import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  PROVIDER_LABELS,
  type CostKind,
  type ProviderId,
  type UsageModelRow,
  type UsageRange,
  type UsageReport,
  type UsageTotals,
} from '../../../shared/types.ts';
import { useUsage } from '../../api/hooks.ts';
import { ProviderMark } from '../../components/ProviderMark.tsx';
import { formatMs, formatTokens, formatUsd } from '../../lib/format.ts';
import { UsageChart } from './UsageChart.tsx';

const RANGES: { value: UsageRange; label: string; short: string }[] = [
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

/** Rows shown on narrow screens before "Show more". */
const COMPACT_ROWS = 5;

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function modelCost(row: UsageModelRow): { value: string; note: string } {
  if (row.costKind === 'local') return { value: 'Free', note: COST_LABELS.local };
  if (row.costKind === 'unknown') return { value: '–', note: COST_LABELS.unknown };
  const value = `${row.costKind === 'estimated' ? '~' : ''}${formatUsd(row.cost)}`;
  return { value, note: row.unpricedReplies > 0 ? 'partly priced' : COST_LABELS[row.costKind] };
}

function speed(totals: UsageTotals): string {
  return totals.medianTokensPerSecond === null ? '–' : `${totals.medianTokensPerSecond} tok/s`;
}

function costDetail(totals: UsageTotals): string {
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

function Stats({ totals, compact }: { totals: UsageTotals; compact: boolean }) {
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

const TABLE_COLUMNS = 'minmax(0, 2.6fr) repeat(7, minmax(0, 1fr))';

function ModelTable({ rows }: { rows: UsageModelRow[] }) {
  const headers = ['Replies', 'Input', 'Output', 'Cost', 'First token', 'Speed', 'Failed'];
  return (
    <Box role="table" aria-label="Usage by model" sx={{ border: '1px solid var(--sb-border)', borderRadius: '10px', backgroundColor: 'var(--sb-surface)' }}>
      <Box
        role="row"
        sx={{
          display: 'grid',
          gridTemplateColumns: TABLE_COLUMNS,
          gap: 1.5,
          px: 2,
          py: 1.25,
          borderBottom: '1px solid var(--sb-border)',
          fontSize: '0.75rem',
          fontWeight: 600,
          color: 'var(--sb-text-faint)',
        }}
      >
        <Box role="columnheader">Model</Box>
        {headers.map((header) => (
          <Box key={header} role="columnheader" sx={{ textAlign: 'right' }}>
            {header}
          </Box>
        ))}
      </Box>
      {rows.map((row) => {
        const cost = modelCost(row);
        return (
          <Box
            key={`${row.provider}:${row.model}`}
            role="row"
            sx={{
              display: 'grid',
              gridTemplateColumns: TABLE_COLUMNS,
              gap: 1.5,
              alignItems: 'center',
              px: 2,
              py: 1.25,
              fontSize: '0.8125rem',
              fontVariantNumeric: 'tabular-nums',
              '& + &': { borderTop: '1px solid var(--sb-border)' },
              '& > :not(:first-of-type)': { textAlign: 'right' },
            }}
          >
            <Box role="cell" sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
              <ProviderMark provider={row.provider} size={24} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" noWrap title={row.model} sx={{ fontWeight: 550 }}>
                  {row.model}
                </Typography>
                <Typography variant="caption" component="div" sx={{ color: 'var(--sb-text-faint)' }}>
                  {PROVIDER_LABELS[row.provider]}
                </Typography>
              </Box>
            </Box>
            <Box role="cell">{row.replies.toLocaleString()}</Box>
            <Box role="cell">{formatTokens(row.tokensIn)}</Box>
            <Box role="cell">{formatTokens(row.tokensOut)}</Box>
            <Box role="cell">
              <Box sx={{ fontWeight: 550 }}>{cost.value}</Box>
              <Box sx={{ fontSize: '0.6875rem', color: 'var(--sb-text-faint)' }}>{cost.note}</Box>
            </Box>
            <Box role="cell">{formatMs(row.medianTtftMs) ?? '–'}</Box>
            <Box role="cell">{speed(row)}</Box>
            <Box role="cell" sx={{ color: row.failed ? 'error.main' : 'var(--sb-text-faint)' }}>
              {row.failed ? row.failed.toLocaleString() : '–'}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function ModelList({ rows }: { rows: UsageModelRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, COMPACT_ROWS);
  const hidden = rows.length - visible.length;
  return (
    <>
      <Box sx={{ border: '1px solid var(--sb-border)', borderRadius: '10px', backgroundColor: 'var(--sb-surface)' }}>
        {visible.map((row) => {
          const cost = modelCost(row);
          return (
            <Box
              key={`${row.provider}:${row.model}`}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                px: 1.75,
                py: 1.5,
                fontVariantNumeric: 'tabular-nums',
                '& + &': { borderTop: '1px solid var(--sb-border)' },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                <ProviderMark provider={row.provider} size={24} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography noWrap sx={{ fontSize: '0.875rem', fontWeight: 550 }}>
                    {row.model}
                  </Typography>
                  <Typography variant="caption" component="div" sx={{ color: 'var(--sb-text-faint)' }}>
                    {PROVIDER_LABELS[row.provider]} · {plural(row.replies, 'reply', 'replies')}
                  </Typography>
                </Box>
                <Box sx={{ textAlign: 'right' }}>
                  <Typography sx={{ fontSize: '0.875rem', fontWeight: 600 }}>{cost.value}</Typography>
                  <Typography sx={{ fontSize: '0.6875rem', color: 'var(--sb-text-faint)' }}>{cost.note}</Typography>
                </Box>
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: 1,
                  pl: '34px',
                  fontSize: '0.75rem',
                  color: 'var(--sb-text-muted)',
                }}
              >
                <span>{formatTokens(row.tokensIn + row.tokensOut)} tokens</span>
                <span>{formatMs(row.medianTtftMs) ?? '–'} first</span>
                <span>{speed(row)}</span>
              </Box>
            </Box>
          );
        })}
      </Box>
      {hidden > 0 && (
        <Button onClick={() => setExpanded(true)} sx={{ minHeight: 44 }}>
          Show {plural(hidden, 'more model', 'more models')}
        </Button>
      )}
    </>
  );
}

function EmptyState({ range, filtered }: { range: UsageRange; filtered: boolean }) {
  const label = RANGES.find((entry) => entry.value === range)?.label.toLowerCase();
  const period = range === 'all' ? '' : ` in the last ${label}`;
  const title = filtered ? `No replies from this provider${period}` : period ? `No replies${period}` : 'No usage yet';
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1.75,
        px: 3,
        py: 8,
        textAlign: 'center',
        border: '1px solid var(--sb-border)',
        borderRadius: '10px',
        backgroundColor: 'var(--sb-surface)',
      }}
    >
      <Box aria-hidden sx={{ display: 'flex', alignItems: 'flex-end', gap: '6px', height: 40 }}>
        {[14, 26, 20, 38].map((height, index) => (
          <Box
            key={index}
            sx={{
              width: 10,
              height,
              borderRadius: '3px 3px 0 0',
              backgroundColor: index === 3 ? 'var(--sb-border)' : 'var(--sb-sunken)',
            }}
          />
        ))}
      </Box>
      <Box>
        <Typography variant="h4">{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 380, textWrap: 'pretty' }}>
          Send a message in a saved chat and its token counts, cost and speed will show up here.
        </Typography>
      </Box>
      <Button component={RouterLink} to="/" variant="contained">
        New chat
      </Button>
    </Box>
  );
}

function Report({ report, compact, wideTable }: { report: UsageReport; compact: boolean; wideTable: boolean }) {
  return (
    <>
      <Stats totals={report.totals} compact={compact} />
      <UsageChart report={report} compact={compact} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Typography variant="h4" component="h2">
            By model
          </Typography>
          <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
            Sorted by cost
          </Typography>
        </Box>
        {wideTable ? <ModelTable rows={report.models} /> : <ModelList rows={report.models} />}
        <Typography variant="caption" component="p" sx={{ m: 0, mt: 0.5, color: 'var(--sb-text-faint)', maxWidth: 760, lineHeight: 1.5, textWrap: 'pretty' }}>
          Token counts come from each provider’s reply. Reported cost is what OpenRouter charged. Estimated cost uses the
          model’s list price, so it can drift from your bill. Temporary chats aren’t recorded, and use of the same API keys
          outside Switchbox doesn’t show up here.
        </Typography>
      </Box>
    </>
  );
}

export function UsagePage() {
  const [range, setRange] = useState<UsageRange>('30d');
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const usage = useUsage(range, provider);
  const compact = !useMediaQuery('(min-width: 600px)');
  const wideTable = useMediaQuery('(min-width: 1180px)');
  const report = usage.data;

  // Keep the chosen provider in the menu even when the new range has none of its replies.
  const providers = report ? [...new Set([...report.providers, ...(provider ? [provider] : [])])] : [];

  return (
    <Box sx={{ flex: 1, overflowY: 'auto' }}>
      <Box
        sx={{
          maxWidth: 1040,
          mx: 'auto',
          px: { xs: 2, md: 4 },
          pt: { xs: 8, md: 6 },
          pb: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: { xs: 2.5, sm: 3 },
        }}
      >
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            alignItems: { xs: 'stretch', md: 'flex-end' },
            justifyContent: 'space-between',
            gap: { xs: 2, md: 3 },
          }}
        >
          <Box>
            <Typography variant="h1" sx={{ mb: 0.75 }}>
              Usage
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 620, textWrap: 'pretty' }}>
              Tokens, cost and speed from every reply in your saved chats
              {compact ? '.' : ', so you don’t have to check each provider’s dashboard.'}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1, flexShrink: 0 }}>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={range}
              onChange={(_event, value: UsageRange | null) => value && setRange(value)}
              aria-label="Time range"
              sx={compact ? { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', '& .MuiToggleButton-root': { minHeight: 44 } } : undefined}
            >
              {RANGES.map((entry) => (
                <ToggleButton key={entry.value} value={entry.value} aria-label={entry.label}>
                  {compact ? entry.short : entry.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Select
              value={provider ?? ''}
              displayEmpty
              onChange={(event) => setProvider((event.target.value as ProviderId) || null)}
              inputProps={{ 'aria-label': 'Provider' }}
              sx={{ minWidth: 160, fontSize: '0.8125rem', '& .MuiSelect-select': compact ? { py: 1.5 } : {} }}
            >
              <MenuItem value="">All providers</MenuItem>
              {providers.map((id) => (
                <MenuItem key={id} value={id}>
                  {PROVIDER_LABELS[id]}
                </MenuItem>
              ))}
            </Select>
          </Box>
        </Box>

        {usage.error && <Alert severity="error" variant="outlined">{usage.error.message}</Alert>}
        {usage.isLoading && (
          <>
            <Skeleton variant="rounded" height={108} />
            <Skeleton variant="rounded" height={320} />
            <Skeleton variant="rounded" height={260} />
          </>
        )}
        {report && report.totals.replies === 0 && <EmptyState range={range} filtered={provider !== null} />}
        {report && report.totals.replies > 0 && (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: { xs: 2.5, sm: 3 },
              opacity: usage.isPlaceholderData ? 0.6 : 1,
              transition: 'opacity 150ms ease',
            }}
          >
            <Report report={report} compact={compact} wideTable={wideTable} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
