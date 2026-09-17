import AddRoundedIcon from '@mui/icons-material/AddRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { SystemPrompt } from '../../../shared/types.ts';
import { useDeletePrompt, usePrompts, useSavePrompt, useSettings, useTools } from '../../api/hooks.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { ParamsFields } from './ParamsFields.tsx';
import { SettingsHeader } from './Section.tsx';

type Draft = Pick<SystemPrompt, 'name' | 'content' | 'isDefault' | 'tools' | 'maxToolRounds' | 'params'> & { id?: string };

const EMPTY_DRAFT: Draft = { name: '', content: '', isDefault: false, tools: null, maxToolRounds: null, params: null };

function ProfileFields({ value, onChange }: { value: Draft; onChange: (value: Draft) => void }) {
  const tools = useTools();
  const settings = useSettings();
  const groups = tools.data ?? [];
  const limited = value.tools !== null;

  function toggleGroup(id: string, on: boolean): void {
    const current = new Set(value.tools ?? []);
    if (on) current.add(id);
    else current.delete(id);
    onChange({ ...value, tools: [...current] });
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1, borderTop: '1px solid var(--sb-border)' }}>
      <Box>
        <Typography variant="subtitle2">Tools</Typography>
        <Typography variant="body2" color="text.secondary">
          Limit what panes using this profile can do. Chat toggles still apply on top.
        </Typography>
        <RadioGroup
          row
          value={limited ? 'some' : 'all'}
          onChange={(event) => onChange({ ...value, tools: event.target.value === 'all' ? null : groups.map((group) => group.id) })}
        >
          <FormControlLabel value="all" control={<Radio size="small" />} label={<Typography variant="body2">All tools</Typography>} />
          <FormControlLabel value="some" control={<Radio size="small" />} label={<Typography variant="body2">Only these</Typography>} />
        </RadioGroup>
        {limited && (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, pl: 1 }}>
            {groups.map((group) => (
              <FormControlLabel
                key={group.id}
                control={<Checkbox size="small" checked={value.tools?.includes(group.id) ?? false} onChange={(event) => toggleGroup(group.id, event.target.checked)} />}
                label={<Typography variant="body2">{group.kind === 'mcp' ? `${group.label} (MCP)` : group.label}</Typography>}
              />
            ))}
          </Box>
        )}
      </Box>
      <TextField
        type="number"
        label="Tool rounds per reply"
        value={value.maxToolRounds ?? ''}
        placeholder={String(settings.data?.agent.maxToolRounds ?? 6)}
        helperText="Leave empty to use the limit from Settings → Tools."
        onChange={(event) => {
          const parsed = Math.round(Number(event.target.value));
          onChange({ ...value, maxToolRounds: event.target.value === '' || !Number.isFinite(parsed) ? null : Math.min(Math.max(parsed, 1), 50) });
        }}
        slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: 1, max: 50 } }}
        sx={{ maxWidth: 260 }}
      />
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Generation
        </Typography>
        <ParamsFields value={value.params ?? {}} onChange={(params) => onChange({ ...value, params })} placeholders={settings.data?.generation} />
      </Box>
    </Box>
  );
}

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
      <ProfileFields value={value} onChange={setValue} />
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
          {draft.id ? 'Save profile' : 'Create profile'}
        </Button>
      </Box>
      <ConfirmDialog
        open={confirming}
        title="Delete this profile?"
        body="Panes that use it will fall back to no system prompt, and memories limited to it will apply to every chat."
        confirmLabel="Delete profile"
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
        title="Profiles"
        description="Reusable system prompts, optionally with their own tools, tool round limit and generation settings. Pick one per pane to compare the same model set up in different ways."
      />

      {editing ? (
        <Box sx={{ border: '1px solid var(--sb-border)', borderRadius: '10px', backgroundColor: 'var(--sb-surface)', p: 2.5 }}>
          <PromptEditor key={editing.id ?? 'new'} draft={editing} onDone={() => setEditing(null)} />
        </Box>
      ) : (
        <>
          <Button variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => setEditing(EMPTY_DRAFT)} sx={{ mb: 2 }}>
            New profile
          </Button>
          <Box sx={{ border: '1px solid var(--sb-border)', borderRadius: '10px', backgroundColor: 'var(--sb-surface)', overflow: 'hidden' }}>
            {prompts.isLoading && <Skeleton height={64} sx={{ mx: 2 }} />}
            {prompts.isSuccess && prompts.data.length === 0 && (
              <Typography variant="body2" sx={{ p: 3, textAlign: 'center', color: 'var(--sb-text-faint)' }}>
                No profiles yet. Create one to reuse it across chats.
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
                  {prompt.tools ? ` · Tools: ${prompt.tools.length === 0 ? 'none' : prompt.tools.join(', ')}` : ''}
                </Typography>
              </Box>
            ))}
          </Box>
        </>
      )}
    </>
  );
}
