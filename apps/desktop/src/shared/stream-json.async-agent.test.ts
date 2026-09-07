import { describe, expect, it } from "vitest";
import { agentCardItemId, applyStreamJsonEvent, createStreamJsonState } from "./stream-json";

// Reproduces a real production transcript (a acme-mono "Security review"
// section) where the Agent tool was used but the CLI never emitted a single
// `task_started`/`task_updated`/`task_notification` system event — the only
// signals were the ordinary tool_use/tool_result pair and a later
// `<task-notification>` block queued back in as a plain user turn. Before this
// fix, stream-json.ts unconditionally dropped the `Agent`/`Task` tool_use
// assuming `task_started` would open the card, so these subagents never
// appeared in the UI at all despite doing real work.

const TOOL_USE_ID = "toolu_016vFKerV1QQWWDFHMAZDSWb";
const AGENT_ID = "a2dc05edd9a660fb0";

const toolUseEvent = {
  type: "assistant",
  message: {
    id: "msg_1",
    role: "assistant",
    model: "claude-opus-5",
    content: [
      {
        type: "tool_use",
        id: TOOL_USE_ID,
        name: "Agent",
        input: {
          description: "Verify abuse-guard and waiter-call items",
          subagent_type: "general-purpose",
          prompt: "You are verifying two claimed-open backlog items...",
        },
      },
    ],
  },
};

const asyncLaunchAckEvent = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: TOOL_USE_ID,
        content: [
          {
            type: "text",
            text: `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT_ID}', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.\noutput_file: /private/tmp/claude-501/example/tasks/${AGENT_ID}.output`,
          },
        ],
      },
    ],
  },
};

const taskNotificationEvent = {
  type: "user",
  message: {
    role: "user",
    content: `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>${TOOL_USE_ID}</tool-use-id>\n<output-file>/private/tmp/claude-501/example/tasks/${AGENT_ID}.output</output-file>\n<status>completed</status>\n<summary>Agent "Verify abuse-guard and waiter-call items" finished</summary>\n<result>Both items verified. No repo files were changed.</result>\n</task-notification>`,
  },
};

describe("applyStreamJsonEvent — async Agent tool with no task_* lifecycle events", () => {
  it("opens an agent card straight from the tool_use, without waiting for task_started", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(state, toolUseEvent);

    const cards = state.items.filter((item) => item.kind === "agent");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe(agentCardItemId(TOOL_USE_ID));
    expect(cards[0]!.title).toBe("Verify abuse-guard and waiter-call items");
    expect(cards[0]!.agent?.toolUseId).toBe(TOOL_USE_ID);
    expect(cards[0]!.agent?.subagentType).toBe("general-purpose");
    expect(cards[0]!.agent?.status).toBe("running");
  });

  it("suppresses the raw async-launch tool_result and records its agent id/output file", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(state, toolUseEvent);
    applyStreamJsonEvent(state, asyncLaunchAckEvent);

    const toolRows = state.items.filter((item) => item.kind === "tool");
    expect(toolRows).toHaveLength(0);

    const card = state.items.find((item) => item.kind === "agent");
    expect(card?.agent?.taskId).toBe(AGENT_ID);
    expect(card?.agent?.outputFile).toBe(`/private/tmp/claude-501/example/tasks/${AGENT_ID}.output`);
  });

  it("resolves the card to completed from the queued <task-notification> text alone", () => {
    const state = createStreamJsonState();
    applyStreamJsonEvent(state, toolUseEvent);
    applyStreamJsonEvent(state, asyncLaunchAckEvent);
    applyStreamJsonEvent(state, taskNotificationEvent);

    const card = state.items.find((item) => item.kind === "agent");
    expect(card?.agent?.status).toBe("completed");
    expect(card?.agent?.summary).toBe('Agent "Verify abuse-guard and waiter-call items" finished');
    expect(card?.body).toContain("completed");

    // The notification itself still renders as its own "Task update" system
    // row (pre-existing behavior) — this test only asserts the card updated.
    const systemRows = state.items.filter((item) => item.kind === "system" && item.title === "Task update");
    expect(systemRows).toHaveLength(1);
  });
});
