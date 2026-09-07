import { afterEach, describe, expect, it, vi } from "vitest";
import { LatestValueThrottle } from "./latestValueThrottle";

describe("LatestValueThrottle", () => {
  afterEach(() => vi.useRealTimers());

  it("emits the first value immediately and coalesces a burst to its newest value", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const emitted: Array<[string, number]> = [];
    const throttle = new LatestValueThrottle<number>(100, (key, value) => emitted.push([key, value]), () => now);

    throttle.push("section", 1);
    now += 10;
    throttle.push("section", 2);
    throttle.push("section", 3);

    expect(emitted).toEqual([["section", 1]]);
    now += 90;
    vi.advanceTimersByTime(90);
    expect(emitted).toEqual([["section", 1], ["section", 3]]);
  });

  it("emits urgent values immediately and cancels a pending stale value", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const emitted: number[] = [];
    const throttle = new LatestValueThrottle<number>(100, (_key, value) => emitted.push(value), () => now);

    throttle.push("section", 1);
    now += 10;
    throttle.push("section", 2);
    throttle.push("section", 3, true);
    vi.advanceTimersByTime(200);

    expect(emitted).toEqual([1, 3]);
  });

  it("keeps independent keys independent", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const throttle = new LatestValueThrottle<string>(100, (key, value) => emitted.push(`${key}:${value}`), () => 1_000);

    throttle.push("a", "one");
    throttle.push("b", "two");

    expect(emitted).toEqual(["a:one", "b:two"]);
  });
});
