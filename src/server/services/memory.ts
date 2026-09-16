import { randomUUID } from 'node:crypto';
import type { ActivityItem, ChatTurn, ModelRef } from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';
import type { MemoryRow } from '../db/schemas.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ToolCall, ToolSpec } from '../providers/types.ts';
import type { ToolResult } from '../web/tools.ts';
import type { SettingsService } from './settings.ts';

export const MEMORY_SAVE_TOOL: ToolSpec = {
  name: 'memory_save',
  description:
    'Save a durable fact about the user to long-term memory, so it is available in future conversations. ' +
    'Call it whenever the user asks you to remember something, and for lasting preferences, background or standing instructions they share. ' +
    'Write the fact as a short standalone sentence in the third person, e.g. "Prefers metric units".',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact to remember, one short sentence' },
      category: {
        type: 'string',
        description: 'A short category such as preferences, background, projects or instructions',
      },
    },
    required: ['content'],
    additionalProperties: false,
  },
};

export const MEMORY_FORGET_TOOL: ToolSpec = {
  name: 'memory_forget',
  description:
    'Remove a fact from long-term memory when the user asks you to forget it or says it is no longer true. ' +
    'Pass the memory text as it appears in your memory list, or a distinctive part of it.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The memory to remove, or a distinctive part of its text' },
    },
    required: ['content'],
    additionalProperties: false,
  },
};

export const MEMORY_TOOLS = [MEMORY_SAVE_TOOL, MEMORY_FORGET_TOOL];

/** Tells the model it has memory, including when nothing is stored yet, so it stops claiming it can't remember. */
export function memoryGuidance(): string {
  return (
    'You have long-term memory that persists across conversations. ' +
    'When the user asks you to remember something, or shares a lasting preference or fact about themselves, save it with memory_save, then confirm briefly. ' +
    'When they ask you to forget something, use memory_forget. ' +
    'Never tell the user that you cannot remember things between conversations.'
  );
}

