import type { MessageRole, SearchHit } from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';

const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 140;

/** Words to look for. Wildcard characters are dropped so they match literally nowhere rather than everywhere. */
export function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .replace(/[%_]/g, ' ')
        .split(/\s+/)
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= 2),
    ),
  ].slice(0, 6);
}

export function snippetAround(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const at = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(content.length, at + SNIPPET_AFTER);
  const text = content.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}${end < content.length ? '…' : ''}`;
}

/** Finds saved messages that contain every word of a query. Temporary chats are never searched. */
export class SearchService {
  private readonly repos: Repos;

  constructor(repos: Repos) {
    this.repos = repos;
  }

  async messages(query: string, options: { limit?: number; excludeConversationId?: string } = {}): Promise<SearchHit[]> {
    const terms = searchTerms(query);
    if (terms.length === 0) return [];
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const where = [
      ...terms.map((term) => ({ field: 'content' as const, op: 'ilike' as const, value: `%${term}%` })),
      ...(options.excludeConversationId ? [{ field: 'conversationId' as const, op: 'ne' as const, value: options.excludeConversationId }] : []),
    ];
    // Several panes often hold the same user message; fetch extra so duplicates don't crowd out other chats.
    const rows = await this.repos.messages.findMany({ where, orderBy: [{ field: 'createdAt', direction: 'desc' }], limit: limit * 4 });

    const conversationIds = [...new Set(rows.map((row) => row.conversationId))];
    const conversations = conversationIds.length
      ? await this.repos.conversations.findMany({ where: [{ field: 'id', op: 'in', value: conversationIds }] })
      : [];
    const titles = new Map(conversations.filter((row) => row.persist).map((row) => [row.id, row.title]));

    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const title = titles.get(row.conversationId);
      if (title === undefined) continue;
      const key = `${row.conversationId}:${row.role}:${row.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        conversationId: row.conversationId,
        conversationTitle: title,
        messageId: row.id,
        paneId: row.paneId,
        role: row.role as MessageRole,
        snippet: snippetAround(row.content, terms),
        createdAt: row.createdAt.toISOString(),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
