import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import HistoryToggleOffRoundedIcon from '@mui/icons-material/HistoryToggleOffRounded';
import PsychologyAltOutlinedIcon from '@mui/icons-material/PsychologyAltOutlined';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import InputBase from '@mui/material/InputBase';
import Skeleton from '@mui/material/Skeleton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { MAX_PANES } from '../../../shared/defaults.ts';
import type { ConversationDetail } from '../../../shared/types.ts';
import { api } from '../../api/client.ts';
import {
  useAddPane,
  useConversation,
  useConversationMessages,
  useModels,
  useUpdateConversation,
} from '../../api/hooks.ts';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import { shortModel } from '../../lib/format.ts';
import { allMessages, useChatStore } from '../../stores/chat.ts';
import { channelSoftVar, channelVar } from '../../theme/theme.ts';
import { Composer } from './Composer.tsx';
import { Pane } from './Pane.tsx';

function ToggleChip({
  on,
  onClick,
  icon,
  label,
  tooltip,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tooltip: string;
}) {
  return (
    <Tooltip title={tooltip} describeChild>
      <ButtonBase
        onClick={onClick}
        aria-pressed={on}
        sx={{
          gap: 0.75,
          px: 1,
          height: 28,
          borderRadius: '6px',
          fontSize: '0.75rem',
          fontWeight: 550,
          border: '1px solid',
          borderColor: on ? 'var(--sb-border-strong)' : 'var(--sb-border)',
          color: on ? 'var(--sb-text)' : 'var(--sb-text-faint)',
          backgroundColor: on ? 'var(--sb-surface)' : 'transparent',
          '&:hover': { color: 'var(--sb-text)' },
          '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
        }}
      >
        {icon}
        {label}
      </ButtonBase>
    </Tooltip>
  );
}

function TitleField({ conversation }: { conversation: ConversationDetail }) {
  const update = useUpdateConversation();
  const [value, setValue] = useState(conversation.title);

  function commit(): void {
    const next = value.trim();
    if (next && next !== conversation.title) update.mutate({ id: conversation.id, title: next });
    else setValue(conversation.title);
  }

  return (
    <InputBase
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') {
          setValue(conversation.title);
          (event.target as HTMLInputElement).blur();
        }
      }}
      inputProps={{ 'aria-label': 'Conversation title' }}
      sx={{
        flex: 1,
        minWidth: 80,
        fontWeight: 600,
        fontSize: '0.9375rem',
        '& input': { px: 0.75, py: 0.5, borderRadius: '6px', textOverflow: 'ellipsis' },
        '& input:hover': { backgroundColor: 'action.hover' },
        '& input:focus': { backgroundColor: 'var(--sb-canvas)', outline: '1px solid var(--sb-ink)' },
      }}
    />
  );
}

export function ChatPage() {
  const { conversationId } = useParams();
  // Keyed so per-chat UI state (skipped panes, selected tab) starts fresh for each chat.
  return conversationId ? <ChatView key={conversationId} conversationId={conversationId} /> : null;
}

