import { describe, expect, it } from 'vitest';
import type { ExportBundle, Memory, MemoryHistoryEntry } from '../../shared/types.ts';
import { createApi, createServices } from '../app.ts';
import { memoryRepos } from '../db/repos.ts';

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('memory history', () => {
  it('records edits and survives an export and import with its dates', async () => {
    const source = createApi(createServices(memoryRepos()));
    const created = (await (await source.request('http://localhost:8787/memories', json({ content: 'Lives in Oslo', category: 'home' }))).json()) as Memory;
    await source.request(`http://localhost:8787/memories/${created.id}`, json({ content: 'Lives in Bergen' }, 'PATCH'));
    await source.request(`http://localhost:8787/memories/${created.id}`, json({ status: 'forgotten' }, 'PATCH'));

    const history = (await (await source.request(`http://localhost:8787/memories/${created.id}/history`)).json()) as MemoryHistoryEntry[];
    expect(history.map((entry) => entry.action).toSorted()).toEqual(['created', 'forgotten', 'updated']);
    expect(history.find((entry) => entry.action === 'updated')).toMatchObject({ content: 'Lives in Bergen', previousContent: 'Lives in Oslo', actor: 'user' });

    const bundle = (await (await source.request('http://localhost:8787/data/export')).json()) as ExportBundle;
    expect(bundle.memoryHistory).toHaveLength(3);

    const target = createApi(createServices(memoryRepos()));
    const result = (await (await target.request('http://localhost:8787/data/import', json(bundle))).json()) as { imported: Record<string, number> };
    expect(result.imported.memoryHistory).toBe(3);
    const imported = (await (await target.request(`http://localhost:8787/memories/${created.id}/history`)).json()) as MemoryHistoryEntry[];
    expect(imported.map((entry) => entry.createdAt).toSorted()).toEqual(history.map((entry) => entry.createdAt).toSorted());
  });

  it('rejects a scope that is not a profile', async () => {
    const api = createApi(createServices(memoryRepos()));
    const response = await api.request('http://localhost:8787/memories', json({ content: 'Uses tabs', scope: 'no-such-profile' }));
    expect(response.status).toBe(400);
  });
});
