import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { MAX_PANES } from '../../shared/defaults.ts';
import type { StreamEvent, StreamRequest } from '../../shared/types.ts';
import { badRequest, readJson, type Services } from '../context.ts';
import { errorMessage } from '../services/chat.ts';

export function chatRoutes({ chat }: Services): Hono {
  const app = new Hono();
  /** runId -> paneId -> controller, so a single pane can be stopped mid-run. */
  const runs = new Map<string, Map<string, AbortController>>();

  app.post('/chat/stream', async (c) => {
    const request = await readJson<StreamRequest>(c);
    if (!request.runId || !request.conversationId) throw badRequest('runId and conversationId are required');
    if (!Array.isArray(request.targets) || request.targets.length === 0) throw badRequest('No panes to send to');
    if (request.targets.length > MAX_PANES) throw badRequest(`At most ${MAX_PANES} panes per request`);
    if (request.content !== null && !request.content?.trim()) throw badRequest('Message is empty');

    const controllers = new Map<string, AbortController>();
    runs.set(request.runId, controllers);

    return streamSSE(c, async (stream) => {
      // Panes stream concurrently; chain writes so frames never interleave.
      let queue = Promise.resolve();
      const emit = (event: StreamEvent) => {
        queue = queue.then(() => (stream.aborted ? undefined : stream.writeSSE({ data: JSON.stringify(event) })));
        return queue;
      };
      stream.onAbort(() => {
        for (const controller of controllers.values()) controller.abort();
      });
      try {
        await chat.run(request, emit, controllers);
      } catch (error) {
        for (const target of request.targets) {
          await emit({ type: 'error', paneId: target.paneId, error: errorMessage(error), message: null });
        }
      } finally {
        runs.delete(request.runId);
        await emit({ type: 'end' });
      }
    });
  });

  app.post('/chat/stop', async (c) => {
    const { runId, paneId } = await readJson<{ runId?: string; paneId?: string }>(c);
    const controllers = runId ? runs.get(runId) : undefined;
    if (controllers) {
      for (const [id, controller] of controllers) {
        if (!paneId || id === paneId) controller.abort();
      }
    }
    return c.json({ stopped: Boolean(controllers) });
  });

  return app;
}
