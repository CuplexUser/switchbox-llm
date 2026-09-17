import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/defaults.ts';
import type { StreamEvent } from '../../shared/types.ts';
import type { LoopMessage } from '../providers/types.ts';
import type { ToolDefinition, ToolSource } from '../tools/types.ts';
import { doneMessage, FakeProvider, seedConversation, send, setup } from './testing.ts';

/** A tool group for tests: "echo" returns its input after an optional delay and tracks how many run at once. */
function echoTools(options: { policy?: 'auto' | 'ask'; delayMs?: number } = {}) {
  const stats = { running: 0, peak: 0, calls: 0 };
  const echo: ToolDefinition = {
    group: 'test',
    label: 'Echo',
    defaultPolicy: options.policy ?? 'auto',
    spec: {
      name: 'echo',
      description: 'Echo text',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    },
    async run(args) {
      stats.calls++;
      stats.running++;
      stats.peak = Math.max(stats.peak, stats.running);
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
      stats.running--;
      return { content: `echo: ${String(args.text)}`, isError: false };
    },
  };
  const source: ToolSource = {
    groups: async () => [{ id: 'test', label: 'Test', description: '', kind: 'builtin', onByDefault: true, toggledBy: null }],
    tools: async () => [echo],
  };
  return { source, stats };
}

const hasToolResult = (messages: LoopMessage[]) => messages.some((message) => message.role === 'tool');

describe('tool approval', () => {
  it('waits for approval, runs the tool once approved and reports each step', async () => {
    const { source, stats } = echoTools({ policy: 'ask' });
    const provider = new FakeProvider((request) =>
      hasToolResult(request.messages)
        ? [{ type: 'text', text: 'Done.' }]
        : [{ type: 'tool_call', call: { id: 'e1', name: 'echo', arguments: '{"text":"hi"}' } }],
    );
    const services = setup(provider, [source]);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });

    const events = await send(services, conversation.id, [pane.id], 'Echo hi', {}, undefined, (event) => {
      if (event.type === 'approval') setTimeout(() => services.approvals.answer(event.request.id, true), 5);
    });

    expect(events.find((event) => event.type === 'approval')).toMatchObject({ request: { toolName: 'echo', label: 'Echo' } });
    expect(events.find((event) => event.type === 'approval_resolved')).toMatchObject({ approved: true });
    expect(stats.calls).toBe(1);
    const message = doneMessage(events);
    expect(message?.content).toBe('Done.');
    expect(message?.activity?.items).toMatchObject([{ kind: 'tool', name: 'echo', done: true, result: 'echo: hi' }]);
  });

  it('tells the model when the user declines', async () => {
    const { source, stats } = echoTools({ policy: 'ask' });
    const provider = new FakeProvider((request) =>
      hasToolResult(request.messages)
        ? [{ type: 'text', text: 'Okay, skipped.' }]
        : [{ type: 'tool_call', call: { id: 'e1', name: 'echo', arguments: '{"text":"hi"}' } }],
    );
    const services = setup(provider, [source]);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });

    const events = await send(services, conversation.id, [pane.id], 'Echo hi', {}, undefined, (event) => {
      if (event.type === 'approval') setTimeout(() => services.approvals.answer(event.request.id, false), 5);
    });

    expect(stats.calls).toBe(0);
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === 'tool');
    expect(toolMessage).toMatchObject({ isError: true });
    expect(toolMessage?.content).toContain('declined');
    expect(doneMessage(events)?.activity?.items).toMatchObject([{ kind: 'tool', status: 'denied', done: true }]);
  });

  it('honors a saved policy over the tool default, and leaves "off" tools out', async () => {
    const { source, stats } = echoTools({ policy: 'ask' });
    const provider = new FakeProvider((request) =>
      hasToolResult(request.messages) ? [{ type: 'text', text: 'ok' }] : [{ type: 'tool_call', call: { id: 'e1', name: 'echo', arguments: '{"text":"x"}' } }],
    );
    const services = setup(provider, [source]);
    await services.settings.set('agent', { ...DEFAULT_SETTINGS.agent, policies: { echo: 'auto' } });
    const { conversation, pane } = await seedConversation(services.repos, { persist: false, useMemory: false });
    const events = await send(services, conversation.id, [pane.id], 'Go');
    expect(events.some((event) => event.type === 'approval')).toBe(false);
    expect(stats.calls).toBe(1);

    await services.settings.set('agent', { ...DEFAULT_SETTINGS.agent, policies: { test: 'off' } });
    await send(services, conversation.id, [pane.id], 'Again');
    expect(provider.requests.at(-1)?.tools?.some((tool) => tool.name === 'echo')).toBe(false);
  });

  it('stops cleanly while a call waits for approval and keeps a replayable trace', async () => {
    const { source } = echoTools({ policy: 'ask' });
    const provider = new FakeProvider((request) =>
      request.messages.at(-1)?.content === 'Never mind'
        ? [{ type: 'text', text: 'Okay.' }]
        : [
            { type: 'text', text: 'Let me echo.' },
            { type: 'tool_call', call: { id: 'e1', name: 'echo', arguments: '{"text":"hi"}' } },
          ],
    );
    const services = setup(provider, [source]);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });
    const controllers = new Map<string, AbortController>();

    const events = await send(services, conversation.id, [pane.id], 'Echo', {}, controllers, (event) => {
      if (event.type === 'approval') setTimeout(() => controllers.get(pane.id)?.abort(), 5);
    });
    expect(doneMessage(events)?.finishReason).toBe('aborted');
    expect(services.approvals.size).toBe(0);

    // The next turn replays the stopped reply, and every call in it has a result.
    await send(services, conversation.id, [pane.id], 'Never mind');
    const replay = provider.requests.at(-1)?.messages ?? [];
    const callIds = replay.flatMap((message) => (message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : []));
    const resultIds = replay.flatMap((message) => (message.role === 'tool' ? [message.toolCallId] : []));
    expect(callIds).toEqual(['e1']);
    expect(resultIds).toEqual(callIds);
    expect(replay.at(-1)).toEqual({ role: 'user', content: 'Never mind' });
  });
});

