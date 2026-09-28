import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { isImageModel, isSpeechModel } from '../../../shared/defaults.ts';
import { speechFormats, speechVoices } from '../../../shared/speech.ts';
import type { GenerationParams, ModelRef, Pane } from '../../../shared/types.ts';
import { useModels, usePrompts, useSettings, useUpdatePane } from '../../api/hooks.ts';
import { ImageParamsFields, ParamsFields, SpeechParamsFields } from '../settings/ParamsFields.tsx';

/** A pane's own settings. `systemPromptId` undefined follows the chat's profile (new chats only). */
export interface PaneSetup {
  systemPromptId?: string | null;
  systemPrompt: string | null;
  params: Partial<GenerationParams>;
}

const FOLLOW_CHAT = '__chat';

export function PaneSettingsDialog({ pane, open, onClose }: { pane: Pane; open: boolean; onClose: () => void }) {
  const updatePane = useUpdatePane();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      {open && (
        <PaneSettingsForm
          model={pane}
          initial={pane}
          saving={updatePane.isPending}
          error={updatePane.error?.message ?? null}
          onClose={onClose}
          onSave={(setup) => updatePane.mutate({ id: pane.id, ...setup, systemPromptId: setup.systemPromptId ?? null }, { onSuccess: onClose })}
        />
      )}
    </Dialog>
  );
}

/** Settings for a pane that doesn't exist yet, on the new chat page. */
export function NewPaneSettingsDialog({
  model,
  setup,
  chatProfileName,
  open,
  onClose,
  onSave,
}: {
  model: ModelRef | null;
  setup: PaneSetup | null;
  /** The profile the rest of the chat uses, offered as the default choice. */
  chatProfileName: string;
  open: boolean;
  onClose: () => void;
  onSave: (setup: PaneSetup) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      {open && model && setup && (
        <PaneSettingsForm
          model={model}
          initial={setup}
          followChatLabel={`Same as the chat (${chatProfileName})`}
          saving={false}
          error={null}
          onClose={onClose}
          onSave={(next) => {
            onSave(next);
            onClose();
          }}
        />
      )}
    </Dialog>
  );
}

function PaneSettingsForm({
  model,
  initial,
  followChatLabel,
  saving,
  error,
  onClose,
  onSave,
}: {
  model: ModelRef;
  initial: PaneSetup;
  /** When set, the preset can follow the chat's own choice. */
  followChatLabel?: string;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (setup: PaneSetup) => void;
}) {
  const prompts = usePrompts();
  const settings = useSettings();
  const models = useModels();
  const [promptId, setPromptId] = useState(initial.systemPromptId === undefined && followChatLabel ? FOLLOW_CHAT : (initial.systemPromptId ?? ''));
  const [custom, setCustom] = useState(initial.systemPrompt ?? '');
  const [params, setParams] = useState<Partial<GenerationParams>>(initial.params);

  const preset = prompts.data?.find((prompt) => prompt.id === promptId);
  const listed = models.data?.models.find((entry) => entry.provider === model.provider && entry.model === model.model);
  const imagePane = isImageModel(model, listed);
  const speechPane = isSpeechModel(model, listed);

  function save(): void {
    const setup: PaneSetup = { systemPrompt: custom.trim() ? custom : null, params };
    if (promptId !== FOLLOW_CHAT) setup.systemPromptId = promptId || null;
    onSave(setup);
  }

  return (
    <>
      <DialogTitle>
        Pane settings
        <Typography variant="body2" component="div" color="text.secondary">
          {listed?.name ?? model.model}
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: '8px !important' }}>
        {/* A speech model reads the message as written, so it has no use for a prompt. */}
        <Box sx={{ display: speechPane ? 'none' : 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="subtitle2">System prompt</Typography>
          <TextField
            select
            label="Preset"
            value={promptId}
            onChange={(event) => setPromptId(event.target.value)}
            helperText={custom.trim() ? 'Custom instructions below replace the preset for this pane.' : ' '}
          >
            {followChatLabel && <MenuItem value={FOLLOW_CHAT}>{followChatLabel}</MenuItem>}
            <MenuItem value="">None</MenuItem>
            {(prompts.data ?? []).map((prompt) => (
              <MenuItem key={prompt.id} value={prompt.id}>
                {prompt.name}
                {prompt.isDefault ? ' (default)' : ''}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Custom instructions for this pane"
            placeholder={preset?.content ? preset.content.slice(0, 160) : 'You are a helpful assistant.'}
            multiline
            minRows={4}
            maxRows={14}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
          />
        </Box>
        {imagePane && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Typography variant="subtitle2">Image</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>
              Leave a field empty to use the default from Settings.
            </Typography>
            <ImageParamsFields value={params} onChange={setParams} placeholders={settings.data?.generation} />
          </Box>
        )}
        {speechPane && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Typography variant="subtitle2">Speech</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>
              Each message you send is read aloud. Leave a field empty to use the default from Settings.
            </Typography>
            <SpeechParamsFields
              value={params}
              onChange={setParams}
              placeholders={settings.data?.generation}
              voices={speechVoices(model)}
              defaultVoices={speechVoices(model).slice(0, 2)}
              formats={speechFormats(model)}
              twoSpeakers={model.provider === 'google'}
            />
          </Box>
        )}
        {!speechPane && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Typography variant="subtitle2">Generation</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>
              Leave a field empty to use the default from Settings.
            </Typography>
            <ParamsFields value={params} onChange={setParams} placeholders={settings.data?.generation} />
          </Box>
        )}
        {error && (
          <Typography variant="body2" color="error">
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" onClick={save} disabled={saving}>
          Save
        </Button>
      </DialogActions>
    </>
  );
}

/** A short line naming what a pane changes from the defaults, e.g. "16:9 · 2K" or "Voice Kore · 1.2×". */
export function setupSummary(setup: PaneSetup): string {
  const { params } = setup;
  const parts = [
    params.aspectRatio,
    params.imageSize,
    params.imageQuality && `${params.imageQuality} quality`,
    params.voice && `Voice ${params.voice}`,
    params.secondVoice && `and ${params.secondVoice}`,
    params.speechSpeed != null && `${params.speechSpeed}×`,
    params.audioFormat?.toUpperCase(),
    params.speechStyle && `“${params.speechStyle.length > 24 ? `${params.speechStyle.slice(0, 23)}…` : params.speechStyle}”`,
    params.temperature != null && `Temp ${params.temperature}`,
    params.topP != null && `Top P ${params.topP}`,
    params.maxTokens != null && `${params.maxTokens.toLocaleString()} tokens`,
    params.reasoningEffort && `${params.reasoningEffort} effort`,
    params.thinkingBudget != null && `${params.thinkingBudget.toLocaleString()} thinking`,
    setup.systemPrompt && 'Custom instructions',
  ].filter(Boolean);
  return parts.join(' · ');
}
