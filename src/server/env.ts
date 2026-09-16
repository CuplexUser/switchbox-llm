import type { ProviderId } from '../shared/types.ts';

// .env is loaded by Node itself (--env-file-if-exists), so this only reads process.env.

const KEY_VARS: Partial<Record<ProviderId, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  custom: 'CUSTOM_API_KEY',
};

/** Providers that cannot work without a key. Local servers and custom endpoints can. */
export const KEY_REQUIRED: Record<ProviderId, boolean> = {
  openrouter: true,
  openai: true,
  anthropic: true,
  ollama: false,
  lmstudio: false,
  custom: false,
};

export function apiKeyFor(provider: ProviderId): string | null {
  const name = KEY_VARS[provider];
  const value = name ? process.env[name]?.trim() : undefined;
  return value ? value : null;
}

export function keyVarFor(provider: ProviderId): string | null {
  return KEY_VARS[provider] ?? null;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  databaseFile: process.env.DATABASE_FILE ?? './data/switchbox.db',
  production: process.env.NODE_ENV === 'production',
};
