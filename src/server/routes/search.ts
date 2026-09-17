import { Hono } from 'hono';
import type { Services } from '../context.ts';

export function searchRoutes({ search }: Services): Hono {
  const app = new Hono();

  app.get('/search', async (c) => {
    const query = c.req.query('q') ?? '';
    const limit = Number(c.req.query('limit') ?? 20);
    return c.json(await search.messages(query, { limit: Number.isFinite(limit) ? limit : 20 }));
  });

  return app;
}
