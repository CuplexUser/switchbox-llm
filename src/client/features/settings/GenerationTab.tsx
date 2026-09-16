import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { GenerationParams } from '../../../shared/types.ts';
import { useSettings, useUpdateSettings } from '../../api/hooks.ts';
import { ParamsFields } from './ParamsFields.tsx';
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
          Anthropic requires an output limit, so Switchbox sends 8,192 tokens when none is set. Some reasoning models
          reject custom temperature values.
        </Typography>
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
                value: { temperature: params.temperature ?? null, topP: params.topP ?? null, maxTokens: params.maxTokens ?? null },
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
