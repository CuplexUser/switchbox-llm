import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRepo, type Repo } from 'repolayer';
import { MemoryRepo, MemoryStore } from 'repolayer/memory';
import { createLogger } from '../log.ts';
import { addMissingColumns } from './migrate.ts';
import {
  attachmentSchema,
  conversationSchema,
  memoryHistorySchema,
  memorySchema,
  messageSchema,
  paneSchema,
  settingSchema,
  systemPromptSchema,
  usageRecordSchema,
  type AttachmentRow,
  type ConversationRow,
  type MemoryHistoryRow,
  type MemoryRow,
  type MessageRow,
  type PaneRow,
  type SettingRow,
  type SystemPromptRow,
  type UsageRecordRow,
} from './schemas.ts';

const BOTH = { createdAt: 'createdAt', updatedAt: 'updatedAt' } as const;
const CREATED_ONLY = { createdAt: 'createdAt', updatedAt: false } as const;
const log = createLogger('db');

/** Tables whose repos stamp createdAt, which an import has to set itself. */
export type DatedTable = 'conversations' | 'panes' | 'systemPrompts' | 'memories' | 'attachments';

export interface Repos {
  settings: Repo<SettingRow>;
  systemPrompts: Repo<SystemPromptRow>;
  conversations: Repo<ConversationRow>;
  panes: Repo<PaneRow>;
  messages: Repo<MessageRow>;
  memories: Repo<MemoryRow>;
  memoryHistory: Repo<MemoryHistoryRow>;
  attachments: Repo<AttachmentRow>;
  usage: Repo<UsageRecordRow>;
  /** The dated tables again without timestamps, so imported rows keep their dates. Only imports write here. */
  undated: Pick<Repos, DatedTable>;
}

/** Every repo, including the undated ones, for closing them all. */
export function allRepos(repos: Repos): Repo<unknown>[] {
  const { undated, ...main } = repos;
  return [...Object.values(main), ...Object.values(undated)] as Repo<unknown>[];
}

export async function openRepos(file: string): Promise<Repos> {
  mkdirSync(dirname(file), { recursive: true });
  const added = addMissingColumns(file, [
    { table: 'conversations', schema: conversationSchema, defaults: { web_access: '1', workspace: '0' } },
    { table: 'messages', schema: messageSchema },
    { table: 'system_prompts', schema: systemPromptSchema },
    { table: 'memories', schema: memorySchema },
  ]);
  if (added.length > 0) log.info('added columns', { columns: added.join(', ') });
  const base = { driver: 'sqlite', connection: { file, busyTimeoutMs: 5000 }, ensureTable: true } as const;

  const repos: Omit<Repos, 'undated'> = {
    settings: await createRepo<SettingRow>({
      ...base,
      table: 'settings',
      schema: settingSchema,
      ids: 'provided',
      timestamps: { createdAt: false, updatedAt: 'updatedAt' },
    }),
    systemPrompts: await createRepo<SystemPromptRow>({
      ...base,
      table: 'system_prompts',
      schema: systemPromptSchema,
      timestamps: true,
    }),
    conversations: await createRepo<ConversationRow>({
      ...base,
      table: 'conversations',
      schema: conversationSchema,
      timestamps: true,
    }),
    panes: await createRepo<PaneRow>({ ...base, table: 'panes', schema: paneSchema, timestamps: true }),
    messages: await createRepo<MessageRow>({
      ...base,
      table: 'messages',
      schema: messageSchema,
      ids: 'provided',
      // createdAt is set by MessageStore, so imports and branches keep their order.
    }),
    memories: await createRepo<MemoryRow>({ ...base, table: 'memories', schema: memorySchema, timestamps: true }),
    memoryHistory: await createRepo<MemoryHistoryRow>({
      ...base,
      table: 'memory_history',
      schema: memoryHistorySchema,
      // createdAt is set by MemoryService.record, so imported history keeps its dates.
    }),
    attachments: await createRepo<AttachmentRow>({
      ...base,
      table: 'attachments',
      schema: attachmentSchema,
      ids: 'provided',
      timestamps: CREATED_ONLY,
    }),
    // No timestamps: createdAt is copied from the reply, including for backfilled rows.
    usage: await createRepo<UsageRecordRow>({ ...base, table: 'usage_records', schema: usageRecordSchema, ids: 'provided' }),
  };

  for (const repo of Object.values(repos) as Repo<unknown>[]) {
    const diff = await repo.verifyTable();
    for (const finding of diff.findings) log.warn(finding.message, { severity: finding.severity });
    if (!diff.ok) throw new Error(`Table "${diff.table}" does not match its schema. See warnings above.`);
  }

  const undated = { ...base, ensureTable: false } as const;
  return {
    ...repos,
    undated: {
      systemPrompts: await createRepo<SystemPromptRow>({ ...undated, table: 'system_prompts', schema: systemPromptSchema }),
      conversations: await createRepo<ConversationRow>({ ...undated, table: 'conversations', schema: conversationSchema }),
      panes: await createRepo<PaneRow>({ ...undated, table: 'panes', schema: paneSchema }),
      memories: await createRepo<MemoryRow>({ ...undated, table: 'memories', schema: memorySchema }),
      attachments: await createRepo<AttachmentRow>({ ...undated, table: 'attachments', schema: attachmentSchema, ids: 'provided' }),
    },
  };
}

/** In-memory repos with the same configuration, for tests. */
export function memoryRepos(): Repos {
  const store = new MemoryStore();
  return {
    settings: new MemoryRepo<SettingRow>({
      table: 'settings',
      schema: settingSchema,
      ids: 'provided',
      timestamps: { createdAt: false, updatedAt: 'updatedAt' },
      store,
    }),
    systemPrompts: new MemoryRepo<SystemPromptRow>({
      table: 'system_prompts',
      schema: systemPromptSchema,
      timestamps: BOTH,
      store,
    }),
    conversations: new MemoryRepo<ConversationRow>({
      table: 'conversations',
      schema: conversationSchema,
      timestamps: BOTH,
      store,
    }),
    panes: new MemoryRepo<PaneRow>({ table: 'panes', schema: paneSchema, timestamps: BOTH, store }),
    messages: new MemoryRepo<MessageRow>({
      table: 'messages',
      schema: messageSchema,
      ids: 'provided',
      // createdAt is set by MessageStore, so imports and branches keep their order.
      store,
    }),
    memories: new MemoryRepo<MemoryRow>({ table: 'memories', schema: memorySchema, timestamps: BOTH, store }),
    memoryHistory: new MemoryRepo<MemoryHistoryRow>({
      table: 'memory_history',
      schema: memoryHistorySchema,
      store,
    }),
    attachments: new MemoryRepo<AttachmentRow>({
      table: 'attachments',
      schema: attachmentSchema,
      ids: 'provided',
      timestamps: CREATED_ONLY,
      store,
    }),
    usage: new MemoryRepo<UsageRecordRow>({ table: 'usage_records', schema: usageRecordSchema, ids: 'provided', store }),
    undated: {
      systemPrompts: new MemoryRepo<SystemPromptRow>({ table: 'system_prompts', schema: systemPromptSchema, store }),
      conversations: new MemoryRepo<ConversationRow>({ table: 'conversations', schema: conversationSchema, store }),
      panes: new MemoryRepo<PaneRow>({ table: 'panes', schema: paneSchema, store }),
      memories: new MemoryRepo<MemoryRow>({ table: 'memories', schema: memorySchema, store }),
      attachments: new MemoryRepo<AttachmentRow>({ table: 'attachments', schema: attachmentSchema, ids: 'provided', store }),
    },
  };
}
