import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../../shared/types.ts';
import type { Services } from '../context.ts';
import { withContinueNote } from './chat.ts';
import { coalesce, RunRegistry, type RunEntry } from './runs.ts';
import { doneMessage, FakeProvider, seedConversation, send, setup } from './testing.ts';

const delta = (paneId: string, text: string): StreamEvent => ({ type: 'delta', paneId, text });

/** Collects what a subscriber sees until the run ends. */
function watch(registry: RunRegistry, runId: string, after = 0): { entries: RunEntry[]; ended: Promise<void> } {
  const entries: RunEntry[] = [];
  const ended = Promise.withResolvers<void>();
  registry.subscribe(runId, after, (entry) => {
    entries.push(entry);
    if (entry.event.type === 'end') ended.resolve();
  });
  return { entries, ended: ended.promise };
}

describe('RunRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a run going with nobody listening and replays it afterwards', async () => {
    const registry = new RunRegistry();
    const gate = Promise.withResolvers<void>();
    registry.start({ runId: 'r1', conversationId: 'c1', paneIds: ['p1'] }, async (emit) => {
      emit({ type: 'start', paneId: 'p1', messageId: 'a1' });
      emit(delta('p1', 'Hel'));
      await gate.promise;
      emit(delta('p1', 'lo'));
    });

    const first = watch(registry, 'r1');
    expect(first.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(registry.active('c1')).toEqual([{ runId: 'r1', paneIds: ['p1'] }]);

    gate.resolve();
    await first.ended;
    expect(registry.active('c1')).toEqual([]);

    // A late client that saw event 2 gets only the rest.
    const late = watch(registry, 'r1', 2);
    await late.ended;
    expect(late.entries).toEqual([
      { seq: 3, event: delta('p1', 'lo') },
      { seq: 4, event: { type: 'end' } },
    ]);
  });

  it('reports a thrown run as an error in every pane, then ends', async () => {
    const registry = new RunRegistry();
    registry.start({ runId: 'r1', conversationId: 'c1', paneIds: ['p1', 'p2'] }, async () => {
      throw new Error('Conversation not found');
    });
    const { entries, ended } = watch(registry, 'r1');
    await ended;
    expect(entries.map((entry) => entry.event)).toEqual([
      { type: 'error', paneId: 'p1', error: 'Conversation not found', message: null },
      { type: 'error', paneId: 'p2', error: 'Conversation not found', message: null },
      { type: 'end' },
    ]);
  });

  it('stops one pane or the whole run, and forgets finished runs after a while', async () => {
    vi.useFakeTimers();
    const registry = new RunRegistry({ retentionMs: 1_000 });
    const aborted: string[] = [];
    registry.start({ runId: 'r1', conversationId: 'c1', paneIds: ['p1', 'p2'] }, async (_emit, controllers) => {
      await Promise.all(
        ['p1', 'p2'].map(async (paneId) => {
          const controller = new AbortController();
          controllers.set(paneId, controller);
          await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve()));
          aborted.push(paneId);
        }),
      );
    });
    expect(registry.stop('r1', 'p2')).toBe(true);
    await vi.waitFor(() => expect(aborted).toEqual(['p2']));
    registry.stopConversation('c1');
    await vi.waitFor(() => expect(aborted).toEqual(['p2', 'p1']));
    await vi.waitFor(() => expect(registry.active('c1')).toEqual([]));

    expect(registry.has('r1')).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(registry.has('r1')).toBe(false);
    expect(registry.subscribe('r1', 0, () => {})).toBeNull();
    expect(registry.stop('r1')).toBe(false);
  });

  it('joins neighboring chunks of the same kind and pane when replaying', () => {
    const entries: RunEntry[] = [
      { seq: 1, event: delta('p1', 'a') },
      { seq: 2, event: delta('p1', 'b') },
      { seq: 3, event: delta('p2', 'x') },
      { seq: 4, event: delta('p1', 'c') },
      { seq: 5, event: { type: 'reasoning', paneId: 'p1', text: 'r' } },
      { seq: 6, event: { type: 'reasoning', paneId: 'p1', text: 's' } },
    ];
    expect(coalesce(entries)).toEqual([
      { seq: 2, event: delta('p1', 'ab') },
      { seq: 3, event: delta('p2', 'x') },
      { seq: 4, event: delta('p1', 'c') },
      { seq: 6, event: { type: 'reasoning', paneId: 'p1', text: 'rs' } },
    ]);
  });
});

