/**
 * Minimal performance telemetry.
 *
 * This exists because the app got slow and nothing on the machine could say
 * why: external sampling of a release Electron build yields unsymbolized
 * frames, and `ps` only shows that a process is busy, not what it is busy with.
 * Every diagnosis so far came from reading code and guessing, which cost two
 * wrong hypotheses (Spotlight, then the stat sweep) before the real one.
 *
 * The design constraint is that telemetry must never become the thing it
 * measures: recording is O(1), allocation-free in the common case, and bounded.
 * Only samples at or above `SLOW_MS` are kept individually; everything else
 * folds into per-operation counters.
 */

/** An operation faster than this is counted but not individually retained. */
export const SLOW_MS = 16;

/** Ring capacity for retained slow samples. Bounded so this cannot grow. */
export const MAX_SLOW_SAMPLES = 200;

export type PerfSample = {
  name: string;
  ms: number;
  at: number;
  /** Optional scalar context, e.g. bytes serialized or rows rendered. */
  detail?: number;
};

export type PerfOperationStats = {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
  /** Samples at or above SLOW_MS. */
  slowCount: number;
};

export type PerfSnapshot = {
  since: number;
  operations: PerfOperationStats[];
  slowest: PerfSample[];
};

export class PerfRecorder {
  private readonly stats = new Map<string, PerfOperationStats>();
  private readonly slow: PerfSample[] = [];
  private slowCursor = 0;
  private since: number;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.since = this.now();
  }

  record(name: string, ms: number, detail?: number): void {
    let entry = this.stats.get(name);
    if (!entry) {
      entry = { name, count: 0, totalMs: 0, maxMs: 0, slowCount: 0 };
      this.stats.set(name, entry);
    }
    entry.count += 1;
    entry.totalMs += ms;
    if (ms > entry.maxMs) entry.maxMs = ms;
    if (ms < SLOW_MS) return;

    entry.slowCount += 1;
    const sample: PerfSample = { name, ms, at: this.now(), ...(detail === undefined ? {} : { detail }) };
    // Ring, not push+shift: a shift on every slow sample would be O(n) work
    // inside the very path we are trying to keep cheap.
    if (this.slow.length < MAX_SLOW_SAMPLES) {
      this.slow.push(sample);
      return;
    }
    this.slow[this.slowCursor] = sample;
    this.slowCursor = (this.slowCursor + 1) % MAX_SLOW_SAMPLES;
  }

  /** Time a synchronous operation and record it. Returns the callback's value. */
  measure<T>(name: string, run: () => T, detail?: number): T {
    const started = this.now();
    try {
      return run();
    } finally {
      this.record(name, this.now() - started, detail);
    }
  }

  snapshot(): PerfSnapshot {
    return {
      since: this.since,
      operations: [...this.stats.values()].sort((a, b) => b.totalMs - a.totalMs),
      slowest: [...this.slow].sort((a, b) => b.ms - a.ms).slice(0, 20),
    };
  }

  reset(): void {
    this.stats.clear();
    this.slow.length = 0;
    this.slowCursor = 0;
    this.since = this.now();
  }
}

/** Human-readable one-liner per operation, for the panel and for agents. */
export function formatPerfOperation(op: PerfOperationStats): string {
  const mean = op.count > 0 ? op.totalMs / op.count : 0;
  return `${op.name}: ${op.count}x · avg ${mean.toFixed(1)}ms · max ${op.maxMs.toFixed(0)}ms · ${op.slowCount} slow`;
}
