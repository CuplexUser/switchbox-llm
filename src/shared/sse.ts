export interface SseMessage {
  event: string | null;
  data: string;
}

/** A dead connection can otherwise hang forever waiting for bytes that will never come. */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

/**
 * Parses a Server-Sent Events byte stream into messages. Handles CRLF and LF line endings,
 * multi-line data fields, comments, and chunks that split anywhere, including inside a
 * multi-byte character.
 *
 * Gives up if no bytes at all — comments included — arrive for `idleTimeoutMs`, so a silently
 * dropped connection is reported instead of leaving the caller waiting indefinitely. Pass 0 to
 * disable. The sender is expected to write something (even just a comment) well within that
 * window whenever it's still alive but has nothing to say yet.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  async function readChunk(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (!idleTimeoutMs) return reader.read();
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Lost the connection to the server.')), idleTimeoutMs);
    });
    try {
      return await Promise.race([reader.read(), timedOut]);
    } finally {
      clearTimeout(timer!);
    }
  }

  function* drain(final: boolean): Generator<SseMessage> {
    while (true) {
      const newline = buffer.search(/\r\n|\n|\r/);
      if (newline === -1) return;
      // A trailing \r may be the first half of a \r\n split across chunks.
      if (!final && buffer[newline] === '\r' && newline === buffer.length - 1) return;
      const width = buffer.startsWith('\r\n', newline) ? 2 : 1;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + width);

      if (line === '') {
        if (data.length > 0) yield { event, data: data.join('\n') };
        event = null;
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
  }

  try {
    while (true) {
      const { value, done } = await readChunk();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drain(false);
    }
    buffer += decoder.decode();
    yield* drain(true);
    if (buffer.length > 0) {
      buffer += '\n';
      yield* drain(true);
    }
    if (data.length > 0) yield { event, data: data.join('\n') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Settles a read left pending by a timed-out race before releasing the lock, which a pending read would reject.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
