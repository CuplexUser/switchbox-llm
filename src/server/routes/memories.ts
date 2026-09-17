import { Hono } from 'hono';
import type { Memory, MemoryAction, MemoryHistoryEntry, MemoryStatus } from '../../shared/types.ts';
import { badRequest, notFound, pick, readJson, type Services } from '../context.ts';
import { serialize } from '../services/serialize.ts';

const STATUSES: MemoryStatus[] = ['active', 'pending', 'rejected', 'forgotten'];

/** What a status change means in the history. */
function statusAction(from: string, to: MemoryStatus): MemoryAction | null {
  if (from === to) return null;
  if (to === 'rejected') return 'dismissed';
  if (to === 'forgotten') return 'forgotten';
  if (to === 'active') return from === 'pending' ? 'kept' : 'restored';
  return null;
}

export function memoryRoutes({ repos, memory }: Services): Hono {
  const app = new Hono();

  async function validScope(scope: unknown): Promise<string | null> {
    if (scope === null || scope === undefined || scope === '') return null;
    if (typeof scope !== 'string' || !(await repos.systemPrompts.findById(scope))) throw badRequest('scope must be a profile id or null');
    return scope;
  }

  app.get('/memories', async (c) => {
    const status = c.req.query('status') as MemoryStatus | undefined;
    if (status && !STATUSES.includes(status)) throw badRequest(`Unknown status "${status}"`);
    const rows = await repos.memories.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ field: 'updatedAt', direction: 'desc' }],
    });
    return c.json(serialize<Memory[]>(rows));
  });

  app.get('/memories/pending-count', async (c) =>
    c.json({ count: await repos.memories.count({ where: { status: 'pending' } }) }),
  );

  app.get('/memories/suggestion-status', (c) => c.json(memory.suggestionStatus()));

  app.get('/memories/duplicates', async (c) => c.json(await memory.duplicates()));

  app.post('/memories/conflicts', async (c) => {
    try {
      return c.json(await memory.conflicts(AbortSignal.timeout(90_000)));
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
  });

  app.post('/memories', async (c) => {
    const body = await readJson<Partial<Memory>>(c);
    if (!body.content?.trim()) throw badRequest('A memory needs some content');
    const row = await repos.memories.create({
      content: body.content.trim(),
      category: body.category?.trim().toLowerCase() || 'general',
      enabled: body.enabled ?? true,
      source: 'manual',
      status: 'active',
      scope: await validScope(body.scope),
      sourceConversationId: null,
    });
    await memory.record(row.id, 'created', 'user', row.content);
    return c.json(serialize<Memory>(row), 201);
  });

  app.patch('/memories/:id', async (c) => {
    const id = c.req.param('id');
    const current = await repos.memories.findById(id);
    if (!current) throw notFound('Memory');
    const body = await readJson<Partial<Memory>>(c);
    if (body.status && !STATUSES.includes(body.status)) throw badRequest(`Unknown status "${body.status}"`);
    const changes = pick(body, ['content', 'category', 'enabled', 'status', 'scope']);
    if (changes.content !== undefined) {
      changes.content = changes.content.trim();
      if (!changes.content) throw badRequest('A memory needs some content');
    }
    if (changes.category !== undefined) changes.category = changes.category.trim().toLowerCase() || 'general';
    if ('scope' in body) changes.scope = await validScope(body.scope);
    const row = await repos.memories.update(id, changes);

    if (changes.content !== undefined && changes.content !== current.content) {
      await memory.record(id, 'updated', 'user', row.content, current.content);
    }
    const action = changes.status ? statusAction(current.status, changes.status) : null;
    if (action) await memory.record(id, action, 'user', row.content);
    return c.json(serialize<Memory>(row));
  });

  app.delete('/memories/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await repos.memories.findById(id))) throw notFound('Memory');
    await repos.memories.delete(id);
    await repos.memoryHistory.deleteMany({ where: { memoryId: id } });
    return c.body(null, 204);
  });

  app.get('/memories/:id/history', async (c) => {
    const id = c.req.param('id');
    if (!(await repos.memories.findById(id))) throw notFound('Memory');
    return c.json(serialize<MemoryHistoryEntry[]>(await memory.history(id)));
  });

  return app;
}
