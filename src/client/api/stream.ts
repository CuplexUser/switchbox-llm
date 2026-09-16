import { parseSse } from '../../shared/sse.ts';
import type { StreamEvent, StreamRequest } from '../../shared/types.ts';
import { ApiError } from './client.ts';

export async function streamChat(
  request: StreamRequest,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
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
    onEvent(JSON.parse(message.data) as StreamEvent);
  }
}
