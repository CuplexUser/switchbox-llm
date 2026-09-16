import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  AnthropicTurn,
  toAnthropicMessages,
  webSearchToolFor,
  type AnthropicEvent,
} from './anthropic.ts';
import { mapModels, mapOpenAiChunk, OpenAiCompatibleProvider, toOpenAiMessages } from './openaiCompatible.ts';
import type { ChatEvent, ChatRequest } from './types.ts';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'test-model',
    system: 'Be brief.',
    messages: [{ role: 'user', content: 'Hi' }],
    params: { temperature: 0.5, topP: 0.9, maxTokens: 100 },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function sentBody(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const init = mock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function replay(events: AnthropicEvent[]) {
  const turn = new AnthropicTurn();
  return { events: events.flatMap((event) => turn.apply(event)), content: turn.content() };
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible provider', () => {
  it('maps content, reasoning, finish and usage', () => {
    expect(mapOpenAiChunk({ choices: [{ delta: { reasoning: 'hmm', content: 'Hello' } }] })).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'Hello' },
    ]);
    expect(
      mapOpenAiChunk({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5, cost: 0.01 } }),
    ).toEqual([
      { type: 'finish', reason: 'stop' },
      { type: 'usage', inputTokens: 3, outputTokens: 5, cost: 0.01 },
    ]);
  });

  it('throws on a mid-stream error chunk', () => {
    expect(() => mapOpenAiChunk({ error: { message: 'rate limited' } })).toThrow('rate limited');
  });

  it('reports url citations as sources', () => {
    expect(
      mapOpenAiChunk({
        choices: [{ delta: { annotations: [{ type: 'url_citation', url_citation: { url: 'https://s.test', title: 'S' } }] } }],
      }),
    ).toEqual([{ type: 'source', url: 'https://s.test', title: 'S' }]);
  });

  it('converts OpenRouter per-token pricing to per-million and filters OpenAI non-chat models', () => {
    const [model] = mapModels('openrouter', [
      { id: 'a/b', name: 'B', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' } },
    ]);
    expect(model?.pricing?.input).toBeCloseTo(1);
    expect(model?.pricing?.output).toBeCloseTo(2);
    expect(mapModels('openai', [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }]).map((m) => m.model)).toEqual(['gpt-5']);
  });

  it('streams a chat completion and sends the right body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        frame({ choices: [{ delta: { content: 'Hel' } }] }),
        frame({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
        frame({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiCompatibleProvider({ id: 'openai', baseUrl: 'https://api.test/v1/', apiKey: 'sk' });
    const events = await collect(provider.streamChat(request({ nativeSearch: true })));

    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hello');
    expect(events).toContainEqual({ type: 'usage', inputTokens: 4, outputTokens: 2, cost: undefined });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/chat/completions');
    const body = sentBody(fetchMock);
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(body.max_completion_tokens).toBe(100);
    expect(body.web_search_options).toEqual({});
    expect(body.tools).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk');
  });

  it('accumulates streamed tool call fragments and maps tool history', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_search', arguments: '{"qu' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"x"}' } }] }, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiCompatibleProvider({ id: 'openrouter', baseUrl: 'http://x.test/v1', apiKey: 'k' });
    const tools = [{ name: 'web_search', description: 'search', parameters: { type: 'object' } }];
    const events = await collect(provider.streamChat(request({ tools, nativeSearch: true })));
    expect(events).toContainEqual({ type: 'tool_call', call: { id: 'c1', name: 'web_search', arguments: '{"query":"x"}' } });

    const body = sentBody(fetchMock);
    expect(body.plugins).toEqual([{ id: 'web', max_results: 5 }]);
    expect(body.usage).toEqual({ include: true });
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'web_search', description: 'search', parameters: { type: 'object' } } },
    ]);

    expect(
      toOpenAiMessages('sys', [
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'web_search', arguments: '{"query":"x"}' }] },
        { role: 'tool', toolCallId: 'c1', name: 'web_search', content: 'results' },
      ]),
    ).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'results' },
    ]);
  });

  it('reports the provider error message on a failed request', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }));
    const provider = new OpenAiCompatibleProvider({ id: 'openrouter', baseUrl: 'https://x.test/v1', apiKey: 'bad' });
    await expect(collect(provider.streamChat(request()))).rejects.toThrow('OpenRouter returned 401: Invalid API key');
  });
});

describe('Anthropic provider', () => {
  it('maps text, thinking, usage and stop reason', () => {
    const { events } = replay([
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'so' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    ]);
    expect(events).toEqual([
      { type: 'usage', inputTokens: 15 },
      { type: 'reasoning', text: 'so' },
      { type: 'text', text: 'Hi' },
      { type: 'usage', outputTokens: 7 },
      { type: 'finish', reason: 'end_turn' },
    ]);
    expect(() => new AnthropicTurn().apply({ type: 'error', error: { message: 'overloaded' } })).toThrow('overloaded');
  });

  it('assembles tool input, native searches and sources, and keeps blocks for replay', () => {
    const { events, content } = replay([
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"ne' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ws"}' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srv',
          content: [{ type: 'web_search_result', url: 'https://a.test', title: 'A' }],
        },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'web_fetch', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"url":"https://b.test"}' } },
      { type: 'content_block_stop', index: 2 },
    ]);
    expect(events).toEqual([
      { type: 'native_search', query: 'news' },
      { type: 'source', url: 'https://a.test', title: 'A' },
      { type: 'tool_call', call: { id: 'tu1', name: 'web_fetch', arguments: '{"url":"https://b.test"}' } },
    ]);
    expect(content.map((block) => block.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'tool_use']);
    expect(content[0]?.input).toEqual({ query: 'news' });
  });

  it('groups consecutive tool results into one user message and replays raw blocks', () => {
    const raw = [{ type: 'tool_use', id: 'a', name: 'web_fetch', input: {} }];
    expect(
      toAnthropicMessages([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', raw },
        { role: 'tool', toolCallId: 'a', name: 'web_fetch', content: 'page' },
        { role: 'tool', toolCallId: 'b', name: 'web_fetch', content: 'nope', isError: true },
      ]),
    ).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'page' },
          { type: 'tool_result', tool_use_id: 'b', content: 'nope', is_error: true },
        ],
      },
    ]);
  });

  it('picks the web search tool version by model', () => {
    expect(webSearchToolFor('claude-opus-5').type).toBe('web_search_20260209');
    expect(webSearchToolFor('claude-haiku-4-5').type).toBe('web_search_20250305');
  });

  it('sends system separately, one sampling param, tools, and emits the raw turn', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        `event: message_start\n${frame({ type: 'message_start', message: { usage: { input_tokens: 5 } } })}`,
        frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Yo' } }),
        frame({ type: 'content_block_stop', index: 0 }),
        frame({ type: 'message_stop' }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({ baseUrl: 'https://api.anthropic.test/v1', apiKey: 'key' });
    const tools = [{ name: 'web_fetch', description: 'fetch', parameters: { type: 'object' } }];
    const events = await collect(provider.streamChat(request({ model: 'claude-opus-5', tools, nativeSearch: true })));
    expect(events).toContainEqual({ type: 'text', text: 'Yo' });
    expect(events.at(-1)).toEqual({ type: 'assistant_raw', content: [{ type: 'text', text: 'Yo' }] });

    const body = sentBody(fetchMock);
    expect(body.system).toBe('Be brief.');
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBe(100);
    expect(body.tools).toEqual([
      { name: 'web_fetch', description: 'fetch', input_schema: { type: 'object' } },
      { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
    ]);
  });
});
