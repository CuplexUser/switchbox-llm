import { randomUUID } from 'node:crypto';
import { mergeParams } from '../../shared/defaults.ts';
import type {
  ActivityItem,
  AppSettings,
  ChatTurn,
  GenerationParams,
  Message,
  PromptPreview,
  ProviderId,
  ResolvedSearch,
  Source,
  StreamEvent,
  StreamRequest,
} from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';
import type { ConversationRow, PaneRow } from '../db/schemas.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { isToolsUnsupported, type LoopMessage, type ToolCall, type ToolSpec } from '../providers/types.ts';
import { nativeSearchSupport, planSearch, type SearchProvider } from '../web/search.ts';
import { runTool, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from '../web/tools.ts';
import { buildSystemPrompt, type MemoryService } from './memory.ts';
import type { SettingsService } from './settings.ts';
import { serialize } from './serialize.ts';

export const DEFAULT_TITLE = 'New chat';
/** Bound on resuming a turn the provider parked mid-search (Anthropic pause_turn). */
const MAX_PAUSE_RESUMES = 4;

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

export interface WebPlan {
  tools: ToolSpec[];
  nativeSearch: boolean;
  search: SearchProvider | null;
  resolved: ResolvedSearch;
  /** Shown to the user when web access is on but search can't run as chosen. */
  note: string | null;
}

/** Works out what web access a pane gets from the chat toggle, the search mode, the keys and the provider. */
export function planWeb(
  enabled: boolean,
  settings: AppSettings['web'],
  provider: ProviderId,
  model: string,
  keys?: { tavily: string | null; brave: string | null },
): WebPlan {
  const off: WebPlan = { tools: [], nativeSearch: false, search: null, resolved: 'none', note: null };
  if (!enabled) return off;

  const plan = planSearch(settings.searchMode, keys);
  const tools: ToolSpec[] = [];
  let nativeSearch = false;
  let resolved = plan.resolved;
  let note = plan.problem;

  if (plan.provider) tools.push(WEB_SEARCH_TOOL);
  if (plan.resolved === 'native') {
    const support = nativeSearchSupport(provider, model);
    nativeSearch = support.supported;
    note = support.note;
    if (!support.supported) resolved = 'none';
  }
  if (settings.allowFetch) tools.push(WEB_FETCH_TOOL);
  return { tools, nativeSearch, search: plan.provider, resolved, note };
}

function webGuidance(plan: WebPlan): string {
  if (plan.tools.length === 0 && !plan.nativeSearch) return '';
  const today = new Date().toISOString().slice(0, 10);
  const abilities: string[] = [];
  if (plan.search || plan.nativeSearch) abilities.push('search the web');
  if (plan.tools.some((tool) => tool.name === WEB_FETCH_TOOL.name)) abilities.push('read web pages with web_fetch');
  return (
    `Today's date is ${today}. You can ${abilities.join(' and ')}. ` +
    'Use the web when the answer depends on current, niche or verifiable facts, not for things you already know well. ' +
    'Cite the sources you rely on inline as Markdown links.'
  );
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

  private async assemble(conversation: ConversationRow, pane: PaneRow) {
    let base = pane.systemPrompt ?? '';
    if (!pane.systemPrompt && pane.systemPromptId) {
      base = (await this.repos.systemPrompts.findById(pane.systemPromptId))?.content ?? '';
    }
    const facts = conversation.useMemory ? await this.memory.activeFacts() : [];
    const all = await this.settings.getAll();
    const provider = pane.provider as ProviderId;
    const web = planWeb(conversation.webAccess, all.web, provider, pane.model);
    const system = [buildSystemPrompt(base, facts), webGuidance(web)].filter(Boolean).join('\n\n');
    return {
      system,
      facts,
      web,
      params: mergeParams(all.generation, pane.params as Partial<GenerationParams>),
      webSettings: all.web,
      provider,
    };
  }

  async preview(conversation: ConversationRow, pane: PaneRow): Promise<PromptPreview> {
    const assembled = await this.assemble(conversation, pane);
    return {
      system: assembled.system,
      memoryCount: assembled.facts.length,
      tools: assembled.web.tools.map((tool) => tool.name),
      search: assembled.web.resolved,
      searchNote: assembled.web.note,
      provider: assembled.provider,
      model: pane.model,
      params: assembled.params,
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

    const messages: LoopMessage[] = cleanHistory(history);
    if (content !== null) {
      const userMessage = await this.save(conversation.persist, {
        ...emptyMessage(conversation.id, paneId),
        role: 'user',
        content,
      });
      await emit({ type: 'user', paneId, message: userMessage });
      messages.push({ role: 'user', content });
    }

    const draft: Message = {
      ...emptyMessage(conversation.id, paneId),
      role: 'assistant',
      provider: pane.provider as ProviderId,
      model: pane.model,
    };
    await emit({ type: 'start', paneId, messageId: draft.id });

    const items = new Map<string, ActivityItem>();
    const sources = new Map<string, Source>();
    const recordActivity = (item: ActivityItem) => {
      items.set(item.id, item);
      void emit({ type: 'activity', paneId, item });
    };
    const recordSource = (source: Source) => {
      if (sources.has(source.url)) return;
      sources.set(source.url, source);
      void emit({ type: 'source', paneId, source });
    };

    const started = performance.now();
    let firstToken: number | null = null;
    try {
      const assembled = await this.assemble(conversation, pane);
      const provider = await this.registry.get(assembled.provider);
      let web = assembled.web;
      if (web.note) recordActivity({ id: randomUUID(), kind: 'notice', text: web.note, done: true });

      let toolRounds = 0;
      let pauseResumes = 0;
      let budgetSpent = false;

      while (true) {
        let stepText = '';
        let raw: unknown;
        let finish: string | null = null;
        let emitted = false;
        const calls: ToolCall[] = [];

        try {
          for await (const event of provider.streamChat({
            model: pane.model,
            system: assembled.system,
            messages,
            params: assembled.params,
            signal,
            tools: web.tools,
            nativeSearch: web.nativeSearch,
          })) {
            switch (event.type) {
              case 'text': {
                firstToken ??= performance.now();
                // Separate what the model says before and after a round of tool calls.
                const separator = !stepText && draft.content && !draft.content.endsWith('\n') ? '\n\n' : '';
                stepText += event.text;
                draft.content += separator + event.text;
                emitted = true;
                await emit({ type: 'delta', paneId, text: separator + event.text });
                break;
              }
              case 'reasoning':
                firstToken ??= performance.now();
                draft.reasoning = (draft.reasoning ?? '') + event.text;
                emitted = true;
                await emit({ type: 'reasoning', paneId, text: event.text });
                break;
              case 'usage':
                // Each request in a tool loop is billed separately, so the counts add up.
                if (event.inputTokens !== undefined) draft.tokensIn = (draft.tokensIn ?? 0) + event.inputTokens;
                if (event.outputTokens !== undefined) draft.tokensOut = (draft.tokensOut ?? 0) + event.outputTokens;
                if (event.cost !== undefined) draft.cost = (draft.cost ?? 0) + event.cost;
                break;
              case 'finish':
                finish = event.reason;
                break;
              case 'tool_call':
                calls.push(event.call);
                break;
              case 'native_search':
                emitted = true;
                recordActivity({
                  id: randomUUID(),
                  kind: 'search',
                  engine: 'native',
                  query: event.query,
                  resultCount: null,
                  done: true,
                });
                break;
              case 'source':
                recordSource({ url: event.url, title: event.title });
                break;
              case 'assistant_raw':
                raw = event.content;
                break;
            }
          }
        } catch (error) {
          // Many local models reject tool definitions outright. Answer without web access instead of failing.
          if (!emitted && !signal.aborted && (web.tools.length > 0 || web.nativeSearch) && isToolsUnsupported(error)) {
            web = { ...web, tools: [], nativeSearch: false, resolved: 'none' };
            recordActivity({
              id: randomUUID(),
              kind: 'notice',
              text: 'This model does not support tools, so it answered without web access.',
              done: true,
            });
            continue;
          }
          throw error;
        }

        if (signal.aborted) break;
        if (finish === 'pause_turn' && pauseResumes < MAX_PAUSE_RESUMES) {
          pauseResumes++;
          messages.push({ role: 'assistant', content: stepText, raw });
          continue;
        }
        draft.finishReason = finish;
        if (calls.length === 0) break;
        if (budgetSpent) break;

        messages.push({ role: 'assistant', content: stepText, toolCalls: calls, raw });
        toolRounds++;
        if (toolRounds > assembled.webSettings.maxToolRounds) {
          // Out of rounds: answer each call with a stop signal and give the model one last turn.
          budgetSpent = true;
          for (const call of calls) {
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: 'Research limit reached. Answer now using what you have found so far.',
              isError: true,
            });
          }
          continue;
        }

        const context = {
          search: web.search,
          settings: assembled.webSettings,
          signal,
          onActivity: recordActivity,
          onSource: recordSource,
        };
        const results = await Promise.all(calls.map((call) => runTool(call, context)));
        calls.forEach((call, index) => {
          const result = results[index];
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: result?.content ?? 'Error: no result',
            isError: result?.isError ?? true,
          });
        });
        if (signal.aborted) break;
      }
      if (signal.aborted) draft.finishReason = 'aborted';
    } catch (error) {
      if (signal.aborted) draft.finishReason = 'aborted';
      else draft.error = errorMessage(error);
    }

    draft.latencyMs = Math.round(performance.now() - started);
    draft.ttftMs = firstToken === null ? null : Math.round(firstToken - started);
    if (items.size > 0 || sources.size > 0) {
      // Anything still marked running was cut short by a stop or an error.
      const finished = [...items.values()].map((item) => (item.done ? item : { ...item, done: true }));
      draft.activity = { items: finished as ActivityItem[], sources: [...sources.values()] };
    }
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
    activity: null,
    createdAt: new Date().toISOString(),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
