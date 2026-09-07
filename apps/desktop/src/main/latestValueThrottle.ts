type Timer = ReturnType<typeof setTimeout>;

type Pending<T> = {
  value: T;
  timer: Timer;
};

/**
 * Emits the newest value for each key at most once per interval.
 *
 * Stream parsers can produce hundreds of deltas per second. Sending a complete
 * conversation snapshot for every delta makes Electron structured-clone the
 * same history repeatedly and can exhaust the renderer heap. Terminal states
 * use `urgent` so completion and permission prompts are never delayed.
 */
export class LatestValueThrottle<T> {
  private readonly lastSentAt = new Map<string, number>();
  private readonly pending = new Map<string, Pending<T>>();

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (key: string, value: T) => void,
    private readonly now: () => number = Date.now,
  ) {}

  push(key: string, value: T, urgent = false): void {
    const lastSentAt = this.lastSentAt.get(key);
    const elapsed = lastSentAt === undefined ? this.intervalMs : this.now() - lastSentAt;
    if (urgent || elapsed >= this.intervalMs) {
      this.cancelPending(key);
      this.send(key, value);
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.value = value;
      return;
    }

    const timer = setTimeout(() => {
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      this.send(key, pending.value);
    }, Math.max(0, this.intervalMs - elapsed));
    timer.unref?.();
    this.pending.set(key, { value, timer });
  }

  clear(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.lastSentAt.clear();
  }

  private send(key: string, value: T): void {
    this.lastSentAt.set(key, this.now());
    this.emit(key, value);
  }

  private cancelPending(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
  }
}
