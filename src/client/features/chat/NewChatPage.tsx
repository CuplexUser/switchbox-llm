import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';
import { isImageModel, isSpeechModel, MAX_PANES, modelKey } from '../../../shared/defaults.ts';
import { PROVIDER_LABELS, type AppSettings, type AttachmentRef, type ModelRef } from '../../../shared/types.ts';
import {
  useCreateConversation,
  useModels,
  usePrompts,
  useProviders,
  useSettings,
  useUpdateSettings,
} from '../../api/hooks.ts';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import { ProviderMark } from '../../components/ProviderMark.tsx';
import { useChatStore } from '../../stores/chat.ts';
import { CHANNEL_NAMES, channelSoftVar, channelVar } from '../../theme/theme.ts';
import { Composer } from './Composer.tsx';
import { NewPaneSettingsDialog, setupSummary, type PaneSetup } from './PaneSettingsDialog.tsx';

/** A model chosen for the new chat, with any settings made for it before the chat starts. */
type Slot = ModelRef & PaneSetup;

function toSlot(ref: ModelRef): Slot {
  return { provider: ref.provider, model: ref.model, systemPrompt: null, params: {} };
}

export function NewChatPage() {
  const settings = useSettings();
  if (!settings.data) {
    return (
      <Box sx={{ maxWidth: 820, width: '100%', mx: 'auto', px: 4, pt: '14vh' }}>
        <Skeleton width={360} height={44} />
        <Skeleton variant="rounded" height={140} sx={{ mt: 3 }} />
      </Box>
    );
  }
  return <NewChatForm settings={settings.data} />;
}

