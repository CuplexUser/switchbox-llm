import { PROVIDER_LABELS, type ProviderId, type ResolvedSearch, type SearchMode, type WebStatus } from '../../shared/types.ts';
import { searchKeys } from '../env.ts';

export interface SearchResult {
  title: string;
  url: string;
  /** Tavily returns a summarized passage; Brave returns the short results-page description. */
  snippet: string;
}

export interface SearchProvider {
  readonly name: 'tavily' | 'brave';
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
/** Brave rejects larger counts rather than clamping them. */
const BRAVE_MAX_COUNT = 20;

async function failure(label: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');
  return new Error(`${label} search failed: HTTP ${response.status} ${body.slice(0, 300)}`.trim());
}

export function createTavilyProvider(apiKey: string): SearchProvider {
  return {
    name: 'tavily',
    async search(query, limit, signal) {
      const response = await fetch(TAVILY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_answer: false }),
        signal,
      });
      if (!response.ok) throw await failure('Tavily', response);
      const body = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
      return (body.results ?? [])
        .filter((hit): hit is { title?: string; url: string; content?: string } => Boolean(hit.url))
        .map((hit) => ({ title: hit.title || hit.url, url: hit.url, snippet: hit.content ?? '' }));
    },
  };
}

/** Brave wraps matched terms in <strong>. */
function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

export function createBraveProvider(apiKey: string): SearchProvider {
  return {
    name: 'brave',
    async search(query, limit, signal) {
      const url = new URL(BRAVE_ENDPOINT);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(limit, BRAVE_MAX_COUNT)));
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal,
      });
      if (!response.ok) throw await failure('Brave', response);
      const body = (await response.json()) as {
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      return (body.web?.results ?? [])
        .filter((hit): hit is { title?: string; url: string; description?: string } => Boolean(hit.url))
        .map((hit) => ({
          title: stripTags(hit.title || hit.url),
          url: hit.url,
          snippet: stripTags(hit.description ?? ''),
        }));
    },
  };
}

export interface SearchPlan {
  resolved: ResolvedSearch;
  /** Set for tavily and brave only. */
  provider: SearchProvider | null;
  problem: string | null;
}

/** Decides how search runs from the chosen mode and the keys in .env. auto: Tavily, then Brave, then native. */
export function planSearch(mode: SearchMode, keys = searchKeys()): SearchPlan {
  switch (mode) {
    case 'tavily':
      return keys.tavily
        ? { resolved: 'tavily', provider: createTavilyProvider(keys.tavily), problem: null }
        : { resolved: 'none', provider: null, problem: 'Tavily is selected but TAVILY_API_KEY is not set in .env.' };
    case 'brave':
      return keys.brave
        ? { resolved: 'brave', provider: createBraveProvider(keys.brave), problem: null }
        : { resolved: 'none', provider: null, problem: 'Brave is selected but BRAVE_API_KEY is not set in .env.' };
    case 'native':
      return { resolved: 'native', provider: null, problem: null };
    case 'none':
      return { resolved: 'none', provider: null, problem: null };
    case 'auto':
      if (keys.tavily) return { resolved: 'tavily', provider: createTavilyProvider(keys.tavily), problem: null };
      if (keys.brave) return { resolved: 'brave', provider: createBraveProvider(keys.brave), problem: null };
      return { resolved: 'native', provider: null, problem: null };
  }
}

export function webStatus(mode: SearchMode): WebStatus {
  const keys = searchKeys();
  const plan = planSearch(mode, keys);
  return {
    tavilyKey: Boolean(keys.tavily),
    braveKey: Boolean(keys.brave),
    mode,
    resolved: plan.resolved,
    problem: plan.problem,
  };
}

/** Providers that can search server-side, and what to tell the user about the others. */
export function nativeSearchSupport(provider: ProviderId, model: string): { supported: boolean; note: string | null } {
  switch (provider) {
    case 'openrouter':
    case 'anthropic':
      return { supported: true, note: null };
    case 'openai':
      return {
        supported: true,
        note: /search/i.test(model)
          ? null
          : 'OpenAI only searches on its search-enabled models, so this model may answer without searching.',
      };
    default:
      return { supported: false, note: `${PROVIDER_LABELS[provider]} has no built-in web search.` };
  }
}

export function formatResults(query: string, engine: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  const lines = results.map(
    (hit, index) => `[${index + 1}] ${hit.title}\nURL: ${hit.url}\n${hit.snippet.replace(/\s+/g, ' ').trim()}`,
  );
  return `Search results for "${query}" (${engine}):\n\n${lines.join('\n\n')}`;
}
