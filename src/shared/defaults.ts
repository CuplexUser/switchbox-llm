import type { AppSettings, GenerationParams } from './types.ts';

export const MAX_PANES = 4;

export const DEFAULT_GENERATION: GenerationParams = {
  temperature: null,
  topP: null,
  maxTokens: null,
};

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    theme: 'system',
    density: 'comfortable',
    persistByDefault: true,
    sendOnEnter: true,
  },
  providers: {
    openrouter: { enabled: true, baseUrl: 'https://openrouter.ai/api/v1' },
    openai: { enabled: true, baseUrl: 'https://api.openai.com/v1' },
    anthropic: { enabled: true, baseUrl: 'https://api.anthropic.com/v1' },
    ollama: { enabled: false, baseUrl: 'http://localhost:11434/v1' },
    lmstudio: { enabled: false, baseUrl: 'http://localhost:1234/v1' },
    custom: { enabled: false, baseUrl: '' },
  },
  favorites: [],
  generation: DEFAULT_GENERATION,
  defaults: {
    panes: [],
  },
  memory: {
    useByDefault: true,
    autoSuggest: false,
    suggestionModel: null,
    maxInjected: 50,
  },
};

/** Layers generation params left to right; later non-null values win. */
export function mergeParams(...layers: Partial<GenerationParams>[]): GenerationParams {
  const result: GenerationParams = { ...DEFAULT_GENERATION };
  for (const layer of layers) {
    for (const key of Object.keys(result) as (keyof GenerationParams)[]) {
      const value = layer[key];
      if (value !== undefined && value !== null) result[key] = value;
    }
  }
  return result;
}

export function modelKey(ref: { provider: string; model: string }): string {
  return `${ref.provider}:${ref.model}`;
}