function NewChatForm({ settings }: { settings: AppSettings }) {
  const providers = useProviders();
  const models = useModels();
  const prompts = usePrompts();
  const updateSettings = useUpdateSettings();
  const createConversation = useCreateConversation();
  const navigate = useNavigate();

  // Start from the saved default models, else the first two favorites.
  const [slots, setSlots] = useState<Slot[]>(() =>
    (settings.defaults.panes.length > 0 ? settings.defaults.panes.slice(0, MAX_PANES) : settings.favorites.slice(0, 2)).map(toSlot),
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [persist, setPersist] = useState(settings.general.persistByDefault);
  const [useMemory, setUseMemory] = useState(settings.memory.useByDefault);
  const [webAccess, setWebAccess] = useState(settings.web.useByDefault);
  // Always starts off: a chat only gets a workspace when asked for.
  const [workspace, setWorkspace] = useState(false);
  const [promptId, setPromptId] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ anchor: HTMLElement; slot: number } | null>(null);

  const defaultPrompt = prompts.data?.find((prompt) => prompt.isDefault);
  const effectivePromptId = promptId ?? defaultPrompt?.id ?? '';
  const current = slots;
  const noProviderReady = providers.isSuccess && !providers.data.some((provider) => provider.ready);
  const savedDefaults = settings.defaults.panes;
  const isDefaultSet =
    current.length > 0 &&
    current.length === savedDefaults.length &&
    current.every((slot, index) => savedDefaults[index] && modelKey(slot) === modelKey(savedDefaults[index]));

  function listed(ref: ModelRef) {
    return models.data?.models.find((model) => modelKey(model) === modelKey(ref));
  }

  function modelName(ref: ModelRef): string {
    return listed(ref)?.name ?? ref.model;
  }

  /** The provider, what kind of model it is, and anything set for it here. */
  function slotCaption(slot: Slot): string {
    const info = listed(slot);
    const kind = isSpeechModel(slot, info) ? 'Speech' : isImageModel(slot, info) ? 'Image' : null;
    const profile = slot.systemPromptId === undefined ? null : (prompts.data?.find((prompt) => prompt.id === slot.systemPromptId)?.name ?? 'No profile');
    return [PROVIDER_LABELS[slot.provider], kind, profile, setupSummary(slot)].filter(Boolean).join(' · ');
  }

  function start(text: string, attachments: AttachmentRef[]): void {
    createConversation.mutate(
      {
        persist,
        useMemory,
        webAccess,
        workspace,
        panes: current.map((slot) => ({
          provider: slot.provider,
          model: slot.model,
          systemPromptId: slot.systemPromptId === undefined ? effectivePromptId || null : slot.systemPromptId,
          systemPrompt: slot.systemPrompt,
          params: slot.params,
        })),
      },
      {
        onSuccess: (conversation) => {
          useChatStore.getState().hydrate(conversation.id, []);
          void useChatStore.getState().send(conversation, text, conversation.panes.map((pane) => pane.id), attachments);
          void navigate(`/c/${conversation.id}`);
        },
      },
    );
  }

  return (
    <Box sx={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          width: '100%',
          maxWidth: 820,
          mx: 'auto',
          px: { xs: 2, md: 4 },
          pt: { xs: 9, md: '14vh' },
          pb: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}
      >
        <Box>
          <Typography variant="h1" component="h1" sx={{ mb: 0.75 }}>
            Ask several models at once
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Pick up to {MAX_PANES} models. Each one gets its own pane, and every message goes to all of them.
          </Typography>
        </Box>

        {noProviderReady && (
          <Alert
            severity="info"
            action={
              <Button component={RouterLink} to="/settings/providers" color="inherit" size="small">
                Set up providers
              </Button>
            }
          >
            No provider is ready. Add an API key to .env, or turn on Ollama or LM Studio.
          </Alert>
        )}

        <Box
          role="list"
          aria-label="Models to compare"
          sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 1.25 }}
        >
          {current.map((slot, index) => (
            <Box
              role="listitem"
              key={`${modelKey(slot)}-${index}`}
              sx={{
                display: 'flex',
                alignItems: 'center',
                borderRadius: '10px',
                border: '1px solid var(--sb-border)',
                borderLeft: `4px solid ${channelVar(index)}`,
                backgroundColor: 'var(--sb-surface)',
                overflow: 'hidden',
              }}
            >
              <ButtonBase
                onClick={(event) => setPicker({ anchor: event.currentTarget, slot: index })}
                aria-label={`Channel ${CHANNEL_NAMES[index]}: ${modelName(slot)}. Change model`}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  gap: 1.25,
                  px: 1.5,
                  py: 1.25,
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  '&:hover': { backgroundColor: channelSoftVar(index) },
                  '&:focus-visible': { outline: '2px solid var(--sb-ink)', outlineOffset: -2 },
                }}
              >
                <ProviderMark provider={slot.provider} size={26} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                    {modelName(slot)}
                  </Typography>
                  <Typography variant="caption" noWrap component="div" title={slotCaption(slot)} sx={{ color: 'var(--sb-text-faint)' }}>
                    {slotCaption(slot)}
                  </Typography>
                </Box>
              </ButtonBase>
              <Tooltip title="Settings for this pane">
                <IconButton
                  size="small"
                  aria-label={`Settings for ${modelName(slot)}`}
                  onClick={() => setEditing(index)}
                  sx={{ color: setupSummary(slot) || slot.systemPromptId !== undefined ? channelVar(index) : undefined }}
                >
                  <TuneRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <IconButton
                size="small"
                aria-label={`Remove ${modelName(slot)}`}
                onClick={() => setSlots(current.filter((_, position) => position !== index))}
                sx={{ mr: 0.75, ml: -0.25 }}
              >
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
          {current.length < MAX_PANES && (
            <ButtonBase
              onClick={(event) => setPicker({ anchor: event.currentTarget, slot: current.length })}
              sx={{
                minHeight: 60,
                gap: 1,
                borderRadius: '10px',
                border: '1px dashed var(--sb-border-strong)',
                color: 'var(--sb-text-muted)',
                fontSize: '0.875rem',
                fontWeight: 550,
                '&:hover': { color: 'var(--sb-text)', borderColor: 'var(--sb-text-faint)' },
                '&:focus-visible': { outline: '2px solid var(--sb-ink)' },
              }}
            >
              <Box
                aria-hidden
                sx={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: channelVar(current.length) }}
              />
              <AddRoundedIcon fontSize="small" />
              {current.length === 0 ? 'Choose a model' : 'Add a model'}
            </ButtonBase>
          )}
        </Box>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: { xs: 1, sm: 2.5 } }}>
          <TextField
            select
            label="System prompt"
            value={effectivePromptId}
            onChange={(event) => setPromptId(event.target.value)}
            sx={{ minWidth: 220 }}
          >
            <MenuItem value="">None</MenuItem>
            {(prompts.data ?? []).map((prompt) => (
              <MenuItem key={prompt.id} value={prompt.id}>
                {prompt.name}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={<Switch checked={persist} onChange={(event) => setPersist(event.target.checked)} />}
            label={<Typography variant="body2">Save to history</Typography>}
          />
          <FormControlLabel
            control={<Switch checked={useMemory} onChange={(event) => setUseMemory(event.target.checked)} />}
            label={<Typography variant="body2">Use memory</Typography>}
          />
          <FormControlLabel
            control={<Switch checked={webAccess} onChange={(event) => setWebAccess(event.target.checked)} />}
            label={<Typography variant="body2">Web access</Typography>}
          />
          <FormControlLabel
            control={<Switch checked={workspace} onChange={(event) => setWorkspace(event.target.checked)} />}
            label={<Typography variant="body2">Files</Typography>}
          />
          <Box sx={{ flex: 1 }} />
          {current.length > 0 && !isDefaultSet && (
            <Button
              size="small"
              color="inherit"
              onClick={() => updateSettings.mutate({ section: 'defaults', value: { panes: current.map(({ provider, model }) => ({ provider, model })) } })}
              sx={{ color: 'var(--sb-text-muted)' }}
            >
              Make these the default models
            </Button>
          )}
        </Box>

        {createConversation.error && <Alert severity="error">{createConversation.error.message}</Alert>}

        <Composer
          autoFocus
          disabled={current.length === 0 || createConversation.isPending}
          disabledReason="Choose at least one model first"
          placeholder={current.length > 1 ? `Message ${current.length} models` : 'Message'}
          onSend={start}
        />
      </Box>

      <ModelPicker
        open={Boolean(picker)}
        anchorEl={picker?.anchor ?? null}
        onClose={() => setPicker(null)}
        selected={picker ? current[picker.slot] : null}
        onSelect={(ref) => {
          if (!picker) return;
          const next = [...current];
          // A new model keeps the settings made for the slot; ones it doesn't use are ignored.
          next[picker.slot] = { ...(current[picker.slot] ?? toSlot(ref)), provider: ref.provider, model: ref.model };
          setSlots(next);
        }}
      />
      <NewPaneSettingsDialog
        open={editing !== null}
        model={editing === null ? null : (current[editing] ?? null)}
        setup={editing === null ? null : (current[editing] ?? null)}
        chatProfileName={prompts.data?.find((prompt) => prompt.id === effectivePromptId)?.name ?? 'none'}
        onClose={() => setEditing(null)}
        onSave={(setup) => {
          if (editing === null) return;
          setSlots(current.map((slot, index) => (index === editing ? { provider: slot.provider, model: slot.model, ...setup } : slot)));
        }}
      />
    </Box>
  );
}
