import { create } from 'zustand';
import type { ActivityItem, ChatTurn, ConversationDetail, Message, Source, StreamEvent } from '../../shared/types.ts';
import { api } from '../api/client.ts';
import { streamChat } from '../api/stream.ts';

export interface LiveReply {
  messageId: string | null;
  text: string;
  reasoning: string;
  startedAt: number;
  firstTokenAt: number | null;
  activity: ActivityItem[];
  sources: Source[];
}

export interface PaneRuntime {
  messages: Message[];
  live: LiveReply | null;
}

interface ConversationRuntime {
  hydrated: boolean;
  runId: string | null;
  panes: Record<string, PaneRuntime>;
}

interface ChatState {
  conversations: Record<string, ConversationRuntime>;
  hydrate: (conversationId: string, messages: Message[]) => void;
  send: (conversation: ConversationDetail, content: string, paneIds: string[]) => Promise<void>;
  regenerate: (conversation: ConversationDetail, paneId: string) => Promise<void>;
  stop: (conversationId: string, paneId?: string) => void;
  clearPane: (conversation: ConversationDetail, paneId: string) => Promise<void>;
  forget: (conversationId: string) => void;
  onRunFinished: ((conversationId: string) => void) | null;
}

const EMPTY_PANE: PaneRuntime = { messages: [], live: null };
const controllers = new Map<string, AbortController>();

function historyOf(messages: Message[]): ChatTurn[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({ role: message.role, content: message.content }));
}

export const useChatStore = create<ChatState>((set, get) => {
  function updatePane(conversationId: string, paneId: string, update: (pane: PaneRuntime) => PaneRuntime): void {
    set((state) => {
      const conversation = state.conversations[conversationId] ?? { hydrated: true, runId: null, panes: {} };
      const pane = conversation.panes[paneId] ?? EMPTY_PANE;
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: { ...conversation, panes: { ...conversation.panes, [paneId]: update(pane) } },
        },
      };
    });
  }

  function setRun(conversationId: string, runId: string | null): void {
    set((state) => {
      const conversation = state.conversations[conversationId] ?? { hydrated: true, runId: null, panes: {} };
      return { conversations: { ...state.conversations, [conversationId]: { ...conversation, runId } } };
    });
  }

  async function run(
    conversation: ConversationDetail,
    content: string | null,
    targets: { paneId: string; history: ChatTurn[] }[],
  ): Promise<void> {
    const conversationId = conversation.id;
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    controllers.set(conversationId, controller);
    setRun(conversationId, runId);

    const now = performance.now();
    for (const { paneId } of targets) {
      updatePane(conversationId, paneId, (pane) => ({
        ...pane,
        live: { messageId: null, text: '', reasoning: '', startedAt: now, firstTokenAt: null, activity: [], sources: [] },
      }));
    }

    // Deltas arrive per token; buffer them and flush once per frame.
    const pending = new Map<string, { text: string; reasoning: string }>();
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      for (const [paneId, chunk] of pending) {
        updatePane(conversationId, paneId, (pane) =>
          pane.live
            ? {
                ...pane,
                live: {
                  ...pane.live,
                  text: pane.live.text + chunk.text,
                  reasoning: pane.live.reasoning + chunk.reasoning,
                  firstTokenAt: pane.live.firstTokenAt ?? performance.now(),
                },
              }
            : pane,
        );
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
          updatePane(conversationId, event.paneId, (pane) => ({ ...pane, messages: [...pane.messages, event.message] }));
          break;
        case 'start':
          updatePane(conversationId, event.paneId, (pane) =>
            pane.live ? { ...pane, live: { ...pane.live, messageId: event.messageId } } : pane,
          );
          break;
        case 'delta':
          queue(event.paneId, 'text', event.text);
          break;
        case 'reasoning':
          queue(event.paneId, 'reasoning', event.text);
          break;
        case 'activity':
          updatePane(conversationId, event.paneId, (pane) => {
            if (!pane.live) return pane;
            const exists = pane.live.activity.some((item) => item.id === event.item.id);
            const activity = exists
              ? pane.live.activity.map((item) => (item.id === event.item.id ? event.item : item))
              : [...pane.live.activity, event.item];
            return { ...pane, live: { ...pane.live, activity } };
          });
          break;
        case 'source':
          updatePane(conversationId, event.paneId, (pane) =>
            pane.live ? { ...pane, live: { ...pane.live, sources: [...pane.live.sources, event.source] } } : pane,
          );
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
      await streamChat({ runId, conversationId, content, targets }, onEvent, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const { paneId } of targets) {
          if (get().conversations[conversationId]?.panes[paneId]?.live) {
            finish(paneId, errorMessage(conversation, paneId, reason));
          }
        }
      }
    } finally {
      if (frame !== null) cancelAnimationFrame(frame);
      flush();
      for (const { paneId } of targets) {
        updatePane(conversationId, paneId, (pane) => (pane.live ? { ...pane, live: null } : pane));
      }
      controllers.delete(conversationId);
      setRun(conversationId, null);
      get().onRunFinished?.(conversationId);
    }
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
        conversations: { ...state.conversations, [conversationId]: { hydrated: true, runId: null, panes } },
      }));
    },

    async send(conversation, content, paneIds) {
      if (get().conversations[conversation.id]?.runId) return;
      const panes = get().conversations[conversation.id]?.panes ?? {};
      await run(
        conversation,
        content,
        paneIds.map((paneId) => ({ paneId, history: historyOf(panes[paneId]?.messages ?? []) })),
      );
    },

    async regenerate(conversation, paneId) {
      if (get().conversations[conversation.id]?.runId) return;
      const messages = get().conversations[conversation.id]?.panes[paneId]?.messages ?? [];
      const lastUser = messages.findLastIndex((message) => message.role === 'user');
      if (lastUser === -1) return;
      const removed = messages.slice(lastUser + 1);
      updatePane(conversation.id, paneId, (pane) => ({ ...pane, messages: messages.slice(0, lastUser + 1) }));
      if (conversation.persist) {
        await Promise.all(removed.map((message) => api<void>(`/messages/${message.id}`, { method: 'DELETE' })));
      }
      await run(conversation, null, [{ paneId, history: historyOf(messages.slice(0, lastUser + 1)) }]);
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
      if (conversation.persist) await api(`/panes/${paneId}/messages`, { method: 'DELETE' });
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
    createdAt: new Date().toISOString(),
  };
}

export function allMessages(runtime: ConversationRuntime | undefined): Message[] {
  return Object.values(runtime?.panes ?? {}).flatMap((pane) => pane.messages);
}
