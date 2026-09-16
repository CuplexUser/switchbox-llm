import type { ChatTurn, ModelRef } from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';
import type { MemoryRow } from '../db/schemas.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { SettingsService } from './settings.ts';

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

  constructor(repos: Repos, settings: SettingsService, registry: ProviderRegistry) {
    this.repos = repos;
    this.settings = settings;
    this.registry = registry;
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
