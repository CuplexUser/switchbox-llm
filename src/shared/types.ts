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

/**
 * auto: Tavily if its key is set, else Brave, else native.
 * tavily / brave: a local web_search tool backed by that API.
 * native: the model's own provider searches server-side.
 * none: no web search (web_fetch can still be allowed).
 */
export type SearchMode = 'auto' | 'tavily' | 'brave' | 'native' | 'none';
export type SearchEngine = 'tavily' | 'brave' | 'native';
export type ResolvedSearch = SearchEngine | 'none';

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
  web: {
    searchMode: SearchMode;
    /** New chats start with web access on. */
    useByDefault: boolean;
    /** Lets models read pages with web_fetch. */
    allowFetch: boolean;
    maxResults: number;
    /** Tool-call rounds per reply before the model is asked to answer. */
    maxToolRounds: number;
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

export interface WebStatus {
  tavilyKey: boolean;
  braveKey: boolean;
  mode: SearchMode;
  /** What `mode` resolves to with the keys that are set. */
  resolved: ResolvedSearch;
  /** Set when the chosen mode can't work, e.g. Tavily selected without a key. */
  problem: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  persist: boolean;
  useMemory: boolean;
  webAccess: boolean;
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

export interface Source {
  url: string;
  title: string;
}

/** One tool step: web research or a memory change. Emitted when it starts and again when it finishes, with the same id. */
export type ActivityItem =
  | { id: string; kind: 'search'; engine: SearchEngine; query: string; resultCount: number | null; done: boolean; error?: string }
  | { id: string; kind: 'fetch'; url: string; done: boolean; chars?: number; error?: string }
  | { id: string; kind: 'memory'; action: 'save' | 'forget'; content: string; done: boolean; error?: string }
  | { id: string; kind: 'notice'; text: string; done: true };

export interface MessageActivity {
  items: ActivityItem[];
  sources: Source[];
}

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
  activity: MessageActivity | null;
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

/** manual: added on the Memory page. suggested: proposed after a reply. model: saved by a model with memory_save. */
export type MemorySource = 'manual' | 'suggested' | 'model';
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
  | { type: 'activity'; paneId: string; item: ActivityItem }
  | { type: 'source'; paneId: string; source: Source }
  | { type: 'done'; paneId: string; message: Message }
  | { type: 'error'; paneId: string; error: string; message: Message | null }
  | { type: 'end' };

export interface PromptPreview {
  system: string;
  memoryCount: number;
  /** Local tools offered to the model, e.g. web_search, web_fetch, memory_save. */
  tools: string[];
  /** How web search runs for this pane, or 'none' when the chat has web access off. */
  search: ResolvedSearch;
  searchNote: string | null;
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

export type UsageRange = '7d' | '30d' | '90d' | 'all';
export type UsageMetric = 'tokens' | 'cost' | 'replies';

/**
 * reported: the provider said what it charged. estimated: worked out from list prices.
 * local: a model running on this machine. unknown: no price could be found.
 */
export type CostKind = 'reported' | 'estimated' | 'local' | 'unknown';

export interface UsageTotals {
  replies: number;
  failed: number;
  chats: number;
  tokensIn: number;
  tokensOut: number;
  /** Reported plus estimated. */
  cost: number;
  reportedCost: number;
  estimatedCost: number;
  /** Replies with tokens but no price to estimate from. */
  unpricedReplies: number;
  medianTtftMs: number | null;
  medianTokensPerSecond: number | null;
}

export interface UsageBucket {
  /** Local date the bucket starts on, YYYY-MM-DD. */
  date: string;
  tokens: number;
  cost: number;
  replies: number;
}

export interface UsageModelRow extends UsageTotals {
  provider: ProviderId;
  model: string;
  costKind: CostKind;
}

export interface UsageReport {
  range: UsageRange;
  /** Days for short ranges; weeks when "all" spans too long for one bar a day. */
  bucket: 'day' | 'week';
  buckets: UsageBucket[];
  totals: UsageTotals;
  models: UsageModelRow[];
  /** Providers with usage in the range, for the filter. */
  providers: ProviderId[];
}
