import type { CostKind, UsageModelRow, UsageRange, UsageTotals } from '../../../shared/types.ts';
import { formatUsd } from '../../lib/format.ts';

export const RANGES: { value: UsageRange; label: string; short: string }[] = [
  { value: '7d', label: '7 days', short: '7d' },
  { value: '30d', label: '30 days', short: '30d' },
  { value: '90d', label: '90 days', short: '90d' },
  { value: 'all', label: 'All time', short: 'All' },
];

const COST_LABELS: Record<CostKind, string> = {
  reported: 'reported',
  estimated: 'estimated',
  local: 'local',
  unknown: 'no price',
};

export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function modelCost(row: UsageModelRow): { value: string; note: string } {
  if (row.costKind === 'local') return { value: 'Free', note: COST_LABELS.local };
  if (row.costKind === 'unknown') return { value: '–', note: COST_LABELS.unknown };
  const value = `${row.costKind === 'estimated' ? '~' : ''}${formatUsd(row.cost)}`;
  return { value, note: row.unpricedReplies > 0 ? 'partly priced' : COST_LABELS[row.costKind] };
}

export function speed(totals: UsageTotals): string {
  return totals.medianTokensPerSecond === null ? '–' : `${totals.medianTokensPerSecond} tok/s`;
}

export function costDetail(totals: UsageTotals): string {
  const parts: string[] = [];
  if (totals.reportedCost > 0 && totals.estimatedCost > 0) {
    parts.push(`${formatUsd(totals.reportedCost)} reported · ~${formatUsd(totals.estimatedCost)} estimated`);
  } else if (totals.estimatedCost > 0) {
    parts.push('Estimated from list prices');
  } else if (totals.reportedCost > 0) {
    parts.push('Reported by OpenRouter');
  } else {
    parts.push('Nothing billed');
  }
  if (totals.unpricedReplies > 0) parts.push(`${plural(totals.unpricedReplies, 'reply', 'replies')} without a price`);
  return parts.join(' · ');
}