describe('tool loop', () => {
  it('runs at most maxParallelTools calls at once', async () => {
    const { source, stats } = echoTools({ delayMs: 20 });
    const calls = Array.from({ length: 5 }, (_, index) => ({
      type: 'tool_call' as const,
      call: { id: `e${index}`, name: 'echo', arguments: `{"text":"${index}"}` },
    }));
    const provider = new FakeProvider((request) => (hasToolResult(request.messages) ? [{ type: 'text', text: 'ok' }] : calls));
    const services = setup(provider, [source]);
    await services.settings.set('agent', { ...DEFAULT_SETTINGS.agent, maxParallelTools: 2 });
    const { conversation, pane } = await seedConversation(services.repos, { persist: false, useMemory: false });

    await send(services, conversation.id, [pane.id], 'Echo five');
    expect(stats.calls).toBe(5);
    expect(stats.peak).toBe(2);
    const results = provider.requests[1]?.messages.filter((message) => message.role === 'tool') ?? [];
    expect(results.map((message) => message.content)).toEqual(['echo: 0', 'echo: 1', 'echo: 2', 'echo: 3', 'echo: 4']);
  });

  it('rejects arguments that do not match the schema without running the tool', async () => {
    const { source, stats } = echoTools();
    const provider = new FakeProvider((request) =>
      hasToolResult(request.messages) ? [{ type: 'text', text: 'ok' }] : [{ type: 'tool_call', call: { id: 'e1', name: 'echo', arguments: '{"txt":1}' } }],
    );
    const services = setup(provider, [source]);
    const { conversation, pane } = await seedConversation(services.repos, { persist: false, useMemory: false });
    await send(services, conversation.id, [pane.id], 'Echo');
    expect(stats.calls).toBe(0);
    const result = provider.requests[1]?.messages.find((message) => message.role === 'tool');
    expect(result?.content).toContain('arguments.text is required');
    expect(result?.content).toContain('arguments.txt is not an accepted argument');
  });

  it('applies a profile: its tool groups, round limit and generation settings', async () => {
    const { source } = echoTools();
    const provider = new FakeProvider(() => [{ type: 'text', text: 'ok' }]);
    const services = setup(provider, [source]);
    const { repos } = services;
    const profile = await repos.systemPrompts.create({
      name: 'Echo only',
      content: 'Use echo.',
      isDefault: false,
      tools: ['test'],
      maxToolRounds: 12,
      params: { temperature: 0.9, reasoningEffort: 'high' },
    });
    const { conversation, pane } = await seedConversation(repos, { persist: false });
    await repos.panes.update(pane.id, { systemPromptId: profile.id, systemPrompt: null, params: {} });

    await send(services, conversation.id, [pane.id], 'Hi');
    const request = provider.requests[0];
    expect(request?.tools?.map((tool) => tool.name)).toEqual(['echo']);
    expect(request?.system).toContain('Use echo.');
    expect(request?.system).not.toContain('long-term memory');
    expect(request?.params).toMatchObject({ temperature: 0.9, reasoningEffort: 'high' });
    const preview = await services.chat.preview(conversation, (await repos.panes.findById(pane.id))!);
    expect(preview.maxToolRounds).toBe(12);
  });

  it('turns optional groups on and off per chat', async () => {
    const provider = new FakeProvider(() => [{ type: 'text', text: 'ok' }]);
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { persist: false, useMemory: false, toolGroups: { code: false } });
    await send(services, conversation.id, [pane.id], 'Hi');
    const names = provider.requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain('current_time');
    expect(names).not.toContain('run_js');
  });
});

