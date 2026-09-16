import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi, createServices } from './app.ts';
import { openRepos } from './db/repos.ts';
import { config } from './env.ts';
import { seedSamplePrompts } from './services/seed.ts';

const repos = await openRepos(config.databaseFile);
const seeded = await seedSamplePrompts(repos);
if (seeded > 0) console.info(`[db] added ${seeded} starter system prompts`);

// Temporary chats never outlive the server process.
const temporary = await repos.conversations.findMany({ where: { persist: false } });
for (const conversation of temporary) {
  await repos.messages.deleteMany({ where: { conversationId: conversation.id } });
  await repos.panes.deleteMany({ where: { conversationId: conversation.id } });
  await repos.conversations.delete(conversation.id);
}

const services = createServices(repos);
// Replies saved before usage tracking existed.
if ((await repos.usage.count()) === 0) {
  const backfilled = await services.usage.backfill();
  if (backfilled > 0) console.info(`[db] recorded usage for ${backfilled} earlier replies`);
}
const app = new Hono();
app.route('/api', createApi(services));

if (existsSync('./dist/index.html')) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.info(`Switchbox API listening on http://localhost:${info.port}`);
});

function shutdown(): void {
  server.close();
  void Promise.allSettled(Object.values(repos).map((repo) => repo.close())).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
