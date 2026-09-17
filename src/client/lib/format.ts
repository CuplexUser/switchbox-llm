import type { Conversation } from '../../shared/types.ts';

/** A whole number from a text field, kept within bounds; `fallback` when the text isn't a number. */
export function clampInt(value: string, min: number, max: number, fallback: number): number {
  const parsed = Math.round(Number(value));
  return value.trim() !== '' && Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

export function formatTokens(count: number | null | undefined): string | null {
  if (count === null || count === undefined) return null;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 1 : 2)}M`;
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k` : String(count);
}

export function formatMs(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s` : `${ms}ms`;
}

export function formatCost(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined) return null;
  if (usd === 0) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;
}

/** Dollar amounts for totals: cents, or four places when under a cent. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPrice(perMillion: number): string {
  if (perMillion === 0) return 'free';
  return perMillion < 1 ? `$${perMillion.toFixed(2)}` : `$${perMillion.toFixed(perMillion < 10 ? 2 : 0)}`;
}

export function formatContext(tokens: number | undefined): string | null {
  if (!tokens) return null;
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}k`;
}

export function tokensPerSecond(tokens: number | null, latencyMs: number | null, ttftMs: number | null): string | null {
  if (!tokens || !latencyMs) return null;
  const generationMs = latencyMs - (ttftMs ?? 0);
  if (generationMs <= 0) return null;
  return `${Math.round((tokens / generationMs) * 1000)} tok/s`;
}

/** Short model label: drops the vendor prefix OpenRouter puts on ids. */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
}

export type ConversationGroup = { label: string; items: Conversation[] };

export function groupConversations(conversations: Conversation[], now = new Date()): ConversationGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const groups: ConversationGroup[] = [
    { label: 'Pinned', items: [] },
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Previous 30 days', items: [] },
    { label: 'Older', items: [] },
  ];
  for (const conversation of conversations) {
    const time = new Date(conversation.updatedAt).getTime();
    const index = conversation.pinned
      ? 0
      : time >= startOfToday
        ? 1
        : time >= startOfToday - day
          ? 2
          : time >= startOfToday - 7 * day
            ? 3
            : time >= startOfToday - 30 * day
              ? 4
              : 5;
    groups[index]?.items.push(conversation);
  }
  return groups.filter((group) => group.items.length > 0);
}
