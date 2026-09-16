import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { addMissingColumns } from './migrate.ts';
import { createRepo, type Repo } from 'repolayer';
import { MemoryRepo, MemoryStore } from 'repolayer/memory';
import {
  conversationSchema,
  memorySchema,
  messageSchema,
  paneSchema,
  settingSchema,
  systemPromptSchema,
  usageRecordSchema,
  type ConversationRow,
  type MemoryRow,
  type MessageRow,
  type PaneRow,
  type SettingRow,
  type SystemPromptRow,
  type UsageRecordRow,
} from './schemas.ts';

const BOTH = { createdAt: 'createdAt', updatedAt: 'updatedAt' } as const;

export interface Repos {
  settings: Repo<SettingRow>;
  systemPrompts: Repo<SystemPromptRow>;
  conversations: Repo<ConversationRow>;
  panes: Repo<PaneRow>;
  messages: Repo<MessageRow>;
  memories: Repo<MemoryRow>;
  usage: Repo<UsageRecordRow>;
}

export async function openRepos(file: string): Promise<Repos> {
  mkdirSync(dirname(file), { recursive: true });
  const added = addMissingColumns(file, [
    { table: 'conversations', schema: conversationSchema, defaults: { web_access: '1' } },
    { table: 'messages', schema: messageSchema },
  ]);
  if (added.length > 0) console.info(`[db] added columns: ${added.join(', ')}`);
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
      timestamps: { createdAt: 'createdAt', updatedAt: false },
    }),
    memories: await createRepo<MemoryRow>({ ...base, table: 'memories', schema: memorySchema, timestamps: true }),
    // No timestamps: createdAt is copied from the reply, including for backfilled rows.
    usage: await createRepo<UsageRecordRow>({ ...base, table: 'usage_records', schema: usageRecordSchema, ids: 'provided' }),
  };

  for (const repo of Object.values(repos) as Repo<unknown>[]) {
    const diff = await repo.verifyTable();
    for (const finding of diff.findings) console.warn(`[db] ${finding.severity}: ${finding.message}`);
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
      timestamps: { createdAt: 'createdAt', updatedAt: false },
      store,
    }),
    memories: new MemoryRepo<MemoryRow>({ table: 'memories', schema: memorySchema, timestamps: BOTH, store }),
    usage: new MemoryRepo<UsageRecordRow>({ table: 'usage_records', schema: usageRecordSchema, ids: 'provided', store }),
  };
}
