import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionService } from "../sessionService";
import { decryptJson, encryptJson } from "./crypto";

/**
 * The durable half of mobile's "queue a follow-up" composer state: a prompt
 * queued behind the active turn lives here (main process), not on the phone,
 * so it survives the phone being killed and reopened. See the `QueuedPrompt`
 * plumbing in `relayBridge.ts` (`MirrorState.queuedPrompts`, `dispatchQueue`,
 * the auto-flush hook inside `observeRuntime`).
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

describe("relay bridge queued prompts", () => {
  let sendInputCalls: Array<{ id: string; data: string }>;
  let sessionService: SessionService;
  let bridge: Awaited<ReturnType<typeof makeBridge>>;

  async function makeBridge() {
    const created = createRelayBridge({
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
    await created.start();
    return created;
  }

  /** Same shape `commands:enqueue` hands `dispatchCommand`; encrypted with the
   * bridge's own (test-generated) key so `dispatchQueue`'s decrypt succeeds. */
  function queueCommand(payload: Record<string, unknown>) {
    const key = (bridge as unknown as { credentials: { key: Uint8Array } }).credentials.key;
    return {
      _id: `cmd-${Math.random()}`,
      mobileId: "mobile-1",
      sessionId: "session-1",
      type: "queue" as const,
      payloadCipher: encryptJson(payload, key),
      createdAt: Date.now(),
    };
  }

  // `dispatchQueue`/`flushQueuedPrompt` are private — reached the same way the
  // relay's command loop reaches them (by shape), since nothing here exercises
  // the claim/ack subscription machinery (untested elsewhere too; see the
  // skipped smoke test in relayBridge.integration.test.ts).
  function dispatchQueue(payload: Record<string, unknown>) {
    return (bridge as unknown as { dispatchQueue: (c: unknown) => Promise<{ succeeded: boolean; payload: { message: string } }> })
      .dispatchQueue(queueCommand(payload));
  }

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    calls.length = 0;
    sendInputCalls = [];
    sessionService = {
      startSession: () => ({ ok: false, message: "not used" }),
      sendInput: async (request) => {
        sendInputCalls.push({ id: request.id, data: request.data });
        return { ok: true };
      },
      answerApproval: () => ({ ok: true }),
      switchSession: () => undefined,
      hibernateSession: () => false,
      stopSession: () => undefined,
      listSessions: () => [],
      getRequest: (id) => ({ id, cwd: "/tmp", command: "codex", runtime: "codex", permissionMode: "workspace-write", executionMode: "stream-json", cols: 80, rows: 24 }),
    };
    bridge = await makeBridge();
    calls.length = 0;
  });

  afterEach(() => {
    bridge.stop();
    vi.useRealTimers();
  });

  it.each(["waiting", "exited"])("delivers a stale queue request immediately when %s", async (agentState) => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent({ agentState }));
    const result = await dispatchQueue({ action: "add", id: "q1", data: "continue" });
    expect(result).toEqual({ succeeded: true, payload: { message: "Sent." } });
    expect(sendInputCalls).toEqual([{ id: "session-1", data: "continue" }]);
    bridge.observeLocalEvent("session:runtime", runtimeEvent({ agentState: "waiting" }));
    await flush();
    expect(sendInputCalls).toHaveLength(1);
  });

  it("reports a failed immediate delivery instead of claiming it was queued", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent({ agentState: "waiting" }));
    sessionService.sendInput = async () => ({ ok: false, message: "Could not restart section." });
    expect(await dispatchQueue({ action: "add", id: "q1", data: "continue" })).toEqual({
      succeeded: false, payload: { message: "Could not restart section." },
    });
  });

  it("publishes an exited badge when the process exits without a final runtime tick", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();
    calls.length = 0;
    bridge.observeLocalEvent("session:exit", { id: "session-1", exitCode: 0 });
    await flush();
    const upsert = calls.find((c) => c.name === "sessions:upsertSession");
    const key = (bridge as unknown as { credentials: { key: Uint8Array } }).credentials.key;
    expect(upsert?.args.agentState).toBe("exited");
    expect(decryptJson(upsert!.args.runtimeCipher as string, key)).toMatchObject({
      agentState: "exited", currentEventType: "process:exit",
    });
  });

  it("mirrors an added prompt into the synced runtime without sending it", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();

    const result = await dispatchQueue({ action: "add", id: "q1", data: "finish the refactor" });
    expect(result.succeeded).toBe(true);
    expect(sendInputCalls).toEqual([]);

    calls.length = 0;
    await flush();
    const putRuntime = calls.find((c) => c.name === "sessions:putRuntime");
    expect(putRuntime?.args.runtimeCipher).toBeDefined();
  });

  it("drops a removed prompt without ever sending it", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();
    await dispatchQueue({ action: "add", id: "q1", data: "abandon this one" });

    const result = await dispatchQueue({ action: "remove", id: "q1" });
    expect(result.succeeded).toBe(true);

    // Nothing queued behind it, so a later "waiting" tick must not send anything.
    bridge.observeLocalEvent("session:runtime", runtimeEvent({ agentState: "waiting" }));
    await flush();
    expect(sendInputCalls).toEqual([]);
  });

  it("send-now delivers immediately instead of waiting for the turn to end", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();
    await dispatchQueue({ action: "add", id: "q1", data: "steer this in" });

    const result = await dispatchQueue({ action: "send-now", id: "q1" });
    expect(result.succeeded).toBe(true);
    expect(sendInputCalls).toEqual([{ id: "session-1", data: "steer this in" }]);
  });

  it("auto-flushes the oldest queued prompt once the turn finishes", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();
    await dispatchQueue({ action: "add", id: "q1", data: "first follow-up" });
    await dispatchQueue({ action: "add", id: "q2", data: "second follow-up" });

    // working -> waiting: the turn just ended, oldest queued entry ships on its
    // own — the whole point of this feature (mobile no longer has to be open,
    // let alone tap "send now", for a queued follow-up to actually go out).
    bridge.observeLocalEvent("session:runtime", runtimeEvent({ agentState: "waiting" }));
    await flush();

    expect(sendInputCalls).toEqual([{ id: "session-1", data: "first follow-up" }]);
  });

  it("does not double-flush the same entry when waiting ticks land back to back", async () => {
    bridge.observeLocalEvent("session:runtime", runtimeEvent());
    await flush();
    await dispatchQueue({ action: "add", id: "q1", data: "first follow-up" });

    // Two "waiting" ticks land before the first flush's awaited `sendInput`
    // resolves — `autoFlushingQueue` must stop the second from re-sending q1.
    bridge.observeLocalEvent("session:runtime", runtimeEvent({ agentState: "waiting" }));
    bridge.observeLocalEvent(
      "session:runtime",
      runtimeEvent({ agentState: "waiting", lastEventAt: new Date(1).toISOString() }),
    );
    await flush();

    expect(sendInputCalls).toEqual([{ id: "session-1", data: "first follow-up" }]);
  });
});
