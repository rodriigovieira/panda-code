import { describe, expect, it } from "vitest";
import type { ConversationItem } from "../../shared/ipc";
import { exportFilename, firstPromptSummary, parseExportCommand, serializeConversation, slugify } from "./export";

function user(id: string, body: string): ConversationItem {
  return { id, kind: "user", body, timestamp: "2026-07-10T00:00:00.000Z" };
}

function assistant(id: string, body: string): ConversationItem {
  return { id, kind: "assistant", title: "Claude", body, timestamp: "2026-07-10T00:00:01.000Z" };
}

describe("serializeConversation", () => {
  const items = [
    user("u1", "make the build pass"),
    assistant("a1", "Running the tests."),
    { id: "t1", kind: "tool", title: "Bash", body: "pnpm test" } satisfies ConversationItem,
  ];

  it("renders each item as a titled Markdown block, oldest first", () => {
    expect(serializeConversation(items)).toBe(
      "## User\nmake the build pass\n\n## Claude\nRunning the tests.\n\n## Bash\npnpm test",
    );
  });

  it("skips markers, empty bodies, and the optimistic thinking placeholder", () => {
    const transcript = serializeConversation([
      { id: "marker:1", kind: "marker", body: "New session" },
      user("u1", "   "),
      { id: "local-thinking:t1:x", kind: "assistant", title: "Claude", body: "Thinking..." },
      assistant("a1", "Done."),
    ]);
    expect(transcript).toBe("## Claude\nDone.");
  });

  it("indents subagent items as a blockquote so nesting survives the flattening", () => {
    const transcript = serializeConversation([
      { id: "c1", kind: "assistant", title: "Explore", body: "line one\n\nline two", parentAgentId: "toolu_1" },
    ]);
    expect(transcript).toBe("> ## Explore\n> line one\n>\n> line two");
  });

  it("writes a header with the section's title, workspace, and agent when asked", () => {
    const transcript = serializeConversation(items, {
      header: {
        title: "Relay reconnect",
        cwd: "/repo",
        runtime: "claude",
        model: "claude-opus-5",
        exportedAt: "2026-07-30T12:00:00.000Z",
      },
    });
    expect(transcript).toContain("# Relay reconnect");
    expect(transcript).toContain("- Workspace: /repo");
    expect(transcript).toContain("- Agent: Claude Code · claude-opus-5");
    expect(transcript).toContain("- Items: 3");
    expect(transcript).toContain("## User\nmake the build pass");
    expect(transcript.endsWith("\n")).toBe(true);
  });

  it("names Codex sections after their runtime", () => {
    const transcript = serializeConversation(items, { header: { runtime: "codex" } });
    expect(transcript).toContain("- Agent: Codex");
    expect(transcript).toContain("# Panda Code session");
  });

  it("keeps only the most recent items within the char limit, dropping whole leading blocks", () => {
    const transcript = serializeConversation(
      [assistant("old", "x".repeat(80)), user("mid", "keep me"), assistant("new", "and me")],
      { limit: 40 },
    );
    expect(transcript).toContain("keep me");
    expect(transcript).toContain("and me");
    expect(transcript).not.toContain("xxxx");
    expect(transcript.length).toBeLessThanOrEqual(40);
  });

  it("hard-slices the tail when a single block exceeds the limit", () => {
    const transcript = serializeConversation([assistant("huge", "y".repeat(100))], { limit: 30 });
    expect(transcript.length).toBe(30);
    expect(transcript.endsWith("y")).toBe(true);
  });
});

describe("exportFilename", () => {
  const at = new Date(2026, 6, 30, 14, 35, 12);

  it("stamps the time and slugs the first prompt", () => {
    const name = exportFilename([user("u1", "Fix the relay reconnect loop!"), assistant("a1", "ok")], at);
    expect(name).toBe("2026-07-30-143512-fix-the-relay-reconnect-loop.md");
  });

  it("falls back to a generic name when no prompt can be slugged", () => {
    expect(exportFilename([assistant("a1", "hello")], at)).toBe("conversation-2026-07-30-143512.md");
    expect(exportFilename([user("u1", "!!!")], at)).toBe("conversation-2026-07-30-143512.md");
  });

  it("clips a long first prompt", () => {
    const summary = firstPromptSummary([user("u1", "w".repeat(200))]);
    expect(summary).toHaveLength(50);
    expect(summary.endsWith("…")).toBe(true);
    // The ellipsis is not filename-safe, so the slug drops it.
    expect(slugify(summary)).toBe("w".repeat(49));
  });
});

describe("parseExportCommand", () => {
  it("ignores anything that is not an /export line", () => {
    expect(parseExportCommand("please export this")).toBeNull();
    expect(parseExportCommand("/exports")).toBeNull();
    expect(parseExportCommand("/btw what changed?")).toBeNull();
  });

  it("defaults to the clipboard", () => {
    expect(parseExportCommand("  /export  ")).toEqual({ target: "clipboard" });
    expect(parseExportCommand("/EXPORT")).toEqual({ target: "clipboard" });
  });

  it("routes the clipboard keywords", () => {
    expect(parseExportCommand("/export clipboard")).toEqual({ target: "clipboard" });
    expect(parseExportCommand("/export copy")).toEqual({ target: "clipboard" });
  });

  it("routes the save-dialog keywords", () => {
    expect(parseExportCommand("/export file")).toEqual({ target: "file" });
    expect(parseExportCommand("/export SAVE")).toEqual({ target: "file" });
  });

  it("treats anything else as a filename", () => {
    expect(parseExportCommand("/export notes.md")).toEqual({ target: "file", filename: "notes.md" });
    expect(parseExportCommand("/export ~/Desktop/run")).toEqual({ target: "file", filename: "~/Desktop/run" });
  });
});
