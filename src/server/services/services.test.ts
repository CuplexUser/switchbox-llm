import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/defaults.ts';
import type { ModelInfo, ProviderId, StreamEvent } from '../../shared/types.ts';
import { memoryRepos, type Repos } from '../db/repos.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { ProviderError, type ChatEvent, type ChatRequest, type Provider } from '../providers/types.ts';
import { ChatService, cleanHistory, titleFrom } from './chat.ts';
import { buildSystemPrompt, MemoryService, parseSuggestions } from './memory.ts';
import { mergeDefaults, SettingsService } from './settings.ts';

class FakeProvider implements Provider {
  readonly id: ProviderId = 'openrouter';
  readonly requests: ChatRequest[] = [];
  private readonly reply: (request: ChatRequest) => ChatEvent[];

  constructor(reply: (request: ChatRequest) => ChatEvent[]) {
    this.reply = reply;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(request);
    for (const event of this.reply(request)) {
      if (request.signal.aborted) return;
      yield event;
    }
  }
}

function setup(provider: Provider) {
  const repos: Repos = memoryRepos();
  const settings = new SettingsService(repos);
  const registry = { get: async () => provider, build: async () => provider } as unknown as ProviderRegistry;
  const memory = new MemoryService(repos, settings, registry);
  const chat = new ChatService(repos, settings, registry, memory);
  return { repos, settings, memory, chat };
}

async function seedConversation(repos: Repos, persist = true, useMemory = true, webAccess = false) {
  const conversation = await repos.conversations.create({
    title: 'New chat',
    persist,
    useMemory,
    webAccess,
    pinned: false,
    archived: false,
  });
  const pane = await repos.panes.create({
    conversationId: conversation.id,
    position: 0,
    provider: 'openrouter',
    model: 'test/model',
    systemPromptId: null,
    systemPrompt: 'You are terse.',
    params: { temperature: 0.3 },
  });
  return { conversation, pane };
}

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

  it('titles, cleans history and merges settings defaults', () => {
    expect(titleFrom('  Explain\nmonads please')).toBe('Explain');
    expect(titleFrom('x'.repeat(80))).toHaveLength(58);
    expect(cleanHistory([{ role: 'assistant', content: '  ' }, { role: 'user', content: 'hi' }])).toHaveLength(1);
    expect(mergeDefaults({ a: 1, nested: { b: 2, c: 3 } }, { nested: { b: 5 } })).toEqual({ a: 1, nested: { b: 5, c: 3 } });
  });
});

