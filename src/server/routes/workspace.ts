import { basename, extname } from 'node:path';
import { Hono } from 'hono';
import { badRequest, notFound, readJson, type Services } from '../context.ts';
import { zipStream, type ArchiveEntry } from '../services/archive.ts';
import { isText } from '../services/workspaces.ts';

/** Types served as themselves. SVG and HTML are left out on purpose: they can run scripts, so they go out as text. */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

export function workspaceRoutes({ repos, workspaces }: Services): Hono {
  const app = new Hono();

  /** The conversation's id and, if its workspace is bound to a real folder, that folder's path. */
  async function chat(id: string): Promise<{ id: string; hostFolderPath: string | null }> {
    const row = await repos.conversations.findById(id);
    if (!row) throw notFound('Conversation');
    return { id, hostFolderPath: row.hostFolderPath };
  }

  app.get('/conversations/:id/files', async (c) => {
    const { id, hostFolderPath } = await chat(c.req.param('id'));
    return c.json(await workspaces.listing(id, hostFolderPath));
  });

  /**
   * One file's bytes, for previews and downloads. Files are written by models, so nothing is served
   * in a form a browser would run: images keep their type, everything else is plain text or bytes,
   * never sniffed, and sandboxed in case the file is opened directly.
   */
  app.get('/conversations/:id/files/raw', async (c) => {
    const { id, hostFolderPath } = await chat(c.req.param('id'));
    const { path, data } = await workspaces.readBytes(id, c.req.query('path') ?? '', hostFolderPath);
    const type = IMAGE_TYPES[extname(path).toLowerCase()] ?? (isText(data) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline';
    c.header('Content-Type', type);
    c.header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(basename(path))}`);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    c.header('Cache-Control', 'no-store');
    return c.body(new Uint8Array(data));
  });

  /** The whole workspace as a ZIP archive. */
  app.get('/conversations/:id/files/archive', async (c) => {
    const { id, hostFolderPath } = await chat(c.req.param('id'));
    const files = (await workspaces.exists(id, hostFolderPath)) ? await workspaces.files(id, '', hostFolderPath) : [];
    async function* entries(): AsyncGenerator<ArchiveEntry> {
      for (const file of files) {
        const { data } = await workspaces.readBytes(id, file.path, hostFolderPath);
        yield { path: file.path, data, modified: new Date(file.modifiedAt) };
      }
    }
    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="workspace-${id.slice(0, 8)}.zip"`);
    return c.body(zipStream(entries()));
  });

  /** Uploads a file as base64 JSON, like attachments, so it passes the same cross-site checks. */
  app.post('/conversations/:id/files', async (c) => {
    const { id, hostFolderPath } = await chat(c.req.param('id'));
    const body = await readJson<{ path?: unknown; data?: unknown }>(c);
    if (typeof body.path !== 'string' || typeof body.data !== 'string') throw badRequest('path and data are required');
    await workspaces.write(id, body.path, Buffer.from(body.data, 'base64'), {}, hostFolderPath);
    return c.json(await workspaces.listing(id, hostFolderPath), 201);
  });

  /** Deletes one file or folder, or with no path everything in the workspace. */
  app.delete('/conversations/:id/files', async (c) => {
    const { id, hostFolderPath } = await chat(c.req.param('id'));
    const path = c.req.query('path');
    if (path) await workspaces.remove(id, path, hostFolderPath);
    else await workspaces.clear(id, hostFolderPath);
    return c.json(await workspaces.listing(id, hostFolderPath));
  });

  return app;
}
