import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import RuleRoundedIcon from '@mui/icons-material/RuleRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import type { Memory } from '../../../shared/types.ts';
import { useCheckConflicts, useMemoryDuplicates, useSettings, useUpdateMemory } from '../../api/hooks.ts';

interface Pair {
  first: Memory;
  second: Memory;
  note: string;
}

const IGNORED_KEY = 'sb-memory-ignored-pairs';

function pairKey(a: string, b: string): string {
  return [a, b].toSorted().join('|');
}

/** Pairs marked "keep both" in this browser, so they stop coming back. */
function loadIgnored(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(IGNORED_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveIgnored(ignored: Set<string>): void {
  try {
    localStorage.setItem(IGNORED_KEY, JSON.stringify([...ignored]));
  } catch {
    // Without storage, "keep both" lasts until the page reloads.
  }
}

/** Buttons that check active memories for near-duplicates and contradictions. */
export function MemoryReview({ active }: { active: Memory[] }) {
  const duplicates = useMemoryDuplicates();
  const conflicts = useCheckConflicts();
  const settings = useSettings();
  const [ignored, setIgnored] = useState(loadIgnored);
  const [open, setOpen] = useState<'duplicates' | 'conflicts' | null>(null);

  const byId = useMemo(() => new Map(active.map((memory) => [memory.id, memory])), [active]);
  // Pairs drop out once either memory is no longer active.
  const duplicatePairs = (duplicates.data ?? [])
    .filter((pair) => byId.has(pair.first.id) && byId.has(pair.second.id) && !ignored.has(pairKey(pair.first.id, pair.second.id)))
    .map((pair) => ({ first: byId.get(pair.first.id) as Memory, second: byId.get(pair.second.id) as Memory, note: `${Math.round(pair.similarity * 100)}% alike` }));
  const conflictPairs = (conflicts.data ?? [])
    .filter((pair) => byId.has(pair.firstId) && byId.has(pair.secondId) && !ignored.has(pairKey(pair.firstId, pair.secondId)))
    .map((pair) => ({ first: byId.get(pair.firstId) as Memory, second: byId.get(pair.secondId) as Memory, note: pair.reason }));

  function keepBoth(pair: Pair): void {
    const next = new Set(ignored).add(pairKey(pair.first.id, pair.second.id));
    setIgnored(next);
    saveIgnored(next);
  }

  if (active.length < 2) return null;
  const hasModel = Boolean(settings.data?.memory.suggestionModel);

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 2 }}>
        <Button
          size="small"
          variant="outlined"
          color={duplicatePairs.length > 0 ? 'warning' : 'inherit'}
          startIcon={<ContentCopyOutlinedIcon />}
          disabled={duplicatePairs.length === 0}
          onClick={() => setOpen('duplicates')}
        >
          {duplicates.isLoading ? 'Looking for duplicates…' : duplicatePairs.length > 0 ? `Possible duplicates (${duplicatePairs.length})` : 'No duplicates'}
        </Button>
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          startIcon={conflicts.isPending ? <CircularProgress size={14} color="inherit" /> : <RuleRoundedIcon />}
          disabled={conflicts.isPending || !hasModel}
          onClick={() => conflicts.mutate(undefined, { onSuccess: () => setOpen('conflicts') })}
        >
          {conflicts.isPending ? 'Checking…' : 'Check for conflicts'}
        </Button>
        {!hasModel && (
          <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
            Checking for conflicts uses the{' '}
            <Box component={RouterLink} to="/settings/memory" sx={{ color: 'inherit' }}>
              suggestion model
            </Box>
            .
          </Typography>
        )}
      </Box>
      {conflicts.error && (
        <Alert severity="error" variant="outlined" sx={{ mt: 1.5 }} onClose={() => conflicts.reset()}>
          Couldn’t check for conflicts: {conflicts.error.message}
        </Alert>
      )}

      <PairsDialog
        open={open === 'duplicates'}
        title="Possible duplicates"
        description="These memories say nearly the same thing. Keep one and the other moves to Forgotten, where you can restore it."
        empty="No duplicates left."
        pairs={duplicatePairs}
        onKeepBoth={keepBoth}
        onClose={() => setOpen(null)}
      />
      <PairsDialog
        open={open === 'conflicts'}
        title="Conflicting memories"
        description="The suggestion model thinks these memories contradict each other. Keep the one that is still true."
        empty="No conflicts found."
        pairs={conflictPairs}
        onKeepBoth={keepBoth}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

function PairsDialog({
  open,
  title,
  description,
  empty,
  pairs,
  onKeepBoth,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  empty: string;
  pairs: Pair[];
  onKeepBoth: (pair: Pair) => void;
  onClose: () => void;
}) {
  const update = useUpdateMemory();
  const forget = (memory: Memory) => update.mutate({ id: memory.id, status: 'forgotten' });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          {pairs.length === 0 ? empty : description}
        </Typography>
        {update.error && <Alert severity="error">{update.error.message}</Alert>}
        {pairs.map((pair) => (
          <Box
            key={pairKey(pair.first.id, pair.second.id)}
            sx={{ border: '1px solid var(--sb-border)', borderRadius: '10px', p: 1.5, backgroundColor: 'var(--sb-surface)' }}
          >
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
              {[
                [pair.first, pair.second],
                [pair.second, pair.first],
              ].map(([memory, other]) => (
                <Box
                  key={memory?.id}
                  sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1.25, borderRadius: '8px', backgroundColor: 'var(--sb-sunken)' }}
                >
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {memory?.content}
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                    <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
                      {memory?.category}, updated {memory ? new Date(memory.updatedAt).toLocaleDateString() : ''}
                    </Typography>
                    <Button size="small" variant="outlined" disabled={update.isPending} onClick={() => other && forget(other)}>
                      Keep this one
                    </Button>
                  </Box>
                </Box>
              ))}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'var(--sb-text-muted)' }}>
                {pair.note}
              </Typography>
              <Button size="small" color="inherit" onClick={() => onKeepBoth(pair)}>
                Keep both
              </Button>
            </Box>
          </Box>
        ))}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