export function isMemoryTool(name: string): boolean {
  return name === MEMORY_SAVE_TOOL.name || name === MEMORY_FORGET_TOOL.name;
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

/** Pulls a JSON array of facts out of a model reply, tolerating code fences and surrounding prose. */
export function parseSuggestions(text: string, limit = 5): MemoryFact[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const facts: MemoryFact[] = [];
  for (const item of parsed) {
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

const SUGGESTION_PROMPT = `You maintain a long-term memory of durable facts about a user: their preferences, background, projects, and standing instructions.

Read the latest exchange and propose new facts worth remembering across future conversations. Only include facts the user stated or clearly implied about themselves. Skip anything temporary, trivial, about the assistant, or already covered by the existing memories.

Reply with only a JSON array, for example:
[{"content": "Prefers TypeScript over JavaScript", "category": "preferences"}]
Use short categories such as preferences, background, projects, instructions. Reply [] when there is nothing new.`;

export class MemoryService {
  private readonly repos: Repos;
  private readonly settings: SettingsService;
  private readonly registry: ProviderRegistry;

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

  /** Stores a fact the model saved as active. Returns false when an equivalent memory already exists. */
  save(content: string, category: string, conversationId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const key = normalizeFact(content);
      const existing = await this.repos.memories.findMany();
      const match = existing.find((memory) => normalizeFact(memory.content) === key);
      if (match) {
        // Saying it again counts as confirming it, even if it was dismissed or paused before.
        if (match.status !== 'active' || !match.enabled) {
          await this.repos.memories.update(match.id, { status: 'active', enabled: true });
          return true;
        }
        return false;
      }
      await this.repos.memories.create({
        content,
        category,
        enabled: true,
        source: 'model',
        status: 'active',
        sourceConversationId: conversationId,
      });
      return true;
    });
  }

  /** Deletes the one active memory matching `content`. Returns what was removed, or the candidates when it is ambiguous. */
  forget(content: string): Promise<{ removed: MemoryRow | null; candidates: MemoryRow[] }> {
    return this.exclusive(async () => {
      const key = normalizeFact(content);
      const active = await this.repos.memories.findMany({ where: { status: 'active' } });
      const exact = active.filter((memory) => normalizeFact(memory.content) === key);
      const candidates = exact.length > 0 ? exact : active.filter((memory) => normalizeFact(memory.content).includes(key));
      if (candidates.length !== 1 || !candidates[0]) return { removed: null, candidates };
      await this.repos.memories.delete(candidates[0].id);
      return { removed: candidates[0], candidates };
    });
  }

  async runTool(call: ToolCall, conversationId: string, onActivity: (item: ActivityItem) => void): Promise<ToolResult> {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.arguments || '{}');
      if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>;
    } catch {
      return { content: `Error: the arguments were not valid JSON: ${call.arguments.slice(0, 200)}`, isError: true };
    }
    const content = typeof args.content === 'string' ? args.content.trim().slice(0, 500) : '';
    if (normalizeFact(content).length < 2) return { content: 'Error: "content" is required.', isError: true };

    const id = randomUUID();
    const action = call.name === MEMORY_SAVE_TOOL.name ? 'save' : 'forget';
    onActivity({ id, kind: 'memory', action, content, done: false });
    try {
      if (action === 'save') {
        const rawCategory = typeof args.category === 'string' ? args.category.trim().toLowerCase().slice(0, 40) : '';
        const stored = await this.save(content, rawCategory || 'general', conversationId);
        onActivity({ id, kind: 'memory', action, content, done: true });
        return {
          content: stored ? `Saved to memory: "${content}"` : `Already in memory: "${content}"`,
          isError: false,
        };
      }

      const { removed, candidates } = await this.forget(content);
      if (removed) {
        onActivity({ id, kind: 'memory', action, content: removed.content, done: true });
        return { content: `Removed from memory: "${removed.content}"`, isError: false };
      }
      const error = candidates.length === 0 ? 'No matching memory' : `${candidates.length} memories match`;
      onActivity({ id, kind: 'memory', action, content, done: true, error });
      return {
        content:
          candidates.length === 0
            ? `Error: no memory matches "${content}".`
            : `Error: several memories match. Call memory_forget again with the full text of one:\n${candidates.map((memory) => `- ${memory.content}`).join('\n')}`,
        isError: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onActivity({ id, kind: 'memory', action, content, done: true, error: message });
      return { content: `Error: ${message}`, isError: true };
    }
  }

  async activeFacts(): Promise<MemoryRow[]> {
    const { maxInjected } = await this.settings.get('memory');
    if (maxInjected <= 0) return [];
    return this.repos.memories.findMany({
      where: { status: 'active', enabled: true },
      orderBy: [{ field: 'updatedAt', direction: 'desc' }],
      limit: maxInjected,
    });
  }

  /** Asks the suggestion model for new facts and stores them as pending. Returns how many were added. */
  async suggest(conversationId: string, exchange: ChatTurn[], signal?: AbortSignal): Promise<number> {
    const memorySettings = await this.settings.get('memory');
    const model: ModelRef | null = memorySettings.suggestionModel;
    if (!memorySettings.autoSuggest || !model) return 0;

    const existing = await this.repos.memories.findMany();
    const known = new Set(existing.map((memory) => normalizeFact(memory.content)));
    const existingList = existing
      .filter((memory) => memory.status !== 'rejected')
      .map((memory) => `- ${memory.content}`)
      .join('\n');

    const transcript = exchange.map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`).join('\n\n');
    const provider = await this.registry.get(model.provider);
    let reply = '';
    for await (const event of provider.streamChat({
      model: model.model,
      system: SUGGESTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Existing memories:\n${existingList || '(none)'}\n\nLatest exchange:\n${transcript}`,
        },
      ],
      params: { temperature: 0.2, topP: null, maxTokens: 1024 },
      signal: signal ?? AbortSignal.timeout(60_000),
    })) {
      if (event.type === 'text') reply += event.text;
    }

    let added = 0;
    for (const fact of parseSuggestions(reply)) {
      const key = normalizeFact(fact.content);
      if (!key || known.has(key)) continue;
      known.add(key);
      await this.repos.memories.create({
        content: fact.content,
        category: fact.category,
        enabled: true,
        source: 'suggested',
        status: 'pending',
        sourceConversationId: conversationId,
      });
      added++;
    }
    return added;
  }
}
