import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import UndoRoundedIcon from '@mui/icons-material/UndoRounded';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import type { Memory, MemoryStatus } from '../../../shared/types.ts';
import {
  useCreateMemory,
  useDeleteMemory,
  useMemories,
  useSettings,
  useUpdateMemory,
} from '../../api/hooks.ts';

function EditableContent({ memory }: { memory: Memory }) {
  const update = useUpdateMemory();
  const [value, setValue] = useState(memory.content);

  return (
    <InputBase
      multiline
      fullWidth
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        const next = value.trim();
        if (next && next !== memory.content) update.mutate({ id: memory.id, content: next });
        else setValue(memory.content);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          (event.target as HTMLTextAreaElement).blur();
        }
      }}
      inputProps={{ 'aria-label': 'Memory text' }}
      sx={{
        fontSize: '0.875rem',
        lineHeight: 1.5,
        px: 0.75,
        py: 0.5,
        ml: -0.75,
        borderRadius: '6px',
        '&:hover': { backgroundColor: 'action.hover' },
        '&.Mui-focused': { backgroundColor: 'var(--sb-canvas)', outline: '1px solid var(--sb-ink)' },
      }}
    />
  );
}

function CategoryTag({ category }: { category: string }) {
  return (
    <Typography
      variant="caption"
      sx={{
        px: 0.875,
        py: 0.25,
        borderRadius: '4px',
        border: '1px solid var(--sb-border)',
        color: 'var(--sb-text-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      {category}
    </Typography>
  );
}

function MemoryRow({ memory }: { memory: Memory }) {
  const update = useUpdateMemory();
  const remove = useDeleteMemory();
  const status = memory.status;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        px: 2,
        py: 1.25,
        borderBottom: '1px solid var(--sb-border)',
        '&:last-child': { borderBottom: 'none' },
        opacity: status === 'active' && !memory.enabled ? 0.55 : 1,
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <EditableContent key={memory.content} memory={memory} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
          <CategoryTag category={memory.category} />
          <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
            {memory.source === 'suggested' ? 'Suggested' : 'Added by you'}, {new Date(memory.createdAt).toLocaleDateString()}
          </Typography>
        </Box>
      </Box>

      {status === 'active' && (
        <>
          <Tooltip title={memory.enabled ? 'Used in chats. Click to pause.' : 'Paused. Click to use in chats.'}>
            <Switch
              checked={memory.enabled}
              onChange={(event) => update.mutate({ id: memory.id, enabled: event.target.checked })}
              slotProps={{ input: { 'aria-label': memory.enabled ? 'Pause memory' : 'Use memory' } }}
              sx={{ my: 0.5 }}
            />
          </Tooltip>
          <IconButton size="small" aria-label="Delete memory" onClick={() => remove.mutate(memory.id)} sx={{ mt: 0.5 }}>
            <DeleteOutlineRoundedIcon fontSize="small" />
          </IconButton>
        </>
      )}

      {status === 'pending' && (
        <Box sx={{ display: 'flex', gap: 0.75, mt: 0.25 }}>
          <Button
            size="small"
            variant="contained"
            startIcon={<CheckRoundedIcon />}
            onClick={() => update.mutate({ id: memory.id, status: 'active', enabled: true })}
          >
            Keep
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<CloseRoundedIcon />}
            onClick={() => update.mutate({ id: memory.id, status: 'rejected' })}
          >
            Dismiss
          </Button>
        </Box>
      )}

      {status === 'rejected' && (
        <Box sx={{ display: 'flex', gap: 0.5, mt: 0.25 }}>
          <Tooltip title="Keep this memory after all">
            <IconButton size="small" aria-label="Restore memory" onClick={() => update.mutate({ id: memory.id, status: 'active' })}>
              <UndoRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <IconButton size="small" aria-label="Delete permanently" onClick={() => remove.mutate(memory.id)}>
            <DeleteOutlineRoundedIcon fontSize="small" />
          </IconButton>
        </Box>
      )}
    </Box>
  );
}

function AddMemory({ categories }: { categories: string[] }) {
  const create = useCreateMemory();
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');

  function submit(): void {
    if (!content.trim()) return;
    create.mutate(
      { content: content.trim(), category: category.trim() || 'general' },
      {
        onSuccess: () => {
          setContent('');
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
        sx={{ width: { xs: 'calc(100% - 90px)', sm: 180 }, flexShrink: 0 }}
      />
      <Button type="submit" variant="contained" disabled={!content.trim() || create.isPending} sx={{ flexShrink: 0 }}>
        Add
      </Button>
    </Box>
  );
}

const TABS: { status: MemoryStatus; label: string }[] = [
  { status: 'active', label: 'Memories' },
  { status: 'pending', label: 'Suggestions' },
  { status: 'rejected', label: 'Dismissed' },
];

export function MemoryPage() {
  const memories = useMemories();
  const settings = useSettings();
  const [tab, setTab] = useState<MemoryStatus>('active');
  const [search, setSearch] = useState('');

  const all = useMemo(() => memories.data ?? [], [memories.data]);
  const counts = useMemo(() => {
    const result: Record<MemoryStatus, number> = { active: 0, pending: 0, rejected: 0 };
    for (const memory of all) result[memory.status]++;
    return result;
  }, [all]);
  const categories = useMemo(() => [...new Set(all.map((memory) => memory.category))].toSorted(), [all]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter(
      (memory) =>
        memory.status === tab &&
        (!term || memory.content.toLowerCase().includes(term) || memory.category.toLowerCase().includes(term)),
    );
  }, [all, tab, search]);

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
            ? ` Only the ${memorySettings.maxInjected} most recently updated are sent.`
            : ''}
        </Typography>

        <AddMemory categories={categories} />

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
                    : 'Dismissed suggestions show up here.'}
            </Typography>
          )}
          {visible.map((memory) => (
            <MemoryRow key={memory.id} memory={memory} />
          ))}
        </Box>
      </Box>
    </Box>
  );
}
