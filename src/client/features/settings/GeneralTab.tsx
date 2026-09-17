import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { AppSettings } from '../../../shared/types.ts';
import { useSettings, useUpdateSettings } from '../../api/hooks.ts';
import { ModelButton } from '../../components/ModelButton.tsx';
import { ChatFontFields, ChatFontPreview } from './ChatFontControls.tsx';
import { Panel, SettingRow, SettingsHeader } from './Section.tsx';

export function GeneralTab() {
  const settings = useSettings();
  const update = useUpdateSettings();
  if (!settings.data) return <Skeleton variant="rounded" height={280} />;
  const general = settings.data.general;

  function set<K extends keyof AppSettings['general']>(key: K, value: AppSettings['general'][K]): void {
    update.mutate({ section: 'general', value: { ...general, [key]: value } });
  }

  return (
    <>
      <SettingsHeader title="General" description="Appearance and how new chats behave." />
      <Panel>
        <SettingRow label="Theme">
          <ToggleButtonGroup
            exclusive
            size="small"
            value={general.theme}
            onChange={(_event, value: AppSettings['general']['theme'] | null) => value && set('theme', value)}
            aria-label="Theme"
          >
            <ToggleButton value="system">System</ToggleButton>
            <ToggleButton value="light">Light</ToggleButton>
            <ToggleButton value="dark">Dark</ToggleButton>
          </ToggleButtonGroup>
        </SettingRow>
        <SettingRow label="Density" description="Compact fits more text in each pane.">
          <ToggleButtonGroup
            exclusive
            size="small"
            value={general.density}
            onChange={(_event, value: AppSettings['general']['density'] | null) => value && set('density', value)}
            aria-label="Density"
          >
            <ToggleButton value="comfortable">Comfortable</ToggleButton>
            <ToggleButton value="compact">Compact</ToggleButton>
          </ToggleButtonGroup>
        </SettingRow>
        <Box sx={{ py: 2, borderBottom: '1px solid var(--sb-border)', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Chat font
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              Family, size and line height for assistant replies and reasoning.
            </Typography>
          </Box>
          <ChatFontFields
            value={general}
            onChange={(patch) => update.mutate({ section: 'general', value: { ...general, ...patch } })}
          />
          <ChatFontPreview value={general} />
        </Box>
        <SettingRow
          label="Save new chats to history"
          description="When off, new chats start as temporary and nothing is written to the database."
        >
          <Switch
            checked={general.persistByDefault}
            onChange={(event) => set('persistByDefault', event.target.checked)}
            slotProps={{ input: { 'aria-label': 'Save new chats to history' } }}
          />
        </SettingRow>
        <SettingRow
          label="Send with Enter"
          description={general.sendOnEnter ? 'Shift+Enter adds a new line.' : 'Enter adds a new line; Ctrl+Enter sends.'}
        >
          <Switch
            checked={general.sendOnEnter}
            onChange={(event) => set('sendOnEnter', event.target.checked)}
            slotProps={{ input: { 'aria-label': 'Send with Enter' } }}
          />
        </SettingRow>
        <SettingRow
          label="Title model"
          description="Writes a short title from your first message. Without one, chats are titled with the first line of that message."
        >
          <ModelButton
            value={general.titleModel}
            onChange={(ref) => set('titleModel', ref)}
            placeholder="First line of the message"
            clearLabel="Use the first line instead"
          />
        </SettingRow>
      </Panel>
    </>
  );
}
