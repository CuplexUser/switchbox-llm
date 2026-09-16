import type { ChatTurn, GenerationParams, ModelInfo, ProviderId } from '../../shared/types.ts';

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cost?: number }
  | { type: 'finish'; reason: string };

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatTurn[];
  params: GenerationParams;
  signal: AbortSignal;
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

/** Wraps fetch so a refused connection reads as "is the server running" rather than "fetch failed". */
export async function providerFetch(label: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    throw new ProviderError(`Could not reach ${label} at ${new URL(url).origin}${cause}`);
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
