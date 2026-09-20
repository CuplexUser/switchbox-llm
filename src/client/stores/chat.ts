import { create } from 'zustand';
import type {
  ActivityItem,
  ApprovalRequest,
  AttachmentRef,
  ConversationDetail,
  Message,
  Source,
  StreamAction,
  StreamEvent,
} from '../../shared/types.ts';
import { api } from '../api/client.ts';
import { streamChat } from '../api/stream.ts';
import { sameUserMessage, siblingReplies } from '../lib/turns.ts';

export interface LiveReply {
  messageId: string | null;
  text: string;
  reasoning: string;
  startedAt: number;
  firstTokenAt: number | null;
  activity: ActivityItem[];
  sources: Source[];
  /** Tool calls waiting for the user to approve or decline. */
  approvals: ApprovalRequest[];
}

export interface PaneRuntime {
  messages: Message[];
  live: LiveReply | null;
}

/** A message typed while a reply was still streaming, held back until it finishes. */
export interface QueuedSend {
  id: string;
  content: string;
  paneIds: string[];
  attachments: AttachmentRef[];
}

export interface ConversationRuntime {
  hydrated: boolean;
  runId: string | null;
  panes: Record<string, PaneRuntime>;
  /** Sends made while busy, in order; the next one starts once the current run finishes. */
  queue: QueuedSend[];
}

interface RunInput {
  action: StreamAction;
  content: string | null;
  paneIds: string[];
  attachmentIds?: string[];
  messageIds?: Record<string, string>;
}

interface ChatState {
  conversations: Record<string, ConversationRuntime>;
  hydrate: (conversationId: string, messages: Message[]) => void;
  send: (conversation: ConversationDetail, content: string, paneIds: string[], attachments?: AttachmentRef[]) => Promise<void>;
  /** Removes a message that was queued while busy, before it's had a chance to send. */
  cancelQueued: (conversationId: string, id: string) => void;
  regenerate: (conversation: ConversationDetail, paneId: string) => Promise<void>;
  /** Rewrites a message and answers it again, in every pane that has the same message. */
  edit: (conversation: ConversationDetail, paneId: string, messageId: string, content: string) => Promise<void>;
  approve: (id: string, approved: boolean) => void;
  /** Marks a reply as the best one, which unmarks the other panes' replies to the same exchange. */
  setPreferred: (conversationId: string, message: Message, preferred: boolean) => Promise<void>;
  stop: (conversationId: string, paneId?: string) => void;
  clearPane: (conversation: ConversationDetail, paneId: string) => Promise<void>;
  forget: (conversationId: string) => void;
  onRunFinished: ((conversationId: string) => void) | null;
}

const EMPTY_PANE: PaneRuntime = { messages: [], live: null };
const controllers = new Map<string, AbortController>();

/** Applies a streamed event to a pane's messages. Exported for tests. */
export function applyMessageEvent(messages: Message[], event: StreamEvent): Message[] {
  switch (event.type) {
    case 'user': {
      const index = messages.findIndex((message) => message.id === event.message.id);
      if (index === -1) return [...messages, event.message];
      return messages.map((message, position) => (position === index ? event.message : message));
    }
    case 'truncate': {
      const index = messages.findIndex((message) => message.id === event.messageId);
      return index === -1 ? messages : messages.slice(0, index + 1);
    }
    default:
      return messages;
  }
}

export function upsertActivity(items: ActivityItem[], item: ActivityItem): ActivityItem[] {
  const exists = items.some((entry) => entry.id === item.id);
  return exists ? items.map((entry) => (entry.id === item.id ? item : entry)) : [...items, item];
}

