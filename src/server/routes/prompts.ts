import { Hono } from 'hono';
import type { GenerationParams, SystemPrompt } from '../../shared/types.ts';
import { badRequest, notFound, pick, readJson, type Services } from '../context.ts';
import { serialize } from '../services/serialize.ts';

/** Checks the profile fields a prompt can carry. */
function validateProfile(body: Partial<SystemPrompt>): void {
  if (body.tools !== undefined && body.tools !== null && (!Array.isArray(body.tools) || body.tools.some((tool) => typeof tool !== 'string'))) {
    throw badRequest('tools must be a list of tool group ids, or null for all');
  }
  if (body.maxToolRounds !== undefined && body.maxToolRounds !== null) {
    if (!Number.isInteger(body.maxToolRounds) || body.maxToolRounds < 1 || body.maxToolRounds > 50) {
      throw badRequest('maxToolRounds must be a whole number from 1 to 50');
    }
  }
  if (body.params !== undefined && body.params !== null && (typeof body.params !== 'object' || Array.isArray(body.params))) {
    throw badRequest('params must be an object');
  }
}

function paramsOrNull(params: Partial<GenerationParams> | null | undefined): Partial<GenerationParams> | null {
  if (!params) return null;
  const kept = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null && value !== undefined));
  return Object.keys(kept).length > 0 ? kept : null;
}

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
    validateProfile(body);
    const row = await repos.systemPrompts.create({
      name: body.name.trim(),
      content: body.content ?? '',
      isDefault: body.isDefault ?? false,
      tools: body.tools ?? null,
      maxToolRounds: body.maxToolRounds ?? null,
      params: paramsOrNull(body.params),
    });
    if (row.isDefault) await clearOtherDefaults(row.id);
    return c.json(serialize<SystemPrompt>(row), 201);
  });

  app.patch('/prompts/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await repos.systemPrompts.findById(id))) throw notFound('Prompt');
    const body = await readJson<Partial<SystemPrompt>>(c);
    validateProfile(body);
    const changes = pick(body, ['name', 'content', 'isDefault', 'tools', 'maxToolRounds', 'params']);
    if ('params' in body) changes.params = paramsOrNull(body.params);
    const row = await repos.systemPrompts.update(id, changes);
    if (row.isDefault) await clearOtherDefaults(row.id);
    return c.json(serialize<SystemPrompt>(row));
  });

  app.delete('/prompts/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await repos.systemPrompts.findById(id))) throw notFound('Prompt');
    await repos.systemPrompts.delete(id);
    // Panes that pointed at the profile fall back to no system prompt, and its memories apply everywhere.
    await repos.panes.updateMany({ where: { systemPromptId: id } }, { systemPromptId: null });
    await repos.memories.updateMany({ where: { scope: id } }, { scope: null });
    return c.body(null, 204);
  });

  return app;
}
