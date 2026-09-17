import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/defaults.ts';
import type { ActivityItem } from '../../shared/types.ts';
import { ProviderError } from '../providers/types.ts';
import { cleanTitle, mapLimit, titleFrom } from './chat.ts';
import { buildSystemPrompt, parseSuggestions, rankFacts, similarity } from './memory.ts';
import { mergeDefaults } from './settings.ts';
import { doneMessage, FakeProvider, seedConversation, send, setup } from './testing.ts';

const toolNames = (request: { tools?: { name: string }[] } | undefined) => (request?.tools ?? []).map((tool) => tool.name);

describe('helpers', () => {
  it('builds a system prompt with a memory block', () => {
    expect(buildSystemPrompt('Base', [])).toBe('Base');
    const prompt = buildSystemPrompt('Base', [
      { content: 'Likes tea', category: 'preferences' },
      { content: 'Lives in Oslo', category: 'general' },
    ]);
    expect(prompt).toContain('Base\n\n<memory>');
    expect(prompt).toContain('- [preferences] Likes tea');
    expect(prompt).toContain('- Lives in Oslo');
  });

  it('parses suggestions out of fenced or chatty replies', () => {
    expect(parseSuggestions('Sure!\n```json\n[{"content":"Uses Vim","category":"Tools"}]\n```')).toEqual([
      { content: 'Uses Vim', category: 'tools' },
    ]);
    expect(parseSuggestions('nothing here')).toEqual([]);
    expect(parseSuggestions('["Plain string fact"]')).toEqual([{ content: 'Plain string fact', category: 'general' }]);
  });

  it('titles chats and merges settings defaults', () => {
    expect(titleFrom('  Explain\nmonads please')).toBe('Explain');
    expect(titleFrom('x'.repeat(80))).toHaveLength(58);
    expect(cleanTitle('"Monads in Haskell."\n')).toBe('Monads in Haskell');
    expect(cleanTitle('Title: Trip planning')).toBe('Trip planning');
    expect(mergeDefaults({ a: 1, nested: { b: 2, c: 3 } }, { nested: { b: 5 } })).toEqual({ a: 1, nested: { b: 5, c: 3 } });
  });

  it('limits how many tasks run at once and keeps result order', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([30, 10, 20, 5], 2, async (ms, index) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });
});

function at(day: number): Date {
  return new Date(2026, 0, day);
}

describe('memory relevance', () => {
  const facts = [
    { content: 'Prefers metric units', category: 'preferences', updatedAt: at(5) },
    { content: 'Lives in Oslo', category: 'background', updatedAt: at(1) },
    { content: 'Works on a Rust compiler', category: 'projects', updatedAt: at(3) },
  ];

  it('keeps everything, newest first, when under the limit', () => {
    expect(rankFacts(facts, 'anything', 5).map((fact) => fact.content)).toEqual([
      'Prefers metric units',
      'Works on a Rust compiler',
      'Lives in Oslo',
    ]);
  });

  it('picks the facts that share words with the message when over the limit', () => {
    expect(rankFacts(facts, 'What is the weather in Oslo today?', 1).map((fact) => fact.content)).toEqual(['Lives in Oslo']);
    expect(rankFacts(facts, 'hello', 2).map((fact) => fact.content)).toEqual(['Prefers metric units', 'Works on a Rust compiler']);
  });

  it('scores wording overlap', () => {
    expect(similarity('Lives in Oslo', 'lives in oslo!')).toBe(1);
    expect(similarity('Likes tea', 'Drives a van')).toBe(0);
  });
});

describe('SettingsService', () => {
  it('stores sections and fills in new defaults', async () => {
    const { settings } = setup(new FakeProvider(() => []));
    await settings.set('memory', { useByDefault: false, autoSuggest: true, suggestionModel: null, maxInjected: 5 });
    const all = await settings.getAll();
    expect(all.memory.maxInjected).toBe(5);
    expect(all.general.sendOnEnter).toBe(true);
    expect(all.agent.maxToolRounds).toBe(6);
  });
});

