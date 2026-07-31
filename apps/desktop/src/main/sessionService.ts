import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { spawn, type IPty } from "node-pty";
import type {
  AgentRuntime,
  SessionApprovalAnswer,
  SessionApprovalResult,
  SessionInputRequest,
  SessionInputResult,
  SessionStartRequest,
  SessionStartResult,
  SessionStopRequest,
  SessionSwitchRequest,
} from "../shared/ipc";
import type { StreamJsonState } from "../shared/stream-json";

export type ManagedStreamSession = {
  process: ChildProcessWithoutNullStreams;
  runtime: AgentRuntime;
  state: StreamJsonState;
  stdoutBuffer: string;
  cwd: string;
  request: SessionStartRequest;
  /** Last title emitted to the relay, so we only re-send when it changes. */
  emittedTitle?: string;
  /** Set once the AI-generated title has been emitted; stops further re-reads. */
  titleLocked?: boolean;
};

type SessionServiceDependencies = {
  sessions: Map<string, IPty>;
  streamSessions: Map<string, ManagedStreamSession>;
  ptyEnvironment: () => NodeJS.ProcessEnv;
  logMain: (event: string, details?: Record<string, unknown>) => void;
  startStreamSession: (request: SessionStartRequest) => SessionStartResult;
  refreshSleepBlocker: () => void;
  readClaudeSessions: (cwd: string) => Map<string, number>;
  detectClaudeSession: (id: string, cwd: string, before: Map<string, number>, startedAt: number) => void;
  stopClaudeSessionDetector: (id: string) => void;
  resumedSessionFromCommand: (command: string) => string | null;
  detectedClaudeSessions: Map<string, string>;
  sendToLiveWindows: (channel: string, payload: unknown) => void;
  sendStreamSnapshot: (id: string, streamSession: ManagedStreamSession) => void;
  streamPromptPayload: (prompt: string) => string;
  getStreamResumeRequest: (id: string) => SessionStartRequest | undefined;
  setStreamResumeRequest: (id: string, request: SessionStartRequest) => void;
  /**
   * Rebuild a launch request for a section from the persisted thread store.
   * This is how a prompt with no live transport behind it — the normal state of
   * every section after the agent's process exits — gets its section back
   * instead of being dropped. The desktop UI does the same thing before it
   * writes a prompt; a remote (phone) prompt has no UI to do it for it.
   */
  getStoredStartRequest?: (id: string) => SessionStartRequest | undefined;
  // Codex app-server transport (persistent JSON-RPC). Absent → exec-only.
  appServer?: {
    has: (id: string) => boolean;
    ids: () => string[];
    getRequest: (id: string) => SessionStartRequest | undefined;
    sendInput: (id: string, data: string, imagePaths?: string[]) => Promise<SessionInputResult>;
    answerApproval: (answer: SessionApprovalAnswer) => SessionApprovalResult;
    stop: (id: string) => void;
    updateOverrides: (id: string, overrides: { model?: string; effort?: string; permissionMode?: string }) => void;
    replay: () => void;
  };
};

export type SessionService = {
  startSession: (request: SessionStartRequest) => SessionStartResult;
  sendInput: (request: SessionInputRequest) => Promise<SessionInputResult>;
  answerApproval: (answer: SessionApprovalAnswer) => SessionApprovalResult;
  switchSession: (request: SessionSwitchRequest) => void;
  stopSession: (request: SessionStopRequest) => void;
  listSessions: () => string[];
};

