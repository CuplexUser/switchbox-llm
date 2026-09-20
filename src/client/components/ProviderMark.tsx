import Box from '@mui/material/Box';
import type { ProviderId } from '../../shared/types.ts';
import { PROVIDER_LABELS } from '../../shared/types.ts';

const GLYPHS: Record<ProviderId, string> = {
  openrouter: 'OR',
  openai: 'OA',
  anthropic: 'An',
  google: 'Gg',
  ollama: 'Ol',
  lmstudio: 'LM',
  custom: 'Cu',
};

/** A compact, monochrome provider badge. Color is reserved for channels, so this stays neutral. */
export function ProviderMark({ provider, size = 20 }: { provider: ProviderId; size?: number }) {
  return (
    <Box
      component="span"
      role="img"
      aria-label={PROVIDER_LABELS[provider]}
      title={PROVIDER_LABELS[provider]}
      sx={{
        display: 'inline-grid',
        placeItems: 'center',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: `${Math.round(size / 3.5)}px`,
        border: '1px solid var(--sb-border-strong)',
        color: 'var(--sb-text-muted)',
        backgroundColor: 'var(--sb-surface)',
        fontSize: size * 0.42,
        fontWeight: 650,
        letterSpacing: '-0.02em',
        lineHeight: 1,
      }}
    >
      {GLYPHS[provider]}
    </Box>
  );
}
