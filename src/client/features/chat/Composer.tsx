import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Tooltip from '@mui/material/Tooltip';
import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AttachmentKind, AttachmentRef } from '../../../shared/types.ts';
import { useSettings, useUploadAttachment } from '../../api/hooks.ts';
import { AttachmentChips, type ChipItem } from './AttachmentChips.tsx';

export interface ComposerProps {
  onSend: (text: string, attachments: AttachmentRef[]) => void;
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  /** Rendered under the text field, left of the send button: target chips, toggles. */
  footer?: ReactNode;
  autoFocus?: boolean;
}

interface Upload extends ChipItem {
  ref: AttachmentRef | null;
}

const MAX_FILES = 10;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.yaml,.yml,.toml,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.kt,.c,.cpp,.h,.cs,.php,.sql,.sh,.ps1,.xml,.html,.css,.log';

function guessKind(file: File): AttachmentKind | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  return 'text';
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { onSend, onStop, running, disabled, disabledReason, placeholder, footer, autoFocus },
  ref,
) {
  const settings = useSettings();
  const upload = useUploadAttachment();
  const sendOnEnter = settings.data?.general.sendOnEnter ?? true;
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const previews = useRef(new Set<string>());

  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const uploading = uploads.some((item) => item.uploading);
  const ready = uploads.filter((item) => item.ref).map((item) => item.ref as AttachmentRef);
  // Sending while running queues the message instead of blocking it, so !running is not part of this.
  const canSend = (text.trim().length > 0 || ready.length > 0) && !uploading && !disabled;

  function addFiles(files: File[]): void {
    const room = MAX_FILES - uploads.length;
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (previewUrl) previews.current.add(previewUrl);
      setUploads((current) => [...current, { key, name: file.name, size: file.size, kind: guessKind(file), previewUrl, uploading: true, ref: null }]);
      upload.mutate(file, {
        onSuccess: (attachment) =>
          setUploads((current) =>
            current.map((item) => (item.key === key ? { ...item, id: attachment.id, kind: attachment.kind, uploading: false, ref: attachment } : item)),
          ),
        onError: (error) =>
          setUploads((current) => current.map((item) => (item.key === key ? { ...item, uploading: false, error: error.message } : item))),
      });
    }
  }

  function remove(key: string): void {
    setUploads((current) => {
      const item = current.find((entry) => entry.key === key);
      if (item?.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
        previews.current.delete(item.previewUrl);
      }
      return current.filter((entry) => entry.key !== key);
    });
  }

  function submit(): void {
    if (!canSend) return;
    onSend(text.trim(), ready);
    setText('');
    for (const item of uploads) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    previews.current.clear();
    setUploads([]);
  }

  const sendHint = sendOnEnter ? 'Enter to send, Shift+Enter for a new line' : 'Ctrl+Enter to send';

  return (
    <Box
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setDragging(false);
        addFiles([...event.dataTransfer.files]);
      }}
      sx={{
        border: '1px solid',
        borderColor: dragging ? 'var(--sb-ink)' : 'var(--sb-border-strong)',
        borderStyle: dragging ? 'dashed' : 'solid',
        borderRadius: '16px',
        backgroundColor: 'var(--sb-raised)',
        boxShadow: '0 1px 0 rgba(16, 20, 32, 0.03), 0 8px 24px -16px rgba(16, 20, 32, 0.25)',
        transition: 'border-color 120ms ease',
        '&:focus-within': { borderColor: 'var(--sb-ink)' },
      }}
    >
      {uploads.length > 0 && (
        <Box sx={{ px: 1.5, pt: 1.25 }}>
          <AttachmentChips items={uploads} onRemove={remove} />
        </Box>
      )}
      <InputBase
        inputRef={ref}
        multiline
        fullWidth
        minRows={1}
        maxRows={12}
        autoFocus={autoFocus}
        value={text}
        placeholder={dragging ? 'Drop files to attach them' : (placeholder ?? 'Ask anything')}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          addFiles(files);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && running) {
            event.preventDefault();
            onStop?.();
            return;
          }
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          const mod = event.ctrlKey || event.metaKey;
          if (mod || (sendOnEnter && !event.shiftKey)) {
            event.preventDefault();
            submit();
          }
        }}
        inputProps={{ 'aria-label': 'Message', 'aria-description': sendHint }}
        sx={{ px: 2, pt: 1.5, pb: 0.5, fontSize: '0.9375rem', lineHeight: 1.55 }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1, pr: 1, pb: 1, pt: 0.5, minHeight: 44 }}>
        <Tooltip title="Attach images, PDFs or text files">
          <span>
            <IconButton
              aria-label="Attach files"
              onClick={() => fileInput.current?.click()}
              disabled={uploads.length >= MAX_FILES}
              sx={{ width: 32, height: 32, color: 'var(--sb-text-muted)' }}
            >
              <AttachFileRoundedIcon sx={{ fontSize: 19, transform: 'rotate(45deg)' }} />
            </IconButton>
          </span>
        </Tooltip>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>{footer}</Box>
        {running && (
          <Tooltip title="Stop all (Esc)">
            <IconButton
              aria-label="Stop all replies"
              onClick={onStop}
              sx={{
                width: 34,
                height: 34,
                borderRadius: '10px',
                color: 'var(--sb-surface)',
                backgroundColor: 'var(--sb-text)',
                '&:hover': { backgroundColor: 'var(--sb-text)', color: 'var(--sb-surface)', opacity: 0.85 },
              }}
            >
              <StopRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip
          title={
            disabled && disabledReason
              ? disabledReason
              : uploading
                ? 'Waiting for files to upload'
                : running
                  ? 'Send — added once the current reply finishes'
                  : sendHint
          }
        >
          <span>
            <IconButton
              aria-label={running ? 'Queue message' : 'Send'}
              onClick={submit}
              disabled={!canSend}
              sx={{
                width: 34,
                height: 34,
                borderRadius: '10px',
                color: 'primary.contrastText',
                backgroundColor: 'var(--sb-ink)',
                '&:hover': { backgroundColor: 'var(--sb-ink)', color: 'primary.contrastText', opacity: 0.88 },
                '&.Mui-disabled': { backgroundColor: 'var(--sb-sunken)', color: 'var(--sb-text-faint)' },
              }}
            >
              <ArrowUpwardRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
    </Box>
  );
});
