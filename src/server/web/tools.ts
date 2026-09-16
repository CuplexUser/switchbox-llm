import { randomUUID } from 'node:crypto';
import type { ActivityItem, AppSettings, Source } from '../../shared/types.ts';
import type { ToolCall, ToolSpec } from '../providers/types.ts';
import { fetchPage } from './fetch.ts';
import { formatResults, type SearchProvider } from './search.ts';

export const WEB_SEARCH_TOOL: ToolSpec = {
  name: 'web_search',
  description:
    'Search the web for current or specific information. Returns numbered results with titles, URLs and text excerpts. ' +
    'Use focused queries, and search again with different wording if the results miss. Read a result in full with web_fetch when the excerpt is not enough.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'How many results to return (default 5)' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export const WEB_FETCH_TOOL: ToolSpec = {
  name: 'web_fetch',
  description:
    'Fetch a public web page or text file by URL and return its readable text, with markup removed. ' +
    'Use it to read a search result in full or a URL from the conversation. Long pages are truncated.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL' },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolContext {
  search: SearchProvider | null;
  settings: AppSettings['web'];
  signal: AbortSignal;
  /** Called when a step starts and again when it finishes, with the same item id. */
  onActivity: (item: ActivityItem) => void;
  onSource: (source: Source) => void;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error(`The arguments were not valid JSON: ${raw.slice(0, 200)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runTool(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  const id = randomUUID();
  let args: Record<string, unknown>;
  try {
    args = parseArguments(call.arguments);
  } catch (error) {
    return { content: `Error: ${errorText(error)}`, isError: true };
  }

  if (call.name === WEB_SEARCH_TOOL.name) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!context.search) return { content: 'Error: web search is not available in this chat.', isError: true };
    if (!query) return { content: 'Error: "query" is required.', isError: true };
    const requested = typeof args.max_results === 'number' ? Math.round(args.max_results) : context.settings.maxResults;
    const limit = Math.min(Math.max(requested, 1), 10);
    const engine = context.search.name;

    context.onActivity({ id, kind: 'search', engine, query, resultCount: null, done: false });
    try {
      const results = await context.search.search(query, limit, context.signal);
      for (const result of results) context.onSource({ url: result.url, title: result.title });
      context.onActivity({ id, kind: 'search', engine, query, resultCount: results.length, done: true });
      return { content: formatResults(query, engine, results), isError: false };
    } catch (error) {
      context.onActivity({ id, kind: 'search', engine, query, resultCount: null, done: true, error: errorText(error) });
      return { content: `Error searching for "${query}": ${errorText(error)}`, isError: true };
    }
  }

  if (call.name === WEB_FETCH_TOOL.name) {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!context.settings.allowFetch) return { content: 'Error: reading web pages is turned off.', isError: true };
    if (!url) return { content: 'Error: "url" is required.', isError: true };

    context.onActivity({ id, kind: 'fetch', url, done: false });
    try {
      const page = await fetchPage(url, context.signal);
      context.onSource({ url: page.url, title: page.title ?? page.url });
      context.onActivity({ id, kind: 'fetch', url, done: true, chars: page.text.length });
      const header = `${page.title ? `${page.title}\n` : ''}URL: ${page.url}\n\n`;
      const note = page.truncated ? `\n\n[Truncated to the first ${page.text.length} characters]` : '';
      return { content: `${header}${page.text || '(The page has no readable text.)'}${note}`, isError: false };
    } catch (error) {
      context.onActivity({ id, kind: 'fetch', url, done: true, error: errorText(error) });
      return { content: `Error fetching ${url}: ${errorText(error)}`, isError: true };
    }
  }

  return { content: `Error: unknown tool "${call.name}".`, isError: true };
}
