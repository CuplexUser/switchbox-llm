export interface SseMessage {
  event: string | null;
  data: string;
  /** The message's `id:` field, when it has one. */
  id?: string;
}

/** A dead connection can otherwise hang forever waiting for bytes that will never come. */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
export const LOST_CONNECTION = 'Lost the connection to the server.';

export interface SseTimeouts {
  /** How long to wait for the first bytes. Defaults to `idleMs`. */
  firstByteMs?: number;
  /** How long to wait between bytes once some have arrived. 0 disables the timeout. */
  idleMs: number;
  /** The error message when a timeout fires. */
  message?: string;
}

/** Thrown when the stream goes quiet for longer than its timeout allows. */
export class SseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseTimeoutError';
  }
}

/**
 * Parses a Server-Sent Events byte stream into messages. Handles CRLF and LF line endings,
 * multi-line data fields, comments, and chunks that split anywhere, including inside a
 * multi-byte character.
 *
 * Gives up with an SseTimeoutError if no bytes at all — comments included — arrive for the idle
 * timeout, so a silently dropped connection is reported instead of leaving the caller waiting
 * indefinitely. Pass 0 to disable. The sender is expected to write something (even just a
 * comment) well within that window whenever it's still alive but has nothing to say yet. A
 * separate, usually longer, `firstByteMs` covers the wait before anything arrives at all.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  timeouts: number | SseTimeouts = DEFAULT_IDLE_TIMEOUT_MS,
): AsyncGenerator<SseMessage> {
  const options: SseTimeouts = typeof timeouts === 'number' ? { idleMs: timeouts } : timeouts;
  const { idleMs, firstByteMs = idleMs, message: timeoutMessage = LOST_CONNECTION } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let id: string | null = null;
  let data: string[] = [];
  let received = false;

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  async function readChunk(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const wait = received ? idleMs : firstByteMs;
    if (!wait) return reader.read();
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SseTimeoutError(timeoutMessage)), wait);
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
        if (data.length > 0) yield message();
        event = null;
        id = null;
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
      else if (field === 'id') id = value;
    }
  }

  function message(): SseMessage {
    return id === null ? { event, data: data.join('\n') } : { event, data: data.join('\n'), id };
  }

  try {
    while (true) {
      const { value, done } = await readChunk();
      if (done) break;
      received = true;
      buffer += decoder.decode(value, { stream: true });
      yield* drain(false);
    }
    buffer += decoder.decode();
    yield* drain(true);
    if (buffer.length > 0) {
      buffer += '\n';
      yield* drain(true);
    }
    if (data.length > 0) yield message();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Settles a read left pending by a timed-out race before releasing the lock, which a pending read would reject.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
