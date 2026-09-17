import type { GenerationParams, ModelInfo, ProviderId } from '../../shared/types.ts';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** The raw JSON arguments string as the model produced it. */
  arguments: string;
}

/** A file sent with a user message: base64 bytes for images and PDFs, decoded text for text files. */
export interface LoopAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'pdf' | 'text';
  data?: string;
  text?: string;
}

/** Provider-neutral conversation turn, including the tool-use round trips of one reply. */
export type LoopMessage =
  | { role: 'user'; content: string; attachments?: LoopAttachment[] }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      /** The provider's own content blocks, replayed verbatim (Anthropic thinking and server-tool blocks). */
      raw?: unknown;
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cost?: number }
  | { type: 'finish'; reason: string }
  | { type: 'tool_call'; call: ToolCall }
  /** A search the provider ran on its own servers. */
  | { type: 'native_search'; query: string }
  | { type: 'source'; url: string; title: string }
  /** The complete assistant turn in the provider's format, for replay on the next request. */
  | { type: 'assistant_raw'; content: unknown };

export interface ChatRequest {
  model: string;
  system: string;
  messages: LoopMessage[];
  params: GenerationParams;
  signal: AbortSignal;
  tools?: ToolSpec[];
  /** Ask the provider to search the web server-side. */
  nativeSearch?: boolean;
}

export interface Provider {
  readonly id: ProviderId;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  streamChat(request: ChatRequest): AsyncIterable<ChatEvent>;
}

export class ProviderError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** Heuristic for "this model can't take tools": local servers reject the request rather than ignoring the field. */
export function isToolsUnsupported(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.status === null) return false;
  return [400, 404, 422, 500].includes(error.status) && /tool|function/i.test(error.message);
}

/** Turns a failed HTTP response into a readable error, using the provider's own message when it sends one. */
export async function errorFromResponse(label: string, response: Response): Promise<ProviderError> {
  let detail = response.statusText;
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      const fromBody = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message);
      detail = fromBody ?? text;
    } catch {
      if (text) detail = text.slice(0, 500);
    }
  } catch {
    // Keep the status text.
  }
  return new ProviderError(`${label} returned ${response.status}: ${detail}`, response.status);
}

/** Statuses worth another try: rate limits and overloaded or restarting upstreams. */
const RETRY_STATUSES = new Set([408, 429, 502, 503, 504, 529]);
const MAX_RETRY_DELAY_MS = 30_000;

export function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  const date = header ? Date.parse(header) : Number.NaN;
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
  // 1s, 3s, 9s with some jitter so parallel panes don't retry in lockstep.
  return Math.min(1000 * 3 ** attempt * (0.8 + Math.random() * 0.4), MAX_RETRY_DELAY_MS);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wraps fetch so a refused connection reads as "is the server running" rather than "fetch failed",
 * and retries rate limits and overload errors. Retries happen before any of the body is read, so a
 * streamed reply is never started twice.
 */
export async function providerFetch(label: string, url: string, init: RequestInit, retries = 3): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      throw new ProviderError(`Could not reach ${label} at ${new URL(url).origin}${cause}`);
    }
    if (!RETRY_STATUSES.has(response.status) || attempt >= retries) return response;
    const delay = retryDelay(response, attempt);
    await response.body?.cancel().catch(() => {});
    await sleep(delay, init.signal);
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
