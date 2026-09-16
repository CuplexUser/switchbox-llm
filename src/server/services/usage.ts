import type {
  CostKind,
  ModelInfo,
  ProviderId,
  UsageBucket,
  UsageModelRow,
  UsageRange,
  UsageReport,
  UsageTotals,
} from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';
import type { UsageRecordRow } from '../db/schemas.ts';
import type { ProviderRegistry } from '../providers/registry.ts';

export const USAGE_RANGES: UsageRange[] = ['7d', '30d', '90d', 'all'];
const RANGE_DAYS: Record<Exclude<UsageRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };
/** Past this many days, "all" draws one bar a week. */
const MAX_DAILY_BUCKETS = 120;
const LOCAL_PROVIDERS: ProviderId[] = ['ollama', 'lmstudio'];
const PRICES_TTL_MS = 6 * 60 * 60 * 1000;
const PRICES_RETRY_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ReplyLike {
  id: string;
  conversationId: string;
  role: string;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  ttftMs: number | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: Date | string;
}

/** The usage row for a saved reply, or null for user messages and replies with no model. */
export function usageFromMessage(message: ReplyLike): UsageRecordRow | null {
  if (message.role !== 'assistant' || !message.provider || !message.model) return null;
  return {
    id: message.id,
    conversationId: message.conversationId,
    provider: message.provider,
    model: message.model,
    tokensIn: message.tokensIn,
    tokensOut: message.tokensOut,
    cost: message.cost,
    ttftMs: message.ttftMs,
    latencyMs: message.latencyMs,
    failed: Boolean(message.error),
    createdAt: new Date(message.createdAt),
  };
}

/** Folds naming differences between a provider's own ids and OpenRouter's: vendor prefix, date suffix, dots. */
export function normalizeModelId(id: string): string {
  const slash = id.lastIndexOf('/');
  return (slash === -1 ? id : id.slice(slash + 1))
    .toLowerCase()
    .replace(/:.*$/, '')
    .replace(/-(latest|\d{8}|\d{4}-\d{2}-\d{2})$/, '')
    .replace(/\./g, '-');
}

export type Price = { input: number; output: number };

/** List prices keyed by OpenRouter id and by vendor plus normalized id, so direct Anthropic and OpenAI models match too. */
export class PriceBook {
  private readonly exact = new Map<string, Price>();
  private readonly byVendor = new Map<string, Price>();

  constructor(models: ModelInfo[]) {
    for (const model of models) {
      if (!model.pricing) continue;
      this.exact.set(model.model, model.pricing);
      const slash = model.model.indexOf('/');
      if (slash === -1) continue;
      const key = `${model.model.slice(0, slash)}:${normalizeModelId(model.model)}`;
      if (!this.byVendor.has(key)) this.byVendor.set(key, model.pricing);
    }
  }

  get size(): number {
    return this.exact.size;
  }

  find(provider: string, model: string): Price | null {
    if (provider === 'openrouter') {
      const exact = this.exact.get(model);
      if (exact) return exact;
      const slash = model.indexOf('/');
      return slash === -1 ? null : (this.byVendor.get(`${model.slice(0, slash)}:${normalizeModelId(model)}`) ?? null);
    }
    if (provider === 'anthropic' || provider === 'openai') {
      return this.byVendor.get(`${provider}:${normalizeModelId(model)}`) ?? null;
    }
    return null;
  }
}

function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(value);
}

/** The first moment a range covers, or null for all time. */
export function rangeStart(range: UsageRange, now: Date): Date | null {
  return range === 'all' ? null : addDays(startOfDay(now), -(RANGE_DAYS[range] - 1));
}

interface Priced {
  record: UsageRecordRow;
  cost: number | null;
  kind: CostKind;
}

function priceRecord(record: UsageRecordRow, prices: PriceBook): Priced {
  if (record.cost !== null) return { record, cost: record.cost, kind: 'reported' };
  if (LOCAL_PROVIDERS.includes(record.provider as ProviderId)) return { record, cost: 0, kind: 'local' };
  const tokensIn = record.tokensIn ?? 0;
  const tokensOut = record.tokensOut ?? 0;
  if (tokensIn + tokensOut === 0) return { record, cost: 0, kind: 'unknown' };
  const price = prices.find(record.provider, record.model);
  if (!price) return { record, cost: null, kind: 'unknown' };
  return { record, cost: (tokensIn * price.input + tokensOut * price.output) / 1_000_000, kind: 'estimated' };
}

function totalsOf(entries: Priced[]): UsageTotals {
  const totals: UsageTotals = {
    replies: entries.length,
    failed: 0,
    chats: new Set(entries.map((entry) => entry.record.conversationId)).size,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    reportedCost: 0,
    estimatedCost: 0,
    unpricedReplies: 0,
    medianTtftMs: null,
    medianTokensPerSecond: null,
  };
  const ttfts: number[] = [];
  const speeds: number[] = [];
  for (const { record, cost, kind } of entries) {
    if (record.failed) totals.failed++;
    totals.tokensIn += record.tokensIn ?? 0;
    totals.tokensOut += record.tokensOut ?? 0;
    if (kind === 'reported') totals.reportedCost += cost ?? 0;
    if (kind === 'estimated') totals.estimatedCost += cost ?? 0;
    if (cost === null) totals.unpricedReplies++;
    if (record.failed) continue;
    if (record.ttftMs !== null) ttfts.push(record.ttftMs);
    const generationMs = (record.latencyMs ?? 0) - (record.ttftMs ?? 0);
    if (record.tokensOut && record.latencyMs !== null && generationMs > 0) {
      speeds.push((record.tokensOut / generationMs) * 1000);
    }
  }
  totals.cost = totals.reportedCost + totals.estimatedCost;
  totals.medianTtftMs = median(ttfts);
  totals.medianTokensPerSecond = median(speeds);
  return totals;
}

