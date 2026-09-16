import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Tooltip from '@mui/material/Tooltip';
import { forwardRef, useState, type ReactNode } from 'react';
import { useSettings } from '../../api/hooks.ts';

export interface ComposerProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  /** Rendered under the text field, left of the send button: target chips, toggles. */
  footer?: ReactNode;
  autoFocus?: boolean;
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { onSend, onStop, running, disabled, disabledReason, placeholder, footer, autoFocus },
  ref,
) {
  const settings = useSettings();
  const sendOnEnter = settings.data?.general.sendOnEnter ?? true;
  const [text, setText] = useState('');
  const canSend = text.trim().length > 0 && !disabled && !running;

  function submit(): void {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
  }

  const sendHint = sendOnEnter ? 'Enter to send, Shift+Enter for a new line' : 'Ctrl+Enter to send';

  return (
    <Box
      sx={{
        border: '1px solid var(--sb-border-strong)',
        borderRadius: '16px',
        backgroundColor: 'var(--sb-raised)',
        boxShadow: '0 1px 0 rgba(16, 20, 32, 0.03), 0 8px 24px -16px rgba(16, 20, 32, 0.25)',
        transition: 'border-color 120ms ease',
        '&:focus-within': { borderColor: 'var(--sb-ink)' },
      }}
    >
      <InputBase
        inputRef={ref}
        multiline
        fullWidth
        minRows={1}
        maxRows={12}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder ?? 'Ask anything'}
        onChange={(event) => setText(event.target.value)}
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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1.5, pr: 1, pb: 1, pt: 0.5, minHeight: 44 }}>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>{footer}</Box>
        {running ? (
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
        ) : (
          <Tooltip title={disabled && disabledReason ? disabledReason : sendHint}>
            <span>
              <IconButton
                aria-label="Send"
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
        )}
      </Box>
    </Box>
  );
});
