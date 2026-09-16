import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/defaults.ts';
import { addMissingColumns } from '../db/migrate.ts';
import { conversationSchema, messageSchema } from '../db/schemas.ts';
import { memoryRepos } from '../db/repos.ts';
import { planWeb } from '../services/chat.ts';
import { seedSamplePrompts } from '../services/seed.ts';
import { assertPublicUrl, htmlToText, isPrivateAddress } from './fetch.ts';
import { createBraveProvider, createTavilyProvider, formatResults, planSearch } from './search.ts';
import { runTool } from './tools.ts';

afterEach(() => vi.unstubAllGlobals());

const NO_KEYS = { tavily: null, brave: null };

describe('planSearch', () => {
  it('resolves auto as Tavily, then Brave, then native', () => {
    expect(planSearch('auto', { tavily: 't', brave: 'b' }).resolved).toBe('tavily');
    expect(planSearch('auto', { tavily: null, brave: 'b' }).resolved).toBe('brave');
    expect(planSearch('auto', NO_KEYS).resolved).toBe('native');
  });

  it('reports a problem when an explicit engine has no key', () => {
    const plan = planSearch('brave', NO_KEYS);
    expect(plan.resolved).toBe('none');
    expect(plan.problem).toContain('BRAVE_API_KEY');
    expect(planSearch('none', { tavily: 't', brave: 'b' }).resolved).toBe('none');
  });
});

describe('planWeb', () => {
  const web = DEFAULT_SETTINGS.web;

  it('offers nothing when the chat has web access off', () => {
    expect(planWeb(false, web, 'openai', 'gpt-5', { tavily: 't', brave: null }).tools).toEqual([]);
  });

  it('offers web_search and web_fetch with a search key', () => {
    const plan = planWeb(true, web, 'ollama', 'llama3', { tavily: 't', brave: null });
    expect(plan.tools.map((tool) => tool.name)).toEqual(['web_search', 'web_fetch']);
    expect(plan.nativeSearch).toBe(false);
  });

  it('uses native search on providers that have it, and explains when they do not', () => {
    const native = planWeb(true, { ...web, searchMode: 'native' }, 'anthropic', 'claude-opus-5', NO_KEYS);
    expect(native.nativeSearch).toBe(true);
    expect(native.tools.map((tool) => tool.name)).toEqual(['web_fetch']);

    const openai = planWeb(true, { ...web, searchMode: 'native' }, 'openai', 'gpt-5', NO_KEYS);
    expect(openai.note).toContain('search-enabled');

    const local = planWeb(true, { ...web, searchMode: 'auto', allowFetch: false }, 'lmstudio', 'qwen', NO_KEYS);
    expect(local).toMatchObject({ nativeSearch: false, resolved: 'none', tools: [] });
    expect(local.note).toContain('no built-in web search');
  });
});

describe('search providers', () => {
  it('calls Tavily with a bearer key and maps results', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [{ title: 'T', url: 'https://t.test', content: 'passage' }, { title: 'no url' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const results = await createTavilyProvider('tvly-key').search('q', 3);
    expect(results).toEqual([{ title: 'T', url: 'https://t.test', snippet: 'passage' }]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tvly-key');
    expect(JSON.parse(init.body as string)).toMatchObject({ query: 'q', max_results: 3 });
  });

  it('calls Brave, clamps the count and strips highlight tags', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ web: { results: [{ title: '<strong>B</strong>', url: 'https://b.test', description: 'a <strong>b</strong>' }] } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const results = await createBraveProvider('key').search('q', 50);
    expect(results).toEqual([{ title: 'B', url: 'https://b.test', snippet: 'a b' }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('count=20');
  });

  it('formats results for the model', () => {
    expect(formatResults('q', 'brave', [])).toBe('No results for "q".');
    expect(formatResults('q', 'tavily', [{ title: 'T', url: 'https://t.test', snippet: 'a\n b' }])).toContain(
      '[1] T\nURL: https://t.test\na b',
    );
  });
});

describe('fetch helpers', () => {
  it('extracts readable text and the title from HTML', () => {
    const { title, text } = htmlToText(
      '<html><head><title>Hi &amp; bye</title><style>x{}</style></head><body><script>alert(1)</script><h1>Head</h1><p>One&nbsp;two</p><ul><li>a</li></ul></body></html>',
    );
    expect(title).toBe('Hi & bye');
    expect(text).toBe('Head\n\nOne two\n\n- a');
  });

  it('recognizes private and loopback addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect({ address, isPrivate: isPrivateAddress(address) }).toEqual({ address, isPrivate: true });
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect({ address, isPrivate: isPrivateAddress(address) }).toEqual({ address, isPrivate: false });
    }
  });

  it('refuses local URLs and non-http schemes', async () => {
    await expect(assertPublicUrl('http://localhost:8787/api')).rejects.toThrow('local');
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow('private');
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow('private');
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow('http');
  });

  it('reports tool errors back to the model instead of throwing', async () => {
    const items: unknown[] = [];
    const result = await runTool(
      { id: '1', name: 'web_fetch', arguments: '{"url":"http://127.0.0.1:8787/api/settings"}' },
      {
        search: null,
        settings: DEFAULT_SETTINGS.web,
        signal: new AbortController().signal,
        onActivity: (item) => items.push(item),
        onSource: () => {},
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('private');
    expect(items).toHaveLength(2);
  });
});

describe('addMissingColumns', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('adds new columns to an existing table with defaults for NOT NULL ones', () => {
    dir = mkdtempSync(join(tmpdir(), 'switchbox-migrate-'));
    const file = join(dir, 'test.db');
    const db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, persist INTEGER NOT NULL, use_memory INTEGER NOT NULL, pinned INTEGER NOT NULL, archived INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
    );
    db.exec("INSERT INTO conversations VALUES ('c1', 't', 1, 1, 0, 0, 'x', 'x')");
    db.close();

    const added = addMissingColumns(file, [
      { table: 'conversations', schema: conversationSchema, defaults: { web_access: '1' } },
      { table: 'messages', schema: messageSchema },
    ]);
    expect(added).toEqual(['conversations.web_access']);

    const check = new DatabaseSync(file);
    expect(check.prepare('SELECT web_access FROM conversations').get()).toEqual({ web_access: 1 });
    check.close();
    expect(addMissingColumns(file, [{ table: 'conversations', schema: conversationSchema, defaults: { web_access: '1' } }])).toEqual([]);
  });
});

describe('seedSamplePrompts', () => {
  it('adds the starter prompts once, with one default', async () => {
    const repos = memoryRepos();
    expect(await seedSamplePrompts(repos)).toBe(2);
    const prompts = await repos.systemPrompts.findMany();
    expect(prompts.filter((prompt) => prompt.isDefault)).toHaveLength(1);

    await repos.systemPrompts.deleteMany();
    expect(await seedSamplePrompts(repos)).toBe(0);
    expect(await repos.systemPrompts.count()).toBe(0);
  });
});
