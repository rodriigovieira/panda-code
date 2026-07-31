import { describe, expect, it } from "vitest";
import {
  applyStreamJsonEvent,
  createStreamJsonState,
  isTurnSummaryItem,
  parseStreamJsonLine,
  streamRuntimeEvent,
  toolInputBody,
  toolResultBody,
} from "./stream-json";

const at = "2026-07-05T12:00:00.000Z";

describe("parseStreamJsonLine", () => {
  it("parses a valid stream-json event line", () => {
    expect(parseStreamJsonLine('{"type":"system","subtype":"init","session_id":"session-1"}')).toEqual({
      ok: true,
      event: { type: "system", subtype: "init", session_id: "session-1" },
    });
  });

  it("rejects malformed or non-object lines", () => {
    expect(parseStreamJsonLine("not-json").ok).toBe(false);
    expect(parseStreamJsonLine('"text"').ok).toBe(false);
  });
});

describe("applyStreamJsonEvent", () => {
  it("maps representative user, assistant, thinking, and usage events into conversation items", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      {
        type: "system",
        subtype: "init",
        session_id: "11111111-1111-4111-8111-111111111111",
      },
      at,
    );
    applyStreamJsonEvent(
      state,
      {
        type: "user",
        message: { role: "user", content: "Inspect the print queue" },
      },
      at,
    );
    applyStreamJsonEvent(
      state,
      {
        type: "assistant",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [
            { type: "thinking" },
            { type: "text", text: "I will check the queue now." },
          ],
          usage: { input_tokens: 10, output_tokens: 7 },
        },
      },
      at,
    );

    expect(state.claudeSessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(state.tokenUsage.totalTokens).toBe(17);
    expect(state.items).toMatchObject([
      { kind: "user", body: "Inspect the print queue" },
      { kind: "assistant", body: "I will check the queue now." },
      { kind: "system", title: "Thinking" },
    ]);
  });

  it("emits an end-of-turn stats footer with duration and per-turn tokens on result", () => {
    const started = "2026-07-05T12:00:00.000Z";
    const ended = "2026-07-05T12:00:15.000Z";
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 1200, output_tokens: 300 } } },
      started,
    );
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, ended);

    const summary = state.items.find((item) => isTurnSummaryItem(item));
    expect(summary).toBeDefined();
    // 15s wall clock; 1.5k tokens consumed this turn.
    expect(summary?.body).toBe("Worked for 15s · 1.5k tokens");
    // Anchored to the turn's final assistant message so it sorts right after it.
    expect(summary?.id).toBe("stream:msg-1:summary");
  });

  it("tracks status transitions for work, waiting, and needs-action events", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "assistant", message: { role: "assistant", content: "Working" } }, at);
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("working");

    applyStreamJsonEvent(state, { type: "result", subtype: "success", usage: { input_tokens: 2, output_tokens: 3 } }, at);
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("waiting");
    expect(state.tokenUsage.totalTokens).toBe(5);

    applyStreamJsonEvent(state, { type: "permission", subtype: "request" }, at);
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("needs_action");
  });

  it("settles to waiting when a background-Bash task never reports completion", () => {
    // Repro of the wedged spinner: Claude reuses the task_* lifecycle for a
    // fire-and-forget background shell, which has no subagent_type and never
    // gets a terminal task_updated. It must not pin the section to "working".
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "assistant", message: { role: "assistant", content: "Investigating" } }, at);
    applyStreamJsonEvent(
      state,
      { type: "system", subtype: "task_started", tool_use_id: "toolu_bg", task_id: "task_bg", description: "sleep 8; cat …" },
      at,
    );
    // A running task with no subagent_type is a background shell, not an agent —
    // it should not hold the section open on its own.
    expect(state.agentState).toBe("working");

    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, at);
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("waiting");
    // The card is flagged background — still honestly "running", but no longer
    // able to re-pin a follow-up turn to "working".
    const card = state.items.find((item) => item.kind === "agent");
    expect(card?.agent?.status).toBe("running");
    expect(card?.agent?.background).toBe(true);
  });

  it("records the output file a background shell writes to", () => {
    // A background shell streams no output at all: its tool_result is only the
    // launch acknowledgement, and the real output goes to a file. Without the
    // path the card has nothing to show, which read as "No output yet…" forever.
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      { type: "system", subtype: "task_started", tool_use_id: "toolu_sh", task_id: "b7zlif8ss", description: "Run the release" },
      at,
    );
    applyStreamJsonEvent(
      state,
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_sh",
              content:
                "Command running in background with ID: b7zlif8ss. Output is being written to: /tmp/claude-501/proj/tasks/b7zlif8ss.output. You will be notified when it completes.",
            },
          ],
        },
      },
      at,
    );

    const card = state.items.find((item) => item.kind === "agent");
    expect(card?.agent?.outputFile).toBe("/tmp/claude-501/proj/tasks/b7zlif8ss.output");
    // The acknowledgement itself is still suppressed — the card replaces it.
    expect(state.items.some((item) => item.title === "Tool result")).toBe(false);
  });

  it("takes the output file from task_notification for a shell task only", () => {
    const shell = createStreamJsonState();
    applyStreamJsonEvent(
      shell,
      { type: "system", subtype: "task_started", tool_use_id: "toolu_sh", task_id: "task_sh", description: "Build" },
      at,
    );
    applyStreamJsonEvent(
      shell,
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task_sh",
        tool_use_id: "toolu_sh",
        status: "completed",
        output_file: "/tmp/tasks/task_sh.output",
      },
      at,
    );
    expect(shell.items.find((item) => item.kind === "agent")?.agent?.outputFile).toBe("/tmp/tasks/task_sh.output");

    // A real subagent's output_file is its full JSONL transcript, which is
    // already rendered as nested children — tailing it would dump raw JSON.
    const subagent = createStreamJsonState();
    applyStreamJsonEvent(
      subagent,
      {
        type: "system",
        subtype: "task_started",
        tool_use_id: "toolu_ag",
        task_id: "task_ag",
        subagent_type: "Explore",
        description: "Research",
      },
      at,
    );
    applyStreamJsonEvent(
      subagent,
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task_ag",
        tool_use_id: "toolu_ag",
        status: "completed",
        output_file: "/tmp/tasks/task_ag.output",
      },
      at,
    );
    expect(subagent.items.find((item) => item.kind === "agent")?.agent?.outputFile).toBeUndefined();
  });

  it("keeps a run_in_background subagent readable after the spawning turn ends", () => {
    // Repro of the false "completed": the main agent launches a background
    // agent, ends its turn, and the agent keeps working for minutes. The card
    // must not claim it finished, and must keep taking task_progress updates.
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      {
        type: "system",
        subtype: "task_started",
        tool_use_id: "toolu_bg_agent",
        task_id: "task_bg_agent",
        subagent_type: "Explore",
        description: "Research the config section",
      },
      at,
    );
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, at);

    // Turn settles (no wedged spinner) but the agent is still truthfully running.
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("waiting");
    const card = () => state.items.find((item) => item.kind === "agent");
    expect(card()?.agent?.status).toBe("running");
    expect(card()?.agent?.background).toBe(true);

    // Progress heartbeats keep flowing after the turn ended.
    applyStreamJsonEvent(
      state,
      {
        type: "system",
        subtype: "task_progress",
        task_id: "task_bg_agent",
        tool_use_id: "toolu_bg_agent",
        last_tool_name: "Grep",
        usage: { total_tokens: 12_000 },
      },
      at,
    );
    expect(card()?.agent?.lastTool).toBe("Grep");
    expect(card()?.agent?.totalTokens).toBe(12_000);
    expect(card()?.body).toContain("Grep");

    // Its real terminal event lands in a later turn.
    applyStreamJsonEvent(
      state,
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task_bg_agent",
        tool_use_id: "toolu_bg_agent",
        status: "completed",
        usage: { total_tokens: 41_000, duration_ms: 180_000 },
      },
      at,
    );
    expect(card()?.agent?.status).toBe("completed");
    expect(card()?.agent?.totalTokens).toBe(41_000);
  });

  it("keeps working while a genuine subagent runs, then reaps a dropped terminal event", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "assistant", message: { role: "assistant", content: "Delegating" } }, at);
    applyStreamJsonEvent(
      state,
      {
        type: "system",
        subtype: "task_started",
        tool_use_id: "toolu_sub",
        task_id: "task_sub",
        subagent_type: "general-purpose",
        description: "Do the thing",
      },
      at,
    );

    // A mid-flight subagent whose own result reads as "waiting" must not settle
    // the parent section.
    applyStreamJsonEvent(state, { type: "result", subtype: "success", parent_tool_use_id: "toolu_sub" }, at);
    expect(state.agentState).toBe("working");

    // The main-agent result flags the subagent card as background even if its
    // terminal task_updated was dropped, so the turn still settles.
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, at);
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("waiting");
    expect(state.items.find((item) => item.kind === "agent")?.agent?.background).toBe(true);

    // A follow-up turn is not re-pinned to "working" by that flagged card.
    applyStreamJsonEvent(state, { type: "assistant", message: { role: "assistant", content: "Next" } }, at);
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, at);
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("waiting");
  });

  it("maps Codex exec JSONL events into runtime state and conversation items", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "thread.started", thread_id: "019f651a-4475-77b1-8400-781551ef354f" }, at);
    applyStreamJsonEvent(state, { type: "turn.started" }, at);
    applyStreamJsonEvent(
      state,
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "panda-codex-probe" },
      },
      at,
    );
    applyStreamJsonEvent(
      state,
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2, reasoning_output_tokens: 1 },
      },
      at,
    );

    expect(streamRuntimeEvent("thread-1", state)).toMatchObject({
      agentState: "working",
      codexThreadId: "019f651a-4475-77b1-8400-781551ef354f",
      tokenUsage: {
        inputTokens: 10,
        cacheReadInputTokens: 3,
        outputTokens: 3,
        totalTokens: 16,
      },
    });
    expect(state.items).toMatchObject([
      { kind: "assistant", title: "Codex", body: "panda-codex-probe" },
      // turn.completed closes the turn with an end-of-turn stats footer.
      { kind: "system", title: "Turn summary" },
    ]);
  });

  it("maps Codex error events into one readable system item", () => {
    const state = createStreamJsonState();
    const errorMessage =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported."}}';

    applyStreamJsonEvent(state, { type: "error", message: errorMessage }, at);
    applyStreamJsonEvent(state, { type: "turn.failed", error: { message: errorMessage } }, at);

    expect(streamRuntimeEvent("thread-1", state)).toMatchObject({ agentState: "needs_action" });
    expect(state.items).toMatchObject([
      { kind: "system", title: "Codex error", body: "The model is not supported." },
    ]);
  });

  it("coalesces partial assistant text with the same message id", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "Hel" } }, at);
    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "lo" } }, at);
    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Hello" }] } },
      at,
    );

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "assistant", body: "Hello" });
  });

  it("keeps long assistant tails that land after the old 10k cutoff", () => {
    const state = createStreamJsonState();
    const longText = `${"A".repeat(10_500)}\n\n**TL;DR:** keep this tail`;

    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: longText }] } },
      at,
    );

    expect(state.items[0]?.body).toContain("**TL;DR:** keep this tail");
  });

  it("does not duplicate the reply when delta chunk boundaries fall on whitespace", () => {
    const state = createStreamJsonState();
    const fullText = "Headline findings:\n\n1. First point \n2. Second point";

    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "Headline findings:\n\n" } }, at);
    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "1. First point \n" } }, at);
    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "2. Second point" } }, at);
    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: fullText }] } },
      at,
    );

    expect(state.items).toHaveLength(1);
    // The canonical full message supersedes the delta accumulation outright.
    // compactBody strips trailing spaces but must preserve the blank line, or
    // the finished reply visibly squeezes shut the moment streaming ends.
    expect(state.items[0]?.body).toBe("Headline findings:\n\n1. First point\n2. Second point");
  });

  it("keeps paragraph breaks when the canonical message replaces the deltas", () => {
    const state = createStreamJsonState();
    const fullText = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";

    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: fullText } }, at);
    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: fullText }] } },
      at,
    );

    expect(state.items[0]?.body).toBe(fullText);
  });

  it("keeps newlines intact while deltas accumulate", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "3." } }, at);
    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "\n" } }, at);
    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "next line" } }, at);

    expect(state.items[0]?.body).toBe("3.\nnext line");
  });

  it("ignores a per-block re-delivery of text the deltas already streamed", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "Part one." } }, at);
    applyStreamJsonEvent(state, { type: "content_block_delta", message_id: "msg-1", delta: { text: "\n\nPart two." } }, at);
    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Part two." }] } },
      at,
    );

    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.body).toBe("Part one.\n\nPart two.");
  });

  it("still appends genuinely new content blocks with the same message id", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Part one." }] } },
      at,
    );
    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Part two." }] } },
      at,
    );

    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.body).toBe("Part one.Part two.");
  });

  it("maps wrapped stream_event message deltas using the active assistant message id", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      {
        type: "stream_event",
        session_id: "11111111-1111-4111-8111-111111111111",
        event: {
          type: "message_start",
          message: {
            id: "msg-stream",
            role: "assistant",
            content: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      },
      at,
    );
    applyStreamJsonEvent(
      state,
      {
        type: "stream_event",
        session_id: "11111111-1111-4111-8111-111111111111",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
      },
      at,
    );
    applyStreamJsonEvent(
      state,
      {
        type: "stream_event",
        session_id: "11111111-1111-4111-8111-111111111111",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: " there" } },
      },
      at,
    );

    expect(streamRuntimeEvent("thread-1", state)).toMatchObject({
      currentEventType: "stream_event:content_block_delta",
      claudeSessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(state.items).toEqual([
      {
        id: "stream:msg-stream",
        kind: "assistant",
        title: "Claude",
        body: "Hi there",
        timestamp: at,
        sequence: 0,
      },
    ]);
  });

  it("renders tool calls and tool results while tracking the latest command", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      {
        type: "assistant",
        message: {
          id: "msg-tools",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "pnpm test", description: "Run tests" },
            },
          ],
        },
      },
      at,
    );
    applyStreamJsonEvent(
      state,
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Tests passed" }],
        },
      },
      at,
    );

    expect(streamRuntimeEvent("thread-1", state)).toMatchObject({
      latestTool: "Bash",
      latestCommand: "pnpm test",
    });
    expect(state.items).toMatchObject([
      { kind: "tool", title: "Bash", body: "Run tests\npnpm test" },
      { kind: "tool", title: "Tool result", body: "Tests passed" },
    ]);
  });
});

