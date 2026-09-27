import { describe, expect, it } from 'vitest';
import { parseSse } from '../../shared/sse.ts';
import type { StreamEvent } from '../../shared/types.ts';
import { createApi, createServices } from '../app.ts';
import { memoryRepos } from '../db/repos.ts';
import { McpManager } from '../tools/mcp.ts';
import { fakeRegistry, FakeProvider, seedConversation, tempWorkspaceDir } from '../services/testing.ts';

const BASE = 'http://localhost:8787';

describe('chat streaming', () => {
  it('keeps writing a reply after the client leaves, and lets it pick up where it left off', async () => {
    const release = Promise.withResolvers<void>();
    const provider = new FakeProvider(async () => {
      await release.promise;
      return [
        { type: 'text', text: 'Still ' },
        { type: 'text', text: 'here' },
      ];
    });
    const services = createServices(memoryRepos(), { registry: fakeRegistry(provider), mcp: new McpManager(), workspaceDir: tempWorkspaceDir() });
    const api = createApi(services);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });

    const body = { runId: 'run-1', conversationId: conversation.id, action: 'send', content: 'Hello', paneIds: [pane.id] };
    const response = await api.request(`${BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Read up to the start of the reply, then drop the connection.
    const abort = new AbortController();
    let lastSeq = 0;
    for await (const message of parseSse(response.body as ReadableStream<Uint8Array>, abort.signal)) {
      lastSeq = Number(message.id);
      if ((JSON.parse(message.data) as StreamEvent).type === 'start') break;
    }
    expect(lastSeq).toBe(2);
    expect(await (await api.request(`${BASE}/conversations/${conversation.id}/runs`)).json()).toEqual([{ runId: 'run-1', paneIds: [pane.id] }]);

    release.resolve();
    const resumed = await api.request(`${BASE}/chat/runs/run-1/stream?after=${lastSeq}`);
    const events: StreamEvent[] = [];
    for await (const message of parseSse(resumed.body as ReadableStream<Uint8Array>)) events.push(JSON.parse(message.data) as StreamEvent);

    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['delta', 'done', 'end']));
    expect(events.filter((event) => event.type === 'delta').map((event) => event.text).join('')).toBe('Still here');
    expect(events.find((event) => event.type === 'done')).toMatchObject({ message: { content: 'Still here', finishReason: null } });
    expect(await (await api.request(`${BASE}/conversations/${conversation.id}/runs`)).json()).toEqual([]);
  });

  it('answers 404 for a run it does not know', async () => {
    const api = createApi(createServices(memoryRepos(), { registry: fakeRegistry(new FakeProvider(() => [])), mcp: new McpManager(), workspaceDir: tempWorkspaceDir() }));
    expect((await api.request(`${BASE}/chat/runs/nope/stream`)).status).toBe(404);
  });
});
