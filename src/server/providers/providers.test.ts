import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GENERATION } from '../../shared/defaults.ts';
import {
  AnthropicProvider,
  AnthropicTurn,
  generationFields,
  nearestEffort,
  toAnthropicMessages,
  webSearchToolFor,
  type AnthropicEvent,
} from './anthropic.ts';
import { GoogleProvider } from './google.ts';
import { mapModels, mapOpenAiChunk, OpenAiCompatibleProvider, reasoningFields, toOpenAiMessages } from './openaiCompatible.ts';
import { providerFetch, retryDelay, type ChatEvent, type ChatRequest, type LoopMessage } from './types.ts';

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
    params: { ...DEFAULT_GENERATION, temperature: 0.5, topP: 0.9, maxTokens: 100 },
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

  it('tags image-output models from each catalog', () => {
    const [model] = mapModels('openrouter', [
      { id: 'google/gemini-2.5-flash-image', name: 'Nano Banana', architecture: { output_modalities: ['image', 'text'] } },
    ]);
    expect(model?.kind).toBe('image');
    expect(mapModels('openai', [{ id: 'gpt-image-1' }, { id: 'gpt-5' }]).map((m) => ({ id: m.model, kind: m.kind }))).toEqual([
      { id: 'gpt-5', kind: undefined },
      { id: 'gpt-image-1', kind: 'image' },
    ]);
  });

  it('reads generated images from a chunk and dedupes across chunks', () => {
    expect(mapOpenAiChunk(withImage())).toEqual([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]);

    const seen = new Set<string>();
    mapOpenAiChunk(withImage(), new Map(), seen);
    expect(mapOpenAiChunk(withImage(), new Map(), seen)).toEqual([]);
  });

  it('adds modalities for an OpenRouter image-output request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiCompatibleProvider({ id: 'openrouter', baseUrl: 'https://x.test/v1', apiKey: 'k' });
    await collect(provider.streamChat(request({ imageOutput: true })));
    expect(sentBody(fetchMock).modalities).toEqual(['image', 'text']);
  });

  it('generates an image through /images/generations instead of chat completions on OpenAI', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: 'AAAA' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiCompatibleProvider({ id: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'sk' });
    const events = await collect(provider.streamChat(request({ model: 'gpt-image-1', imageOutput: true })));
    expect(events).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'finish', reason: 'stop' },
    ]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/images/generations');
    expect(sentBody(fetchMock)).toEqual({ model: 'gpt-image-1', prompt: 'Hi', n: 1 });
  });
});

describe('Google provider', () => {
  it('builds contents from history and attachments, and parses image, text and usage from the response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        candidates: [
          { content: { parts: [{ text: 'Here you go' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GoogleProvider({ baseUrl: 'https://generativelanguage.test/v1beta', apiKey: 'key' });
    const messages: LoopMessage[] = [
      { role: 'user', content: 'Make it blue', attachments: [{ id: 'i', name: 'cat.png', mimeType: 'image/png', kind: 'image', data: 'BBBB' }] },
    ];
    const events = await collect(provider.streamChat(request({ model: 'gemini-2.5-flash-image', messages })));
    expect(events).toEqual([
      { type: 'text', text: 'Here you go' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'usage', inputTokens: 10, outputTokens: 20 },
      { type: 'finish', reason: 'STOP' },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.test/v1beta/models/gemini-2.5-flash-image:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('key');
    const body = sentBody(fetchMock);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'BBBB' } }, { text: 'Make it blue' }] }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
  });

  it('reports the provider error message on a failed request', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: { message: 'blocked' } }, { status: 400 }));
    const provider = new GoogleProvider({ baseUrl: 'https://x.test/v1beta', apiKey: 'key' });
    await expect(collect(provider.streamChat(request()))).rejects.toThrow('blocked');
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

  it('sends a cached system prompt, adaptive thinking without sampling, tools, and emits the raw turn', async () => {
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
    expect(body.system).toEqual([{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }]);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBe(100);
    expect(body.tools).toEqual([
      { name: 'web_fetch', description: 'fetch', input_schema: { type: 'object' } },
      { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
    ]);
  });
});

function params(overrides = {}) {
  return { ...DEFAULT_GENERATION, ...overrides };
}

function withImage() {
  return { choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] } }] };
}

