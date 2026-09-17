import type { AppSettings, ProviderId } from '../../shared/types.ts';
import { fetchPage } from '../web/fetch.ts';
import { formatResults, nativeSearchSupport, planSearch } from '../web/search.ts';
import type { ToolDefinition, ToolGroup, ToolSource, WebPlan } from './types.ts';

/** Works out what web access a pane gets from the chat toggle, the search mode, the keys and the provider. */
export function planWeb(
  enabled: boolean,
  settings: AppSettings['web'],
  provider: ProviderId,
  model: string,
  keys?: { tavily: string | null; brave: string | null },
): WebPlan {
  if (!enabled) return { search: null, fetch: false, nativeSearch: false, resolved: 'none', note: null };

  const plan = planSearch(settings.searchMode, keys);
  let nativeSearch = false;
  let resolved = plan.resolved;
  let note = plan.problem;
  if (plan.resolved === 'native') {
    const support = nativeSearchSupport(provider, model);
    nativeSearch = support.supported;
    note = support.note;
    if (!support.supported) resolved = 'none';
  }
  return { search: plan.provider, fetch: settings.allowFetch, nativeSearch, resolved, note };
}

export function webGuidance(plan: WebPlan): string {
  const abilities: string[] = [];
  if (plan.search || plan.nativeSearch) abilities.push('search the web');
  if (plan.fetch) abilities.push('read web pages with web_fetch');
  if (abilities.length === 0) return '';
  return (
    `You can ${abilities.join(' and ')}. ` +
    'Use the web when the answer depends on current, niche or verifiable facts, not for things you already know well. ' +
    'Cite the sources you rely on inline as Markdown links.'
  );
}

export const WEB_SEARCH_TOOL: ToolDefinition = {
  group: 'web',
  label: 'Web search',
  defaultPolicy: 'auto',
  ownActivity: true,
  untrusted: true,
  spec: {
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
  },
  available: (environment) => Boolean(environment.web.search),
  async run(args, context) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const search = context.web.search;
    if (!search) return { content: 'Error: web search is not available in this chat.', isError: true };
    if (!query) return { content: 'Error: "query" is required.', isError: true };
    const limit = typeof args.max_results === 'number' ? args.max_results : context.settings.web.maxResults;
    const engine = search.name;
    const id = crypto.randomUUID();

    context.onActivity({ id, kind: 'search', engine, query, resultCount: null, done: false });
    try {
      const results = await search.search(query, Math.min(Math.max(limit, 1), 10), context.signal);
      for (const result of results) context.onSource({ url: result.url, title: result.title });
      context.onActivity({ id, kind: 'search', engine, query, resultCount: results.length, done: true });
      return { content: formatResults(query, engine, results), isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.onActivity({ id, kind: 'search', engine, query, resultCount: null, done: true, error: message });
      return { content: `Error searching for "${query}": ${message}`, isError: true };
    }
  },
};

export const WEB_FETCH_TOOL: ToolDefinition = {
  group: 'web',
  label: 'Read a web page',
  defaultPolicy: 'auto',
  ownActivity: true,
  untrusted: true,
  spec: {
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
  },
  available: (environment) => environment.web.fetch,
  async run(args, context) {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!context.web.fetch) return { content: 'Error: reading web pages is turned off.', isError: true };
    if (!url) return { content: 'Error: "url" is required.', isError: true };
    const id = crypto.randomUUID();

    context.onActivity({ id, kind: 'fetch', url, done: false });
    try {
      const page = await fetchPage(url, context.signal);
      context.onSource({ url: page.url, title: page.title ?? page.url });
      context.onActivity({ id, kind: 'fetch', url, done: true, chars: page.text.length });
      const header = `${page.title ? `${page.title}\n` : ''}URL: ${page.url}\n\n`;
      const note = page.truncated ? `\n\n[Truncated to the first ${page.text.length} characters]` : '';
      return { content: `${header}${page.text || '(The page has no readable text.)'}${note}`, isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.onActivity({ id, kind: 'fetch', url, done: true, error: message });
      return { content: `Error fetching ${url}: ${message}`, isError: true };
    }
  },
};

export const WEB_GROUP: ToolGroup = {
  id: 'web',
  label: 'Web',
  description: 'Search the web and read pages. Follows each chat’s Web toggle.',
  kind: 'builtin',
  onByDefault: true,
  toggledBy: 'webAccess',
};

export function webTools(): ToolSource {
  return {
    groups: async () => [WEB_GROUP],
    tools: async () => [WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
  };
}
