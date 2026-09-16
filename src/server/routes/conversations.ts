import { Hono } from 'hono';
import { MAX_PANES } from '../../shared/defaults.ts';
import {
  PROVIDER_IDS,
  type Conversation,
  type ConversationDetail,
  type Message,
  type ModelRef,
  type Pane,
} from '../../shared/types.ts';
import { badRequest, notFound, pick, readJson, type Services } from '../context.ts';
import type { ConversationRow, MessageRow, PaneRow } from '../db/schemas.ts';
import { DEFAULT_TITLE } from '../services/chat.ts';
import { reviveDates, serialize } from '../services/serialize.ts';

interface NewPane extends ModelRef {
  systemPromptId?: string | null;
  systemPrompt?: string | null;
  params?: Pane['params'];
}

function validateModel(ref: Partial<ModelRef>): void {
  if (!ref.provider || !PROVIDER_IDS.includes(ref.provider)) throw badRequest('Each pane needs a valid provider');
  if (!ref.model?.trim()) throw badRequest('Each pane needs a model');
}

function paneData(conversationId: string, position: number, pane: NewPane, promptId: string | null) {
  return {
    conversationId,
    position,
    provider: pane.provider,
    model: pane.model.trim(),
    systemPromptId: pane.systemPromptId === undefined ? promptId : pane.systemPromptId,
    systemPrompt: pane.systemPrompt ?? null,
    params: pane.params ?? {},
  };
}

