import { Hono } from 'hono';
import { badRequest, readJson, type Services } from '../context.ts';

/** How long a read-aloud request may take, all pieces together. */
const READ_ALOUD_TIMEOUT_MS = 3 * 60_000;

export function speechRoutes({ speech }: Services): Hono {
  const app = new Hono();

  /** Speaks `text` with the speech model from Settings → General and answers with the audio file. */
  app.post('/speech', async (c) => {
    const body = await readJson<{ text?: string }>(c);
    if (typeof body.text !== 'string' || !body.text.trim()) throw badRequest('text is required');
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(READ_ALOUD_TIMEOUT_MS)]);
    const audio = await speech.readAloud(body.text, signal);
    c.header('Content-Type', audio.mimeType);
    c.header('Cache-Control', 'no-store');
    return c.body(new Uint8Array(audio.data));
  });

  return app;
}
