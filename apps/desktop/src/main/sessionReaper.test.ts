import { describe, expect, it } from "vitest";
import { selectEvictions, type LiveSection } from "./sessionReaper";

/**
 * These encode a POLICY, not an algorithm — the sorting is three lines and was
 * never the risk. Every case below is a decision about whose work is allowed to
 * be interrupted, and the negative ones ("never evicts…") are the point: each
 * marks a state where killing the process destroys something the user cannot
 * get back, and the cheapest way to reintroduce that bug is to widen
 * eligibility here while "simplifying".
 *
 * The reaper is pure precisely so these can exist. Its real inputs — a live
 * process map, a Codex app-server, wall-clock idle time — are all things you
 * cannot arrange in a test, so the choice of victim was split away from the
 * killing and is exercised directly.
 */

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

/** A live, idle, resumable Claude section prompted `agoMinutes` ago. */
function section(id: string, agoMinutes: number, overrides: Partial<LiveSection> = {}): LiveSection {
  return {
    id,
    runtime: "claude",
    agentState: "waiting",
    resumable: true,
    lastPromptAt: NOW - agoMinutes * MINUTE,
    ...overrides,
  };
}

function evict(sections: LiveSection[], options: { maxLive?: number; idleMinutes?: number; incoming?: number } = {}) {
  return selectEvictions({
    sections,
    maxLive: options.maxLive ?? 0,
    idleTimeoutMs: (options.idleMinutes ?? 0) * MINUTE,
    now: NOW,
    incoming: options.incoming,
  });
}

const ids = (evictions: { id: string }[]) => evictions.map((eviction) => eviction.id);

describe("selectEvictions — cap", () => {
  it("evicts nothing while under the cap", () => {
    expect(evict([section("a", 1), section("b", 2)], { maxLive: 10 })).toEqual([]);
  });

  it("evicts the least recently prompted section when a new one would exceed the cap", () => {
    const sections = [section("new", 1), section("oldest", 90), section("middle", 30)];
    expect(evict(sections, { maxLive: 3, incoming: 1 })).toEqual([{ id: "oldest", reason: "cap" }]);
  });

  it("evicts as many as it takes to get under the cap", () => {
    const sections = [section("a", 10), section("b", 50), section("c", 30), section("d", 70)];
    expect(ids(evict(sections, { maxLive: 2 }))).toEqual(["d", "b"]);
  });

  it("orders victims by last prompt, not by last output", () => {
    // "loud" answered most recently but was prompted long ago — a long autonomous
    // run whose result the user has not read. It is the correct victim; "quiet"
    // is the section they are actively working in.
    const sections = [section("loud", 120), section("quiet", 2)];
    expect(ids(evict(sections, { maxLive: 1 }))).toEqual(["loud"]);
  });

  it("is disabled by a cap of 0", () => {
    expect(evict([section("a", 500), section("b", 900)], { maxLive: 0 })).toEqual([]);
  });
});

describe("selectEvictions — protected states", () => {
  it("never evicts a working section", () => {
    const sections = [section("busy", 300, { agentState: "working" }), section("idle", 5)];
    expect(ids(evict(sections, { maxLive: 1 }))).toEqual(["idle"]);
  });

  it("never evicts a section blocked on an approval", () => {
    const sections = [section("asking", 300, { agentState: "needs_action" }), section("idle", 5)];
    expect(ids(evict(sections, { maxLive: 1 }))).toEqual(["idle"]);
  });

  it("never evicts a section that could not be resumed", () => {
    const sections = [section("no-id", 300, { resumable: false }), section("idle", 5)];
    expect(ids(evict(sections, { maxLive: 1 }))).toEqual(["idle"]);
  });

  // A background shell or a `run_in_background` subagent leaves the section at
  // `waiting` by design (it must not pin the spinner), so to every other signal
  // here it looks idle. Hibernating it kills the push/release mid-flight.
  it("never evicts a section with background work still running", () => {
    const sections = [section("pushing", 300, { hasBackgroundWork: true }), section("idle", 5)];
    expect(ids(evict(sections, { maxLive: 1 }))).toEqual(["idle"]);
  });

  it("does not sweep a long-idle section whose background work is still running", () => {
    expect(evict([section("releasing", 90, { hasBackgroundWork: true })], { idleMinutes: 30 })).toEqual([]);
  });

  it("sweeps it once the background work finishes", () => {
    expect(ids(evict([section("done", 90, { hasBackgroundWork: false })], { idleMinutes: 30 }))).toEqual(["done"]);
  });

  it("exceeds the cap rather than interrupting work when nothing is eligible", () => {
    const sections = [
      section("a", 300, { agentState: "working" }),
      section("b", 200, { agentState: "needs_action" }),
      section("c", 100, { resumable: false }),
      section("d", 50, { hasBackgroundWork: true }),
    ];
    expect(evict(sections, { maxLive: 1 })).toEqual([]);
  });
});