export function conversationRoutes({ repos, settings, chat }: Services): Hono {
  const app = new Hono();

  async function loadConversation(id: string): Promise<ConversationRow> {
    const row = await repos.conversations.findById(id);
    if (!row) throw notFound('Conversation');
    return row;
  }

  async function loadPane(id: string): Promise<PaneRow> {
    const row = await repos.panes.findById(id);
    if (!row) throw notFound('Pane');
    return row;
  }

  async function panesOf(conversationId: string): Promise<PaneRow[]> {
    return repos.panes.findMany({
      where: { conversationId },
      orderBy: [{ field: 'position', direction: 'asc' }],
    });
  }

  async function detail(row: ConversationRow): Promise<ConversationDetail> {
    return serialize<ConversationDetail>({ ...row, panes: await panesOf(row.id) });
  }

  async function defaultPromptId(): Promise<string | null> {
    return (await repos.systemPrompts.findOne({ where: { isDefault: true } }))?.id ?? null;
  }

  app.get('/conversations', async (c) => {
    const rows = await repos.conversations.findMany({
      orderBy: [
        { field: 'pinned', direction: 'desc' },
        { field: 'updatedAt', direction: 'desc' },
      ],
    });
    return c.json(serialize<Conversation[]>(rows));
  });

  app.post('/conversations', async (c) => {
    const body = await readJson<Partial<Conversation> & { panes?: NewPane[] }>(c);
    const panes = body.panes ?? [];
    if (panes.length === 0) throw badRequest('Pick at least one model');
    if (panes.length > MAX_PANES) throw badRequest(`At most ${MAX_PANES} panes per conversation`);
    panes.forEach(validateModel);

    const [general, memory, promptId] = await Promise.all([
      settings.get('general'),
      settings.get('memory'),
      defaultPromptId(),
    ]);

    const created = await repos.conversations.withTransaction(async (tx, ctx) => {
      const row = await tx.create({
        title: body.title?.trim() || DEFAULT_TITLE,
        persist: body.persist ?? general.persistByDefault,
        useMemory: body.useMemory ?? memory.useByDefault,
        pinned: false,
        archived: false,
      });
      await repos.panes.with(ctx).createMany(panes.map((pane, index) => paneData(row.id, index, pane, promptId)));
      return row;
    });
    return c.json(await detail(created), 201);
  });

  app.get('/conversations/:id', async (c) => c.json(await detail(await loadConversation(c.req.param('id')))));

  app.patch('/conversations/:id', async (c) => {
    const id = c.req.param('id');
    await loadConversation(id);
    const body = await readJson<Partial<Conversation>>(c);
    const row = await repos.conversations.update(id, pick(body, ['title', 'persist', 'useMemory', 'pinned', 'archived']));
    return c.json(await detail(row));
  });

  app.delete('/conversations/:id', async (c) => {
    const id = c.req.param('id');
    await loadConversation(id);
    await repos.conversations.withTransaction(async (tx, ctx) => {
      await repos.messages.with(ctx).deleteMany({ where: { conversationId: id } });
      await repos.panes.with(ctx).deleteMany({ where: { conversationId: id } });
      await tx.delete(id);
    });
    return c.body(null, 204);
  });

  app.get('/conversations/:id/messages', async (c) => {
    const id = c.req.param('id');
    await loadConversation(id);
    const rows = await repos.messages.findMany({
      where: { conversationId: id },
      orderBy: [{ field: 'createdAt', direction: 'asc' }],
    });
    return c.json(serialize<Message[]>(rows));
  });

  /** Saves messages that were produced while the conversation was temporary. */
  app.post('/conversations/:id/messages', async (c) => {
    const id = c.req.param('id');
    await loadConversation(id);
    const body = await readJson<{ messages?: Message[] }>(c);
    const paneIds = new Set((await panesOf(id)).map((pane) => pane.id));
    let saved = 0;
    for (const message of body.messages ?? []) {
      if (!paneIds.has(message.paneId) || (await repos.messages.findById(message.id))) continue;
      await repos.messages.create(
        reviveDates({ ...message, conversationId: id }, ['createdAt']) as unknown as Partial<MessageRow>,
      );
      saved++;
    }
    return c.json({ saved });
  });

  app.post('/conversations/:id/panes', async (c) => {
    const id = c.req.param('id');
    await loadConversation(id);
    const body = await readJson<NewPane>(c);
    validateModel(body);
    const existing = await panesOf(id);
    if (existing.length >= MAX_PANES) throw badRequest(`At most ${MAX_PANES} panes per conversation`);
    const position = existing.reduce((max, pane) => Math.max(max, pane.position + 1), 0);
    const row = await repos.panes.create(paneData(id, position, body, await defaultPromptId()));
    return c.json(serialize<Pane>(row), 201);
  });

  app.patch('/panes/:id', async (c) => {
    const id = c.req.param('id');
    await loadPane(id);
    const body = await readJson<Partial<Pane>>(c);
    if (body.provider !== undefined || body.model !== undefined) validateModel({ ...(await loadPane(id)), ...body } as Partial<ModelRef>);
    const row = await repos.panes.update(
      id,
      pick(body, ['provider', 'model', 'systemPromptId', 'systemPrompt', 'params', 'position']),
    );
    return c.json(serialize<Pane>(row));
  });

  app.delete('/panes/:id', async (c) => {
    const id = c.req.param('id');
    const pane = await loadPane(id);
    if ((await repos.panes.count({ where: { conversationId: pane.conversationId } })) <= 1) {
      throw badRequest('A conversation needs at least one pane');
    }
    await repos.panes.withTransaction(async (tx, ctx) => {
      await repos.messages.with(ctx).deleteMany({ where: { paneId: id } });
      await tx.delete(id);
    });
    return c.body(null, 204);
  });

  app.delete('/panes/:id/messages', async (c) => {
    const id = c.req.param('id');
    await loadPane(id);
    const removed = await repos.messages.deleteMany({ where: { paneId: id } });
    return c.json({ removed });
  });

  app.get('/panes/:id/preview', async (c) => {
    const pane = await loadPane(c.req.param('id'));
    const conversation = await loadConversation(pane.conversationId);
    return c.json(await chat.preview(conversation, pane));
  });

  app.delete('/messages/:id', async (c) => {
    const id = c.req.param('id');
    if (await repos.messages.findById(id)) await repos.messages.delete(id);
    return c.body(null, 204);
  });

  return app;
}
