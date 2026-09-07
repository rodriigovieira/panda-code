import { describe, expect, it, vi } from "vitest";
import { createStreamJsonState } from "../shared/stream-json";
import type { SessionStartRequest } from "../shared/ipc";
import { createSessionService, type ManagedStreamSession } from "./sessionService";

function baseRequest(overrides: Partial<SessionStartRequest> = {}): SessionStartRequest {
  return {
    id: "sess-1",
    cwd: "/work",
    command: "claude",
    runtime: "claude",
    executionMode: "stream-json",
    cols: 100,
    rows: 30,
    ...overrides,
  };
}

function fakeStreamSession(request: SessionStartRequest): ManagedStreamSession {
  return {
    process: {
      stdin: { write: vi.fn(), end: vi.fn(), destroyed: false, writable: true },
      kill: vi.fn(),
    } as unknown as ManagedStreamSession["process"],
    runtime: request.runtime ?? "claude",
    state: createStreamJsonState(),
    stdoutBuffer: "",
    cwd: request.cwd,
    request,
    lastPromptAt: Date.now(),
  };
}

function makeService(over: Partial<Parameters<typeof createSessionService>[0]> = {}) {
  const streamSessions = new Map<string, ManagedStreamSession>();
  const resumeRequests = new Map<string, SessionStartRequest>();
  const deps = {
    sessions: new Map(),
    streamSessions,
    ptyEnvironment: () => ({}) as NodeJS.ProcessEnv,
    logMain: vi.fn(),
    startStreamSession: vi.fn((request: SessionStartRequest) => {
      streamSessions.set(request.id, fakeStreamSession(request));
      return { ok: true as const };
    }),
    refreshSleepBlocker: vi.fn(),
    readClaudeSessions: () => new Map<string, number>(),
    detectClaudeSession: vi.fn(),
    stopClaudeSessionDetector: vi.fn(),
    resumedSessionFromCommand: () => null,
    detectedClaudeSessions: new Map<string, string>(),
    sendToLiveWindows: vi.fn(),
    sendStreamSnapshot: vi.fn(),
    streamPromptPayload: (prompt: string) => `${prompt}\n`,
    getStreamResumeRequest: (id: string) => resumeRequests.get(id),
    setStreamResumeRequest: (id: string, request: SessionStartRequest) => resumeRequests.set(id, request),
    ...over,
  };
  return { service: createSessionService(deps), deps, streamSessions, resumeRequests };
}

