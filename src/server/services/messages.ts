import type { Message } from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';
import type { ConversationRow, MessageRow } from '../db/schemas.ts';
import { createLogger } from '../log.ts';
import { serialize } from './serialize.ts';
import { usageFromMessage } from './usage.ts';

const log = createLogger('messages');

export type NewMessage = Omit<MessageRow, 'createdAt'> & { createdAt?: Date };

/** The wire shape of a message. The tool trace stays on the server. */
export function toMessage(row: MessageRow): Message {
  const { trace: _trace, ...rest } = row;
  return serialize<Message>(rest);
}

function byCreated(a: MessageRow, b: MessageRow): number {
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Messages for both kinds of chat. Saved chats read and write the database; temporary chats keep
 * their messages in this process only, so the server can still build history from them and they
 * vanish on restart. Messages are ordered by createdAt, which this store sets and keeps strictly
 * increasing, so two messages written in the same millisecond still sort in the order written.
 */
export class MessageStore {
  private readonly repos: Repos;
  private readonly temporary = new Map<string, MessageRow[]>();
  private lastStamp = 0;

  constructor(repos: Repos) {
    this.repos = repos;
  }

  /** Now, or one millisecond after the last stamp handed out. */
  private stamp(): Date {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp);
  }

  private memory(conversationId: string): MessageRow[] {
    let rows = this.temporary.get(conversationId);
    if (!rows) {
      rows = [];
      this.temporary.set(conversationId, rows);
    }
    return rows;
  }

  /** Messages oldest first, for one pane or the whole chat. */
  async list(conversation: ConversationRow, paneId?: string): Promise<MessageRow[]> {
    if (!conversation.persist) {
      const rows = this.temporary.get(conversation.id) ?? [];
      return rows.filter((row) => !paneId || row.paneId === paneId).toSorted(byCreated);
    }
    return this.repos.messages.findMany({
      where: paneId ? { conversationId: conversation.id, paneId } : { conversationId: conversation.id },
      orderBy: [{ field: 'createdAt', direction: 'asc' }],
    });
  }

  async get(conversation: ConversationRow, id: string): Promise<MessageRow | null> {
    if (!conversation.persist) return (this.temporary.get(conversation.id) ?? []).find((row) => row.id === id) ?? null;
    const row = await this.repos.messages.findById(id);
    return row && row.conversationId === conversation.id ? row : null;
  }

  async create(conversation: ConversationRow, message: NewMessage): Promise<MessageRow> {
    const row: MessageRow = { ...message, createdAt: this.stamp() };
    if (!conversation.persist) {
      this.memory(conversation.id).push(row);
      return row;
    }
    const saved = await this.repos.messages.create(row);
    const usage = usageFromMessage(saved);
    if (usage) {
      // Usage is bookkeeping: failing to record it must not lose the reply.
      await this.repos.usage.create(usage).catch((error: unknown) => log.warn('could not record usage', { messageId: saved.id, error }));
    }
    return saved;
  }

  async update(conversation: ConversationRow, id: string, changes: Partial<MessageRow>): Promise<MessageRow | null> {
    const { id: _id, createdAt: _createdAt, conversationId: _conversationId, ...allowed } = changes;
    if (!conversation.persist) {
      const rows = this.temporary.get(conversation.id) ?? [];
      const index = rows.findIndex((row) => row.id === id);
      const current = rows[index];
      if (!current) return null;
      const updated = { ...current, ...allowed };
      rows[index] = updated;
      return updated;
    }
    if (!(await this.get(conversation, id))) return null;
    return this.repos.messages.update(id, allowed);
  }

  /** Removes the messages of a pane that come after `messageId`. */
  async deleteAfter(conversation: ConversationRow, paneId: string, messageId: string): Promise<number> {
    const rows = await this.list(conversation, paneId);
    const index = rows.findIndex((row) => row.id === messageId);
    if (index === -1) return 0;
    const ids = rows.slice(index + 1).map((row) => row.id);
    if (ids.length === 0) return 0;
    if (!conversation.persist) {
      const remove = new Set(ids);
      this.temporary.set(
        conversation.id,
        (this.temporary.get(conversation.id) ?? []).filter((row) => !remove.has(row.id)),
      );
      return ids.length;
    }
    return this.repos.messages.deleteMany({ where: [{ field: 'id', op: 'in', value: ids }] });
  }

  async clearPane(conversation: ConversationRow, paneId: string): Promise<number> {
    if (!conversation.persist) {
      const rows = this.temporary.get(conversation.id) ?? [];
      const kept = rows.filter((row) => row.paneId !== paneId);
      this.temporary.set(conversation.id, kept);
      return rows.length - kept.length;
    }
    return this.repos.messages.deleteMany({ where: { paneId } });
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.temporary.delete(conversationId);
    await this.repos.messages.deleteMany({ where: { conversationId } });
  }

  /** Writes a temporary chat's messages to the database when it is saved. Usage isn't recorded for them. */
  async persist(conversationId: string): Promise<number> {
    const rows = (this.temporary.get(conversationId) ?? []).toSorted(byCreated);
    let saved = 0;
    for (const row of rows) {
      if (await this.repos.messages.findById(row.id)) continue;
      await this.repos.messages.create(row);
      saved++;
    }
    this.temporary.delete(conversationId);
    return saved;
  }

  /** Moves a saved chat's messages into memory when it becomes temporary. Usage rows stay. */
  async unpersist(conversationId: string): Promise<number> {
    const rows = await this.repos.messages.findMany({
      where: { conversationId },
      orderBy: [{ field: 'createdAt', direction: 'asc' }],
    });
    this.temporary.set(conversationId, [...(this.temporary.get(conversationId) ?? []), ...rows]);
    await this.repos.messages.deleteMany({ where: { conversationId } });
    return rows.length;
  }

  /** Copies messages into another chat and pane with new ids, keeping their order. */
  async copy(target: ConversationRow, paneId: string, rows: MessageRow[], rename: (id: string) => string): Promise<MessageRow[]> {
    const copies: MessageRow[] = [];
    for (const row of rows.toSorted(byCreated)) {
      const copy = { ...row, id: rename(row.id), conversationId: target.id, paneId, createdAt: this.stamp() };
      if (target.persist) await this.repos.messages.create(copy);
      else this.memory(target.id).push(copy);
      copies.push(copy);
    }
    return copies;
  }
}
