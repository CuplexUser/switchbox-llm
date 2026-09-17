import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { Memory, MemoryAction, MemoryActor, MemoryHistoryEntry } from '../../../shared/types.ts';
import { useMemoryHistory } from '../../api/hooks.ts';
import { diffWords } from '../../lib/diff.ts';

const ACTIONS: Record<MemoryAction, string> = {
  created: 'Added',
  updated: 'Changed',
  forgotten: 'Forgotten',
  restored: 'Restored',
  dismissed: 'Dismissed',
  kept: 'Kept',
};

const ACTORS: Record<MemoryActor, string> = {
  user: 'by you',
  model: 'by a model',
  suggestion: 'as a suggestion',
};

function Change({ entry }: { entry: MemoryHistoryEntry }) {
  if (entry.previousContent === null) {
    return <Typography variant="body2">{entry.content}</Typography>;
  }
  return (
    <Typography
      variant="body2"
      component="div"
      aria-label={`Changed from “${entry.previousContent}” to “${entry.content}”`}
      sx={{
        '& del': { color: 'error.main' },
        '& ins': { color: 'success.main', textDecoration: 'none', fontWeight: 550 },
        '& del + ins': { ml: '0.3em' },
      }}
    >
      {diffWords(entry.previousContent, entry.content).map((part, index) =>
        part.kind === 'same' ? (
          <span key={index}>{part.text}</span>
        ) : part.kind === 'removed' ? (
          <del key={index}>{part.text}</del>
        ) : (
          <ins key={index}>{part.text}</ins>
        ),
      )}
    </Typography>
  );
}

export function MemoryHistoryDialog({ memory, onClose }: { memory: Memory | null; onClose: () => void }) {
  const history = useMemoryHistory(memory?.id ?? null);
  const entries = history.data ?? [];

  return (
    <Dialog open={Boolean(memory)} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Memory history</DialogTitle>
      <DialogContent>
        {history.isLoading && <Skeleton variant="rounded" height={120} />}
        {history.error && <Typography color="error">{history.error.message}</Typography>}
        {history.isSuccess && entries.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No changes recorded. History started with this version of Switchbox, so older memories begin empty.
          </Typography>
        )}
        <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {entries.map((entry) => (
            <Box
              component="li"
              key={entry.id}
              sx={{ py: 1.25, borderBottom: '1px solid var(--sb-border)', '&:last-child': { borderBottom: 'none' } }}
            >
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', mb: 0.25 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {ACTIONS[entry.action]} {ACTORS[entry.actor]}
                </Typography>
                <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
                  {new Date(entry.createdAt).toLocaleString()}
                </Typography>
              </Box>
              <Change entry={entry} />
            </Box>
          ))}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
