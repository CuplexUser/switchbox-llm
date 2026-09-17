import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { PROVIDER_LABELS, type UsageModelRow } from '../../../shared/types.ts';
import { ProviderMark } from '../../components/ProviderMark.tsx';
import { formatMs, formatTokens } from '../../lib/format.ts';
import { modelCost, plural, speed } from './usageFormat.ts';

/** Rows shown on narrow screens before "Show more". */
const COMPACT_ROWS = 5;

const TABLE_COLUMNS = 'minmax(0, 2.6fr) repeat(7, minmax(0, 1fr))';

/** Usage by model as a table, for wide screens. */
export function ModelTable({ rows }: { rows: UsageModelRow[] }) {
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

/** Usage by model as a list of cards, for narrow screens. */
export function ModelList({ rows }: { rows: UsageModelRow[] }) {
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
