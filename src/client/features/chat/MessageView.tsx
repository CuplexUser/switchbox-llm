import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded';
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { memo, useState } from 'react';
import type { ApprovalRequest, Message } from '../../../shared/types.ts';
import { Markdown } from '../../components/Markdown.tsx';
import { formatCost, formatMs, formatTokens, shortModel, tokensPerSecond } from '../../lib/format.ts';
import { useChatStore, type LiveReply, type QueuedSend } from '../../stores/chat.ts';
import { fonts } from '../../theme/theme.ts';
import { ActivityLog } from './ActivityLog.tsx';
import { AttachmentChips, GeneratedImages } from './AttachmentChips.tsx';

const FINISH_NOTES: Record<string, string> = {
  aborted: 'Stopped',
  length: 'Cut off at the token limit',
  max_tokens: 'Cut off at the token limit',
  content_filter: 'Blocked by the provider’s content filter',
  refusal: 'The model declined',
};

function EditBox({
  initial,
  paneCount,
  onCancel,
  onSubmit,
}: {
  initial: string;
  paneCount: number;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const changed = value.trim() !== '' && value !== initial;
  return (
    <Box sx={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <TextField
        autoFocus
        multiline
        minRows={2}
        maxRows={16}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && changed) onSubmit(value);
        }}
        slotProps={{ htmlInput: { 'aria-label': 'Edit message' } }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" sx={{ flex: 1, color: 'var(--sb-text-faint)' }}>
          Later messages are replaced{paneCount > 1 ? ` in ${paneCount} panes` : ''}.
        </Typography>
        <Button size="small" color="inherit" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="small" variant="contained" disabled={!changed} onClick={() => onSubmit(value)}>
          Send
        </Button>
      </Box>
    </Box>
  );
}

