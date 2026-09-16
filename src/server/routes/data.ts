import { Hono } from 'hono';
import type { Repo } from 'repolayer';
import type { ExportBundle } from '../../shared/types.ts';
import { badRequest, readJson, type Services } from '../context.ts';
import { reviveDates, serialize } from '../services/serialize.ts';

const DATE_FIELDS = ['createdAt', 'updatedAt'];

export function dataRoutes({ repos, settings }: Services): Hono {
  const app = new Hono();

  app.get('/data/export', async (c) => {
    const bundle: ExportBundle = serialize({
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations: await repos.conversations.findMany({ where: { persist: true } }),
      panes: await repos.panes.findMany(),
      messages: await repos.messages.findMany({ orderBy: [{ field: 'createdAt', direction: 'asc' }] }),
      systemPrompts: await repos.systemPrompts.findMany(),
      memories: await repos.memories.findMany(),
      settings: await settings.getAll(),
    });
    const persisted = new Set(bundle.conversations.map((conversation) => conversation.id));
    bundle.panes = bundle.panes.filter((pane) => persisted.has(pane.conversationId));
    c.header('Content-Disposition', `attachment; filename="switchbox-export-${bundle.exportedAt.slice(0, 10)}.json"`);
    return c.json(bundle);
  });

  /** Merges a bundle in: rows whose id already exists are skipped, so importing twice is harmless. */
  app.post('/data/import', async (c) => {
    const bundle = await readJson<Partial<ExportBundle>>(c);
    if (bundle.version !== 1) throw badRequest('Not a Switchbox export (expected version 1)');

    async function insert<T extends { id: string }>(repo: Repo<T>, rows: object[] | undefined): Promise<number> {
      let count = 0;
      for (const row of rows ?? []) {
        const record = reviveDates(row as Record<string, unknown>, DATE_FIELDS) as unknown as T;
        if (typeof record.id !== 'string' || (await repo.findById(record.id))) continue;
        await repo.create(record);
        count++;
      }
      return count;
    }

    const imported = {
      conversations: await insert(repos.conversations, bundle.conversations),
      panes: await insert(repos.panes, bundle.panes),
      messages: await insert(repos.messages, bundle.messages),
      systemPrompts: await insert(repos.systemPrompts, bundle.systemPrompts),
      memories: await insert(repos.memories, bundle.memories),
    };
    if (bundle.settings) await settings.replaceAll(bundle.settings);
    return c.json({ imported });
  });

  app.delete('/data/history', async (c) => {
    const removed = await repos.conversations.withTransaction(async (tx, ctx) => {
      await repos.messages.with(ctx).deleteMany();
      await repos.panes.with(ctx).deleteMany();
      return tx.deleteMany();
    });
    return c.json({ removed });
  });

  return app;
}