export function createSessionService(deps: SessionServiceDependencies): SessionService {
  // Claude sections whose persistent process we tore down for a mid-session
  // switch. The next input for one of these resumes `claude --resume … --model …`
  // from its stored request instead of writing to a dead pipe. Scoped to
  // switches so a normally-exited Claude section keeps its old drop-the-input
  // behavior (its resume request may carry stale settings / no session id).
  const pendingClaudeResume = new Set<string>();

  function emitStarted(request: SessionStartRequest, result: SessionStartResult): SessionStartResult {
    if (result.ok) {
      deps.sendToLiveWindows("session:started", { request });
    }
    return result;
  }

  function startSession(request: SessionStartRequest): SessionStartResult {
    const requestedRuntime = request.runtime ?? "claude";
    const ptyExisting = deps.sessions.get(request.id);
    const streamExisting = deps.streamSessions.get(request.id);
    const appServerExisting = deps.appServer?.has(request.id) ?? false;
    const existingRuntime = streamExisting?.runtime ?? (appServerExisting ? "codex" : ptyExisting ? "claude" : undefined);
    if (existingRuntime && existingRuntime !== requestedRuntime) {
      deps.logMain("session:start-runtime-mismatch", { id: request.id, existingRuntime, requestedRuntime });
      stopSession({ id: request.id });
    } else if (ptyExisting || streamExisting || appServerExisting) {
      deps.logMain("session:start-existing", { id: request.id });
      return emitStarted(request, { ok: true });
    }

    if (!existsSync(request.cwd)) {
      deps.logMain("session:start-missing-cwd", { id: request.id, cwd: request.cwd });
      return { ok: false, message: "Workspace folder does not exist." };
    }

    if (request.executionMode === "stream-json") {
      return emitStarted(request, deps.startStreamSession(request));
    }

    try {
      const shellPath = process.env.SHELL || "/bin/zsh";
      const startedAt = Date.now();
      const claudeSessionsBeforeStart = deps.readClaudeSessions(request.cwd);
      deps.logMain("session:start", {
        id: request.id,
        cwd: request.cwd,
        command: request.command,
        cols: request.cols,
        rows: request.rows,
        knownClaudeSessions: claudeSessionsBeforeStart.size,
      });
      const session = spawn(shellPath, ["-lic", request.command], {
        name: "xterm-256color",
        cwd: request.cwd,
        cols: Math.max(40, request.cols),
        rows: Math.max(12, request.rows),
        env: deps.ptyEnvironment(),
      });

      deps.sessions.set(request.id, session);
      deps.refreshSleepBlocker();
      const resumedClaudeSessionId = deps.resumedSessionFromCommand(request.command);
      deps.detectClaudeSession(request.id, request.cwd, claudeSessionsBeforeStart, startedAt);
      if (resumedClaudeSessionId) {
        deps.detectedClaudeSessions.set(request.id, resumedClaudeSessionId);
        deps.logMain("session:resume-detected", { id: request.id, claudeSessionId: resumedClaudeSessionId });
        deps.sendToLiveWindows("session:claude-session", { id: request.id, claudeSessionId: resumedClaudeSessionId });
      }

      session.onData((data) => {
        deps.logMain("session:data", {
          id: request.id,
          bytes: data.length,
          ready: /what can i help you with today\?|type \/ for commands|baked for/i.test(data),
          preview: data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim(),
        });
        deps.sendToLiveWindows("session:data", { id: request.id, data });
      });

      session.onExit(({ exitCode, signal }) => {
        deps.sessions.delete(request.id);
        deps.refreshSleepBlocker();
        deps.stopClaudeSessionDetector(request.id);
        deps.logMain("session:exit", { id: request.id, exitCode, signal });
        deps.sendToLiveWindows("session:exit", { id: request.id, exitCode, signal });
      });

      return emitStarted(request, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start Claude Code.";
      deps.logMain("session:start-error", { id: request.id, message });
      return { ok: false, message };
    }
  }

  async function sendInput(request: SessionInputRequest): Promise<SessionInputResult> {
    if (deps.appServer?.has(request.id)) {
      deps.logMain("app-server:input", {
        id: request.id,
        bytes: request.data.length,
        images: request.imagePaths?.length ?? 0,
        preview: request.data.replace(/\s+/g, " ").trim(),
      });
      // Awaited, and its real result returned: a queued-or-refused prompt has to
      // reach the caller, which shows a "Thinking…" bubble on the strength of it.
      return deps.appServer.sendInput(request.id, request.data, request.imagePaths);
    }

    const streamSession = deps.streamSessions.get(request.id);
    if (streamSession) {
      deps.logMain("stream-json:input", {
        id: request.id,
        bytes: request.data.length,
        preview: request.data.replace(/\s+/g, " ").trim(),
      });
      streamSession.process.stdin.write(deps.streamPromptPayload(request.data));
      return { ok: true };
    }

    const resumeRequest = deps.getStreamResumeRequest(request.id);
    // A Codex section is always app-server now, so a resume request for one means
    // its thread is gone from the manager (stopped, or the app-server died).
    // Re-open the thread and let the manager deliver this prompt.
    if (resumeRequest?.runtime === "codex") {
      deps.logMain("app-server:resume-for-input", { id: request.id, codexThreadId: resumeRequest.codexThreadId });
      const result = deps.startStreamSession(resumeRequest);
      if (!result.ok) {
        deps.logMain("app-server:resume-input-failed", { id: request.id, message: result.message });
        return { ok: false, message: `Could not resume this Codex section: ${result.message}` };
      }
      if (!deps.appServer) {
        return { ok: false, message: "The Codex app-server transport is unavailable." };
      }
      return deps.appServer.sendInput(request.id, request.data, request.imagePaths);
    }

    // A Claude section whose persistent process we tore down for a mid-session
    // model switch leaves behind a resume request carrying the claudeSessionId +
    // new model. Re-spawn `claude --resume … --model …` and deliver this prompt
    // so the switch takes effect on the very next message.
    // `resumeRequest.runtime` is already narrowed to non-codex by the branch
    // above (which returns for codex), so we only gate on the switch marker.
    if (pendingClaudeResume.has(request.id) && resumeRequest) {
      pendingClaudeResume.delete(request.id);
      deps.logMain("stream-json:claude-resume-for-input", {
        id: request.id,
        claudeSessionId: resumeRequest.claudeSessionId,
        model: resumeRequest.model,
      });
      const result = deps.startStreamSession(resumeRequest);
      const resumed = deps.streamSessions.get(request.id);
      if (result.ok && resumed) {
        resumed.process.stdin.write(deps.streamPromptPayload(request.data));
        return { ok: true };
      }
      deps.logMain("stream-json:claude-resume-input-failed", {
        id: request.id,
        message: result.ok ? "No resumed stream session." : result.message,
      });
    }

    const pty = deps.sessions.get(request.id);
    deps.logMain("session:input", {
      id: request.id,
      bytes: request.data.length,
      preview: request.data.replace(/\s+/g, " ").trim(),
      hasSession: Boolean(pty),
    });
    // No transport of any kind owns this section — the normal state of every
    // section once its agent process has exited. Bring it back and deliver the
    // prompt, exactly as the desktop composer does before it writes one.
    if (!pty) {
      return restartAndDeliver(request);
    }
    pty.write(request.data);
    return { ok: true };
  }

  /**
   * Rebuild a dormant section from its persisted thread and hand it the prompt.
   *
   * Without this a prompt that arrives with no live transport is dropped, which
   * the desktop never notices (its composer restarts the section first) but the
   * phone hits constantly: any section whose process exited — i.e. every section
   * after a desktop restart — silently swallowed remote prompts.
   */
  async function restartAndDeliver(request: SessionInputRequest): Promise<SessionInputResult> {
    const stored = deps.getStoredStartRequest?.(request.id);
    if (!stored) {
      deps.logMain("session:input-dropped", { id: request.id, bytes: request.data.length });
      return { ok: false, message: "This section's agent is no longer running. Send the prompt again to restart it." };
    }

    deps.logMain("session:restart-for-input", {
      id: request.id,
      runtime: stored.runtime ?? "claude",
      claudeSessionId: stored.claudeSessionId,
      codexThreadId: stored.codexThreadId,
    });
    const started = startSession(stored);
    if (!started.ok) {
      deps.logMain("session:restart-for-input-failed", { id: request.id, message: started.message });
      return { ok: false, message: `Could not restart this section: ${started.message}` };
    }

    // Every transport registers its section synchronously (the app-server
    // manager before its first await, a stream process on spawn), so exactly one
    // of these owns the section by now. Deliver here rather than recursing —
    // one restart per prompt, never a loop.
    if (deps.appServer?.has(request.id)) {
      return deps.appServer.sendInput(request.id, request.data, request.imagePaths);
    }
    const restarted = deps.streamSessions.get(request.id);
    if (restarted) {
      restarted.process.stdin.write(deps.streamPromptPayload(request.data));
      return { ok: true };
    }
    const restartedPty = deps.sessions.get(request.id);
    if (restartedPty) {
      restartedPty.write(request.data);
      return { ok: true };
    }

    deps.logMain("session:input-dropped", { id: request.id, bytes: request.data.length });
    return { ok: false, message: "This section restarted but its agent never came up. Send the prompt again." };
  }

  /**
   * Change a running section's runtime/model/effort/permission mid-session.
   * Mirrors the desktop ModelSelector but arrives from a remote (mobile) client.
   * The switch lands on the section's next turn:
   *  - Same runtime, Codex app-server: mutate the stored overrides; the next
   *    `turn/start` re-asserts them (no thread restart).
   *  - Same runtime, Claude stream-json: rewrite the stored resume request with
   *    the new settings (keeping the resume id), tear down the live process, and
   *    let the next input resume the section with the new model.
   *  - Provider change (Claude ↔ Codex): start a FRESH thread in the other
   *    runtime — conversation context does not transfer — so the resume ids are
   *    cleared. Handy when one provider's plan hits its usage limit.
   */
  function switchSession(request: SessionSwitchRequest): void {
    const { id, runtime, model, effort, permissionMode } = request;

    const applyField = (current: string | undefined, next: string | undefined): string | undefined => {
      if (next === undefined) return current;
      const trimmed = next.trim();
      return trimmed ? trimmed : undefined;
    };

    const live = deps.streamSessions.get(id);
    const appServerLive = deps.appServer?.has(id) ?? false;
    const base = live?.request ?? deps.getStreamResumeRequest(id) ?? (appServerLive ? deps.appServer?.getRequest(id) : undefined);
    if (!base) {
      deps.logMain("session:switch-no-session", { id });
      return;
    }

    const currentRuntime = base.runtime ?? "claude";
    const nextRuntime = runtime ?? currentRuntime;
    const runtimeChanged = nextRuntime !== currentRuntime;

    // Fast path: no provider change on a live Codex app-server thread → just
    // re-assert the per-turn overrides, no restart.
    if (!runtimeChanged && appServerLive) {
      deps.logMain("app-server:switch-request", { id, model, effort, permissionMode });
      deps.appServer!.updateOverrides(id, { model, effort, permissionMode });
      return;
    }

    const updated: SessionStartRequest = runtimeChanged
      ? {
          ...base,
          runtime: nextRuntime,
          command: nextRuntime === "codex" ? "codex" : "claude",
          // A provider switch is a fresh conversation — don't carry the previous
          // runtime's model/effort, and clear both resume ids so a new thread is
          // opened.
          model: applyField(undefined, model),
          effort: applyField(undefined, effort),
          permissionMode: applyField(nextRuntime === "codex" ? "read-only" : undefined, permissionMode),
          claudeSessionId: undefined,
          codexThreadId: undefined,
        }
      : {
          ...base,
          model: applyField(base.model, model),
          effort: applyField(base.effort, effort),
          permissionMode: applyField(base.permissionMode, permissionMode),
          // Preserve conversation context: resume the same underlying thread.
          claudeSessionId: live?.state.claudeSessionId ?? base.claudeSessionId,
          codexThreadId: live?.state.codexThreadId ?? base.codexThreadId,
        };
    deps.setStreamResumeRequest(id, updated);
    deps.logMain("session:switch", {
      id,
      runtime: updated.runtime,
      runtimeChanged,
      model: updated.model,
      effort: updated.effort,
      permissionMode: updated.permissionMode,
      wasLive: Boolean(live) || appServerLive,
    });

    // The next input must resume as Claude (start a fresh stream process) unless
    // the target runtime is Codex, which re-opens its thread in sendInput.
    if (nextRuntime !== "codex") pendingClaudeResume.add(id);
    else pendingClaudeResume.delete(id);

    // Tear down whatever is currently live so the next input starts fresh with
    // the new settings.
    if (appServerLive) {
      deps.appServer!.stop(id);
    }
    if (live) {
      // Push a "ready" snapshot before killing so the phone doesn't sit on a
      // stale "working" badge — the section is idle until the next prompt.
      live.state.agentState = "waiting";
      live.state.latestModel = updated.model;
      live.state.lastEventAt = new Date().toISOString();
      deps.sendStreamSnapshot(id, live);
      live.process.kill();
      deps.streamSessions.delete(id);
      deps.refreshSleepBlocker();
    }
  }

  function stopSession(request: SessionStopRequest): void {
    if (deps.appServer?.has(request.id)) {
      deps.logMain("app-server:stop", { id: request.id });
      deps.appServer.stop(request.id);
    }

    const streamSession = deps.streamSessions.get(request.id);
    if (streamSession) {
      deps.logMain("stream-json:stop", { id: request.id });
      streamSession.process.kill();
      deps.streamSessions.delete(request.id);
    }

    deps.logMain("session:stop", { id: request.id, hasSession: deps.sessions.has(request.id) });
    deps.sessions.get(request.id)?.kill();
    deps.sessions.delete(request.id);
    deps.refreshSleepBlocker();
    deps.stopClaudeSessionDetector(request.id);
  }

  function listSessions(): string[] {
    // A freshly (re)loaded renderer only knows persisted thread state; replay
    // the live stream snapshots so it picks up the authoritative agentState.
    for (const [id, streamSession] of deps.streamSessions) {
      deps.sendStreamSnapshot(id, streamSession);
    }
    deps.appServer?.replay();
    return [...deps.sessions.keys(), ...deps.streamSessions.keys(), ...(deps.appServer?.ids() ?? [])];
  }

  function answerApproval(answer: SessionApprovalAnswer): SessionApprovalResult {
    if (!deps.appServer) {
      return { ok: false, message: "The Codex app-server transport is unavailable." };
    }
    return deps.appServer.answerApproval(answer);
  }

  return { startSession, sendInput, answerApproval, switchSession, stopSession, listSessions };
}
