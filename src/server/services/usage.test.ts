import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../shared/types.ts';
import { memoryRepos } from '../db/repos.ts';
import type { UsageRecordRow } from '../db/schemas.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { buildReport, normalizeModelId, PriceBook, UsageService, usageFromMessage } from './usage.ts';

const NOW = new Date(2026, 8, 16, 15, 0);

function record(overrides: Partial<UsageRecordRow>): UsageRecordRow {
  return {
    id: crypto.randomUUID(),
    conversationId: 'c1',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-5',
    tokensIn: 1000,
    tokensOut: 100,
    cost: null,
    ttftMs: 500,
    latencyMs: 1500,
    failed: false,
    createdAt: new Date(2026, 8, 16, 9, 0),
    ...overrides,
  };
}

const CATALOG: ModelInfo[] = [
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', name: 'Sonnet', pricing: { input: 3, output: 15 } },
  { provider: 'openrouter', model: 'openai/gpt-5.1', name: 'GPT', pricing: { input: 1, output: 10 } },
];

describe('prices', () => {
  it('normalizes ids across providers', () => {
    expect(normalizeModelId('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('gpt-5.1-2025-11-13')).toBe('gpt-5-1');
  });

  it('matches direct Anthropic and OpenAI models to OpenRouter list prices', () => {
    const book = new PriceBook(CATALOG);
    expect(book.find('anthropic', 'claude-sonnet-4-5-20250929')).toEqual({ input: 3, output: 15 });
    expect(book.find('openai', 'gpt-5.1')).toEqual({ input: 1, output: 10 });
    expect(book.find('openrouter', 'openai/gpt-5.1')).toEqual({ input: 1, output: 10 });
    expect(book.find('custom', 'gpt-5.1')).toBeNull();
  });
});

describe('buildReport', () => {
  it('splits reported, estimated, local and unpriced cost', () => {
    const records = [
      record({ cost: 0.5 }),
      record({ provider: 'anthropic', model: 'claude-sonnet-4-5', tokensIn: 1_000_000, tokensOut: 100_000 }),
      record({ provider: 'ollama', model: 'qwen3:14b', conversationId: 'c2' }),
      record({ provider: 'custom', model: 'mystery', failed: true, ttftMs: null }),
    ];
    const report = buildReport(records, '30d', null, new PriceBook(CATALOG), NOW);

    expect(report.totals).toMatchObject({ replies: 4, failed: 1, chats: 2, reportedCost: 0.5, estimatedCost: 4.5, cost: 5, unpricedReplies: 1 });
    expect(report.totals.medianTtftMs).toBe(500);
    expect(report.totals.medianTokensPerSecond).toBe(100);
    expect(report.models.map((row) => [row.provider, row.costKind])).toEqual([
      ['anthropic', 'estimated'],
      ['openrouter', 'reported'],
      ['ollama', 'local'],
      ['custom', 'unknown'],
    ]);
    expect(report.providers).toEqual(['anthropic', 'custom', 'ollama', 'openrouter']);
  });

  it('fills every day in the range and filters by provider', () => {
    const records = [
      record({ cost: 1, createdAt: new Date(2026, 8, 10, 23, 30) }),
      record({ provider: 'openai', model: 'gpt-5.1' }),
    ];
    const report = buildReport(records, '7d', 'openrouter', new PriceBook([]), NOW);
    expect(report.buckets.map((bucket) => bucket.date)).toEqual([
      '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16',
    ]);
    expect(report.buckets[0]).toEqual({ date: '2026-09-10', tokens: 1100, cost: 1, replies: 1 });
    expect(report.totals.replies).toBe(1);
    // The filter list still offers every provider in the range.
    expect(report.providers).toEqual(['openai', 'openrouter']);
  });

  it('switches all-time to weekly bars when the history is long', () => {
    const report = buildReport([record({ createdAt: new Date(2025, 0, 1) })], 'all', null, new PriceBook([]), NOW);
    expect(report.bucket).toBe('week');
    expect(report.buckets[0]?.date).toBe('2024-12-30');
    expect(report.buckets[0]?.replies).toBe(1);
  });
});

describe('UsageService', () => {
  it('backfills replies without usage rows and keeps rows after their chat is deleted', async () => {
    const repos = memoryRepos();
    const offline = { build: async () => ({ listModels: async () => { throw new Error('offline'); } }) } as unknown as ProviderRegistry;
    const usage = new UsageService(repos, offline);
    const base = { conversationId: 'gone', reasoning: null, ttftMs: 200, latencyMs: 900, cost: 0.01, finishReason: 'stop', error: null, activity: null };
    await repos.messages.create({ ...base, id: 'u1', paneId: 'p', role: 'user', content: 'hi', provider: null, model: null, tokensIn: null, tokensOut: null });
    await repos.messages.create({ ...base, id: 'a1', paneId: 'p', role: 'assistant', content: 'hello', provider: 'openrouter', model: 'x/y', tokensIn: 10, tokensOut: 5 });

    expect(await usage.backfill()).toBe(1);
    expect(await usage.backfill()).toBe(0);
    await repos.messages.deleteMany();

    const report = await usage.report('all', null);
    expect(report.totals).toMatchObject({ replies: 1, tokensIn: 10, tokensOut: 5, reportedCost: 0.01 });
    expect(usageFromMessage({ ...base, id: 'u', role: 'user', provider: null, model: null, tokensIn: null, tokensOut: null, createdAt: NOW })).toBeNull();
  });
});
