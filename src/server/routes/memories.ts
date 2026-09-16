import { Hono } from 'hono';
import type { Memory, MemoryStatus } from '../../shared/types.ts';
import { badRequest, notFound, pick, readJson, type Services } from '../context.ts';
import { serialize } from '../services/serialize.ts';

const STATUSES: MemoryStatus[] = ['active', 'pending', 'rejected'];

export function memoryRoutes({ repos }: Services): Hono {
  const app = new Hono();

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

  app.post('/memories', async (c) => {
    const body = await readJson<Partial<Memory>>(c);
    if (!body.content?.trim()) throw badRequest('A memory needs some content');
    const row = await repos.memories.create({
      content: body.content.trim(),
      category: body.category?.trim().toLowerCase() || 'general',
      enabled: body.enabled ?? true,
      source: 'manual',
      status: 'active',
      sourceConversationId: null,
    });
    return c.json(serialize<Memory>(row), 201);
  });

  app.patch('/memories/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await repos.memories.findById(id))) throw notFound('Memory');
    const body = await readJson<Partial<Memory>>(c);
    if (body.status && !STATUSES.includes(body.status)) throw badRequest(`Unknown status "${body.status}"`);
    const changes = pick(body, ['content', 'category', 'enabled', 'status']);
    if (changes.category !== undefined) changes.category = changes.category.trim().toLowerCase() || 'general';
    const row = await repos.memories.update(id, changes);
    return c.json(serialize<Memory>(row));
  });

  app.delete('/memories/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await repos.memories.findById(id))) throw notFound('Memory');
    await repos.memories.delete(id);
    return c.body(null, 204);
  });

  return app;
}