describe("toolInputBody", () => {
  it("prefers the human-readable summary fields", () => {
    expect(toolInputBody({ command: "pnpm test", description: "Run tests" })).toBe("Run tests\npnpm test");
  });

  it("renders structured inputs as a pretty-printed json code block", () => {
    expect(toolInputBody({ query: "printer", limit: 5 })).toBe('```json\n{\n  "query": "printer",\n  "limit": 5\n}\n```');
  });
});

describe("toolResultBody", () => {
  it("keeps plain-text results untouched", () => {
    expect(toolResultBody("Tests passed")).toBe("Tests passed");
  });

  it("pretty-prints results that are JSON strings", () => {
    expect(toolResultBody('{"ok":true,"count":2}')).toBe('```json\n{\n  "ok": true,\n  "count": 2\n}\n```');
  });

  it("unwraps text parts instead of dumping the content envelope", () => {
    expect(toolResultBody([{ type: "text", text: "All good" }])).toBe("All good");
  });

  it("replaces image parts with a compact placeholder", () => {
    const data = "A".repeat(8_000);
    expect(toolResultBody([{ type: "image", source: { type: "base64", media_type: "image/png", data } }])).toBe(
      "[Image image/png — ~6 KB]",
    );
  });

  it("omits embedded base64 blobs from structured results", () => {
    const body = toolResultBody([{ type: "document", source: { data: "B".repeat(4_000) } }]);
    expect(body).toContain("base64 data omitted — ~3 KB");
    expect(body).not.toContain("B".repeat(100));
  });
});