describe('history across turns', () => {
  async function twoTurns(keepToolResults: 'full' | 'summary' | 'off', secondModel?: string) {
    const { source } = echoTools();
    const provider = new FakeProvider((request) => {
      const last = request.messages.at(-1);
      if (last?.role === 'user' && last.content === 'first') {
        return [{ type: 'tool_call', call: { id: 'e1', name: 'echo', arguments: `{"text":"${'x'.repeat(3000)}"}` } }, { type: 'assistant_raw', content: [{ type: 'tool_use' }] }];
      }
      return [{ type: 'text', text: 'answer' }];
    });
    const services = setup(provider, [source]);
    await services.settings.set('agent', { ...DEFAULT_SETTINGS.agent, keepToolResults });
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });
    await send(services, conversation.id, [pane.id], 'first');
    if (secondModel) await services.repos.panes.update(pane.id, { model: secondModel });
    await send(services, conversation.id, [pane.id], 'second');
    return provider.requests.at(-1)?.messages ?? [];
  }

  it('replays tool calls and full results to the same model', async () => {
    const messages = await twoTurns('full');
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    const call = messages[1];
    expect(call?.role === 'assistant' && call.raw).toEqual([{ type: 'tool_use' }]);
    expect(messages[2]?.content.length).toBeGreaterThan(3000);
  });

  it('shortens results in summary mode and drops provider blocks for another model', async () => {
    const messages = await twoTurns('summary', 'other/model');
    const call = messages[1];
    expect(call?.role === 'assistant' && call.raw).toBeUndefined();
    expect(messages[2]?.content.length).toBeLessThan(1500);
  });

  it('keeps only the final text when tool results are off', async () => {
    const messages = await twoTurns('off');
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]);
  });
});

