import { describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderId, StreamEvent } from '../../shared/types.ts';
import { memoryRepos, type Repos } from '../db/repos.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ChatEvent, ChatRequest, Provider } from '../providers/types.ts';
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

async function seedConversation(repos: Repos, persist = true, useMemory = true) {
  const conversation = await repos.conversations.create({
    title: 'New chat',
    persist,
    useMemory,
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
