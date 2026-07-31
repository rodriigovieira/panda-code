import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SessionStartRequest } from "../../shared/ipc";
import { codexPromptPayload } from "../../shared/agent-prompts";
import { CodexAppServerClient, type AppServerProcess } from "./appServerClient";
import { CodexAppServerSessionManager, type CodexAppServerSession } from "./appServerSession";

class FakeProcess extends EventEmitter implements AppServerProcess {
  readonly writes: string[] = [];
  killed = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: (data: string) => {
      this.writes.push(data);
    },
  };
  kill(): void {
    this.killed = true;
    this.emit("exit", null);
  }
  sent(): Array<Record<string, unknown>> {
    return this.writes.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  push(message: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
  }
  /** Answer the most recent request for `method` with `result`. */
  reply(method: string, result: unknown): void {
    const request = [...this.sent()].reverse().find((m) => m.method === method && m.id !== undefined);
    if (request) {
      this.push({ id: request.id, result });
    }
  }
}

function makeManager() {
  const proc = new FakeProcess();
  const snapshots: Array<{ id: string; agentState: string; items: number }> = [];
  const manager = new CodexAppServerSessionManager({
    createClient: (handlers) =>
      new CodexAppServerClient({
        spawn: () => proc,
        clientInfo: { name: "panda_code", title: "Panda Code", version: "1" },
        onNotification: handlers.onNotification,
        onServerRequest: handlers.onServerRequest,
        onExit: handlers.onExit,
      }),
    logMain: () => {},
    sendSnapshot: (id, session: CodexAppServerSession) => {
      snapshots.push({ id, agentState: session.state.agentState, items: session.state.items.length });
    },
  });
  return { proc, manager, snapshots };
}

const request: SessionStartRequest = {
  id: "sec_1",
  cwd: "/repo",
  command: "codex",
  runtime: "codex",
  executionMode: "stream-json",
  cols: 80,
  rows: 24,
};

function codexTextInput(text: string): Record<string, unknown> {
  return { type: "text", text: codexPromptPayload(text), text_elements: [] };
}

/** Drive the async start(): settle handshake, then thread/start, then turn/start. */
async function settleStart(proc: FakeProcess, startPromise: Promise<unknown>, threadId = "th_1", turnId = "t1") {
  await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "initialize")).toBe(true));
  proc.reply("initialize", { userAgent: "codex" });
  await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "thread/start")).toBe(true));
  proc.reply("thread/start", { thread: { id: threadId }, model: "gpt-5-codex" });
  await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "turn/start")).toBe(true));
  proc.reply("turn/start", { turn: { id: turnId } });
  await startPromise;
}

