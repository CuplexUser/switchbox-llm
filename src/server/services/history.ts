import type { AttachmentRef, KeepToolResults, ProviderId } from '../../shared/types.ts';
import type { MessageRow } from '../db/schemas.ts';
import type { LoopAttachment, LoopMessage } from '../providers/types.ts';

/** Tool output kept in the saved trace. Longer results are cut when the reply is saved. */
export const TRACE_TOOL_CHARS = 20_000;
/** Tool output replayed into later turns when only a summary is kept. */
export const SUMMARY_TOOL_CHARS = 1_200;
/** A tool result the budget pass can shorten, and what it keeps. */
const SHORTEN_ABOVE = 2_000;
const KEEP_HEAD = 1_000;
const KEEP_TAIL = 400;

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters left out …]\n${text.slice(-tail)}`;
}

/**
 * Makes a saved trace safe to replay: a tool call with no recorded result (a reply stopped in the
 * middle of a tool) would be rejected by every provider, so such a step keeps its text only.
 */
export function sanitizeTrace(trace: LoopMessage[]): LoopMessage[] {
  const answered = new Set(trace.filter((message) => message.role === 'tool').map((message) => message.toolCallId));
  const out: LoopMessage[] = [];
  for (const message of trace) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const complete = message.toolCalls.every((call) => answered.has(call.id));
      if (!complete) {
        if (message.content) out.push({ role: 'assistant', content: message.content });
        continue;
      }
    }
    if (message.role === 'tool' && !out.some((entry) => entry.role === 'assistant' && entry.toolCalls?.some((call) => call.id === message.toolCallId))) {
      continue;
    }
    out.push(message);
  }
  return out;
}

/** What gets saved with a reply: the tool loop with long results cut down. */
export function traceForStorage(trace: LoopMessage[]): LoopMessage[] | null {
  if (!trace.some((message) => message.role === 'tool' || (message.role === 'assistant' && message.raw))) return null;
  return trace.map((message) => (message.role === 'tool' ? { ...message, content: clip(message.content, TRACE_TOOL_CHARS) } : message));
}

export interface HistoryOptions {
  provider: ProviderId;
  model: string;
  keepToolResults: KeepToolResults;
  /** File contents by attachment id. */
  attachments: Map<string, LoopAttachment>;
}

/**
 * Turns a pane's saved messages into provider history. Replies keep their tool calls and results
 * (in full or shortened) so later turns can refer to what was found. Provider-specific blocks are
 * only replayed to the same model that produced them.
 */
export function buildHistory(rows: MessageRow[], options: HistoryOptions): LoopMessage[] {
  const out: LoopMessage[] = [];
  for (const row of rows) {
    if (row.role === 'user') {
      const refs = (row.attachments as AttachmentRef[] | null) ?? [];
      const attachments = refs.map((ref) => options.attachments.get(ref.id)).filter((item): item is LoopAttachment => Boolean(item));
      if (!row.content.trim() && attachments.length === 0) continue;
      out.push(attachments.length > 0 ? { role: 'user', content: row.content, attachments } : { role: 'user', content: row.content });
      continue;
    }

    const trace = Array.isArray(row.trace) ? (row.trace as LoopMessage[]) : null;
    if (trace && options.keepToolResults !== 'off') {
      const sameModel = row.provider === options.provider && row.model === options.model;
      for (const message of sanitizeTrace(trace)) {
        if (message.role === 'assistant') {
          const { raw, ...rest } = message;
          out.push(sameModel && raw ? message : rest);
        } else if (message.role === 'tool' && options.keepToolResults === 'summary') {
          out.push({ ...message, content: clip(message.content, SUMMARY_TOOL_CHARS) });
        } else {
          out.push(message);
        }
      }
      continue;
    }
    // Errors and early stops leave empty replies that providers reject.
    if (row.content.trim()) out.push({ role: 'assistant', content: row.content });
  }
  return mergeAssistantTurns(out);
}

/** Two assistant messages in a row, without tool calls between them, become one. */
function mergeAssistantTurns(messages: LoopMessage[]): LoopMessage[] {
  const out: LoopMessage[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    if (
      message.role === 'assistant' &&
      previous?.role === 'assistant' &&
      !previous.toolCalls?.length &&
      !previous.raw &&
      !message.raw &&
      !message.toolCalls?.length
    ) {
      out[out.length - 1] = { role: 'assistant', content: [previous.content, message.content].filter(Boolean).join('\n\n') };
      continue;
    }
    out.push(message);
  }
  return out;
}

export function estimateTokens(message: LoopMessage): number {
  let chars = message.content.length;
  if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? []) chars += call.arguments.length + call.name.length;
    if (message.raw) chars = Math.max(chars, JSON.stringify(message.raw).length);
  }
  let tokens = Math.ceil(chars / 4);
  if (message.role === 'user') {
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === 'image') tokens += 1_600;
      else if (attachment.kind === 'pdf') tokens += Math.ceil(((attachment.data?.length ?? 0) * 0.75) / 20);
      else tokens += Math.ceil((attachment.text?.length ?? 0) / 4);
    }
  }
  return tokens + 4;
}

export interface BudgetResult {
  messages: LoopMessage[];
  shortened: number;
  dropped: number;
}

/**
 * Keeps a request under `budget` tokens by an estimate. First it shortens long tool results,
 * oldest first; then it drops whole earlier exchanges, from a user message up to the next one.
 * Messages from `protectFrom` on (the current exchange) are never dropped.
 */
export function fitToBudget(messages: LoopMessage[], budget: number, protectFrom: number): BudgetResult {
  let list = [...messages];
  let total = list.reduce((sum, message) => sum + estimateTokens(message), 0);
  let shortened = 0;
  let dropped = 0;
  let protectedIndex = protectFrom;

  for (let index = 0; index < list.length && total > budget; index++) {
    const message = list[index];
    if (message?.role !== 'tool' || message.content.length <= SHORTEN_ABOVE) continue;
    const before = estimateTokens(message);
    const content = `${message.content.slice(0, KEEP_HEAD)}\n[… shortened to fit the context window …]\n${message.content.slice(-KEEP_TAIL)}`;
    list[index] = { ...message, content };
    total -= before - estimateTokens(list[index] as LoopMessage);
    shortened++;
  }

  while (total > budget && protectedIndex > 0) {
    // One exchange: the first message and everything up to the next user message.
    let end = 1;
    while (end < protectedIndex && list[end]?.role !== 'user') end++;
    if (end > protectedIndex) break;
    const removed = list.slice(0, end);
    list = list.slice(end);
    protectedIndex -= end;
    total -= removed.reduce((sum, message) => sum + estimateTokens(message), 0);
    dropped += removed.filter((message) => message.role === 'user').length;
  }

  return { messages: list, shortened, dropped };
}
