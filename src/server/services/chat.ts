import { randomUUID } from 'node:crypto';
import { isImageModel, mergeParams } from '../../shared/defaults.ts';
import type {
  ActivityItem,
  AppSettings,
  AttachmentRef,
  GenerationParams,
  PromptPreview,
  ProviderId,
  Source,
  StreamEvent,
  StreamRequest,
} from '../../shared/types.ts';
import { STREAMING_FINISH } from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';
import type { ConversationRow, MessageRow, PaneRow, SystemPromptRow } from '../db/schemas.ts';
import { createLogger, type Logger } from '../log.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { isToolsUnsupported, type ChatRequest, type LoopAttachment, type LoopMessage, type Provider, type ToolCall } from '../providers/types.ts';
import { UNTRUSTED_GUIDANCE, type ToolRegistry } from '../tools/registry.ts';
import type { ToolDefinition, ToolResult, ToolRunContext, WebPlan } from '../tools/types.ts';
import { planWeb, webGuidance } from '../tools/web.ts';
import { workspaceGuidance } from '../tools/workspace.ts';
import type { ApprovalBroker } from './approvals.ts';
import { extFromMime, toRef, type AttachmentService } from './attachments.ts';
import { buildHistory, fitToBudget, traceForStorage } from './history.ts';
import { buildSystemPrompt, memoryGuidance, type MemoryService } from './memory.ts';
import { toMessage, type MessageStore } from './messages.ts';
import type { SettingsService } from './settings.ts';
import type { WorkspaceService } from './workspaces.ts';

export const DEFAULT_TITLE = 'New chat';
/** Bound on resuming a turn the provider parked mid-search (Anthropic pause_turn). */
const MAX_PAUSE_RESUMES = 4;
/** Context window assumed for models whose size isn't known. */
const DEFAULT_CONTEXT_TOKENS = 128_000;
/** How long a model that rejected tools is sent requests without them. */
const NO_TOOLS_MEMORY_MS = 60 * 60 * 1000;
/** How often a reply being written is saved to its row. */
const CHECKPOINT_MS = 2_000;
/** How much of an unfinished reply's reasoning is handed back when it's continued: the most recent part. */
const CONTINUE_REASONING_CHARS = 20_000;
const TITLE_PROMPT =
  'Write a short title for a chat that starts with the message below. Use 2 to 6 words, sentence case, no quotes and no ending punctuation. Reply with the title only.';

export function titleFrom(content: string): string {
  const firstLine = content.trim().split(/\r?\n/)[0] ?? '';
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  if (!clean) return DEFAULT_TITLE;
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
}

export function cleanTitle(text: string): string {
  const line = text.trim().split(/\r?\n/).find((entry) => entry.trim()) ?? '';
  const clean = line.replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, '').replace(/^title:\s*/i, '').trim();
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
}

/**
 * The message an edit rewrites, or a continue carries on, in `pane`: from `messageIds`, or
 * `messageId` when there's one pane.
 */