describe('ChatService', () => {
  it('streams a reply, injects memories and persists both messages', async () => {
    const provider = new FakeProvider(() => [
      { type: 'text', text: 'Hi ' },
      { type: 'text', text: 'there' },
      { type: 'usage', inputTokens: 12, outputTokens: 2 },
      { type: 'finish', reason: 'stop' },
    ]);
    const services = setup(provider);
    const { repos } = services;
    const { conversation, pane } = await seedConversation(repos);
    const memory = { category: 'general', enabled: true, scope: null, sourceConversationId: null };
    await repos.memories.create({ ...memory, content: 'Name is Sam', source: 'manual', status: 'active' });
    await repos.memories.create({ ...memory, content: 'Pending fact', source: 'suggested', status: 'pending' });

    const events = await send(services, conversation.id, [pane.id], 'Hello');

    const request = provider.requests[0];
    expect(request?.system).toContain('You are terse.');
    expect(request?.system).toContain('Name is Sam');
    expect(request?.system).not.toContain('Pending fact');
    expect(request?.params.temperature).toBe(0.3);
    expect(request?.messages).toEqual([{ role: 'user', content: 'Hello' }]);

    const message = doneMessage(events);
    expect(message?.content).toBe('Hi there');
    expect(message?.tokensOut).toBe(2);
    expect(message).not.toHaveProperty('trace');

    const stored = await repos.messages.findMany({ where: { conversationId: conversation.id } });
    expect(stored.map((row) => row.role).toSorted()).toEqual(['assistant', 'user']);
    expect((await repos.conversations.findById(conversation.id))?.title).toBe('Hello');
  });

  it('keeps temporary chats in memory and reports provider errors per pane', async () => {
    const provider = new FakeProvider(() => {
      throw new Error('boom');
    });
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { persist: false, useMemory: false });

    const events = await send(services, conversation.id, [pane.id], 'Hello');

    expect(events.map((event) => event.type)).toEqual(['user', 'start', 'error']);
    expect(await services.repos.messages.count()).toBe(0);
    expect((await services.store.list(conversation, pane.id)).map((row) => row.role)).toEqual(['user', 'assistant']);
  });

  it('marks a stopped pane as aborted and keeps the partial text', async () => {
    const controllers = new Map<string, AbortController>();
    const provider = new FakeProvider(() => {
      controllers.values().next().value?.abort();
      return [{ type: 'text', text: 'never' }];
    });
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos);

    const events = await send(services, conversation.id, [pane.id], 'Go', {}, controllers);
    expect(doneMessage(events)?.finishReason).toBe('aborted');
  });

  it('uses the title model when one is set', async () => {
    const provider = new FakeProvider((request) =>
      request.system.startsWith('Write a short title') ? [{ type: 'text', text: '"Planning a trip to Oslo."' }] : [{ type: 'text', text: 'Sure.' }],
    );
    const services = setup(provider);
    await services.settings.set('general', { ...DEFAULT_SETTINGS.general, titleModel: { provider: 'openrouter', model: 'cheap' } });
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });
    await send(services, conversation.id, [pane.id], 'I want to plan a trip to Oslo next month');
    expect((await services.repos.conversations.findById(conversation.id))?.title).toBe('Planning a trip to Oslo');
  });
});

describe('ChatService web tools', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('runs web_search through Tavily, feeds results back and records activity and sources', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
    vi.stubEnv('BRAVE_API_KEY', '');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({ results: [{ title: 'Yr', url: 'https://yr.test/oslo', content: 'Sunny, 21 degrees' }] }),
      ),
    );
    const provider = new FakeProvider((request) =>
      request.messages.some((message) => message.role === 'tool')
        ? [{ type: 'text', text: 'Sunny.' }]
        : [
            { type: 'text', text: 'Let me check.' },
            { type: 'usage', inputTokens: 10, outputTokens: 3 },
            { type: 'tool_call', call: { id: 'c1', name: 'web_search', arguments: '{"query":"Oslo weather"}' } },
          ],
    );
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false, webAccess: true });

    const events = await send(services, conversation.id, [pane.id], 'Weather in Oslo?');

    expect(provider.requests).toHaveLength(2);
    expect(toolNames(provider.requests[0])).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
    expect(provider.requests[0]?.system).toContain("Today's date is");
    expect(provider.requests[0]?.system).toContain('<tool_output>');
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.role === 'tool' && toolMessage.content).toContain('Sunny, 21 degrees');
    expect(toolMessage?.role === 'tool' && toolMessage.content).toMatch(/^<tool_output tool="web_search">/);

    const message = doneMessage(events);
    expect(message?.content).toBe('Let me check.\n\nSunny.');
    expect(message?.tokensIn).toBe(10);
    expect(message?.activity?.items).toMatchObject([{ kind: 'search', engine: 'tavily', query: 'Oslo weather', resultCount: 1, done: true }]);
    expect(message?.activity?.sources).toEqual([{ url: 'https://yr.test/oslo', title: 'Yr' }]);
    expect(events.filter((event) => event.type === 'activity')).toHaveLength(2);

    const stored = await services.repos.messages.findById(message?.id ?? '');
    expect(stored?.activity).toEqual(message?.activity);
    expect(Array.isArray(stored?.trace)).toBe(true);
  });

  it('retries without tools when the model rejects them, and remembers it', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    const provider = new FakeProvider((request) => {
      if (request.tools?.length) throw new ProviderError('Ollama returned 400: model does not support tools', 400);
      return [{ type: 'text', text: 'Offline answer.' }];
    });
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { persist: false, useMemory: false, webAccess: true });

    const first = await send(services, conversation.id, [pane.id], 'Weather?');
    expect(doneMessage(first)?.content).toBe('Offline answer.');
    expect(doneMessage(first)?.activity?.items.map((item) => item.kind)).toEqual(['notice']);
    expect(provider.requests).toHaveLength(2);

    await send(services, conversation.id, [pane.id], 'And tomorrow?');
    // The second reply goes straight to a request without tools.
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.tools).toEqual([]);
  });

  it('stops calling tools after the round limit and asks for an answer', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    const provider = new FakeProvider(() => [
      { type: 'tool_call', call: { id: `c${Math.random()}`, name: 'web_fetch', arguments: '{"url":"http://127.0.0.1/"}' } },
    ]);
    const services = setup(provider);
    await services.settings.set('agent', { ...DEFAULT_SETTINGS.agent, maxToolRounds: 2 });
    const { conversation, pane } = await seedConversation(services.repos, { persist: false, useMemory: false, webAccess: true });

    await send(services, conversation.id, [pane.id], 'Read it');
    // Two real rounds, one round answered with the limit notice, then a final turn that is cut off.
    expect(provider.requests).toHaveLength(4);
    const last = provider.requests.at(-1)?.messages.at(-1);
    expect(last?.role === 'tool' && last.content).toContain('Tool limit reached');
  });
});

