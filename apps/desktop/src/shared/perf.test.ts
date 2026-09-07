import { describe, expect, it } from "vitest";
import { MAX_SLOW_SAMPLES, PerfRecorder, SLOW_MS, formatPerfOperation } from "./perf";

/** Deterministic clock: these assertions must not depend on real timing. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return { now: () => value, advance: (ms) => (value += ms) };
}

describe("PerfRecorder", () => {
  it("aggregates count, total and max per operation", () => {
    const perf = new PerfRecorder(() => 0);
    perf.record("persist", 10);
    perf.record("persist", 30);
    perf.record("render", 5);

    const { operations } = perf.snapshot();
    const persist = operations.find((op) => op.name === "persist");
    expect(persist).toMatchObject({ count: 2, totalMs: 40, maxMs: 30 });
    expect(operations.find((op) => op.name === "render")?.count).toBe(1);
  });

  it("ranks operations by total time, so the real cost sink sorts first", () => {
    const perf = new PerfRecorder(() => 0);
    perf.record("rare-but-slow", 100);
    for (let i = 0; i < 50; i += 1) perf.record("frequent", 20);

    expect(perf.snapshot().operations[0]?.name).toBe("frequent");
  });

  it("retains individual samples only at or above the slow threshold", () => {
    const perf = new PerfRecorder(() => 0);
    perf.record("fast", SLOW_MS - 1);
    perf.record("slow", SLOW_MS);

    const { slowest, operations } = perf.snapshot();
    expect(slowest.map((s) => s.name)).toEqual(["slow"]);
    // The fast one is still counted — dropped from the ring, not from the stats.
    expect(operations.find((op) => op.name === "fast")?.count).toBe(1);
    expect(operations.find((op) => op.name === "fast")?.slowCount).toBe(0);
  });

  it("bounds retained samples so telemetry cannot grow without limit", () => {
    const perf = new PerfRecorder(() => 0);
    for (let i = 0; i < MAX_SLOW_SAMPLES * 3; i += 1) perf.record("op", SLOW_MS + i);

    // Ring holds at most MAX_SLOW_SAMPLES; snapshot surfaces the worst 20.
    expect(perf.snapshot().slowest).toHaveLength(20);
    expect(perf.snapshot().operations[0]?.count).toBe(MAX_SLOW_SAMPLES * 3);
  });

  it("keeps the worst samples visible after wrapping", () => {
    const perf = new PerfRecorder(() => 0);
    perf.record("op", 5_000);
    for (let i = 0; i < MAX_SLOW_SAMPLES - 1; i += 1) perf.record("op", SLOW_MS);

    // Still inside capacity, so the outlier must survive.
    expect(perf.snapshot().slowest[0]?.ms).toBe(5_000);
  });

  it("measures a synchronous call and returns its value", () => {
    const { now, advance } = clock();
    const perf = new PerfRecorder(now);
    const result = perf.measure("work", () => {
      advance(42);
      return "value";
    });

    expect(result).toBe("value");
    expect(perf.snapshot().operations[0]).toMatchObject({ name: "work", count: 1, maxMs: 42 });
  });

  it("still records when the measured call throws", () => {
    const { now, advance } = clock();
    const perf = new PerfRecorder(now);

    expect(() =>
      perf.measure("boom", () => {
        advance(7);
        throw new Error("nope");
      }),
    ).toThrow("nope");
    // A throwing operation is exactly the one worth timing; losing it would
    // hide the slow failure path.
    expect(perf.snapshot().operations[0]).toMatchObject({ name: "boom", count: 1 });
  });

  it("clears everything on reset", () => {
    const perf = new PerfRecorder(() => 0);
    perf.record("op", 100);
    perf.reset();
    expect(perf.snapshot().operations).toEqual([]);
    expect(perf.snapshot().slowest).toEqual([]);
  });
});

describe("formatPerfOperation", () => {
  it("reports the mean rather than only the total", () => {
    expect(formatPerfOperation({ name: "persist", count: 4, totalMs: 100, maxMs: 40, slowCount: 2 })).toBe(
      "persist: 4x · avg 25.0ms · max 40ms · 2 slow",
    );
  });

  it("does not divide by zero for an operation that never ran", () => {
    expect(formatPerfOperation({ name: "idle", count: 0, totalMs: 0, maxMs: 0, slowCount: 0 })).toContain("avg 0.0ms");
  });
});
