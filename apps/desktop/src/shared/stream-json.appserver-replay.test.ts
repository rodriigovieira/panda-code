import { describe, expect, it } from "vitest";
import capture from "./appserver-capture.fixture.json";
import { applyAppServerNotification, createStreamJsonState, isTurnSummaryItem, TURN_SUMMARY_TITLE } from "./stream-json";

// Replays a REAL `codex app-server` notification stream (captured from a live
// turn: "Read hello.txt and reply with only the word DONE.") through the
// reducer. This is the Phase 3 reconciliation — it guards against protocol
// drift the hand-written unit tests can't, since it uses actual payload shapes
// and ordering (item/started before item/completed, delta itemId == item.id).
// See docs/codex-app-server-migration.md.

type Note = { method: string; params: unknown };

describe("applyAppServerNotification — real capture replay", () => {
  const state = createStreamJsonState();
  for (const note of capture as Note[]) {
    applyAppServerNotification(state, note.method, note.params);
  }

  it("resolves the thread id", () => {
    expect(state.codexThreadId).toBe("019f69da-2d82-7eb2-9a6e-bc5925d867c5");
  });

  it("ends the turn idle with a stats summary", () => {
    expect(state.agentState).toBe("waiting");
    const summary = state.items.find((item) => isTurnSummaryItem(item));
    expect(summary?.title).toBe(TURN_SUMMARY_TITLE);
    expect(summary?.body).toContain("Worked for 5"); // durationMs 5742 → "5.7s"
  });

  it("coalesces the streamed delta and the completed agent message into ONE bubble", () => {
    const assistant = state.items.filter((item) => item.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.body).toBe("DONE");
    expect(assistant[0]!.title).toBe("Codex");
  });

  it("renders the user message once (started + completed dedupe by id)", () => {
    const users = state.items.filter((item) => item.kind === "user");
    expect(users).toHaveLength(1);
  });

  it("renders the command execution once, on completion, with output and exit code", () => {
    const tools = state.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.title).toBe("Command");
    expect(tools[0]!.body).toContain("panda-code phase3 probe"); // aggregatedOutput
    expect(tools[0]!.body).toContain("exit 0");
  });

  it("tracks cumulative token usage from the final update", () => {
    expect(state.tokenUsage.totalTokens).toBe(33584);
    expect(state.tokenUsage.inputTokens).toBe(33508);
    expect(state.tokenUsage.outputTokens).toBe(76); // outputTokens + reasoningOutputTokens(0)
    expect(state.tokenUsage.cacheReadInputTokens).toBe(16128);
  });
});
