import { Hono } from 'hono';
import type { SystemPrompt } from '../../shared/types.ts';
import { badRequest, notFound, pick, readJson, type Services } from '../context.ts';
import { serialize } from '../services/serialize.ts';

export function promptRoutes({ repos }: Services): Hono {
  const app = new Hono();

  async function clearOtherDefaults(keepId: string): Promise<void> {
    await repos.systemPrompts.updateMany(
      { where: [{ field: 'id', op: 'ne', value: keepId }, { field: 'isDefault', op: 'eq', value: true }] },
      { isDefault: false },
    );
  }

  app.get('/prompts', async (c) => {
    const rows = await repos.systemPrompts.findMany({ orderBy: [{ field: 'name', direction: 'asc' }] });
    return c.json(serialize<SystemPrompt[]>(rows));
  });

  app.post('/prompts', async (c) => {
    const body = await readJson<Partial<SystemPrompt>>(c);
    if (!body.name?.trim()) throw badRequest('A prompt needs a name');
    const row = await repos.systemPrompts.create({
      name: body.name.trim(),
      content: body.content ?? '',
      isDefault: body.isDefault ?? false,
    });
    if (row.isDefault) await clearOtherDefaults(row.id);
    return c.json(serialize<SystemPrompt>(row), 201);
  });

  app.patch('/prompts/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await repos.systemPrompts.findById(id))) throw notFound('Prompt');
    const body = await readJson<Partial<SystemPrompt>>(c);
    const row = await repos.systemPrompts.update(id, pick(body, ['name', 'content', 'isDefault']));
    if (row.isDefault) await clearOtherDefaults(row.id);
    return c.json(serialize<SystemPrompt>(row));
  });

  app.delete('/prompts/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await repos.systemPrompts.findById(id))) throw notFound('Prompt');
    await repos.systemPrompts.delete(id);
    // Panes that pointed at the preset fall back to no system prompt.
    await repos.panes.updateMany({ where: { systemPromptId: id } }, { systemPromptId: null });
    return c.body(null, 204);
  });

  return app;
}