function editTarget(request: StreamRequest, pane: { id: string }): string | undefined {
  return request.messageIds?.[pane.id] ?? (request.paneIds.length === 1 ? request.messageId : undefined);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `task` over `items` with at most `limit` running at once, keeping the input order in the results. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function difference(after: number | null, before: number | null): number | null {
  return after === null ? null : after - (before ?? 0);
}

/**
 * Asks the model to carry on from an unfinished reply. The reply's text and tool steps are already
 * at the end of `history`; its reasoning isn't (providers don't take reasoning back as input), so
 * the note repeats the latest part of it.
 */
export function withContinueNote(history: LoopMessage[], reply: Pick<MessageRow, 'content' | 'reasoning' | 'finishReason' | 'error'>): LoopMessage[] {
  const reasoning = reply.reasoning?.trim() ?? '';
  const kept = reasoning.length > CONTINUE_REASONING_CHARS ? `[… earlier reasoning left out …]\n${reasoning.slice(-CONTINUE_REASONING_CHARS)}` : reasoning;
  const cause = reply.error ? ` (${reply.error})` : reply.finishReason === 'length' ? ' (it hit the output token limit)' : '';
  const note = [
    `Your previous reply was cut off before it was finished${cause}.`,
    kept ? `This is the reasoning you had done so far:\n<previous_reasoning>\n${kept}\n</previous_reasoning>` : '',
    reply.content.trim()
      ? "Continue your reply from exactly where it stops. Don't restart, repeat or summarize what you already wrote: your new text is added directly after it."
      : 'You had not written any of your answer yet. Pick up from where your reasoning got to and finish the task, without redoing work you already did.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const out = [...history];
  const last = out.at(-1);
  // Two user messages in a row are rejected by some providers, so a reply with nothing to show adds to the question instead.
  if (last?.role === 'user') out[out.length - 1] = { ...last, content: `${last.content}\n\n${note}` };
  else out.push({ role: 'user', content: note });
  return out;
}

export type Emit = (event: StreamEvent) => void | Promise<void>;

/** A reply being built. Rows from the repo are read-only. */
type Draft = { -readonly [K in keyof MessageRow]: MessageRow[K] };

export interface ChatDependencies {
  repos: Repos;
  settings: SettingsService;
  providers: ProviderRegistry;
  memory: MemoryService;
  tools: ToolRegistry;
  store: MessageStore;
  attachments: AttachmentService;
  approvals: ApprovalBroker;
  workspaces: WorkspaceService;
}

interface Assembled {
  system: string;
  factCount: number;
  web: WebPlan;
  tools: ToolDefinition[];
  params: GenerationParams;
  settings: AppSettings;
  provider: ProviderId;
  maxToolRounds: number;
}

interface StepResult {
  text: string;
  raw: unknown;
  finish: string | null;
  calls: ToolCall[];
  /** Output reached the user, so the step can't be retried silently. */
  emitted: boolean;
  error: unknown;
}

function emptyRow(conversationId: string, paneId: string): Draft {
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
    attachments: null,
    trace: null,
    preferred: null,
    createdAt: new Date(),
  };
}

function attachmentRefs(rows: MessageRow[]): AttachmentRef[] {
  return rows.flatMap((row) => (row.attachments as AttachmentRef[] | null) ?? []);
}

export class ChatService {
  private readonly deps: ChatDependencies;
  private readonly log: Logger = createLogger('chat');
  /** provider:model -> when the model last rejected tool definitions. */
  private readonly noToolModels = new Map<string, number>();

  constructor(deps: ChatDependencies) {
    this.deps = deps;
  }

  private async profileOf(pane: PaneRow): Promise<SystemPromptRow | null> {
    return pane.systemPromptId ? await this.deps.repos.systemPrompts.findById(pane.systemPromptId) : null;
  }

  private async assemble(conversation: ConversationRow, pane: PaneRow, rows: MessageRow[], query: string): Promise<Assembled> {
    const { memory, tools } = this.deps;
    const settings = await this.deps.settings.getAll();
    const profile = await this.profileOf(pane);
    const profileTools = (profile?.tools as string[] | null) ?? null;
    const provider = pane.provider as ProviderId;

    let web = planWeb(conversation.webAccess, settings.web, provider, pane.model);
    if (profileTools && !profileTools.includes('web')) web = { search: null, fetch: false, nativeSearch: false, resolved: 'none', note: null };
    const offered = await tools.resolve({ conversation, settings, web, profileTools, attachments: attachmentRefs(rows) });
    const hasMemoryTools = offered.some((tool) => tool.group === 'memory');
    const facts = hasMemoryTools ? await memory.activeFacts({ query, profileId: pane.systemPromptId }) : [];

    const hostFolderPath = conversation.hostFolderPath;
    const workspace = offered.some((tool) => tool.group === 'files')
      ? workspaceGuidance(
          (await this.deps.workspaces.exists(conversation.id, hostFolderPath)) ? await this.deps.workspaces.files(conversation.id, '', hostFolderPath) : [],
          offered.some((tool) => tool.group === 'commands'),
          hostFolderPath,
        )
      : '';

    const base = pane.systemPrompt ?? profile?.content ?? '';
    const today = new Date().toISOString().slice(0, 10);
    const system = [
      buildSystemPrompt(base, facts),
      hasMemoryTools ? memoryGuidance() : '',
      workspace,
      webGuidance({ ...web, search: offered.some((tool) => tool.spec.name === 'web_search') ? web.search : null, fetch: offered.some((tool) => tool.spec.name === 'web_fetch') }),
      offered.some((tool) => tool.untrusted) ? UNTRUSTED_GUIDANCE : '',
      offered.length > 0 || web.nativeSearch ? `Today's date is ${today}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      system,
      factCount: facts.length,
      web,
      tools: offered,
      params: mergeParams(settings.generation, profile?.params as Partial<GenerationParams> | null, pane.params as Partial<GenerationParams>),
      settings,
      provider,
      maxToolRounds: profile?.maxToolRounds ?? settings.agent.maxToolRounds,
    };
  }

  async preview(conversation: ConversationRow, pane: PaneRow): Promise<PromptPreview> {
    const rows = await this.deps.store.list(conversation, pane.id);
    const query = rows.findLast((row) => row.role === 'user')?.content ?? '';
    const assembled = await this.assemble(conversation, pane, rows, query);
    return {
      system: assembled.system,
      memoryCount: assembled.factCount,
      tools: assembled.tools.map((tool) => tool.spec.name),
      search: assembled.web.resolved,
      searchNote: assembled.web.note,
      provider: assembled.provider,
      model: pane.model,
      params: assembled.params,
      maxToolRounds: assembled.maxToolRounds,
    };
  }

  /**
   * Streams every target pane concurrently. `controllers` receives one AbortController per pane
   * so a caller can stop a single pane without touching the others.
   */
  async run(request: StreamRequest, emit: Emit, controllers: Map<string, AbortController>): Promise<void> {
    const { repos, attachments } = this.deps;
    const conversation = await repos.conversations.findById(request.conversationId);
    if (!conversation) throw new Error('Conversation not found');
    const panes = await repos.panes.findMany({ where: { conversationId: conversation.id } });
    const targets = request.paneIds.map((id) => panes.find((pane) => pane.id === id));
    if (targets.some((pane) => !pane)) throw new Error('A pane was not found in this conversation');
    if (request.action === 'edit' && targets.some((pane) => !editTarget(request, pane as PaneRow))) {
      throw new Error('Name the message to edit in each pane');
    }
    if (request.action === 'continue' && targets.some((pane) => !editTarget(request, pane as PaneRow))) {
      throw new Error('Name the reply to continue in each pane');
    }

    const content = request.content ?? '';
    const refs = request.action === 'send' && request.attachmentIds?.length ? await attachments.claim(request.attachmentIds, conversation.id) : [];
    const log = this.log.child({ runId: request.runId, conversationId: conversation.id });
    log.info('run started', { action: request.action, panes: targets.length, attachments: refs.length });

    const title =
      request.action === 'send' && conversation.title === DEFAULT_TITLE
        ? this.titleFor(content, titleFrom(content || refs[0]?.name || ''), log)
        : null;

    const results = await Promise.all(
      (targets as PaneRow[]).map(async (pane) => {
        const controller = new AbortController();
        controllers.set(pane.id, controller);
        try {
          return await this.runPane(conversation, pane, request, refs, emit, controller.signal, log.child({ paneId: pane.id }));
        } finally {
          controllers.delete(pane.id);
        }
      }),
    );

    // Updating the chat also moves it to the top of the list.
    await repos.conversations.update(conversation.id, { title: title ? await title : conversation.title });

    const reply = results.find((result) => result && !result.error && result.content);
    if (request.action === 'send' && conversation.useMemory && reply && content) {
      this.deps.memory
        .suggest(conversation.id, [
          { role: 'user', content },
          { role: 'assistant', content: reply.content },
        ])
        .catch(() => {
          // MemoryService records the failure for the Memory page.
        });
    }
    log.info('run finished', { replies: results.filter(Boolean).length });
  }

  /** A title from the title model, or `fallback` when none is set or it fails. */
  private async titleFor(content: string, fallback: string, log: Logger): Promise<string> {
    const { titleModel } = await this.deps.settings.get('general');
    if (!titleModel || !content.trim()) return fallback;
    try {
      const provider = await this.deps.providers.get(titleModel.provider);
      let text = '';
      for await (const event of provider.streamChat({
        model: titleModel.model,
        system: TITLE_PROMPT,
        messages: [{ role: 'user', content: content.slice(0, 2_000) }],
        params: mergeParams({ temperature: 0.3, maxTokens: 2_000, reasoningEffort: 'low' }),
        signal: AbortSignal.timeout(20_000),
      })) {
        if (event.type === 'text') text += event.text;
      }
      return cleanTitle(text) || fallback;
    } catch (error) {
      log.warn('title model failed', { error });
      return fallback;
    }
  }

  /** Applies the action to the pane's messages and returns the history to answer, or null after reporting a problem. */
  private async prepareTurn(
    conversation: ConversationRow,
    pane: PaneRow,
    request: StreamRequest,
    refs: AttachmentRef[],
    emit: Emit,
  ): Promise<{ rows: MessageRow[]; query: string; resume?: MessageRow } | null> {
    const { store } = this.deps;
    // A reply another run is still writing isn't history yet.
    const rows = (await store.list(conversation, pane.id)).filter((row) => row.finishReason !== STREAMING_FINISH);
    const content = request.content ?? '';

    if (request.action === 'continue') {
      const index = rows.findIndex((row) => row.id === editTarget(request, pane) && row.role === 'assistant');
      const target = rows[index];
      if (!target) {
        await emit({ type: 'error', paneId: pane.id, error: 'That reply is no longer in this pane.', message: null });
        return null;
      }
      await store.deleteAfter(conversation, pane.id, target.id);
      await emit({ type: 'truncate', paneId: pane.id, messageId: target.id });
      const query = rows.slice(0, index).findLast((row) => row.role === 'user')?.content ?? '';
      return { rows: rows.slice(0, index), query, resume: target };
    }

    if (request.action === 'send') {
      const user = await store.create(conversation, { ...emptyRow(conversation.id, pane.id), role: 'user', content, attachments: refs.length ? refs : null });
      await emit({ type: 'user', paneId: pane.id, message: toMessage(user) });
      return { rows: [...rows, user], query: content };
    }

    const index =
      request.action === 'edit'
        ? rows.findIndex((row) => row.id === editTarget(request, pane) && row.role === 'user')
        : rows.findLastIndex((row) => row.role === 'user');
    const target = rows[index];
    if (!target) {
      const error = request.action === 'edit' ? 'That message is no longer in this pane.' : 'There is no message to answer again.';
      await emit({ type: 'error', paneId: pane.id, error, message: null });
      return null;
    }
    await store.deleteAfter(conversation, pane.id, target.id);
    await emit({ type: 'truncate', paneId: pane.id, messageId: target.id });
    if (request.action === 'regenerate') return { rows: rows.slice(0, index + 1), query: target.content };

    const edited = (await store.update(conversation, target.id, { content })) ?? { ...target, content };
    await emit({ type: 'user', paneId: pane.id, message: toMessage(edited) });
    return { rows: [...rows.slice(0, index), edited], query: content };
  }

  private async runPane(
    conversation: ConversationRow,
    pane: PaneRow,
    request: StreamRequest,
    refs: AttachmentRef[],
    emit: Emit,
    signal: AbortSignal,
    log: Logger,
  ): Promise<MessageRow | null> {
    const { providers, attachments } = this.deps;

    const { store } = this.deps;
    let draft: Draft = { ...emptyRow(conversation.id, pane.id), provider: pane.provider, model: pane.model };
    /** Whether the draft has a row yet, and what it had used before this run when it continues an earlier reply. */
    let saved = false;
    let before: Pick<MessageRow, 'tokensIn' | 'tokensOut' | 'cost'> | null = null;
    const items = new Map<string, ActivityItem>();
    const sources = new Map<string, Source>();
    const activity = (): Draft['activity'] => {
      if (items.size === 0 && sources.size === 0) return draft.activity;
      // Anything still marked running was cut short by a stop or an error.
      const finished = [...items.values()].map((item) => (item.done ? item : { ...item, done: true }));
      return { items: finished as ActivityItem[], sources: [...sources.values()] };
    };

    // The reply is written to its row as it streams, so a dropped server keeps what was said so far.
    let writes: Promise<unknown> = Promise.resolve();
    let lastWrite = 0;
    const checkpoint = () => {
      if (!saved || performance.now() - lastWrite < CHECKPOINT_MS) return;
      lastWrite = performance.now();
      const changes = { content: draft.content, reasoning: draft.reasoning, attachments: draft.attachments, activity: activity() };
      writes = writes.then(() => store.update(conversation, draft.id, changes)).catch((error: unknown) => log.warn('could not save progress', { error }));
    };

    const recordActivity = (item: ActivityItem) => {
      items.set(item.id, item);
      void emit({ type: 'activity', paneId: pane.id, item });
      checkpoint();
    };
    const notice = (text: string) => recordActivity({ id: randomUUID(), kind: 'notice', text, done: true });
    const recordSource = (source: Source) => {
      if (sources.has(source.url)) return;
      sources.set(source.url, source);
      void emit({ type: 'source', paneId: pane.id, source });
    };

    const started = performance.now();
    let firstToken: number | null = null;
    const trace: LoopMessage[] = [];

    try {
      // prepareTurn is inside this try too: if the connection dies right after the user's message is
      // saved but before a reply starts, the pane still gets a placeholder to retry instead of a
      // dangling message whose only way back is editing it.
      const turn = await this.prepareTurn(conversation, pane, request, refs, emit);
      if (!turn) return null;
      if (turn.resume) {
        // Carry on in the same row: new text is added to what was already written.
        const { resume } = turn;
        before = { tokensIn: resume.tokensIn, tokensOut: resume.tokensOut, cost: resume.cost };
        draft = { ...resume, provider: pane.provider, model: pane.model, finishReason: null, error: null, trace: null };
        const previous = resume.activity as { items: ActivityItem[]; sources: Source[] } | null;
        for (const item of previous?.items ?? []) items.set(item.id, item);
        for (const source of previous?.sources ?? []) sources.set(source.url, source);
        await store.update(conversation, draft.id, { ...draft, finishReason: STREAMING_FINISH });
      } else {
        draft = { ...draft, ...(await store.create(conversation, { ...draft, finishReason: STREAMING_FINISH })), finishReason: null };
      }
      saved = true;
      lastWrite = performance.now();
      await emit(
        turn.resume
          ? { type: 'start', paneId: pane.id, messageId: draft.id, text: draft.content, reasoning: draft.reasoning ?? '' }
          : { type: 'start', paneId: pane.id, messageId: draft.id },
      );

      const assembled = await this.assemble(conversation, pane, turn.rows, turn.query);
      const provider = await providers.get(assembled.provider);
      const refsInHistory = attachmentRefs(turn.rows);
      const loaded = new Map((await attachments.load(refsInHistory)).map((item): [string, LoopAttachment] => [item.id, item]));
      const history = buildHistory(turn.resume ? [...turn.rows, turn.resume] : turn.rows, {
        provider: assembled.provider,
        model: pane.model,
        keepToolResults: assembled.settings.agent.keepToolResults,
        attachments: loaded,
      });
      const messages: LoopMessage[] = turn.resume ? withContinueNote(history, turn.resume) : [...history];
      const protectFrom = Math.max(0, history.findLastIndex((message) => message.role === 'user'));
      const contextLength = providers.cachedModel(assembled.provider, pane.model)?.contextLength ?? DEFAULT_CONTEXT_TOKENS;
      const budget = Math.max(4_000, Math.floor(contextLength * 0.9) - (assembled.params.maxTokens ?? 8_192) - Math.ceil(assembled.system.length / 4));

      let web = assembled.web;
      let tools = assembled.tools;
      // Image models answer with a generated attachment, not tool use or web search.
      const imageOutput = isImageModel({ provider: assembled.provider, model: pane.model }, providers.cachedModel(assembled.provider, pane.model));
      if (imageOutput) {
        tools = [];
        web = { search: null, fetch: false, nativeSearch: false, resolved: 'none', note: null };
      }
      if (web.note) notice(web.note);
      const modelKey = `${assembled.provider}:${pane.model}`;
      const rejectedAt = this.noToolModels.get(modelKey);
      if (rejectedAt && Date.now() - rejectedAt < NO_TOOLS_MEMORY_MS && (tools.length > 0 || web.nativeSearch)) {
        notice(`This model recently rejected tools, so it answered without ${this.lostAbilities(tools, web)}.`);
        tools = [];
        web = { ...web, nativeSearch: false, resolved: 'none' };
      }

      let toolRounds = 0;
      let pauseResumes = 0;
      let budgetSpent = false;
      let budgetNoticed = false;

      while (true) {
        const fitted = fitToBudget(messages, budget, protectFrom);
        if ((fitted.shortened > 0 || fitted.dropped > 0) && !budgetNoticed) {
          budgetNoticed = true;
          notice(
            fitted.dropped > 0
              ? `The chat is longer than this model's context window, so the ${fitted.dropped} earliest ${fitted.dropped === 1 ? 'exchange was' : 'exchanges were'} left out.`
              : 'Some long tool results were shortened to fit the context window.',
          );
        }

        const step = await this.streamStep(
          provider,
          {
            model: pane.model,
            system: assembled.system,
            messages: fitted.messages,
            params: assembled.params,
            signal,
            tools: tools.map((tool) => tool.spec),
            nativeSearch: web.nativeSearch,
            imageOutput,
          },
          {
            draft,
            paneId: pane.id,
            emit,
            recordActivity,
            recordSource,
            onFirstToken: () => {
              firstToken ??= performance.now();
            },
            onProgress: checkpoint,
            // A continuation picks up mid-sentence, so its first words join straight onto the old ones.
            joinDirectly: Boolean(turn.resume) && toolRounds === 0 && pauseResumes === 0,
          },
        );

        if (step.error) {
          // Many local models reject tool definitions outright. Answer without tools instead of failing.
          if (!step.emitted && !signal.aborted && (tools.length > 0 || web.nativeSearch) && isToolsUnsupported(step.error)) {
            this.noToolModels.set(modelKey, Date.now());
            notice(`This model does not support tools, so it answered without ${this.lostAbilities(tools, web)}.`);
            log.info('model rejected tools', { model: modelKey });
            tools = [];
            web = { ...web, nativeSearch: false, resolved: 'none' };
            continue;
          }
          throw step.error;
        }

        if (signal.aborted) break;
        if (step.finish === 'pause_turn' && pauseResumes < MAX_PAUSE_RESUMES) {
          pauseResumes++;
          const parked: LoopMessage = { role: 'assistant', content: step.text, raw: step.raw };
          messages.push(parked);
          trace.push(parked);
          continue;
        }
        draft.finishReason = step.finish;
        if (step.calls.length === 0 || budgetSpent) {
          // The last step. Calls made after the limit are dropped, along with the blocks that hold them.
          trace.push(step.calls.length === 0 ? { role: 'assistant', content: step.text, raw: step.raw } : { role: 'assistant', content: step.text });
          break;
        }

        const withCalls: LoopMessage = { role: 'assistant', content: step.text, toolCalls: step.calls, raw: step.raw };
        messages.push(withCalls);
        trace.push(withCalls);
        toolRounds++;

        let results: ToolResult[];
        if (toolRounds > assembled.maxToolRounds) {
          // Out of rounds: answer each call with a stop signal and give the model one last turn.
          budgetSpent = true;
          results = step.calls.map(() => ({ content: 'Tool limit reached. Answer now using what you have found so far.', isError: true }));
        } else {
          const context: ToolRunContext = {
            conversationId: conversation.id,
            hostFolderPath: conversation.hostFolderPath,
            paneId: pane.id,
            settings: assembled.settings,
            web,
            attachments: refsInHistory,
            signal,
            onActivity: recordActivity,
            onSource: recordSource,
          };
          results = await this.executeTools(step.calls, tools, context, emit);
        }
        step.calls.forEach((call, index) => {
          const result = results[index];
          const message: LoopMessage = {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: result?.content ?? 'Error: no result',
            isError: result?.isError ?? true,
          };
          messages.push(message);
          trace.push(message);
        });
        if (signal.aborted) break;
      }
      if (signal.aborted) draft.finishReason = 'aborted';
    } catch (error) {
      if (signal.aborted) draft.finishReason = 'aborted';
      else {
        draft.error = errorMessage(error);
        log.warn('reply failed', { error: draft.error });
      }
    }

    draft.latencyMs = Math.round(performance.now() - started);
    draft.ttftMs = firstToken === null ? null : Math.round(firstToken - started);
    draft.activity = activity();
    draft.trace = traceForStorage(trace);
    await writes;
    let row: MessageRow;
    if (!saved) {
      row = await store.create(conversation, draft);
    } else {
      // Null when the chat was deleted mid-reply; the client still gets the reply it watched being written.
      row = (await store.update(conversation, draft.id, draft).catch(() => null)) ?? draft;
      // A continuation records only what it added, as its own entry.
      const spent = before
        ? {
            ...row,
            id: randomUUID(),
            createdAt: new Date(),
            tokensIn: difference(row.tokensIn, before.tokensIn),
            tokensOut: difference(row.tokensOut, before.tokensOut),
            cost: difference(row.cost, before.cost),
          }
        : row;
      await store.recordUsage(conversation, spent);
    }
    const message = toMessage(row);

    if (row.error) await emit({ type: 'error', paneId: pane.id, error: row.error, message });
    else await emit({ type: 'done', paneId: pane.id, message });
    return row;
  }

  private lostAbilities(tools: ToolDefinition[], web: WebPlan): string {
    const lost = [
      tools.some((tool) => tool.group === 'web') || web.nativeSearch ? 'web access' : null,
      tools.some((tool) => tool.group === 'memory') ? 'saving memories' : null,
      tools.some((tool) => tool.group !== 'web' && tool.group !== 'memory') ? 'its other tools' : null,
    ].filter(Boolean);
    return lost.join(' or ') || 'tools';
  }

  /** One request to the provider, streaming text and reasoning into the draft as it arrives. */
  private async streamStep(
    provider: Provider,
    request: ChatRequest,
    sink: {
      draft: Draft;
      paneId: string;
      emit: Emit;
      recordActivity: (item: ActivityItem) => void;
      recordSource: (source: Source) => void;
      onFirstToken: () => void;
      /** Called as the draft grows, so it can be saved now and then. */
      onProgress: () => void;
      /** Add the first text straight onto the draft, with no break before it. */
      joinDirectly: boolean;
    },
  ): Promise<StepResult> {
    const { draft, paneId, emit } = sink;
    let reasoningStarted = false;
    const result: StepResult = { text: '', raw: undefined, finish: null, calls: [], emitted: false, error: null };
    try {
      for await (const event of provider.streamChat(request)) {
        switch (event.type) {
          case 'text': {
            sink.onFirstToken();
            // Separate what the model says before and after a round of tool calls.
            const separator = !result.text && !sink.joinDirectly && draft.content && !draft.content.endsWith('\n') ? '\n\n' : '';
            result.text += event.text;
            draft.content += separator + event.text;
            result.emitted = true;
            await emit({ type: 'delta', paneId, text: separator + event.text });
            sink.onProgress();
            break;
          }
          case 'reasoning': {
            sink.onFirstToken();
            // Reasoning picked up again after a continue starts on a fresh paragraph.
            const separator = !reasoningStarted && sink.joinDirectly && draft.reasoning && !draft.reasoning.endsWith('\n') ? '\n\n' : '';
            reasoningStarted = true;
            draft.reasoning = (draft.reasoning ?? '') + separator + event.text;
            result.emitted = true;
            await emit({ type: 'reasoning', paneId, text: separator + event.text });
            sink.onProgress();
            break;
          }
          case 'usage':
            // Each request in a tool loop is billed separately, so the counts add up.
            if (event.inputTokens !== undefined) draft.tokensIn = (draft.tokensIn ?? 0) + event.inputTokens;
            if (event.outputTokens !== undefined) draft.tokensOut = (draft.tokensOut ?? 0) + event.outputTokens;
            if (event.cost !== undefined) draft.cost = (draft.cost ?? 0) + event.cost;
            break;
          case 'finish':
            result.finish = event.reason;
            break;
          case 'tool_call':
            result.calls.push(event.call);
            break;
          case 'native_search':
            result.emitted = true;
            sink.recordActivity({ id: randomUUID(), kind: 'search', engine: 'native', query: event.query, resultCount: null, done: true });
            break;
          case 'source':
            sink.recordSource({ url: event.url, title: event.title });
            break;
          case 'assistant_raw':
            result.raw = event.content;
            break;
          case 'image': {
            sink.onFirstToken();
            const attachment = await this.deps.attachments.create({
              name: `generated-${Date.now()}.${extFromMime(event.mimeType)}`,
              mimeType: event.mimeType,
              data: event.data,
              conversationId: draft.conversationId,
            });
            draft.attachments = [...((draft.attachments as AttachmentRef[] | null) ?? []), toRef(attachment)];
            result.emitted = true;
            sink.onProgress();
            break;
          }
        }
      }
    } catch (error) {
      result.error = error;
    }
    return result;
  }

  /** Runs a round of tool calls through the registry, a few at a time, asking for approval where the policy says so. */
  private async executeTools(calls: ToolCall[], offered: ToolDefinition[], context: ToolRunContext, emit: Emit): Promise<ToolResult[]> {
    const { tools, approvals } = this.deps;
    const byName = new Map(offered.map((tool) => [tool.spec.name, tool]));
    return mapLimit(calls, context.settings.agent.maxParallelTools, async (call) => {
      const definition = byName.get(call.name);
      return tools.execute(definition, call, context, {
        policy: definition ? tools.policyOf(definition, context.settings) : 'auto',
        approve: async (request) => {
          await emit({ type: 'approval', paneId: context.paneId, request });
          const approved = await approvals.wait(request.id, context.signal);
          await emit({ type: 'approval_resolved', paneId: context.paneId, id: request.id, approved });
          return approved;
        },
      });
    });
  }
}
