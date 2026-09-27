import { Hono, type Context } from 'hono';
import { MAX_PANES } from '../../shared/defaults.ts';
import type { StreamRequest } from '../../shared/types.ts';
import { streamSSE } from 'hono/streaming';
import { badRequest, notFound, readJson, type Services } from '../context.ts';

const ACTIONS = ['send', 'regenerate', 'edit', 'continue'];
/** Written regardless of model activity, so a slow tool call or a quiet thinking step never looks like a dead connection to the client's idle timeout. */
const HEARTBEAT_MS = 15_000;

export function chatRoutes({ chat, runs, approvals }: Services): Hono {
  const app = new Hono();

  /**
   * Streams a run's events to one client, starting after event `after`. Leaving doesn't stop the
   * run: the client can come back for the rest with the number of the last event it saw.
   */
  function follow(c: Context, runId: string, after: number): Response {
    return streamSSE(c, async (stream) => {
      // Chain writes so frames never interleave.
      let queue = Promise.resolve();
      const write = (task: () => Promise<void>) => {
        queue = queue.then(() => (stream.aborted ? undefined : task())).catch(() => {});
      };
      // A comment: invisible to the client's event parsing, but bytes it can use to tell "still connected" from "dead".
      const heartbeat = setInterval(() => write(() => stream.write(':\n\n').then(() => {})), HEARTBEAT_MS);
      await new Promise<void>((resolve) => {
        const unsubscribe = runs.subscribe(runId, after, (entry) => {
          write(() => stream.writeSSE({ id: String(entry.seq), data: JSON.stringify(entry.event) }));
          if (entry.event.type === 'end') resolve();
        });
        if (!unsubscribe) return resolve();
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
      clearInterval(heartbeat);
      await queue;
    });
  }

  app.post('/chat/stream', async (c) => {
    const request = await readJson<StreamRequest>(c);
    if (!request.runId || !request.conversationId) throw badRequest('runId and conversationId are required');
    if (runs.has(request.runId)) throw badRequest('That run has already started');
    if (!ACTIONS.includes(request.action)) throw badRequest('action must be send, regenerate, edit or continue');
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

    runs.start(request, (emit, controllers) => chat.run(request, emit, controllers));
    return follow(c, request.runId, 0);
  });

  /** Picks a run back up after event `after`, for a client whose connection dropped or a page opened mid-reply. */
  app.get('/chat/runs/:runId/stream', async (c) => {
    const runId = c.req.param('runId');
    if (!runs.has(runId)) throw notFound('Run');
    const after = Number(c.req.query('after') ?? 0);
    return follow(c, runId, Number.isInteger(after) && after > 0 ? after : 0);
  });

  /** The runs of a chat that are still going. */
  app.get('/conversations/:id/runs', (c) => c.json(runs.active(c.req.param('id'))));

  app.post('/chat/stop', async (c) => {
    const { runId, paneId } = await readJson<{ runId?: string; paneId?: string }>(c);
    return c.json({ stopped: runId ? runs.stop(runId, paneId) : false });
  });

  /** Answers a tool call waiting for approval. */
  app.post('/chat/approve', async (c) => {
    const { id, approved } = await readJson<{ id?: string; approved?: boolean }>(c);
    if (!id || typeof approved !== 'boolean') throw badRequest('id and approved are required');
    return c.json({ answered: approvals.answer(id, approved) });
  });

  return app;
}
