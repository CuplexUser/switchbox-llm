import { Hono } from 'hono';
import type { Repo } from 'repolayer';
import type { AppSettings, ExportBundle } from '../../shared/types.ts';
import { badRequest, readJson, type Services } from '../context.ts';
import type { AttachmentRow, ConversationRow } from '../db/schemas.ts';
import { isZip, unzip, zipStream, type ArchiveEntry } from '../services/archive.ts';
import { MAX_ATTACHMENT_BYTES } from '../services/attachments.ts';
import { reviveDates, serialize } from '../services/serialize.ts';
import { WorkspaceError } from '../services/workspaces.ts';

const DATE_FIELDS = ['createdAt', 'updatedAt'];
/** The rows of a version 2 export, inside the archive. */
const BUNDLE_ENTRY = 'switchbox.json';
const ATTACHMENTS_PREFIX = 'attachments/';
const WORKSPACES_PREFIX = 'workspaces/';
/** Most an archive may unpack to. It is read into memory whole. */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

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
  conversations: { toolGroups: null, workspace: false, hostFolderPath: null },
  messages: { attachments: null, trace: null, preferred: null },
  systemPrompts: { tools: null, maxToolRounds: null, params: null },
  memories: { scope: null },
};

export function dataRoutes({ repos, settings, usage, store, workspaces }: Services): Hono {
  const app = new Hono();

  /**
   * A ZIP archive: the rows in switchbox.json, each attachment's bytes under attachments/<id>, and
   * each saved chat's workspace under workspaces/<chat id>/. Files stay as they are instead of
   * becoming base64 text, and the archive is compressed as it streams out.
   */
  app.get('/data/export', async (c) => {
    const conversations = await repos.conversations.findMany({ where: { persist: true } });
    const persisted = new Set(conversations.map((conversation) => conversation.id));
    const files = (await repos.attachments.findMany()).filter((file) => file.conversationId !== null && persisted.has(file.conversationId));
    const bundle: ExportBundle = serialize({
      version: 2,
      exportedAt: new Date().toISOString(),
      conversations,
      panes: (await repos.panes.findMany()).filter((pane) => persisted.has(pane.conversationId)),
      // Rows go out as stored, including tool traces, so an import can replay them.
      messages: await repos.messages.findMany({ orderBy: [{ field: 'createdAt', direction: 'asc' }] }),
      systemPrompts: await repos.systemPrompts.findMany(),
      memories: await repos.memories.findMany(),
      memoryHistory: await repos.memoryHistory.findMany({ orderBy: [{ field: 'createdAt', direction: 'asc' }] }),
      attachments: files.map(({ data: _data, ...file }) => file),
      settings: await settings.getAll(),
    });

    async function* entries(): AsyncGenerator<ArchiveEntry> {
      yield { path: BUNDLE_ENTRY, data: Buffer.from(JSON.stringify(bundle), 'utf8') };
      for (const file of files) yield { path: `${ATTACHMENTS_PREFIX}${file.id}`, data: file.data, modified: file.createdAt };
      for (const conversation of conversations) {
        if (!(await workspaces.exists(conversation.id))) continue;
        for (const file of await workspaces.files(conversation.id)) {
          const { data } = await workspaces.readBytes(conversation.id, file.path);
          yield { path: `${WORKSPACES_PREFIX}${conversation.id}/${file.path}`, data, modified: new Date(file.modifiedAt) };
        }
      }
    }

    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="switchbox-export-${bundle.exportedAt.slice(0, 10)}.zip"`);
    return c.body(zipStream(entries()));
  });

  /**
   * Merges an export in: rows whose id already exists are skipped, and workspace files that already
   * exist are left alone, so importing twice is harmless. Takes a ZIP archive, or the JSON file
   * earlier versions exported.
   */
  app.post('/data/import', async (c) => {
    let bundle: Partial<ExportBundle>;
    let entries = new Map<string, Uint8Array>();
    // A ZIP body can't be sent cross-site without a CORS preflight either, like JSON.
    if (/^application\/(zip|x-zip-compressed)\b/i.test(c.req.header('content-type') ?? '')) {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (!isZip(bytes)) throw badRequest('Not a ZIP archive');
      const workspaceLimit = (await settings.get('workspace')).maxFileMb * 1024 * 1024;
      entries = unzip(bytes, { maxEntryBytes: Math.max(MAX_ATTACHMENT_BYTES, workspaceLimit, 256 * 1024 * 1024), maxTotalBytes: MAX_IMPORT_BYTES });
      const rows = entries.get(BUNDLE_ENTRY);
      if (!rows) throw badRequest(`Not a Switchbox export (no ${BUNDLE_ENTRY} in the archive)`);
      try {
        bundle = JSON.parse(Buffer.from(rows).toString('utf8')) as Partial<ExportBundle>;
      } catch {
        throw badRequest(`${BUNDLE_ENTRY} is not valid JSON`);
      }
    } else {
      bundle = await readJson<Partial<ExportBundle>>(c);
    }
    if (bundle.version !== 1 && bundle.version !== 2) throw badRequest('Not a Switchbox export (expected version 1 or 2)');

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

    // Version 1 carries the bytes as base64 in the row, version 2 as an archive entry. Rows with neither are left out.
    const attachmentBytes = (row: { id?: unknown; data?: unknown }): Uint8Array | null => {
      const entry = typeof row.id === 'string' ? entries.get(`${ATTACHMENTS_PREFIX}${row.id}`) : undefined;
      if (entry) return entry;
      return typeof row.data === 'string' ? Buffer.from(row.data, 'base64') : null;
    };
    const attachments = (bundle.attachments ?? []).filter((row) => attachmentBytes(row) !== null);

    const imported = {
      // The undated repos store createdAt and updatedAt as given, so imported chats keep their dates.
      // A bound folder is never trusted from an import: it never went through assertBindableRoot, and a
      // path from another machine (or a crafted export) could point anywhere on this one.
      conversations: await insert(repos.undated.conversations, bundle.conversations, 'conversations', (row) => ({ ...row, hostFolderPath: null })),
      panes: await insert(repos.undated.panes, bundle.panes, 'panes'),
      messages: await insert(repos.messages, bundle.messages, 'messages'),
      systemPrompts: await insert(repos.undated.systemPrompts, bundle.systemPrompts, 'systemPrompts'),
      memories: await insert(repos.undated.memories, bundle.memories, 'memories'),
      memoryHistory: await insert(repos.memoryHistory, bundle.memoryHistory, 'memoryHistory'),
      attachments: await insert(repos.undated.attachments, attachments, 'attachments', (row) => ({
        ...row,
        data: attachmentBytes(row) as AttachmentRow['data'],
      })),
      workspaceFiles: 0,
      skippedFiles: 0,
    };

    // Each entry path goes through the workspace's own checks, so "../" and absolute names can't land outside it.
    const chats = new Map<string, ConversationRow | null>();
    for (const [name, data] of entries) {
      if (!name.startsWith(WORKSPACES_PREFIX)) continue;
      const [conversationId = '', ...rest] = name.slice(WORKSPACES_PREFIX.length).split('/');
      if (!chats.has(conversationId)) chats.set(conversationId, await repos.conversations.findById(conversationId).catch(() => null));
      if (!chats.get(conversationId)) {
        imported.skippedFiles++;
        continue;
      }
      try {
        const result = await workspaces.write(conversationId, rest.join('/'), data, { overwrite: false });
        if (result.written) imported.workspaceFiles++;
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        imported.skippedFiles++;
      }
    }

    if (imported.messages > 0) await usage.backfill();
    if (bundle.settings) {
      const incoming: Partial<AppSettings> = { ...bundle.settings };
      // MCP servers run commands on this machine, so imported ones start switched off.
      if (incoming.mcp) {
        const existing = (await settings.get('mcp')).servers;
        const serverIds = new Set(existing.map((server) => server.id));
        const added = (incoming.mcp.servers ?? []).filter((server) => !serverIds.has(server.id)).map((server) => ({ ...server, enabled: false }));
        incoming.mcp = { servers: [...existing, ...added] };
      }
      // Likewise commands keep this machine's approval rules; an import can't make them run without asking.
      if (incoming.agent?.policies) {
        const current = (await settings.get('agent')).policies;
        const policies = { ...incoming.agent.policies };
        for (const key of ['commands', 'run_command']) {
          if (current[key]) policies[key] = current[key];
          else delete policies[key];
        }
        incoming.agent = { ...incoming.agent, policies };
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
    await workspaces.deleteAll();
    return c.json({ removed });
  });

  return app;
}
