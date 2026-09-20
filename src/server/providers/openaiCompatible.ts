import { parseSse } from '../../shared/sse.ts';
import { PROVIDER_LABELS, type GenerationParams, type ModelInfo, type ProviderId, type ReasoningEffort } from '../../shared/types.ts';
import { attachmentText, nearestEffort } from './anthropic.ts';
import {
  errorFromResponse,
  joinUrl,
  ProviderError,
  providerFetch,
  type ChatEvent,
  type ChatRequest,
  type LoopAttachment,
  type LoopMessage,
  type Provider,
  type ToolCall,
} from './types.ts';

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface Annotation {
  type?: string;
  url_citation?: { url?: string; title?: string };
}

/** OpenRouter's shape for a generated image: a data url, same as an attachment's image_url content part. */
interface ImagePart {
  type?: string;
  image_url?: { url?: string };
}

interface ChunkChoice {
  delta?: {
    content?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    tool_calls?: ToolCallDelta[];
    annotations?: Annotation[];
    images?: ImagePart[];
  };
  message?: { annotations?: Annotation[]; images?: ImagePart[] };
  finish_reason?: string | null;
}

export interface OpenAiChunk {
  choices?: ChunkChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
  error?: { message?: string };
}

/** Splits a `data:<mime>;base64,<data>` url. Null for anything else (a hosted url, say). */
function parseDataUrl(url: string | undefined): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(url ?? '');
  return match ? { mimeType: match[1] as string, data: match[2] as string } : null;
}

/**
 * Maps one streamed chunk. Tool-call fragments are merged into `pending` and emitted when the
 * stream ends. `seenImages` dedupes generated images in case OpenRouter resends the array
 * cumulatively across chunks rather than once at the end.
 */
export function mapOpenAiChunk(chunk: OpenAiChunk, pending: Map<number, ToolCall> = new Map(), seenImages: Set<string> = new Set()): ChatEvent[] {
  if (chunk.error) throw new ProviderError(chunk.error.message ?? 'The provider reported an error mid-stream');
  const events: ChatEvent[] = [];
  const choice = chunk.choices?.[0];
  const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
  if (reasoning) events.push({ type: 'reasoning', text: reasoning });
  if (choice?.delta?.content) events.push({ type: 'text', text: choice.delta.content });

  for (const fragment of choice?.delta?.tool_calls ?? []) {
    const index = fragment.index ?? 0;
    const call = pending.get(index) ?? { id: '', name: '', arguments: '' };
    if (fragment.id) call.id = fragment.id;
    if (fragment.function?.name) call.name += fragment.function.name;
    if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
    pending.set(index, call);
  }

  for (const annotation of [...(choice?.delta?.annotations ?? []), ...(choice?.message?.annotations ?? [])]) {
    const citation = annotation.url_citation;
    if (annotation.type === 'url_citation' && citation?.url) {
      events.push({ type: 'source', url: citation.url, title: citation.title || citation.url });
    }
  }

  for (const image of [...(choice?.delta?.images ?? []), ...(choice?.message?.images ?? [])]) {
    const url = image.image_url?.url;
    if (!url || seenImages.has(url)) continue;
    const parsed = parseDataUrl(url);
    if (!parsed) continue;
    seenImages.add(url);
    events.push({ type: 'image', mimeType: parsed.mimeType, data: parsed.data });
  }

  if (choice?.finish_reason) events.push({ type: 'finish', reason: choice.finish_reason });
  if (chunk.usage) {
    events.push({
      type: 'usage',
      inputTokens: chunk.usage.prompt_tokens,
      outputTokens: chunk.usage.completion_tokens,
      cost: chunk.usage.cost,
    });
  }
  return events;
}