describe("CodexAppServerSessionManager", () => {
  it("starts a thread and runs a turn from a prompt", async () => {
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "hello codex");
    await settleStart(proc, startPromise);

    const threadStart = proc.sent().find((m) => m.method === "thread/start");
    expect((threadStart!.params as Record<string, unknown>).cwd).toBe("/repo");
    // Approvals are answerable now, so ask on request rather than pinning "never".
    expect((threadStart!.params as Record<string, unknown>).approvalPolicy).toBe("on-request");

    const turnStart = proc.sent().find((m) => m.method === "turn/start");
    const params = turnStart!.params as Record<string, unknown>;
    expect(params.threadId).toBe("th_1");
    expect(params.input).toEqual([codexTextInput("hello codex")]);
    expect(JSON.stringify(params.input)).toContain("**TL;DR:**");

    expect(manager.get("sec_1")?.threadId).toBe("th_1");
    expect(manager.get("sec_1")?.state.latestModel).toBe("gpt-5-codex");
  });

  it("folds streamed notifications into the section's state", async () => {
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "hi");
    await settleStart(proc, startPromise);

    proc.push({ method: "turn/started", params: { threadId: "th_1", turnId: "t1", turn: { id: "t1" } } });
    proc.push({ method: "item/agentMessage/delta", params: { threadId: "th_1", turnId: "t1", itemId: "m1", delta: "Hi there" } });
    proc.push({ method: "item/completed", params: { threadId: "th_1", turnId: "t1", item: { id: "m1", type: "agentMessage", text: "Hi there" } } });
    proc.push({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", durationMs: 900 } } });

    const session = manager.get("sec_1")!;
    expect(session.state.agentState).toBe("waiting");
    const assistant = session.state.items.filter((i) => i.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.body).toBe("Hi there");
  });

  it("buffers a prompt that races the thread opening, then runs it once ready", async () => {
    // Repro of the dropped-first-prompt bug: the renderer sends the first prompt
    // as a separate input ~ms after start(), before the async handshake +
    // thread/start finish. The section must be registered synchronously (so the
    // input routes here) and the prompt buffered until threadId is known.
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request); // no prompt on start
    expect(manager.has("sec_1")).toBe(true); // registered synchronously

    await manager.sendInput("sec_1", "raced prompt"); // arrives before thread opens
    expect(proc.sent().some((m) => m.method === "turn/start")).toBe(false); // buffered, not sent

    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "initialize")).toBe(true));
    proc.reply("initialize", { userAgent: "codex" });
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "thread/start")).toBe(true));
    proc.reply("thread/start", { thread: { id: "th_1" } });
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "turn/start")).toBe(true));
    proc.reply("turn/start", { turn: { id: "t1" } });
    await startPromise;

    const turnStart = [...proc.sent()].reverse().find((m) => m.method === "turn/start");
    expect((turnStart!.params as Record<string, unknown>).input).toEqual([codexTextInput("raced prompt")]);
  });

  it("resumes an existing thread by id", async () => {
    const { proc, manager } = makeManager();
    const resumeReq = { ...request, codexThreadId: "th_existing" };
    const startPromise = manager.start(resumeReq);

    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "initialize")).toBe(true));
    proc.reply("initialize", { userAgent: "codex" });
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "thread/resume")).toBe(true));
    proc.reply("thread/resume", { thread: { id: "th_existing" } });
    await startPromise;

    const resume = proc.sent().find((m) => m.method === "thread/resume");
    expect((resume!.params as Record<string, unknown>).threadId).toBe("th_existing");
    expect(proc.sent().some((m) => m.method === "turn/start")).toBe(false); // no prompt → no turn
    expect(manager.get("sec_1")?.threadId).toBe("th_existing");
  });

  it("buffers a prompt that races an in-flight resume instead of firing turn/start early", async () => {
    // Repro of the "thread not found" drop: on resume, threadId is pre-set from
    // request.codexThreadId, but the freshly-spawned app-server has NOT loaded
    // that thread until thread/resume completes. A prompt racing in during that
    // window must buffer, not fire turn/start (which the server would reject).
    const { proc, manager } = makeManager();
    const resumeReq = { ...request, codexThreadId: "th_existing" };
    const startPromise = manager.start(resumeReq);

    await manager.sendInput("sec_1", "Go ahead."); // arrives before resume completes
    expect(proc.sent().some((m) => m.method === "turn/start")).toBe(false); // buffered, not sent

    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "initialize")).toBe(true));
    proc.reply("initialize", { userAgent: "codex" });
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "thread/resume")).toBe(true));
    proc.reply("thread/resume", { thread: { id: "th_existing" } });
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "turn/start")).toBe(true));
    proc.reply("turn/start", { turn: { id: "t1" } });
    await startPromise;

    const turnStart = [...proc.sent()].reverse().find((m) => m.method === "turn/start")!;
    const params = turnStart.params as Record<string, unknown>;
    expect(params.threadId).toBe("th_existing");
    expect(params.input).toEqual([codexTextInput("Go ahead.")]);
  });

  it("steers the live turn instead of starting a second one", async () => {
    // Firing turn/start while a turn is running is the bug turn/steer exists to
    // fix: `expectedTurnId` is a server-side precondition on the ACTIVE turn.
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "first");
    await settleStart(proc, startPromise);

    const turnStartsBefore = proc.sent().filter((m) => m.method === "turn/start").length;
    const followUp = manager.sendInput("sec_1", "second");
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "turn/steer")).toBe(true));
    proc.reply("turn/steer", { turnId: "t1" });
    await expect(followUp).resolves.toEqual({ ok: true });

    expect(proc.sent().filter((m) => m.method === "turn/start").length).toBe(turnStartsBefore);
    const steer = [...proc.sent()].reverse().find((m) => m.method === "turn/steer")!.params as Record<string, unknown>;
    expect(steer.expectedTurnId).toBe("t1");
    expect(steer.input).toEqual([codexTextInput("second")]);
  });

  it("starts a new turn for a follow-up once the previous turn completed", async () => {
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "first");
    await settleStart(proc, startPromise);
    proc.push({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "completed", durationMs: 10 } } });

    const before = proc.sent().filter((m) => m.method === "turn/start").length;
    const followUp = manager.sendInput("sec_1", "second");
    await vi.waitFor(() => expect(proc.sent().filter((m) => m.method === "turn/start").length).toBe(before + 1));
    proc.reply("turn/start", { turn: { id: "t2" } });
    await expect(followUp).resolves.toEqual({ ok: true });

    expect(proc.sent().some((m) => m.method === "turn/steer")).toBe(false);
    const lastTurn = [...proc.sent()].reverse().find((m) => m.method === "turn/start");
    expect((lastTurn!.params as Record<string, unknown>).input).toEqual([codexTextInput("second")]);
  });

  it("falls back to a new turn when the steer loses the expectedTurnId race", async () => {
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "first");
    await settleStart(proc, startPromise);

    const followUp = manager.sendInput("sec_1", "second");
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "turn/steer")).toBe(true));
    // The turn ended between our check and the call, so the precondition fails.
    const steer = [...proc.sent()].reverse().find((m) => m.method === "turn/steer")!;
    proc.push({ id: steer.id, error: { code: -32602, message: "turn is not active" } });
    await vi.waitFor(() => expect(proc.sent().filter((m) => m.method === "turn/start").length).toBe(2));
    proc.reply("turn/start", { turn: { id: "t2" } });
    await expect(followUp).resolves.toEqual({ ok: true });
  });

  it("queues every prompt that races the thread opening and loses none", async () => {
    // The old single-slot pendingPrompt silently overwrote the first prompt.
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request);

    await manager.sendInput("sec_1", "first");
    await manager.sendInput("sec_1", "second");
    expect(proc.sent().some((m) => m.method === "turn/start")).toBe(false);

    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "initialize")).toBe(true));
    proc.reply("initialize", { userAgent: "codex" });
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "thread/start")).toBe(true));
    proc.reply("thread/start", { thread: { id: "th_1" } });
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "turn/start")).toBe(true));
    proc.reply("turn/start", { turn: { id: "t1" } });
    await startPromise;

    const turnStart = [...proc.sent()].reverse().find((m) => m.method === "turn/start")!.params as Record<string, unknown>;
    expect(turnStart.input).toEqual([codexTextInput("first"), codexTextInput("second")]);
  });

  it("reports failure instead of queueing forever when the client is gone", async () => {
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "hi");
    await settleStart(proc, startPromise);

    proc.emit("exit", 1); // app-server died
    await vi.waitFor(() => expect(manager.get("sec_1")?.state.agentState).toBe("exited"));

    // An ok:true here is what stranded the UI on "Thinking…" forever.
    await expect(manager.sendInput("sec_1", "still there?")).resolves.toMatchObject({ ok: false });
  });

  it("sends staged images as localImage inputs alongside the text", async () => {
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "hi");
    await settleStart(proc, startPromise);
    proc.push({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "completed" } } });

    const send = manager.sendInput("sec_1", "what is this?", ["/tmp/shot.png"]);
    await vi.waitFor(() => expect(proc.sent().filter((m) => m.method === "turn/start").length).toBe(2));
    proc.reply("turn/start", { turn: { id: "t2" } });
    await send;

    const turnStart = [...proc.sent()].reverse().find((m) => m.method === "turn/start")!.params as Record<string, unknown>;
    expect(turnStart.input).toEqual([codexTextInput("what is this?"), { type: "localImage", path: "/tmp/shot.png" }]);
  });

  it("pins the sandbox opt-out to approvalPolicy never", async () => {
    // Full access means the operator already said "no restrictions"; prompting
    // them for every escape would be noise.
    const { proc, manager } = makeManager();
    const startPromise = manager.start({ ...request, permissionMode: "danger-full-access" }, "hi");
    await settleStart(proc, startPromise);

    const threadStart = proc.sent().find((m) => m.method === "thread/start")!.params as Record<string, unknown>;
    expect(threadStart.sandbox).toBe("danger-full-access");
    expect(threadStart.approvalPolicy).toBe("never");
  });

  it("carries the section's model and effort on turn/start", async () => {
    const { proc, manager } = makeManager();
    const modelReq = { ...request, model: "gpt-5-codex", effort: "high" };
    const startPromise = manager.start(modelReq, "hello");
    await settleStart(proc, startPromise);

    const turnStart = proc.sent().find((m) => m.method === "turn/start");
    const params = turnStart!.params as Record<string, unknown>;
    // Effort has NO thread-level param in the protocol; turn/start is the only
    // place it can be applied, so it MUST ride every turn.
    expect(params.model).toBe("gpt-5-codex");
    expect(params.effort).toBe("high");
  });

  it("omits model/effort overrides when the section left them at the Codex default", async () => {
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "hello"); // base request: no model/effort
    await settleStart(proc, startPromise);

    const turnStart = proc.sent().find((m) => m.method === "turn/start");
    const params = turnStart!.params as Record<string, unknown>;
    expect("model" in params).toBe(false);
    expect("effort" in params).toBe(false);
  });

  it("applies a mid-session model switch: resume carries the new model and the next turn re-asserts model + effort", async () => {
    // Mirrors the renderer flow: switching a launch setting stops the section,
    // then the next prompt resumes the SAME codex thread with the new settings.
    const { proc, manager } = makeManager();
    const switchedReq = {
      ...request,
      codexThreadId: "th_existing",
      model: "gpt-5-codex-mini",
      effort: "low",
    };
    const startPromise = manager.start(switchedReq, "continue with the new model");

    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "initialize")).toBe(true));
    proc.reply("initialize", { userAgent: "codex" });
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "thread/resume")).toBe(true));
    proc.reply("thread/resume", { thread: { id: "th_existing" } });
    await vi.waitFor(() => expect(proc.sent().some((m) => m.method === "turn/start")).toBe(true));
    proc.reply("turn/start", { turn: { id: "t9" } });
    await startPromise;

    const resume = proc.sent().find((m) => m.method === "thread/resume")!.params as Record<string, unknown>;
    expect(resume.threadId).toBe("th_existing");
    expect(resume.model).toBe("gpt-5-codex-mini");

    const turnStart = proc.sent().find((m) => m.method === "turn/start")!.params as Record<string, unknown>;
    expect(turnStart.model).toBe("gpt-5-codex-mini");
    expect(turnStart.effort).toBe("low");
  });

  it("interrupts the active turn on stop and disposes the client when idle", async () => {
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "hi");
    await settleStart(proc, startPromise);

    manager.stop("sec_1");
    expect(proc.sent().some((m) => m.method === "turn/interrupt")).toBe(true);
    expect(manager.has("sec_1")).toBe(false);
    expect(proc.killed).toBe(true); // last session gone → client disposed
  });

  it("declines server requests it cannot represent so a turn cannot hang", async () => {
    const { proc, manager } = makeManager();
    const startPromise = manager.start(request, "hi");
    await settleStart(proc, startPromise);

    // Permission profiles / MCP elicitation have no UI yet. Refusing keeps the
    // turn moving, and the transcript says why.
    proc.push({ id: 99, method: "mcpServer/elicitation/request", params: { threadId: "th_1" } });
    expect(proc.sent().find((m) => m.id === 99 && "error" in m)).toBeDefined();
    expect(manager.get("sec_1")!.state.items.some((item) => item.title?.includes("can't answer"))).toBe(true);
  });

  describe("approvals", () => {
    async function pendingCommandApproval() {
      const { proc, manager, snapshots } = makeManager();
      const startPromise = manager.start(request, "run the build");
      await settleStart(proc, startPromise);
      proc.push({
        id: 77,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "th_1", turnId: "t1", itemId: "i1", command: "rm -rf build", cwd: "/repo", reason: "outside the sandbox" },
      });
      return { proc, manager, snapshots };
    }

    it("holds the request open and parks the section at needs_action", async () => {
      const { proc, manager } = await pendingCommandApproval();

      // NOT answered yet — the operator decides.
      expect(proc.sent().some((m) => m.id === 77)).toBe(false);
      const session = manager.get("sec_1")!;
      expect(session.state.agentState).toBe("needs_action");
      expect(session.state.pendingApproval).toMatchObject({
        kind: "command",
        body: "rm -rf build",
        reason: "outside the sandbox",
        cwd: "/repo",
      });
    });

    it("answers the held request with the operator's decision", async () => {
      const { proc, manager } = await pendingCommandApproval();
      const promptId = manager.get("sec_1")!.state.pendingApproval!.promptId;

      expect(manager.answerApproval({ id: "sec_1", promptId, optionId: "acceptForSession" })).toEqual({ ok: true });

      const answer = proc.sent().find((m) => m.id === 77);
      expect(answer).toMatchObject({ result: { decision: "acceptForSession" } });
      const session = manager.get("sec_1")!;
      expect(session.state.pendingApproval).toBeUndefined();
      expect(session.state.agentState).toBe("working");
    });

    it("rejects an answer for a prompt that is no longer pending", async () => {
      const { manager } = await pendingCommandApproval();

      expect(manager.answerApproval({ id: "sec_1", promptId: "approval:stale:1", optionId: "accept" })).toMatchObject({
        ok: false,
      });
    });

    it("refuses a prompt while an approval is outstanding", async () => {
      const { manager } = await pendingCommandApproval();

      await expect(manager.sendInput("sec_1", "never mind")).resolves.toMatchObject({ ok: false });
    });

    it("cancels a held request on stop so the thread is not wedged", async () => {
      const { proc, manager } = await pendingCommandApproval();

      manager.stop("sec_1");

      expect(proc.sent().find((m) => m.id === 77)).toMatchObject({ result: { decision: "cancel" } });
    });

    it("cancels an unanswered prompt when the turn ends instead of wedging the thread", async () => {
      const { proc, manager } = await pendingCommandApproval();

      proc.push({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "interrupted" } } });

      // The server is still waiting on request 77 until we say something.
      expect(proc.sent().find((m) => m.id === 77)).toMatchObject({ result: { decision: "cancel" } });
      expect(manager.get("sec_1")!.state.pendingApproval).toBeUndefined();
    });

    it("does not answer twice when the server already resolved the request", async () => {
      const { proc, manager } = await pendingCommandApproval();

      proc.push({ method: "serverRequest/resolved", params: { threadId: "th_1", requestId: 77 } });
      proc.push({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "completed" } } });

      expect(proc.sent().filter((m) => m.id === 77).length).toBe(0);
      expect(manager.get("sec_1")!.state.pendingApproval).toBeUndefined();
    });

    it("drops the prompt when the server resolves the request itself", async () => {
      const { proc, manager } = await pendingCommandApproval();

      proc.push({ method: "serverRequest/resolved", params: { threadId: "th_1", requestId: 77 } });

      expect(manager.get("sec_1")!.state.pendingApproval).toBeUndefined();
    });

    it("walks a multi-question requestUserInput one question at a time", async () => {
      const { proc, manager } = makeManager();
      const startPromise = manager.start(request, "set this up");
      await settleStart(proc, startPromise);
      proc.push({
        id: 88,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "th_1",
          turnId: "t1",
          itemId: "i2",
          questions: [
            { id: "db", header: "Database", question: "Which database?", isOther: false, isSecret: false, options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] },
            { id: "name", header: "Name", question: "Service name?", isOther: true, isSecret: false, options: null },
          ],
        },
      });

      const first = manager.get("sec_1")!.state.pendingApproval!;
      expect(first).toMatchObject({ kind: "userInput", body: "Which database?", questionCount: 2, questionIndex: 0 });
      expect(first.options.map((option) => option.label)).toEqual(["Postgres", "SQLite"]);

      // Answering the first question advances rather than replying.
      expect(manager.answerApproval({ id: "sec_1", promptId: first.promptId, optionId: first.options[1]!.id })).toEqual({ ok: true });
      expect(proc.sent().some((m) => m.id === 88)).toBe(false);
      const second = manager.get("sec_1")!.state.pendingApproval!;
      expect(second).toMatchObject({ body: "Service name?", questionIndex: 1, allowsFreeText: true });

      expect(manager.answerApproval({ id: "sec_1", promptId: second.promptId, text: "panda-api" })).toEqual({ ok: true });
      expect(proc.sent().find((m) => m.id === 88)).toMatchObject({
        result: { answers: { db: { answers: ["SQLite"] }, name: { answers: ["panda-api"] } } },
      });
      expect(manager.get("sec_1")!.state.pendingApproval).toBeUndefined();
    });
  });
});
