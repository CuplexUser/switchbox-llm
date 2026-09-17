import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import { alpha } from '@mui/material/styles';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useMemo, useState } from 'react';
import type { ConversationDetail, Message } from '../../../shared/types.ts';
import { diffWords, overlap } from '../../lib/diff.ts';
import { formatMs, formatTokens, formatUsd, shortModel } from '../../lib/format.ts';
import { totalsOf, turnsOf, type ReplyTotals } from '../../lib/turns.ts';
import { messagesByPaneOf, useChatStore } from '../../stores/chat.ts';
import { channelVar, fonts } from '../../theme/theme.ts';

const cell = { px: 1, py: 0.75, borderBottom: '1px solid var(--sb-border)', whiteSpace: 'nowrap' } as const;

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function costText(totals: ReplyTotals): string {
  if (totals.cost === 0 && totals.costPartial) return '–';
  return `${formatUsd(totals.cost)}${totals.costPartial ? '+' : ''}`;
}

export function CompareDialog({ conversation, open, onClose }: { conversation: ConversationDetail; open: boolean; onClose: () => void }) {
  const narrow = useMediaQuery('(max-width: 720px)');
  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth fullScreen={narrow}>
      {open && <CompareView conversation={conversation} onClose={onClose} />}
    </Dialog>
  );
}