function ChatView({ conversationId }: { conversationId: string }) {
  const conversation = useConversation(conversationId);
  const messages = useConversationMessages(conversationId);
  const models = useModels();
  const updateConversation = useUpdateConversation();
  const addPane = useAddPane();
  const hydrate = useChatStore((state) => state.hydrate);
  const send = useChatStore((state) => state.send);
  const stop = useChatStore((state) => state.stop);
  const running = useChatStore((state) => Boolean(state.conversations[conversationId]?.runId));
  const narrow = useMediaQuery('(max-width: 720px)');

  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState(0);

  useEffect(() => {
    if (messages.data) hydrate(conversationId, messages.data);
  }, [conversationId, messages.data, hydrate]);

  const data = conversation.data;
  const panes = useMemo(() => data?.panes ?? [], [data]);
  const targets = panes.filter((pane) => !excluded.has(pane.id));

  if (conversation.error) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', flex: 1, p: 3 }}>
        <Box sx={{ textAlign: 'center', maxWidth: 360 }}>
          <Typography variant="h3" sx={{ mb: 1 }}>
            This chat isn’t available
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            It may have been deleted, or it was a temporary chat from before the server restarted.
          </Typography>
          <Button component={RouterLink} to="/" variant="contained">
            Start a new chat
          </Button>
        </Box>
      </Box>
    );
  }

  if (!data) {
    return (
      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Skeleton width={240} height={32} />
        <Skeleton variant="rounded" height={320} />
      </Box>
    );
  }

  function togglePersist(detail: ConversationDetail): void {
    const persist = !detail.persist;
    updateConversation.mutate(
      { id: detail.id, persist },
      {
        onSuccess: () => {
          if (!persist) return;
          // Save what was said while the chat was temporary.
          const unsaved = allMessages(useChatStore.getState().conversations[detail.id]);
          if (unsaved.length > 0) {
            void api(`/conversations/${detail.id}/messages`, { method: 'POST', json: { messages: unsaved } });
          }
        },
      },
    );
  }

  const noTargets = targets.length === 0;
  const readyModels = new Set((models.data?.models ?? []).map((model) => `${model.provider}:${model.model}`));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Box
        component="header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          height: 52,
          flexShrink: 0,
          pl: 'calc(var(--sb-shell-inset) + 12px)',
          pr: 1.5,
          borderBottom: '1px solid var(--sb-border)',
          backgroundColor: 'var(--sb-canvas)',
        }}
      >
        <TitleField key={data.title} conversation={data} />
        <ToggleChip
          on={data.persist}
          onClick={() => togglePersist(data)}
          icon={data.persist ? <CheckRoundedIcon sx={{ fontSize: 15 }} /> : <HistoryToggleOffRoundedIcon sx={{ fontSize: 15 }} />}
          label={data.persist ? 'Saved' : 'Temporary'}
          tooltip={
            data.persist
              ? 'Messages are saved to the database. Click to stop saving.'
              : 'Nothing is saved; this chat disappears when the server restarts. Click to save it.'
          }
        />
        <ToggleChip
          on={data.useMemory}
          onClick={() => updateConversation.mutate({ id: data.id, useMemory: !data.useMemory })}
          icon={<PsychologyAltOutlinedIcon sx={{ fontSize: 15 }} />}
          label={narrow ? '' : data.useMemory ? 'Memory on' : 'Memory off'}
          tooltip={
            data.useMemory
              ? 'Saved memories are added to the system prompt. Click to turn off for this chat.'
              : 'Memories are not used in this chat. Click to turn on.'
          }
        />
        <ToggleChip
          on={data.webAccess}
          onClick={() => updateConversation.mutate({ id: data.id, webAccess: !data.webAccess })}
          icon={<PublicRoundedIcon sx={{ fontSize: 15 }} />}
          label={narrow ? '' : data.webAccess ? 'Web on' : 'Web off'}
          tooltip={
            data.webAccess
              ? 'Models can search the web and read pages. Click to turn off for this chat.'
              : 'Models answer without web access. Click to turn on.'
          }
        />
        <Tooltip title={panes.length >= MAX_PANES ? `Up to ${MAX_PANES} models per chat` : 'Add a model to compare'}>
          <span>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddRoundedIcon />}
              disabled={panes.length >= MAX_PANES || running}
              onClick={(event) => setAddAnchor(event.currentTarget)}
              sx={{ height: 28, whiteSpace: 'nowrap' }}
            >
              {narrow ? 'Model' : 'Add model'}
            </Button>
          </span>
        </Tooltip>
      </Box>

      {narrow && panes.length > 1 && (
        <Tabs
          value={Math.min(tab, panes.length - 1)}
          onChange={(_event, value: number) => setTab(value)}
          variant="scrollable"
          sx={{ borderBottom: '1px solid var(--sb-border)', px: 1, flexShrink: 0 }}
        >
          {panes.map((pane, index) => (
            <Tab
              key={pane.id}
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: channelVar(index) }} />
                  {shortModel(pane.model)}
                </Box>
              }
            />
          ))}
        </Tabs>
      )}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: narrow ? '1fr' : `repeat(${panes.length}, minmax(300px, 1fr))`,
          overflowX: 'auto',
          backgroundColor: 'var(--sb-border)',
          gap: '1px',
        }}
      >
        {panes.map((pane, index) =>
          narrow && index !== Math.min(tab, panes.length - 1) ? (
            <Fragment key={pane.id} />
          ) : (
            <Pane key={pane.id} conversation={data} pane={pane} index={index} canRemove={panes.length > 1} />
          ),
        )}
      </Box>

      <Box sx={{ flexShrink: 0, px: { xs: 1.5, md: 3 }, pt: 1.5, pb: 2, borderTop: '1px solid var(--sb-border)' }}>
        <Box sx={{ maxWidth: 920, mx: 'auto' }}>
          {messages.error && (
            <Alert severity="error" sx={{ mb: 1 }}>
              Couldn’t load earlier messages: {messages.error.message}
            </Alert>
          )}
          <Composer
            autoFocus
            running={running}
            disabled={noTargets}
            disabledReason="Pick at least one pane to send to"
            placeholder={panes.length > 1 ? `Message ${targets.length} of ${panes.length} models` : 'Message'}
            onSend={(text) => void send(data, text, targets.map((pane) => pane.id))}
            onStop={() => stop(data.id)}
            footer={
              panes.length > 1 &&
              panes.map((pane, index) => {
                const on = !excluded.has(pane.id);
                const known = readyModels.size === 0 || readyModels.has(`${pane.provider}:${pane.model}`);
                return (
                  <Tooltip key={pane.id} describeChild title={on ? 'Sending to this pane. Click to skip it.' : 'Skipping this pane. Click to include it.'}>
                    <ButtonBase
                      aria-pressed={on}
                      onClick={() =>
                        setExcluded((current) => {
                          const next = new Set(current);
                          if (next.has(pane.id)) next.delete(pane.id);
                          else next.add(pane.id);
                          return next;
                        })
                      }
                      sx={{
                        gap: 0.75,
                        px: 1,
                        height: 26,
                        maxWidth: 200,
                        borderRadius: '13px',
                        fontSize: '0.75rem',
                        fontWeight: 550,
                        color: on ? 'var(--sb-text)' : 'var(--sb-text-faint)',
                        backgroundColor: on ? channelSoftVar(index) : 'transparent',
                        border: '1px solid',
                        borderColor: on ? 'transparent' : 'var(--sb-border)',
                        textDecoration: on ? 'none' : 'line-through',
                        opacity: known ? 1 : 0.8,
                        '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
                      }}
                    >
                      <Box
                        sx={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          flexShrink: 0,
                          backgroundColor: on ? channelVar(index) : 'var(--sb-border-strong)',
                        }}
                      />
                      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {shortModel(pane.model)}
                      </Box>
                    </ButtonBase>
                  </Tooltip>
                );
              })
            }
          />
        </Box>
      </Box>

      <ModelPicker
        open={Boolean(addAnchor)}
        anchorEl={addAnchor}
        onClose={() => setAddAnchor(null)}
        onSelect={(ref) => addPane.mutate({ conversationId: data.id, ...ref })}
      />
    </Box>
  );
}
