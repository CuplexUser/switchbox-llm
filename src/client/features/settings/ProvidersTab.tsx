import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import KeyRoundedIcon from '@mui/icons-material/KeyRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { ProviderId, ProviderStatus } from '../../../shared/types.ts';
import { useProviders, useSettings, useTestProvider, useUpdateSettings } from '../../api/hooks.ts';
import { ProviderMark } from '../../components/ProviderMark.tsx';
import { SettingsHeader } from './Section.tsx';

const KEY_VARS: Partial<Record<ProviderId, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  custom: 'CUSTOM_API_KEY',
};

const DESCRIPTIONS: Record<ProviderId, string> = {
  openrouter: 'Hundreds of models from many vendors through one key, with per-request pricing.',
  openai: 'GPT models directly from OpenAI.',
  anthropic: 'Claude models directly from Anthropic.',
  google: 'Nano Banana and other Gemini image models directly from Google.',
  ollama: 'Models running locally with Ollama. No key needed.',
  lmstudio: 'Models served by LM Studio’s local server. No key needed.',
  custom: 'Any server that speaks the OpenAI Chat Completions API, such as vLLM or llama.cpp.',
};

function ProviderCard({ status }: { status: ProviderStatus }) {
  const settings = useSettings();
  const update = useUpdateSettings();
  const test = useTestProvider();
  const [baseUrl, setBaseUrl] = useState(status.baseUrl);

  const keyVar = KEY_VARS[status.id];

  function save(changes: { enabled?: boolean; baseUrl?: string }): void {
    if (!settings.data) return;
    const providers = settings.data.providers;
    update.mutate({
      section: 'providers',
      value: { ...providers, [status.id]: { ...providers[status.id], ...changes } },
    });
    test.reset();
  }

  return (
    <Box
      sx={{
        border: '1px solid var(--sb-border)',
        borderRadius: '10px',
        backgroundColor: 'var(--sb-surface)',
        p: 2.5,
        opacity: status.enabled ? 1 : 0.8,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
        <ProviderMark provider={status.id} size={32} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="h4" component="h3">
              {status.label}
            </Typography>
            {status.ready ? (
              <Typography variant="caption" sx={{ color: 'success.main', fontWeight: 600 }}>
                Ready
              </Typography>
            ) : status.enabled ? (
              <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 600 }}>
                {status.requiresKey && !status.keyConfigured ? 'Needs a key' : 'Needs a base URL'}
              </Typography>
            ) : (
              <Typography variant="caption" sx={{ color: 'var(--sb-text-faint)', fontWeight: 600 }}>
                Off
              </Typography>
            )}
          </Box>
          <Typography variant="body2" color="text.secondary">
            {DESCRIPTIONS[status.id]}
          </Typography>
        </Box>
        <Switch
          checked={status.enabled}
          onChange={(event) => save({ enabled: event.target.checked })}
          slotProps={{ input: { 'aria-label': `Use ${status.label}` } }}
        />
      </Box>

      <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1.5, pl: { sm: 5.5 } }}>
        {keyVar && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <KeyRoundedIcon sx={{ fontSize: 16, color: 'var(--sb-text-faint)' }} />
            <Typography variant="body2" sx={{ color: 'var(--sb-text-muted)' }}>
              <Box component="code" sx={{ fontSize: '0.8em', px: 0.5, borderRadius: '4px', backgroundColor: 'var(--sb-sunken)' }}>
                {keyVar}
              </Box>{' '}
              {status.keyConfigured
                ? 'is set in .env'
                : status.requiresKey
                  ? 'is missing from .env. Add it and restart the server.'
                  : 'is not set (optional)'}
            </Typography>
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
          <TextField
            fullWidth
            label="Base URL"
            value={baseUrl}
            placeholder="https://example.com/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
            onBlur={() => baseUrl.trim() !== status.baseUrl && save({ baseUrl: baseUrl.trim() })}
          />
          <Button
            variant="outlined"
            onClick={() => test.mutate(status.id)}
            disabled={test.isPending || !baseUrl.trim()}
            sx={{ flexShrink: 0, height: 40 }}
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
        </Box>
        {test.data?.ok && (
          <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: 'success.main' }}>
            <CheckCircleRoundedIcon sx={{ fontSize: 16 }} />
            Connected in {test.data.latencyMs}ms and found {test.data.modelCount} models.
          </Typography>
        )}
        {test.data && !test.data.ok && (
          <Typography variant="body2" sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, color: 'error.main' }}>
            <ErrorOutlineRoundedIcon sx={{ fontSize: 16, mt: 0.25 }} />
            {test.data.error}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export function ProvidersTab() {
  const providers = useProviders();

  return (
    <>
      <SettingsHeader
        title="Providers"
        description={
          <>
            API keys live in the <code>.env</code> file next to the app and never reach the browser. Everything else is
            set here.
          </>
        }
      />
      {providers.error && <Alert severity="error">{providers.error.message}</Alert>}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {providers.isLoading && Array.from({ length: 3 }, (_, index) => <Skeleton key={index} variant="rounded" height={150} />)}
        {providers.data?.map((status) => (
          <ProviderCard key={`${status.id}:${status.baseUrl}`} status={status} />
        ))}
      </Box>
    </>
  );
}
