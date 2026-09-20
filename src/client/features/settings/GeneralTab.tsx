import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { MAX_PANES, modelKey } from '../../../shared/defaults.ts';
import type { AppSettings, ModelRef } from '../../../shared/types.ts';
import { useModels, useSettings, useUpdateSettings } from '../../api/hooks.ts';
import { ModelButton } from '../../components/ModelButton.tsx';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import { ProviderMark } from '../../components/ProviderMark.tsx';
import { ChatFontFields, ChatFontPreview } from './ChatFontControls.tsx';
import { Panel, SettingRow, SettingsHeader } from './Section.tsx';

/** Up to `MAX_PANES` models, shown as removable chips with a picker to add more. */
function DefaultModels({ value, onChange }: { value: ModelRef[]; onChange: (value: ModelRef[]) => void }) {
  const models = useModels();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  function name(ref: ModelRef): string {
    return models.data?.models.find((model) => modelKey(model) === modelKey(ref))?.name ?? ref.model;
  }

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75, maxWidth: 420 }}>
      {value.map((ref, index) => (
        <Box
          key={`${modelKey(ref)}-${index}`}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            pl: 0.75,
            pr: 0.25,
            py: 0.375,
            borderRadius: '999px',
            border: '1px solid var(--sb-border-strong)',
          }}
        >
          <ProviderMark provider={ref.provider} size={16} />
          <Typography variant="body2" noWrap sx={{ maxWidth: 180 }}>
            {name(ref)}
          </Typography>
          <IconButton
            size="small"
            aria-label={`Remove ${name(ref)}`}
            onClick={() => onChange(value.filter((_, position) => position !== index))}
            sx={{ p: 0.25 }}
          >
            <CloseRoundedIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Box>
      ))}
      {value.length < MAX_PANES && (
        <Button size="small" color="inherit" onClick={(event) => setAnchor(event.currentTarget)} sx={{ color: 'var(--sb-text-muted)' }}>
          + Add a model
        </Button>
      )}
      <ModelPicker
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        onSelect={(ref) => {
          onChange([...value, ref]);
          setAnchor(null);
        }}
      />
    </Box>
  );
}

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
        <SettingRow
          label="Default models for new chats"
          description={`Pre-fills up to ${MAX_PANES} panes when you start a new chat. Without any, your favorites fill the first two.`}
        >
          <DefaultModels
            value={settings.data.defaults.panes}
            onChange={(panes) => update.mutate({ section: 'defaults', value: { panes } })}
          />
        </SettingRow>
      </Panel>
    </>
  );
}
