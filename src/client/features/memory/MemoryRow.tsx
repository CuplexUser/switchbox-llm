import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import UndoRoundedIcon from '@mui/icons-material/UndoRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Switch from '@mui/material/Switch';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { Memory, SystemPrompt } from '../../../shared/types.ts';
import { useDeleteMemory, useUpdateMemory } from '../../api/hooks.ts';
import { ScopeButton } from './ScopeButton.tsx';

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

export function MemoryRow({
  memory,
  profiles,
  onShowHistory,
}: {
  memory: Memory;
  profiles: SystemPrompt[];
  onShowHistory: (memory: Memory) => void;
}) {
  const update = useUpdateMemory();
  const remove = useDeleteMemory();
  const status = memory.status;
  const history = (
    <Tooltip title="History">
      <IconButton size="small" aria-label="Memory history" onClick={() => onShowHistory(memory)} sx={{ mt: 0.5 }}>
        <HistoryRoundedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );

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
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
          <CategoryTag category={memory.category} />
          <ScopeButton value={memory.scope} profiles={profiles} onChange={(scope) => update.mutate({ id: memory.id, scope })} />
          <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
            {memory.source === 'suggested' ? 'Suggested' : memory.source === 'model' ? 'Saved by a model' : 'Added by you'},{' '}
            {new Date(memory.createdAt).toLocaleDateString()}
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
          {history}
          <Tooltip title="Forget. You can restore it from Forgotten.">
            <IconButton size="small" aria-label="Forget memory" onClick={() => update.mutate({ id: memory.id, status: 'forgotten' })} sx={{ mt: 0.5 }}>
              <DeleteOutlineRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
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

      {(status === 'rejected' || status === 'forgotten') && (
        <Box sx={{ display: 'flex', gap: 0.5, mt: 0.25 }}>
          {history}
          <Tooltip title={status === 'forgotten' ? 'Restore this memory' : 'Keep this memory after all'}>
            <IconButton size="small" aria-label="Restore memory" onClick={() => update.mutate({ id: memory.id, status: 'active' })}>
              <UndoRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete permanently, with its history">
            <IconButton size="small" aria-label="Delete permanently" onClick={() => remove.mutate(memory.id)}>
              <DeleteOutlineRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      )}
    </Box>
  );
}
