import { strFromU8, unzipSync } from 'fflate';
import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ExportBundle, Memory, MemoryHistoryEntry } from '../../shared/types.ts';
import { createApi, createServices } from '../app.ts';
import { memoryRepos } from '../db/repos.ts';
import { tempWorkspaceDir } from '../services/testing.ts';

function freshApi(): Hono {
  return createApi(createServices(memoryRepos(), { workspaceDir: tempWorkspaceDir() }));
}

/** Downloads an export and unpacks it. */
async function exportArchive(api: Hono): Promise<{ bundle: ExportBundle; entries: Record<string, Uint8Array> }> {
  const response = await api.request('http://localhost:8787/data/export');
  expect(response.headers.get('content-type')).toBe('application/zip');
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  return { bundle: JSON.parse(strFromU8(entries['switchbox.json'] as Uint8Array)) as ExportBundle, entries };
}

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('memory history', () => {
  it('records edits and survives an export and import with its dates', async () => {
    const source = freshApi();
    const created = (await (await source.request('http://localhost:8787/memories', json({ content: 'Lives in Oslo', category: 'home' }))).json()) as Memory;
    await source.request(`http://localhost:8787/memories/${created.id}`, json({ content: 'Lives in Bergen' }, 'PATCH'));
    await source.request(`http://localhost:8787/memories/${created.id}`, json({ status: 'forgotten' }, 'PATCH'));

    const history = (await (await source.request(`http://localhost:8787/memories/${created.id}/history`)).json()) as MemoryHistoryEntry[];
    expect(history.map((entry) => entry.action).toSorted()).toEqual(['created', 'forgotten', 'updated']);
    expect(history.find((entry) => entry.action === 'updated')).toMatchObject({ content: 'Lives in Bergen', previousContent: 'Lives in Oslo', actor: 'user' });

    const bundle = (await exportArchive(source)).bundle;
    expect(bundle.memoryHistory).toHaveLength(3);

    const target = freshApi();
    const result = (await (await target.request('http://localhost:8787/data/import', json(bundle))).json()) as { imported: Record<string, number> };
    expect(result.imported.memoryHistory).toBe(3);
    const imported = (await (await target.request(`http://localhost:8787/memories/${created.id}/history`)).json()) as MemoryHistoryEntry[];
    expect(imported.map((entry) => entry.createdAt).toSorted()).toEqual(history.map((entry) => entry.createdAt).toSorted());
  });

  it('rejects a scope that is not a profile', async () => {
    const api = freshApi();
    const response = await api.request('http://localhost:8787/memories', json({ content: 'Uses tabs', scope: 'no-such-profile' }));
    expect(response.status).toBe(400);
  });
});

describe('import', () => {
  it('keeps the dates of imported chats, panes, profiles and memories', async () => {
    const source = freshApi();
    await source.request('http://localhost:8787/memories', json({ content: 'Lives in Oslo' }));
    await source.request('http://localhost:8787/prompts', json({ name: 'Researcher', content: 'Cite sources.' }));
    const created = await source.request('http://localhost:8787/conversations', json({ panes: [{ provider: 'openrouter', model: 'a/model' }] }));
    expect(created.status).toBe(201);

    const old = '2020-01-02T03:04:05.000Z';
    const bundle = (await exportArchive(source)).bundle;
    const tables = [bundle.conversations, bundle.panes, bundle.systemPrompts, bundle.memories] as { createdAt: string; updatedAt: string }[][];
    for (const rows of tables) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) Object.assign(row, { createdAt: old, updatedAt: old });
    }

    const target = freshApi();
    expect((await target.request('http://localhost:8787/data/import', json(bundle))).status).toBe(200);
    const again = (await exportArchive(target)).bundle;
    for (const table of ['conversations', 'panes', 'memories'] as const) {
      for (const row of again[table] as { createdAt: string; updatedAt: string }[]) {
        expect([table, row.createdAt, row.updatedAt]).toEqual([table, old, old]);
      }
    }
    const researcher = again.systemPrompts.find((prompt) => prompt.name === 'Researcher');
    expect(researcher).toMatchObject({ createdAt: old, updatedAt: old });
  });

  it('never trusts a bound folder from an import, even a crafted one', async () => {
    const source = freshApi();
    const created = await source.request('http://localhost:8787/conversations', json({ panes: [{ provider: 'openrouter', model: 'a/model' }] }));
    expect(created.status).toBe(201);

    const bundle = (await exportArchive(source)).bundle;
    for (const row of bundle.conversations) Object.assign(row, { hostFolderPath: 'C:\\Windows' });

    const target = freshApi();
    expect((await target.request('http://localhost:8787/data/import', json(bundle))).status).toBe(200);
    const again = await exportArchive(target);
    expect(again.bundle.conversations.length).toBeGreaterThan(0);
    for (const row of again.bundle.conversations) expect(row.hostFolderPath).toBeNull();
  });
});