describe('reasoning and sampling settings', () => {
  it('follows each Claude model family', () => {
    expect(generationFields('claude-opus-5', params({ temperature: 0.7, reasoningEffort: 'xhigh' }))).toEqual({
      output_config: { effort: 'xhigh' },
      thinking: { type: 'adaptive', display: 'summarized' },
      max_tokens: 32_000,
    });
    // Opus 4.6 thinks only when asked, keeps sampling otherwise, and has no xhigh.
    expect(generationFields('claude-opus-4-6', params({ temperature: 0.7 }))).toEqual({ max_tokens: 8192, temperature: 0.7 });
    expect(generationFields('claude-opus-4-6', params({ reasoningEffort: 'xhigh' }))).toMatchObject({
      output_config: { effort: 'high' },
      thinking: { type: 'adaptive' },
    });
    // Older models take a budget, which has to fit inside max_tokens.
    expect(generationFields('claude-haiku-4-5', params({ thinkingBudget: 4000, maxTokens: 2000, temperature: 1 }))).toEqual({
      thinking: { type: 'enabled', budget_tokens: 4000 },
      max_tokens: 12_192,
    });
    expect(generationFields('claude-haiku-4-5', params({ topP: 0.5, reasoningEffort: 'high' }))).toEqual({ max_tokens: 8192, top_p: 0.5 });
    expect(nearestEffort('max', ['low', 'medium', 'high'])).toBe('high');
    expect(nearestEffort('low', [])).toBeNull();
  });

  it('uses each OpenAI-compatible dialect', () => {
    expect(reasoningFields('openai', params({ reasoningEffort: 'max' }))).toEqual({ reasoning_effort: 'high' });
    expect(reasoningFields('openrouter', params({ reasoningEffort: 'low' }))).toEqual({ reasoning: { effort: 'low' } });
    expect(reasoningFields('openrouter', params({ thinkingBudget: 2048 }))).toEqual({ reasoning: { max_tokens: 2048 } });
    expect(reasoningFields('ollama', params())).toEqual({});
  });
});

describe('attachments in provider formats', () => {
  const withFiles: LoopMessage[] = [
    {
      role: 'user',
      content: 'Look',
      attachments: [
        { id: 'i', name: 'cat.png', mimeType: 'image/png', kind: 'image', data: 'AAA' },
        { id: 'd', name: 'spec.pdf', mimeType: 'application/pdf', kind: 'pdf', data: 'BBB' },
        { id: 't', name: 'notes.md', mimeType: 'text/plain', kind: 'text', text: '# hi' },
      ],
    },
  ];

  it('builds Anthropic content blocks with media first', () => {
    expect(toAnthropicMessages(withFiles)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' }, title: 'spec.pdf' },
          { type: 'text', text: '<attachment name="notes.md" id="t">\n# hi\n</attachment>' },
          { type: 'text', text: 'Look' },
        ],
      },
    ]);
  });

  it('builds OpenAI content parts', () => {
    expect(toOpenAiMessages('', withFiles)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'file', file: { filename: 'spec.pdf', file_data: 'data:application/pdf;base64,BBB' } },
          { type: 'text', text: '<attachment name="notes.md" id="t">\n# hi\n</attachment>' },
          { type: 'text', text: 'Look' },
        ],
      },
    ]);
  });
});

describe('providerFetch retries', () => {
  it('retries rate limits and overloads before the body is read, then gives up', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return calls < 3 ? new Response('busy', { status: 529, headers: { 'retry-after': '0' } }) : new Response('ok');
    });
    expect(await (await providerFetch('Test', 'https://x.test', {})).text()).toBe('ok');
    expect(calls).toBe(3);

    calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('nope', { status: 400 });
    });
    expect((await providerFetch('Test', 'https://x.test', {})).status).toBe(400);
    expect(calls).toBe(1);
  });

  it('reads retry-after and backs off otherwise', () => {
    expect(retryDelay(new Response(null, { headers: { 'retry-after': '2' } }), 0)).toBe(2000);
    expect(retryDelay(new Response(null, { headers: { 'retry-after': '999' } }), 0)).toBe(30_000);
    const backoff = retryDelay(new Response(null), 1);
    expect(backoff).toBeGreaterThanOrEqual(2400);
    expect(backoff).toBeLessThanOrEqual(3600);
  });
});
