import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { PROVIDER_LABELS, type ResolvedSearch } from '../../../shared/types.ts';
import { usePanePreview } from '../../api/hooks.ts';
import { fonts } from '../../theme/theme.ts';

const SEARCH_LABELS: Record<ResolvedSearch, string> = {
  tavily: 'Tavily',
  brave: 'Brave',
  native: 'Provider built-in',
  none: 'Off',
};

export function PromptPreviewDialog({ paneId, onClose }: { paneId: string | null; onClose: () => void }) {
  const preview = usePanePreview(paneId);
  const data = preview.data;

  const params = data
    ? [
        ['Temperature', data.params.temperature],
        ['Top P', data.params.topP],
        ['Max tokens', data.params.maxTokens],
      ]
    : [];

  return (
    <Dialog open={Boolean(paneId)} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Assembled prompt</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {preview.isLoading && <Skeleton variant="rounded" height={160} />}
        {preview.error && <Typography color="error">{preview.error.message}</Typography>}
        {data && (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              <Stat label="Model" value={`${data.model} on ${PROVIDER_LABELS[data.provider]}`} />
              <Stat label="Memories included" value={String(data.memoryCount)} />
              <Stat label="Web search" value={SEARCH_LABELS[data.search]} />
              <Stat label="Tools" value={data.tools.length ? data.tools.join(', ') : 'None'} />
              {params.map(([label, value]) => (
                <Stat key={label} label={String(label)} value={value === null ? 'Provider default' : String(value)} />
              ))}
            </Box>
            {data.searchNote && (
              <Typography variant="body2" sx={{ color: 'warning.main' }}>
                {data.searchNote}
              </Typography>
            )}
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                System prompt sent with every message
              </Typography>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 2,
                  maxHeight: 420,
                  overflow: 'auto',
                  borderRadius: '8px',
                  border: '1px solid var(--sb-border)',
                  backgroundColor: 'var(--sb-sunken)',
                  fontFamily: fonts.mono,
                  fontVariantLigatures: 'none',
                  fontSize: '0.8125rem',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  color: data.system ? 'var(--sb-text)' : 'var(--sb-text-faint)',
                }}
              >
                {data.system || 'No system prompt. The model only sees the conversation.'}
              </Box>
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 550 }}>
        {value}
      </Typography>
    </Box>
  );
}
