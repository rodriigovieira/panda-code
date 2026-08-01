import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionService } from "../sessionService";

/**
 * What the relay bridge WRITES while a session streams — the desktop half of the
 * relay's bandwidth bill. A turn produces one runtime event per second, and each
 * of these calls is charged for every document it reads: `sessions:upsertSession`
 * reads the session row plus its notification subscriptions, `sessions:putRuntime`
 * reads one small runtime row. Keeping the per-tick badge on the second path is
 * the whole point of the split, so it is asserted here rather than left to drift.
 */

type Call = { name: string; args: Record<string, unknown> };
const calls: Call[] = [];

/**
 * A mutation the fake client parks mid-flight, so a test can land a state change
 * on the bridge while an earlier write is still awaiting the relay.
 */
let held: { name: string; wait: Promise<void> } | null = null;
function holdMutation(name: string): { release: () => void } {
  let release = (): void => undefined;
  held = { name, wait: new Promise<void>((resolve) => (release = () => resolve())) };
  return { release };
}

vi.mock("./keychain", () => ({
  readKeychainSecret: vi.fn(async () => null),
  writeKeychainSecret: vi.fn(async () => undefined),
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class {
    async mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
      const name = getFunctionName(reference as never);
      calls.push({ name, args });
      if (held?.name === name) {
        const wait = held.wait;
        held = null;
        await wait;
      }
      return null;
    }
    async query(): Promise<unknown> {
      return [];
    }
    onUpdate(): () => void {
      return () => undefined;
    }
    async close(): Promise<void> {}
  },
}));

const { createRelayBridge } = await import("./relayBridge");

const sessionService: SessionService = {
  startSession: () => ({ ok: false, message: "not used" }),
  sendInput: async () => ({ ok: true }),
  answerApproval: () => ({ ok: true }),
  switchSession: () => undefined,
  stopSession: () => undefined,
  listSessions: () => [],
};

function runtimeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "session-1",
    executionMode: "stream-json",
    agentState: "working",
    currentEventType: "assistant:text",
    lastEventAt: new Date(0).toISOString(),
    ...overrides,
  };
}

let usageUtilization = 0.5;

describe("relay bridge write path", () => {
  let bridge: Awaited<ReturnType<typeof makeBridge>>;

  async function makeBridge() {
    const created = createRelayBridge({
      url: "https://relay.test",
      appVersion: "test",
      sessionService,
      isRemoteWorkspaceAllowed: () => true,
      log: () => undefined,
      pairingChanged: () => undefined,
      getUsageBundle: async () => ({
        claude: {
          provider: "claude" as const,
          windows: [{ key: "5h", label: "5-hour", utilization: usageUtilization }],
          fetchedAt: new Date(0).toISOString(),
        },
        codex: null,
      }),
      runBtw: async () => ({ ok: false, message: "not used" }),
      loadUsageCost: () => {
        throw new Error("not used");
      },
      loadSessionFiles: async () => ({ isRepo: false, files: [], added: 0, removed: 0 }),
    });
    await created.start();
    return created;
  }

  /** Let the 1s flush timer fire and its awaited mutations settle. */
  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    usageUtilization = 0.5;
    held = null;
    calls.length = 0;
    bridge = await makeBridge();
    calls.length = 0;
  });

  afterEach(() => {
    bridge.stop();
    vi.useRealTimers();
  });

  const names = () => calls.map((call) => call.name);

  it("registers a session once, then carries the badge on putRuntime", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();
    // The first tick is also this session's registration.
    expect(names()).toContain("sessions:upsertSession");

    calls.length = 0;
    bridge.observeLocalEvent(
      "session:runtime",
      runtimeEvent({ lastEventAt: new Date(1_000).toISOString(), latestTool: "Read" }),
    );
    await flush();
    // Same status/agentState: the session row has nothing new to say, so the
    // badge must not drag a full upsert (and its reads) along with it.
    expect(names()).toEqual(["sessions:putRuntime"]);
  });

  it("upserts when the agent state actually transitions", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();

    calls.length = 0;
    bridge.observeLocalEvent(
      "session:runtime",
      runtimeEvent({ agentState: "waiting", lastEventAt: new Date(2_000).toISOString() }),
    );
    await flush();
    // working -> waiting is the "turn finished" signal the relay turns into a push
    // notification, so this one has to reach the session row.
    expect(names()).toContain("sessions:upsertSession");
  });

  it("still upserts a transition that lands while an upsert is in flight", async () => {
    // The turn ends mid-flight. Before the version check, clearing `metadataDirty`
    // after the await swallowed it: the row kept "working" forever (nothing else
    // ticks on an idle session) while the badge went on to say "waiting" — the
    // phone's list spun on a session that opened as Ready.
    const gate = holdMutation("sessions:upsertSession");
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();
    expect(names()).toEqual(["sessions:upsertSession"]);

    bridge.observeLocalEvent(
      "session:runtime",
      runtimeEvent({ agentState: "waiting", lastEventAt: new Date(2_000).toISOString() }),
    );
    gate.release();
    await flush();
    await flush();

    const upserts = calls.filter((call) => call.name === "sessions:upsertSession");
    expect(upserts).toHaveLength(2);
    expect(upserts[1]?.args.agentState).toBe("waiting");
  });

  it("writes nothing when a replayed runtime event repeats the last one", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();

    calls.length = 0;
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();
    // An idle session re-emitting its state (transcript replay, resume) must not
    // turn into a write per tick.
    expect(calls).toEqual([]);
  });

  it("ignores the title and claude session id re-stated on every tick", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent({ claudeSessionId: "claude-1" }));
    bridge.observeLocalEvent("session:title", { id: "session-1", title: "Fix the flush" });
    await flush();

    calls.length = 0;
    // The main process re-emits both of these alongside every `session:runtime`
    // tick. Re-stating an unchanged value must not mark the session row dirty,
    // or the per-second badge drags a full upsert back onto the hot path.
    bridge.observeLocalEvent("session:claude-session", { id: "session-1", claudeSessionId: "claude-1" });
    bridge.observeLocalEvent("session:title", { id: "session-1", title: "Fix the flush" });
    await flush();
    expect(calls).toEqual([]);

    bridge.observeLocalEvent("session:title", { id: "session-1", title: "Renamed" });
    await flush();
    expect(names()).toEqual(["sessions:upsertSession"]);
  });

  it("sends the usage snapshot once per distinct value", async () => {
    // `start()` fetched and pushed the first snapshot. The heartbeat then fires
    // every 12s: re-sending that unchanged blob on each one rewrote a relay
    // document, and re-fired every phone's `devices:status` subscription, five
    // times a minute to say nothing.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    const withUsage = () =>
      calls.filter((call) => call.name === "devices:heartbeat" && call.args.usageCipher !== undefined);
    expect(calls.filter((call) => call.name === "devices:heartbeat").length).toBeGreaterThan(1);
    expect(withUsage()).toEqual([]);

    // A snapshot whose numbers moved does go up — exactly once.
    calls.length = 0;
    usageUtilization = 0.9;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(withUsage()).toHaveLength(1);
  });
});
