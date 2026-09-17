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
import { PROVIDER_LABELS, type ProviderId, type UsageRange, type UsageReport } from '../../../shared/types.ts';
import { useUsage } from '../../api/hooks.ts';
import { UsageChart } from './UsageChart.tsx';
import { ModelList, ModelTable } from './UsageModels.tsx';
import { UsageStats } from './UsageStats.tsx';
import { RANGES } from './usageFormat.ts';

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
      <UsageStats totals={report.totals} compact={compact} />
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
