import type { ConversationDetail, Message, Pane } from '../shared/types.ts';

/** Fixtures for client tests. */
export function message(id: string, paneId: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'c1',
    paneId,
    role,
    content,
    reasoning: null,
    provider: 'openrouter',
    model: 'a/model',
    tokensIn: null,
    tokensOut: null,
    ttftMs: null,
    latencyMs: null,
    cost: null,
    finishReason: null,
    error: null,
    activity: null,
    attachments: null,
    preferred: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...extra,
  };
}

export function pane(id: string, model: string, position: number): Pane {
  return {
    id,
    conversationId: 'c1',
    position,
    provider: 'openrouter',
    model,
    systemPromptId: null,
    systemPrompt: null,
    params: {},
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
  } as Pane;
}

export function conversationWith(panes: Pane[]): ConversationDetail {
  return { id: 'c1', title: 'Test chat', panes } as ConversationDetail;
}
