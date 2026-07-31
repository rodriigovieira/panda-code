import { describe, expect, it } from "vitest";
import type { ConversationItem } from "../../shared/ipc";
import { mergeBtwItems, serializeBtwContext } from "./btw";

function user(id: string, body: string): ConversationItem {
  return { id, kind: "user", body, timestamp: "2026-07-10T00:00:00.000Z" };
}

function assistant(id: string, body: string): ConversationItem {
  return { id, kind: "assistant", title: "Claude", body, timestamp: "2026-07-10T00:00:01.000Z" };
}

const thinking: ConversationItem = {
  id: "local-thinking:t1:2026",
  kind: "assistant",
  title: "Claude",
  body: "Thinking...",
  timestamp: "2026-07-10T00:00:00.500Z",
};

describe("mergeBtwItems", () => {
  it("keeps optimistic items while only an empty running snapshot has arrived", () => {
    const optimistic = [user("btw-local:t1:2026", "why is the build failing?"), thinking];
    const merged = mergeBtwItems(optimistic, []);
    expect(merged.map((item) => item.id)).toEqual(optimistic.map((item) => item.id));
  });

  it("drops the thinking placeholder once real content streams in", () => {
    const optimistic = [user("btw-local:t1:2026", "why is the build failing?"), thinking];
    const merged = mergeBtwItems(optimistic, [assistant("stream:msg_1", "Because of a type error.")]);
    expect(merged.map((item) => item.id)).toEqual(["btw-local:t1:2026", "stream:msg_1"]);
    expect(merged.some((item) => item.id.startsWith("local-thinking:"))).toBe(false);
  });

  it("coalesces streaming updates to the same message id in place", () => {
    const first = mergeBtwItems([user("btw-local:t1:2026", "q")], [assistant("stream:msg_1", "Because")]);
    const second = mergeBtwItems(first, [assistant("stream:msg_1", "Because of a type error.")]);
    expect(second).toHaveLength(2);
    expect(second[1]?.body).toBe("Because of a type error.");
  });

  it("accumulates earlier turns before the current one (insertion order preserved)", () => {
    const turnOne = mergeBtwItems([user("btw-local:t1:a", "first?")], [assistant("stream:msg_1", "first answer")]);
    const withSecondQuestion = [...turnOne, user("btw-local:t1:b", "second?")];
    const turnTwo = mergeBtwItems(withSecondQuestion, [assistant("stream:msg_2", "second answer")]);
    expect(turnTwo.map((item) => item.id)).toEqual([
      "btw-local:t1:a",
      "stream:msg_1",
      "btw-local:t1:b",
      "stream:msg_2",
    ]);
  });
});

describe("serializeBtwContext", () => {
  const tool = (id: string, title: string, body: string): ConversationItem => ({
    id,
    kind: "tool",
    title,
    body,
    timestamp: "2026-07-10T00:00:02.000Z",
  });

  it("labels each item by speaker and preserves order, oldest first", () => {
    const transcript = serializeBtwContext([
      user("u1", "make the build pass"),
      assistant("a1", "Running the tests."),
      tool("t1", "Bash", "pnpm test"),
    ]);
    expect(transcript).toBe(
      "## User\nmake the build pass\n\n## Claude\nRunning the tests.\n\n## Bash\npnpm test",
    );
  });

  it("skips markers, empty bodies, and the optimistic thinking placeholder", () => {
    const transcript = serializeBtwContext([
      { id: "marker:1", kind: "marker", body: "New session" },
      user("u1", "   "),
      { id: "local-thinking:t1:x", kind: "assistant", title: "Claude", body: "Thinking..." },
      assistant("a1", "Done."),
    ]);
    expect(transcript).toBe("## Claude\nDone.");
  });

  it("keeps only the most recent items within the char limit, dropping whole leading blocks", () => {
    const items = [
      assistant("old", "x".repeat(80)),
      user("mid", "keep me"),
      assistant("new", "and me"),
    ];
    const transcript = serializeBtwContext(items, 40);
    expect(transcript).toContain("keep me");
    expect(transcript).toContain("and me");
    expect(transcript).not.toContain("xxxx");
    expect(transcript.length).toBeLessThanOrEqual(40);
  });

  it("hard-slices the tail when a single block exceeds the limit", () => {
    const transcript = serializeBtwContext([assistant("huge", "y".repeat(100))], 30);
    expect(transcript.length).toBe(30);
    expect(transcript.endsWith("y")).toBe(true);
  });
});