describe('zip export', () => {
  const base = 'http://localhost:8787';

  async function chatWithFiles(api: Hono): Promise<string> {
    const created = (await (await api.request(`${base}/conversations`, json({ workspace: true, panes: [{ provider: 'openrouter', model: 'a/model' }] }))).json()) as {
      id: string;
    };
    const upload = await api.request(`${base}/conversations/${created.id}/files`, json({ path: 'src/main.c', data: Buffer.from('int main(){return 0;}').toString('base64') }));
    expect(upload.status).toBe(201);
    await api.request(`${base}/conversations/${created.id}/files`, json({ path: 'logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64') }));
    const attachment = await api.request(`${base}/attachments`, json({ name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64'), conversationId: created.id }));
    expect(attachment.status).toBe(201);
    return created.id;
  }

  it('puts attachments and workspace files in the archive as raw entries and imports them back', async () => {
    const source = freshApi();
    const id = await chatWithFiles(source);
    const { bundle, entries } = await exportArchive(source);
    expect(bundle.version).toBe(2);
    expect(bundle.attachments?.[0]).not.toHaveProperty('data');
    expect(strFromU8(entries[`workspaces/${id}/src/main.c`] as Uint8Array)).toBe('int main(){return 0;}');
    const attachmentId = bundle.attachments?.[0]?.id ?? '';
    expect(strFromU8(entries[`attachments/${attachmentId}`] as Uint8Array)).toBe('hello');

    const archive = await (await source.request(`${base}/data/export`)).arrayBuffer();
    const target = freshApi();
    const imported = await target.request(`${base}/data/import`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: archive });
    expect(imported.status).toBe(200);
    expect(((await imported.json()) as { imported: Record<string, number> }).imported).toMatchObject({ conversations: 1, attachments: 1, workspaceFiles: 2 });
    const listing = (await (await target.request(`${base}/conversations/${id}/files`)).json()) as { files: { path: string }[] };
    expect(listing.files.map((file) => file.path)).toEqual(['logo.png', 'src/main.c']);
    const content = await target.request(`${base}/attachments/${attachmentId}/content`);
    expect(await content.text()).toBe('hello');

    // A second import changes nothing.
    const again = await target.request(`${base}/data/import`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: archive });
    expect(((await again.json()) as { imported: Record<string, number> }).imported).toMatchObject({ conversations: 0, workspaceFiles: 0 });
  });

  it('still imports version 1 JSON with base64 attachments', async () => {
    const source = freshApi();
    await chatWithFiles(source);
    const { bundle, entries } = await exportArchive(source);
    const v1 = {
      ...bundle,
      version: 1,
      attachments: bundle.attachments?.map((row) => ({ ...row, data: Buffer.from(entries[`attachments/${row.id}`] as Uint8Array).toString('base64') })),
    };
    const target = freshApi();
    const response = await target.request(`${base}/data/import`, json(v1));
    expect(((await response.json()) as { imported: Record<string, number> }).imported).toMatchObject({ conversations: 1, attachments: 1 });
  });

  it('keeps workspace entries that try to leave the folder out', async () => {
    const source = freshApi();
    const id = await chatWithFiles(source);
    const { entries } = await exportArchive(source);
    const { zipSync } = await import('fflate');
    const evil = zipSync({
      ...entries,
      [`workspaces/${id}/../../escaped.txt`]: Buffer.from('nope'),
      [`workspaces/${id}/C:/escaped.txt`]: Buffer.from('nope'),
      'workspaces/../escaped.txt': Buffer.from('nope'),
    });
    const target = freshApi();
    const response = await target.request(`${base}/data/import`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: evil });
    expect(((await response.json()) as { imported: Record<string, number> }).imported).toMatchObject({ workspaceFiles: 2, skippedFiles: 3 });
  });

  it('does not let an import change how commands are approved', async () => {
    const source = freshApi();
    const { bundle } = await exportArchive(source);
    bundle.settings = { ...bundle.settings, agent: { maxToolRounds: 6, maxParallelTools: 4, keepToolResults: 'summary', policies: { run_command: 'auto', web_search: 'ask' } } };
    const target = freshApi();
    await target.request(`${base}/data/import`, json(bundle));
    const settings = (await (await target.request(`${base}/settings`)).json()) as { agent: { policies: Record<string, string> } };
    expect(settings.agent.policies).toEqual({ web_search: 'ask' });
  });

  it('rejects an archive without switchbox.json', async () => {
    const { zipSync } = await import('fflate');
    const response = await freshApi().request(`${base}/data/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zipSync({ 'other.txt': Buffer.from('x') }),
    });
    expect(response.status).toBe(400);
  });
});
