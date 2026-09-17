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

/** How hard a reasoning model thinks. Providers that offer fewer levels get the nearest one. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface GenerationParams {
  /** Null means "use the provider default". */
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  reasoningEffort: ReasoningEffort | null;
  /** Tokens a model may spend thinking, for providers and models that take a fixed budget. */
  thinkingBudget: number | null;
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

/** auto: runs without asking. ask: waits for the user to approve each call. off: not offered to models. */
export type ToolPolicy = 'auto' | 'ask' | 'off';

/** How much of a reply's tool calls later turns see. summary: the calls and short excerpts of their results. */
export type KeepToolResults = 'full' | 'summary' | 'off';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  /** stdio only. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** http only: a Streamable HTTP endpoint. */
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  /** New chats start with this server's tools on. */
  useByDefault: boolean;
}

export interface AppSettings {
  general: {
    theme: ThemeMode;
    density: 'comfortable' | 'compact';
    persistByDefault: boolean;
    sendOnEnter: boolean;
    /** Writes chat titles. Null titles chats from the first line of the first message. */
    titleModel: ModelRef | null;
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
  };
  agent: {
    /** Tool-call rounds per reply before the model is asked to answer. */
    maxToolRounds: number;
    /** Tool calls from one round that run at the same time. */
    maxParallelTools: number;
    keepToolResults: KeepToolResults;
    /** Per-tool policy by tool name or group id. Tools not listed use their own default. */
    policies: Record<string, ToolPolicy>;
  };
  mcp: {
    servers: McpServerConfig[];
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
  /** Per-chat on/off for optional tool groups such as "code" or "mcp:<server id>". Missing groups use their default. */
  toolGroups: Record<string, boolean> | null;
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

/** One tool step. Emitted when it starts and again when it finishes, with the same id. */
export type ActivityItem =
  | { id: string; kind: 'search'; engine: SearchEngine; query: string; resultCount: number | null; done: boolean; error?: string }
  | { id: string; kind: 'fetch'; url: string; done: boolean; chars?: number; error?: string }
  | {
      id: string;
      kind: 'memory';
      action: 'save' | 'forget' | 'update' | 'list';
      content: string;
      done: boolean;
      error?: string;
    }
  | {
      id: string;
      kind: 'tool';
      name: string;
      /** Readable name, e.g. "Run JavaScript" or "github: create_issue". */
      label: string;
      /** The arguments as JSON, shortened. */
      args: string;
      /** The start of the result. */
      result?: string;
      /** waiting: the user has to approve the call. denied: the user refused it. */
      status?: 'waiting' | 'denied';
      done: boolean;
      error?: string;
    }
  | { id: string; kind: 'notice'; text: string; done: true };

export interface MessageActivity {
  items: ActivityItem[];
  sources: Source[];
}

export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface AttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
}

export interface Attachment extends AttachmentRef {
  conversationId: string | null;
  createdAt: string;
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
  attachments: AttachmentRef[] | null;
  /** The user marked this reply as the best one. */
  preferred: boolean | null;
  createdAt: string;
}

/** A system prompt, optionally with its own tools, round limit and generation settings. Called a profile in the app. */
export interface SystemPrompt {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  /** Tool group ids this profile may use, e.g. ["web", "code"]. Null allows every group. */
  tools: string[] | null;
  /** Overrides the tool round limit from Settings → Tools. */
  maxToolRounds: number | null;
  /** Layered between the Generation defaults and a pane's own settings. */
  params: Partial<GenerationParams> | null;
  createdAt: string;
  updatedAt: string;
}

/** manual: added on the Memory page. suggested: proposed after a reply. model: saved by a model with memory_save. */
export type MemorySource = 'manual' | 'suggested' | 'model';
/** forgotten: removed by a model with memory_forget, kept so it can be restored. */
export type MemoryStatus = 'active' | 'pending' | 'rejected' | 'forgotten';

export interface Memory {
  id: string;
  content: string;
  category: string;
  enabled: boolean;
  source: MemorySource;
  status: MemoryStatus;
  /** A profile (system prompt) id to limit the memory to chats using that profile. Null means every chat. */
  scope: string | null;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MemoryAction = 'created' | 'updated' | 'forgotten' | 'restored' | 'dismissed' | 'kept';
export type MemoryActor = 'user' | 'model' | 'suggestion';

export interface MemoryHistoryEntry {
  id: string;
  memoryId: string;
  action: MemoryAction;
  actor: MemoryActor;
  content: string;
  previousContent: string | null;
  createdAt: string;
}

export interface MemoryDuplicate {
  first: Memory;
  second: Memory;
  /** 0 to 1, how much of the wording the two share. */
  similarity: number;
}

export interface MemoryConflict {
  firstId: string;
  secondId: string;
  reason: string;
}

export interface SuggestionStatus {
  lastRunAt: string | null;
  lastAdded: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** A turn in a memory suggestion exchange. */
export interface ChatTurn {
  role: MessageRole;
  content: string;
}

/**
 * send: a new user message to every pane in `paneIds`.
 * regenerate: drop the replies after each pane's last user message and answer it again.
 * edit: replace the text of user message `messageId`, drop everything after it, and answer again (one pane).
 */
export type StreamAction = 'send' | 'regenerate' | 'edit';

export interface StreamRequest {
  runId: string;
  conversationId: string;
  action: StreamAction;
  /** The message text for send and edit. */
  content: string | null;
  attachmentIds?: string[];
  paneIds: string[];
  /** edit, with one pane: the user message to rewrite. */
  messageId?: string;
  /** edit, with several panes: the user message to rewrite in each pane, by pane id. */
  messageIds?: Record<string, string>;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  label: string;
  /** The call's arguments as formatted JSON. */
  arguments: string;
}

export type StreamEvent =
  | { type: 'user'; paneId: string; message: Message }
  /** Everything after `messageId` in the pane was removed. */
  | { type: 'truncate'; paneId: string; messageId: string }
  | { type: 'start'; paneId: string; messageId: string }
  | { type: 'delta'; paneId: string; text: string }
  | { type: 'reasoning'; paneId: string; text: string }
  | { type: 'activity'; paneId: string; item: ActivityItem }
  | { type: 'source'; paneId: string; source: Source }
  | { type: 'approval'; paneId: string; request: ApprovalRequest }
  | { type: 'approval_resolved'; paneId: string; id: string; approved: boolean }
  | { type: 'done'; paneId: string; message: Message }
  | { type: 'error'; paneId: string; error: string; message: Message | null }
  | { type: 'end' };

export interface PromptPreview {
  system: string;
  memoryCount: number;
  /** Tools offered to the model, e.g. web_search, web_fetch, memory_save. */
  tools: string[];
  /** How web search runs for this pane, or 'none' when the chat has web access off. */
  search: ResolvedSearch;
  searchNote: string | null;
  provider: ProviderId;
  model: string;
  params: GenerationParams;
  maxToolRounds: number;
}

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  group: string;
  /** The policy in effect: the saved one, or the tool's default. */
  policy: ToolPolicy;
  defaultPolicy: ToolPolicy;
}

export interface ToolGroupInfo {
  id: string;
  label: string;
  description: string;
  kind: 'builtin' | 'mcp';
  /** Whether new chats start with the group on. Web and memory follow their own chat toggles. */
  onByDefault: boolean;
  /** Set when the group has a chat toggle of its own, so the tools menu leaves it out. */
  toggledBy: 'webAccess' | 'useMemory' | null;
  tools: ToolInfo[];
  /** For MCP servers that could not be reached. */
  error: string | null;
}

export interface McpTestResult {
  ok: boolean;
  tools: { name: string; description: string }[];
  error: string | null;
}

export interface SearchHit {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  paneId: string;
  role: MessageRole;
  /** Text around the first match. */
  snippet: string;
  createdAt: string;
}

export interface ExportBundle {
  version: 1;
  exportedAt: string;
  conversations: Conversation[];
  panes: Pane[];
  messages: Message[];
  systemPrompts: SystemPrompt[];
  memories: Memory[];
  memoryHistory?: MemoryHistoryEntry[];
  /** File contents are base64. */
  attachments?: (Attachment & { data: string })[];
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