describe('ChatService memory tools', () => {
  it('offers memory tools with memory on, saves facts as active and dedupes across panes', async () => {
    const provider = new FakeProvider((request) =>
      request.messages.some((message) => message.role === 'tool')
        ? [{ type: 'text', text: 'Got it.' }]
        : [
            {
              type: 'tool_call',
              call: { id: 'm1', name: 'memory_save', arguments: '{"content":"Has a dog named Rex","category":"Background"}' },
            },
          ],
    );
    const services = setup(provider);
    const { repos } = services;
    const { conversation, pane } = await seedConversation(repos);
    const second = await repos.panes.create({ ...pane, id: undefined, position: 1 } as never);

    const events = await send(services, conversation.id, [pane.id, second.id], 'Remember that my dog is called Rex');

    expect(toolNames(provider.requests[0])).toEqual(expect.arrayContaining(['memory_save', 'memory_update', 'memory_forget', 'memory_list']));
    expect(provider.requests[0]?.system).toContain('long-term memory');
    const saved = await repos.memories.findMany();
    expect(saved).toMatchObject([{ content: 'Has a dog named Rex', category: 'background', source: 'model', status: 'active' }]);
    expect(await repos.memoryHistory.count({ where: { memoryId: saved[0]?.id ?? '' } })).toBe(1);
    expect(doneMessage(events)?.activity?.items).toMatchObject([{ kind: 'memory', action: 'save', done: true }]);
  });

  it('leaves memory tools out when the chat has memory off', async () => {
    const provider = new FakeProvider(() => [{ type: 'text', text: 'Hi' }]);
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { persist: false, useMemory: false });
    await send(services, conversation.id, [pane.id], 'Hi');
    expect(toolNames(provider.requests[0]).some((name) => name.startsWith('memory_'))).toBe(false);
    expect(provider.requests[0]?.system).not.toContain('long-term memory');
  });

  it('forgets a single match into Forgotten, updates, and lists candidates when ambiguous', async () => {
    const services = setup(new FakeProvider(() => []));
    const { repos, tools, settings } = services;
    for (const content of ['Lives in Oslo', 'Works in Oslo', 'Likes tea']) {
      await repos.memories.create({ content, category: 'general', enabled: true, source: 'manual', status: 'active', scope: null, sourceConversationId: null });
    }
    const all = await tools.all(await settings.getAll());
    const activity: ActivityItem[] = [];
    const context = {
      conversationId: 'c',
      paneId: 'p',
      settings: await settings.getAll(),
      web: { search: null, fetch: false, nativeSearch: false, resolved: 'none' as const, note: null },
      attachments: [],
      signal: new AbortController().signal,
      onActivity: (item: ActivityItem) => activity.push(item),
      onSource: () => {},
    };
    const run = (name: string, args: object) =>
      tools.execute(all.find((tool) => tool.spec.name === name), { id: 'x', name, arguments: JSON.stringify(args) }, context, {
        policy: 'auto',
        approve: async () => true,
      });

    const ambiguous = await run('memory_forget', { content: 'oslo' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toContain('Works in Oslo');

    expect(await run('memory_forget', { content: 'likes tea.' })).toEqual({ content: 'Removed from memory: "Likes tea"', isError: false });
    expect((await repos.memories.findMany({ where: { status: 'forgotten' } })).map((row) => row.content)).toEqual(['Likes tea']);

    const updated = await run('memory_update', { memory: 'Lives in Oslo', content: 'Lives in Bergen' });
    expect(updated.isError).toBe(false);
    const history = await repos.memoryHistory.findMany({ where: { action: 'updated' } });
    expect(history).toMatchObject([{ content: 'Lives in Bergen', previousContent: 'Lives in Oslo', actor: 'model' }]);

    const invalid = await run('memory_save', { content: 5 });
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content).toContain('arguments.content should be string');
  });

  it('only sends memories scoped to the pane profile or to every chat', async () => {
    const provider = new FakeProvider(() => [{ type: 'text', text: 'Ok' }]);
    const services = setup(provider);
    const { repos } = services;
    const profile = await repos.systemPrompts.create({ name: 'Coder', content: 'Code well.', isDefault: false, tools: null, maxToolRounds: null, params: null });
    const other = await repos.systemPrompts.create({ name: 'Writer', content: 'Write well.', isDefault: false, tools: null, maxToolRounds: null, params: null });
    const base = { category: 'general', enabled: true, source: 'manual', status: 'active', sourceConversationId: null };
    await repos.memories.create({ ...base, content: 'Everywhere fact', scope: null });
    await repos.memories.create({ ...base, content: 'Coder fact', scope: profile.id });
    await repos.memories.create({ ...base, content: 'Writer fact', scope: other.id });
    const { conversation, pane } = await seedConversation(repos);
    await repos.panes.update(pane.id, { systemPromptId: profile.id, systemPrompt: null });

    await send(services, conversation.id, [pane.id], 'Hi');
    const system = provider.requests[0]?.system ?? '';
    expect(system).toContain('Code well.');
    expect(system).toContain('Everywhere fact');
    expect(system).toContain('Coder fact');
    expect(system).not.toContain('Writer fact');
  });
});

