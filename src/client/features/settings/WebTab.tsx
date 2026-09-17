import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { AppSettings, ResolvedSearch, SearchMode, WebStatus } from '../../../shared/types.ts';
import { useSettings, useUpdateSettings, useWebStatus } from '../../api/hooks.ts';
import { clampInt } from '../../lib/format.ts';
import { Panel, SettingRow, SettingsHeader } from './Section.tsx';

const RESOLVED_LABELS: Record<ResolvedSearch, string> = {
  tavily: 'Tavily',
  brave: 'Brave Search',
  native: 'the provider’s built-in search',
  none: 'no web search',
};

interface ModeOption {
  mode: SearchMode;
  label: string;
  description: string;
  keyVar?: 'TAVILY_API_KEY' | 'BRAVE_API_KEY';
}

const MODES: ModeOption[] = [
  {
    mode: 'auto',
    label: 'Automatic',
    description: 'Uses Tavily if its key is set, otherwise Brave, otherwise the model provider’s built-in search.',
  },
  {
    mode: 'tavily',
    label: 'Tavily',
    description:
      'Results come back as summarized passages, so models can often answer straight from them instead of opening every link.',
    keyVar: 'TAVILY_API_KEY',
  },
  {
    mode: 'brave',
    label: 'Brave Search',
    description: 'Ordinary web results. Cheaper and more neutral, but models open more pages to get the details.',
    keyVar: 'BRAVE_API_KEY',
  },
  {
    mode: 'native',
    label: 'Provider’s built-in search',
    description:
      'No extra key: the model’s own provider searches on its servers. Quality varies by provider. OpenAI only searches with its search-enabled models, and Ollama, LM Studio and custom endpoints have no built-in search.',
  },
  {
    mode: 'none',
    label: 'Off',
    description: 'No web search. Models can still read pages by URL if page reading is on below.',
  },
];

function keySet(status: WebStatus | undefined, keyVar: ModeOption['keyVar']): boolean {
  if (!status || !keyVar) return false;
  return keyVar === 'TAVILY_API_KEY' ? status.tavilyKey : status.braveKey;
}

function ModeCard({
  option,
  selected,
  status,
  onSelect,
}: {
  option: ModeOption;
  selected: boolean;
  status: WebStatus | undefined;
  onSelect: () => void;
}) {
  const hasKey = keySet(status, option.keyVar);
  return (
    <Box
      component="label"
      sx={{
        display: 'flex',
        gap: 1.5,
        alignItems: 'flex-start',
        p: 1.75,
        borderRadius: '10px',
        border: '1px solid',
        borderColor: selected ? 'var(--sb-ink)' : 'var(--sb-border)',
        backgroundColor: selected ? 'action.selected' : 'var(--sb-surface)',
        cursor: 'pointer',
        '&:hover': { borderColor: selected ? 'var(--sb-ink)' : 'var(--sb-border-strong)' },
        '&:has(input:focus-visible)': { outline: '2px solid var(--sb-ink)', outlineOffset: 2 },
      }}
    >
      <Box
        component="input"
        type="radio"
        name="search-mode"
        checked={selected}
        onChange={onSelect}
        sx={{ mt: '3px', accentColor: 'var(--sb-ink)', width: 16, height: 16, flexShrink: 0 }}
      />
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {option.label}
          </Typography>
          {option.mode === 'auto' && status && (
            <Typography variant="caption" sx={{ color: 'var(--sb-text-muted)' }}>
              Using {RESOLVED_LABELS[planAuto(status)]}
            </Typography>
          )}
          {option.keyVar && (
            <Typography variant="caption" sx={{ color: hasKey ? 'success.main' : 'var(--sb-text-faint)', fontWeight: 550 }}>
              {hasKey ? 'Key set' : `Needs ${option.keyVar} in .env`}
            </Typography>
          )}
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {option.description}
        </Typography>
      </Box>
    </Box>
  );
}

function planAuto(status: WebStatus): ResolvedSearch {
  if (status.tavilyKey) return 'tavily';
  if (status.braveKey) return 'brave';
  return 'native';
}


export function WebTab() {
  const settings = useSettings();
  const status = useWebStatus();
  const update = useUpdateSettings();
  if (!settings.data) return <Skeleton variant="rounded" height={420} />;
  const web = settings.data.web;

  function set<K extends keyof AppSettings['web']>(key: K, value: AppSettings['web'][K]): void {
    update.mutate({ section: 'web', value: { ...web, [key]: value } });
  }

  return (
    <>
      <SettingsHeader
        title="Web search"
        description={
          <>
            How models look things up online in chats with web access on. Search API keys go in <code>.env</code>; restart
            the server after adding one.
          </>
        }
      />

      {status.data?.problem && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {status.data.problem}
        </Alert>
      )}

      <Box role="radiogroup" aria-label="Search mode" sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 3 }}>
        {MODES.map((option) => (
          <ModeCard
            key={option.mode}
            option={option}
            selected={web.searchMode === option.mode}
            status={status.data}
            onSelect={() => set('searchMode', option.mode)}
          />
        ))}
      </Box>

      <Panel>
        <SettingRow label="Web access in new chats" description="Each chat can still turn it on or off from its header.">
          <Switch
            checked={web.useByDefault}
            onChange={(event) => set('useByDefault', event.target.checked)}
            slotProps={{ input: { 'aria-label': 'Web access in new chats' } }}
          />
        </SettingRow>
        <SettingRow
          label="Let models read pages"
          description="Offers a web_fetch tool that opens a URL and returns its text. Local and private network addresses are always blocked."
        >
          <Switch
            checked={web.allowFetch}
            onChange={(event) => set('allowFetch', event.target.checked)}
            slotProps={{ input: { 'aria-label': 'Let models read pages' } }}
          />
        </SettingRow>
        <SettingRow label="Results per search" description="Used by Tavily and Brave. Models can ask for up to 10." htmlFor="max-results">
          <TextField
            id="max-results"
            type="number"
            value={web.maxResults}
            onChange={(event) => set('maxResults', clampInt(event.target.value, 1, 10, web.maxResults))}
            slotProps={{ htmlInput: { min: 1, max: 10 } }}
            sx={{ width: 110 }}
          />
        </SettingRow>
      </Panel>
    </>
  );
}
