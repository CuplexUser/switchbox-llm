import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi, createServices } from './app.ts';
import { runMigrations } from './db/migrations.ts';
import { allRepos, openRepos } from './db/repos.ts';
import { config } from './env.ts';
import { createLogger } from './log.ts';
import { seedSamplePrompts } from './services/seed.ts';

const log = createLogger('server');
const repos = await openRepos(config.databaseFile);
await runMigrations(repos, createLogger('migrate'));
const seeded = await seedSamplePrompts(repos);
if (seeded > 0) log.info('added starter system prompts', { count: seeded });

// Temporary chats never outlive the server process.
const temporary = await repos.conversations.findMany({ where: { persist: false } });
for (const conversation of temporary) {
  await repos.messages.deleteMany({ where: { conversationId: conversation.id } });
  await repos.panes.deleteMany({ where: { conversationId: conversation.id } });
  await repos.attachments.deleteMany({ where: { conversationId: conversation.id } });
  await repos.conversations.delete(conversation.id);
}

const services = createServices(repos);
// Workspaces of the temporary chats removed above, and of chats deleted while the server was down.
const chatIds = new Set((await repos.conversations.findMany()).map((conversation) => conversation.id));
const orphaned = await services.workspaces.prune(chatIds);
if (orphaned > 0) log.info('removed workspaces of deleted chats', { count: orphaned });
const unclaimed = await services.attachments.deleteUnclaimed(new Date(Date.now() - 24 * 60 * 60 * 1000));
if (unclaimed > 0) log.info('removed files that were never sent', { count: unclaimed });
// Replies saved before usage tracking existed.
if ((await repos.usage.count()) === 0) {
  const backfilled = await services.usage.backfill();
  if (backfilled > 0) log.info('recorded usage for earlier replies', { count: backfilled });
}
const app = new Hono();
app.route('/api', createApi(services));

if (existsSync('./dist/index.html')) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  log.info(`Switchbox API listening on http://localhost:${info.port}`);
});

function shutdown(): void {
  server.close();
  void Promise.allSettled([services.mcp.closeAll(), ...allRepos(repos).map((repo) => repo.close())]).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
