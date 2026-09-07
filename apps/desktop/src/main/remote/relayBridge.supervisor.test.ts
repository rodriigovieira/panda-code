import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionService } from "../sessionService";

/**
 * The bridge has to come back on its own.
 *
 * A `connect()` that threw used to clear every timer and schedule nothing, so
 * the phone stayed offline until something else happened to call `start()` — in
 * practice, opening Settings → Phone, whose device list calls `start()` when it
 * finds no client. Recovery must not depend on the user looking at a panel.
 */

/** Mutation names that should reject, so a test can fail a connect on demand. */
let failing = new Set<string>();
const calls: string[] = [];

vi.mock("./keychain", () => ({
  readKeychainSecret: vi.fn(async () => null),
  writeKeychainSecret: vi.fn(async () => undefined),
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class {
    async mutation(reference: unknown): Promise<unknown> {
      const name = getFunctionName(reference as never);
      calls.push(name);
      if (failing.has(name)) throw new Error(`${name} refused`);
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
  hibernateSession: () => false,
  stopSession: () => undefined,
  listSessions: () => [],
};

function makeBridge(): ReturnType<typeof createRelayBridge> {
  return createRelayBridge({
    url: "https://relay.test",
    appVersion: "test",
    sessionService,
    isRemoteWorkspaceAllowed: () => true,
    log: () => undefined,
    pairingChanged: () => undefined,
    getUsageBundle: async () => null,
    runBtw: async () => ({ ok: false, message: "not used" }),
    loadUsageCost: () => {
      throw new Error("not used");
    },
    loadSessionFiles: async () => ({ isRepo: false, files: [], added: 0, removed: 0 }),
    applyBacklog: () => ({ ok: true, backlog: { version: 1, cwd: "/tmp", items: [], nextNumber: 1, updatedAt: "" } }),
    loadRemoteSchedule: () => ({ version: 1, cwd: "/tmp", items: [], updatedAt: "" }),
    loadRemoteGitStatus: async () => ({ isRepo: false, remotes: [], changes: [], stashes: [], worktrees: [], branches: [], folders: [] }),
    loadRemoteGitLog: async () => ({ isRepo: false, commits: [], skip: 0, hasMore: false }),
    loadRemoteTree: async () => ({ path: "", entries: [] }),
    loadRemoteFile: () => ({ path: "", name: "", content: "", size: 0, truncated: false }),
    writeRemoteFile: () => ({ path: "", size: 0, savedAt: 0 }),
    loadMachineStats: async () => ({
      capturedAt: new Date(0).toISOString(),
      hostname: "test",
      platform: "darwin",
      uptimeSec: 0,
      cpuCount: 1,
      loadAvg: [0, 0, 0] as [number, number, number],
      cpuPct: 0,
      memTotalBytes: 0,
      memAvailableBytes: 0,
      memUsedPct: 0,
      swapUsedBytes: null,
      swapTotalBytes: null,
      diskUsedPct: null,
      diskFreeBytes: null,
      topByCpu: [],
      topByMemory: [],
      sectionCommands: [],
    }),
    ensureRemoteScratchWorkspace: () => "/tmp/scratch",
    readBrowserMedia: () => Promise.reject(new Error("readBrowserMedia is not wired in this test.")),
  });
}

describe("relay bridge connection supervisor", () => {
  let bridge: ReturnType<typeof createRelayBridge>;

  beforeEach(() => {
    vi.useFakeTimers();
    failing = new Set();
    calls.length = 0;
  });

  afterEach(() => {
    bridge.stop();
    vi.useRealTimers();
  });

  it("reconnects on its own after a failed connect, without touching the pairing panel", async () => {
    failing.add("pairing:registerDevice");
    bridge = makeBridge();
    await bridge.start();
    expect(bridge.getPairingInfo().status).toBe("error");

    // The relay comes back. Nobody opens Settings; only time passes.
    failing.clear();
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toContain("pairing:registerDevice");
    expect(bridge.getPairingInfo().status).toBe("ready");
  });

  it("rebuilds a connection that never acknowledges a heartbeat", async () => {
    bridge = makeBridge();
    await bridge.start();
    expect(bridge.getPairingInfo().status).toBe("ready");

    // The socket goes deaf immediately after connecting: every heartbeat from
    // here on fails, and none has ever been acknowledged since the rebuild.
    failing.add("devices:heartbeat");
    await vi.advanceTimersByTimeAsync(90_000);
    calls.length = 0;
    // Long enough to cover a second staleness window plus the tick that reads
    // it: the rebuild in the first window is the one that never gets an ack.
    await vi.advanceTimersByTimeAsync(150_000);

    expect(calls).toContain("pairing:registerDevice");
  });

  /**
   * Measured on the real Mac: 1500 sessions archived on the desktop, 1480 known
   * to the relay, and the 41-row difference was all RECENT threads — so the
   * phone listed 41 sections the desktop had hidden. Each seed pass sends at
   * most 32 and used to leave the rest for the next connect.
   */
  it("drains an archive backlog larger than one seed pass", async () => {
    bridge = makeBridge();
    await bridge.start();
    calls.length = 0;

    const ids = Array.from({ length: 100 }, (_, i) => `session-${i}`);
    bridge.syncLocalArchivedThreads(ids);
    const seeded = (): number => calls.filter((name) => name === "sessions:setArchivedByDevice").length;
    expect(seeded()).toBe(32);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(seeded()).toBe(100);

    // And it stops: an agreed set costs nothing per tick.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seeded()).toBe(0);
  });
});
