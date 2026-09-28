import { mergeParams } from '../../shared/defaults.ts';
import type {
  ChatTurn,
  MemoryAction,
  MemoryActor,
  MemoryConflict,
  MemoryDuplicate,
  ModelRef,
  SuggestionStatus,
} from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';
import type { MemoryRow } from '../db/schemas.ts';
import { createLogger } from '../log.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { serialize } from './serialize.ts';
import type { SettingsService } from './settings.ts';

const log = createLogger('memory');

/** Most facts one exchange may add. */
const MAX_SUGGESTIONS = 2;
/**
 * A suggestion this close to any memory already stored is dropped: whether it was saved, suggested,
 * rejected or forgotten, the user has already seen it once and answered. Unrelated memories score
 * under 0.3 and rewordings of one fact 0.5 or more.
 */
const RESEMBLANCE_LIMIT = 0.5;
/** Recent rejections shown to the suggestion model as examples of what not to suggest. */
const REJECTED_EXAMPLES = 20;
/** The reply is only context, so a long one is cut short. */
const REPLY_CONTEXT_CHARS = 1_500;
const USER_MESSAGE_CHARS = 8_000;

/** Tells the model it has memory, including when nothing is stored yet, so it stops claiming it can't remember. */
export function memoryGuidance(): string {
  return (
    'You have long-term memory that persists across conversations. ' +
    'When the user asks you to remember something, or shares a lasting preference or fact about themselves, save it with memory_save, then confirm briefly. ' +
    'When something you remember changes, use memory_update. When they ask you to forget something, use memory_forget. ' +
    'Never tell the user that you cannot remember things between conversations.'
  );
}

export interface MemoryFact {
  content: string;
  category: string;
}

const MEMORY_PREAMBLE =
  'Things the user has asked you to remember about them and their preferences. ' +
  'Use them when relevant. Do not recite this list unless asked.';

export function buildSystemPrompt(base: string, memories: MemoryFact[]): string {
  const parts: string[] = [];
  if (base.trim()) parts.push(base.trim());
  if (memories.length > 0) {
    const lines = memories.map((memory) =>
      memory.category && memory.category !== 'general' ? `- [${memory.category}] ${memory.content}` : `- ${memory.content}`,
    );
    parts.push(`<memory>\n${MEMORY_PREAMBLE}\n${lines.join('\n')}\n</memory>`);
  }
  return parts.join('\n\n');
}

export function normalizeFact(content: string): string {
  return content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const STOPWORDS = new Set(
  'the and for are but not you your with this that have has had was were will would can could should what when where which who how why about from into over than then them they their there these those some any all more most very just also only such our out its his her him she has does did doing been being because while each both few other same own too here after before again further once'.split(
    ' ',
  ),
);

function keywords(text: string): string[] {
  return normalizeFact(text)
    .split(' ')
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Picks the facts most related to `query` when there are more than `limit`. Each shared keyword
 * scores by how rare it is among the facts, so "Oslo" counts for more than "prefers". Ties, and
 * facts that share nothing, keep the most recently updated order.
 */
export function rankFacts<T extends { content: string; category: string; updatedAt: Date }>(facts: T[], query: string, limit: number): T[] {
  const byRecency = facts.toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  if (byRecency.length <= limit) return byRecency;
  const wanted = new Set(keywords(query));
  if (wanted.size === 0) return byRecency.slice(0, limit);

  const documents = byRecency.map((fact) => new Set(keywords(`${fact.content} ${fact.category}`)));
  const frequency = new Map<string, number>();
  for (const words of documents) for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);

  const scored = byRecency.map((fact, index) => {
    let score = 0;
    for (const word of documents[index] ?? []) {
      if (wanted.has(word)) score += Math.log(1 + byRecency.length / (frequency.get(word) ?? 1));
    }
    return { fact, score, index };
  });
  return scored
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.fact);
}

