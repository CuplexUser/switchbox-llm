import { randomUUID } from 'node:crypto';
import { mergeParams } from '../../shared/defaults.ts';
import type {
  ChatTurn,
  GenerationParams,
  Message,
  PromptPreview,
  ProviderId,
  StreamEvent,
  StreamRequest,
} from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';
import type { ConversationRow, PaneRow } from '../db/schemas.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { buildSystemPrompt, type MemoryService } from './memory.ts';
import type { SettingsService } from './settings.ts';
import { serialize } from './serialize.ts';

export const DEFAULT_TITLE = 'New chat';

export function titleFrom(content: string): string {
  const firstLine = content.trim().split(/\r?\n/)[0] ?? '';
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  if (!clean) return DEFAULT_TITLE;
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
}

/** Drops turns a provider would reject: empty replies left behind by errors or early stops. */
export function cleanHistory(history: ChatTurn[]): ChatTurn[] {
  return history.filter((turn) => turn.content.trim().length > 0);
}

export type Emit = (event: StreamEvent) => void | Promise<void>;

export class ChatService {
  private readonly repos: Repos;
  private readonly settings: SettingsService;
  private readonly registry: ProviderRegistry;
  private readonly memory: MemoryService;

  constructor(repos: Repos, settings: SettingsService, registry: ProviderRegistry, memory: MemoryService) {
    this.repos = repos;
    this.settings = settings;
    this.registry = registry;
    this.memory = memory;
  }

  async preview(conversation: ConversationRow, pane: PaneRow): Promise<PromptPreview> {
    let base = pane.systemPrompt ?? '';
    if (!pane.systemPrompt && pane.systemPromptId) {
      base = (await this.repos.systemPrompts.findById(pane.systemPromptId))?.content ?? '';
    }
    const facts = conversation.useMemory ? await this.memory.activeFacts() : [];
    const defaults = await this.settings.get('generation');
    return {
      system: buildSystemPrompt(base, facts),
      memoryCount: facts.length,
      provider: pane.provider as ProviderId,
      model: pane.model,
      params: mergeParams(defaults, pane.params as Partial<GenerationParams>),
    };
  }

  /**
   * Streams every target pane concurrently. `controllers` receives one AbortController per pane
   * so a caller can stop a single pane without touching the others.
   */
  async run(request: StreamRequest, emit: Emit, controllers: Map<string, AbortController>): Promise<void> {
    const conversation = await this.repos.conversations.findById(request.conversationId);
    if (!conversation) throw new Error('Conversation not found');

    const results = await Promise.all(
      request.targets.map(async (target) => {
        const controller = new AbortController();
        controllers.set(target.paneId, controller);
        try {
          return await this.runPane(conversation, target.paneId, request.content, target.history, emit, controller.signal);
        } finally {
          controllers.delete(target.paneId);
        }
      }),
    );

    const content = request.content;
    if (content !== null) {
      const title = conversation.title === DEFAULT_TITLE ? titleFrom(content) : conversation.title;
      await this.repos.conversations.update(conversation.id, { title });

      const reply = results.find((result) => result && !result.error && result.content);
      if (conversation.useMemory && reply) {
        this.memory
          .suggest(conversation.id, [
            { role: 'user', content },
            { role: 'assistant', content: reply.content },
          ])
          .catch((error: unknown) => console.warn('[memory] suggestion failed:', errorMessage(error)));
      }
    }
  }

  private async runPane(
    conversation: ConversationRow,
    paneId: string,
    content: string | null,
    history: ChatTurn[],
    emit: Emit,
    signal: AbortSignal,
  ): Promise<Message | null> {
    const pane = await this.repos.panes.findById(paneId);
    if (!pane || pane.conversationId !== conversation.id) {
      await emit({ type: 'error', paneId, error: 'Pane not found in this conversation', message: null });
      return null;
    }

    const turns = cleanHistory(history);
    if (content !== null) {
      const userMessage = await this.save(conversation.persist, {
        ...emptyMessage(conversation.id, paneId),
        role: 'user',
        content,
      });
      await emit({ type: 'user', paneId, message: userMessage });
      turns.push({ role: 'user', content });
    }

    const draft: Message = {
      ...emptyMessage(conversation.id, paneId),
      role: 'assistant',
      provider: pane.provider as ProviderId,
      model: pane.model,
    };
    await emit({ type: 'start', paneId, messageId: draft.id });

    const started = performance.now();
    let firstToken: number | null = null;
    try {
      const prompt = await this.preview(conversation, pane);
      const provider = await this.registry.get(prompt.provider);
      for await (const event of provider.streamChat({
        model: pane.model,
        system: prompt.system,
        messages: turns,
        params: prompt.params,
        signal,
      })) {
        switch (event.type) {
          case 'text':
            firstToken ??= performance.now();
            draft.content += event.text;
            await emit({ type: 'delta', paneId, text: event.text });
            break;
          case 'reasoning':
            firstToken ??= performance.now();
            draft.reasoning = (draft.reasoning ?? '') + event.text;
            await emit({ type: 'reasoning', paneId, text: event.text });
            break;
          case 'usage':
            if (event.inputTokens !== undefined) draft.tokensIn = event.inputTokens;
            if (event.outputTokens !== undefined) draft.tokensOut = event.outputTokens;
            if (event.cost !== undefined) draft.cost = event.cost;
            break;
          case 'finish':
            draft.finishReason = event.reason;
            break;
        }
      }
      if (signal.aborted) draft.finishReason = 'aborted';
    } catch (error) {
      if (signal.aborted) draft.finishReason = 'aborted';
      else draft.error = errorMessage(error);
    }

    draft.latencyMs = Math.round(performance.now() - started);
    draft.ttftMs = firstToken === null ? null : Math.round(firstToken - started);
    const saved = await this.save(conversation.persist, draft);

    if (saved.error) await emit({ type: 'error', paneId, error: saved.error, message: saved });
    else await emit({ type: 'done', paneId, message: saved });
    return saved;
  }

  private async save(persist: boolean, message: Message): Promise<Message> {
    if (!persist) return message;
    // The repo stamps createdAt itself.
    const { createdAt: _createdAt, ...data } = message;
    const row = await this.repos.messages.create(data);
    return serialize<Message>(row);
  }
}

function emptyMessage(conversationId: string, paneId: string): Message {
  return {
    id: randomUUID(),
    conversationId,
    paneId,
    role: 'assistant',
    content: '',
    reasoning: null,
    provider: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    ttftMs: null,
    latencyMs: null,
    cost: null,
    finishReason: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
