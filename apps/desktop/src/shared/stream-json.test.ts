import { describe, expect, it } from "vitest";
import {
  applyStreamJsonEvent,
  createStreamJsonState,
  hasBackgroundWork,
  isTurnSummaryItem,
  parseCommandOutputPlan,
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

  it("keeps a transient error_during_execution result at waiting, tagged for auto-retry", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(state, { type: "result", subtype: "error_during_execution", is_error: true }, "2026-07-05T12:00:15.000Z");
    expect(state.agentState).toBe("waiting");
    expect(state.lastResultError).toEqual({ subtype: "error_during_execution" });
  });

  it("surfaces a terminal error result (max turns) as needs_action", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(state, { type: "result", subtype: "error_max_turns", is_error: true }, "2026-07-05T12:00:15.000Z");
    expect(state.agentState).toBe("needs_action");
    expect(state.lastResultError).toEqual({ subtype: "error_max_turns" });
  });

  it("clears lastResultError once a later turn succeeds", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(state, { type: "result", subtype: "error_during_execution", is_error: true }, "2026-07-05T12:00:15.000Z");
    expect(state.lastResultError).toBeDefined();
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, "2026-07-05T12:00:20.000Z");
    expect(state.lastResultError).toBeUndefined();
    expect(state.agentState).toBe("waiting");
  });

  // The failure that made the whole auto-retry path a no-op in practice: the CLI
  // reports a dropped connection as a `<synthetic>` assistant message and then
  // closes the turn as `success`, so keying only off `is_error` never fired.
  const apiErrorEvent = (text: string) => ({
    type: "assistant",
    message: { id: "msg-api-error", role: "assistant", model: "<synthetic>", content: [{ type: "text", text }] },
  });

  it("tags a mid-response connection drop for auto-retry even though the result says success", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(
      state,
      apiErrorEvent("API Error: Connection closed mid-response. The response above may be incomplete."),
      "2026-07-05T12:00:10.000Z",
    );
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, "2026-07-05T12:00:15.000Z");
    expect(state.lastResultError).toEqual({ subtype: "error_during_execution" });
    expect(state.agentState).toBe("waiting");
  });

  it("surfaces a non-retryable API error as needs_action instead of retrying it forever", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(state, apiErrorEvent("API Error: 400 prompt is too long"), "2026-07-05T12:00:10.000Z");
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, "2026-07-05T12:00:15.000Z");
    expect(state.lastResultError).toEqual({ subtype: "error_api" });
    expect(state.agentState).toBe("needs_action");
  });

  it("does not relabel the section's model as <synthetic> when an API error lands", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Working." }] } },
      "2026-07-05T12:00:05.000Z",
    );
    applyStreamJsonEvent(state, apiErrorEvent("API Error: Connection closed mid-response."), "2026-07-05T12:00:10.000Z");
    expect(state.latestModel).toBe("claude-opus-5");
  });

  it("does not carry an API error across a turn that never reached its result", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(state, apiErrorEvent("API Error: Connection closed mid-response."), "2026-07-05T12:00:10.000Z");
    // No `result` — the CLI was killed. A fresh turn starts and finishes cleanly.
    applyStreamJsonEvent(state, { type: "user", message: { role: "user", content: "next" } }, "2026-07-05T12:05:00.000Z");
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, "2026-07-05T12:05:30.000Z");
    expect(state.lastResultError).toBeUndefined();
    expect(state.agentState).toBe("waiting");
  });

  it("emits no footer for the bookkeeping turn that follows an interrupt", () => {
    // Interrupting writes the notice as a user message, which flips the state
    // back to "working" and starts a fresh turn clock; the CLI's own `result`
    // lands a heartbeat later. That turn burned nothing — a bare "Worked for
    // 0.1s" under the interrupt notice reads like a turn that broke.
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "On it." }], usage: { input_tokens: 1200, output_tokens: 300 } } },
      "2026-07-05T12:00:00.000Z",
    );
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, "2026-07-05T12:00:15.000Z");
    expect(state.items.filter((item) => isTurnSummaryItem(item))).toHaveLength(1);

    applyStreamJsonEvent(
      state,
      { type: "user", message: { role: "user", content: "[Request interrupted by user for tool use]" } },
      "2026-07-05T12:00:15.100Z",
    );
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, "2026-07-05T12:00:15.200Z");

    expect(state.items.filter((item) => isTurnSummaryItem(item))).toHaveLength(1);
  });

  it("resolves a stuck background command card when the turn is interrupted", () => {
    // A background-Bash card (no subagent_type) left "running" has nothing left
    // to resolve it once the CLI injects the interrupt marker — its process was
    // just killed, and no task_updated/task_notification is coming.
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "assistant", message: { role: "assistant", content: "Investigating" } }, at);
    applyStreamJsonEvent(
      state,
      { type: "system", subtype: "task_started", tool_use_id: "toolu_bg", task_id: "task_bg", description: "sleep 8; cat …" },
      at,
    );
    const card = state.items.find((item) => item.kind === "agent");
    expect(card?.agent?.status).toBe("running");

    applyStreamJsonEvent(
      state,
      { type: "user", message: { role: "user", content: "[Request interrupted by user for tool use]" } },
      at,
    );

    expect(card?.agent?.status).toBe("failed");
    expect(card?.agent?.summary).toBe("Interrupted");
  });

  it("counts zero tokens for a turn that burned none, instead of the session total", () => {
    // The bookkeeping turn's token delta is exactly zero, and falling back to the
    // cumulative counter there reported the whole session — a non-zero count that
    // walked straight past the guard above and rendered "Worked for 0.1s · 1.5k
    // tokens" as a second footer, under whatever assistant message came next.
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "On it." }], usage: { input_tokens: 1200, output_tokens: 300 } } },
      "2026-07-05T12:00:00.000Z",
    );
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, "2026-07-05T12:00:15.000Z");

    // A new assistant message (so the next footer would anchor elsewhere and not
    // be deduped away) that consumes nothing, then an immediate result.
    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-2", role: "assistant", content: [{ type: "text", text: "" }] } },
      "2026-07-05T12:00:15.100Z",
    );
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, "2026-07-05T12:00:15.200Z");

    const summaries = state.items.filter((item) => isTurnSummaryItem(item));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.body).toBe("Worked for 15s · 1.5k tokens");
  });

  it("still reports the whole total when the turn's start was never seen", () => {
    // Resuming mid-turn leaves no `turnStartTokens`; the cumulative counter is
    // then the only estimate available and must still be reported.
    const state = createStreamJsonState();
    state.tokenUsage.totalTokens = 1500;
    state.agentState = "waiting";

    applyStreamJsonEvent(state, { type: "result", subtype: "success", duration_ms: 9000 }, "2026-07-05T12:00:15.000Z");

    const summaries = state.items.filter((item) => isTurnSummaryItem(item));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.body).toBe("Worked for 9.0s · 1.5k tokens");
  });

  it("ignores a subagent's result so it can't rebaseline the parent turn's footer", () => {
    // A subagent ends its own turn with a `result` carrying `parent_tool_use_id`.
    // Treating it as the turn ending reset `turnStartedAt`/`turnStartTokens`, so
    // the real footer reported only the time since the last child finished — a
    // 9-minute turn rendering as "Worked for 0.1s" with no token count.
    const started = "2026-07-05T12:00:00.000Z";
    const childEnded = "2026-07-05T12:08:59.900Z";
    const ended = "2026-07-05T12:09:00.000Z";
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Sweeping." }], usage: { input_tokens: 1200, output_tokens: 300 } } },
      started,
    );
    applyStreamJsonEvent(state, { type: "result", subtype: "success", parent_tool_use_id: "toolu_child" }, childEnded);
    expect(state.items.some((item) => isTurnSummaryItem(item))).toBe(false);

    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, ended);

    const summaries = state.items.filter((item) => isTurnSummaryItem(item));
    expect(summaries).toHaveLength(1);
    // Full 9m wall clock and the whole turn's tokens, not the 0.1s sliver.
    expect(summaries[0]?.body).toBe("Worked for 9m · 1.5k tokens");
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

  it("keeps a finished section idle when a late system notice arrives", () => {
    // The CLI rescans skills/commands on disk and emits `system:commands_changed`
    // to every live session, including ones idle since their `result`. That used
    // to read as "working" and wedge the sidebar spinner forever.
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "assistant", message: { role: "assistant", content: "Done" } }, at);
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, at);
    expect(state.agentState).toBe("waiting");

    applyStreamJsonEvent(state, { type: "system", subtype: "commands_changed" }, at);
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("waiting");
  });

  it("keeps a finished section idle when a background shell reports its lifecycle", () => {
    // A turn that launches a `run_in_background` Bash gets a `command_lifecycle`
    // event milliseconds after its `result`, and more of them whenever that
    // shell later changes state. Treating those as activity wedged the section
    // at "Puzzling…" long after the agent had finished and answered.
    const state = createStreamJsonState();

    applyStreamJsonEvent(state, { type: "assistant", message: { role: "assistant", content: "Watching CI." } }, at);
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, at);
    expect(state.agentState).toBe("waiting");

    applyStreamJsonEvent(state, { type: "command_lifecycle" }, at);
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("waiting");
  });

  it("does not drop a live turn back to idle when the CLI announces its boot", () => {
    // The exec path relaunches the CLI per prompt, so `system:init` lands a beat
    // *after* the prompt is already in flight. Reporting "waiting" there killed
    // the spinner (sidebar and status bar) until the first real event — seconds
    // of a section that looks idle while the transcript already says "Thinking…".
    const state = createStreamJsonState();
    state.agentState = "working";

    applyStreamJsonEvent(state, { type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" }, at);
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("working");

    // A section that boots without a prompt still reads as idle.
    const idle = createStreamJsonState();
    applyStreamJsonEvent(idle, { type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" }, at);
    expect(streamRuntimeEvent("thread-2", idle).agentState).toBe("waiting");
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

  it("puts a foreground shell's output on its card instead of dropping it", () => {
    // Repro of the silent commit: Claude reuses the task_* lifecycle for plain
    // Bash calls, so `git commit` got an agent card, and the card registered its
    // tool_use_id as an agent — which made the tool_result get suppressed as a
    // redundant subagent echo. With no children and no output file the card then
    // read "No output yet…" while the gates' output was thrown away.
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      { type: "system", subtype: "task_started", tool_use_id: "toolu_git", task_id: "task_git", description: "Push to origin main" },
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
              tool_use_id: "toolu_git",
              content: "Enumerating objects: 42, done.\nTo github.com:acme/repo.git\n   4021a5d..9f31c0e  main -> main",
            },
          ],
        },
      },
      at,
    );

    const card = state.items.find((item) => item.kind === "agent");
    expect(card?.agent?.outputTail).toContain("main -> main");
    // Still only one place to read it — no duplicate row beside the card.
    expect(state.items.some((item) => item.title === "Tool result")).toBe(false);
  });

  it("reads a command's output sink out of its shell syntax", () => {
    // The table is the parser's contract: every case below is a form that
    // actually appears in this repo's own transcripts, and the negative ones
    // are the two mistakes a looser regex makes — treating `2>&1` as a filename
    // and treating `/dev/null` as one. Both would produce a path that exists in
    // the type system and never in the filesystem, so the card would silently
    // stay empty and look exactly like the bug this all fixes.
    const plan = (command: string) => parseCommandOutputPlan(command);

    expect(plan("pnpm build 2>&1 | tee /tmp/build.log | tail -20")).toEqual({
      file: "/tmp/build.log",
      bufferedBy: "tail",
    });
    // `2>&1` is a stream dup, not a file — the old trap for a naive redirect parse.
    expect(plan("pnpm build 2>&1").file).toBeUndefined();
    expect(plan("pnpm build > /tmp/out.log 2>&1").file).toBe("/tmp/out.log");
    expect(plan('pnpm build | tee "/tmp/with space.log"').file).toBe("/tmp/with space.log");
    expect(plan("pnpm build | tee -a /tmp/appended.log").file).toBe("/tmp/appended.log");
    // A redirect wins over tee: everything ends up in the redirect's target.
    expect(plan("pnpm build | tee /tmp/t.log > /tmp/final.log").file).toBe("/tmp/final.log");
    // /dev/null names no readable file, so tee's target is still the best tail.
    expect(plan("pnpm build | tee /tmp/t.log > /dev/null").file).toBe("/tmp/t.log");
    // `tail -f` streams; only a waiting stage counts as buffering.
    expect(plan("pnpm build & tail -f /tmp/x.log").bufferedBy).toBeUndefined();
    expect(plan("grep -c foo src | wc -l").bufferedBy).toBe("wc");
    expect(plan("pnpm build")).toEqual({ file: undefined, bufferedBy: undefined });
  });

  it("tails the file the command itself writes when a pipe swallows stdout", () => {
    // The push that started this: `| tee log | tail -20` sent 71KB to the log
    // while the CLI's own output file stayed empty for 20 minutes, so the card
    // read "No output yet…" for the whole run. The command text says where the
    // output really went; record it so the main process can tail that instead.
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_push",
              name: "Bash",
              input: {
                command: "cd /tmp/wt && git push origin HEAD:main 2>&1 | tee /tmp/push.log | tail -20",
                description: "Push to origin main",
                run_in_background: true,
              },
            },
          ],
        },
      },
      at,
    );
    applyStreamJsonEvent(
      state,
      { type: "system", subtype: "task_started", tool_use_id: "toolu_push", task_id: "t1", description: "Push to origin main" },
      at,
    );

    const agent = state.items.find((item) => item.kind === "agent")?.agent;
    expect(agent?.commandOutputFile).toBe("/tmp/push.log");
    expect(agent?.outputBufferedBy).toBe("tail");
  });

  it("resolves the output sink when task_started arrives before the tool_use", () => {
    // The two events race; the card must end up the same either way.
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      { type: "system", subtype: "task_started", tool_use_id: "toolu_b", task_id: "t2", description: "Build" },
      at,
    );
    applyStreamJsonEvent(
      state,
      {
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "pnpm build > /tmp/build.log 2>&1" } },
          ],
        },
      },
      at,
    );

    expect(state.items.find((item) => item.kind === "agent")?.agent?.commandOutputFile).toBe("/tmp/build.log");
  });

  it("leaves a real subagent's card to its nested children", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
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
      state,
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_ag", content: "Found it in src/app.ts" }],
        },
      },
      at,
    );

    expect(state.items.find((item) => item.kind === "agent")?.agent?.outputTail).toBeUndefined();
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
    expect(hasBackgroundWork(state)).toBe(false);
  });

  // The section reads as `waiting` for the whole run above — which is what the
  // reaper reads too. Without this signal it hibernates the process and the
  // background work dies with it.
  it("reports background work to the reaper for as long as the card runs", () => {
    const state = createStreamJsonState();
    expect(hasBackgroundWork(state)).toBe(false);

    applyStreamJsonEvent(
      state,
      {
        type: "system",
        subtype: "task_started",
        tool_use_id: "toolu_push",
        task_id: "task_push",
        description: "git push --progress",
      },
      at,
    );
    applyStreamJsonEvent(state, { type: "result", subtype: "success" }, at);

    // A background shell, not a subagent: the turn is over, the push is not.
    expect(streamRuntimeEvent("thread-1", state).agentState).toBe("waiting");
    expect(hasBackgroundWork(state)).toBe(true);

    applyStreamJsonEvent(
      state,
      { type: "system", subtype: "task_updated", task_id: "task_push", patch: { status: "completed" } },
      at,
    );
    expect(hasBackgroundWork(state)).toBe(false);
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

describe("synthetic user turns", () => {
  it("renders an injected skill body as a system row, not a prompt bubble", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      {
        type: "user",
        uuid: "uuid-skill",
        isSynthetic: true,
        message: {
          role: "user",
          content: [{ type: "text", text: "Base directory for this skill: /repo/.claude/skills/release\n\nRelease a project" }],
        },
      },
      at,
    );

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "system", title: "Skill" });
  });

  it("renders an unflagged task notification as a system row", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      {
        type: "user",
        uuid: "uuid-task-note",
        message: {
          role: "user",
          content:
            '<task-notification>\n<task-id>bo6swulfe</task-id>\n<summary>Background command "Install deps" completed (exit code 0)</summary>\n</task-notification>',
        },
      },
      at,
    );

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "system", title: "Task update" });
  });

  it("keeps a real prompt a user item", () => {
    const state = createStreamJsonState();

    applyStreamJsonEvent(
      state,
      { type: "user", uuid: "uuid-prompt", message: { role: "user", content: "Ship it" } },
      at,
    );

    expect(state.items[0]).toMatchObject({ kind: "user", body: "Ship it" });
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
