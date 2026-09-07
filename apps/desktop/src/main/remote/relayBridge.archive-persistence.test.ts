import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionService } from "../sessionService";
import type { SessionArchivedEvent } from "../../shared/ipc";

/**
 * The bug this covers: archive state lives on the relay as a `sessionArchive`
 * row AND in the renderer's localStorage. On every connect the whole table is
 * replayed, and a stale `archived: false` row used to win over a session that
 * had been archived on this Mac for months — because the guard against stale
 * rows (`archivedChangedAt`) was in-memory only and forgot everything on
 * relaunch. These tests exercise the fix: `archivedChangedAt` persisted to
 * disk, and a one-time self-heal for sessions already stuck when the fix
 * shipped.
 */

let queuedRows: Record<string, Array<{ sessionId: string; archived: boolean; updatedAt: number }>> = {};
const calls: Array<{ name: string; args: unknown }> = [];

vi.mock("./keychain", () => ({
  readKeychainSecret: vi.fn(async () => null),
  writeKeychainSecret: vi.fn(async () => undefined),
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class {
    async mutation(reference: unknown, args: unknown): Promise<unknown> {
      const name = getFunctionName(reference as never);
      calls.push({ name, args });
      return null;
    }
    async query(reference: unknown): Promise<unknown> {
      const name = getFunctionName(reference as never);
      const queue = queuedRows[name];
      if (!queue || queue.length === 0) return [];
      // Each call drains one page; subsequent calls (the next `since` cursor,
      // or a re-poll) see nothing left, mirroring a real one-shot backlog read.
      const page = queue;
      queuedRows = { ...queuedRows, [name]: [] };
      return page;
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

function makeBridge(
  userDataPath: string | undefined,
  onArchivedChanged: (event: SessionArchivedEvent) => void,
): ReturnType<typeof createRelayBridge> {
  return createRelayBridge({
    url: "https://relay.test",
    appVersion: "test",
    userDataPath,
    sessionService,
    isRemoteWorkspaceAllowed: () => true,
    log: () => undefined,
    pairingChanged: () => undefined,
    archivedChanged: onArchivedChanged,
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

function archiveMutationCalls(): Array<{ sessionId: string; archived: boolean }> {
  return calls
    .filter((c) => c.name === "sessions:setArchivedByDevice")
    .map((c) => c.args as { sessionId: string; archived: boolean });
}

describe("relay bridge archive persistence", () => {
  let bridge: ReturnType<typeof createRelayBridge> | undefined;
  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    queuedRows = {};
    calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), "relay-archive-test-"));
  });

  afterEach(() => {
    bridge?.stop();
    bridge = undefined;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("self-heals a session stuck archived locally with a stale false row and no persisted timestamp", async () => {
    queuedRows["sessions:archivedForDevice"] = [{ sessionId: "s1", archived: false, updatedAt: 1000 }];
    const events: SessionArchivedEvent[] = [];
    bridge = makeBridge(dir, (event) => events.push(event));
    await bridge.start();

    // The renderer's localStorage says s1 is archived. With no persisted flip
    // timestamp, the stale `false` row must not be allowed to stand.
    bridge.syncLocalArchivedThreads(["s1"]);

    const archiveCalls = archiveMutationCalls();
    expect(archiveCalls).toContainEqual(expect.objectContaining({ sessionId: "s1", archived: true }));
    // The renderer must be told the corrected value, not left on the `false`
    // that `connect`'s replay may already have emitted.
    expect(events.at(-1)).toEqual({ id: "s1", archived: true });
  });

  it("still applies a live row newer than the persisted flip timestamp (a real phone-side unarchive)", async () => {
    writeFileSync(join(dir, "archive-flips.json"), JSON.stringify({ s1: 500 }));
    queuedRows["sessions:archivedForDevice"] = [{ sessionId: "s1", archived: false, updatedAt: 1000 }];
    const events: SessionArchivedEvent[] = [];
    bridge = makeBridge(dir, (event) => events.push(event));
    await bridge.start();

    expect(events).toContainEqual({ id: "s1", archived: false });
  });

  it("ignores a row older than a persisted flip timestamp loaded off disk in a fresh bridge instance", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "archive-flips.json"), JSON.stringify({ s1: 2000 }));
    queuedRows["sessions:archivedForDevice"] = [{ sessionId: "s1", archived: false, updatedAt: 1000 }];
    const events: SessionArchivedEvent[] = [];
    bridge = makeBridge(dir, (event) => events.push(event));
    await bridge.start();

    expect(events.find((e) => e.id === "s1")).toBeUndefined();
    // The file on disk is what supplied the timestamp — confirm it is still there,
    // untouched, proving the guard came from disk and not from this run's own state.
    const persisted = JSON.parse(readFileSync(join(dir, "archive-flips.json"), "utf8")) as Record<string, number>;
    expect(persisted.s1).toBe(2000);
  });

  it("persists a local flip but not a relay row applied through the connect-time read", async () => {
    // r1 arrives as a relay row during connect — someone else's decision.
    queuedRows["sessions:archivedForDevice"] = [{ sessionId: "r1", archived: false, updatedAt: 1000 }];
    bridge = makeBridge(dir, () => undefined);
    await bridge.start();

    // s2 is a flip THIS Mac makes right now.
    bridge.setSessionArchived({ id: "s2", archived: true });

    // Past the save debounce for the s2 flip. If the connect-time row had also
    // scheduled a save, this same window would have flushed it too.
    await vi.advanceTimersByTimeAsync(3000);

    const persisted = JSON.parse(readFileSync(join(dir, "archive-flips.json"), "utf8")) as Record<string, number>;
    expect(persisted).toHaveProperty("s2");
    // The relay's own row must never end up in the file: persisting it would
    // permanently disqualify the session from the self-heal on a future
    // relaunch, and a relay row is not this Mac's decision to remember.
    expect(persisted).not.toHaveProperty("r1");
  });

  it("lets a genuinely newer phone-side unarchive stand: syncLocalArchivedThreads does not fight it", async () => {
    // A local flip was persisted a while ago (this Mac archived it once)...
    writeFileSync(join(dir, "archive-flips.json"), JSON.stringify({ s1: 500 }));
    // ...but the phone unarchived it more recently, and that row is newer.
    queuedRows["sessions:archivedForDevice"] = [{ sessionId: "s1", archived: false, updatedAt: 1000 }];
    const events: SessionArchivedEvent[] = [];
    bridge = makeBridge(dir, (event) => events.push(event));
    await bridge.start();

    // Connect itself applies the newer row and reports the unarchive once.
    expect(events).toContainEqual({ id: "s1", archived: false });

    events.length = 0;
    calls.length = 0;
    // The renderer's stale localStorage still thinks s1 is archived and syncs it.
    bridge.syncLocalArchivedThreads(["s1"]);

    // The persisted flip timestamp disqualifies s1 from the self-heal, and the
    // non-heal seed path skips any session the relay already has a value for —
    // so nothing is re-pushed and the renderer is not told anything new. The
    // phone's decision must stand.
    expect(events).toEqual([]);
    expect(archiveMutationCalls()).toEqual([]);
  });
});
