import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useLocation, useParams } from 'react-router';
import { useAddPane, useConversation, useConversationMessages, useModels } from '../../api/hooks.ts';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import { shortModel } from '../../lib/format.ts';
import { useChatStore } from '../../stores/chat.ts';
import { channelVar } from '../../theme/theme.ts';
import { ChatHeader } from './ChatHeader.tsx';
import { Composer } from './Composer.tsx';
import { Pane } from './Pane.tsx';
import { PaneTargets } from './PaneTargets.tsx';

export function ChatPage() {
  const { conversationId } = useParams();
  // Keyed so per-chat UI state (skipped panes, selected tab) starts fresh for each chat.
  return conversationId ? <ChatView key={conversationId} conversationId={conversationId} /> : null;
}

function ChatView({ conversationId }: { conversationId: string }) {
  const conversation = useConversation(conversationId);
  const messages = useConversationMessages(conversationId);
  const models = useModels();
  const addPane = useAddPane();
  const hydrate = useChatStore((state) => state.hydrate);
  const send = useChatStore((state) => state.send);
  const stop = useChatStore((state) => state.stop);
  const running = useChatStore((state) => Boolean(state.conversations[conversationId]?.runId));
  const narrow = useMediaQuery('(max-width: 720px)');

  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState(0);
  const { hash } = useLocation();

  useEffect(() => {
    if (messages.data) hydrate(conversationId, messages.data);
  }, [conversationId, messages.data, hydrate]);

  const data = conversation.data;
  const panes = useMemo(() => data?.panes ?? [], [data]);
  const targets = panes.filter((pane) => !excluded.has(pane.id));

  // On narrow screens only one pane shows, so a link to a message opens that message's pane.
  const linkedPane = hash.startsWith('#message-') ? messages.data?.find((message) => `#message-${message.id}` === hash)?.paneId : undefined;
  const [shownLink, setShownLink] = useState<string | undefined>(undefined);
  if (linkedPane !== shownLink) {
    setShownLink(linkedPane);
    const index = panes.findIndex((pane) => pane.id === linkedPane);
    if (index !== -1) setTab(index);
  }

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

  const noTargets = targets.length === 0;
  const readyModels = new Set((models.data?.models ?? []).map((model) => `${model.provider}:${model.model}`));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <ChatHeader data={data} narrow={narrow} running={running} onAddModel={setAddAnchor} />

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
            <Pane
              key={pane.id}
              conversation={data}
              pane={pane}
              index={index}
              canRemove={panes.length > 1}
              onSendOnlyHere={panes.length > 1 ? () => setExcluded(new Set(panes.filter((other) => other.id !== pane.id).map((other) => other.id))) : undefined}
            />
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
            onSend={(text, attachments) => void send(data, text, targets.map((pane) => pane.id), attachments)}
            onStop={() => stop(data.id)}
            footer={
              panes.length > 1 && (
                <PaneTargets
                  panes={panes}
                  excluded={excluded}
                  readyModels={readyModels}
                  onToggle={(paneId) =>
                    setExcluded((current) => {
                      const next = new Set(current);
                      if (next.has(paneId)) next.delete(paneId);
                      else next.add(paneId);
                      return next;
                    })
                  }
                />
              )
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
