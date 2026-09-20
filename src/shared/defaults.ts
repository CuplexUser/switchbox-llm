import { DEFAULT_CHAT_FONT_ID, DEFAULT_CHAT_FONT_SIZE, DEFAULT_CHAT_LINE_HEIGHT } from './chatFonts.ts';
import type { AppSettings, GenerationParams } from './types.ts';

export const MAX_PANES = 4;

export const DEFAULT_GENERATION: GenerationParams = {
  temperature: null,
  topP: null,
  maxTokens: null,
  reasoningEffort: null,
  thinkingBudget: null,
};

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    theme: 'system',
    density: 'comfortable',
    persistByDefault: true,
    sendOnEnter: true,
    titleModel: null,
    chatFont: DEFAULT_CHAT_FONT_ID,
    chatFontSize: DEFAULT_CHAT_FONT_SIZE,
    chatLineHeight: DEFAULT_CHAT_LINE_HEIGHT,
  },
  providers: {
    openrouter: { enabled: true, baseUrl: 'https://openrouter.ai/api/v1' },
    openai: { enabled: true, baseUrl: 'https://api.openai.com/v1' },
    anthropic: { enabled: true, baseUrl: 'https://api.anthropic.com/v1' },
    google: { enabled: false, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
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
  web: {
    searchMode: 'auto',
    useByDefault: true,
    allowFetch: true,
    maxResults: 5,
  },
  agent: {
    maxToolRounds: 6,
    maxParallelTools: 4,
    keepToolResults: 'summary',
    policies: {},
  },
  mcp: {
    servers: [],
  },
  workspace: {
    quotaMb: 100,
    maxFileMb: 20,
    commandTimeoutSeconds: 60,
    maxCommandTimeoutSeconds: 600,
    shell: 'system',
    outputChars: 20_000,
    sandboxCommands: false,
    wslDistro: '',
    allowNetworkByDefault: false,
  },
};

/** Layers generation params left to right; later non-null values win. */
export function mergeParams(...layers: (Partial<GenerationParams> | null | undefined)[]): GenerationParams {
  const result: GenerationParams = { ...DEFAULT_GENERATION };
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of Object.keys(result) as (keyof GenerationParams)[]) {
      const value = layer[key];
      if (value !== undefined && value !== null) (result as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export function modelKey(ref: { provider: string; model: string }): string {
  return `${ref.provider}:${ref.model}`;
}
