import { describe, expect, it } from 'vitest';
import { parseSse, SseTimeoutError, type SseMessage } from './sse.ts';

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

  it('gives up and cancels the reader if nothing arrives within the idle timeout', async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        // Never enqueues or closes: simulates a connection that silently died.
      },
      cancel() {
        cancelled = true;
      },
    });
    const iterator = parseSse(stalled, undefined, 5);
    await expect(iterator.next()).rejects.toThrow('Lost the connection to the server.');
    expect(cancelled).toBe(true);
  });

  it('reads the id field of each message', async () => {
    expect(await collect(['id: 7\ndata: a\n\n', 'data: b\n\n'])).toEqual([
      { event: null, data: 'a', id: '7' },
      { event: null, data: 'b' },
    ]);
  });

  it('waits longer for the first bytes than between them, and says why it gave up', async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const slowStart = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls++;
        // The first bytes take 30ms, longer than the idle timeout; after that nothing comes.
        if (pulls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          controller.enqueue(encoder.encode('data: first\n\n'));
        }
      },
    });
    const iterator = parseSse(slowStart, undefined, { firstByteMs: 1_000, idleMs: 10, message: 'The model stopped responding.' });
    expect((await iterator.next()).value).toEqual({ event: null, data: 'first' });
    const failure = iterator.next();
    await expect(failure).rejects.toBeInstanceOf(SseTimeoutError);
    await expect(failure).rejects.toThrow('The model stopped responding.');
  });

  it('never times out when idleTimeoutMs is 0', async () => {
    const out: SseMessage[] = [];
    for await (const message of parseSse(streamOf(['data: last']), undefined, 0)) out.push(message);
    expect(out).toEqual([{ event: null, data: 'last' }]);
  });
});
