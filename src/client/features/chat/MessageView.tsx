import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { memo, useState } from 'react';
import type { ApprovalRequest, Message } from '../../../shared/types.ts';
import { Markdown } from '../../components/Markdown.tsx';
import { formatCost, formatMs, formatTokens, shortModel, tokensPerSecond } from '../../lib/format.ts';
import { useChatStore, type LiveReply } from '../../stores/chat.ts';
import { fonts } from '../../theme/theme.ts';
import { ActivityLog } from './ActivityLog.tsx';
import { AttachmentChips } from './AttachmentChips.tsx';

const FINISH_NOTES: Record<string, string> = {
  aborted: 'Stopped',
  length: 'Cut off at the token limit',
  max_tokens: 'Cut off at the token limit',
  content_filter: 'Blocked by the provider’s content filter',
  refusal: 'The model declined',
};

export function UserMessage({ message }: { message: Message }) {
  const files = (message.attachments ?? []).map((ref) => ({ key: ref.id, id: ref.id, name: ref.name, size: ref.size, kind: ref.kind }));
  return (
    <Box sx={{ alignSelf: 'flex-end', maxWidth: '88%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.75 }}>
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
    </Box>
  );
}

/** A tool call waiting for the user, with its arguments. */
function ApprovalCard({ request }: { request: ApprovalRequest }) {
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
        {request.arguments}
      </Box>
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
            fontFamily: fonts.prose,
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
}: {
  message: Message;
  paneModel: string;
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const note = message.finishReason ? FINISH_NOTES[message.finishReason] : undefined;

  return (
    <Box sx={{ '&:hover .sb-actions, &:focus-within .sb-actions': { opacity: 1 } }}>
      {message.reasoning && <Reasoning text={message.reasoning} />}
      {message.activity && <ActivityLog items={message.activity.items} sources={message.activity.sources} />}
      {message.content && <Markdown text={message.content} />}
      {message.error && (
        <Alert severity="error" variant="outlined" sx={{ mt: message.content ? 1.5 : 0, fontSize: '0.8125rem' }}>
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
        <Box className="sb-actions" sx={{ display: 'flex', opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms ease' }}>
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
          {canRegenerate && (
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