function modelCostKind(provider: string, entries: Priced[]): CostKind {
  if (LOCAL_PROVIDERS.includes(provider as ProviderId)) return 'local';
  if (entries.some((entry) => entry.kind === 'estimated')) return 'estimated';
  if (entries.some((entry) => entry.kind === 'reported')) return 'reported';
  return 'unknown';
}

/** Rolls usage rows up into totals, time buckets and a per-model table. `records` must already be limited to the range. */
export function buildReport(
  records: UsageRecordRow[],
  range: UsageRange,
  provider: ProviderId | null,
  prices: PriceBook,
  now = new Date(),
): UsageReport {
  const providers = [...new Set(records.map((record) => record.provider as ProviderId))].toSorted();
  const scoped = provider ? records.filter((record) => record.provider === provider) : records;
  const priced = scoped.map((record) => priceRecord(record, prices));

  const today = startOfDay(now);
  let first = rangeStart(range, now);
  let bucket: UsageReport['bucket'] = 'day';
  if (!first) {
    const earliest = records.reduce<Date | null>((min, record) => (!min || record.createdAt < min ? record.createdAt : min), null);
    first = earliest ? startOfDay(earliest) : today;
    if (Math.round((today.getTime() - first.getTime()) / DAY_MS) + 1 > MAX_DAILY_BUCKETS) {
      bucket = 'week';
      first = startOfWeek(first);
    }
  }

  const buckets: UsageBucket[] = [];
  const index = new Map<string, UsageBucket>();
  for (let date = first; date <= today; date = addDays(date, bucket === 'week' ? 7 : 1)) {
    const entry = { date: localDateKey(date), tokens: 0, cost: 0, replies: 0 };
    buckets.push(entry);
    index.set(entry.date, entry);
  }
  for (const { record, cost } of priced) {
    const start = bucket === 'week' ? startOfWeek(record.createdAt) : startOfDay(record.createdAt);
    const entry = index.get(localDateKey(start));
    if (!entry) continue;
    entry.tokens += (record.tokensIn ?? 0) + (record.tokensOut ?? 0);
    entry.cost += cost ?? 0;
    entry.replies++;
  }

  const groups = new Map<string, Priced[]>();
  for (const entry of priced) {
    const key = `${entry.record.provider} ${entry.record.model}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const models: UsageModelRow[] = [...groups.values()]
    .map((entries) => {
      const { provider: id, model } = entries[0]!.record;
      return { provider: id as ProviderId, model, costKind: modelCostKind(id, entries), ...totalsOf(entries) };
    })
    .toSorted((a, b) => b.cost - a.cost || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));

  return { range, bucket, buckets, totals: totalsOf(priced), models, providers };
}

export class UsageService {
  private readonly repos: Repos;
  private readonly registry: ProviderRegistry;
  private prices: { at: number; ttl: number; book: PriceBook } | null = null;

  constructor(repos: Repos, registry: ProviderRegistry) {
    this.repos = repos;
    this.registry = registry;
  }

  /** Adds usage rows for saved replies that have none, e.g. from before usage was tracked or from an import. */
  async backfill(): Promise<number> {
    const known = new Set((await this.repos.usage.findMany()).map((record) => record.id));
    const replies = await this.repos.messages.findMany({ where: { role: 'assistant' } });
    const missing = replies
      .filter((message) => !known.has(message.id))
      .map(usageFromMessage)
      .filter((record): record is UsageRecordRow => record !== null);
    for (const record of missing) await this.repos.usage.create(record);
    return missing.length;
  }

  async report(range: UsageRange, provider: ProviderId | null, now = new Date()): Promise<UsageReport> {
    const since = rangeStart(range, now);
    const records = await this.repos.usage.findMany({
      where: since ? [{ field: 'createdAt', op: 'gte', value: since }] : undefined,
    });
    return buildReport(records, range, provider, await this.priceBook(), now);
  }

  /** OpenRouter's public catalog is the price list; its models endpoint needs no key. */
  private async priceBook(): Promise<PriceBook> {
    if (this.prices && Date.now() - this.prices.at < this.prices.ttl) return this.prices.book;
    try {
      const provider = await this.registry.build('openrouter');
      const book = new PriceBook(await provider.listModels(AbortSignal.timeout(10_000)));
      this.prices = { at: Date.now(), ttl: PRICES_TTL_MS, book };
    } catch (error) {
      console.warn('[usage] could not load prices:', error instanceof Error ? error.message : String(error));
      this.prices = { at: Date.now(), ttl: PRICES_RETRY_MS, book: this.prices?.book ?? new PriceBook([]) };
    }
    return this.prices.book;
  }
}