describe('regenerate and edit', () => {
  it('drops later replies, answers again and replaces an edited message', async () => {
    let reply = 0;
    const provider = new FakeProvider(() => [{ type: 'text', text: `reply ${++reply}` }]);
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });
    await send(services, conversation.id, [pane.id], 'one');
    await send(services, conversation.id, [pane.id], 'two');

    const regenerated = await send(services, conversation.id, [pane.id], '', { action: 'regenerate', content: null });
    expect(regenerated.map((event) => event.type)).toEqual(['truncate', 'start', 'delta', 'done']);
    let rows = await services.store.list(conversation, pane.id);
    expect(rows.map((row) => row.content)).toEqual(['one', 'reply 1', 'two', 'reply 3']);

    const firstUser = rows[0]?.id ?? '';
    const edited: StreamEvent[] = await send(services, conversation.id, [pane.id], 'uno', { action: 'edit', messageId: firstUser });
    expect(edited.slice(0, 2).map((event) => event.type)).toEqual(['truncate', 'user']);
    rows = await services.store.list(conversation, pane.id);
    expect(rows.map((row) => row.content)).toEqual(['uno', 'reply 4']);
    expect(rows[0]?.id).toBe(firstUser);
    expect(provider.requests.at(-1)?.messages).toEqual([{ role: 'user', content: 'uno' }]);
  });

  it('edits the same message in several panes at once', async () => {
    const provider = new FakeProvider(() => [{ type: 'text', text: 'ok' }]);
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });
    const { id: _id, createdAt: _created, updatedAt: _updated, ...fields } = pane;
    const second = await services.repos.panes.create({ ...fields, position: 1 });
    await send(services, conversation.id, [pane.id, second.id], 'one');

    const firstOf = async (paneId: string) => (await services.store.list(conversation, paneId))[0]?.id ?? '';
    const messageIds = { [pane.id]: await firstOf(pane.id), [second.id]: await firstOf(second.id) };
    await send(services, conversation.id, [pane.id, second.id], 'uno', { action: 'edit', messageIds });
    for (const paneId of [pane.id, second.id]) {
      expect((await services.store.list(conversation, paneId)).map((row) => row.content)).toEqual(['uno', 'ok']);
    }

    await expect(send(services, conversation.id, [pane.id, second.id], 'dos', { action: 'edit', messageId: messageIds[pane.id] })).rejects.toThrow(
      'Name the message to edit in each pane',
    );
  });
});

describe('attachments', () => {
  it('sends images and text files with the message and offers read_attachment', async () => {
    const provider = new FakeProvider(() => [{ type: 'text', text: 'Nice cat.' }]);
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
    const image = await services.attachments.create({ name: 'cat.png', mimeType: 'image/png', data: png });
    const notes = await services.attachments.create({ name: 'notes.md', mimeType: '', data: Buffer.from('# Notes').toString('base64') });

    const events = await send(services, conversation.id, [pane.id], 'What is this?', { attachmentIds: [image.id, notes.id] });

    const user = events.find((event) => event.type === 'user');
    expect(user?.type === 'user' && user.message.attachments?.map((ref) => ref.name)).toEqual(['cat.png', 'notes.md']);
    const sent = provider.requests[0]?.messages[0];
    expect(sent?.role === 'user' && sent.attachments?.map((item) => item.kind)).toEqual(['image', 'text']);
    expect(sent?.role === 'user' && sent.attachments?.[0]?.data).toBe(png);
    expect(sent?.role === 'user' && sent.attachments?.[1]?.text).toBe('# Notes');
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toContain('read_attachment');
    expect((await services.repos.attachments.findById(image.id))?.conversationId).toBe(conversation.id);
  });

  it('refuses attachments from another chat and unsupported files', async () => {
    const services = setup(new FakeProvider(() => []));
    const first = await seedConversation(services.repos);
    const other = await seedConversation(services.repos);
    const file = await services.attachments.create({ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('hi').toString('base64'), conversationId: other.conversation.id });
    await expect(services.attachments.claim([file.id], first.conversation.id)).rejects.toThrow('could not be found');
    await expect(services.attachments.create({ name: 'a.exe', mimeType: 'application/octet-stream', data: Buffer.from([0, 1, 2]).toString('base64') })).rejects.toThrow("isn't a supported file");
  });
});
