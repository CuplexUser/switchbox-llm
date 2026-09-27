import { create } from 'zustand';
import {
  STREAMING_FINISH,
  type ActiveRun,
  type ActivityItem,
  type ApprovalRequest,
  type AttachmentRef,
  type ConversationDetail,
  type Message,
  type Source,
  type StreamAction,
  type StreamEvent,
} from '../../shared/types.ts';
import { api, ApiError } from '../api/client.ts';
import { followRun, streamChat, type RunEventHandler } from '../api/stream.ts';
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
  /** The connection dropped and the client is trying to pick the run back up. */
  reconnecting: boolean;
}

/** What the store needs to know about a chat to run it. Pane details only label an error reply. */
type ChatRef = Pick<ConversationDetail, 'id'> & Partial<Pick<ConversationDetail, 'panes'>>;

/** Waits before each attempt to pick a dropped run back up, about two minutes in all. */
const RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000];

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
  /** Loads a chat's saved messages once, then attaches to any reply the server is still writing for it. */
  hydrate: (conversationId: string, messages: Message[]) => void;
  send: (conversation: ConversationDetail, content: string, paneIds: string[], attachments?: AttachmentRef[]) => Promise<void>;
  /** Removes a message that was queued while busy, before it's had a chance to send. */
  cancelQueued: (conversationId: string, id: string) => void;
  regenerate: (conversation: ConversationDetail, paneId: string) => Promise<void>;
  /** Carries on an unfinished reply from where it stopped, instead of starting over. */
  continueReply: (conversation: ConversationDetail, paneId: string, messageId: string) => Promise<void>;
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

/** Adds a finished reply, replacing an earlier copy with the same id. */
export function upsertMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((entry) => entry.id === message.id);
  return index === -1 ? [...messages, message] : messages.map((entry, position) => (position === index ? message : entry));
}

