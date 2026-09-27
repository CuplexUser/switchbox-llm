import type { ActiveRun, StreamEvent, StreamRequest } from '../../shared/types.ts';
import { createLogger } from '../log.ts';
import { errorMessage } from './chat.ts';

const log = createLogger('runs');

/** How long a finished run's events stay available, so a client that dropped near the end can still catch up. */
const RETENTION_MS = 5 * 60_000;

export interface RunEntry {
  /** Numbered from 1 in the order events were emitted. */
  seq: number;
  event: StreamEvent;
}

type Listener = (entry: RunEntry) => void;

interface Run {
  runId: string;
  conversationId: string;
  paneIds: string[];
  /** paneId -> controller, so a single pane can be stopped mid-run. */
  controllers: Map<string, AbortController>;
  events: RunEntry[];
  finished: boolean;
  listeners: Set<Listener>;
}

type Execute = (emit: (event: StreamEvent) => void, controllers: Map<string, AbortController>) => Promise<void>;

/**
 * Runs that outlive the request that started them. Every event is numbered and kept, so a client
 * whose connection drops can come back and pick up after the last event it saw, and a page loaded
 * mid-reply can attach to a run already under way. Only an explicit stop cancels a run.
 */
export class RunRegistry {
  private readonly runs = new Map<string, Run>();
  private readonly retentionMs: number;

  constructor(options: { retentionMs?: number } = {}) {
    this.retentionMs = options.retentionMs ?? RETENTION_MS;
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Starts `execute` in the background. It always ends with an `end` event, after an `error` for each pane if it throws. */
  start(request: Pick<StreamRequest, 'runId' | 'conversationId' | 'paneIds'>, execute: Execute): void {
    const run: Run = {
      runId: request.runId,
      conversationId: request.conversationId,
      paneIds: request.paneIds,
      controllers: new Map(),
      events: [],
      finished: false,
      listeners: new Set(),
    };
    this.runs.set(run.runId, run);
    const emit = (event: StreamEvent) => {
      if (run.finished) return;
      const entry = { seq: run.events.length + 1, event };
      run.events.push(entry);
      for (const listener of run.listeners) listener(entry);
    };

    void (async () => {
      try {
        await execute(emit, run.controllers);
      } catch (error) {
        for (const paneId of run.paneIds) emit({ type: 'error', paneId, error: errorMessage(error), message: null });
      } finally {
        emit({ type: 'end' });
        run.finished = true;
        run.listeners.clear();
        setTimeout(() => this.runs.delete(run.runId), this.retentionMs).unref?.();
      }
    })().catch((error: unknown) => log.error('run bookkeeping failed', { runId: run.runId, error }));
  }

  /**
   * Replays the events after `after`, then passes on new ones as they come, up to and including
   * `end`. Returns null for an unknown run, otherwise a function that stops listening.
   */
  subscribe(runId: string, after: number, listener: Listener): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    for (const entry of coalesce(run.events.slice(Math.max(0, after)))) listener(entry);
    if (run.finished) return () => {};
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  /** Runs of a conversation that haven't finished yet. */
  active(conversationId: string): ActiveRun[] {
    return [...this.runs.values()]
      .filter((run) => run.conversationId === conversationId && !run.finished)
      .map((run) => ({ runId: run.runId, paneIds: run.paneIds }));
  }

  /** Stops one pane of a run, or all of it. Returns whether the run was found. */
  stop(runId: string, paneId?: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    for (const [id, controller] of run.controllers) {
      if (!paneId || id === paneId) controller.abort();
    }
    return true;
  }

  /** Stops every run of a conversation, as when it's deleted. */
  stopConversation(conversationId: string): void {
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId) this.stop(run.runId);
    }
  }
}

/**
 * Joins runs of adjacent text or reasoning chunks for the same pane into one event carrying the
 * last chunk's number, so replaying a long reply sends a handful of events instead of one per
 * token. Only neighbors are joined, so the numbers still rise in order.
 */
export function coalesce(entries: RunEntry[]): RunEntry[] {
  const out: RunEntry[] = [];
  for (const entry of entries) {
    const previous = out.at(-1)?.event;
    const { event } = entry;
    if (
      (event.type === 'delta' || event.type === 'reasoning') &&
      (previous?.type === 'delta' || previous?.type === 'reasoning') &&
      previous.type === event.type &&
      previous.paneId === event.paneId
    ) {
      out[out.length - 1] = { seq: entry.seq, event: { ...event, text: previous.text + event.text } };
      continue;
    }
    out.push(entry);
  }
  return out;
}
