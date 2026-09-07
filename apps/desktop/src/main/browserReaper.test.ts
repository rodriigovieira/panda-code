import { describe, expect, it } from "vitest";
import { selectShotEvictions, selectTabEvictions, type LiveTab, type ShotEntry } from "./browserReaper";

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;

const tab = (patch: Partial<LiveTab> & { id: string }): LiveTab => ({
  threadId: "sec-1",
  lastUsedAt: NOW,
  ...patch,
});

describe("selectTabEvictions", () => {
  it("sleeps a tab nobody has touched for the timeout", () => {
    const evictions = selectTabEvictions({
      tabs: [tab({ id: "cold", lastUsedAt: NOW - 10 * MINUTE }), tab({ id: "warm" })],
      maxAwake: 0,
      idleTimeoutMs: 5 * MINUTE,
      now: NOW,
    });
    expect(evictions).toEqual([{ id: "cold", reason: "idle" }]);
  });

  it("never sleeps the tab on screen", () => {
    // Blanking the page somebody is reading is not a memory optimisation.
    const evictions = selectTabEvictions({
      tabs: [tab({ id: "visible", lastUsedAt: NOW - 60 * MINUTE })],
      maxAwake: 0,
      idleTimeoutMs: 5 * MINUTE,
      now: NOW,
      visibleTabId: "visible",
    });
    expect(evictions).toEqual([]);
  });

  it("never sleeps a recording, a pending note, or a loading page", () => {
    const stale = { lastUsedAt: NOW - 60 * MINUTE };
    const evictions = selectTabEvictions({
      tabs: [
        tab({ id: "recording", recording: true, ...stale }),
        tab({ id: "noted", hasNote: true, ...stale }),
        tab({ id: "loading", loading: true, ...stale }),
        tab({ id: "ordinary", ...stale }),
      ],
      maxAwake: 0,
      idleTimeoutMs: 5 * MINUTE,
      now: NOW,
    });
    expect(evictions).toEqual([{ id: "ordinary", reason: "idle" }]);
  });

  it("leaves tabs that are already asleep alone", () => {
    const evictions = selectTabEvictions({
      tabs: [tab({ id: "gone", asleep: true, lastUsedAt: 0 })],
      maxAwake: 1,
      idleTimeoutMs: MINUTE,
      now: NOW,
    });
    expect(evictions).toEqual([]);
  });

  it("holds the awake count to the ceiling, coldest first", () => {
    const evictions = selectTabEvictions({
      tabs: [
        tab({ id: "a", lastUsedAt: NOW - 3 * MINUTE }),
        tab({ id: "b", lastUsedAt: NOW - 1 * MINUTE }),
        tab({ id: "c", lastUsedAt: NOW - 4 * MINUTE }),
        tab({ id: "d", lastUsedAt: NOW }),
      ],
      maxAwake: 2,
      idleTimeoutMs: 0,
      now: NOW,
    });
    expect(evictions).toEqual([
      { id: "c", reason: "cap" },
      { id: "a", reason: "cap" },
    ]);
  });

  it("counts the idle sweep against the cap rather than double-evicting", () => {
    const evictions = selectTabEvictions({
      tabs: [
        tab({ id: "cold", lastUsedAt: NOW - 30 * MINUTE }),
        tab({ id: "warm-a", lastUsedAt: NOW - MINUTE }),
        tab({ id: "warm-b", lastUsedAt: NOW }),
      ],
      maxAwake: 2,
      idleTimeoutMs: 5 * MINUTE,
      now: NOW,
    });
    // The idle sweep already took one, which is enough to satisfy the ceiling.
    expect(evictions).toEqual([{ id: "cold", reason: "idle" }]);
  });

  it("knowingly exceeds the ceiling rather than interrupting anything", () => {
    // Every awake tab is protected: going over costs memory, but ending a
    // recording or blanking a hand-off costs the user something irreversible.
    const evictions = selectTabEvictions({
      tabs: [
        tab({ id: "recording", recording: true, lastUsedAt: 0 }),
        tab({ id: "noted", hasNote: true, lastUsedAt: 0 }),
        tab({ id: "visible", lastUsedAt: 0 }),
      ],
      maxAwake: 1,
      idleTimeoutMs: 0,
      now: NOW,
      visibleTabId: "visible",
    });
    expect(evictions).toEqual([]);
  });

  it("does nothing when both bounds are disabled", () => {
    const evictions = selectTabEvictions({
      tabs: [tab({ id: "a", lastUsedAt: 0 }), tab({ id: "b", lastUsedAt: 0 })],
      maxAwake: 0,
      idleTimeoutMs: 0,
      now: NOW,
    });
    expect(evictions).toEqual([]);
  });
});

describe("selectShotEvictions", () => {
  const HOUR = 60 * 60_000;
  const shot = (name: string, ageHours: number, directory = false): ShotEntry => ({
    path: `/shots/${name}`,
    writtenAt: NOW - ageHours * HOUR,
    directory,
  });

  it("keeps the newest and deletes the rest", () => {
    const doomed = selectShotEvictions({
      entries: [shot("old.png", 100), shot("new.png", 50), shot("newest.png", 30)],
      keep: 2,
      graceMs: 0,
      now: NOW,
    });
    expect(doomed).toEqual(["/shots/old.png"]);
  });

  it("never deletes a capture inside its grace window, however many there are", () => {
    // A section taking a burst of screenshots must not delete the paths its own
    // message is still pointing the user at.
    const doomed = selectShotEvictions({
      entries: Array.from({ length: 20 }, (_, index) => shot(`burst-${index}.png`, index)),
      keep: 5,
      graceMs: 24 * HOUR,
      now: NOW,
    });
    expect(doomed).toEqual([]);
  });

  it("spares the recording being written right now", () => {
    const doomed = selectShotEvictions({
      entries: [shot("recording-live", 200, true), shot("recording-done", 300, true)],
      keep: 0 + 1,
      graceMs: 0,
      now: NOW,
      activeDirectory: "/shots/recording-live",
    });
    expect(doomed).toEqual(["/shots/recording-done"]);
  });

  it("deletes nothing when the cap is disabled", () => {
    const doomed = selectShotEvictions({
      entries: [shot("a.png", 500), shot("b.png", 600)],
      keep: 0,
      graceMs: 0,
      now: NOW,
    });
    expect(doomed).toEqual([]);
  });
});
