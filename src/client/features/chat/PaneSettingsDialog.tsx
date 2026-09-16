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
import type { GenerationParams, Pane } from '../../../shared/types.ts';
import { usePrompts, useSettings, useUpdatePane } from '../../api/hooks.ts';
import { ParamsFields } from '../settings/ParamsFields.tsx';

export function PaneSettingsDialog({ pane, open, onClose }: { pane: Pane; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      {open && <PaneSettingsForm pane={pane} onClose={onClose} />}
    </Dialog>
  );
}

function PaneSettingsForm({ pane, onClose }: { pane: Pane; onClose: () => void }) {
  const prompts = usePrompts();
  const settings = useSettings();
  const updatePane = useUpdatePane();
  const [promptId, setPromptId] = useState(pane.systemPromptId ?? '');
  const [custom, setCustom] = useState(pane.systemPrompt ?? '');
  const [params, setParams] = useState<Partial<GenerationParams>>(pane.params);

  const preset = prompts.data?.find((prompt) => prompt.id === promptId);

  function save(): void {
    updatePane.mutate(
      {
        id: pane.id,
        systemPromptId: promptId || null,
        systemPrompt: custom.trim() ? custom : null,
        params,
      },
      { onSuccess: onClose },
    );
  }

  return (
    <>
      <DialogTitle>Pane settings</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: '8px !important' }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="subtitle2">System prompt</Typography>
          <TextField
            select
            label="Preset"
            value={promptId}
            onChange={(event) => setPromptId(event.target.value)}
            helperText={custom.trim() ? 'Custom instructions below replace the preset for this pane.' : ' '}
          >
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
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="subtitle2">Generation</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>
            Leave a field empty to use the default from Settings.
          </Typography>
          <ParamsFields value={params} onChange={setParams} placeholders={settings.data?.generation} />
        </Box>
        {updatePane.error && (
          <Typography variant="body2" color="error">
            {updatePane.error.message}
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" onClick={save} disabled={updatePane.isPending}>
          Save
        </Button>
      </DialogActions>
    </>
  );
}
