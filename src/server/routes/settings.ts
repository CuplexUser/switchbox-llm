import { Hono } from 'hono';
import { DEFAULT_SETTINGS } from '../../shared/defaults.ts';
import { PROVIDER_IDS, type AppSettings, type McpServerConfig, type ProviderId, type SettingsSection } from '../../shared/types.ts';
import { badRequest, readJson, type Services } from '../context.ts';
import { errorMessage } from '../services/chat.ts';
import { webStatus } from '../web/search.ts';

export function settingsRoutes({ settings, registry, tools, mcp }: Services): Hono {
  const app = new Hono();

  app.get('/settings', async (c) => c.json(await settings.getAll()));

  app.put('/settings/:section', async (c) => {
    const section = c.req.param('section') as SettingsSection;
    if (!(section in DEFAULT_SETTINGS)) throw badRequest(`Unknown settings section "${section}"`);
    const value = await readJson<AppSettings[typeof section]>(c);
    const updated = await settings.set(section, value);
    if (section === 'providers') registry.clearModelCache();
    if (section === 'mcp') await mcp.sync(updated.mcp.servers);
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
      registry.cacheModels(id, models);
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
        try {
          return await registry.models(id, refresh);
        } catch (error) {
          errors.push({ provider: id, error: errorMessage(error) });
          return registry.cachedModels(id);
        }
      }),
    );
    return c.json({ models: lists.flat(), errors });
  });

  /** Every tool group and tool with its policy, including tools from connected MCP servers. */
  app.get('/tools', async (c) => c.json(await tools.catalog(await settings.getAll())));

  /** Connects to a server configuration without saving it and lists its tools. */
  app.post('/mcp/test', async (c) => {
    const server = await readJson<McpServerConfig>(c);
    if (server.transport !== 'stdio' && server.transport !== 'http') throw badRequest('transport must be stdio or http');
    return c.json(await mcp.test(server));
  });

  return app;
}