function newLive(text = '', reasoning = ''): LiveReply {
  return {
    messageId: null,
    text,
    reasoning,
    startedAt: performance.now(),
    firstTokenAt: null,
    activity: [],
    sources: [],
    approvals: [],
    reconnecting: false,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms === 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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
  async function drainQueue(conversation: ChatRef): Promise<void> {
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

  /** Starts a run on the server and follows it. */
  async function run(conversation: ChatRef, input: RunInput, live: Record<string, LiveReply> = {}): Promise<void> {
    const runId = crypto.randomUUID();
    await follow(conversation, runId, input.paneIds, live, (onEvent, signal) =>
      streamChat({ runId, conversationId: conversation.id, ...input }, onEvent, signal),
    );
  }

  /**
   * Streams a run's events into its panes. The run lives on the server, so when the connection
   * drops this picks it up again after the last event seen. If the run can't be found again, the
   * panes reload what the server saved, and only if that fails too does a pane show an error,
   * which still keeps the text that had arrived.
   */
  async function follow(
    conversation: ChatRef,
    runId: string,
    paneIds: string[],
    live: Record<string, LiveReply>,
    open: (onEvent: RunEventHandler, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const conversationId = conversation.id;
    const controller = new AbortController();
    controllers.set(conversationId, controller);
    setRun(conversationId, runId);

    for (const paneId of paneIds) {
      updatePane(conversationId, paneId, (pane) => ({ ...pane, live: live[paneId] ?? newLive() }));
    }

    // Deltas arrive per token; buffer them and flush once per frame.
    const pending = new Map<string, { text: string; reasoning: string }>();
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      for (const [paneId, chunk] of pending) {
        updateLive(conversationId, paneId, (current) => ({
          ...current,
          text: current.text + chunk.text,
          reasoning: current.reasoning + chunk.reasoning,
          firstTokenAt: current.firstTokenAt ?? performance.now(),
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
        messages: message ? upsertMessage(pane.messages, message) : pane.messages,
        live: null,
      }));
    };
    const setReconnecting = (reconnecting: boolean) => {
      for (const paneId of paneIds) updateLive(conversationId, paneId, (current) => ({ ...current, reconnecting }));
    };

    let lastSeq = 0;
    let ended = false;
    const onEvent: RunEventHandler = (event, seq) => {
      // A replay after reconnecting can start with events already seen.
      if (seq > 0 && seq <= lastSeq) return;
      lastSeq = Math.max(lastSeq, seq);
      switch (event.type) {
        case 'user':
        case 'truncate':
          updatePane(conversationId, event.paneId, (pane) => ({ ...pane, messages: applyMessageEvent(pane.messages, event) }));
          break;
        case 'start':
          updateLive(conversationId, event.paneId, (current) => ({
            ...current,
            messageId: event.messageId,
            ...(event.text === undefined ? {} : { text: event.text }),
            ...(event.reasoning === undefined ? {} : { reasoning: event.reasoning }),
          }));
          break;
        case 'delta':
          queue(event.paneId, 'text', event.text);
          break;
        case 'reasoning':
          queue(event.paneId, 'reasoning', event.text);
          break;
        case 'activity':
          updateLive(conversationId, event.paneId, (current) => ({ ...current, activity: upsertActivity(current.activity, event.item) }));
          break;
        case 'source':
          updateLive(conversationId, event.paneId, (current) => ({ ...current, sources: [...current.sources, event.source] }));
          break;
        case 'approval':
          updateLive(conversationId, event.paneId, (current) => ({ ...current, approvals: [...current.approvals, event.request] }));
          break;
        case 'approval_resolved':
          updateLive(conversationId, event.paneId, (current) => ({
            ...current,
            approvals: current.approvals.filter((request) => request.id !== event.id),
          }));
          break;
        case 'done':
          finish(event.paneId, event.message);
          break;
        case 'error':
          finish(event.paneId, event.message ?? errorMessage(conversation, event.paneId, event.error));
          break;
        case 'end':
          ended = true;
          break;
      }
    };

    const { signal } = controller;
    try {
      let failure: unknown = null;
      try {
        await open(onEvent, signal);
      } catch (error) {
        failure = error;
      }
      // A refused request (a bad message, a missing chat) never started a run, so there is nothing to pick up.
      const refused = failure instanceof ApiError && lastSeq === 0;
      let gone = refused;
      for (const delay of RECONNECT_DELAYS_MS) {
        if (ended || gone || signal.aborted) break;
        setReconnecting(true);
        await sleep(delay, signal);
        if (signal.aborted) break;
        try {
          await followRun(runId, lastSeq, (event, seq) => {
            setReconnecting(false);
            onEvent(event, seq);
          }, signal);
        } catch (error) {
          gone = error instanceof ApiError && error.status === 404;
          // Report why the connection was lost in the first place, not that the run has since ended.
          if (!gone) failure = error;
        }
      }
      if (!ended && !signal.aborted) {
        flush();
        const reason = failure instanceof Error ? failure.message : 'Lost the connection to the server.';
        await recover(conversation, paneIds, refused ? null : reason, reason);
      }
    } finally {
      if (frame !== null) cancelAnimationFrame(frame);
      flush();
      for (const paneId of paneIds) {
        updatePane(conversationId, paneId, (pane) => (pane.live ? { ...pane, live: null } : pane));
      }
      if (controllers.get(conversationId) === controller) controllers.delete(conversationId);
      setRun(conversationId, null);
      get().onRunFinished?.(conversationId);
      void drainQueue(conversation);
    }
  }

  /**
   * After losing a run, shows each pane's reply as the server saved it. `reload` is null when
   * the run never started; a pane with nothing saved gets an error reply with whatever text had
   * arrived.
   */
  async function recover(conversation: ChatRef, paneIds: string[], reload: string | null, reason: string): Promise<void> {
    const conversationId = conversation.id;
    let saved: Message[] | null = null;
    if (reload !== null) {
      try {
        saved = await api<Message[]>(`/conversations/${conversationId}/messages`);
      } catch {
        // Fall back to what the client has.
      }
    }
    for (const paneId of paneIds) {
      const pane = get().conversations[conversationId]?.panes[paneId];
      if (!pane?.live) continue;
      const live = pane.live;
      const reply = live.messageId ? saved?.find((message) => message.id === live.messageId) : undefined;
      if (saved && reply && reply.finishReason !== STREAMING_FINISH) {
        const messages = saved.filter((message) => message.paneId === paneId);
        updatePane(conversationId, paneId, () => ({ messages, live: null }));
      } else {
        updatePane(conversationId, paneId, (current) => ({
          messages: upsertMessage(current.messages, errorMessage(conversation, paneId, reason, live)),
          live: null,
        }));
      }
    }
  }

  /** Follows runs the server is still working on for a chat, as after reloading the page mid-reply. */
  async function attach(conversationId: string): Promise<void> {
    let runs: ActiveRun[];
    try {
      runs = await api<ActiveRun[]>(`/conversations/${conversationId}/runs`);
    } catch {
      return;
    }
    const runtime = get().conversations[conversationId];
    if (!Array.isArray(runs)) return;
    if (!runtime || runtime.runId) return;
    const covered = new Set(runs.flatMap((active) => active.paneIds));
    // A reply marked as still being written with no run behind it finished between the two requests: reload it.
    const stale = Object.values(runtime.panes).some((pane) => pane.messages.some((message) => message.finishReason === STREAMING_FINISH && !covered.has(message.paneId)));
    if (stale) {
      try {
        const messages = await api<Message[]>(`/conversations/${conversationId}/messages`);
        set((state) => ({ conversations: { ...state.conversations, [conversationId]: { ...(state.conversations[conversationId] ?? emptyRuntime()), panes: panesOf(messages) } } }));
      } catch {
        // Keep what's shown.
      }
    }
    const active = runs[0];
    if (!active) return;
    // The run's replay rebuilds the replies being written, so their saved copies make way.
    for (const paneId of active.paneIds) {
      updatePane(conversationId, paneId, (pane) => ({ ...pane, messages: pane.messages.filter((message) => message.finishReason !== STREAMING_FINISH) }));
    }
    await follow({ id: conversationId }, active.runId, active.paneIds, {}, (onEvent, signal) => followRun(active.runId, 0, onEvent, signal));
  }

  async function runSend(conversation: ChatRef, item: QueuedSend): Promise<void> {
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
      set((state) => ({
        conversations: { ...state.conversations, [conversationId]: { hydrated: true, runId: null, panes: panesOf(messages), queue: [] } },
      }));
      void attach(conversationId);
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

    async continueReply(conversation, paneId, messageId) {
      if (busy(conversation.id)) return;
      const messages = get().conversations[conversation.id]?.panes[paneId]?.messages ?? [];
      const index = messages.findIndex((message) => message.id === messageId);
      const reply = messages[index];
      if (!reply || reply.role !== 'assistant') return;
      // The reply moves back to being written, starting from what it already says.
      updatePane(conversation.id, paneId, (pane) => ({ ...pane, messages: messages.slice(0, index) }));
      await run(conversation, { action: 'continue', content: null, paneIds: [paneId], messageIds: { [paneId]: messageId } }, {
        [paneId]: newLive(reply.content, reply.reasoning ?? ''),
      });
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
        // The server saves the partial replies and reports them. Only drop the connection if it can't be told to stop.
        const drop = () => setTimeout(() => controllers.get(conversationId)?.abort(), 1500);
        void api<{ stopped: boolean }>('/chat/stop', { method: 'POST', json: { runId } }).then(
          (result) => !result?.stopped && drop(),
          drop,
        );
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

/** A reply for a run that failed, keeping any text that had arrived. Uses the live reply's id so the saved copy can replace it later. */
function errorMessage(conversation: ChatRef, paneId: string, error: string, live?: LiveReply): Message {
  const pane = conversation.panes?.find((entry) => entry.id === paneId);
  return {
    id: live?.messageId ?? crypto.randomUUID(),
    conversationId: conversation.id,
    paneId,
    role: 'assistant',
    content: live?.text ?? '',
    reasoning: live?.reasoning || null,
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

function panesOf(messages: Message[]): Record<string, PaneRuntime> {
  const panes: Record<string, PaneRuntime> = {};
  for (const message of messages) {
    const pane = (panes[message.paneId] ??= { messages: [], live: null });
    pane.messages.push(message);
  }
  return panes;
}

export function allMessages(runtime: ConversationRuntime | undefined): Message[] {
  return Object.values(runtime?.panes ?? {}).flatMap((pane) => pane.messages);
}

export function messagesByPaneOf(runtime: ConversationRuntime | undefined): Record<string, Message[]> {
  return Object.fromEntries(Object.entries(runtime?.panes ?? {}).map(([paneId, pane]) => [paneId, pane.messages]));
}
