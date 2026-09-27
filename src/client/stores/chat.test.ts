import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem, StreamEvent, StreamRequest } from '../../shared/types.ts';
import { api, ApiError } from '../api/client.ts';
import { followRun, streamChat } from '../api/stream.ts';
import { conversationWith, message, pane } from '../testing.ts';
import { applyMessageEvent, useChatStore } from './chat.ts';

vi.mock('../api/stream.ts', () => ({ streamChat: vi.fn<typeof streamChat>(), followRun: vi.fn<typeof followRun>() }));
vi.mock('../api/client.ts', async (actual) => ({ ...(await actual<Record<string, unknown>>()), api: vi.fn<typeof api>() }));

const stream = vi.mocked(streamChat);
const resume = vi.mocked(followRun);
const request = vi.mocked(api);
const conversation = conversationWith([pane('p1', 'vendor/alpha', 0), pane('p2', 'vendor/beta', 1)]);

/** Answers the next stream with the events built for its request, numbered from 1. */
function replyWith(events: (request: StreamRequest) => StreamEvent[]): void {
  stream.mockImplementationOnce(async (body, onEvent) => {
    events(body).forEach((event, index) => onEvent(event, index + 1));
  });
}

function tool(done: boolean): ActivityItem {
  return { id: 't1', kind: 'tool', name: 'current_time', label: 'Current time', args: '{}', done };
}

const state = () => useChatStore.getState();
const paneOf = (paneId: string) => state().conversations.c1?.panes[paneId];

