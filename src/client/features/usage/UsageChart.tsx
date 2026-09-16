import Box from '@mui/material/Box';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { UsageBucket, UsageMetric, UsageReport } from '../../../shared/types.ts';
import { formatTokens, formatUsd } from '../../lib/format.ts';

const METRICS: { value: UsageMetric; label: string }[] = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
  { value: 'replies', label: 'Replies' },
];

/** Gridlines above the baseline. */
const TICKS = 3;

function parseDay(key: string): Date {
  const [year = 0, month = 1, day = 1] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function shortDate(key: string): string {
  return parseDay(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function valueOf(bucket: UsageBucket, metric: UsageMetric): number {
  return metric === 'tokens' ? bucket.tokens : metric === 'cost' ? bucket.cost : bucket.replies;
}

function formatAxis(value: number, metric: UsageMetric): string {
  if (value === 0) return metric === 'cost' ? '$0' : '0';
  if (metric === 'tokens') return formatTokens(value) ?? '0';
  if (metric === 'cost') return value < 1 ? `$${value.toFixed(2)}` : `$${Math.round(value)}`;
  return value.toLocaleString();
}

/** Rounds a tick step up to 1, 2, 2.5 or 5 times a power of ten, so the axis reads cleanly. */
export function niceStep(max: number, ticks: number, whole: boolean): number {
  const raw = max / ticks;
  if (raw <= 0) return whole ? 1 : 0.01;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
  return whole ? Math.max(1, Math.ceil(step)) : step;
}

/** Evenly spaced bucket indexes for the date axis, always including the first and last. */
function labelIndexes(count: number, wanted: number): number[] {
  if (count <= wanted) return [...Array(count).keys()];
  return [...new Set(Array.from({ length: wanted }, (_, index) => Math.round((index * (count - 1)) / (wanted - 1))))];
}

export function UsageChart({ report, compact }: { report: UsageReport; compact: boolean }) {
  const [metric, setMetric] = useState<UsageMetric>('tokens');
  const { buckets, bucket } = report;
  const values = buckets.map((entry) => valueOf(entry, metric));
  const step = niceStep(Math.max(...values, 0), TICKS, metric !== 'cost');
  const top = step * TICKS;
  const period = bucket === 'week' ? 'week' : 'day';
  const labels = labelIndexes(buckets.length, compact ? 3 : 5);
  const height = compact ? 150 : 220;
  const peak = values.indexOf(Math.max(...values));
  const first = buckets[0];
  const last = buckets.at(-1);
  const span = first && last ? `${shortDate(first.date)} – ${shortDate(last.date)}` : '';
  const title = `${METRICS.find((entry) => entry.value === metric)?.label} per ${period}`;
  const summary =
    peak >= 0 && buckets[peak] && values[peak]
      ? `${title}, ${span}. Highest: ${formatAxis(values[peak], metric)} on ${shortDate(buckets[peak].date)}.`
      : `${title}, ${span}. Nothing recorded.`;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        px: compact ? 1.75 : 2.5,
        pt: compact ? 1.5 : 2.25,
        pb: 2,
        border: '1px solid var(--sb-border)',
        borderRadius: '10px',
        backgroundColor: 'var(--sb-surface)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box>
          <Typography variant="h4" component="h2">
            {title}
          </Typography>
          {!compact && (
            <Typography variant="body2" color="text.secondary">
              {metric === 'tokens' ? `Input and output combined, ${span}` : span}
            </Typography>
          )}
        </Box>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={metric}
          onChange={(_event, value: UsageMetric | null) => value && setMetric(value)}
          aria-label="Chart shows"
          sx={compact ? { '& .MuiToggleButton-root': { minHeight: 44 } } : undefined}
        >
          {METRICS.map((entry) => (
            <ToggleButton key={entry.value} value={entry.value}>
              {entry.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      <Box role="img" aria-label={summary} sx={{ display: 'flex', gap: 1.25 }}>
        <Box
          aria-hidden
          sx={{
            position: 'relative',
            width: compact ? 34 : 40,
            flexShrink: 0,
            height,
            fontSize: '0.6875rem',
            color: 'var(--sb-text-faint)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {Array.from({ length: TICKS + 1 }, (_, index) => (
            <Box
              key={index}
              sx={{ position: 'absolute', right: 0, bottom: `${(index / TICKS) * 100}%`, transform: 'translateY(50%)', lineHeight: 1 }}
            >
              {formatAxis(step * index, metric)}
            </Box>
          ))}
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Box sx={{ position: 'relative', height }}>
            {Array.from({ length: TICKS + 1 }, (_, index) => (
              <Box
                key={index}
                aria-hidden
                sx={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: `${(index / TICKS) * 100}%`,
                  borderTop: index === 0 ? '1px solid var(--sb-border-strong)' : '1px dashed var(--sb-border)',
                }}
              />
            ))}
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'stretch',
                gap: buckets.length > 60 ? '2px' : compact ? '3px' : '6px',
              }}
            >
              {buckets.map((entry, index) => {
                const value = values[index] ?? 0;
                const tooltip = (
                  <>
                    <Box sx={{ fontWeight: 600 }}>
                      {bucket === 'week'
                        ? `Week of ${shortDate(entry.date)}`
                        : parseDay(entry.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                    </Box>
                    <Box sx={{ opacity: 0.8 }}>
                      {formatTokens(entry.tokens)} tokens · {formatUsd(entry.cost)}
                    </Box>
                    <Box sx={{ opacity: 0.8 }}>
                      {entry.replies.toLocaleString()} {entry.replies === 1 ? 'reply' : 'replies'}
                    </Box>
                  </>
                );
                return (
                  <Tooltip key={entry.date} title={tooltip} placement="top" enterDelay={0} followCursor={false}>
                    {/* The whole column is the hover target, so short bars are as easy to hit as tall ones. */}
                    <Box
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'flex-end',
                        cursor: 'default',
                        '&:hover > div': { backgroundColor: 'var(--sb-ink)' },
                      }}
                    >
                      <Box
                        sx={{
                          width: '100%',
                          height: `${top > 0 ? (value / top) * 100 : 0}%`,
                          minHeight: value > 0 ? 2 : 0,
                          borderRadius: buckets.length > 60 ? '2px 2px 0 0' : compact ? '3px 3px 0 0' : '4px 4px 0 0',
                          backgroundColor: 'color-mix(in srgb, var(--sb-ink) 55%, transparent)',
                          transition: 'background-color 100ms ease',
                        }}
                      />
                    </Box>
                  </Tooltip>
                );
              })}
            </Box>
          </Box>
          <Box aria-hidden sx={{ position: 'relative', height: 14, fontSize: '0.6875rem', color: 'var(--sb-text-faint)' }}>
            {labels.map((index) => {
              const entry = buckets[index];
              if (!entry) return null;
              const at = buckets.length === 1 ? 0.5 : (index + 0.5) / buckets.length;
              const align = index === 0 ? 'translateX(0)' : index === buckets.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)';
              return (
                <Box
                  key={entry.date}
                  sx={{
                    position: 'absolute',
                    left: index === 0 ? 0 : index === buckets.length - 1 ? '100%' : `${at * 100}%`,
                    transform: align,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {shortDate(entry.date)}
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
