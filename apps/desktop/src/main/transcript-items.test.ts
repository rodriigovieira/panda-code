import { describe, expect, it } from "vitest";
import { agentCardItemId } from "../shared/stream-json";
import {
  createTranscriptAgentCards,
  resolveTranscriptTaskNotification,
  toolItemsFromContent,
} from "./transcript-items";

// The live stream builds subagent cards from events; a reloaded session has to
// rebuild the same cards from the transcript JSONL, where the `task_*` system
// events were never persisted. Before this, the reader emitted a bare "Agent"
// tool row plus the raw "Async agent launched successfully…" tool result, so
// reopening a section made its subagents disappear as cards.

const TOOL_USE_ID = "toolu_016vFKerV1QQWWDFHMAZDSWb";
const AGENT_ID = "a2dc05edd9a660fb0";
const OUTPUT_FILE = `/private/tmp/claude-501/example/tasks/${AGENT_ID}.output`;

const assistantEntry = {
  uuid: "assistant-1",
  timestamp: "2026-08-02T12:00:00.000Z",
  message: {
    id: "msg_1",
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

const launchAckEntry = {
  uuid: "user-1",
  timestamp: "2026-08-02T12:00:01.000Z",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: TOOL_USE_ID,
        content: [
          {
            type: "text",
            text: `Async agent launched successfully.\nagentId: ${AGENT_ID} (internal ID)\nThe agent is working in the background.\noutput_file: ${OUTPUT_FILE}`,
          },
        ],
      },
    ],
  },
};

const notificationText = `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>${TOOL_USE_ID}</tool-use-id>\n<output-file>${OUTPUT_FILE}</output-file>\n<status>completed</status>\n<summary>Agent "Verify abuse-guard and waiter-call items" finished</summary>\n</task-notification>`;

describe("toolItemsFromContent — Agent/Task tool calls read back from a transcript", () => {
  it("opens an agent card instead of a plain tool row", () => {
    const cards = createTranscriptAgentCards();
    const items = toolItemsFromContent(assistantEntry, 3, cards);

    expect(items).toHaveLength(1);
    const card = items[0]!;
    expect(card.kind).toBe("agent");
    expect(card.id).toBe(agentCardItemId(TOOL_USE_ID));
    expect(card.title).toBe("Verify abuse-guard and waiter-call items");
    expect(card.agent?.subagentType).toBe("general-purpose");
    expect(card.agent?.status).toBe("running");
    expect(cards.get(TOOL_USE_ID)).toBe(card);
  });

  it("folds the async launch acknowledgement into the card instead of rendering it", () => {
    const cards = createTranscriptAgentCards();
    toolItemsFromContent(assistantEntry, 3, cards);
    const items = toolItemsFromContent(launchAckEntry, 4, cards);

    expect(items).toHaveLength(0);
    expect(cards.get(TOOL_USE_ID)?.agent.taskId).toBe(AGENT_ID);
    expect(cards.get(TOOL_USE_ID)?.agent.outputFile).toBe(OUTPUT_FILE);
  });

  it("still renders ordinary tools and their results", () => {
    const cards = createTranscriptAgentCards();
    const items = toolItemsFromContent(
      {
        uuid: "assistant-2",
        message: { id: "msg_2", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } }] },
      },
      1,
      cards,
    );

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tool");
    expect(items[0]!.title).toBe("Bash");
    expect(cards.size).toBe(0);
  });
});

describe("resolveTranscriptTaskNotification", () => {
  it("takes the card out of running when the queued notification arrives", () => {
    const cards = createTranscriptAgentCards();
    toolItemsFromContent(assistantEntry, 3, cards);
    toolItemsFromContent(launchAckEntry, 4, cards);
    resolveTranscriptTaskNotification(cards, notificationText);

    const card = cards.get(TOOL_USE_ID)!;
    expect(card.agent.status).toBe("completed");
    expect(card.agent.summary).toBe('Agent "Verify abuse-guard and waiter-call items" finished');
    expect(card.body).toContain("completed");
  });

  it("matches on the task id alone when the tool-use id is absent", () => {
    const cards = createTranscriptAgentCards();
    toolItemsFromContent(assistantEntry, 3, cards);
    toolItemsFromContent(launchAckEntry, 4, cards);
    resolveTranscriptTaskNotification(
      cards,
      `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<status>failed</status>\n</task-notification>`,
    );

    expect(cards.get(TOOL_USE_ID)!.agent.status).toBe("failed");
  });

  it("ignores ordinary prompt text", () => {
    const cards = createTranscriptAgentCards();
    toolItemsFromContent(assistantEntry, 3, cards);
    resolveTranscriptTaskNotification(cards, "please check the task notification handling");

    expect(cards.get(TOOL_USE_ID)!.agent.status).toBe("running");
  });
});
