import { Hono } from 'hono';
import type { Repo } from 'repolayer';
import type { AppSettings, ExportBundle } from '../../shared/types.ts';
import { badRequest, readJson, type Services } from '../context.ts';
import { reviveDates, serialize } from '../services/serialize.ts';

const DATE_FIELDS = ['createdAt', 'updatedAt'];

/** Date fields each table stores, filled with the import time when a bundle leaves them out. */
const STORED_DATES: Record<string, string[]> = {
  conversations: DATE_FIELDS,
  panes: DATE_FIELDS,
  systemPrompts: DATE_FIELDS,
  memories: DATE_FIELDS,
  messages: ['createdAt'],
  memoryHistory: ['createdAt'],
  attachments: ['createdAt'],
};

/** Fields added after the first export format, filled in for older bundles. */
const LATER_FIELDS: Record<string, Record<string, unknown>> = {
  conversations: { toolGroups: null },
  messages: { attachments: null, trace: null, preferred: null },
  systemPrompts: { tools: null, maxToolRounds: null, params: null },
  memories: { scope: null },
};

export function dataRoutes({ repos, settings, usage, store }: Services): Hono {
  const app = new Hono();

  app.get('/data/export', async (c) => {
    const conversations = await repos.conversations.findMany({ where: { persist: true } });
    const persisted = new Set(conversations.map((conversation) => conversation.id));
    const files = await repos.attachments.findMany();
    const bundle: ExportBundle = serialize({
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations,
      panes: (await repos.panes.findMany()).filter((pane) => persisted.has(pane.conversationId)),
      // Rows go out as stored, including tool traces, so an import can replay them.
      messages: await repos.messages.findMany({ orderBy: [{ field: 'createdAt', direction: 'asc' }] }),
      systemPrompts: await repos.systemPrompts.findMany(),
      memories: await repos.memories.findMany(),
      memoryHistory: await repos.memoryHistory.findMany({ orderBy: [{ field: 'createdAt', direction: 'asc' }] }),
      attachments: files
        .filter((file) => file.conversationId !== null && persisted.has(file.conversationId))
        .map(({ data, ...file }) => ({ ...file, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') })),
      settings: await settings.getAll(),
    });
    c.header('Content-Disposition', `attachment; filename="switchbox-export-${bundle.exportedAt.slice(0, 10)}.json"`);
    return c.json(bundle);
  });

  /** Merges a bundle in: rows whose id already exists are skipped, so importing twice is harmless. */
  app.post('/data/import', async (c) => {
    const bundle = await readJson<Partial<ExportBundle>>(c);
    if (bundle.version !== 1) throw badRequest('Not a Switchbox export (expected version 1)');

    async function insert<T extends { id: string }>(
      repo: Repo<T>,
      rows: object[] | undefined,
      table: string,
      convert: (row: Record<string, unknown>) => Record<string, unknown> = (row) => row,
    ): Promise<number> {
      let count = 0;
      const now = new Date();
      const dates = Object.fromEntries((STORED_DATES[table] ?? []).map((field) => [field, now]));
      for (const row of rows ?? []) {
        const revived = reviveDates({ ...LATER_FIELDS[table], ...(row as Record<string, unknown>) }, DATE_FIELDS);
        for (const [field, fallback] of Object.entries(dates)) revived[field] ??= fallback;
        const record = convert(revived) as unknown as T;
        if (typeof record.id !== 'string' || (await repo.findById(record.id))) continue;
        await repo.create(record);
        count++;
      }
      return count;
    }

    const imported = {
      // The undated repos store createdAt and updatedAt as given, so imported chats keep their dates.
      conversations: await insert(repos.undated.conversations, bundle.conversations, 'conversations'),
      panes: await insert(repos.undated.panes, bundle.panes, 'panes'),
      messages: await insert(repos.messages, bundle.messages, 'messages'),
      systemPrompts: await insert(repos.undated.systemPrompts, bundle.systemPrompts, 'systemPrompts'),
      memories: await insert(repos.undated.memories, bundle.memories, 'memories'),
      memoryHistory: await insert(repos.memoryHistory, bundle.memoryHistory, 'memoryHistory'),
      attachments: await insert(repos.undated.attachments, bundle.attachments, 'attachments', (row) => ({
        ...row,
        data: Buffer.from(String(row.data ?? ''), 'base64'),
      })),
    };
    if (imported.messages > 0) await usage.backfill();
    if (bundle.settings) {
      const incoming: Partial<AppSettings> = { ...bundle.settings };
      // MCP servers run commands on this machine, so imported ones start switched off.
      if (incoming.mcp) {
        const existing = (await settings.get('mcp')).servers;
        const known = new Set(existing.map((server) => server.id));
        const added = (incoming.mcp.servers ?? []).filter((server) => !known.has(server.id)).map((server) => ({ ...server, enabled: false }));
        incoming.mcp = { servers: [...existing, ...added] };
      }
      await settings.replaceAll(incoming);
    }
    return c.json({ imported });
  });

  // Usage rows are left alone, so totals still count the deleted chats.
  app.delete('/data/history', async (c) => {
    const conversations = await repos.conversations.findMany();
    for (const conversation of conversations) await store.deleteConversation(conversation.id);
    const removed = await repos.conversations.withTransaction(async (tx, ctx) => {
      await repos.panes.with(ctx).deleteMany();
      return tx.deleteMany();
    });
    await repos.attachments.deleteMany();
    return c.json({ removed });
  });

  return app;
}