describe("sendInput", () => {
  it("reports a drop when no transport owns the section", async () => {
    const { service } = makeService();

    const result = await service.sendInput({ id: "sess-1", data: "how we doing here" });

    // Nothing to write to: the caller has to learn the prompt never landed,
    // otherwise the UI waits on a turn that will never start.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/no longer running/i);
  });

  it("acknowledges input written to a live stream session", async () => {
    const { service, streamSessions } = makeService();
    streamSessions.set("sess-1", fakeStreamSession(baseRequest()));

    await expect(service.sendInput({ id: "sess-1", data: "hi" })).resolves.toEqual({ ok: true });
    expect(streamSessions.get("sess-1")?.process.stdin.write).toHaveBeenCalledWith("hi\n");
  });

  it("marks a live stream section working the moment its prompt is written", async () => {
    // Claude answers a prompt with `system:init` in ~200ms but can take 10s+ to
    // emit its first real event, and system notices don't move the state. A
    // state left at "waiting" from the last turn's `result` therefore rode every
    // snapshot in that window and reported the section Ready right after send.
    const { service, deps, streamSessions } = makeService();
    const session = fakeStreamSession(baseRequest());
    session.state.agentState = "waiting";
    streamSessions.set("sess-1", session);

    await service.sendInput({ id: "sess-1", data: "hi" });

    expect(session.state.agentState).toBe("working");
    expect(deps.sendStreamSnapshot).toHaveBeenCalledWith("sess-1", session);
  });

  it("restarts a dormant section from its stored thread and delivers the prompt", async () => {
    // A phone prompt lands here whenever the agent's process has exited — the
    // normal state of every section after a desktop restart. The desktop
    // composer restarts the section before it writes; nothing does that for a
    // remote prompt, so the service has to.
    const stored = baseRequest({ cwd: process.cwd(), claudeSessionId: "claude-abc", model: "opus" });
    const { service, deps, streamSessions } = makeService({ getStoredStartRequest: () => stored });

    const result = await service.sendInput({ id: "sess-1", data: "carry on" });

    expect(result).toEqual({ ok: true });
    expect(deps.startStreamSession).toHaveBeenCalledWith(expect.objectContaining({ claudeSessionId: "claude-abc", model: "opus" }));
    expect(streamSessions.get("sess-1")?.process.stdin.write).toHaveBeenCalledWith("carry on\n");
    // The renderer and the relay both learn the section is live again.
    expect(deps.sendToLiveWindows).toHaveBeenCalledWith("session:started", { request: stored });
  });

  it("hands a restarted codex section's prompt to the app-server", async () => {
    const stored = baseRequest({ cwd: process.cwd(), runtime: "codex", command: "codex", codexThreadId: "th-1" });
    const sendInput = vi.fn(async () => ({ ok: true as const }));
    let live = false;
    const { service, deps } = makeService({
      getStoredStartRequest: () => stored,
      startStreamSession: vi.fn(() => {
        live = true;
        return { ok: true as const };
      }),
      appServer: {
        has: () => live,
        ids: () => (live ? ["sess-1"] : []),
        getRequest: () => stored,
        sendInput,
        answerApproval: vi.fn(() => ({ ok: true as const })),
        stop: vi.fn(),
        updateOverrides: vi.fn(),
        replay: vi.fn(),
      },
    });

    await expect(service.sendInput({ id: "sess-1", data: "carry on", imagePaths: ["/tmp/a.png"] })).resolves.toEqual({ ok: true });
    expect(deps.startStreamSession).toHaveBeenCalledWith(expect.objectContaining({ runtime: "codex", codexThreadId: "th-1" }));
    expect(sendInput).toHaveBeenCalledWith("sess-1", "carry on", ["/tmp/a.png"]);
  });

  it("reports the failure when a dormant section cannot be restarted", async () => {
    // Its workspace folder is gone, so there is nothing to launch — the phone
    // needs to hear that rather than watch a bubble sit there.
    const { service } = makeService({ getStoredStartRequest: () => baseRequest({ cwd: "/nope/not/here" }) });

    const result = await service.sendInput({ id: "sess-1", data: "carry on" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/could not restart/i);
  });

  it("acknowledges input handed to a live pty session", async () => {
    const write = vi.fn();
    const sessions = new Map([["sess-1", { write } as unknown as never]]);
    const { service } = makeService({ sessions });

    await expect(service.sendInput({ id: "sess-1", data: "hi\r" })).resolves.toEqual({ ok: true });
    expect(write).toHaveBeenCalledWith("hi\r");
  });
});

describe("switchSession", () => {
  it("rewrites the resume request, snapshots ready, and tears down a live Claude section", () => {
    const { service, streamSessions, resumeRequests, deps } = makeService();
    const live = fakeStreamSession(baseRequest({ model: "sonnet", effort: "low" }));
    live.state.claudeSessionId = "claude-abc";
    live.state.agentState = "working";
    streamSessions.set("sess-1", live);

    service.switchSession({ id: "sess-1", model: "opus" });

    // Resume request captures the new model + the live conversation id, and
    // leaves the untouched effort alone.
    const resume = resumeRequests.get("sess-1");
    expect(resume).toMatchObject({ model: "opus", effort: "low", claudeSessionId: "claude-abc" });
    // A ready snapshot went out before the kill so the phone leaves "working".
    expect(deps.sendStreamSnapshot).toHaveBeenCalledWith("sess-1", live);
    expect(live.state.agentState).toBe("waiting");
    expect(live.process.kill).toHaveBeenCalled();
    expect(streamSessions.has("sess-1")).toBe(false);
  });

  it("resumes the switched Claude section with the new model on the next input", async () => {
    const { service, streamSessions, deps } = makeService();
    const live = fakeStreamSession(baseRequest({ model: "sonnet" }));
    live.state.claudeSessionId = "claude-abc";
    streamSessions.set("sess-1", live);

    service.switchSession({ id: "sess-1", model: "opus" });
    await service.sendInput({ id: "sess-1", data: "keep going" });

    // The next input re-spawned the section from the rewritten resume request.
    expect(deps.startStreamSession).toHaveBeenCalledWith(expect.objectContaining({ id: "sess-1", model: "opus" }));
    const resumed = streamSessions.get("sess-1");
    expect(resumed?.process.stdin.write).toHaveBeenCalledWith("keep going\n");
  });

  it("clears a setting when passed an empty string", () => {
    const { service, streamSessions, resumeRequests } = makeService();
    streamSessions.set("sess-1", fakeStreamSession(baseRequest({ model: "opus", effort: "high" })));

    service.switchSession({ id: "sess-1", effort: "" });

    expect(resumeRequests.get("sess-1")).toMatchObject({ model: "opus" });
    expect(resumeRequests.get("sess-1")?.effort).toBeUndefined();
  });

  it("delegates to the app-server overrides for a codex app-server section", () => {
    const updateOverrides = vi.fn();
    const { service } = makeService({
      appServer: {
        has: (id: string) => id === "sess-1",
        ids: () => ["sess-1"],
        getRequest: () => baseRequest({ runtime: "codex", command: "codex" }),
        sendInput: vi.fn(async () => ({ ok: true as const })),
        answerApproval: vi.fn(() => ({ ok: true as const })),
        stop: vi.fn(),
        updateOverrides,
        replay: vi.fn(),
      },
    });

    service.switchSession({ id: "sess-1", model: "gpt-5.5", effort: "high" });

    expect(updateOverrides).toHaveBeenCalledWith("sess-1", { model: "gpt-5.5", effort: "high", permissionMode: undefined });
  });

  it("starts a fresh Codex thread when switching provider from a live Claude section", async () => {
    const { service, streamSessions, resumeRequests, deps } = makeService();
    const live = fakeStreamSession(baseRequest({ model: "opus", effort: "high" }));
    live.state.claudeSessionId = "claude-abc";
    streamSessions.set("sess-1", live);

    service.switchSession({ id: "sess-1", runtime: "codex" });

    const resume = resumeRequests.get("sess-1");
    // Fresh Codex thread: command flips, target resume id is cleared, sandbox defaults.
    // The old Claude id remains as read-only transcript history for restore.
    expect(resume).toMatchObject({ runtime: "codex", command: "codex", permissionMode: "read-only" });
    expect(resume?.claudeSessionId).toBe("claude-abc");
    expect(resume?.codexThreadId).toBeUndefined();
    // The old Claude model/effort are dropped, not carried into Codex.
    expect(resume?.model).toBeUndefined();
    expect(resume?.effort).toBeUndefined();
    expect(live.process.kill).toHaveBeenCalled();

    // The next input re-opens the Codex thread on the app-server, not Claude.
    await service.sendInput({ id: "sess-1", data: "hi" });
    expect(deps.startStreamSession).toHaveBeenCalledWith(expect.objectContaining({ runtime: "codex" }));
  });

  it("resumes as Claude on next input when switching provider from Codex", async () => {
    const { service, resumeRequests, deps, streamSessions } = makeService();
    resumeRequests.set("sess-1", baseRequest({ runtime: "codex", command: "codex", codexThreadId: "th-1" }));

    service.switchSession({ id: "sess-1", runtime: "claude", model: "sonnet" });
    await service.sendInput({ id: "sess-1", data: "hi" });

    expect(deps.startStreamSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "claude", command: "claude", model: "sonnet" }),
    );
    // The old Codex id remains as read-only transcript history for restore.
    expect(resumeRequests.get("sess-1")?.codexThreadId).toBe("th-1");
    expect(streamSessions.get("sess-1")?.process.stdin.write).toHaveBeenCalledWith("hi\n");
  });

  it("updates the resume request for an idle codex section without killing anything", () => {
    const { service, resumeRequests } = makeService();
    resumeRequests.set("sess-1", baseRequest({ runtime: "codex", command: "codex", model: "", effort: "low", codexThreadId: "th-1" }));

    service.switchSession({ id: "sess-1", effort: "high" });

    expect(resumeRequests.get("sess-1")).toMatchObject({ runtime: "codex", effort: "high", codexThreadId: "th-1" });
  });
});