export function UserMessage({
  message,
  editPaneCount = 1,
  onEdit,
  onRetry,
}: {
  message: Message;
  /** How many panes an edit rewrites. */
  editPaneCount?: number;
  /** Missing while the message can't be edited, such as during a reply. */
  onEdit?: (content: string) => void;
  /** Present only when this is the last message in the pane and never got a reply, so there's nothing to regenerate from. */
  onRetry?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const files = (message.attachments ?? []).map((ref) => ({ key: ref.id, id: ref.id, name: ref.name, size: ref.size, kind: ref.kind }));
  if (editing && onEdit) {
    return (
      <EditBox
        initial={message.content}
        paneCount={editPaneCount}
        onCancel={() => setEditing(false)}
        onSubmit={(content) => {
          setEditing(false);
          onEdit(content);
        }}
      />
    );
  }
  return (
    <Box
      id={`message-${message.id}`}
      sx={{
        alignSelf: 'flex-end',
        maxWidth: '88%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 0.75,
        scrollMarginTop: 16,
        '&:hover .sb-actions, &:focus-within .sb-actions': { opacity: 1 },
      }}
    >
      {files.length > 0 && <AttachmentChips items={files} />}
      {message.content && (
        <Box
          sx={{
            px: 1.75,
            py: 1.125,
            borderRadius: '12px 12px 4px 12px',
            backgroundColor: 'var(--sb-sunken)',
            border: '1px solid var(--sb-border)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            fontSize: '0.875rem',
            lineHeight: 1.55,
          }}
        >
          {message.content}
        </Box>
      )}
      {onRetry && (
        <Typography variant="caption" component="div" sx={{ color: 'var(--sb-text-faint)' }}>
          No reply came back.{' '}
          <ButtonBase onClick={onRetry} sx={{ textDecoration: 'underline', fontSize: 'inherit', color: 'inherit' }}>
            Try again
          </ButtonBase>
        </Typography>
      )}
      {onEdit && message.content && (
        <Box className="sb-actions" sx={{ mt: -0.5, opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms ease' }}>
          <Tooltip title={editPaneCount > 1 ? `Edit and send again to ${editPaneCount} panes` : 'Edit and send again'}>
            <IconButton size="small" aria-label="Edit message" onClick={() => setEditing(true)}>
              <EditOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
    </Box>
  );
}

/** A message sent while a reply was still streaming: shown in place, held back until the pane is free. */
export function QueuedMessage({ item, onCancel }: { item: QueuedSend; onCancel: () => void }) {
  const files = item.attachments.map((ref) => ({ key: ref.id, id: ref.id, name: ref.name, size: ref.size, kind: ref.kind }));
  return (
    <Box sx={{ alignSelf: 'flex-end', maxWidth: '88%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.75, opacity: 0.6 }}>
      {files.length > 0 && <AttachmentChips items={files} />}
      {item.content && (
        <Box
          sx={{
            px: 1.75,
            py: 1.125,
            borderRadius: '12px 12px 4px 12px',
            backgroundColor: 'var(--sb-sunken)',
            border: '1px dashed var(--sb-border)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            fontSize: '0.875rem',
            lineHeight: 1.55,
          }}
        >
          {item.content}
        </Box>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
        <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)' }}>
          Queued — sends once the current reply finishes
        </Typography>
        <Tooltip title="Cancel this message">
          <IconButton size="small" aria-label="Cancel queued message" onClick={onCancel} sx={{ width: 22, height: 22 }}>
            <CloseRoundedIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

/** A command to show as a command line, with where and how long it may run, instead of raw JSON. */
function commandDetails(request: ApprovalRequest): { command: string; note: string } | null {
  if (request.toolName !== 'run_command') return null;
  try {
    const args = JSON.parse(request.arguments) as { command?: unknown; cwd?: unknown; timeout_seconds?: unknown };
    if (typeof args.command !== 'string') return null;
    const where = typeof args.cwd === 'string' && args.cwd ? `the workspace folder “${args.cwd}”` : 'the chat’s workspace folder';
    const limit = typeof args.timeout_seconds === 'number' ? `, for up to ${args.timeout_seconds} seconds` : '';
    return { command: args.command, note: `Runs on this computer in ${where}${limit}. It is not isolated from your other files.` };
  } catch {
    return null;
  }
}

/** A tool call waiting for the user, with its arguments. */
function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const command = commandDetails(request);
  const approve = useChatStore((state) => state.approve);
  const [answered, setAnswered] = useState(false);
  const answer = (approved: boolean) => {
    setAnswered(true);
    approve(request.id, approved);
  };
  return (
    <Box
      role="group"
      aria-label={`Approve ${request.label}`}
      sx={{ my: 1.25, p: 1.5, borderRadius: '10px', border: '1px solid var(--sb-pane-color, var(--sb-ink))', backgroundColor: 'var(--sb-surface)' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
        <BuildOutlinedIcon sx={{ fontSize: 16, color: 'var(--sb-text-muted)' }} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Allow {request.label}?
        </Typography>
      </Box>
      <Box
        component="pre"
        sx={{
          m: 0,
          mb: 1.25,
          p: 1,
          maxHeight: 200,
          overflow: 'auto',
          borderRadius: '6px',
          backgroundColor: 'var(--sb-sunken)',
          fontFamily: fonts.mono,
          fontSize: '0.75rem',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {command ? `> ${command.command}` : request.arguments}
      </Box>
      {command && (
        <Typography variant="caption" component="div" sx={{ mt: -0.5, mb: 1.25, color: 'var(--sb-text-muted)' }}>
          {command.note}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button size="small" variant="contained" disabled={answered} onClick={() => answer(true)}>
          Allow
        </Button>
        <Button size="small" variant="outlined" color="inherit" disabled={answered} onClick={() => answer(false)}>
          Decline
        </Button>
      </Box>
    </Box>
  );
}

function Reasoning({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mb: 1.25 }}>
      <ButtonBase
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        sx={{
          gap: 0.5,
          px: 0.75,
          py: 0.25,
          ml: -0.75,
          borderRadius: '6px',
          color: 'var(--sb-text-faint)',
          fontSize: '0.75rem',
          fontWeight: 550,
          '&:hover': { color: 'var(--sb-text-muted)' },
        }}
      >
        {live ? 'Reasoning…' : 'Reasoning'}
        <ExpandMoreRoundedIcon
          sx={{ fontSize: 16, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
        />
      </ButtonBase>
      <Collapse in={open}>
        <Box
          sx={{
            mt: 0.75,
            pl: 1.5,
            borderLeft: '2px solid var(--sb-border)',
            color: 'var(--sb-text-muted)',
            fontFamily: `var(--sb-chat-font, ${fonts.prose})`,
            fontSize: '0.875rem',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {text}
        </Box>
      </Collapse>
    </Box>
  );
}

function Meta({ message, showModel }: { message: Message; showModel: boolean }) {
  const parts = [
    showModel && message.model ? shortModel(message.model) : null,
    message.ttftMs !== null ? `${formatMs(message.ttftMs)} to first token` : null,
    tokensPerSecond(message.tokensOut, message.latencyMs, message.ttftMs),
    message.tokensIn !== null || message.tokensOut !== null
      ? `${formatTokens(message.tokensIn) ?? '–'} in, ${formatTokens(message.tokensOut) ?? '–'} out`
      : null,
    formatCost(message.cost),
  ].filter((part): part is string => Boolean(part));

  return (
    <Typography
      variant="caption"
      component="div"
      sx={{ color: 'var(--sb-text-faint)', display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.25 }}
    >
      {parts.map((part) => (
        <span key={part}>{part}</span>
      ))}
    </Typography>
  );
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  paneModel,
  canRegenerate,
  onRegenerate,
  onRetryWith,
  onBranch,
  onPreferred,
}: {
  message: Message;
  paneModel: string;
  canRegenerate: boolean;
  onRegenerate: () => void;
  /** Offered on a failed reply: opens a model picker anchored to the button. */
  onRetryWith?: (anchor: HTMLElement) => void;
  onBranch?: () => void;
  /** Present in chats with several panes, where one reply can be marked as the best. */
  onPreferred?: (preferred: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const note = message.finishReason ? FINISH_NOTES[message.finishReason] : undefined;

  return (
    <Box id={`message-${message.id}`} sx={{ scrollMarginTop: 16, '&:hover .sb-actions, &:focus-within .sb-actions': { opacity: 1 } }}>
      {message.reasoning && <Reasoning text={message.reasoning} />}
      {message.activity && <ActivityLog items={message.activity.items} sources={message.activity.sources} />}
      {message.attachments && <GeneratedImages attachments={message.attachments} />}
      {message.content && <Markdown text={message.content} />}
      {message.error && (
        <Alert
          severity="error"
          variant="outlined"
          sx={{ mt: message.content ? 1.5 : 0, fontSize: '0.8125rem' }}
          action={
            canRegenerate && (
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <Button size="small" color="inherit" onClick={onRegenerate}>
                  Retry
                </Button>
                {onRetryWith && (
                  <Button size="small" color="inherit" onClick={(event) => onRetryWith(event.currentTarget)}>
                    Try another model
                  </Button>
                )}
              </Box>
            )
          }
        >
          {message.error}
        </Alert>
      )}
      {note && (
        <Typography variant="caption" component="div" sx={{ mt: 1, color: 'warning.main', fontWeight: 550 }}>
          {note}
        </Typography>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, minHeight: 28 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Meta message={message} showModel={message.model !== paneModel} />
        </Box>
        {onPreferred && message.preferred && (
          <Tooltip title="Marked as the best reply. Click to unmark.">
            <IconButton size="small" aria-label="Unmark best reply" aria-pressed onClick={() => onPreferred(false)} sx={{ color: 'warning.main' }}>
              <StarRoundedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
        <Box className="sb-actions" sx={{ display: 'flex', opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms ease' }}>
          {onPreferred && !message.preferred && !message.error && (
            <Tooltip title="Mark as the best reply">
              <IconButton size="small" aria-label="Mark as best reply" aria-pressed={false} onClick={() => onPreferred(true)}>
                <StarBorderRoundedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          )}
          {onBranch && (
            <Tooltip title="Branch into a new chat from here">
              <IconButton size="small" aria-label="Branch into a new chat" onClick={onBranch}>
                <CallSplitRoundedIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
          )}
          {message.content && (
            <Tooltip title={copied ? 'Copied' : 'Copy reply'}>
              <IconButton
                size="small"
                aria-label="Copy reply"
                onClick={() => {
                  void navigator.clipboard.writeText(message.content).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? <CheckRoundedIcon sx={{ fontSize: 16 }} /> : <ContentCopyRoundedIcon sx={{ fontSize: 16 }} />}
              </IconButton>
            </Tooltip>
          )}
          {canRegenerate && !message.error && (
            <Tooltip title="Regenerate">
              <IconButton size="small" aria-label="Regenerate reply" onClick={onRegenerate}>
                <ReplayRoundedIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Box>
    </Box>
  );
});

export function LiveMessage({ live }: { live: LiveReply }) {
  const waiting = !live.text && !live.reasoning && live.activity.length === 0 && live.approvals.length === 0;
  return (
    <Box aria-live="polite" aria-busy="true">
      {live.reasoning && <Reasoning text={live.reasoning} live={!live.text} />}
      <ActivityLog items={live.activity} sources={live.sources} live />
      {live.approvals.map((request) => (
        <ApprovalCard key={request.id} request={request} />
      ))}
      {waiting ? (
        <Box sx={{ display: 'flex', gap: 0.75, py: 1 }} aria-label="Waiting for the first token">
          {[0, 1, 2].map((index) => (
            <Box
              key={index}
              sx={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: 'var(--sb-text-faint)',
                animation: 'sb-dot 1.1s ease-in-out infinite',
                animationDelay: `${index * 0.15}s`,
                '@keyframes sb-dot': { '0%, 80%, 100%': { opacity: 0.25 }, '40%': { opacity: 1 } },
              }}
            />
          ))}
        </Box>
      ) : (
        live.text && (
          <Box
            sx={{
              '& > div > :last-child::after': {
                content: '""',
                display: 'inline-block',
                width: '0.5em',
                height: '1.05em',
                ml: '2px',
                verticalAlign: 'text-bottom',
                backgroundColor: 'var(--sb-pane-color, var(--sb-ink))',
                borderRadius: '1px',
                animation: 'sb-caret 1s steps(2, start) infinite',
                '@keyframes sb-caret': { to: { visibility: 'hidden' } },
              },
            }}
          >
            <Markdown text={live.text} live />
          </Box>
        )
      )}
    </Box>
  );
}
