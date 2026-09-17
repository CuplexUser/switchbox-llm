import { Hono } from 'hono';
import { badRequest, notFound, readJson, type Services } from '../context.ts';

export function attachmentRoutes({ attachments, repos }: Services): Hono {
  const app = new Hono();

  /** Uploads a file as base64 JSON, like every other write, so it passes the same cross-site checks. */
  app.post('/attachments', async (c) => {
    const body = await readJson<{ name?: string; mimeType?: string; data?: string; conversationId?: string | null }>(c);
    if (typeof body.name !== 'string' || typeof body.data !== 'string') throw badRequest('name and data are required');
    if (body.conversationId && !(await repos.conversations.findById(body.conversationId))) throw notFound('Conversation');
    const attachment = await attachments.create({
      name: body.name,
      mimeType: body.mimeType ?? '',
      data: body.data,
      conversationId: body.conversationId ?? null,
    });
    return c.json(attachment, 201);
  });

  /** The file itself, for previews and downloads. */
  app.get('/attachments/:id/content', async (c) => {
    const row = await attachments.get(c.req.param('id'));
    if (!row) throw notFound('Attachment');
    c.header('Content-Type', row.mimeType);
    c.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    // Never sniffed, and sandboxed in case a file is opened directly.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return c.body(new Uint8Array(row.data).buffer);
  });

  return app;
}
