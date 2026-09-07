import { describe, expect, it } from "vitest";
import { formatPlaybackRate, PLAYBACK_RATES, stepPlaybackRate } from "./videoPlayer";

describe("stepPlaybackRate", () => {
  it("walks the ladder in both directions", () => {
    expect(stepPlaybackRate(1, 1)).toBe(2);
    expect(stepPlaybackRate(2, 1)).toBe(4);
    expect(stepPlaybackRate(1, -1)).toBe(0.5);
    expect(stepPlaybackRate(4, -1)).toBe(2);
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(stepPlaybackRate(8, 1)).toBe(8);
    expect(stepPlaybackRate(0.5, -1)).toBe(0.5);
  });

  it("snaps a rate that is not on the ladder to the nearest step first", () => {
    expect(stepPlaybackRate(1.2, 1)).toBe(2);
    // 3 is equidistant from 2 and 4; the lower step wins, so down lands on 1.
    expect(stepPlaybackRate(3, -1)).toBe(1);
    expect(stepPlaybackRate(3.5, -1)).toBe(2);
  });

  it("covers the whole ladder from the slowest step", () => {
    let rate: number = PLAYBACK_RATES[0];
    const seen: number[] = [rate];
    for (let i = 0; i < PLAYBACK_RATES.length - 1; i += 1) {
      rate = stepPlaybackRate(rate, 1);
      seen.push(rate);
    }
    expect(seen).toEqual([...PLAYBACK_RATES]);
  });
});

describe("formatPlaybackRate", () => {
  it("writes whole and fractional speeds the way the HUD shows them", () => {
    expect(formatPlaybackRate(1)).toBe("1x");
    expect(formatPlaybackRate(0.5)).toBe("0.5x");
    expect(formatPlaybackRate(8)).toBe("8x");
  });
});
