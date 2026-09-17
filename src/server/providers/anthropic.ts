import { parseSse } from '../../shared/sse.ts';
import type { GenerationParams, ModelInfo, ReasoningEffort } from '../../shared/types.ts';
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
} from './types.ts';

const API_VERSION = '2023-06-01';
/** The Messages API requires max_tokens; used when the user leaves it unset on older models. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;
/** Output room for models that think, so thinking doesn't crowd out the answer. */
export const ANTHROPIC_THINKING_MAX_TOKENS = 32_000;
const MIN_THINKING_BUDGET = 1024;

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

/**
 * How a Claude model takes thinking and sampling settings.
 * always: thinking can't be turned off. default: thinks unless told otherwise. adaptive: thinks
 * when asked, with no fixed budget. budget: older models, which take a token budget.
 */
export interface ClaudeModelRules {
  thinking: 'always' | 'default' | 'adaptive' | 'budget';
  /** temperature and top_p are rejected. */
  noSampling: boolean;
  efforts: ReasoningEffort[];
}

const ALL_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RULES: [string, ClaudeModelRules][] = [
  ['claude-fable-5', { thinking: 'always', noSampling: true, efforts: ALL_EFFORTS }],
  ['claude-mythos-5', { thinking: 'always', noSampling: true, efforts: ALL_EFFORTS }],
  ['claude-opus-5', { thinking: 'default', noSampling: true, efforts: ALL_EFFORTS }],
  ['claude-sonnet-5', { thinking: 'default', noSampling: true, efforts: ALL_EFFORTS }],
  ['claude-opus-4-8', { thinking: 'adaptive', noSampling: true, efforts: ALL_EFFORTS }],
  ['claude-opus-4-7', { thinking: 'adaptive', noSampling: true, efforts: ALL_EFFORTS }],
  ['claude-opus-4-6', { thinking: 'adaptive', noSampling: false, efforts: ['low', 'medium', 'high', 'max'] }],
  ['claude-sonnet-4-6', { thinking: 'adaptive', noSampling: false, efforts: ['low', 'medium', 'high', 'max'] }],
  ['claude-opus-4-5', { thinking: 'budget', noSampling: false, efforts: ['low', 'medium', 'high'] }],
];

export function claudeModelRules(model: string): ClaudeModelRules {
  const normalized = model.trim().toLowerCase();
  return MODEL_RULES.find(([prefix]) => normalized.startsWith(prefix))?.[1] ?? { thinking: 'budget', noSampling: false, efforts: [] };
}

/** The closest effort a model accepts: the one asked for, else the next lower one, else the lowest. */
export function nearestEffort(wanted: ReasoningEffort, supported: ReasoningEffort[]): ReasoningEffort | null {
  if (supported.includes(wanted)) return wanted;
  const rank = ALL_EFFORTS.indexOf(wanted);
  return supported.filter((effort) => ALL_EFFORTS.indexOf(effort) < rank).at(-1) ?? supported[0] ?? null;
}

/** Thinking, effort, sampling and output settings for one request, following the model's rules. */
export function generationFields(model: string, params: GenerationParams): Record<string, unknown> {
  const rules = claudeModelRules(model);
  const fields: Record<string, unknown> = {};
  let thinking = false;

  const effort = params.reasoningEffort ? nearestEffort(params.reasoningEffort, rules.efforts) : null;
  if (effort) fields.output_config = { effort };

  let maxTokens = params.maxTokens;
  const wantsThinking = Boolean(effort || params.thinkingBudget);
  if (rules.thinking === 'always' || rules.thinking === 'default' || (rules.thinking === 'adaptive' && wantsThinking)) {
    // Summaries make the reasoning visible; newer models otherwise return it empty.
    fields.thinking = { type: 'adaptive', display: 'summarized' };
    thinking = true;
    maxTokens ??= ANTHROPIC_THINKING_MAX_TOKENS;
  } else if (rules.thinking === 'budget' && params.thinkingBudget !== null && params.thinkingBudget >= MIN_THINKING_BUDGET) {
    fields.thinking = { type: 'enabled', budget_tokens: params.thinkingBudget };
    thinking = true;
    // The budget has to fit inside max_tokens with room left for the answer.
    maxTokens = Math.max(maxTokens ?? 0, params.thinkingBudget + ANTHROPIC_DEFAULT_MAX_TOKENS);
  }
  fields.max_tokens = maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;

  // Newer models reject sampling settings, and none of them combine with thinking.
  // Recent models also reject temperature and top_p together, so temperature wins.
  if (!rules.noSampling && !thinking) {
    if (params.temperature !== null) fields.temperature = params.temperature;
    else if (params.topP !== null) fields.top_p = params.topP;
  }
  return fields;
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

/** A text attachment as the model sees it, with its id for read_attachment. */
export function attachmentText(attachment: LoopAttachment): string {
  const name = attachment.name.replaceAll('"', "'");
  return `<attachment name="${name}" id="${attachment.id}">\n${attachment.text ?? ''}\n</attachment>`;
}

/** A user turn with files: images and documents first, then text, as the API recommends. */
function userContent(content: string, attachments: LoopAttachment[] | undefined): unknown {
  if (!attachments?.length) return content;
  const blocks: unknown[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.data) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data } });
    } else if (attachment.kind === 'pdf' && attachment.data) {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: attachment.data },
        title: attachment.name,
      });
    }
  }
  for (const attachment of attachments) {
    if (attachment.kind === 'text') blocks.push({ type: 'text', text: attachmentText(attachment) });
  }
  if (content) blocks.push({ type: 'text', text: content });
  return blocks;
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
      out.push({ role: 'user', content: userContent(message.content, message.attachments) });
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
    const body: Record<string, unknown> = {
      model: request.model,
      ...generationFields(request.model, request.params),
      messages: toAnthropicMessages(request.messages),
      stream: true,
      // Caches the conversation so far, since every tool round resends the same prefix.
      cache_control: { type: 'ephemeral' },
    };
    // A breakpoint on the system prompt keeps tools and system cached when the conversation changes.
    if (request.system) body.system = [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }];

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