function CompareView({ conversation, onClose }: { conversation: ConversationDetail; onClose: () => void }) {
  const runtime = useChatStore((state) => state.conversations[conversation.id]);
  const setPreferred = useChatStore((state) => state.setPreferred);
  const turns = useMemo(() => turnsOf(conversation, messagesByPaneOf(runtime)), [conversation, runtime]);
  const [turnIndex, setTurnIndex] = useState(Math.max(0, turns.length - 1));
  const [left, setLeft] = useState(conversation.panes[0]?.id ?? '');
  const [right, setRight] = useState(conversation.panes[1]?.id ?? '');

  const turn = turns[Math.min(turnIndex, turns.length - 1)];
  const replies = turn?.replies ?? [];
  const exchangeTotals = totalsOf(replies.map((reply) => reply.message));
  const chatTotals = totalsOf(turns.flatMap((entry) => entry.replies.map((reply) => reply.message)));
  const leftText = replies.find((reply) => reply.pane.id === left)?.message?.content ?? '';
  const rightText = replies.find((reply) => reply.pane.id === right)?.message?.content ?? '';
  const parts = useMemo(() => (left && right && left !== right ? diffWords(leftText, rightText) : []), [left, right, leftText, rightText]);
  const paneIndex = (id: string) => conversation.panes.findIndex((pane) => pane.id === id);

  const paneSelect = (label: string, value: string, onChange: (id: string) => void) => (
    <TextField select size="small" label={label} value={value} onChange={(event) => onChange(event.target.value)} sx={{ minWidth: 180 }}>
      {conversation.panes.map((pane, index) => (
        <MenuItem key={pane.id} value={pane.id}>
          <Box component="span" sx={{ display: 'inline-block', width: 8, height: 8, mr: 1, borderRadius: '50%', backgroundColor: channelVar(index) }} />
          {shortModel(pane.model)}
        </MenuItem>
      ))}
    </TextField>
  );

  return (
    <>
      <DialogTitle>Compare replies</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        {turns.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Send a message first. Each exchange can then be compared here.
          </Typography>
        ) : (
          <>
            <TextField
              select
              size="small"
              label="Exchange"
              value={Math.min(turnIndex, turns.length - 1)}
              onChange={(event) => setTurnIndex(Number(event.target.value))}
              sx={{ mt: 1, maxWidth: 520 }}
            >
              {turns.map((entry, index) => (
                <MenuItem key={entry.prompt?.id ?? index} value={index}>
                  <Typography variant="body2" noWrap>
                    {index + 1}. {entry.prompt?.content || entry.prompt?.attachments?.[0]?.name || 'Message'}
                  </Typography>
                </MenuItem>
              ))}
            </TextField>

            <Box sx={{ overflowX: 'auto' }}>
              <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8125rem', '& th': { ...cell, textAlign: 'left', fontWeight: 600, color: 'var(--sb-text-muted)' }, '& td': cell }}>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>First token</th>
                    <th>Total time</th>
                    <th>Tokens in</th>
                    <th>Tokens out</th>
                    <th>Cost</th>
                    <th>Words</th>
                    <th>Best</th>
                  </tr>
                </thead>
                <tbody>
                  {replies.map(({ pane, message }, index) => (
                    <tr key={pane.id}>
                      <td>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Box sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: channelVar(index) }} />
                          {shortModel(message?.model ?? pane.model)}
                        </Box>
                      </td>
                      {message ? <ReplyCells message={message} /> : <td colSpan={6}>No reply</td>}
                      <td>
                        {message && !message.error && (
                          <PreferredButton message={message} onChange={(value) => void setPreferred(conversation.id, message, value)} />
                        )}
                      </td>
                    </tr>
                  ))}
                  <Box component="tr" sx={{ '& td': { fontWeight: 600, borderBottom: 'none' } }}>
                    <td colSpan={2}>This exchange</td>
                    <td>{formatMs(exchangeTotals.wallMs) ?? '–'}</td>
                    <td>{formatTokens(exchangeTotals.tokensIn)}</td>
                    <td>{formatTokens(exchangeTotals.tokensOut)}</td>
                    <td colSpan={3}>{costText(exchangeTotals)}</td>
                  </Box>
                  <Box component="tr" sx={{ '& td': { color: 'var(--sb-text-muted)', borderBottom: 'none' } }}>
                    <td colSpan={3}>Whole chat</td>
                    <td>{formatTokens(chatTotals.tokensIn)}</td>
                    <td>{formatTokens(chatTotals.tokensOut)}</td>
                    <td>{costText(chatTotals)}</td>
                    <td colSpan={2}>{chatTotals.replies} replies</td>
                  </Box>
                </tbody>
              </Box>
              <Typography variant="caption" component="p" sx={{ mt: 0.75, color: 'var(--sb-text-faint)' }}>
                Total time for the exchange is the slowest reply, since panes run at the same time. A + means some replies
                have no known price.
              </Typography>
            </Box>

            {conversation.panes.length > 1 && (
              <Box>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
                  <Typography variant="subtitle2" sx={{ mr: 1 }}>
                    Differences
                  </Typography>
                  {paneSelect('From', left, setLeft)}
                  {paneSelect('To', right, setRight)}
                  {parts.length > 0 && (
                    <Typography variant="body2" color="text.secondary">
                      {Math.round(overlap(parts) * 100)}% of words in common
                    </Typography>
                  )}
                </Box>
                {left === right ? (
                  <Typography variant="body2" color="text.secondary">
                    Pick two different panes.
                  </Typography>
                ) : (
                  <Box
                    aria-label="Word differences"
                    sx={{
                      p: 1.5,
                      maxHeight: 420,
                      overflowY: 'auto',
                      borderRadius: '8px',
                      border: '1px solid var(--sb-border)',
                      backgroundColor: 'var(--sb-sunken)',
                      fontFamily: fonts.mono,
                      fontSize: '0.8125rem',
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                      '& del': { color: 'error.main', backgroundColor: (theme) => alpha(theme.palette.error.main, 0.12), textDecorationThickness: '1px' },
                      '& ins': { color: 'success.main', backgroundColor: (theme) => alpha(theme.palette.success.main, 0.14), textDecoration: 'none' },
                    }}
                  >
                    {parts.length === 0 && (
                      <Typography variant="body2" color="text.secondary">
                        Neither pane has a reply to this exchange.
                      </Typography>
                    )}
                    {parts.map((part, index) =>
                      part.kind === 'same' ? (
                        <span key={index}>{part.text}</span>
                      ) : part.kind === 'removed' ? (
                        <del key={index}>{part.text}</del>
                      ) : (
                        <ins key={index}>{part.text}</ins>
                      ),
                    )}
                  </Box>
                )}
                <Typography variant="caption" component="p" sx={{ mt: 0.75, color: 'var(--sb-text-faint)' }}>
                  Struck-through words are only in {shortModel(conversation.panes[paneIndex(left)]?.model ?? '')}; highlighted
                  words are only in {shortModel(conversation.panes[paneIndex(right)]?.model ?? '')}. Markdown is compared as
                  written.
                </Typography>
              </Box>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </>
  );
}

function ReplyCells({ message }: { message: Message }) {
  if (message.error) {
    return (
      <Box component="td" colSpan={6} sx={{ color: 'error.main', whiteSpace: 'normal !important' }}>
        Failed: {message.error}
      </Box>
    );
  }
  return (
    <>
      <td>{formatMs(message.ttftMs) ?? '–'}</td>
      <td>{formatMs(message.latencyMs) ?? '–'}</td>
      <td>{formatTokens(message.tokensIn) ?? '–'}</td>
      <td>{formatTokens(message.tokensOut) ?? '–'}</td>
      <td>{message.cost === null ? '–' : formatUsd(message.cost)}</td>
      <td>{words(message.content)}</td>
    </>
  );
}

function PreferredButton({ message, onChange }: { message: Message; onChange: (preferred: boolean) => void }) {
  const on = Boolean(message.preferred);
  return (
    <Tooltip title={on ? 'Unmark best reply' : 'Mark as best reply'}>
      <IconButton size="small" aria-label={on ? 'Unmark best reply' : 'Mark as best reply'} aria-pressed={on} onClick={() => onChange(!on)}>
        {on ? <StarRoundedIcon sx={{ fontSize: 18, color: 'warning.main' }} /> : <StarBorderRoundedIcon sx={{ fontSize: 18 }} />}
      </IconButton>
    </Tooltip>
  );
}