describe('SettingsService', () => {
  it('stores sections and fills in new defaults', async () => {
    const { settings } = setup(new FakeProvider(() => []));
    await settings.set('memory', { useByDefault: false, autoSuggest: true, suggestionModel: null, maxInjected: 5 });
    const all = await settings.getAll();
    expect(all.memory.maxInjected).toBe(5);
    expect(all.general.sendOnEnter).toBe(true);
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
    const { repos, chat } = setup(provider);
    const { conversation, pane } = await seedConversation(repos);
    await repos.memories.create({
      content: 'Name is Sam',
      category: 'general',
      enabled: true,
      source: 'manual',
      status: 'active',
      sourceConversationId: null,
    });
    await repos.memories.create({
      content: 'Pending fact',
      category: 'general',
      enabled: true,
      source: 'suggested',
      status: 'pending',
      sourceConversationId: null,
    });

    const events: StreamEvent[] = [];
    await chat.run(
      { runId: 'r1', conversationId: conversation.id, content: 'Hello', targets: [{ paneId: pane.id, history: [] }] },
      (event) => void events.push(event),
      new Map(),
    );

    const request = provider.requests[0];
    expect(request?.system).toContain('You are terse.');
    expect(request?.system).toContain('Name is Sam');
    expect(request?.system).not.toContain('Pending fact');
    expect(request?.params.temperature).toBe(0.3);
    expect(request?.messages).toEqual([{ role: 'user', content: 'Hello' }]);

    const done = events.find((event) => event.type === 'done');
    expect(done?.type === 'done' && done.message.content).toBe('Hi there');
    expect(done?.type === 'done' && done.message.tokensOut).toBe(2);

    const stored = await repos.messages.findMany({ where: { conversationId: conversation.id } });
    expect(stored.map((message) => message.role).toSorted()).toEqual(['assistant', 'user']);
    expect((await repos.conversations.findById(conversation.id))?.title).toBe('Hello');
  });

  it('does not persist temporary conversations and reports provider errors per pane', async () => {
    const provider = new FakeProvider(() => {
      throw new Error('boom');
    });
    const { repos, chat } = setup(provider);
    const { conversation, pane } = await seedConversation(repos, false, false);

    const events: StreamEvent[] = [];
    await chat.run(
      { runId: 'r2', conversationId: conversation.id, content: 'Hello', targets: [{ paneId: pane.id, history: [] }] },
      (event) => void events.push(event),
      new Map(),
    );

    expect(events.map((event) => event.type)).toEqual(['user', 'start', 'error']);
    expect(await repos.messages.count()).toBe(0);
  });

  it('marks a stopped pane as aborted and keeps the partial text', async () => {
    const controllers = new Map<string, AbortController>();
    const provider = new FakeProvider(() => {
      controllers.values().next().value?.abort();
      return [{ type: 'text', text: 'never' }];
    });
    const { repos, chat } = setup(provider);
    const { conversation, pane } = await seedConversation(repos);

    const events: StreamEvent[] = [];
    await chat.run(
      { runId: 'r3', conversationId: conversation.id, content: 'Go', targets: [{ paneId: pane.id, history: [] }] },
      (event) => void events.push(event),
      controllers,
    );
    const done = events.find((event) => event.type === 'done');
    expect(done?.type === 'done' && done.message.finishReason).toBe('aborted');
  });
});