/**
 * Hibernation is "kill the process, keep the section" — the reaper's teardown.
 * What these guard is the difference between that and stopping a section: a
 * hibernated section must come back on its next prompt with its conversation
 * intact, and must never have looked like it crashed on the way out.
 *
 * The refusals matter as much as the successes. `hibernateSession` returning
 * false is the last line of defence before an eviction turns into data loss,
 * and it is the only thing standing between a section with no resume id and
 * permanent deletion.
 */
describe("hibernateSession", () => {
  it("tears down a live Claude section and keeps it resumable", () => {
    const { service, streamSessions, resumeRequests, deps } = makeService();
    const live = fakeStreamSession(baseRequest({ model: "opus" }));
    live.state.claudeSessionId = "claude-abc";
    streamSessions.set("sess-1", live);

    expect(service.hibernateSession("sess-1")).toBe(true);

    expect(live.process.kill).toHaveBeenCalled();
    // Removed from the live map *before* the async close event fires, which is
    // what makes the exit handler take its stale-exit branch — a hibernated
    // section must not surface as a crash.
    expect(streamSessions.has("sess-1")).toBe(false);
    expect(resumeRequests.get("sess-1")).toMatchObject({ claudeSessionId: "claude-abc", model: "opus" });
    expect(deps.refreshSleepBlocker).toHaveBeenCalled();
  });

  it("reports the section idle rather than exited before killing it", () => {
    const { service, streamSessions, deps } = makeService();
    const live = fakeStreamSession(baseRequest());
    live.state.claudeSessionId = "claude-abc";
    live.state.agentState = "working";
    streamSessions.set("sess-1", live);

    service.hibernateSession("sess-1");

    // The phone would otherwise sit on a stale badge for a section that no
    // longer has a process behind it.
    expect(live.state.agentState).toBe("waiting");
    expect(deps.sendStreamSnapshot).toHaveBeenCalledWith("sess-1", live);
  });

  it("refuses a section with no resume id instead of destroying it", () => {
    const { service, streamSessions } = makeService();
    const live = fakeStreamSession(baseRequest());
    streamSessions.set("sess-1", live);

    // Nothing to `--resume` from: hibernating this would lose the conversation.
    expect(service.hibernateSession("sess-1")).toBe(false);
    expect(live.process.kill).not.toHaveBeenCalled();
    expect(streamSessions.has("sess-1")).toBe(true);
  });

  it("refuses a section that is not live", () => {
    const { service } = makeService();
    expect(service.hibernateSession("sess-1")).toBe(false);
  });

  it("resumes a hibernated section on its next prompt", async () => {
    const { service, streamSessions, deps } = makeService();
    const live = fakeStreamSession(baseRequest({ model: "opus" }));
    live.state.claudeSessionId = "claude-abc";
    streamSessions.set("sess-1", live);
    service.hibernateSession("sess-1");

    const result = await service.sendInput({ id: "sess-1", data: "still there?" });

    expect(result).toEqual({ ok: true });
    expect(deps.startStreamSession).toHaveBeenCalledWith(
      expect.objectContaining({ claudeSessionId: "claude-abc", model: "opus" }),
    );
    expect(streamSessions.get("sess-1")?.process.stdin.write).toHaveBeenCalledWith("still there?\n");
  });

  it("stops a codex section's thread and stores the live thread id", () => {
    const stop = vi.fn();
    const { service, resumeRequests } = makeService({
      appServer: {
        has: (id: string) => id === "sess-1",
        ids: () => ["sess-1"],
        getRequest: () => baseRequest({ runtime: "codex", command: "codex" }),
        threadId: () => "th-live",
        sendInput: vi.fn(),
        answerApproval: vi.fn(),
        stop,
        updateOverrides: vi.fn(),
        replay: vi.fn(),
      },
    });

    expect(service.hibernateSession("sess-1")).toBe(true);
    expect(stop).toHaveBeenCalledWith("sess-1");
    expect(resumeRequests.get("sess-1")).toMatchObject({ codexThreadId: "th-live" });
  });
});