/** Share of words two facts have in common, from 0 to 1. */
export function similarity(first: string, second: string): number {
  const a = new Set(normalizeFact(first).split(' ').filter(Boolean));
  const b = new Set(normalizeFact(second).split(' ').filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * How much two facts say the same thing, from 0 to 1, by their keywords. Word overlap alone misses a
 * short rewording of a longer fact ("Has Blender installed" against "Uses Blender for 3D, installed
 * locally"), so the shared keywords' share of the shorter fact counts too. Two short facts sharing a
 * couple of words are often opposites ("Prefers TypeScript over JavaScript" and "Prefers Python over
 * JavaScript"), so under three shared keywords only counts when one fact is wholly inside the other.
 */
export function resemblance(first: string, second: string): number {
  const a = new Set(keywords(first));
  const b = new Set(keywords(second));
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const shorter = Math.min(a.size, b.size);
  if (shared === 0 || (shared < 3 && shared < shorter)) return 0;
  return Math.max(shared / (a.size + b.size - shared), shared / shorter);
}

/** Pulls a JSON array out of a model reply, tolerating code fences and surrounding prose. */
function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseSuggestions(text: string, limit = 5): MemoryFact[] {
  const facts: MemoryFact[] = [];
  for (const item of extractJsonArray(text)) {
    const content = typeof item === 'string' ? item : (item as { content?: unknown })?.content;
    const category = typeof item === 'object' && item ? (item as { category?: unknown }).category : undefined;
    if (typeof content !== 'string' || content.trim().length < 3) continue;
    facts.push({
      content: content.trim().slice(0, 500),
      category: typeof category === 'string' && category.trim() ? category.trim().toLowerCase().slice(0, 40) : 'general',
    });
    if (facts.length >= limit) break;
  }
  return facts;
}

/**
 * Deliberately strict. Most memories are saved on purpose, on the Memory page or by asking a model to
 * remember something, so a suggestion only earns its place when it would matter in unrelated chats.
 */
const SUGGESTION_PROMPT = `You maintain a small long-term memory about one user. The user saves most memories themselves, so you only suggest a fact when it is clearly worth keeping. Suggesting nothing is the normal outcome.

A fact qualifies only if all of these hold:
- The user said it about themselves in their own message. The assistant's reply is there to help you understand the user's message and is never a source of facts.
- It would still help in an unrelated conversation a month from now.
- No existing memory covers it, and it is nothing like a fact the user rejected.

Never suggest:
- Details of the current task: answers, solutions, file names, paths, image sizes, code, or numbers from the problem.
- Facts about the assistant, its tools, the workspace or sandbox, or software installed there.
- Interests guessed from one question. Asking about a topic once does not make it an interest.
- Instructions that only make sense for one kind of task.

Good: "Prefers metric units", "Is a backend developer who mainly writes Go", "Wants answers without emoji".
Bad: "The puzzle's correct answer was option 4", "Has Python available in the workspace", "Interested in bond markets" (from a single question about them).

Reply with only a JSON array of at most ${MAX_SUGGESTIONS} facts, for example:
[{"content": "Prefers TypeScript over JavaScript", "category": "preferences"}]
Use short categories such as preferences, background, instructions. Reply [] when nothing qualifies.`;

const CONFLICT_PROMPT = `You review a list of remembered facts about one user. Find pairs of facts that contradict each other, such as two different home cities or opposite preferences. Facts that merely overlap are not conflicts.

Reply with only a JSON array, for example:
[{"first": 3, "second": 7, "reason": "Different home cities"}]
Use the numbers from the list. Reply [] when nothing conflicts.`;

function bulleted(rows: Pick<MemoryRow, 'content'>[]): string {
  return rows.map((row) => `- ${row.content}`).join('\n') || '(none)';
}

/**
 * What the suggestion model reads. Only the user's own words count as evidence; the reply is labeled
 * as context, since facts about the sandbox and the task were mostly lifted from replies and tool output.
 */
export function suggestionInput(exchange: ChatTurn[], current: Pick<MemoryRow, 'content'>[], rejected: Pick<MemoryRow, 'content'>[]): string {
  const said = (role: ChatTurn['role'], limit: number) =>
    exchange
      .filter((turn) => turn.role === role)
      .map((turn) => (turn.content.length > limit ? `${turn.content.slice(0, limit)}…` : turn.content))
      .join('\n\n');
  return [
    `Existing memories, saved or waiting for review:\n${bulleted(current)}`,
    `Facts the user rejected. Never suggest these or anything like them:\n${bulleted(rejected.slice(0, REJECTED_EXAMPLES))}`,
    `The user's message, the only evidence you may use:\n${said('user', USER_MESSAGE_CHARS) || '(empty)'}`,
    `The assistant's reply, for context only:\n${said('assistant', REPLY_CONTEXT_CHARS) || '(empty)'}`,
  ].join('\n\n');
}

export interface MatchResult {
  match: MemoryRow | null;
  candidates: MemoryRow[];
}

export class MemoryService {
  private readonly repos: Repos;
  private readonly settings: SettingsService;
  private readonly registry: ProviderRegistry;
  private status: SuggestionStatus = { lastRunAt: null, lastAdded: 0, lastError: null, lastErrorAt: null };

  /** Serializes memory writes so panes saving the same fact at once don't store it twice. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(repos: Repos, settings: SettingsService, registry: ProviderRegistry) {
    this.repos = repos;
    this.settings = settings;
    this.registry = registry;
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writes.then(task, task);
    this.writes = next.catch(() => undefined);
    return next;
  }

  async record(memoryId: string, action: MemoryAction, actor: MemoryActor, content: string, previousContent: string | null = null): Promise<void> {
    await this.repos.memoryHistory.create({ memoryId, action, actor, content, previousContent, createdAt: new Date() });
  }

  async history(memoryId: string) {
    return this.repos.memoryHistory.findMany({
      where: { memoryId },
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
    });
  }

  /** Stores a fact a model saved as active. Returns false when an equivalent active memory already exists. */
  save(content: string, category: string, conversationId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const key = normalizeFact(content);
      const existing = await this.repos.memories.findMany();
      const match = existing.find((memory) => normalizeFact(memory.content) === key);
      if (match) {
        // Saying it again counts as confirming it, even if it was dismissed, forgotten or paused before.
        if (match.status !== 'active' || !match.enabled) {
          await this.repos.memories.update(match.id, { status: 'active', enabled: true });
          await this.record(match.id, 'restored', 'model', match.content);
          return true;
        }
        return false;
      }
      const row = await this.repos.memories.create({
        content,
        category,
        enabled: true,
        source: 'model',
        status: 'active',
        scope: null,
        sourceConversationId: conversationId,
      });
      await this.record(row.id, 'created', 'model', content);
      return true;
    });
  }

  /** Finds the one active memory that `text` refers to: an exact match, else the only one containing it. */
  async match(text: string): Promise<MatchResult> {
    const key = normalizeFact(text);
    const active = await this.repos.memories.findMany({ where: { status: 'active' } });
    const exact = active.filter((memory) => normalizeFact(memory.content) === key);
    const candidates = exact.length > 0 ? exact : active.filter((memory) => normalizeFact(memory.content).includes(key));
    return { match: candidates.length === 1 ? (candidates[0] ?? null) : null, candidates };
  }

  /** Moves the matching memory to Forgotten, where the user can restore it. */
  forget(text: string): Promise<MatchResult> {
    return this.exclusive(async () => {
      const result = await this.match(text);
      if (result.match) {
        await this.repos.memories.update(result.match.id, { status: 'forgotten' });
        await this.record(result.match.id, 'forgotten', 'model', result.match.content);
      }
      return result;
    });
  }

  /** Rewrites the matching memory. */
  update(text: string, content: string): Promise<MatchResult> {
    return this.exclusive(async () => {
      const result = await this.match(text);
      if (result.match) {
        await this.repos.memories.update(result.match.id, { content });
        await this.record(result.match.id, 'updated', 'model', content, result.match.content);
      }
      return result;
    });
  }

  async list(): Promise<MemoryRow[]> {
    return this.repos.memories.findMany({
      where: { status: 'active' },
      orderBy: [{ field: 'updatedAt', direction: 'desc' }],
    });
  }

  /**
   * The memories to put in a prompt: active and enabled, for every chat or for this profile, and
   * at most `maxInjected`, chosen by relevance to `query` when there are more.
   */
  async activeFacts(options: { query?: string; profileId?: string | null } = {}): Promise<MemoryRow[]> {
    const { maxInjected } = await this.settings.get('memory');
    if (maxInjected <= 0) return [];
    const rows = await this.repos.memories.findMany({ where: { status: 'active', enabled: true } });
    const inScope = rows.filter((row) => row.scope === null || row.scope === options.profileId);
    return rankFacts(inScope, options.query ?? '', maxInjected);
  }

  suggestionStatus(): SuggestionStatus {
    return this.status;
  }

  /** Asks the suggestion model for new facts and stores them as pending. Returns how many were added. */
  async suggest(conversationId: string, exchange: ChatTurn[], signal?: AbortSignal): Promise<number> {
    const memorySettings = await this.settings.get('memory');
    const model: ModelRef | null = memorySettings.suggestionModel;
    if (!memorySettings.autoSuggest || !model) return 0;

    try {
      const existing = await this.repos.memories.findMany({ orderBy: [{ field: 'updatedAt', direction: 'desc' }] });
      const known = new Set(existing.map((memory) => normalizeFact(memory.content)));
      const current = existing.filter((memory) => memory.status === 'active' || memory.status === 'pending');
      const rejected = existing.filter((memory) => memory.status === 'rejected');
      const reply = await this.complete(model, SUGGESTION_PROMPT, suggestionInput(exchange, current, rejected), signal);

      let added = 0;
      // The cap counts what survives the checks below, so echoes of old memories don't use it up.
      for (const fact of parseSuggestions(reply)) {
        if (added >= MAX_SUGGESTIONS) break;
        const key = normalizeFact(fact.content);
        if (!key || known.has(key)) continue;
        const echo = existing.find((row) => resemblance(row.content, fact.content) >= RESEMBLANCE_LIMIT);
        if (echo) {
          log.info('suggestion dropped', { conversationId, content: fact.content, resembles: echo.id, status: echo.status });
          continue;
        }
        known.add(key);
        const row = await this.repos.memories.create({
          content: fact.content,
          category: fact.category,
          enabled: true,
          source: 'suggested',
          status: 'pending',
          scope: null,
          sourceConversationId: conversationId,
        });
        // Later suggestions from this same reply are compared against it too.
        existing.push(row);
        await this.record(row.id, 'created', 'suggestion', fact.content);
        added++;
      }
      this.status = { ...this.status, lastRunAt: new Date().toISOString(), lastAdded: added, lastError: null };
      return added;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const at = new Date().toISOString();
      this.status = { lastRunAt: at, lastAdded: 0, lastError: message, lastErrorAt: at };
      log.warn('suggestion failed', { conversationId, error: message });
      throw error;
    }
  }

  /** Pairs of active memories worded alike enough to be the same fact. */
  async duplicates(threshold = 0.6): Promise<MemoryDuplicate[]> {
    const active = await this.list();
    const pairs: MemoryDuplicate[] = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const first = active[i];
        const second = active[j];
        if (!first || !second) continue;
        const score = similarity(first.content, second.content);
        const contained = normalizeFact(first.content).includes(normalizeFact(second.content)) || normalizeFact(second.content).includes(normalizeFact(first.content));
        if (score >= threshold || contained) {
          pairs.push({ first: serialize(first), second: serialize(second), similarity: contained ? Math.max(score, 0.9) : score });
        }
      }
    }
    return pairs.toSorted((a, b) => b.similarity - a.similarity);
  }

  /** Asks the suggestion model which active memories contradict each other. */
  async conflicts(signal?: AbortSignal): Promise<MemoryConflict[]> {
    const { suggestionModel } = await this.settings.get('memory');
    if (!suggestionModel) throw new Error('Choose a suggestion model under Settings → Memory to check for conflicts.');
    const active = await this.list();
    if (active.length < 2) return [];
    const numbered = active.map((memory, index) => `${index + 1}. ${memory.content}`).join('\n');
    const reply = await this.complete(suggestionModel, CONFLICT_PROMPT, numbered, signal);
    const conflicts: MemoryConflict[] = [];
    for (const item of extractJsonArray(reply)) {
      const entry = item as { first?: unknown; second?: unknown; reason?: unknown };
      const first = typeof entry.first === 'number' ? active[entry.first - 1] : undefined;
      const second = typeof entry.second === 'number' ? active[entry.second - 1] : undefined;
      if (!first || !second || first.id === second.id) continue;
      conflicts.push({ firstId: first.id, secondId: second.id, reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 200) : '' });
    }
    return conflicts;
  }

  private async complete(model: ModelRef, system: string, content: string, signal?: AbortSignal): Promise<string> {
    const provider = await this.registry.get(model.provider);
    let reply = '';
    for await (const event of provider.streamChat({
      model: model.model,
      system,
      messages: [{ role: 'user', content }],
      params: mergeParams({ temperature: 0.2, maxTokens: 1024 }),
      signal: signal ?? AbortSignal.timeout(60_000),
    })) {
      if (event.type === 'text') reply += event.text;
    }
    return reply;
  }
}