describe('saving replies as they stream', () => {
  it('writes the reply to its row before it finishes, and records usage once at the end', async () => {
    let midway: { content: string; finishReason: string | null } | undefined;
    const services: Services = setup(
      new FakeProvider(async () => {
        const rows = await services.repos.messages.findMany({ where: { role: 'assistant' } });
        midway = rows[0] && { content: rows[0].content, finishReason: rows[0].finishReason };
        return [
          { type: 'text', text: 'Done' },
          { type: 'usage', inputTokens: 5, outputTokens: 1 },
        ];
      }),
    );
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });

    const events = await send(services, conversation.id, [pane.id], 'Hi');

    expect(midway).toEqual({ content: '', finishReason: 'streaming' });
    const message = doneMessage(events);
    const [row] = await services.repos.messages.findMany({ where: { role: 'assistant' } });
    expect(row).toMatchObject({ id: message?.id, content: 'Done', finishReason: null });
    expect(await services.repos.usage.findMany()).toMatchObject([{ id: message?.id, tokensIn: 5, tokensOut: 1 }]);
  });

  it('marks replies left mid-stream by a shutdown as interrupted', async () => {
    const services = setup(new FakeProvider(() => []));
    const { conversation, pane } = await seedConversation(services.repos);
    const base = { conversationId: conversation.id, paneId: pane.id, reasoning: null, provider: 'openrouter', model: 'm', tokensIn: null, tokensOut: null, ttftMs: null, latencyMs: null, cost: null, activity: null, attachments: null, trace: null, preferred: null };
    await services.store.create(conversation, { ...base, id: 'a1', role: 'assistant', content: 'Half', finishReason: 'streaming', error: null });
    await services.store.create(conversation, { ...base, id: 'a2', role: 'assistant', content: 'Whole', finishReason: 'stop', error: null });

    expect(await services.store.markInterrupted()).toBe(1);
    expect(await services.repos.messages.findById('a1')).toMatchObject({ content: 'Half', finishReason: 'interrupted', error: expect.stringContaining('server stopped') });
    expect(await services.repos.messages.findById('a2')).toMatchObject({ finishReason: 'stop', error: null });
  });
});

describe('continuing a reply', () => {
  it('feeds the unfinished reply back and adds the rest to the same message', async () => {
    let calls = 0;
    const provider = new FakeProvider(() =>
      calls++ === 0
        ? [
            { type: 'reasoning', text: 'Try the corners first.' },
            { type: 'text', text: 'The first row is' },
            { type: 'usage', inputTokens: 10, outputTokens: 4 },
            { type: 'finish', reason: 'length' },
          ]
        : [
            { type: 'reasoning', text: 'Now the middle.' },
            { type: 'text', text: ' 3, 1, 2.' },
            { type: 'usage', inputTokens: 20, outputTokens: 3 },
            { type: 'finish', reason: 'stop' },
          ],
    );
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });
    const first = doneMessage(await send(services, conversation.id, [pane.id], 'Solve the puzzle'));
    expect(first?.finishReason).toBe('length');

    const events = await send(services, conversation.id, [pane.id], '', { action: 'continue', content: null, messageIds: { [pane.id]: first?.id ?? '' } });

    expect(events.find((event) => event.type === 'start')).toEqual({
      type: 'start',
      paneId: pane.id,
      messageId: first?.id,
      text: 'The first row is',
      reasoning: 'Try the corners first.',
    });
    const sent = provider.requests[1]?.messages ?? [];
    expect(sent.slice(0, 2)).toEqual([
      { role: 'user', content: 'Solve the puzzle' },
      { role: 'assistant', content: 'The first row is' },
    ]);
    expect(sent[2]?.role).toBe('user');
    expect(sent[2]?.content).toContain('Try the corners first.');
    expect(sent[2]?.content).toContain('Continue your reply from exactly where it stops');

    const message = doneMessage(events);
    expect(message).toMatchObject({
      id: first?.id,
      content: 'The first row is 3, 1, 2.',
      reasoning: 'Try the corners first.\n\nNow the middle.',
      finishReason: 'stop',
      error: null,
      tokensIn: 30,
      tokensOut: 7,
    });
    expect(await services.repos.messages.count()).toBe(2);
    // The continuation's own cost is recorded separately from the first attempt's.
    const usage = await services.repos.usage.findMany();
    expect(usage.map((entry) => [entry.tokensIn, entry.tokensOut]).toSorted()).toEqual([
      [10, 4],
      [20, 3],
    ]);
  });

  it('adds the note to the question when the reply had no text yet', () => {
    const messages = withContinueNote([{ role: 'user', content: 'Solve it' }], { content: '', reasoning: 'Half done', finishReason: 'interrupted', error: 'The server stopped' });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toMatch(/^Solve it\n\nYour previous reply was cut off before it was finished \(The server stopped\)\./);
    expect(messages[0]?.content).toContain('<previous_reasoning>\nHalf done\n</previous_reasoning>');
    expect(messages[0]?.content).toContain('You had not written any of your answer yet.');
  });

  it('refuses to continue a reply that is gone', async () => {
    const services = setup(new FakeProvider(() => []));
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false });
    const events = await send(services, conversation.id, [pane.id], '', { action: 'continue', content: null, messageIds: { [pane.id]: 'missing' } });
    expect(events).toEqual([{ type: 'error', paneId: pane.id, error: 'That reply is no longer in this pane.', message: null }]);
  });
});
