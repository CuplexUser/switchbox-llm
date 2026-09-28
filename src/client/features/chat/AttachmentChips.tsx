import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import GraphicEqRoundedIcon from '@mui/icons-material/GraphicEqRounded';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import type { AttachmentKind, AttachmentRef } from '../../../shared/types.ts';
import {
  attachmentUrl,
  audioLabel,
  convertImage,
  downloadBlob,
  formatBytes,
  IMAGE_FORMAT_LABELS,
  renameForFormat,
  withExtension,
  type ImageFormat,
} from '../../lib/files.ts';
import { AUDIO_SAVE_OPTIONS, audioSaveFormatOf, convertAudio, type AudioSaveOption } from '../../lib/audio.ts';

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
  const Icon = item.error
    ? ErrorOutlineRoundedIcon
    : item.kind === 'pdf'
      ? PictureAsPdfOutlinedIcon
      : item.kind === 'audio'
        ? GraphicEqRoundedIcon
        : DescriptionOutlinedIcon;
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

/** Images a model generated, shown at a real viewing size rather than as a small chip. */
export function GeneratedImages({ attachments }: { attachments: AttachmentRef[] }) {
  const images = attachments.filter((ref) => ref.kind === 'image');
  if (images.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1.25 }}>
      {images.map((ref) => (
        <GeneratedImage key={ref.id} image={ref} />
      ))}
    </Box>
  );
}

const SAVE_FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp'];

type Status = { text: string; error: boolean } | null;

/**
 * A save or copy menu's state: where it's anchored, and a short-lived note on how the last action
 * went. `run` closes the menu, then reports the action's message or error.
 */
function useSaveMenu() {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  async function run(action: () => Promise<string | null>): Promise<void> {
    setMenuAnchor(null);
    try {
      const done = await action();
      if (done) setStatus({ text: done, error: false });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  }

  return { menuAnchor, setMenuAnchor, status, run };
}

function StatusNote({ status, width }: { status: Status; width: number }) {
  if (!status) return null;
  return (
    <Typography variant="caption" component="div" role="status" sx={{ mt: 0.5, maxWidth: width, color: status.error ? 'error.main' : 'var(--sb-text-faint)' }}>
      {status.text}
    </Typography>
  );
}

function GeneratedImage({ image }: { image: AttachmentRef }) {
  const { menuAnchor, setMenuAnchor, status, run } = useSaveMenu();
  const url = attachmentUrl(image.id);
  const original = SAVE_FORMATS.find((format) => image.mimeType === `image/${format}`);

  const saveAs = (format: ImageFormat) =>
    run(async () => {
      downloadBlob(renameForFormat(image.name, format), await convertImage(url, format));
      return null;
    });

  const copy = () =>
    run(async () => {
      // Clipboards reliably take PNG only, so anything else is converted first.
      const blob = image.mimeType === 'image/png' ? await (await fetch(url)).blob() : await convertImage(url, 'png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'Copied to the clipboard';
    });

  return (
    <Box sx={{ position: 'relative', '&:hover .sb-save, &:focus-within .sb-save': { opacity: 1 } }}>
      <Box component="a" href={url} target="_blank" rel="noreferrer" sx={{ display: 'block', lineHeight: 0 }}>
        <Box
          component="img"
          src={url}
          alt={image.name}
          sx={{ maxWidth: 320, maxHeight: 320, width: 'auto', height: 'auto', borderRadius: '10px', border: '1px solid var(--sb-border)' }}
        />
      </Box>
      <Tooltip title="Save or copy">
        <IconButton
          className="sb-save"
          aria-label={`Save or copy ${image.name}`}
          aria-haspopup="menu"
          size="small"
          onClick={(event) => setMenuAnchor(event.currentTarget)}
          sx={{
            position: 'absolute',
            top: 6,
            right: 6,
            opacity: menuAnchor ? 1 : { xs: 1, md: 0 },
            transition: 'opacity 120ms ease',
            backgroundColor: 'var(--sb-surface)',
            border: '1px solid var(--sb-border)',
            '&:hover': { backgroundColor: 'var(--sb-surface)' },
          }}
        >
          <DownloadRoundedIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        <MenuItem component="a" href={url} download={image.name} onClick={() => setMenuAnchor(null)}>
          <ListItemIcon>
            <DownloadRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Save original" secondary={`${image.mimeType.replace('image/', '').toUpperCase()} · ${formatBytes(image.size)}`} />
        </MenuItem>
        <Divider />
        {SAVE_FORMATS.filter((format) => format !== original).map((format) => (
          <MenuItem key={format} onClick={() => void saveAs(format)}>
            <ListItemIcon>
              <ImageOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={`Save as ${IMAGE_FORMAT_LABELS[format]}`} />
          </MenuItem>
        ))}
        <Divider />
        <MenuItem onClick={() => void copy()}>
          <ListItemIcon>
            <ContentCopyRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Copy image" />
        </MenuItem>
      </Menu>
      <StatusNote status={status} width={320} />
    </Box>
  );
}

/** Speech a model generated, as a player with a save menu. */
export function GeneratedAudio({ attachments }: { attachments: AttachmentRef[] }) {
  const clips = attachments.filter((ref) => ref.kind === 'audio');
  if (clips.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 1.25 }}>
      {clips.map((ref) => (
        <GeneratedClip key={ref.id} clip={ref} />
      ))}
    </Box>
  );
}

function GeneratedClip({ clip }: { clip: AttachmentRef }) {
  const { menuAnchor, setMenuAnchor, status, run } = useSaveMenu();
  const [converting, setConverting] = useState<string | null>(null);
  const url = attachmentUrl(clip.id);
  const original = audioSaveFormatOf(clip.mimeType);

  const saveAs = (option: AudioSaveOption) =>
    run(async () => {
      setConverting(option.label);
      try {
        downloadBlob(withExtension(clip.name, option.extension), await convertAudio(url, option.format));
      } finally {
        setConverting(null);
      }
      return null;
    });

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, maxWidth: 480 }}>
        <Box component="audio" controls preload="metadata" src={url} aria-label={clip.name} sx={{ flex: 1, minWidth: 0, height: 40 }} />
        <Tooltip title={converting ? `Saving as ${converting}…` : 'Save'}>
          <span>
            <IconButton
              aria-label={`Save ${clip.name}`}
              aria-haspopup="menu"
              size="small"
              disabled={Boolean(converting)}
              onClick={(event) => setMenuAnchor(event.currentTarget)}
            >
              {converting ? <CircularProgress size={16} /> : <DownloadRoundedIcon sx={{ fontSize: 18 }} />}
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        <MenuItem component="a" href={url} download={clip.name} onClick={() => setMenuAnchor(null)}>
          <ListItemIcon>
            <DownloadRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Save original" secondary={`${audioLabel(clip.mimeType)} · ${formatBytes(clip.size)}`} />
        </MenuItem>
        <Divider />
        {AUDIO_SAVE_OPTIONS.filter((option) => option.format !== original).map((option) => (
          <MenuItem key={option.format} onClick={() => void saveAs(option)}>
            <ListItemIcon>
              <GraphicEqRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={`Save as ${option.label}`} secondary={option.note} />
          </MenuItem>
        ))}
      </Menu>
      <StatusNote status={status} width={480} />
    </Box>
  );
}
