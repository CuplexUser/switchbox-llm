import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { MAX_PANES } from '../../shared/defaults.ts';
import {
  PROVIDER_IDS,
  type AttachmentRef,
  type Conversation,
  type ConversationDetail,
  type Message,
  type ModelRef,
  type Pane,
} from '../../shared/types.ts';
import { badRequest, notFound, pick, readJson, type Services } from '../context.ts';
import type { ConversationRow, PaneRow } from '../db/schemas.ts';
import { DEFAULT_TITLE } from '../services/chat.ts';
import { toMessage } from '../services/messages.ts';
import { serialize } from '../services/serialize.ts';

interface NewPane extends ModelRef {
  systemPromptId?: string | null;
  systemPrompt?: string | null;
  params?: Pane['params'];
}

function validateModel(ref: Partial<ModelRef>): void {
  if (!ref.provider || !PROVIDER_IDS.includes(ref.provider)) throw badRequest('Each pane needs a valid provider');
  if (!ref.model?.trim()) throw badRequest('Each pane needs a model');
}

function validateToolGroups(value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== 'boolean')) {
    throw badRequest('toolGroups must map group ids to true or false');
  }
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

export function conversationRoutes({ repos, settings, chat, store, attachments, workspaces }: Services): Hono {
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
    validateToolGroups(body.toolGroups);

    const [general, memory, web, promptId] = await Promise.all([
      settings.get('general'),
      settings.get('memory'),
      settings.get('web'),
      defaultPromptId(),
    ]);

    const created = await repos.conversations.withTransaction(async (tx, ctx) => {
      const row = await tx.create({
        title: body.title?.trim() || DEFAULT_TITLE,
        persist: body.persist ?? general.persistByDefault,
        useMemory: body.useMemory ?? memory.useByDefault,
        webAccess: body.webAccess ?? web.useByDefault,
        workspace: body.workspace === true,
        toolGroups: body.toolGroups ?? null,
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
    const current = await loadConversation(id);
    const body = await readJson<Partial<Conversation>>(c);
    validateToolGroups(body.toolGroups);
    if (body.workspace !== undefined && typeof body.workspace !== 'boolean') throw badRequest('workspace must be true or false');
    const row = await repos.conversations.update(
      id,
      pick(body, ['title', 'persist', 'useMemory', 'webAccess', 'workspace', 'toolGroups', 'pinned', 'archived']),
    );
    // Saving a temporary chat writes what was said so far; making a chat temporary takes it out of the database.
    if (body.persist === true && !current.persist) await store.persist(id);
    if (body.persist === false && current.persist) await store.unpersist(id);
    return c.json(await detail(row));
  });

  app.delete('/conversations/:id', async (c) => {
    const id = c.req.param('id');
    await loadConversation(id);
    await store.deleteConversation(id);
    await repos.conversations.withTransaction(async (tx, ctx) => {
      await repos.panes.with(ctx).deleteMany({ where: { conversationId: id } });
      await tx.delete(id);
    });
    await attachments.deleteForConversation(id);
    await workspaces.deleteFor(id);
    return c.body(null, 204);
  });

  app.get('/conversations/:id/messages', async (c) => {
    const conversation = await loadConversation(c.req.param('id'));
    return c.json((await store.list(conversation)).map(toMessage));
  });

  /** Marks or unmarks a reply as the best one. */
  app.patch('/conversations/:id/messages/:messageId', async (c) => {
    const conversation = await loadConversation(c.req.param('id'));
    const body = await readJson<Partial<Message>>(c);
    if (body.preferred !== undefined && body.preferred !== null && typeof body.preferred !== 'boolean') {
      throw badRequest('preferred must be true, false or null');
    }
    const row = await store.update(conversation, c.req.param('messageId'), pick(body, ['preferred']));
    if (!row) throw notFound('Message');
    return c.json(toMessage(row));
  });

  /** Starts a new chat from one pane, with its messages up to and including `messageId`. */
  app.post('/conversations/:id/branch', async (c) => {
    const source = await loadConversation(c.req.param('id'));
    const { paneId, messageId } = await readJson<{ paneId?: string; messageId?: string }>(c);
    const pane = paneId ? await repos.panes.findById(paneId) : null;
    if (!pane || pane.conversationId !== source.id) throw notFound('Pane');
    const rows = await store.list(source, pane.id);
    const end = rows.findIndex((row) => row.id === messageId);
    if (end === -1) throw notFound('Message');

    const branch = await repos.conversations.create({
      title: `${source.title} (branch)`.slice(0, 80),
      persist: source.persist,
      useMemory: source.useMemory,
      webAccess: source.webAccess,
      workspace: source.workspace,
      toolGroups: source.toolGroups,
      pinned: false,
      archived: false,
    });
    const { id: _id, createdAt: _created, updatedAt: _updated, conversationId: _conversation, ...paneFields } = pane;
    const newPane = await repos.panes.create({ ...paneFields, conversationId: branch.id, position: 0 });

    // Attachments belong to one chat, so the branch gets its own copies.
    const copiedFiles = new Map<string, string>();
    const kept = [];
    for (const row of rows.slice(0, end + 1)) {
      const refs = (row.attachments as AttachmentRef[] | null) ?? [];
      const newRefs: AttachmentRef[] = [];
      for (const ref of refs) {
        const file = await repos.attachments.findById(ref.id);
        if (!file) continue;
        const copyId = copiedFiles.get(ref.id) ?? randomUUID();
        if (!copiedFiles.has(ref.id)) {
          const { createdAt: _fileCreated, ...fileFields } = file;
          await repos.attachments.create({ ...fileFields, id: copyId, conversationId: branch.id });
          copiedFiles.set(ref.id, copyId);
        }
        newRefs.push({ ...ref, id: copyId });
      }
      kept.push({ ...row, attachments: refs.length ? newRefs : row.attachments });
    }
    await store.copy(branch, newPane.id, kept, () => randomUUID());
    // The branch starts with the files as they are now, and the two chats change them separately from here.
    await workspaces.copy(source.id, branch.id);
    return c.json(await detail(branch), 201);
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
    const current = await loadPane(id);
    const body = await readJson<Partial<Pane>>(c);
    if (body.provider !== undefined || body.model !== undefined) validateModel({ ...current, ...body } as Partial<ModelRef>);
    const row = await repos.panes.update(
      id,
      pick(body, ['provider', 'model', 'systemPromptId', 'systemPrompt', 'params', 'position']),
    );
    return c.json(serialize<Pane>(row));
  });

  app.delete('/panes/:id', async (c) => {
    const pane = await loadPane(c.req.param('id'));
    if ((await repos.panes.count({ where: { conversationId: pane.conversationId } })) <= 1) {
      throw badRequest('A conversation needs at least one pane');
    }
    await store.clearPane(await loadConversation(pane.conversationId), pane.id);
    await repos.panes.delete(pane.id);
    return c.body(null, 204);
  });

  app.delete('/panes/:id/messages', async (c) => {
    const pane = await loadPane(c.req.param('id'));
    const removed = await store.clearPane(await loadConversation(pane.conversationId), pane.id);
    return c.json({ removed });
  });

  app.get('/panes/:id/preview', async (c) => {
    const pane = await loadPane(c.req.param('id'));
    const conversation = await loadConversation(pane.conversationId);
    return c.json(await chat.preview(conversation, pane));
  });

  return app;
}
