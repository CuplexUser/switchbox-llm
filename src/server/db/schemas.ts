import { defineSchema, type Infer } from 'repolayer';

// Column names avoid SQL reserved words (key, order, ...) because repolayer never quotes identifiers.

export const settingSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  value: { type: 'json' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

export const systemPromptSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  name: { type: 'string' },
  content: { type: 'string' },
  isDefault: { type: 'boolean', column: 'is_default' },
  createdAt: { type: 'date', column: 'created_at' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

export const conversationSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  title: { type: 'string' },
  persist: { type: 'boolean' },
  useMemory: { type: 'boolean', column: 'use_memory' },
  webAccess: { type: 'boolean', column: 'web_access' },
  pinned: { type: 'boolean' },
  archived: { type: 'boolean' },
  createdAt: { type: 'date', column: 'created_at' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

export const paneSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  conversationId: { type: 'string', column: 'conversation_id' },
  position: { type: 'integer', column: 'pane_position' },
  provider: { type: 'string' },
  model: { type: 'string' },
  systemPromptId: { type: 'string', nullable: true, column: 'system_prompt_id' },
  systemPrompt: { type: 'string', nullable: true, column: 'system_prompt' },
  params: { type: 'json' },
  createdAt: { type: 'date', column: 'created_at' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

export const messageSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  conversationId: { type: 'string', column: 'conversation_id' },
  paneId: { type: 'string', column: 'pane_id' },
  role: { type: 'string' },
  content: { type: 'string' },
  reasoning: { type: 'string', nullable: true },
  provider: { type: 'string', nullable: true },
  model: { type: 'string', nullable: true },
  tokensIn: { type: 'integer', nullable: true, column: 'tokens_in' },
  tokensOut: { type: 'integer', nullable: true, column: 'tokens_out' },
  ttftMs: { type: 'integer', nullable: true, column: 'ttft_ms' },
  latencyMs: { type: 'integer', nullable: true, column: 'latency_ms' },
  cost: { type: 'number', nullable: true },
  finishReason: { type: 'string', nullable: true, column: 'finish_reason' },
  error: { type: 'string', nullable: true },
  activity: { type: 'json', nullable: true },
  createdAt: { type: 'date', column: 'created_at' },
});

export const memorySchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  content: { type: 'string' },
  category: { type: 'string' },
  enabled: { type: 'boolean' },
  source: { type: 'string' },
  status: { type: 'string' },
  sourceConversationId: { type: 'string', nullable: true, column: 'source_conversation_id' },
  createdAt: { type: 'date', column: 'created_at' },
  updatedAt: { type: 'date', column: 'updated_at' },
});

export type SettingRow = Infer<typeof settingSchema>;
export type SystemPromptRow = Infer<typeof systemPromptSchema>;
export type ConversationRow = Infer<typeof conversationSchema>;
export type PaneRow = Infer<typeof paneSchema>;
export type MessageRow = Infer<typeof messageSchema>;
export type MemoryRow = Infer<typeof memorySchema>;

/** One row per assistant reply, kept when its chat is deleted so usage totals stay complete. The id is the message id. */
export const usageRecordSchema = defineSchema({
  id: { type: 'string', primaryKey: true },
  conversationId: { type: 'string', column: 'conversation_id' },
  provider: { type: 'string' },
  model: { type: 'string' },
  tokensIn: { type: 'integer', nullable: true, column: 'tokens_in' },
  tokensOut: { type: 'integer', nullable: true, column: 'tokens_out' },
  cost: { type: 'number', nullable: true },
  ttftMs: { type: 'integer', nullable: true, column: 'ttft_ms' },
  latencyMs: { type: 'integer', nullable: true, column: 'latency_ms' },
  failed: { type: 'boolean' },
  createdAt: { type: 'date', column: 'created_at' },
});

export type UsageRecordRow = Infer<typeof usageRecordSchema>;
