import { parseSse } from '../../shared/sse.ts';
import type { ModelInfo } from '../../shared/types.ts';
import {
  errorFromResponse,
  joinUrl,
  ProviderError,
  providerFetch,
  type ChatEvent,
  type ChatRequest,
  type LoopMessage,
  type Provider,
} from './types.ts';

const API_VERSION = '2023-06-01';
/** The Messages API requires max_tokens; used when the user leaves it unset. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

/** Models on the server-tool generation with dynamic filtering. Older models only accept the basic variant. */
const NEW_SEARCH_TOOL_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
];

export function webSearchToolFor(model: string): Record<string, unknown> {
  const normalized = model.trim().toLowerCase();
  const isNew = NEW_SEARCH_TOOL_MODELS.some((known) => normalized.startsWith(known));
  return { type: isNew ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 8 };
}

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  citations?: unknown[] | null;
  [key: string]: unknown;
}

export interface AnthropicEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  content_block?: Block;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    citation?: { url?: string; title?: string };
    stop_reason?: string | null;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/**
 * Rebuilds the assistant turn from stream events so it can be replayed exactly (thinking
 * signatures and server-tool pairs must survive the round trip) and emits neutral events.
 */
export class AnthropicTurn {
  readonly blocks: Block[] = [];
  private readonly partialJson = new Map<number, string>();

  apply(event: AnthropicEvent): ChatEvent[] {
    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage;
        if (!usage) return [];
        // input_tokens excludes cached tokens on this API; add them back so the count means the whole prompt.
        const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        return [{ type: 'usage', inputTokens: input }];
      }
      case 'content_block_start': {
        const block = { ...(event.content_block ?? { type: 'unknown' }) };
        this.blocks[event.index ?? this.blocks.length] = block;
        const events: ChatEvent[] = [];
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const result of block.content as { type?: string; url?: string; title?: string }[]) {
            if (result.type === 'web_search_result' && result.url) {
              events.push({ type: 'source', url: result.url, title: result.title || result.url });
            }
          }
        }
        if (block.type === 'text' && block.text) events.push({ type: 'text', text: block.text });
        return events;
      }
      case 'content_block_delta': {
        const index = event.index ?? this.blocks.length - 1;
        const block = this.blocks[index];
        const delta = event.delta;
        if (!block || !delta) return [];
        switch (delta.type) {
          case 'text_delta':
            block.text = (block.text ?? '') + (delta.text ?? '');
            return delta.text ? [{ type: 'text', text: delta.text }] : [];
          case 'thinking_delta':
            block.thinking = (block.thinking ?? '') + (delta.thinking ?? '');
            return delta.thinking ? [{ type: 'reasoning', text: delta.thinking }] : [];
          case 'signature_delta':
            block.signature = ((block.signature as string | undefined) ?? '') + (delta.signature ?? '');
            return [];
          case 'input_json_delta':
            this.partialJson.set(index, (this.partialJson.get(index) ?? '') + (delta.partial_json ?? ''));
            return [];
          case 'citations_delta': {
            block.citations = [...(block.citations ?? []), delta.citation];
            const url = delta.citation?.url;
            return url ? [{ type: 'source', url, title: delta.citation?.title || url }] : [];
          }
          default:
            return [];
        }
      }
      case 'content_block_stop': {
        const index = event.index ?? this.blocks.length - 1;
        const block = this.blocks[index];
        if (!block) return [];
        if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          const json = this.partialJson.get(index);
          let input: unknown = block.input ?? {};
          if (json) {
            try {
              input = JSON.parse(json);
            } catch {
              input = {};
            }
          }
          block.input = input;
          if (block.type === 'tool_use' && block.name && block.id) {
            return [{ type: 'tool_call', call: { id: block.id, name: block.name, arguments: json || JSON.stringify(input) } }];
          }
          if (block.type === 'server_tool_use' && block.name === 'web_search') {
            const query = (input as { query?: unknown }).query;
            return typeof query === 'string' ? [{ type: 'native_search', query }] : [];
          }
        }
        return [];
      }
      case 'message_delta': {
        const events: ChatEvent[] = [];
        if (event.usage) events.push({ type: 'usage', outputTokens: event.usage.output_tokens });
        if (event.delta?.stop_reason) events.push({ type: 'finish', reason: event.delta.stop_reason });
        return events;
      }
      case 'error':
        throw new ProviderError(event.error?.message ?? 'Anthropic reported an error mid-stream');
      default:
        return [];
    }
  }

  /** The turn's blocks, without holes left by unknown indexes. */
  content(): Block[] {
    return this.blocks.filter(Boolean);
  }
}

/** Neutral history to Messages API turns. Consecutive tool results share one user message, as the API requires. */
export function toAnthropicMessages(messages: LoopMessage[]): { role: string; content: unknown }[] {
  const out: { role: string; content: unknown }[] = [];
  let results: unknown[] = [];
  const flush = () => {
    if (results.length > 0) {
      out.push({ role: 'user', content: results });
      results = [];
    }
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      results.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      });
      continue;
    }
    flush();
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
    } else if (Array.isArray(message.raw) && message.raw.length > 0) {
      out.push({ role: 'assistant', content: message.raw });
    } else {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments || '{}');
        } catch {
          // Keep an empty object; the tool result will carry the parse error.
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : message.content });
    }
  }
  flush();
  return out;
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
    const body = (await response.json()) as { data?: { id: string; display_name?: string; max_input_tokens?: number }[] };
    return (body.data ?? []).map((model) => ({
      provider: 'anthropic',
      model: model.id,
      name: model.display_name ?? model.id,
      ...(model.max_input_tokens ? { contextLength: model.max_input_tokens } : {}),
    }));
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const { temperature, topP, maxTokens } = request.params;
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: toAnthropicMessages(request.messages),
      stream: true,
    };
    if (request.system) body.system = request.system;
    // Recent Claude models reject temperature and top_p together, so temperature wins.
    if (temperature !== null) body.temperature = temperature;
    else if (topP !== null) body.top_p = topP;

    const tools: unknown[] = (request.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
    if (request.nativeSearch) tools.push(webSearchToolFor(request.model));
    if (tools.length > 0) body.tools = tools;

    const response = await providerFetch('Anthropic', joinUrl(this.baseUrl, 'messages'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) throw await errorFromResponse('Anthropic', response);
    if (!response.body) throw new ProviderError('Anthropic returned an empty response');

    const turn = new AnthropicTurn();
    let stopReason: string | null = null;
    for await (const message of parseSse(response.body, request.signal)) {
      let event: AnthropicEvent;
      try {
        event = JSON.parse(message.data) as AnthropicEvent;
      } catch {
        continue;
      }
      for (const mapped of turn.apply(event)) {
        if (mapped.type === 'finish') stopReason = mapped.reason;
        yield mapped;
      }
      if (event.type === 'message_stop') break;
    }
    if (stopReason === 'refusal') throw new ProviderError('The model declined this request (stop reason: refusal).');
    yield { type: 'assistant_raw', content: turn.content() };
  }
}