beforeEach(() => {
  // Deltas are flushed once per frame; run frames straight away.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  // By default a dropped run can't be found again.
  resume.mockRejectedValue(new ApiError('Run not found', 404));
  useChatStore.setState({ conversations: {}, onRunFinished: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('applyMessageEvent', () => {
  it('adds or replaces the message from the user and cuts history after a truncate', () => {
    const history = [message('u1', 'p1', 'user', 'hi'), message('a1', 'p1', 'assistant', 'hello')];
    const replaced = applyMessageEvent(history, { type: 'user', paneId: 'p1', message: message('u1', 'p1', 'user', 'hey') });
    expect(replaced.map((entry) => entry.content)).toEqual(['hey', 'hello']);
    expect(applyMessageEvent(history, { type: 'truncate', paneId: 'p1', messageId: 'u1' }).map((entry) => entry.id)).toEqual(['u1']);
    expect(applyMessageEvent(history, { type: 'truncate', paneId: 'p1', messageId: 'gone' })).toBe(history);
  });
});

describe('chat store', () => {
  it('streams a reply into each pane and finishes the run', async () => {
    const finished = vi.fn<(conversationId: string) => void>();
    useChatStore.setState({ onRunFinished: finished });
    let liveText = '';
    replyWith((body) =>
      body.paneIds.flatMap((paneId): StreamEvent[] => [
        { type: 'user', paneId, message: message(`u-${paneId}`, paneId, 'user', 'Hello') },
        { type: 'start', paneId, messageId: `a-${paneId}` },
        { type: 'delta', paneId, text: 'Hi ' },
        { type: 'delta', paneId, text: 'there' },
        { type: 'end' },
      ]),
    );
    const unsubscribe = useChatStore.subscribe((next) => {
      liveText = next.conversations.c1?.panes.p1?.live?.text ?? liveText;
    });

    await state().send(conversation, 'Hello', ['p1']);
    unsubscribe();

    expect(stream.mock.calls[0]?.[0]).toMatchObject({ conversationId: 'c1', action: 'send', content: 'Hello', paneIds: ['p1'] });
    expect(liveText).toBe('Hi there');
    // No done event arrived, so the live reply is dropped and only the message from the user stays.
    expect(paneOf('p1')).toEqual({ messages: [expect.objectContaining({ id: 'u-p1' })], live: null });
    expect(state().conversations.c1?.runId).toBeNull();
    expect(finished).toHaveBeenCalledWith('c1');
  });

  it('keeps the saved reply and merges activity updates by id', async () => {
    let activity: unknown[] = [];
    replyWith(() => [
      { type: 'start', paneId: 'p1', messageId: 'a1' },
      { type: 'activity', paneId: 'p1', item: tool(false) },
      { type: 'activity', paneId: 'p1', item: tool(true) },
      { type: 'done', paneId: 'p1', message: message('a1', 'p1', 'assistant', 'Done') },
      { type: 'end' },
    ]);
    const unsubscribe = useChatStore.subscribe((next) => {
      activity = next.conversations.c1?.panes.p1?.live?.activity ?? activity;
    });
    await state().send(conversation, 'Go', ['p1']);
    unsubscribe();

    expect(activity).toEqual([tool(true)]);
    expect(paneOf('p1')?.messages.map((entry) => entry.content)).toEqual(['Done']);
  });

  it('turns a failed stream into an error reply in every pane still waiting', async () => {
    stream.mockRejectedValueOnce(new Error('Network down'));
    await state().send(conversation, 'Hello', ['p1', 'p2']);

    for (const paneId of ['p1', 'p2']) {
      expect(paneOf(paneId)?.messages).toEqual([
        expect.objectContaining({ role: 'assistant', error: 'Network down', paneId, model: paneId === 'p1' ? 'vendor/alpha' : 'vendor/beta' }),
      ]);
    }
  });

  it('queues a second send while one is going, then sends it once the first finishes', async () => {
    const pending = Promise.withResolvers<void>();
    stream.mockImplementationOnce(() => pending.promise);
    stream.mockImplementationOnce(async () => {});
    const first = state().send(conversation, 'One', ['p1']);
    await state().send(conversation, 'Two', ['p1']);

    // Held back, not sent yet, but visible so it can show in the transcript.
    expect(stream).toHaveBeenCalledTimes(1);
    expect(state().conversations.c1?.queue.map((item) => item.content)).toEqual(['Two']);

    pending.resolve();
    await first;
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
    expect(stream.mock.calls[1]?.[0]).toMatchObject({ conversationId: 'c1', action: 'send', content: 'Two', paneIds: ['p1'] });
    expect(state().conversations.c1?.queue).toEqual([]);
  });

  it('lets a queued send be cancelled before it runs', async () => {
    const pending = Promise.withResolvers<void>();
    stream.mockImplementationOnce(() => pending.promise);
    const first = state().send(conversation, 'One', ['p1']);
    await state().send(conversation, 'Two', ['p1']);
    const queuedId = state().conversations.c1?.queue[0]?.id;
    expect(queuedId).toBeDefined();

    state().cancelQueued('c1', queuedId as string);
    expect(state().conversations.c1?.queue).toEqual([]);

    pending.resolve();
    await first;
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('regenerates from the last message from the user', async () => {
    state().hydrate('c1', [
      message('u1', 'p1', 'user', 'first'),
      message('a1', 'p1', 'assistant', 'one'),
      message('u2', 'p1', 'user', 'second'),
      message('a2', 'p1', 'assistant', 'two'),
    ]);
    let before: string[] = [];
    stream.mockImplementationOnce(async () => {
      before = paneOf('p1')?.messages.map((entry) => entry.id) ?? [];
    });
    await state().regenerate(conversation, 'p1');

    expect(before).toEqual(['u1', 'a1', 'u2']);
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ action: 'regenerate', content: null, paneIds: ['p1'] });
  });

  it('edits the same message in every pane that has it', async () => {
    state().hydrate('c1', [
      message('u1', 'p1', 'user', 'first'),
      message('a1', 'p1', 'assistant', 'one'),
      message('u3', 'p2', 'user', 'first'),
      message('b1', 'p2', 'assistant', 'uno'),
    ]);
    let during: Record<string, string[]> = {};
    stream.mockImplementationOnce(async () => {
      during = { p1: paneOf('p1')?.messages.map((entry) => entry.content) ?? [], p2: paneOf('p2')?.messages.map((entry) => entry.content) ?? [] };
    });
    await state().edit(conversation, 'p1', 'u1', 'rewritten');

    expect(during).toEqual({ p1: ['rewritten'], p2: ['rewritten'] });
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ action: 'edit', content: 'rewritten', paneIds: ['p1', 'p2'], messageIds: { p1: 'u1', p2: 'u3' } });
  });

  it('marks one reply as the best and puts it back when saving fails', async () => {
    state().hydrate('c1', [
      message('u1', 'p1', 'user', 'first'),
      message('a1', 'p1', 'assistant', 'one'),
      message('u3', 'p2', 'user', 'first'),
      message('b1', 'p2', 'assistant', 'uno', { preferred: true }),
    ]);
    request.mockImplementation(async (path) => {
      if (path.endsWith('/a1')) throw new Error('offline');
      return {};
    });
    const reply = paneOf('p1')?.messages[1];
    if (!reply) throw new Error('missing reply');
    await state().setPreferred('c1', reply, true);

    expect(request).toHaveBeenCalledWith('/conversations/c1/messages/b1', { method: 'PATCH', json: { preferred: false } });
    expect(paneOf('p1')?.messages[1]?.preferred).toBeNull();
    expect(paneOf('p2')?.messages[1]?.preferred).toBe(false);
  });

  it('picks a dropped run back up after the last event it saw', async () => {
    replyWith(() => [
      { type: 'start', paneId: 'p1', messageId: 'a1' },
      { type: 'delta', paneId: 'p1', text: 'Hel' },
    ]);
    const reconnecting: boolean[] = [];
    resume.mockImplementationOnce(async (_runId, after, onEvent) => {
      reconnecting.push(paneOf('p1')?.live?.reconnecting ?? false);
      // The replay may repeat an event already seen.
      onEvent({ type: 'delta', paneId: 'p1', text: 'Hel' }, 2);
      onEvent({ type: 'delta', paneId: 'p1', text: 'lo' }, 3);
      reconnecting.push(paneOf('p1')?.live?.reconnecting ?? true);
      onEvent({ type: 'done', paneId: 'p1', message: message('a1', 'p1', 'assistant', 'Hello') }, 4);
      onEvent({ type: 'end' }, 5);
      expect(after).toBe(2);
    });
    await state().send(conversation, 'Hi', ['p1']);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(reconnecting).toEqual([true, false]);
    expect(paneOf('p1')?.messages.map((entry) => entry.content)).toEqual(['Hello']);
  });

  it('shows what the server saved when a dropped run is gone', async () => {
    replyWith(() => [
      { type: 'start', paneId: 'p1', messageId: 'a1' },
      { type: 'delta', paneId: 'p1', text: 'Partial' },
    ]);
    request.mockResolvedValueOnce([
      message('u1', 'p1', 'user', 'Hi'),
      message('a1', 'p1', 'assistant', 'Partial answer', { finishReason: 'interrupted', error: 'The server stopped' }),
    ]);
    await state().send(conversation, 'Hi', ['p1']);

    expect(request).toHaveBeenCalledWith('/conversations/c1/messages');
    expect(paneOf('p1')?.messages.map((entry) => entry.content)).toEqual(['Hi', 'Partial answer']);
  });

  it('keeps the text that arrived when nothing can be recovered', async () => {
    stream.mockImplementationOnce(async (_body, onEvent) => {
      onEvent({ type: 'start', paneId: 'p1', messageId: 'a1' }, 1);
      onEvent({ type: 'reasoning', paneId: 'p1', text: 'Thinking hard' }, 2);
      onEvent({ type: 'delta', paneId: 'p1', text: 'Half an' }, 3);
      throw new Error('Lost the connection to the server.');
    });
    request.mockRejectedValueOnce(new Error('offline'));
    await state().send(conversation, 'Hi', ['p1']);

    expect(paneOf('p1')?.messages).toEqual([
      expect.objectContaining({ id: 'a1', content: 'Half an', reasoning: 'Thinking hard', error: 'Lost the connection to the server.' }),
    ]);
  });

  it('does not try to reconnect to a run the server refused', async () => {
    stream.mockRejectedValueOnce(new ApiError('Message is empty', 400));
    await state().send(conversation, 'Hi', ['p1']);

    expect(resume).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(paneOf('p1')?.messages).toEqual([expect.objectContaining({ error: 'Message is empty' })]);
  });

  it('continues an unfinished reply from what it already says', async () => {
    state().hydrate('c1', [message('u1', 'p1', 'user', 'Solve it'), message('a1', 'p1', 'assistant', 'Step one', { finishReason: 'aborted', reasoning: 'hmm' })]);
    let live: { text: string; reasoning: string } | undefined;
    let during: string[] = [];
    stream.mockImplementationOnce(async (_body, onEvent) => {
      during = paneOf('p1')?.messages.map((entry) => entry.id) ?? [];
      onEvent({ type: 'start', paneId: 'p1', messageId: 'a1', text: 'Step one', reasoning: 'hmm' }, 1);
      onEvent({ type: 'delta', paneId: 'p1', text: ', step two' }, 2);
      live = paneOf('p1')?.live ?? undefined;
      onEvent({ type: 'done', paneId: 'p1', message: message('a1', 'p1', 'assistant', 'Step one, step two') }, 3);
      onEvent({ type: 'end' }, 4);
    });
    await state().continueReply(conversation, 'p1', 'a1');

    expect(stream.mock.calls[0]?.[0]).toMatchObject({ action: 'continue', paneIds: ['p1'], messageIds: { p1: 'a1' } });
    expect(during).toEqual(['u1']);
    expect(live).toMatchObject({ text: 'Step one, step two', reasoning: 'hmm' });
    expect(paneOf('p1')?.messages.map((entry) => entry.content)).toEqual(['Solve it', 'Step one, step two']);
  });

  it('attaches to a reply the server is still writing when a chat loads', async () => {
    request.mockImplementation(async (path) => (path === '/conversations/c1/runs' ? [{ runId: 'r1', paneIds: ['p1'] }] : []));
    resume.mockImplementationOnce(async (runId, after, onEvent) => {
      expect([runId, after]).toEqual(['r1', 0]);
      onEvent({ type: 'start', paneId: 'p1', messageId: 'a1' }, 2);
      onEvent({ type: 'delta', paneId: 'p1', text: 'So far' }, 3);
      onEvent({ type: 'done', paneId: 'p1', message: message('a1', 'p1', 'assistant', 'So far, done') }, 4);
      onEvent({ type: 'end' }, 5);
    });
    state().hydrate('c1', [message('u1', 'p1', 'user', 'Go'), message('a1', 'p1', 'assistant', 'So', { finishReason: 'streaming' })]);

    await vi.waitFor(() => expect(state().conversations.c1?.runId).toBeNull());
    expect(resume).toHaveBeenCalledTimes(1);
    expect(paneOf('p1')?.messages.map((entry) => entry.content)).toEqual(['Go', 'So far, done']);
  });

  it('hydrates once and forgets a conversation', () => {
    state().hydrate('c1', [message('u1', 'p1', 'user', 'first')]);
    state().hydrate('c1', []);
    expect(paneOf('p1')?.messages).toHaveLength(1);
    state().forget('c1');
    expect(state().conversations.c1).toBeUndefined();
  });
});
