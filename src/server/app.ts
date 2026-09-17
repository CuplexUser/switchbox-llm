import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { NotFoundError, QueryError, UniqueConstraintError } from 'repolayer';
import type { Services } from './context.ts';
import type { Repos } from './db/repos.ts';
import { createLogger } from './log.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { attachmentRoutes } from './routes/attachments.ts';
import { chatRoutes } from './routes/chat.ts';
import { conversationRoutes } from './routes/conversations.ts';
import { dataRoutes } from './routes/data.ts';
import { memoryRoutes } from './routes/memories.ts';
import { promptRoutes } from './routes/prompts.ts';
import { searchRoutes } from './routes/search.ts';
import { settingsRoutes } from './routes/settings.ts';
import { usageRoutes } from './routes/usage.ts';
import { localOnly } from './security.ts';
import { ApprovalBroker } from './services/approvals.ts';
import { AttachmentError, AttachmentService } from './services/attachments.ts';
import { ChatService } from './services/chat.ts';
import { MemoryService } from './services/memory.ts';
import { MessageStore } from './services/messages.ts';
import { SearchService } from './services/search.ts';
import { SettingsService } from './services/settings.ts';
import { UsageService } from './services/usage.ts';
import { codeTools } from './tools/code.ts';
import { libraryTools } from './tools/library.ts';
import { McpManager } from './tools/mcp.ts';
import { memoryTools } from './tools/memory.ts';
import { ToolRegistry } from './tools/registry.ts';
import { timeTools } from './tools/time.ts';
import type { ToolSource } from './tools/types.ts';
import { webTools } from './tools/web.ts';

const log = createLogger('api');

/** Builds every service. Tests pass their own provider registry to avoid the network. */
export function createServices(
  repos: Repos,
  options: { registry?: ProviderRegistry; mcp?: McpManager; toolSources?: ToolSource[] } = {},
): Services {
  const settings = new SettingsService(repos);
  const registry = options.registry ?? new ProviderRegistry(settings);
  const memory = new MemoryService(repos, settings, registry);
  const store = new MessageStore(repos);
  const attachments = new AttachmentService(repos);
  const search = new SearchService(repos);
  const mcp = options.mcp ?? new McpManager();
  const tools = new ToolRegistry([webTools(), memoryTools(memory), codeTools(), timeTools(), libraryTools(repos, search), mcp, ...(options.toolSources ?? [])]);
  const approvals = new ApprovalBroker();
  const chat = new ChatService({ repos, settings, providers: registry, memory, tools, store, attachments, approvals });
  const usage = new UsageService(repos, registry);
  return { repos, settings, registry, memory, store, attachments, search, tools, mcp, approvals, chat, usage };
}

export function createApi(services: Services): Hono {
  const api = new Hono();

  api.use('*', localOnly());
  api.get('/health', (c) => c.json({ ok: true }));
  api.route('/', settingsRoutes(services));
  api.route('/', promptRoutes(services));
  api.route('/', conversationRoutes(services));
  api.route('/', chatRoutes(services));
  api.route('/', memoryRoutes(services));
  api.route('/', attachmentRoutes(services));
  api.route('/', searchRoutes(services));
  api.route('/', dataRoutes(services));
  api.route('/', usageRoutes(services));

  api.notFound((c) => c.json({ error: 'Not found' }, 404));
  api.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof AttachmentError) return c.json({ error: error.message }, 400);
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof UniqueConstraintError) return c.json({ error: error.message }, 409);
    if (error instanceof QueryError) return c.json({ error: error.message }, 400);
    log.error('unhandled error', { method: c.req.method, path: c.req.path, error: error.stack ?? error.message });
    return c.json({ error: 'Internal server error' }, 500);
  });

  return api;
}
