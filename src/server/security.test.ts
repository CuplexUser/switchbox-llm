import { describe, expect, it } from 'vitest';
import { createApi, createServices } from './app.ts';
import { memoryRepos } from './db/repos.ts';

const api = createApi(createServices(memoryRepos()));

function stop(url: string, headers: Record<string, string> = {}) {
  return api.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ runId: 'none' }),
  });
}

describe('localOnly', () => {
  it('accepts requests from the app and from tools without an Origin', async () => {
    expect((await stop('http://localhost:8787/chat/stop', { Origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await stop('http://127.0.0.1:8787/chat/stop', { Origin: 'http://127.0.0.1:8787' })).status).toBe(200);
    expect((await stop('http://127.0.0.1:8787/chat/stop')).status).toBe(200);
    expect((await api.request('http://localhost/health', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
  });

  it('refuses a Host that is not loopback, as with DNS rebinding', async () => {
    expect((await api.request('http://attacker.test:8787/data/export')).status).toBe(403);
    expect((await stop('http://attacker.test:8787/chat/stop', { Origin: 'http://attacker.test:8787' })).status).toBe(403);
  });

  it('refuses requests sent by other sites', async () => {
    expect((await stop('http://localhost:8787/chat/stop', { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await stop('http://localhost:8787/chat/stop', { Origin: 'null' })).status).toBe(403);
    const crossSiteGet = await api.request('http://localhost:8787/data/export', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSiteGet.status).toBe(403);
  });

  it('requires a JSON content type for request bodies', async () => {
    const response = await api.request('http://localhost:8787/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ runId: 'none' }),
    });
    expect(response.status).toBe(415);
  });
});
