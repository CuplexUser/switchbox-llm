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
}

export async function openRepos(file: string): Promise<Repos> {
  mkdirSync(dirname(file), { recursive: true });
  const added = addMissingColumns(file, [
    { table: 'conversations', schema: conversationSchema, defaults: { web_access: '1' } },
    { table: 'messages', schema: messageSchema },
    { table: 'system_prompts', schema: systemPromptSchema },
    { table: 'memories', schema: memorySchema },
  ]);
  if (added.length > 0) log.info('added columns', { columns: added.join(', ') });
  const base = { driver: 'sqlite', connection: { file, busyTimeoutMs: 5000 }, ensureTable: true } as const;

  const repos: Repos = {
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
      timestamps: CREATED_ONLY,
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

  return repos;
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
      timestamps: CREATED_ONLY,
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
  };
}
