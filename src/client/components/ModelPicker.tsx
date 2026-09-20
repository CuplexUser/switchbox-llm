import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Popover from '@mui/material/Popover';
import Skeleton from '@mui/material/Skeleton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useDeferredValue, useMemo, useState, type KeyboardEvent } from 'react';
import { Link as RouterLink } from 'react-router';
import { modelKey } from '../../shared/defaults.ts';
import { PROVIDER_LABELS, type ModelInfo, type ModelRef, type ProviderId } from '../../shared/types.ts';
import { useModels, useProviders, useRefreshModels, useSettings, useUpdateSettings } from '../api/hooks.ts';
import { formatContext, formatPrice } from '../lib/format.ts';
import { ProviderMark } from './ProviderMark.tsx';

interface Row {
  kind: 'header' | 'model' | 'custom';
  key: string;
  label: string;
  model?: ModelInfo;
  provider?: ProviderId;
}

const MAX_ROWS_PER_PROVIDER = 150;

export interface ModelPickerProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  onSelect: (ref: ModelRef) => void;
  selected?: ModelRef | null;
}

export function ModelPicker({ anchorEl, open, onClose, onSelect, selected }: ModelPickerProps) {
  const models = useModels();
  const providers = useProviders();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const refresh = useRefreshModels();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [active, setActive] = useState(0);

  const favorites = useMemo(() => settings.data?.favorites ?? [], [settings.data]);
  const favoriteKeys = useMemo(() => new Set(favorites.map(modelKey)), [favorites]);
  const readyProviders = useMemo(
    () => (providers.data ?? []).filter((provider) => provider.ready).map((provider) => provider.id),
    [providers.data],
  );

  const rows = useMemo<Row[]>(() => {
    const all = models.data?.models ?? [];
    const terms = deferredQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (model: ModelInfo) => {
      const haystack = `${model.name} ${model.model} ${PROVIDER_LABELS[model.provider]}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    };
    const filtered = all.filter(matches);
    const result: Row[] = [];

    const starred = filtered.filter((model) => favoriteKeys.has(modelKey(model)));
    if (starred.length > 0) {
      result.push({ kind: 'header', key: 'h-favorites', label: 'Favorites' });
      for (const model of starred) result.push({ kind: 'model', key: `f-${modelKey(model)}`, label: model.name, model });
    }

    for (const provider of readyProviders) {
      const own = filtered.filter((model) => model.provider === provider);
      if (own.length === 0) continue;
      result.push({ kind: 'header', key: `h-${provider}`, label: PROVIDER_LABELS[provider] });
      for (const model of own.slice(0, MAX_ROWS_PER_PROVIDER)) {
        result.push({ kind: 'model', key: modelKey(model), label: model.name, model });
      }
    }

    const typed = query.trim();
    if (typed && !all.some((model) => model.model === typed)) {
      result.push({ kind: 'header', key: 'h-direct-id', label: 'Use a model id directly' });
      for (const provider of readyProviders) {
        result.push({ kind: 'custom', key: `direct-${provider}`, label: typed, provider });
      }
    }
    return result;
  }, [models.data, deferredQuery, query, favoriteKeys, readyProviders]);

  const selectable = rows.filter((row) => row.kind !== 'header');

  function choose(row: Row | undefined): void {
    if (!row) return;
    if (row.kind === 'model' && row.model) onSelect({ provider: row.model.provider, model: row.model.model });
    if (row.kind === 'custom' && row.provider) onSelect({ provider: row.provider, model: row.label });
    setQuery('');
    onClose();
  }

  function toggleFavorite(model: ModelInfo): void {
    if (!settings.data) return;
    const ref = { provider: model.provider, model: model.model };
    const next = favoriteKeys.has(modelKey(ref))
      ? favorites.filter((favorite) => modelKey(favorite) !== modelKey(ref))
      : [...favorites, ref];
    updateSettings.mutate({ section: 'favorites', value: next });
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, selectable.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(selectable[active]);
    }
  }

  const activeKey = selectable[active]?.key;
  const selectedKey = selected ? modelKey(selected) : null;

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: -6, horizontal: 'left' }}
      slotProps={{ paper: { sx: { width: 420, maxWidth: 'calc(100vw - 32px)' } } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderBottom: '1px solid var(--sb-border)' }}>
        <SearchRoundedIcon fontSize="small" sx={{ color: 'var(--sb-text-faint)' }} />
        <InputBase
          autoFocus
          fullWidth
          placeholder="Search models or type an id"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          inputProps={{ 'aria-label': 'Search models' }}
          sx={{ fontSize: '0.875rem' }}
        />
        <Tooltip title="Reload model lists">
          <IconButton size="small" onClick={() => refresh.mutate()} disabled={refresh.isPending} aria-label="Reload model lists">
            <RefreshRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {(models.data?.errors ?? []).map((error) => (
        <Alert key={error.provider} severity="warning" sx={{ m: 1, py: 0, fontSize: '0.75rem' }}>
          {PROVIDER_LABELS[error.provider]}: {error.error}
        </Alert>
      ))}

      <Box role="listbox" aria-label="Models" sx={{ maxHeight: 420, overflowY: 'auto', p: 0.5 }}>
        {models.isLoading &&
          Array.from({ length: 6 }, (_, index) => <Skeleton key={index} height={36} sx={{ mx: 1 }} />)}

        {!models.isLoading && readyProviders.length === 0 && (
          <Box sx={{ p: 2.5, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              No provider is ready yet. Add an API key to .env or enable a local server.
            </Typography>
            <Button component={RouterLink} to="/settings/providers" variant="outlined" size="small" onClick={onClose}>
              Open provider settings
            </Button>
          </Box>
        )}

        {!models.isLoading && readyProviders.length > 0 && selectable.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2.5, textAlign: 'center' }}>
            No models match “{query}”.
          </Typography>
        )}

        {rows.map((row) => {
          if (row.kind === 'header') {
            return (
              <Typography
                key={row.key}
                variant="caption"
                component="div"
                sx={{ px: 1.25, pt: 1.25, pb: 0.5, color: 'var(--sb-text-faint)', fontWeight: 600 }}
              >
                {row.label}
              </Typography>
            );
          }
          const isActive = row.key === activeKey;
          const model = row.model;
          const isSelected = model ? modelKey(model) === selectedKey : false;
          return (
            <Box
              key={row.key}
              role="option"
              aria-selected={isSelected}
              onMouseEnter={() => setActive(selectable.findIndex((entry) => entry.key === row.key))}
              onClick={() => choose(row)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.25,
                py: 0.75,
                borderRadius: '6px',
                cursor: 'pointer',
                backgroundColor: isActive ? 'action.hover' : isSelected ? 'action.selected' : 'transparent',
              }}
            >
              <ProviderMark provider={model?.provider ?? row.provider ?? 'custom'} />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 550 }}>
                  {row.kind === 'custom' ? `Use “${row.label}” on ${PROVIDER_LABELS[row.provider ?? 'custom']}` : row.label}
                </Typography>
                {model && model.name !== model.model && (
                  <Typography variant="caption" noWrap component="div" sx={{ color: 'var(--sb-text-faint)' }}>
                    {model.model}
                  </Typography>
                )}
              </Box>
              {model && (
                <Box sx={{ display: 'flex', gap: 1, color: 'var(--sb-text-faint)', flexShrink: 0 }}>
                  {model.kind === 'image' && (
                    <Typography
                      variant="caption"
                      title="Answers with a generated image instead of text"
                      sx={{ px: 0.75, borderRadius: '4px', border: '1px solid var(--sb-border-strong)' }}
                    >
                      Image
                    </Typography>
                  )}
                  {model.contextLength && <Typography variant="caption">{formatContext(model.contextLength)}</Typography>}
                  {model.pricing && (
                    <Typography variant="caption" title="Input / output price per million tokens">
                      {formatPrice(model.pricing.input)}/{formatPrice(model.pricing.output)}
                    </Typography>
                  )}
                </Box>
              )}
              {model && (
                <IconButton
                  size="small"
                  aria-label={favoriteKeys.has(modelKey(model)) ? 'Remove from favorites' : 'Add to favorites'}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleFavorite(model);
                  }}
                  sx={{ p: 0.25 }}
                >
                  {favoriteKeys.has(modelKey(model)) ? (
                    <StarRoundedIcon fontSize="small" sx={{ color: 'var(--sb-ch-1)' }} />
                  ) : (
                    <StarBorderRoundedIcon fontSize="small" />
                  )}
                </IconButton>
              )}
            </Box>
          );
        })}
      </Box>
    </Popover>
  );
}
