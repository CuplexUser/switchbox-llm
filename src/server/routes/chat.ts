import { Hono } from 'hono';
import { MAX_PANES } from '../../shared/defaults.ts';
import type { StreamEvent, StreamRequest } from '../../shared/types.ts';
import { streamSSE } from 'hono/streaming';
import { badRequest, readJson, type Services } from '../context.ts';
import { errorMessage } from '../services/chat.ts';

const ACTIONS = ['send', 'regenerate', 'edit'];

export function chatRoutes({ chat, approvals }: Services): Hono {
  const app = new Hono();
  /** runId -> paneId -> controller, so a single pane can be stopped mid-run. */
  const runs = new Map<string, Map<string, AbortController>>();

  app.post('/chat/stream', async (c) => {
    const request = await readJson<StreamRequest>(c);
    if (!request.runId || !request.conversationId) throw badRequest('runId and conversationId are required');
    if (!ACTIONS.includes(request.action)) throw badRequest('action must be send, regenerate or edit');
    if (!Array.isArray(request.paneIds) || request.paneIds.length === 0) throw badRequest('No panes to send to');
    if (request.paneIds.length > MAX_PANES) throw badRequest(`At most ${MAX_PANES} panes per request`);
    if (request.attachmentIds !== undefined && !Array.isArray(request.attachmentIds)) throw badRequest('attachmentIds must be a list');
    const hasFiles = (request.attachmentIds?.length ?? 0) > 0;
    if (request.action === 'send' && !request.content?.trim() && !hasFiles) throw badRequest('Message is empty');
    if (request.action === 'edit' && !request.content?.trim()) throw badRequest('Message is empty');
    const ids = request.messageIds;
    if (ids !== undefined && (typeof ids !== 'object' || ids === null || Array.isArray(ids) || Object.values(ids).some((id) => typeof id !== 'string'))) {
      throw badRequest('messageIds must map pane ids to message ids');
    }

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
        for (const paneId of request.paneIds) {
          await emit({ type: 'error', paneId, error: errorMessage(error), message: null });
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

  /** Answers a tool call waiting for approval. */
  app.post('/chat/approve', async (c) => {
    const { id, approved } = await readJson<{ id?: string; approved?: boolean }>(c);
    if (!id || typeof approved !== 'boolean') throw badRequest('id and approved are required');
    return c.json({ answered: approvals.answer(id, approved) });
  });

  return app;
}
