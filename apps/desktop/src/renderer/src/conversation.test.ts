import { describe, expect, it } from "vitest";
import type { ConversationItem } from "../../shared/ipc";
import { mergeConversationItems } from "./conversation";

const localPrompt: ConversationItem = {
  id: "local:thread-1:2026-07-04T20:46:00.000Z",
  kind: "user",
  body: "hi",
  timestamp: "2026-07-04T20:46:00.000Z",
};

const localThinking: ConversationItem = {
  id: "local-thinking:thread-1:2026-07-04T20:46:00.001Z",
  kind: "assistant",
  title: "Claude",
  body: "Thinking...",
  timestamp: "2026-07-04T20:46:00.001Z",
};

describe("mergeConversationItems", () => {
  it("keeps a local prompt when Claude history has not persisted that user message yet", () => {
    const incoming: ConversationItem[] = [
      {
        id: "assistant-1",
        kind: "assistant",
        body: "You've hit your monthly spend limit",
        timestamp: "2026-07-04T20:46:01.000Z",
      },
    ];

    expect(mergeConversationItems([localPrompt], incoming)).toEqual([localPrompt, incoming[0]]);
  });

  it("keeps a local thinking indicator until Claude returns a response item", () => {
    const acceptedPrompt: ConversationItem = {
      id: "claude-user-1",
      kind: "user",
      body: "hi",
      timestamp: "2026-07-04T20:46:01.000Z",
    };

    expect(mergeConversationItems([localPrompt, localThinking], [acceptedPrompt])).toEqual([acceptedPrompt, localThinking]);
  });

  it("removes the local thinking indicator once Claude returns an assistant message", () => {
    const assistant: ConversationItem = {
      id: "assistant-1",
      kind: "assistant",
      body: "Hello",
      timestamp: "2026-07-04T20:46:03.000Z",
    };

    expect(mergeConversationItems([localPrompt, localThinking], [assistant])).toEqual([localPrompt, assistant]);
  });

  it("removes the local thinking indicator once Claude returns tool activity", () => {
    const toolCall: ConversationItem = {
      id: "tool-1",
      kind: "tool",
      title: "Bash",
      body: "rg print-queue",
      timestamp: "2026-07-04T20:46:03.000Z",
    };

    expect(mergeConversationItems([localPrompt, localThinking], [toolCall])).toEqual([localPrompt, toolCall]);
  });

  it("does not duplicate canonical items when history is reloaded", () => {
    const assistant: ConversationItem = {
      id: "assistant-1",
      kind: "assistant",
      body: "Hello",
      timestamp: "2026-07-04T20:46:03.000Z",
    };

    expect(mergeConversationItems([assistant], [assistant])).toEqual([assistant]);
  });

  it("removes the local prompt once Claude history includes the accepted prompt", () => {
    const acceptedPrompt: ConversationItem = {
      id: "claude-user-1",
      kind: "user",
      body: "hi",
      timestamp: "2026-07-04T20:46:02.000Z",
    };

    expect(mergeConversationItems([localPrompt], [acceptedPrompt])).toEqual([acceptedPrompt]);
  });

  it("removes the local prompt when a double-send was persisted as repeated text", () => {
    const acceptedPrompt: ConversationItem = {
      id: "claude-user-1",
      kind: "user",
      body: "Fix itFix it",
      timestamp: "2026-07-04T20:46:02.000Z",
    };
    const localRepeatedPrompt: ConversationItem = {
      ...localPrompt,
      body: "Fix it",
    };

    expect(mergeConversationItems([localRepeatedPrompt], [acceptedPrompt])).toEqual([acceptedPrompt]);
  });

  it("keeps multiple pending prompts in chronological order", () => {
    const secondPrompt: ConversationItem = {
      id: "local:thread-1:2026-07-04T20:47:00.000Z",
      kind: "user",
      body: "are you there?",
      timestamp: "2026-07-04T20:47:00.000Z",
    };
    const assistant: ConversationItem = {
      id: "assistant-1",
      kind: "assistant",
      body: "Working on it",
      timestamp: "2026-07-04T20:48:00.000Z",
    };

    expect(mergeConversationItems([secondPrompt, localPrompt], [assistant])).toEqual([localPrompt, secondPrompt, assistant]);
  });

  it("uses JSONL sequence as the tiebreaker when cards share a timestamp", () => {
    const timestamp = "2026-07-05T07:23:00.000Z";
    const readTool: ConversationItem = {
      id: "tool-read",
      kind: "tool",
      title: "Read",
      body: "file",
      timestamp,
      sequence: 2201,
    };
    const thinking: ConversationItem = {
      id: "thinking",
      kind: "system",
      title: "Thinking",
      body: "Thinking",
      timestamp,
      sequence: 2200,
    };
    const result: ConversationItem = {
      id: "tool-result",
      kind: "tool",
      title: "Tool result",
      body: "result",
      timestamp,
      sequence: 2202,
    };

    expect(mergeConversationItems([], [result, readTool, thinking])).toEqual([thinking, readTool, result]);
  });

  it("uses a deterministic kind order when same-time cards do not have a sequence", () => {
    const timestamp = "2026-07-05T07:23:00.000Z";
    const user: ConversationItem = {
      id: "user",
      kind: "user",
      body: "prompt",
      timestamp,
    };
    const tool: ConversationItem = {
      id: "tool",
      kind: "tool",
      body: "tool",
      timestamp,
    };
    const assistant: ConversationItem = {
      id: "assistant",
      kind: "assistant",
      body: "answer",
      timestamp,
    };

    expect(mergeConversationItems([], [assistant, tool, user])).toEqual([user, tool, assistant]);
  });

  it("marks steering as applied once activity appears after the follow-up, even before the prompt is canonical", () => {
    const marker: ConversationItem = {
      id: "local-steer:thread-1:2026-07-04T20:47:00.000Z",
      kind: "marker",
      title: "Steering sent",
      body: "Waiting for Claude Code to receive the follow-up.",
      timestamp: "2026-07-04T20:47:00.000Z",
    };
    const continuation: ConversationItem = {
      id: "local:thread-1:2026-07-04T20:47:00.000Z",
      kind: "user",
      body: "also check tests",
      timestamp: "2026-07-04T20:47:00.000Z",
    };
    const assistant: ConversationItem = {
      id: "assistant-1",
      kind: "assistant",
      body: "Still working",
      timestamp: "2026-07-04T20:47:03.000Z",
    };

    expect(mergeConversationItems([marker, continuation], [assistant])).toEqual([
      continuation,
      { ...marker, title: "Steering applied", body: "Claude started working with the follow-up." },
      assistant,
    ]);
  });

  it("keeps a steering marker as sent while no follow-up activity has arrived", () => {
    const marker: ConversationItem = {
      id: "local-steer:thread-1:2026-07-04T20:47:00.000Z",
      kind: "marker",
      title: "Steering sent",
      body: "Waiting for Claude Code to receive the follow-up.",
      timestamp: "2026-07-04T20:47:00.000Z",
    };
    const staleAssistant: ConversationItem = {
      id: "assistant-earlier",
      kind: "assistant",
      body: "From before the follow-up",
      timestamp: "2026-07-04T20:46:00.000Z",
    };

    expect(mergeConversationItems([marker], [staleAssistant])).toEqual([
      staleAssistant,
      { ...marker, title: "Steering sent", body: "Waiting for Claude Code to receive the follow-up." },
    ]);
  });

  it("marks steering as received once the continuation prompt is canonical", () => {
    const marker: ConversationItem = {
      id: "local-steer:thread-1:2026-07-04T20:47:00.000Z",
      kind: "marker",
      title: "Steering sent",
      body: "Waiting for Claude Code to receive the follow-up.",
      timestamp: "2026-07-04T20:47:00.000Z",
    };
    const acceptedPrompt: ConversationItem = {
      id: "claude-user-2",
      kind: "user",
      body: "also check tests",
      timestamp: "2026-07-04T20:47:01.000Z",
    };

    expect(mergeConversationItems([marker], [acceptedPrompt])).toEqual([
      acceptedPrompt,
      {
        ...marker,
        title: "Steering received",
        body: "Claude Code accepted the follow-up.",
        timestamp: acceptedPrompt.timestamp,
      },
    ]);
  });

  it("keeps streamed items and the pending prompt when a transcript reload merges in", () => {
    // Regression: switching away and back to a section reloads the JSONL
    // transcript. That reload must merge, not replace — a just-sent prompt
    // and freshly streamed items are not in the transcript yet.
    const streamedAssistant: ConversationItem = {
      id: "stream:msg_01ABC",
      kind: "assistant",
      title: "Claude",
      body: "Working on it",
      timestamp: "2026-07-04T20:46:05.000Z",
    };
    const olderTranscriptItem: ConversationItem = {
      id: "stream:uuid-old-1",
      kind: "user",
      body: "an earlier prompt",
      timestamp: "2026-07-04T20:40:00.000Z",
    };

    expect(mergeConversationItems([localPrompt, streamedAssistant], [olderTranscriptItem])).toEqual([
      olderTranscriptItem,
      localPrompt,
      streamedAssistant,
    ]);
  });

  it("does not duplicate items that appear in both the stream and the transcript", () => {
    // Stream and transcript share the same id scheme (same uuid / message id /
    // tool-use id), so the same message arriving from both sources is one card.
    const streamedCopy: ConversationItem = {
      id: "stream:uuid-user-1",
      kind: "user",
      body: "run the tests",
      timestamp: "2026-07-04T20:46:05.100Z",
    };
    const transcriptCopy: ConversationItem = {
      id: "stream:uuid-user-1",
      kind: "user",
      body: "run the tests",
      timestamp: "2026-07-04T20:46:05.000Z",
      sequence: 400,
    };
    const streamedTool: ConversationItem = {
      id: "stream:toolu_01XYZ:tool",
      kind: "tool",
      title: "Bash",
      body: "pnpm test",
      timestamp: "2026-07-04T20:46:06.000Z",
    };
    const transcriptTool: ConversationItem = {
      id: "stream:toolu_01XYZ:tool",
      kind: "tool",
      title: "Bash",
      body: "pnpm test",
      timestamp: "2026-07-04T20:46:06.000Z",
      sequence: 500,
    };

    const merged = mergeConversationItems([streamedCopy, streamedTool], [transcriptCopy, transcriptTool]);
    expect(merged).toHaveLength(2);
    expect(merged.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(merged.filter((item) => item.kind === "tool")).toHaveLength(1);
  });

  it("does not blank the feed when a resumed session emits an empty snapshot", () => {
    // Switching the model on a codex app-server section stops it and resumes the
    // thread with a FRESH (empty) StreamJsonState. The manager's first snapshot
    // after resume carries zero items — merging it must retain the conversation,
    // not wipe it, so mid-session model switches never lose prior content.
    const existing: ConversationItem[] = [
      {
        id: "stream:msg_prev",
        kind: "assistant",
        title: "Codex",
        body: "Answer from before the model switch",
        timestamp: "2026-07-16T04:00:00.000Z",
      },
      {
        id: "stream:cmd_prev:tool",
        kind: "tool",
        title: "Command",
        body: "ls -la",
        timestamp: "2026-07-16T04:00:01.000Z",
      },
    ];

    expect(mergeConversationItems(existing, [])).toEqual(existing);
  });

  it("keeps two identical prompts sent at different times as separate bubbles", () => {
    const firstYes: ConversationItem = {
      id: "stream:uuid-yes-1",
      kind: "user",
      body: "yes",
      timestamp: "2026-07-04T20:46:00.000Z",
    };
    const secondYes: ConversationItem = {
      id: "stream:uuid-yes-2",
      kind: "user",
      body: "yes",
      timestamp: "2026-07-04T20:50:00.000Z",
    };

    expect(mergeConversationItems([firstYes], [secondYes])).toEqual([firstYes, secondYes]);
  });

  it("keeps a fresh prompt at the bottom even when timestamp-less items are in the feed", () => {
    // Regression for the scrambled-order bug: an item without a timestamp made
    // the sort comparator inconsistent, letting whole runs of history sort
    // after the newest message.
    const noTimestampTitle: ConversationItem = {
      id: "stream:title-1",
      kind: "system",
      title: "Title",
      body: "Audit codebase",
      sequence: 110_000,
    };
    const oldHistory: ConversationItem = {
      id: "stream:uuid-old",
      kind: "assistant",
      body: "From this morning",
      timestamp: "2026-07-06T06:22:00.000Z",
      sequence: 200,
    };
    const freshPrompt: ConversationItem = {
      id: "stream:uuid-fresh",
      kind: "user",
      body: "So nothing urgent?",
      timestamp: "2026-07-06T21:29:00.000Z",
      sequence: 2,
    };

    const merged = mergeConversationItems([freshPrompt], [noTimestampTitle, oldHistory]);
    expect(merged.at(-1)).toEqual(freshPrompt);
    expect(merged[0]).toEqual(noTimestampTitle);
  });

  it("keeps the earliest timestamp when the same item is re-delivered stamped with arrival time", () => {
    const transcriptCopy: ConversationItem = {
      id: "stream:uuid-1",
      kind: "assistant",
      body: "Old answer",
      timestamp: "2026-07-06T06:00:00.000Z",
      sequence: 300,
    };
    const restampedStreamCopy: ConversationItem = {
      id: "stream:uuid-1",
      kind: "assistant",
      body: "Old answer",
      timestamp: "2026-07-06T21:31:00.000Z",
    };
    const freshPrompt: ConversationItem = {
      id: "stream:uuid-2",
      kind: "user",
      body: "follow-up",
      timestamp: "2026-07-06T21:29:00.000Z",
    };

    const merged = mergeConversationItems([transcriptCopy, freshPrompt], [restampedStreamCopy]);
    expect(merged.map((item) => item.id)).toEqual(["stream:uuid-1", "stream:uuid-2"]);
    expect(merged[0]?.timestamp).toBe("2026-07-06T06:00:00.000Z");
  });

  it("marks steering as applied once assistant activity appears after the canonical prompt", () => {
    const marker: ConversationItem = {
      id: "local-steer:thread-1:2026-07-04T20:47:00.000Z",
      kind: "marker",
      title: "Steering sent",
      body: "Waiting for Claude Code to receive the follow-up.",
      timestamp: "2026-07-04T20:47:00.000Z",
    };
    const acceptedPrompt: ConversationItem = {
      id: "claude-user-2",
      kind: "user",
      body: "also check tests",
      timestamp: "2026-07-04T20:47:01.000Z",
    };
    const tool: ConversationItem = {
      id: "tool-2",
      kind: "tool",
      title: "Bash",
      body: "pnpm test",
      timestamp: "2026-07-04T20:47:02.000Z",
    };

    expect(mergeConversationItems([marker], [tool, acceptedPrompt])).toEqual([
      acceptedPrompt,
      {
        ...marker,
        title: "Steering applied",
        body: "Claude started working with the follow-up.",
        timestamp: acceptedPrompt.timestamp,
      },
      tool,
    ]);
  });

  it("keeps Codex steering markers labeled as Codex after stream activity arrives", () => {
    const marker: ConversationItem = {
      id: "local-steer:thread-1:2026-07-04T20:47:00.000Z",
      kind: "marker",
      title: "Steering sent",
      body: "Waiting for Codex to receive the follow-up.",
      timestamp: "2026-07-04T20:47:00.000Z",
    };
    const assistant: ConversationItem = {
      id: "codex-assistant-1",
      kind: "assistant",
      title: "Codex",
      body: "Still working",
      timestamp: "2026-07-04T20:47:03.000Z",
    };

    expect(mergeConversationItems([marker], [assistant])).toEqual([
      {
        ...marker,
        title: "Steering applied",
        body: "Codex started working with the follow-up.",
      },
      assistant,
    ]);
  });

  it("removes the local thinking indicator when a terminal limit response arrives", () => {
    const limit: ConversationItem = {
      id: "assistant-limit",
      kind: "assistant",
      title: "Claude",
      body: "You've hit your monthly spend limit - raise it at claude.ai/settings/usage",
      timestamp: "2026-07-04T20:46:30.000Z",
    };

    expect(mergeConversationItems([localPrompt, localThinking], [limit])).toEqual([localPrompt, limit]);
  });
});
