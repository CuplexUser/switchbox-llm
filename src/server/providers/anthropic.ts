import { parseSse } from '../../shared/sse.ts';
import type { ModelInfo } from '../../shared/types.ts';
import {
  errorFromResponse,
  joinUrl,
  ProviderError,
  providerFetch,
  type ChatEvent,
  type ChatRequest,
  type Provider,
} from './types.ts';

const API_VERSION = '2023-06-01';
/** The Messages API requires max_tokens; used when the user leaves it unset. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

export interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string | null };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export function mapAnthropicEvent(event: AnthropicEvent): ChatEvent[] {
  switch (event.type) {
    case 'message_start': {
      const usage = event.message?.usage;
      return usage ? [{ type: 'usage', inputTokens: usage.input_tokens }] : [];
    }
    case 'content_block_delta':
      if (event.delta?.type === 'text_delta' && event.delta.text) return [{ type: 'text', text: event.delta.text }];
      if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
        return [{ type: 'reasoning', text: event.delta.thinking }];
      }
      return [];
    case 'message_delta': {
      const events: ChatEvent[] = [];
      if (event.usage) {
        events.push({ type: 'usage', inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens });
      }
      if (event.delta?.stop_reason) events.push({ type: 'finish', reason: event.delta.stop_reason });
      return events;
    }
    case 'error':
      throw new ProviderError(event.error?.message ?? 'Anthropic reported an error mid-stream');
    default:
      return [];
  }
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;

  constructor(options: { baseUrl: string; apiKey: string | null }) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) throw new ProviderError('ANTHROPIC_API_KEY is not set in .env');
    return { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': API_VERSION };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await providerFetch('Anthropic', joinUrl(this.baseUrl, 'models?limit=1000'), {
      headers: this.headers(),
      signal,
    });
    if (!response.ok) throw await errorFromResponse('Anthropic', response);
    const body = (await response.json()) as { data?: { id: string; display_name?: string }[] };
    return (body.data ?? []).map((model) => ({
      provider: 'anthropic',
      model: model.id,
      name: model.display_name ?? model.id,
    }));
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const { temperature, topP, maxTokens } = request.params;
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: request.messages,
      stream: true,
    };
    if (request.system) body.system = request.system;
    // Recent Claude models reject temperature and top_p together, so temperature wins.
    if (temperature !== null) body.temperature = temperature;
    else if (topP !== null) body.top_p = topP;

    const response = await providerFetch('Anthropic', joinUrl(this.baseUrl, 'messages'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) throw await errorFromResponse('Anthropic', response);
    if (!response.body) throw new ProviderError('Anthropic returned an empty response');

    for await (const message of parseSse(response.body, request.signal)) {
      let event: AnthropicEvent;
      try {
        event = JSON.parse(message.data) as AnthropicEvent;
      } catch {
        continue;
      }
      yield* mapAnthropicEvent(event);
      if (event.type === 'message_stop') break;
    }
  }
}
