import { describe, expect, it } from "vitest";
import { applyAppServerNotification, createStreamJsonState, streamRuntimeEvent, TURN_SUMMARY_TITLE } from "./stream-json";
import { codexPromptPayload } from "./agent-prompts";

const AT = "2026-07-16T00:00:00.000Z";

describe("applyAppServerNotification", () => {
  it("captures the thread id from thread/started", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(state, "thread/started", { thread: { id: "th_123" } }, AT);
    expect(state.codexThreadId).toBe("th_123");
  });

  it("marks the session working on turn/started and stamps turn accounting", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(state, "turn/started", { threadId: "th_1", turn: { id: "t1" } }, AT);
    expect(state.agentState).toBe("working");
    expect(state.turnStartedAt).toBe(Date.parse(AT));
  });

  it("streams agent message deltas then supersedes them with the completed item", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(state, "item/agentMessage/delta", { threadId: "th_1", itemId: "it_1", delta: "Hel" }, AT);
    applyAppServerNotification(state, "item/agentMessage/delta", { threadId: "th_1", itemId: "it_1", delta: "lo" }, AT);
    const assistant = state.items.filter((item) => item.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.body).toBe("Hello");

    applyAppServerNotification(
      state,
      "item/completed",
      { threadId: "th_1", item: { id: "it_1", type: "agentMessage", text: "Hello world" } },
      AT,
    );
    const after = state.items.filter((item) => item.kind === "assistant");
    expect(after).toHaveLength(1);
    expect(after[0]!.body).toBe("Hello world");
    expect(after[0]!.title).toBe("Codex");
  });

  it("strips the developer instructions wrapper from the echoed user message", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(
      state,
      "item/completed",
      {
        threadId: "th_1",
        item: {
          id: "um_1",
          type: "userMessage",
          content: [{ type: "text", text: codexPromptPayload("Inspect the print queue") }],
        },
      },
      AT,
    );
    const user = state.items.filter((item) => item.kind === "user");
    expect(user).toHaveLength(1);
    // Must match the optimistic local bubble verbatim, or the merge shows both.
    expect(user[0]!.body).toBe("Inspect the print queue");
  });

  it("renders a completed command execution with output", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(
      state,
      "item/started",
      { threadId: "th_1", item: { id: "cmd_1", type: "commandExecution", command: "ls -la" } },
      AT,
    );
    // started: indicator only, no conversation item yet.
    expect(state.items.filter((i) => i.kind === "tool")).toHaveLength(0);
    expect(state.latestCommand).toBe("ls -la");

    applyAppServerNotification(
      state,
      "item/completed",
      { threadId: "th_1", item: { id: "cmd_1", type: "commandExecution", command: "ls -la", aggregatedOutput: "file.txt", exitCode: 0 } },
      AT,
    );
    const tool = state.items.find((i) => i.kind === "tool");
    expect(tool?.title).toBe("Command");
    expect(tool?.body).toContain("ls -la");
    expect(tool?.body).toContain("file.txt");
    expect(tool?.body).toContain("exit 0");
  });

  it("renders a completed file change with per-file diffs", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(
      state,
      "item/completed",
      { threadId: "th_1", item: { id: "fc_1", type: "fileChange", status: "completed", changes: [{ path: "a.ts", kind: "update", diff: "+const x = 1;" }] } },
      AT,
    );
    const tool = state.items.find((i) => i.kind === "tool");
    expect(tool?.title).toBe("File change");
    expect(tool?.body).toContain("a.ts");
    expect(tool?.body).toContain("+const x = 1;");
  });

  it("exposes readable reasoning text when present", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(
      state,
      "item/completed",
      { threadId: "th_1", item: { id: "r_1", type: "reasoning", summary: ["Considering options"], content: [] } },
      AT,
    );
    const thinking = state.items.find((i) => i.title === "Thinking");
    expect(thinking?.body).toBe("Considering options");
  });

  it("replaces cumulative token usage from thread/tokenUsage/updated", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(
      state,
      "thread/tokenUsage/updated",
      { threadId: "th_1", tokenUsage: { total: { totalTokens: 1500, inputTokens: 1000, outputTokens: 400, cachedInputTokens: 100, reasoningOutputTokens: 50 } } },
      AT,
    );
    expect(state.tokenUsage.totalTokens).toBe(1500);
    expect(state.tokenUsage.inputTokens).toBe(1000);
    expect(state.tokenUsage.outputTokens).toBe(450); // output + reasoning
    expect(state.tokenUsage.cacheReadInputTokens).toBe(100);
  });

  it("emits a turn summary and goes idle on turn/completed", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(state, "turn/started", { threadId: "th_1", turn: { id: "t1" } }, AT);
    applyAppServerNotification(
      state,
      "thread/tokenUsage/updated",
      { threadId: "th_1", tokenUsage: { total: { totalTokens: 3400 } } },
      AT,
    );
    applyAppServerNotification(state, "turn/completed", { threadId: "th_1", turn: { id: "t1", durationMs: 12000 } }, "2026-07-16T00:00:12.000Z");
    expect(state.agentState).toBe("waiting");
    const summary = state.items.find((i) => i.title === TURN_SUMMARY_TITLE);
    expect(summary?.body).toContain("Worked for 12");
    expect(summary?.body).toContain("3.4k tokens");
  });

  it("surfaces a failed turn instead of reporting a clean finish", () => {
    // There is no `turn/failed` notification: a failure arrives as turn/completed
    // carrying status + error, which used to read as a normal idle turn.
    const state = createStreamJsonState();
    applyAppServerNotification(state, "turn/started", { threadId: "th_1", turn: { id: "t1" } }, AT);
    applyAppServerNotification(
      state,
      "turn/completed",
      { threadId: "th_1", turn: { id: "t1", status: "failed", durationMs: 400, error: { message: "usage limit reached" } } },
      AT,
    );
    expect(state.agentState).toBe("needs_action");
    expect(state.items.find((i) => i.title === "Codex error")?.body).toBe("usage limit reached");
    // No "worked for 0.4s" footer on a turn that failed — the error is the story.
    expect(state.items.some((i) => i.title === TURN_SUMMARY_TITLE)).toBe(false);
  });

  it("goes idle on an interrupted turn", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(state, "turn/started", { threadId: "th_1", turn: { id: "t1" } }, AT);
    applyAppServerNotification(
      state,
      "turn/completed",
      { threadId: "th_1", turn: { id: "t1", status: "interrupted", durationMs: 300 } },
      AT,
    );
    expect(state.agentState).toBe("waiting");
  });

  it("clears a pending approval when the server resolves the request itself", () => {
    const state = createStreamJsonState();
    state.pendingApproval = {
      promptId: "approval:sec:1",
      kind: "command",
      title: "Run a command?",
      body: "ls",
      options: [],
      requestedAt: AT,
    };
    applyAppServerNotification(state, "serverRequest/resolved", { threadId: "th_1", requestId: 7 }, AT);
    expect(state.pendingApproval).toBeUndefined();
  });

  it("carries the pending approval onto the runtime event for the relay", () => {
    const state = createStreamJsonState();
    state.agentState = "needs_action";
    state.pendingApproval = {
      promptId: "approval:sec:2",
      kind: "userInput",
      title: "Which database?",
      body: "Postgres or SQLite?",
      options: [{ id: "option:0", label: "Postgres" }],
      requestedAt: AT,
    };
    const event = streamRuntimeEvent("sec-1", state, "codex");
    expect(event.pendingApproval?.promptId).toBe("approval:sec:2");
    // Flat id for protocol v1 clients (docs/protocol.md §6).
    expect(event.pendingPromptId).toBe("approval:sec:2");
  });

  it("renders a terminal error and asks for action", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(state, "error", { threadId: "th_1", willRetry: false, error: { message: "model not supported" } }, AT);
    expect(state.agentState).toBe("needs_action");
    const err = state.items.find((i) => i.title === "Codex error");
    expect(err?.body).toBe("model not supported");
  });

  it("keeps working through a retrying error", () => {
    const state = createStreamJsonState();
    applyAppServerNotification(state, "error", { threadId: "th_1", willRetry: true, error: { message: "transient" } }, AT);
    expect(state.agentState).toBe("working");
  });
});
