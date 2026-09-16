import { describe, expect, it } from 'vitest';
import { parseSse, type SseMessage } from './sse.ts';

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function collect(chunks: (string | Uint8Array)[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const message of parseSse(streamOf(chunks))) out.push(message);
  return out;
}

describe('parseSse', () => {
  it('parses data and event fields', async () => {
    expect(await collect(['event: ping\ndata: {"a":1}\n\n', 'data: two\n\n'])).toEqual([
      { event: 'ping', data: '{"a":1}' },
      { event: null, data: 'two' },
    ]);
  });

  it('joins multi-line data and skips comments', async () => {
    expect(await collect([': keep-alive\n', 'data: a\ndata: b\n\n'])).toEqual([{ event: null, data: 'a\nb' }]);
  });

  it('handles CRLF split across chunks', async () => {
    expect(await collect(['data: x\r', '\n\r', '\ndata: y\r\n\r\n'])).toEqual([
      { event: null, data: 'x' },
      { event: null, data: 'y' },
    ]);
  });

  it('handles a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: héllo\n\n');
    expect(await collect([bytes.slice(0, 8), bytes.slice(8)])).toEqual([{ event: null, data: 'héllo' }]);
  });

  it('flushes a final message without a trailing blank line', async () => {
    expect(await collect(['data: last'])).toEqual([{ event: null, data: 'last' }]);
  });
});
