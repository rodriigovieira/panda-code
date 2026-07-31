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

vi.mock("./keychain", () => ({
  readKeychainSecret: vi.fn(async () => null),
  writeKeychainSecret: vi.fn(async () => undefined),
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class {
    async mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ name: getFunctionName(reference as never), args });
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
