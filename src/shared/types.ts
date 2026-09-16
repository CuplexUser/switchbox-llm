export const PROVIDER_IDS = ['openrouter', 'openai', 'anthropic', 'ollama', 'lmstudio', 'custom'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Custom endpoint',
};

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface ModelInfo extends ModelRef {
  name: string;
  contextLength?: number;
  /** USD per million tokens. */
  pricing?: { input: number; output: number };
}

export interface GenerationParams {
  /** Null means "use the provider default". */
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ProviderSettings {
  enabled: boolean;
  baseUrl: string;
}

export interface AppSettings {
  general: {
    theme: ThemeMode;
    density: 'comfortable' | 'compact';
    persistByDefault: boolean;
    sendOnEnter: boolean;
  };
  providers: Record<ProviderId, ProviderSettings>;
  favorites: ModelRef[];
  generation: GenerationParams;
  defaults: {
    panes: ModelRef[];
  };
  memory: {
    useByDefault: boolean;
    autoSuggest: boolean;
    suggestionModel: ModelRef | null;
    maxInjected: number;
  };
}

export type SettingsSection = keyof AppSettings;

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  enabled: boolean;
  baseUrl: string;
  requiresKey: boolean;
  keyConfigured: boolean;
  /** True when the provider can be called: enabled and, where needed, keyed. */
  ready: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  persist: boolean;
  useMemory: boolean;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Pane {
  id: string;
  conversationId: string;
  position: number;
  provider: ProviderId;
  model: string;
  systemPromptId: string | null;
  systemPrompt: string | null;
  params: Partial<GenerationParams>;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends Conversation {
  panes: Pane[];
}

export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: string;
  conversationId: string;
  paneId: string;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  provider: ProviderId | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  ttftMs: number | null;
  latencyMs: number | null;
  cost: number | null;
  finishReason: string | null;
  error: string | null;
  createdAt: string;
}

export interface SystemPrompt {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MemorySource = 'manual' | 'suggested';
export type MemoryStatus = 'active' | 'pending' | 'rejected';

export interface Memory {
  id: string;
  content: string;
  category: string;
  enabled: boolean;
  source: MemorySource;
  status: MemoryStatus;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A turn sent to a provider. */
export interface ChatTurn {
  role: MessageRole;
  content: string;
}

export interface StreamTarget {
  paneId: string;
  /** Prior turns for this pane, oldest first, not including the new user message. */
  history: ChatTurn[];
}

export interface StreamRequest {
  runId: string;
  conversationId: string;
  /** The new user message. Null regenerates the last reply from `history` as-is. */
  content: string | null;
  targets: StreamTarget[];
}

export type StreamEvent =
  | { type: 'user'; paneId: string; message: Message }
  | { type: 'start'; paneId: string; messageId: string }
  | { type: 'delta'; paneId: string; text: string }
  | { type: 'reasoning'; paneId: string; text: string }
  | { type: 'done'; paneId: string; message: Message }
  | { type: 'error'; paneId: string; error: string; message: Message | null }
  | { type: 'end' };

export interface PromptPreview {
  system: string;
  memoryCount: number;
  provider: ProviderId;
  model: string;
  params: GenerationParams;
}

export interface ExportBundle {
  version: 1;
  exportedAt: string;
  conversations: Conversation[];
  panes: Pane[];
  messages: Message[];
  systemPrompts: SystemPrompt[];
  memories: Memory[];
  settings: Partial<AppSettings>;
}
