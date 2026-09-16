import { Hono } from 'hono';
import { PROVIDER_IDS, type ProviderId, type UsageRange } from '../../shared/types.ts';
import { badRequest, type Services } from '../context.ts';
import { USAGE_RANGES } from '../services/usage.ts';

export function usageRoutes({ usage }: Services): Hono {
  const app = new Hono();

  app.get('/usage', async (c) => {
    const range = (c.req.query('range') ?? '30d') as UsageRange;
    if (!USAGE_RANGES.includes(range)) throw badRequest(`Unknown range "${range}"`);
    const provider = c.req.query('provider') || null;
    if (provider && !PROVIDER_IDS.includes(provider as ProviderId)) throw badRequest(`Unknown provider "${provider}"`);
    return c.json(await usage.report(range, provider as ProviderId | null));
  });

  return app;
}