async function runOnce(chat: ChatService, conversationId: string, paneId: string) {
  const events: StreamEvent[] = [];
  await chat.run(
    { runId: 'r', conversationId, content: 'Weather in Oslo?', targets: [{ paneId, history: [] }] },
    (event) => void events.push(event),
    new Map(),
  );
  return events;
}

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
    const { repos, chat } = setup(provider);
    const { conversation, pane } = await seedConversation(repos, true, false, true);

    const events = await runOnce(chat, conversation.id, pane.id);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['web_search', 'web_fetch']);
    expect(provider.requests[0]?.system).toContain("Today's date is");
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.role === 'tool' && toolMessage.content).toContain('Sunny, 21 degrees');

    const done = events.find((event) => event.type === 'done');
    const message = done?.type === 'done' ? done.message : null;
    expect(message?.content).toBe('Let me check.\n\nSunny.');
    expect(message?.tokensIn).toBe(10);
    expect(message?.activity?.items).toMatchObject([{ kind: 'search', engine: 'tavily', query: 'Oslo weather', resultCount: 1, done: true }]);
    expect(message?.activity?.sources).toEqual([{ url: 'https://yr.test/oslo', title: 'Yr' }]);
    expect(events.filter((event) => event.type === 'activity')).toHaveLength(2);

    const stored = await repos.messages.findById(message?.id ?? '');
    expect(stored?.activity).toEqual(message?.activity);
  });

  it('retries without tools when the model rejects them', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    const provider = new FakeProvider((request) => {
      if (request.tools?.length) throw new ProviderError('Ollama returned 400: model does not support tools', 400);
      return [{ type: 'text', text: 'Offline answer.' }];
    });
    const { repos, chat } = setup(provider);
    const { conversation, pane } = await seedConversation(repos, false, false, true);

    const events = await runOnce(chat, conversation.id, pane.id);
    const done = events.find((event) => event.type === 'done');
    expect(done?.type === 'done' && done.message.content).toBe('Offline answer.');
    expect(done?.type === 'done' && done.message.activity?.items.map((item) => item.kind)).toEqual(['notice']);
  });

  it('stops calling tools after the round limit and asks for an answer', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    const provider = new FakeProvider(() => [
      { type: 'tool_call', call: { id: `c${Math.random()}`, name: 'web_fetch', arguments: '{"url":"http://127.0.0.1/"}' } },
    ]);
    const { repos, settings, chat } = setup(provider);
    await settings.set('web', { ...DEFAULT_SETTINGS.web, maxToolRounds: 2 });
    const { conversation, pane } = await seedConversation(repos, false, false, true);

    await runOnce(chat, conversation.id, pane.id);
    // Two real rounds, one round answered with the limit notice, then a final turn that is cut off.
    expect(provider.requests).toHaveLength(4);
    const last = provider.requests.at(-1)?.messages.at(-1);
    expect(last?.role === 'tool' && last.content).toContain('Research limit reached');
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
    const { repos, chat } = setup(provider);
    const { conversation, pane } = await seedConversation(repos, true, true);
    const second = await repos.panes.create({ ...pane, id: undefined, position: 1 } as never);

    const events: StreamEvent[] = [];
    await chat.run(
      {
        runId: 'm',
        conversationId: conversation.id,
        content: 'Remember that my dog is called Rex',
        targets: [
          { paneId: pane.id, history: [] },
          { paneId: second.id, history: [] },
        ],
      },
      (event) => void events.push(event),
      new Map(),
    );

    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['memory_save', 'memory_forget']);
    expect(provider.requests[0]?.system).toContain('long-term memory');
    const saved = await repos.memories.findMany();
    expect(saved).toMatchObject([{ content: 'Has a dog named Rex', category: 'background', source: 'model', status: 'active' }]);
    const done = events.find((event) => event.type === 'done');
    expect(done?.type === 'done' && done.message.activity?.items).toMatchObject([{ kind: 'memory', action: 'save', done: true }]);
  });

  it('leaves memory tools out when the chat has memory off', async () => {
    const provider = new FakeProvider(() => [{ type: 'text', text: 'Hi' }]);
    const { repos, chat } = setup(provider);
    const { conversation, pane } = await seedConversation(repos, false, false);
    await runOnce(chat, conversation.id, pane.id);
    expect(provider.requests[0]?.tools).toEqual([]);
    expect(provider.requests[0]?.system).not.toContain('long-term memory');
  });

  it('forgets a single matching memory and lists candidates when ambiguous', async () => {
    const { repos, memory } = setup(new FakeProvider(() => []));
    for (const content of ['Lives in Oslo', 'Works in Oslo', 'Likes tea']) {
      await repos.memories.create({ content, category: 'general', enabled: true, source: 'manual', status: 'active', sourceConversationId: null });
    }
    const activity: unknown[] = [];
    const ambiguous = await memory.runTool({ id: 'f1', name: 'memory_forget', arguments: '{"content":"oslo"}' }, 'c', (item) => activity.push(item));
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toContain('Works in Oslo');

    const removed = await memory.runTool({ id: 'f2', name: 'memory_forget', arguments: '{"content":"likes tea."}' }, 'c', () => {});
    expect(removed).toEqual({ content: 'Removed from memory: "Likes tea"', isError: false });
    expect(await repos.memories.count()).toBe(2);
  });
});

describe('MemoryService.suggest', () => {
  it('stores new facts as pending and skips duplicates', async () => {
    const provider = new FakeProvider(() => [
      { type: 'text', text: '[{"content":"Prefers dark mode","category":"preferences"},{"content":"likes tea!"}]' },
    ]);
    const { repos, settings, memory } = setup(provider);
    await settings.set('memory', {
      useByDefault: true,
      autoSuggest: true,
      suggestionModel: { provider: 'openrouter', model: 'cheap' },
      maxInjected: 50,
    });
    await repos.memories.create({
      content: 'Likes tea',
      category: 'general',
      enabled: true,
      source: 'manual',
      status: 'active',
      sourceConversationId: null,
    });

    const added = await memory.suggest('c1', [
      { role: 'user', content: 'I prefer dark mode' },
      { role: 'assistant', content: 'Noted' },
    ]);
    expect(added).toBe(1);
    const pending = await repos.memories.findMany({ where: { status: 'pending' } });
    expect(pending.map((row) => row.content)).toEqual(['Prefers dark mode']);
  });
});
