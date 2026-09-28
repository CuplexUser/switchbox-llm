import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { mergeParams } from '../../../shared/defaults.ts';
import { SPEECH_VOICES } from '../../../shared/speech.ts';
import type { GenerationParams } from '../../../shared/types.ts';
import { useSettings, useUpdateSettings } from '../../api/hooks.ts';
import { ImageParamsFields, ParamsFields, SpeechParamsFields } from './ParamsFields.tsx';

/** Every known voice, for a default that applies across providers. */
const ALL_VOICES = [...new Set(Object.values(SPEECH_VOICES).flat())];
import { SettingsHeader } from './Section.tsx';

export function GenerationTab() {
  const settings = useSettings();
  if (!settings.data) return <Skeleton variant="rounded" height={200} />;
  return <GenerationForm saved={settings.data.generation} />;
}

function GenerationForm({ saved }: { saved: GenerationParams }) {
  const update = useUpdateSettings();
  const [params, setParams] = useState<Partial<GenerationParams>>(saved);
  const dirty = JSON.stringify(params) !== JSON.stringify(saved);

  return (
    <>
      <SettingsHeader
        title="Generation"
        description="Defaults for every pane. A pane's own settings override these, and an empty field lets the provider decide."
      />
      <Box sx={{ border: '1px solid var(--sb-border)', borderRadius: '10px', backgroundColor: 'var(--sb-surface)', p: 2.5 }}>
        <ParamsFields value={params} onChange={setParams} />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Anthropic requires an output limit, so Switchbox sends 32,000 tokens to models that think and 8,192 to older
          ones when none is set. Temperature and top P are left out for newer Claude models, which reject them, and some
          other reasoning models reject them too. Reasoning effort is sent as the nearest level a provider offers:
          newer Claude models think adaptively at that effort, older ones use the thinking budget, and OpenAI and
          OpenRouter get their own reasoning setting.
        </Typography>
        <Typography variant="subtitle2" sx={{ mt: 3, mb: 2 }}>
          Image generation
        </Typography>
        <ImageParamsFields value={params} onChange={setParams} />
        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          Speech
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          For speech panes and Read aloud. A voice from another provider, such as alloy on a Gemini model, is swapped
          for that model's default voice.
        </Typography>
        <SpeechParamsFields value={params} onChange={setParams} voices={ALL_VOICES} />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
          <Button color="inherit" disabled={!dirty} onClick={() => setParams(saved)}>
            Discard
          </Button>
          <Button
            variant="contained"
            disabled={!dirty || update.isPending}
            onClick={() =>
              update.mutate({
                section: 'generation',
                value: mergeParams(params),
              })
            }
          >
            Save defaults
          </Button>
        </Box>
      </Box>
    </>
  );
}
