import type { ProviderId } from '../shared/types.ts';

// .env is loaded here rather than with --env-file-if-exists: on Windows, watch mode handles that flag by
// watching the whole project folder, so every database write under data/ restarted the server in a loop.
// Variables already set in the environment win over the file.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

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

export function searchKeys(): { tavily: string | null; brave: string | null } {
  return {
    tavily: process.env.TAVILY_API_KEY?.trim() || null,
    brave: process.env.BRAVE_API_KEY?.trim() || null,
  };
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  databaseFile: process.env.DATABASE_FILE ?? './data/switchbox.db',
  /** One folder per chat with its workspace turned on. */
  workspaceDir: process.env.WORKSPACE_DIR ?? './data/workspaces',
  production: process.env.NODE_ENV === 'production',
};