/** A user turn with files as content parts: images and PDFs as data URLs, text files inline. */
function userContent(content: string, attachments: LoopAttachment[] | undefined): unknown {
  if (!attachments?.length) return content;
  const parts: unknown[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.data) {
      parts.push({ type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` } });
    } else if (attachment.kind === 'pdf' && attachment.data) {
      parts.push({ type: 'file', file: { filename: attachment.name, file_data: `data:application/pdf;base64,${attachment.data}` } });
    } else if (attachment.kind === 'text') {
      parts.push({ type: 'text', text: attachmentText(attachment) });
    }
  }
  if (content) parts.push({ type: 'text', text: content });
  return parts;
}

const OPENAI_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

/** Reasoning settings in each server's dialect. Servers without the concept ignore the field. */
export function reasoningFields(id: ProviderId, params: GenerationParams): Record<string, unknown> {
  const effort = params.reasoningEffort ? nearestEffort(params.reasoningEffort, OPENAI_EFFORTS) : null;
  if (id === 'openrouter') {
    if (effort) return { reasoning: { effort } };
    if (params.thinkingBudget) return { reasoning: { max_tokens: params.thinkingBudget } };
    return {};
  }
  return effort ? { reasoning_effort: effort } : {};
}

export function toOpenAiMessages(system: string, messages: LoopMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: userContent(message.content, message.attachments) });
    } else if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' },
        })),
      });
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  return out;
}

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  /** OpenRouter's model-list shape. */
  architecture?: { output_modalities?: string[] };
}

const NON_CHAT_MODEL = /embed|whisper|tts|moderation|transcribe|audio|realtime|computer-use|babbage|davinci/i;
/** OpenAI's own image models: not chat-completions models, handled through /images/generations instead. */
const OPENAI_IMAGE_MODEL = /^(gpt-image-\d|dall-e-\d)/i;

function kindOf(provider: ProviderId, model: RawModel): 'image' | undefined {
  if (provider === 'openai') return OPENAI_IMAGE_MODEL.test(model.id) ? 'image' : undefined;
  if (provider === 'openrouter') return model.architecture?.output_modalities?.includes('image') ? 'image' : undefined;
  return undefined;
}

export function mapModels(provider: ProviderId, data: RawModel[]): ModelInfo[] {
  return data
    .filter((model) => provider !== 'openai' || OPENAI_IMAGE_MODEL.test(model.id) || !NON_CHAT_MODEL.test(model.id))
    .map((model) => {
      const input = Number(model.pricing?.prompt);
      const output = Number(model.pricing?.completion);
      const info: ModelInfo = { provider, model: model.id, name: model.name ?? model.id };
      if (model.context_length) info.contextLength = model.context_length;
      if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 && model.pricing) {
        info.pricing = { input: input * 1_000_000, output: output * 1_000_000 };
      }
      const kind = kindOf(provider, model);
      if (kind) info.kind = kind;
      return info;
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  baseUrl: string;
  apiKey: string | null;
}

/** OpenRouter, OpenAI, Ollama, LM Studio and any other server that speaks the Chat Completions API. */
export class OpenAiCompatibleProvider implements Provider {
  readonly id: ProviderId;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly label: string;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.label = PROVIDER_LABELS[options.id];
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.id === 'openrouter') {
      headers['HTTP-Referer'] = 'http://localhost';
      headers['X-Title'] = 'Switchbox LLM';
    }
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    if (!this.baseUrl) throw new ProviderError(`${this.label} has no base URL configured`);
    const response = await providerFetch(this.label, joinUrl(this.baseUrl, 'models'), {
      headers: this.headers(),
      signal,
    });
    if (!response.ok) throw await errorFromResponse(this.label, response);
    const body = (await response.json()) as { data?: RawModel[] };
    return mapModels(this.id, body.data ?? []);
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    if (this.id === 'openai' && request.imageOutput) {
      yield* this.streamOpenAiImage(request);
      return;
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request.system, request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    // OpenRouter proxies image-output models (Nano Banana and the like) through this same endpoint.
    if (request.imageOutput && this.id === 'openrouter') body.modalities = ['image', 'text'];
    const { temperature, topP, maxTokens } = request.params;
    if (temperature !== null) body.temperature = temperature;
    if (topP !== null) body.top_p = topP;
    // OpenAI's current models only accept max_completion_tokens; everything else still reads max_tokens.
    if (maxTokens !== null) body[this.id === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
    Object.assign(body, reasoningFields(this.id, request.params));

    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = 'auto';
    }
    if (request.nativeSearch) {
      // OpenRouter's web plugin works with every model it proxies. OpenAI accepts
      // web_search_options on any model but only acts on it with its search-enabled models.
      if (this.id === 'openrouter') body.plugins = [{ id: 'web', max_results: 5 }];
      if (this.id === 'openai') body.web_search_options = {};
    }
    // Makes OpenRouter report the real dollar cost of the call.
    if (this.id === 'openrouter') body.usage = { include: true };

    const response = await providerFetch(this.label, joinUrl(this.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) throw await errorFromResponse(this.label, response);
    if (!response.body) throw new ProviderError(`${this.label} returned an empty response`);

    const pending = new Map<number, ToolCall>();
    const seenImages = new Set<string>();
    for await (const message of parseSse(response.body, request.signal)) {
      if (message.data === '[DONE]') break;
      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(message.data) as OpenAiChunk;
      } catch {
        continue;
      }
      yield* mapOpenAiChunk(chunk, pending, seenImages);
    }

    for (const [index, call] of [...pending.entries()].toSorted(([a], [b]) => a - b)) {
      if (!call.name) continue;
      yield { type: 'tool_call', call: { ...call, id: call.id || `call_${index}` } };
    }
  }

  /** OpenAI's own image models (gpt-image-1, dall-e) are a separate, non-chat, non-streaming endpoint. */
  private async *streamOpenAiImage(request: ChatRequest): AsyncIterable<ChatEvent> {
    const prompt = request.messages.toReversed().find((message) => message.role === 'user')?.content ?? '';
    const response = await providerFetch(this.label, joinUrl(this.baseUrl, 'images/generations'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: request.model, prompt, n: 1 }),
      signal: request.signal,
    });
    if (!response.ok) throw await errorFromResponse(this.label, response);
    const body = (await response.json()) as { data?: { b64_json?: string }[] };
    for (const item of body.data ?? []) {
      if (item.b64_json) yield { type: 'image', mimeType: 'image/png', data: item.b64_json };
    }
    yield { type: 'finish', reason: 'stop' };
  }
}
