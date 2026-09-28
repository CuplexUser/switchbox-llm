import { DEFAULT_CHAT_FONT_ID, DEFAULT_CHAT_FONT_SIZE, DEFAULT_CHAT_LINE_HEIGHT } from './chatFonts.ts';
import type { AppSettings, GenerationParams, ModelInfo, ModelRef } from './types.ts';

export const MAX_PANES = 4;

export const DEFAULT_GENERATION: GenerationParams = {
  temperature: null,
  topP: null,
  maxTokens: null,
  reasoningEffort: null,
  thinkingBudget: null,
  aspectRatio: null,
  imageSize: null,
  imageQuality: null,
  voice: null,
  secondVoice: null,
  speechSpeed: null,
  speechStyle: null,
  audioFormat: null,
};

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    theme: 'system',
    density: 'comfortable',
    persistByDefault: true,
    sendOnEnter: true,
    titleModel: null,
    speechModel: null,
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

/** Providers whose TTS models can be recognized by a "tts" in the id when the model list isn't loaded. */
const SPEECH_PROVIDERS = new Set(['openai', 'openrouter', 'google']);

/** Speech panes answer with generated audio. The model list tags them; a "tts" id is enough on
 * providers with a speech endpoint, so a model typed in by id still works. */
export function isSpeechModel(ref: ModelRef, info: ModelInfo | null | undefined): boolean {
  if (info?.kind) return info.kind === 'speech';
  return SPEECH_PROVIDERS.has(ref.provider) && /(^|[-/_.])tts([-_.]|$)/i.test(ref.model);
}

/** Image panes answer with a generated image. Every non-speech model on the direct Google provider
 * is one; elsewhere the model list tags them. `info` is the listed model, when it is known. */
export function isImageModel(ref: ModelRef, info: ModelInfo | null | undefined): boolean {
  if (isSpeechModel(ref, info)) return false;
  return ref.provider === 'google' || info?.kind === 'image';
}
