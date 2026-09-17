import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { UsageTotals } from '../../../shared/types.ts';
import { formatMs, formatTokens, formatUsd } from '../../lib/format.ts';
import { costDetail, plural, speed } from './usageFormat.ts';

function StatTile({ label, value, detail, compact }: { label: string; value: string; detail: string; compact: boolean }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 0.25 : 0.5,
        px: compact ? 1.75 : 2.25,
        py: compact ? 1.75 : 2,
        minWidth: 0,
        border: '1px solid var(--sb-border)',
        borderRadius: '10px',
        backgroundColor: 'var(--sb-surface)',
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600, color: 'var(--sb-text-muted)' }}>
        {label}
      </Typography>
      <Typography
        sx={{ fontSize: compact ? '1.375rem' : '1.625rem', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.25 }}
      >
        {value}
      </Typography>
      <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
        {detail}
      </Typography>
    </Box>
  );
}

/** The four headline numbers: tokens, cost, replies and speed. */
export function UsageStats({ totals, compact }: { totals: UsageTotals; compact: boolean }) {
  const tiles = [
    {
      label: 'Tokens',
      value: formatTokens(totals.tokensIn + totals.tokensOut) ?? '0',
      detail: `${formatTokens(totals.tokensIn)} in · ${formatTokens(totals.tokensOut)} out`,
    },
    {
      label: 'Cost',
      value: formatUsd(totals.cost),
      detail: compact && totals.estimatedCost > 0 ? `~${formatUsd(totals.estimatedCost)} of it estimated` : costDetail(totals),
    },
    {
      label: 'Replies',
      value: totals.replies.toLocaleString(),
      detail: [compact ? null : `in ${plural(totals.chats, 'chat', 'chats')}`, totals.failed ? `${totals.failed} failed` : null]
        .filter(Boolean)
        .join(' · '),
    },
    {
      label: 'Typical speed',
      value: speed(totals),
      detail: totals.medianTtftMs === null ? 'No timing yet' : `${formatMs(totals.medianTtftMs)} to first token${compact ? '' : ' (median)'}`,
    },
  ];
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5 }}>
      {tiles.map((tile) => (
        <StatTile key={tile.label} {...tile} compact={compact} />
      ))}
    </Box>
  );
}
