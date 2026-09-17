import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Skeleton from '@mui/material/Skeleton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import type { Memory, MemoryStatus, SystemPrompt } from '../../../shared/types.ts';
import { useCreateMemory, useMemories, usePrompts, useSettings, useSuggestionStatus } from '../../api/hooks.ts';
import { formatRelative } from '../../lib/format.ts';
import { MemoryHistoryDialog } from './MemoryHistoryDialog.tsx';
import { MemoryReview } from './MemoryReview.tsx';
import { MemoryRow } from './MemoryRow.tsx';
import { ScopeButton, scopeLabel } from './ScopeButton.tsx';

function AddMemory({ categories, profiles }: { categories: string[]; profiles: SystemPrompt[] }) {
  const create = useCreateMemory();
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [scope, setScope] = useState<string | null>(null);

  function submit(): void {
    if (!content.trim()) return;
    create.mutate(
      { content: content.trim(), category: category.trim() || 'general', scope },
      {
        onSuccess: () => {
          setContent('');
          // Back to every chat, so the next fact isn't limited to a profile by accident.
          setScope(null);
        },
      },
    );
  }

  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      sx={{ display: 'flex', gap: 1, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}
    >
      <TextField
        fullWidth
        placeholder="Something the models should know, e.g. I write TypeScript and prefer concise answers"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        slotProps={{ htmlInput: { 'aria-label': 'New memory' } }}
      />
      <Autocomplete
        freeSolo
        options={categories}
        inputValue={category}
        onInputChange={(_event, value) => setCategory(value)}
        renderInput={(params) => <TextField {...params} placeholder="Category" />}
        sx={{ width: { xs: 'calc(100% - 90px)', sm: 160 }, flexShrink: 0 }}
      />
      <ScopeButton value={scope} profiles={profiles} onChange={setScope} size="medium" />
      <Button type="submit" variant="contained" disabled={!content.trim() || create.isPending} sx={{ flexShrink: 0 }}>
        Add
      </Button>
    </Box>
  );
}

/** The last suggestion run failed; hidden again once a run succeeds or the user dismisses this error. */
function SuggestionFailure() {
  const status = useSuggestionStatus();
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const { lastError, lastErrorAt } = status.data ?? { lastError: null, lastErrorAt: null };
  if (!lastError || !lastErrorAt || dismissedAt === lastErrorAt) return null;

  return (
    <Alert
      severity="warning"
      variant="outlined"
      sx={{ mt: 2 }}
      action={
        // Alert drops its own close button when given an action, so both go here.
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Button component={RouterLink} to="/settings/memory" size="small" color="inherit" sx={{ whiteSpace: 'nowrap' }}>
            Settings
          </Button>
          <IconButton size="small" color="inherit" aria-label="Dismiss" onClick={() => setDismissedAt(lastErrorAt)}>
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </Box>
      }
    >
      Suggestions failed {formatRelative(lastErrorAt)}: {lastError}
    </Alert>
  );
}

const TABS: { status: MemoryStatus; label: string }[] = [
  { status: 'active', label: 'Memories' },
  { status: 'pending', label: 'Suggestions' },
  { status: 'rejected', label: 'Dismissed' },
  { status: 'forgotten', label: 'Forgotten' },
];