describe("selectEvictions — idle sweep", () => {
  it("hibernates sections idle past the timeout", () => {
    const sections = [section("stale", 45), section("fresh", 5)];
    expect(evict(sections, { idleMinutes: 30 })).toEqual([{ id: "stale", reason: "idle" }]);
  });

  it("treats the timeout as inclusive", () => {
    expect(ids(evict([section("exact", 30)], { idleMinutes: 30 }))).toEqual(["exact"]);
  });

  it("is disabled by a timeout of 0", () => {
    expect(evict([section("ancient", 6000)], { idleMinutes: 0 })).toEqual([]);
  });

  it("leaves a section that has been working for longer than the timeout", () => {
    expect(evict([section("grinding", 90, { agentState: "working" })], { idleMinutes: 30 })).toEqual([]);
  });
});

describe("selectEvictions — cap and sweep together", () => {
  it("counts idle evictions against the cap instead of double-evicting", () => {
    const sections = [section("stale", 90), section("a", 3), section("b", 2)];
    const evictions = evict(sections, { maxLive: 2, idleMinutes: 30 });
    expect(evictions).toEqual([{ id: "stale", reason: "idle" }]);
  });

  it("still applies the cap when the idle sweep did not free enough", () => {
    const sections = [section("stale", 90), section("a", 8), section("b", 5), section("c", 2)];
    const evictions = evict(sections, { maxLive: 2, idleMinutes: 30 });
    expect(evictions).toEqual([
      { id: "stale", reason: "idle" },
      { id: "a", reason: "cap" },
    ]);
  });

  it("never reports the same section twice", () => {
    const sections = [section("stale", 90), section("older", 120)];
    const evictions = evict(sections, { maxLive: 1, idleMinutes: 30 });
    expect(new Set(ids(evictions)).size).toBe(evictions.length);
  });
});

describe("selectEvictions — unsent drafts", () => {
  it("never sweeps a section with a half-written prompt in it", () => {
    const sections = [section("typing", 90, { hasUnsentDraft: true }), section("stale", 45)];
    expect(evict(sections, { idleMinutes: 30 })).toEqual([{ id: "stale", reason: "idle" }]);
  });

  it("evicts a drafted section last under the cap", () => {
    // "typing" was prompted longest ago and would otherwise lead the queue.
    const sections = [section("typing", 300, { hasUnsentDraft: true }), section("read", 200), section("new", 1)];
    expect(ids(evict(sections, { maxLive: 2 }))).toEqual(["read"]);
  });

  it("still evicts a drafted section when the cap leaves no one else", () => {
    const sections = [section("typing", 300, { hasUnsentDraft: true }), section("busy", 5, { agentState: "working" })];
    expect(ids(evict(sections, { maxLive: 1 }))).toEqual(["typing"]);
  });
});

describe("selectEvictions — exemptions", () => {
  it("never evicts the section a launch is making room for", () => {
    // A restart of an already-live section counts as incoming 0, so without the
    // exemption the cap check could kill the very process the caller is about to
    // write its prompt to.
    const sections = [section("restarting", 300), section("other", 5)];
    expect(ids(selectEvictions({
      sections,
      maxLive: 1,
      idleTimeoutMs: 0,
      now: NOW,
      exempt: ["restarting"],
    }))).toEqual(["other"]);
  });

  it("exempts a section from the idle sweep too", () => {
    expect(selectEvictions({
      sections: [section("restarting", 300)],
      maxLive: 0,
      idleTimeoutMs: 30 * MINUTE,
      now: NOW,
      exempt: ["restarting"],
    })).toEqual([]);
  });
});
