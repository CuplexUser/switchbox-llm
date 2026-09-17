import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { PROVIDER_LABELS, type AppSettings } from '../../../shared/types.ts';
import { useSettings, useUpdateSettings } from '../../api/hooks.ts';
import { ModelButton } from '../../components/ModelButton.tsx';
import { Panel, SettingRow, SettingsHeader } from './Section.tsx';

export function MemoryTab() {
  const settings = useSettings();
  const update = useUpdateSettings();
  if (!settings.data) return <Skeleton variant="rounded" height={260} />;
  const memory = settings.data.memory;

  function set<K extends keyof AppSettings['memory']>(key: K, value: AppSettings['memory'][K]): void {
    update.mutate({ section: 'memory', value: { ...memory, [key]: value } });
  }

  return (
    <>
      <SettingsHeader title="Memory" description="How saved memories are used and how new ones are suggested." />
      <Panel>
        <SettingRow label="Use memory in new chats" description="Each chat can still turn it on or off from its header.">
          <Switch
            checked={memory.useByDefault}
            onChange={(event) => set('useByDefault', event.target.checked)}
            slotProps={{ input: { 'aria-label': 'Use memory in new chats' } }}
          />
        </SettingRow>
        <SettingRow
          label="Most memories per prompt"
          description="When there are more, the ones most related to your message are sent. Set to 0 to send none."
          htmlFor="max-injected"
        >
          <TextField
            id="max-injected"
            type="number"
            value={memory.maxInjected}
            onChange={(event) => set('maxInjected', Math.max(0, Math.round(Number(event.target.value) || 0)))}
            slotProps={{ htmlInput: { min: 0, max: 500 } }}
            sx={{ width: 110 }}
          />
        </SettingRow>
        <SettingRow
          label="Suggest new memories"
          description="After each reply in a chat with memory on, a model reads the exchange and proposes facts for you to keep or dismiss."
        >
          <Switch
            checked={memory.autoSuggest}
            onChange={(event) => set('autoSuggest', event.target.checked)}
            slotProps={{ input: { 'aria-label': 'Suggest new memories' } }}
          />
        </SettingRow>
        <SettingRow
          label="Suggestion model"
          description="A small, inexpensive model works well. It sees your message and the first reply."
        >
          <ModelButton
            value={memory.suggestionModel}
            onChange={(ref) => set('suggestionModel', ref)}
            warn={memory.autoSuggest}
          />
        </SettingRow>
      </Panel>
      {memory.autoSuggest && !memory.suggestionModel && (
        <Typography variant="body2" sx={{ mt: 1.5, color: 'warning.main' }}>
          Suggestions won’t run until you choose a model.
        </Typography>
      )}
      {memory.suggestionModel && (
        <Typography variant="caption" component="p" sx={{ mt: 1.5, color: 'var(--sb-text-faint)' }}>
          Suggestions use {PROVIDER_LABELS[memory.suggestionModel.provider]}, so they count toward that provider’s usage.
        </Typography>
      )}
    </>
  );
}