export function MemoryPage() {
  const memories = useMemories();
  const settings = useSettings();
  const prompts = usePrompts();
  const profiles = useMemo(() => prompts.data ?? [], [prompts.data]);
  const [tab, setTab] = useState<MemoryStatus>('active');
  const [historyOf, setHistoryOf] = useState<Memory | null>(null);
  const [search, setSearch] = useState('');

  const all = useMemo(() => memories.data ?? [], [memories.data]);
  const counts = useMemo(() => {
    const result: Record<MemoryStatus, number> = { active: 0, pending: 0, rejected: 0, forgotten: 0 };
    for (const memory of all) result[memory.status]++;
    return result;
  }, [all]);
  const categories = useMemo(() => [...new Set(all.map((memory) => memory.category))].toSorted(), [all]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter(
      (memory) =>
        memory.status === tab &&
        (!term ||
          memory.content.toLowerCase().includes(term) ||
          memory.category.toLowerCase().includes(term) ||
          scopeLabel(memory.scope, profiles).toLowerCase().includes(term)),
    );
  }, [all, tab, search, profiles]);

  const memorySettings = settings.data?.memory;
  const enabledCount = all.filter((memory) => memory.status === 'active' && memory.enabled).length;

  return (
    <Box sx={{ flex: 1, overflowY: 'auto' }}>
      <Box sx={{ maxWidth: 820, mx: 'auto', px: { xs: 2, md: 4 }, pt: { xs: 8, md: 6 }, pb: 6 }}>
        <Typography variant="h1" sx={{ mb: 0.75 }}>
          Memory
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3, maxWidth: 620 }}>
          Facts about you that get added to the system prompt in chats with memory turned on.
          {memorySettings && enabledCount > memorySettings.maxInjected
            ? ` Only the ${memorySettings.maxInjected} most related to each message are sent.`
            : ''}
        </Typography>

        <AddMemory categories={categories} profiles={profiles} />

        {memorySettings?.autoSuggest && <SuggestionFailure />}

        {memorySettings && !memorySettings.autoSuggest && (
          <Alert
            severity="info"
            variant="outlined"
            sx={{ mt: 2 }}
            action={
              <Button component={RouterLink} to="/settings/memory" size="small" color="inherit" sx={{ whiteSpace: 'nowrap' }}>
                Turn on
              </Button>
            }
          >
            Suggestions are off. When on, a model you pick reads each exchange and proposes new memories for you to review.
          </Alert>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 3, borderBottom: '1px solid var(--sb-border)', flexWrap: 'wrap' }}>
          <Tabs value={tab} onChange={(_event, value: MemoryStatus) => setTab(value)} sx={{ flex: 1 }}>
            {TABS.map((entry) => (
              <Tab
                key={entry.status}
                value={entry.status}
                label={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    {entry.label}
                    {counts[entry.status] > 0 && (
                      <Box
                        component="span"
                        sx={{
                          px: 0.75,
                          borderRadius: '8px',
                          fontSize: '0.6875rem',
                          fontWeight: 650,
                          lineHeight: '18px',
                          color: entry.status === 'pending' ? 'primary.contrastText' : 'var(--sb-text-muted)',
                          backgroundColor: entry.status === 'pending' ? 'var(--sb-ink)' : 'var(--sb-sunken)',
                        }}
                      >
                        {counts[entry.status]}
                      </Box>
                    )}
                  </Box>
                }
              />
            ))}
          </Tabs>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: 'var(--sb-text-faint)', pb: { xs: 1, sm: 0 } }}>
            <SearchRoundedIcon sx={{ fontSize: 17 }} />
            <InputBase
              placeholder="Filter"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              inputProps={{ 'aria-label': 'Filter memories' }}
              sx={{ fontSize: '0.8125rem', width: 140 }}
            />
          </Box>
        </Box>

        {tab === 'active' && <MemoryReview active={all.filter((memory) => memory.status === 'active')} />}

        <Box sx={{ mt: 2, border: '1px solid var(--sb-border)', borderRadius: '10px', backgroundColor: 'var(--sb-surface)' }}>
          {memories.isLoading &&
            Array.from({ length: 4 }, (_, index) => <Skeleton key={index} height={56} sx={{ mx: 2 }} />)}
          {memories.isSuccess && visible.length === 0 && (
            <Typography variant="body2" sx={{ p: 3, textAlign: 'center', color: 'var(--sb-text-faint)' }}>
              {search
                ? 'Nothing matches that filter.'
                : tab === 'active'
                  ? 'No memories yet. Add one above, or accept a suggestion.'
                  : tab === 'pending'
                    ? 'No suggestions waiting for review.'
                    : tab === 'forgotten'
                      ? 'Memories a model forgot show up here, so you can restore them.'
                      : 'Dismissed suggestions show up here.'}
            </Typography>
          )}
          {visible.map((memory) => (
            <MemoryRow key={memory.id} memory={memory} profiles={profiles} onShowHistory={setHistoryOf} />
          ))}
        </Box>
      </Box>
      <MemoryHistoryDialog memory={historyOf} onClose={() => setHistoryOf(null)} />
    </Box>
  );
}
