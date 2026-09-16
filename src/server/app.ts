import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { NotFoundError, QueryError, UniqueConstraintError } from 'repolayer';
import type { Services } from './context.ts';
import type { Repos } from './db/repos.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { chatRoutes } from './routes/chat.ts';
import { conversationRoutes } from './routes/conversations.ts';
import { dataRoutes } from './routes/data.ts';
import { memoryRoutes } from './routes/memories.ts';
import { promptRoutes } from './routes/prompts.ts';
import { settingsRoutes } from './routes/settings.ts';
import { ChatService } from './services/chat.ts';
import { MemoryService } from './services/memory.ts';
import { SettingsService } from './services/settings.ts';

export function createServices(repos: Repos): Services {
  const settings = new SettingsService(repos);
  const registry = new ProviderRegistry(settings);
  const memory = new MemoryService(repos, settings, registry);
  const chat = new ChatService(repos, settings, registry, memory);
  return { repos, settings, registry, memory, chat };
}

export function createApi(services: Services): Hono {
  const api = new Hono();

  api.get('/health', (c) => c.json({ ok: true }));
  api.route('/', settingsRoutes(services));
  api.route('/', promptRoutes(services));
  api.route('/', conversationRoutes(services));
  api.route('/', chatRoutes(services));
  api.route('/', memoryRoutes(services));
  api.route('/', dataRoutes(services));

  api.notFound((c) => c.json({ error: 'Not found' }, 404));
  api.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof UniqueConstraintError) return c.json({ error: error.message }, 409);
    if (error instanceof QueryError) return c.json({ error: error.message }, 400);
    console.error('[api]', error);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return api;
}