export const useChatStore = create<ChatState>((set, get) => {
  const emptyRuntime = (): ConversationRuntime => ({ hydrated: true, runId: null, panes: {}, queue: [] });

  function updatePane(conversationId: string, paneId: string, update: (pane: PaneRuntime) => PaneRuntime): void {
    set((state) => {
      const conversation = state.conversations[conversationId] ?? emptyRuntime();
      const pane = conversation.panes[paneId] ?? EMPTY_PANE;
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: { ...conversation, panes: { ...conversation.panes, [paneId]: update(pane) } },
        },
      };
    });
  }

  function updateLive(conversationId: string, paneId: string, update: (live: LiveReply) => LiveReply): void {
    updatePane(conversationId, paneId, (pane) => (pane.live ? { ...pane, live: update(pane.live) } : pane));
  }

  function setRun(conversationId: string, runId: string | null): void {
    set((state) => {
      const conversation = state.conversations[conversationId] ?? emptyRuntime();
      return { conversations: { ...state.conversations, [conversationId]: { ...conversation, runId } } };
    });
  }

  /** Adds a send to the conversation's queue, so it shows in the transcript right away. */
  function enqueue(conversationId: string, item: QueuedSend): void {
    set((state) => {
      const conversation = state.conversations[conversationId] ?? emptyRuntime();
      return { conversations: { ...state.conversations, [conversationId]: { ...conversation, queue: [...conversation.queue, item] } } };
    });
  }

  /** Runs the next queued send, if any, once the current run has fully finished (so it sees the completed reply as context). */
  async function drainQueue(conversation: ConversationDetail): Promise<void> {
    const conversationId = conversation.id;
    const next = get().conversations[conversationId]?.queue[0];
    if (!next) return;
    set((state) => {
      const current = state.conversations[conversationId];
      if (!current) return state;
      return { conversations: { ...state.conversations, [conversationId]: { ...current, queue: current.queue.slice(1) } } };
    });
    await runSend(conversation, next);
  }

  async function run(conversation: ConversationDetail, input: RunInput): Promise<void> {
    const conversationId = conversation.id;
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    controllers.set(conversationId, controller);
    setRun(conversationId, runId);

    const now = performance.now();
    for (const paneId of input.paneIds) {
      updatePane(conversationId, paneId, (pane) => ({
        ...pane,
        live: { messageId: null, text: '', reasoning: '', startedAt: now, firstTokenAt: null, activity: [], sources: [], approvals: [] },
      }));
    }

    // Deltas arrive per token; buffer them and flush once per frame.
    const pending = new Map<string, { text: string; reasoning: string }>();
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      for (const [paneId, chunk] of pending) {
        updateLive(conversationId, paneId, (live) => ({
          ...live,
          text: live.text + chunk.text,
          reasoning: live.reasoning + chunk.reasoning,
          firstTokenAt: live.firstTokenAt ?? performance.now(),
        }));
      }
      pending.clear();
    };
    const queue = (paneId: string, kind: 'text' | 'reasoning', text: string) => {
      const chunk = pending.get(paneId) ?? { text: '', reasoning: '' };
      chunk[kind] += text;
      pending.set(paneId, chunk);
      frame ??= requestAnimationFrame(flush);
    };

    const finish = (paneId: string, message: Message | null) => {
      flush();
      updatePane(conversationId, paneId, (pane) => ({
        messages: message ? [...pane.messages, message] : pane.messages,
        live: null,
      }));
    };

    const onEvent = (event: StreamEvent) => {
      switch (event.type) {
        case 'user':
        case 'truncate':
          updatePane(conversationId, event.paneId, (pane) => ({ ...pane, messages: applyMessageEvent(pane.messages, event) }));
          break;
        case 'start':
          updateLive(conversationId, event.paneId, (live) => ({ ...live, messageId: event.messageId }));
          break;
        case 'delta':
          queue(event.paneId, 'text', event.text);
          break;
        case 'reasoning':
          queue(event.paneId, 'reasoning', event.text);
          break;
        case 'activity':
          updateLive(conversationId, event.paneId, (live) => ({ ...live, activity: upsertActivity(live.activity, event.item) }));
          break;
        case 'source':
          updateLive(conversationId, event.paneId, (live) => ({ ...live, sources: [...live.sources, event.source] }));
          break;
        case 'approval':
          updateLive(conversationId, event.paneId, (live) => ({ ...live, approvals: [...live.approvals, event.request] }));
          break;
        case 'approval_resolved':
          updateLive(conversationId, event.paneId, (live) => ({
            ...live,
            approvals: live.approvals.filter((request) => request.id !== event.id),
          }));
          break;
        case 'done':
          finish(event.paneId, event.message);
          break;
        case 'error':
          finish(event.paneId, event.message ?? errorMessage(conversation, event.paneId, event.error));
          break;
        case 'end':
          break;
      }
    };

    try {
      await streamChat({ runId, conversationId, ...input }, onEvent, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const paneId of input.paneIds) {
          if (get().conversations[conversationId]?.panes[paneId]?.live) {
            finish(paneId, errorMessage(conversation, paneId, reason));
          }
        }
      }
    } finally {
      if (frame !== null) cancelAnimationFrame(frame);
      flush();
      for (const paneId of input.paneIds) {
        updatePane(conversationId, paneId, (pane) => (pane.live ? { ...pane, live: null } : pane));
      }
      controllers.delete(conversationId);
      setRun(conversationId, null);
      get().onRunFinished?.(conversationId);
      void drainQueue(conversation);
    }
  }

  async function runSend(conversation: ConversationDetail, item: QueuedSend): Promise<void> {
    await run(conversation, {
      action: 'send',
      content: item.content,
      paneIds: item.paneIds,
      ...(item.attachments.length ? { attachmentIds: item.attachments.map((attachment) => attachment.id) } : {}),
    });
  }

  function messagesByPane(conversationId: string): Record<string, Message[]> {
    return messagesByPaneOf(get().conversations[conversationId]);
  }

  function busy(conversationId: string): boolean {
    return Boolean(get().conversations[conversationId]?.runId);
  }

  return {
    conversations: {},
    onRunFinished: null,

    hydrate(conversationId, messages) {
      const existing = get().conversations[conversationId];
      if (existing?.hydrated || existing?.runId) return;
      const panes: Record<string, PaneRuntime> = {};
      for (const message of messages) {
        const pane = (panes[message.paneId] ??= { messages: [], live: null });
        pane.messages.push(message);
      }
      set((state) => ({
        conversations: { ...state.conversations, [conversationId]: { hydrated: true, runId: null, panes, queue: [] } },
      }));
    },

    async send(conversation, content, paneIds, attachments = []) {
      const item: QueuedSend = { id: crypto.randomUUID(), content, paneIds, attachments };
      if (busy(conversation.id)) {
        enqueue(conversation.id, item);
        return;
      }
      await runSend(conversation, item);
    },

    cancelQueued(conversationId, id) {
      set((state) => {
        const conversation = state.conversations[conversationId];
        if (!conversation) return state;
        return {
          conversations: {
            ...state.conversations,
            [conversationId]: { ...conversation, queue: conversation.queue.filter((entry) => entry.id !== id) },
          },
        };
      });
    },

    async regenerate(conversation, paneId) {
      if (busy(conversation.id)) return;
      const messages = get().conversations[conversation.id]?.panes[paneId]?.messages ?? [];
      const lastUser = messages.findLastIndex((message) => message.role === 'user');
      if (lastUser === -1) return;
      updatePane(conversation.id, paneId, (pane) => ({ ...pane, messages: messages.slice(0, lastUser + 1) }));
      await run(conversation, { action: 'regenerate', content: null, paneIds: [paneId] });
    },

    async edit(conversation, paneId, messageId, content) {
      if (busy(conversation.id)) return;
      const messageIds = sameUserMessage(messagesByPane(conversation.id), paneId, messageId);
      const paneIds = Object.keys(messageIds);
      if (paneIds.length === 0) return;
      for (const [id, target] of Object.entries(messageIds)) {
        updatePane(conversation.id, id, (pane) => {
          const index = pane.messages.findIndex((message) => message.id === target);
          return {
            ...pane,
            messages: pane.messages.slice(0, index + 1).map((message) => (message.id === target ? { ...message, content } : message)),
          };
        });
      }
      await run(conversation, { action: 'edit', content, paneIds, messageIds });
    },

    approve(id, approved) {
      void api('/chat/approve', { method: 'POST', json: { id, approved } });
    },

    async setPreferred(conversationId, message, preferred) {
      const others = preferred ? siblingReplies(messagesByPane(conversationId), message).filter((reply) => reply.preferred) : [];
      const apply = (target: Message, value: boolean | null) =>
        updatePane(conversationId, target.paneId, (pane) => ({
          ...pane,
          messages: pane.messages.map((entry) => (entry.id === target.id ? { ...entry, preferred: value } : entry)),
        }));
      const save = async (target: Message, value: boolean) => {
        apply(target, value);
        try {
          await api(`/conversations/${conversationId}/messages/${target.id}`, { method: 'PATCH', json: { preferred: value } });
        } catch {
          apply(target, target.preferred);
        }
      };
      await Promise.all([save(message, preferred), ...others.map((other) => save(other, false))]);
    },

    stop(conversationId, paneId) {
      const runId = get().conversations[conversationId]?.runId;
      if (!runId) return;
      if (paneId) {
        void api('/chat/stop', { method: 'POST', json: { runId, paneId } });
      } else {
        // Ask the server to stop first so partial replies are saved, then drop the connection as a fallback.
        void api('/chat/stop', { method: 'POST', json: { runId } }).finally(() => {
          setTimeout(() => controllers.get(conversationId)?.abort(), 1500);
        });
      }
    },

    async clearPane(conversation, paneId) {
      await api(`/panes/${paneId}/messages`, { method: 'DELETE' });
      updatePane(conversation.id, paneId, () => ({ messages: [], live: null }));
    },

    forget(conversationId) {
      controllers.get(conversationId)?.abort();
      set((state) => {
        const { [conversationId]: _removed, ...rest } = state.conversations;
        return { conversations: rest };
      });
    },
  };
});

function errorMessage(conversation: ConversationDetail, paneId: string, error: string): Message {
  const pane = conversation.panes.find((entry) => entry.id === paneId);
  return {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    paneId,
    role: 'assistant',
    content: '',
    reasoning: null,
    provider: pane?.provider ?? null,
    model: pane?.model ?? null,
    tokensIn: null,
    tokensOut: null,
    ttftMs: null,
    latencyMs: null,
    cost: null,
    finishReason: null,
    error,
    activity: null,
    attachments: null,
    preferred: null,
    createdAt: new Date().toISOString(),
  };
}

export function allMessages(runtime: ConversationRuntime | undefined): Message[] {
  return Object.values(runtime?.panes ?? {}).flatMap((pane) => pane.messages);
}

export function messagesByPaneOf(runtime: ConversationRuntime | undefined): Record<string, Message[]> {
  return Object.fromEntries(Object.entries(runtime?.panes ?? {}).map(([paneId, pane]) => [paneId, pane.messages]));
}
