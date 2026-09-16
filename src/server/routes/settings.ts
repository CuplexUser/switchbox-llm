import { Hono } from 'hono';
import { DEFAULT_SETTINGS } from '../../shared/defaults.ts';
import { PROVIDER_IDS, type AppSettings, type ModelInfo, type ProviderId, type SettingsSection } from '../../shared/types.ts';
import { badRequest, readJson, type Services } from '../context.ts';
import { errorMessage } from '../services/chat.ts';
import { webStatus } from '../web/search.ts';

const MODEL_CACHE_MS = 10 * 60 * 1000;

export function settingsRoutes({ settings, registry }: Services): Hono {
  const app = new Hono();
  const modelCache = new Map<ProviderId, { at: number; models: ModelInfo[] }>();

  app.get('/settings', async (c) => c.json(await settings.getAll()));

  app.put('/settings/:section', async (c) => {
    const section = c.req.param('section') as SettingsSection;
    if (!(section in DEFAULT_SETTINGS)) throw badRequest(`Unknown settings section "${section}"`);
    const value = await readJson<AppSettings[typeof section]>(c);
    const updated = await settings.set(section, value);
    if (section === 'providers') modelCache.clear();
    return c.json(updated);
  });

  app.get('/providers', async (c) => c.json(await registry.statuses()));

  app.get('/web/status', async (c) => c.json(webStatus((await settings.get('web')).searchMode)));

  app.post('/providers/:id/test', async (c) => {
    const id = c.req.param('id') as ProviderId;
    if (!PROVIDER_IDS.includes(id)) throw badRequest(`Unknown provider "${id}"`);
    const started = performance.now();
    try {
      const provider = await registry.build(id);
      const models = await provider.listModels(AbortSignal.timeout(15_000));
      modelCache.set(id, { at: Date.now(), models });
      return c.json({ ok: true, modelCount: models.length, latencyMs: Math.round(performance.now() - started) });
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get('/models', async (c) => {
    const refresh = c.req.query('refresh') === '1';
    const statuses = (await registry.statuses()).filter((status) => status.ready);
    const errors: { provider: ProviderId; error: string }[] = [];
    const lists = await Promise.all(
      statuses.map(async ({ id }) => {
        const cached = modelCache.get(id);
        if (!refresh && cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
        try {
          const provider = await registry.get(id);
          const models = await provider.listModels(AbortSignal.timeout(15_000));
          modelCache.set(id, { at: Date.now(), models });
          return models;
        } catch (error) {
          errors.push({ provider: id, error: errorMessage(error) });
          return cached?.models ?? [];
        }
      }),
    );
    return c.json({ models: lists.flat(), errors });
  });

  return app;
}
