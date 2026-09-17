import type { ConversationDetail, Message, Pane } from '../../shared/types.ts';

/** One exchange across panes: the message that started it and each pane's reply. */
export interface Turn {
  prompt: Message | null;
  replies: { pane: Pane; message: Message | null }[];
}

interface PaneTurn {
  prompt: Message;
  reply: Message | null;
}

function paneTurns(messages: Message[]): PaneTurn[] {
  const turns: PaneTurn[] = [];
  for (const message of messages) {
    if (message.role === 'user') turns.push({ prompt: message, reply: null });
    else {
      const last = turns.at(-1);
      if (last) last.reply = message;
    }
  }
  return turns;
}

/**
 * Lines panes up by exchange: the nth message from the user in each pane starts turn n, and each
 * pane's reply to it sits beside the others.
 */
export function turnsOf(conversation: ConversationDetail, messagesByPane: Record<string, Message[]>): Turn[] {
  const perPane = conversation.panes.map((pane) => ({ pane, turns: paneTurns(messagesByPane[pane.id] ?? []) }));
  const count = Math.max(0, ...perPane.map((entry) => entry.turns.length));
  return Array.from({ length: count }, (_, index) => ({
    prompt: perPane.map((entry) => entry.turns[index]?.prompt).find(Boolean) ?? null,
    replies: perPane.map((entry) => ({ pane: entry.pane, message: entry.turns[index]?.reply ?? null })),
  }));
}

/** Which exchange a message belongs to in its pane, counting from 0, or -1 when it isn't there. */
export function turnIndex(messages: Message[], messageId: string): number {
  let turn = -1;
  for (const message of messages) {
    if (message.role === 'user') turn++;
    if (message.id === messageId) return turn;
  }
  return -1;
}

/**
 * The same message from the user in every pane that has it: same exchange, same text. Keyed by pane
 * id, so an edit can rewrite it everywhere at once and keep the panes comparable.
 */
export function sameUserMessage(messagesByPane: Record<string, Message[]>, paneId: string, messageId: string): Record<string, string> {
  const source = messagesByPane[paneId] ?? [];
  const original = source.find((message) => message.id === messageId);
  const turn = turnIndex(source, messageId);
  if (!original || original.role !== 'user' || turn === -1) return {};
  const ids: Record<string, string> = {};
  for (const [id, messages] of Object.entries(messagesByPane)) {
    const match = paneTurns(messages)[turn]?.prompt;
    if (match && (id === paneId || match.content === original.content)) ids[id] = match.id;
  }
  return ids;
}

/** Replies to the same exchange in the other panes. */
export function siblingReplies(messagesByPane: Record<string, Message[]>, message: Message): Message[] {
  const turn = turnIndex(messagesByPane[message.paneId] ?? [], message.id);
  if (turn === -1) return [];
  return Object.entries(messagesByPane)
    .filter(([paneId]) => paneId !== message.paneId)
    .map(([, messages]) => paneTurns(messages)[turn]?.reply)
    .filter((reply): reply is Message => Boolean(reply));
}

export interface ReplyTotals {
  replies: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  /** Some replies have no price, so `cost` is a lower bound. */
  costPartial: boolean;
  /** The slowest reply, which is how long the whole exchange took. */
  wallMs: number | null;
}

export function totalsOf(messages: (Message | null)[]): ReplyTotals {
  const replies = messages.filter((message): message is Message => Boolean(message));
  const latencies = replies.map((message) => message.latencyMs).filter((value): value is number => value !== null);
  return {
    replies: replies.length,
    tokensIn: replies.reduce((sum, message) => sum + (message.tokensIn ?? 0), 0),
    tokensOut: replies.reduce((sum, message) => sum + (message.tokensOut ?? 0), 0),
    cost: replies.reduce((sum, message) => sum + (message.cost ?? 0), 0),
    costPartial: replies.some((message) => message.cost === null && !message.error),
    wallMs: latencies.length ? Math.max(...latencies) : null,
  };
}

/**
 * For each message from the user in `paneId`, how many panes an edit would rewrite, as
 * "messageId:count" pairs. A string, so a store selector can return it without re-rendering.
 */
export function editCountKey(messagesByPane: Record<string, Message[]>, paneId: string): string {
  const own = paneTurns(messagesByPane[paneId] ?? []);
  const others = Object.entries(messagesByPane)
    .filter(([id]) => id !== paneId)
    .map(([, messages]) => paneTurns(messages));
  return own
    .map((turn, index) => {
      const count = 1 + others.filter((turns) => turns[index]?.prompt.content === turn.prompt.content).length;
      return `${turn.prompt.id}:${count}`;
    })
    .join(',');
}
