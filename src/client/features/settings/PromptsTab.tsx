import AddRoundedIcon from '@mui/icons-material/AddRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { SystemPrompt } from '../../../shared/types.ts';
import { useDeletePrompt, usePrompts, useSavePrompt } from '../../api/hooks.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { SettingsHeader } from './Section.tsx';

type Draft = Pick<SystemPrompt, 'name' | 'content' | 'isDefault'> & { id?: string };

const EMPTY_DRAFT: Draft = { name: '', content: '', isDefault: false };

function PromptEditor({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const save = useSavePrompt();
  const remove = useDeletePrompt();
  const [value, setValue] = useState(draft);
  const [confirming, setConfirming] = useState(false);

  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(value, { onSuccess: onDone });
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <TextField
        autoFocus={!draft.id}
        label="Name"
        required
        value={value.name}
        onChange={(event) => setValue({ ...value, name: event.target.value })}
      />
      <TextField
        label="Prompt"
        multiline
        minRows={8}
        maxRows={24}
        placeholder="You are a precise technical writer. Answer in short paragraphs and use code blocks for commands."
        value={value.content}
        onChange={(event) => setValue({ ...value, content: event.target.value })}
        slotProps={{ htmlInput: { style: { fontSize: '0.875rem', lineHeight: 1.6 } } }}
      />
      <FormControlLabel
        control={<Switch checked={value.isDefault} onChange={(event) => setValue({ ...value, isDefault: event.target.checked })} />}
        label={<Typography variant="body2">Use for new chats by default</Typography>}
      />
      {save.error && (
        <Typography variant="body2" color="error">
          {save.error.message}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 1 }}>
        {draft.id && (
          <Button color="error" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button color="inherit" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="contained" disabled={!value.name.trim() || save.isPending}>
          {draft.id ? 'Save prompt' : 'Create prompt'}
        </Button>
      </Box>
      <ConfirmDialog
        open={confirming}
        title="Delete this prompt?"
        body="Panes that use it will fall back to no system prompt."
        confirmLabel="Delete prompt"
        destructive
        onClose={() => setConfirming(false)}
        onConfirm={() => draft.id && remove.mutate(draft.id, { onSuccess: onDone })}
      />
    </Box>
  );
}

export function PromptsTab() {
  const prompts = usePrompts();
  const [editing, setEditing] = useState<Draft | null>(null);

  return (
    <>
      <SettingsHeader
        title="System prompts"
        description="Reusable instructions you can attach to any pane. A pane can also have its own custom instructions."
      />

      {editing ? (
        <Box sx={{ border: '1px solid var(--sb-border)', borderRadius: '10px', backgroundColor: 'var(--sb-surface)', p: 2.5 }}>
          <PromptEditor key={editing.id ?? 'new'} draft={editing} onDone={() => setEditing(null)} />
        </Box>
      ) : (
        <>
          <Button variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => setEditing(EMPTY_DRAFT)} sx={{ mb: 2 }}>
            New prompt
          </Button>
          <Box sx={{ border: '1px solid var(--sb-border)', borderRadius: '10px', backgroundColor: 'var(--sb-surface)', overflow: 'hidden' }}>
            {prompts.isLoading && <Skeleton height={64} sx={{ mx: 2 }} />}
            {prompts.isSuccess && prompts.data.length === 0 && (
              <Typography variant="body2" sx={{ p: 3, textAlign: 'center', color: 'var(--sb-text-faint)' }}>
                No prompts yet. Create one to reuse it across chats.
              </Typography>
            )}
            {prompts.data?.map((prompt) => (
              <Box
                key={prompt.id}
                component="button"
                type="button"
                onClick={() => setEditing(prompt)}
                sx={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  font: 'inherit',
                  color: 'inherit',
                  background: 'none',
                  border: 'none',
                  borderBottom: '1px solid var(--sb-border)',
                  '&:last-of-type': { borderBottom: 'none' },
                  px: 2.5,
                  py: 1.75,
                  cursor: 'pointer',
                  '&:hover': { backgroundColor: 'action.hover' },
                  '&:focus-visible': { outline: '2px solid var(--sb-ink)', outlineOffset: -2 },
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {prompt.name}
                  </Typography>
                  {prompt.isDefault && (
                    <Typography variant="caption" sx={{ color: 'var(--sb-ink)', fontWeight: 600 }}>
                      Default
                    </Typography>
                  )}
                </Box>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', mt: 0.25 }}
                >
                  {prompt.content || 'Empty prompt'}
                </Typography>
              </Box>
            ))}
          </Box>
        </>
      )}
    </>
  );
}
