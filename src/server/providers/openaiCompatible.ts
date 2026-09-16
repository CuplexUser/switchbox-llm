import { parseSse } from '../../shared/sse.ts';
import { PROVIDER_LABELS, type ModelInfo, type ProviderId } from '../../shared/types.ts';
import {
  errorFromResponse,
  joinUrl,
  ProviderError,
  providerFetch,
  type ChatEvent,
  type ChatRequest,
  type Provider,
} from './types.ts';

interface ChunkChoice {
  delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
  finish_reason?: string | null;
}

export interface OpenAiChunk {
  choices?: ChunkChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
  error?: { message?: string };
}

export function mapOpenAiChunk(chunk: OpenAiChunk): ChatEvent[] {
  if (chunk.error) throw new ProviderError(chunk.error.message ?? 'The provider reported an error mid-stream');
  const events: ChatEvent[] = [];
  const choice = chunk.choices?.[0];
  const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
  if (reasoning) events.push({ type: 'reasoning', text: reasoning });
  if (choice?.delta?.content) events.push({ type: 'text', text: choice.delta.content });
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

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

const NON_CHAT_MODEL = /embed|whisper|tts|dall-e|moderation|transcribe|audio|realtime|image|search|computer-use|babbage|davinci/i;

export function mapModels(provider: ProviderId, data: RawModel[]): ModelInfo[] {
  return data
    .filter((model) => provider !== 'openai' || !NON_CHAT_MODEL.test(model.id))
    .map((model) => {
      const input = Number(model.pricing?.prompt);
      const output = Number(model.pricing?.completion);
      const info: ModelInfo = { provider, model: model.id, name: model.name ?? model.id };
      if (model.context_length) info.contextLength = model.context_length;
      if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 && model.pricing) {
        info.pricing = { input: input * 1_000_000, output: output * 1_000_000 };
      }
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
    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages,
    ];
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    const { temperature, topP, maxTokens } = request.params;
    if (temperature !== null) body.temperature = temperature;
    if (topP !== null) body.top_p = topP;
    // OpenAI's current models only accept max_completion_tokens; everything else still reads max_tokens.
    if (maxTokens !== null) body[this.id === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;

    const response = await providerFetch(this.label, joinUrl(this.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) throw await errorFromResponse(this.label, response);
    if (!response.body) throw new ProviderError(`${this.label} returned an empty response`);

    for await (const message of parseSse(response.body, request.signal)) {
      if (message.data === '[DONE]') break;
      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(message.data) as OpenAiChunk;
      } catch {
        continue;
      }
      yield* mapOpenAiChunk(chunk);
    }
  }
}