describe('MemoryService.suggest', () => {
  it('stores new facts as pending, skips duplicates and records failures', async () => {
    let fail = false;
    const provider = new FakeProvider(() => {
      if (fail) throw new Error('suggestion model down');
      return [{ type: 'text', text: '[{"content":"Prefers dark mode","category":"preferences"},{"content":"likes tea!"}]' }];
    });
    const { repos, settings, memory } = setup(provider);
    await settings.set('memory', {
      useByDefault: true,
      autoSuggest: true,
      suggestionModel: { provider: 'openrouter', model: 'cheap' },
      maxInjected: 50,
    });
    await repos.memories.create({ content: 'Likes tea', category: 'general', enabled: true, source: 'manual', status: 'active', scope: null, sourceConversationId: null });

    const exchange = [
      { role: 'user' as const, content: 'I prefer dark mode' },
      { role: 'assistant' as const, content: 'Noted' },
    ];
    expect(await memory.suggest('c1', exchange)).toBe(1);
    const pending = await repos.memories.findMany({ where: { status: 'pending' } });
    expect(pending.map((row) => row.content)).toEqual(['Prefers dark mode']);
    expect(memory.suggestionStatus()).toMatchObject({ lastAdded: 1, lastError: null });

    fail = true;
    await expect(memory.suggest('c1', exchange)).rejects.toThrow('suggestion model down');
    expect(memory.suggestionStatus().lastError).toBe('suggestion model down');
  });

  it('finds near-duplicate memories', async () => {
    const { repos, memory } = setup(new FakeProvider(() => []));
    const base = { category: 'general', enabled: true, source: 'manual', status: 'active', scope: null, sourceConversationId: null };
    await repos.memories.create({ ...base, content: 'Prefers metric units' });
    await repos.memories.create({ ...base, content: 'Prefers metric units always' });
    await repos.memories.create({ ...base, content: 'Has two cats' });
    const pairs = await memory.duplicates();
    expect(pairs).toHaveLength(1);
    expect([pairs[0]?.first.content, pairs[0]?.second.content].toSorted()).toEqual(['Prefers metric units', 'Prefers metric units always']);
  });
});
