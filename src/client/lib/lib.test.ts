import { describe, expect, it } from 'vitest';
import type { ConversationDetail, Message, Pane } from '../../shared/types.ts';
import { diffWords, overlap } from './diff.ts';
import { toHtml, toMarkdown } from './export.ts';
import { editCountKey, sameUserMessage, siblingReplies, totalsOf, turnIndex, turnsOf } from './turns.ts';

function message(id: string, paneId: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'c1',
    paneId,
    role,
    content,
    reasoning: null,
    provider: 'openrouter',
    model: 'a/model',
    tokensIn: null,
    tokensOut: null,
    ttftMs: null,
    latencyMs: null,
    cost: null,
    finishReason: null,
    error: null,
    activity: null,
    attachments: null,
    preferred: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...extra,
  };
}

function pane(id: string, model: string, position: number): Pane {
  return {
    id,
    conversationId: 'c1',
    position,
    provider: 'openrouter',
    model,
    systemPromptId: null,
    systemPrompt: null,
    params: {},
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
  } as Pane;
}

const conversation = {
  id: 'c1',
  title: 'Compare <models>',
  panes: [pane('p1', 'vendor/alpha', 0), pane('p2', 'vendor/beta', 1)],
} as ConversationDetail;

const messagesByPane: Record<string, Message[]> = {
  p1: [
    message('u1', 'p1', 'user', 'first'),
    message('a1', 'p1', 'assistant', 'Alpha says **hi**', { tokensIn: 10, tokensOut: 5, cost: 0.002, latencyMs: 900 }),
    message('u2', 'p1', 'user', 'second'),
    message('a2', 'p1', 'assistant', 'Alpha again', { preferred: true }),
  ],
  p2: [
    message('u3', 'p2', 'user', 'first'),
    message('b1', 'p2', 'assistant', 'Beta says hi <script>alert(1)</script>', { tokensIn: 12, tokensOut: 7, latencyMs: 1400 }),
    message('u4', 'p2', 'user', 'a different second'),
  ],
};

describe('turns', () => {
  it('lines up exchanges across panes', () => {
    const turns = turnsOf(conversation, messagesByPane);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.replies.map((reply) => reply.message?.id)).toEqual(['a1', 'b1']);
    expect(turns[1]?.replies.map((reply) => reply.message?.id ?? null)).toEqual(['a2', null]);
    expect(turnIndex(messagesByPane.p1 ?? [], 'a2')).toBe(1);
    expect(turnIndex(messagesByPane.p1 ?? [], 'missing')).toBe(-1);
  });

  it('finds the same message in other panes only when the text matches', () => {
    expect(sameUserMessage(messagesByPane, 'p1', 'u1')).toEqual({ p1: 'u1', p2: 'u3' });
    expect(sameUserMessage(messagesByPane, 'p1', 'u2')).toEqual({ p1: 'u2' });
    expect(sameUserMessage(messagesByPane, 'p1', 'a1')).toEqual({});
    expect(editCountKey(messagesByPane, 'p1')).toBe('u1:2,u2:1');
  });

  it('finds replies to the same exchange and adds them up', () => {
    const first = messagesByPane.p1?.[1] as Message;
    expect(siblingReplies(messagesByPane, first).map((reply) => reply.id)).toEqual(['b1']);
    const totals = totalsOf([first, messagesByPane.p2?.[1] ?? null, null]);
    expect(totals).toMatchObject({ replies: 2, tokensIn: 22, tokensOut: 12, cost: 0.002, costPartial: true, wallMs: 1400 });
  });
});

describe('diffWords', () => {
  it('marks added and removed words and rebuilds the second text', () => {
    const parts = diffWords('the quick brown fox', 'the slow brown fox jumps');
    const text = (kinds: string[]) => parts.filter((part) => kinds.includes(part.kind)).map((part) => part.text).join('');
    // Matching words take their spacing from the second text.
    expect(text(['same', 'removed']).trim()).toBe('the quick brown fox');
    expect(text(['same', 'added'])).toBe('the slow brown fox jumps');
    expect(parts.filter((part) => part.kind === 'removed').map((part) => part.text.trim())).toEqual(['quick']);
    expect(overlap(parts)).toBeCloseTo(3 / 5);
    expect(overlap(diffWords('', ''))).toBe(1);
  });
});

describe('export', () => {
  it('writes Markdown with each reply under its model', () => {
    const markdown = toMarkdown(conversation, messagesByPane);
    expect(markdown).toContain('# Compare <models>');
    expect(markdown).toContain('### vendor/alpha (OpenRouter)');
    expect(markdown).toContain('### vendor/alpha (OpenRouter) ★ best reply');
    expect(markdown).toContain('_No reply._');
  });

  it('writes HTML that escapes the title and never passes raw HTML from replies', () => {
    const html = toHtml(conversation, messagesByPane);
    expect(html).toContain('<title>Compare &lt;models&gt;</title>');
    expect(html).toContain('<strong>hi</strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('class="reply best"');
  });
});
