import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { AttachmentKind } from '../../../shared/types.ts';
import { attachmentUrl, formatBytes } from '../../lib/files.ts';

export interface ChipItem {
  key: string;
  name: string;
  size: number;
  kind: AttachmentKind | null;
  /** A server id once uploaded, for the preview and the link. */
  id?: string;
  /** A local preview while uploading. */
  previewUrl?: string;
  uploading?: boolean;
  error?: string;
}

function Thumb({ item }: { item: ChipItem }) {
  const source = item.previewUrl ?? (item.id && item.kind === 'image' ? attachmentUrl(item.id) : null);
  if (source && item.kind !== 'pdf' && item.kind !== 'text') {
    return <Box component="img" src={source} alt="" sx={{ width: 28, height: 28, objectFit: 'cover', borderRadius: '4px', flexShrink: 0 }} />;
  }
  const Icon = item.error ? ErrorOutlineRoundedIcon : item.kind === 'pdf' ? PictureAsPdfOutlinedIcon : DescriptionOutlinedIcon;
  return <Icon sx={{ fontSize: 20, color: item.error ? 'error.main' : 'var(--sb-text-faint)', flexShrink: 0 }} />;
}

/** Files on a message, or waiting in the composer when `onRemove` is given. */
export function AttachmentChips({ items, onRemove }: { items: ChipItem[]; onRemove?: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
      {items.map((item) => {
        const chip = (
          <Box
            key={item.key}
            component={item.id && !onRemove ? 'a' : 'div'}
            href={item.id && !onRemove ? attachmentUrl(item.id) : undefined}
            target={item.id && !onRemove ? '_blank' : undefined}
            rel="noreferrer"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              maxWidth: 240,
              pl: 0.5,
              pr: onRemove ? 0.25 : 1,
              py: 0.5,
              borderRadius: '8px',
              border: '1px solid',
              borderColor: item.error ? 'error.main' : 'var(--sb-border)',
              backgroundColor: 'var(--sb-surface)',
              color: 'var(--sb-text)',
              textDecoration: 'none',
            }}
          >
            <Thumb item={item} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" noWrap component="div" sx={{ fontWeight: 550, lineHeight: 1.3 }}>
                {item.name}
              </Typography>
              <Typography variant="caption" noWrap component="div" sx={{ color: item.error ? 'error.main' : 'var(--sb-text-faint)', lineHeight: 1.2 }}>
                {item.error ? 'Upload failed' : item.uploading ? 'Uploading…' : formatBytes(item.size)}
              </Typography>
            </Box>
            {item.uploading && <CircularProgress size={14} sx={{ ml: 0.5 }} />}
            {onRemove && (
              <IconButton size="small" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.key)} sx={{ p: 0.25 }}>
                <CloseRoundedIcon sx={{ fontSize: 15 }} />
              </IconButton>
            )}
          </Box>
        );
        return item.error ? (
          <Tooltip key={item.key} title={item.error}>
            {chip}
          </Tooltip>
        ) : (
          chip
        );
      })}
    </Box>
  );
}
