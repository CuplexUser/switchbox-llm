import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, mapAnthropicEvent } from './anthropic.ts';
import { mapModels, mapOpenAiChunk, OpenAiCompatibleProvider } from './openaiCompatible.ts';
import type { ChatEvent, ChatRequest } from './types.ts';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible mapping', () => {
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
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiCompatibleProvider({ id: 'openai', baseUrl: 'https://api.test/v1/', apiKey: 'sk' });
    const events = await collect(provider.streamChat(request()));

    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hello');
    expect(events).toContainEqual({ type: 'usage', inputTokens: 4, outputTokens: 2, cost: undefined });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/chat/completions');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(body.max_completion_tokens).toBe(100);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk');
  });

  it('reports the provider error message on a failed request', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }));
    const provider = new OpenAiCompatibleProvider({ id: 'openrouter', baseUrl: 'https://x.test/v1', apiKey: 'bad' });
    await expect(collect(provider.streamChat(request()))).rejects.toThrow('OpenRouter returned 401: Invalid API key');
  });
});

describe('Anthropic mapping', () => {
  it('maps the event sequence', () => {
    expect(mapAnthropicEvent({ type: 'message_start', message: { usage: { input_tokens: 10 } } })).toEqual([
      { type: 'usage', inputTokens: 10 },
    ]);
    expect(mapAnthropicEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } })).toEqual([
      { type: 'text', text: 'Hi' },
    ]);
    expect(mapAnthropicEvent({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'so' } })).toEqual([
      { type: 'reasoning', text: 'so' },
    ]);
    expect(
      mapAnthropicEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    ).toEqual([
      { type: 'usage', inputTokens: undefined, outputTokens: 7 },
      { type: 'finish', reason: 'end_turn' },
    ]);
    expect(() => mapAnthropicEvent({ type: 'error', error: { message: 'overloaded' } })).toThrow('overloaded');
  });

  it('sends system separately and only one of temperature or top_p', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Yo"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({ baseUrl: 'https://api.anthropic.test/v1', apiKey: 'key' });
    const events = await collect(provider.streamChat(request()));
    expect(events).toContainEqual({ type: 'text', text: 'Yo' });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.system).toBe('Be brief.');
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBe(100);
  });
});
