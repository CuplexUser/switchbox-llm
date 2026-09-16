import CleaningServicesOutlinedIcon from '@mui/icons-material/CleaningServicesOutlined';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useLayoutEffect, useRef, useState } from 'react';
import { PROVIDER_LABELS, type ConversationDetail, type Pane as PaneData } from '../../../shared/types.ts';
import { useModels, usePrompts, useRemovePane, useUpdatePane } from '../../api/hooks.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import { ProviderMark } from '../../components/ProviderMark.tsx';
import { useChatStore, type PaneRuntime } from '../../stores/chat.ts';
import { channelSoftVar, channelVar } from '../../theme/theme.ts';
import { AssistantMessage, LiveMessage, UserMessage } from './MessageView.tsx';
import { PaneSettingsDialog } from './PaneSettingsDialog.tsx';
import { PromptPreviewDialog } from './PromptPreviewDialog.tsx';

const EMPTY: PaneRuntime = { messages: [], live: null };

export function Pane({
  conversation,
  pane,
  index,
  canRemove,
  showHeader = true,
}: {
  conversation: ConversationDetail;
  pane: PaneData;
  index: number;
  canRemove: boolean;
  showHeader?: boolean;
}) {
  const runtime = useChatStore((state) => state.conversations[conversation.id]?.panes[pane.id]) ?? EMPTY;
  const running = useChatStore((state) => Boolean(state.conversations[conversation.id]?.runId));
  const regenerate = useChatStore((state) => state.regenerate);
  const stop = useChatStore((state) => state.stop);
  const clearPane = useChatStore((state) => state.clearPane);
  const models = useModels();
  const prompts = usePrompts();
  const updatePane = useUpdatePane();
  const removePane = useRemovePane();

  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const info = models.data?.models.find((model) => model.provider === pane.provider && model.model === pane.model);
  const promptName = pane.systemPrompt
    ? 'Custom instructions'
    : prompts.data?.find((prompt) => prompt.id === pane.systemPromptId)?.name;

  const lastAssistant = runtime.messages.findLast((message) => message.role === 'assistant');
  const messageCount = runtime.messages.length;
  const seenCount = useRef(messageCount);

  // Runs after every render: follow new output while the reader is at the bottom.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // A new message from the user always brings the pane back to the bottom.
    if (messageCount > seenCount.current && runtime.messages.at(-1)?.role === 'user') pinnedToBottom.current = true;
    seenCount.current = messageCount;
    if (pinnedToBottom.current) element.scrollTop = element.scrollHeight;
  });

  return (
    <Box
      sx={{
        '--sb-pane-color': channelVar(index),
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        backgroundColor: 'var(--sb-surface)',
      }}
    >
      {showHeader && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1.25,
            height: 48,
            flexShrink: 0,
            borderTop: `3px solid ${channelVar(index)}`,
            borderBottom: '1px solid var(--sb-border)',
          }}
        >
          <ButtonBase
            onClick={(event) => setPickerAnchor(event.currentTarget)}
            disabled={running}
            aria-label={`Change model, currently ${pane.model}`}
            sx={{
              minWidth: 0,
              gap: 1,
              px: 0.75,
              py: 0.5,
              borderRadius: '6px',
              justifyContent: 'flex-start',
              '&:hover': { backgroundColor: 'action.hover' },
              '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
            }}
          >
            <ProviderMark provider={pane.provider} />
            <Box sx={{ minWidth: 0, textAlign: 'left' }}>
              <Typography variant="body2" noWrap sx={{ fontWeight: 600, lineHeight: 1.25 }}>
                {info?.name ?? pane.model}
              </Typography>
              <Typography variant="caption" noWrap component="div" sx={{ color: 'var(--sb-text-faint)', lineHeight: 1.2 }}>
                {PROVIDER_LABELS[pane.provider]}
                {promptName ? `, ${promptName}` : ''}
              </Typography>
            </Box>
            <ExpandMoreRoundedIcon sx={{ fontSize: 16, color: 'var(--sb-text-faint)', flexShrink: 0 }} />
          </ButtonBase>

          <Box sx={{ flex: 1 }} />

          {runtime.live && (
            <Tooltip title="Stop this pane">
              <IconButton
                size="small"
                aria-label="Stop this pane"
                onClick={() => stop(conversation.id, pane.id)}
                sx={{ color: channelVar(index), backgroundColor: channelSoftVar(index) }}
              >
                <StopRoundedIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Pane settings">
            <IconButton size="small" aria-label="Pane settings" onClick={() => setSettingsOpen(true)}>
              <TuneRoundedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <IconButton
            size="small"
            aria-label="More pane actions"
            aria-haspopup="menu"
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          >
            <MoreVertRoundedIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
      )}

      <Box
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
        sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sb-gap)',
            maxWidth: 760,
            mx: 'auto',
            px: { xs: 2, md: 2.5 },
            py: 2.5,
          }}
        >
          {runtime.messages.length === 0 && !runtime.live && (
            <Box sx={{ py: 6, textAlign: 'center', color: 'var(--sb-text-faint)' }}>
              <Box
                aria-hidden
                sx={{ width: 28, height: 4, borderRadius: 2, mx: 'auto', mb: 1.5, backgroundColor: channelVar(index) }}
              />
              <Typography variant="body2">Replies from {info?.name ?? pane.model} appear here.</Typography>
            </Box>
          )}
          {runtime.messages.map((message) =>
            message.role === 'user' ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage
                key={message.id}
                message={message}
                paneModel={pane.model}
                canRegenerate={!running && message.id === lastAssistant?.id}
                onRegenerate={() => void regenerate(conversation, pane.id)}
              />
            ),
          )}
          {runtime.live && <LiveMessage live={runtime.live} />}
        </Box>
      </Box>

      <ModelPicker
        open={Boolean(pickerAnchor)}
        anchorEl={pickerAnchor}
        onClose={() => setPickerAnchor(null)}
        selected={pane}
        onSelect={(ref) => updatePane.mutate({ id: pane.id, ...ref })}
      />

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            setPreviewOpen(true);
          }}
        >
          <ListItemIcon>
            <VisibilityOutlinedIcon fontSize="small" />
          </ListItemIcon>
          View assembled prompt
        </MenuItem>
        <MenuItem
          disabled={running || runtime.messages.length === 0}
          onClick={() => {
            setMenuAnchor(null);
            void clearPane(conversation, pane.id);
          }}
        >
          <ListItemIcon>
            <CleaningServicesOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Clear this pane
        </MenuItem>
        <MenuItem
          disabled={!canRemove || running}
          onClick={() => {
            setMenuAnchor(null);
            setConfirmRemove(true);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon>
            <CloseRoundedIcon fontSize="small" />
          </ListItemIcon>
          Remove pane
        </MenuItem>
      </Menu>

      <PaneSettingsDialog pane={pane} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <PromptPreviewDialog paneId={previewOpen ? pane.id : null} onClose={() => setPreviewOpen(false)} />
      <ConfirmDialog
        open={confirmRemove}
        title="Remove this pane?"
        body={`The ${info?.name ?? pane.model} pane and its replies will be removed from this chat.`}
        confirmLabel="Remove pane"
        destructive
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => removePane.mutate(pane)}
      />
    </Box>
  );
}
