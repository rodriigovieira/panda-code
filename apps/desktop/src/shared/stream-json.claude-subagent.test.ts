import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCardItemId, applyStreamJsonEvent, createStreamJsonState, parseStreamJsonLine } from "./stream-json";

// Replays a REAL `claude --output-format stream-json` capture of a turn that
// delegated to a subagent (prompt: "Use the Task tool to launch a single
// general-purpose subagent whose entire job is to reply with just the word
// BANANA"). This guards the subagent-nesting reducer against protocol drift,
// since it uses actual Claude Code 2.x payloads: the task_started/task_updated/
// task_notification lifecycle events and `parent_tool_use_id` attribution.

const TOOL_USE_ID = "toolu_01WV1NRTZmPuuJP6fpqk6kgQ";
const TASK_ID = "abae5801f283d0c3d";

function replayCapture() {
  const path = fileURLToPath(new URL("./claude-subagent-capture.fixture.jsonl", import.meta.url));
  const state = createStreamJsonState();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseStreamJsonLine(line);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      applyStreamJsonEvent(state, parsed.event);
    }
  }
  return state;
}

describe("applyStreamJsonEvent — Claude subagent capture replay", () => {
  const state = replayCapture();
  const agentCards = state.items.filter((item) => item.kind === "agent");

  it("opens exactly one agent card, keyed by the spawning tool_use id", () => {
    expect(agentCards).toHaveLength(1);
    expect(agentCards[0]!.id).toBe(agentCardItemId(TOOL_USE_ID));
    expect(agentCards[0]!.title).toBe("Reply with one word");
    expect(agentCards[0]!.agent?.toolUseId).toBe(TOOL_USE_ID);
    expect(agentCards[0]!.agent?.taskId).toBe(TASK_ID);
    expect(agentCards[0]!.agent?.subagentType).toBe("general-purpose");
  });

  it("marks the agent completed with the summary token/duration accounting", () => {
    const agent = agentCards[0]!.agent!;
    expect(agent.status).toBe("completed");
    expect(agent.totalTokens).toBe(8292);
    expect(agent.durationMs).toBe(2570);
    expect(agent.summary).toContain("finished");
    // Body reflects the terminal state for renderers that only read text.
    expect(agentCards[0]!.body).toContain("general-purpose");
    expect(agentCards[0]!.body).toContain("completed");
  });

  it("attributes the subagent's own reply to its parent agent", () => {
    const banana = state.items.find((item) => item.kind === "assistant" && item.body === "BANANA");
    expect(banana).toBeDefined();
    expect(banana!.parentAgentId).toBe(TOOL_USE_ID);
  });

  it("leaves the main agent's messages unparented", () => {
    const mainMessages = state.items.filter(
      (item) => item.kind === "assistant" && item.parentAgentId === undefined && item.body !== "BANANA",
    );
    expect(mainMessages.length).toBeGreaterThan(0);
  });

  it("suppresses the redundant Agent tool_use and its tool_result echo", () => {
    expect(state.items.some((item) => item.kind === "tool" && item.title === "Agent")).toBe(false);
    expect(state.items.some((item) => item.id.includes(`${TOOL_USE_ID}:result`))).toBe(false);
  });

  it("settles to waiting once the subagent has completed", () => {
    expect(state.agentState).toBe("waiting");
  });
});
