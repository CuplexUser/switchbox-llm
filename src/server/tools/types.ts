import type { ActivityItem, AppSettings, AttachmentRef, ResolvedSearch, Source, ToolGroupToggle, ToolPolicy } from '../../shared/types.ts';
import type { ConversationRow } from '../db/schemas.ts';
import type { ToolSpec } from '../providers/types.ts';
import type { SearchProvider } from '../web/search.ts';

/** What web access a pane gets, from the chat toggle, the search mode, the keys and the provider. */
export interface WebPlan {
  /** Set when web_search runs locally through Tavily or Brave. */
  search: SearchProvider | null;
  /** web_fetch is offered. */
  fetch: boolean;
  /** The provider searches on its own servers. */
  nativeSearch: boolean;
  resolved: ResolvedSearch;
  /** Shown to the user when web access is on but search can't run as chosen. */
  note: string | null;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

/** What decides whether a tool is offered for one reply. */
export interface ToolEnvironment {
  conversation: ConversationRow;
  settings: AppSettings;
  web: WebPlan;
  /** Tool groups the pane's profile allows. Null allows every group. */
  profileTools: string[] | null;
  /** Attachments in the pane's history, for read_attachment. */
  attachments: AttachmentRef[];
}

export interface ToolRunContext {
  conversationId: string;
  /** A real folder on this computer the chat's workspace is bound to, instead of its own hidden folder. */
  hostFolderPath: string | null;
  paneId: string;
  settings: AppSettings;
  web: WebPlan;
  attachments: AttachmentRef[];
  signal: AbortSignal;
  /** Called when a step starts and again when it finishes, with the same item id. */
  onActivity: (item: ActivityItem) => void;
  onSource: (source: Source) => void;
}

export interface ToolDefinition {
  spec: ToolSpec;
  /** The group id the tool belongs to, e.g. "web" or "mcp:github". */
  group: string;
  /** Readable name for activity and approval prompts. */
  label: string;
  defaultPolicy: ToolPolicy;
  /** The tool reports its own activity items. Other tools get a generic "tool" item. */
  ownActivity?: boolean;
  /** Output comes from outside Switchbox (web pages, MCP servers) and may contain instructions. */
  untrusted?: boolean;
  /** Extra checks beyond the group being on, e.g. a search key being set. */
  available?(environment: ToolEnvironment): boolean;
  run(args: Record<string, unknown>, context: ToolRunContext): Promise<ToolResult>;
}

export interface ToolGroup {
  id: string;
  label: string;
  description: string;
  kind: 'builtin' | 'mcp';
  onByDefault: boolean;
  /** A chat switch that turns the group on and off, instead of the tools menu. */
  toggledBy: ToolGroupToggle | null;
  /** A chat switch that must also be on, e.g. commands need the workspace. */
  requires?: ToolGroupToggle;
}

/** Supplies tools and their groups. Built-in tools are fixed; MCP servers change with settings. */
export interface ToolSource {
  groups(settings: AppSettings): Promise<ToolGroup[]>;
  tools(settings: AppSettings): Promise<ToolDefinition[]>;
  /** A problem to show for a group, such as an MCP server that could not start. */
  groupError?(groupId: string): string | null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
