import { parseSse } from '../../shared/sse.ts';
import type { StreamEvent, StreamRequest } from '../../shared/types.ts';
import { ApiError } from './client.ts';

/** Receives each event of a run with its number, which says where to pick up after a dropped connection. */
export type RunEventHandler = (event: StreamEvent, seq: number) => void;

async function consume(response: Response, onEvent: RunEventHandler, signal: AbortSignal): Promise<void> {
  if (!response.ok || !response.body) {
    let message = `Request failed (${response.status})`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // Keep the generic message.
    }
    throw new ApiError(message, response.status);
  }
  for await (const message of parseSse(response.body, signal)) {
    onEvent(JSON.parse(message.data) as StreamEvent, Number(message.id ?? 0));
  }
}

/** Starts a run and streams its events. The run keeps going on the server if this connection drops. */
export async function streamChat(request: StreamRequest, onEvent: RunEventHandler, signal: AbortSignal): Promise<void> {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  await consume(response, onEvent, signal);
}

/** Streams the events of a run already under way, starting after event `after`. Throws an ApiError with status 404 once the run is gone. */
export async function followRun(runId: string, after: number, onEvent: RunEventHandler, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/stream?after=${after}`, { signal });
  await consume(response, onEvent, signal);
}
