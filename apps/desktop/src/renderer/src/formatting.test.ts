import { describe, expect, it } from "vitest";
import { parseBodyBlocks, parseTaskNotification } from "./formatting";

describe("parseBodyBlocks", () => {
  it("preserves useful line breaks instead of flattening a dense paragraph", () => {
    expect(parseBodyBlocks("Good news: one thing.\nWhat already exists. The gap is here.")).toEqual([
      { type: "paragraph", text: "Good news: one thing.\nWhat already exists. The gap is here." },
    ]);
  });

  it("splits numbered recommendations into separate paragraphs", () => {
    expect(parseBodyBlocks("What I'd add, in order of value: 1. First thing\n2. Second thing")).toEqual([
      { type: "paragraph", text: "What I'd add, in order of value: 1. First thing" },
      { type: "paragraph", text: "2. Second thing" },
    ]);
  });

  it("keeps fenced code blocks separate", () => {
    expect(parseBodyBlocks("The fix:\n```ts\nconst ok = true;\n```")).toEqual([
      { type: "paragraph", text: "The fix:" },
      { type: "code", language: "ts", code: "const ok = true;" },
    ]);
  });

  it("parses ordered lists and checkbox lists", () => {
    expect(parseBodyBlocks("1. First\n2. Second\n\n- [x] Done\n- [ ] Todo")).toEqual([
      {
        type: "list",
        ordered: true,
        items: [{ text: "First" }, { text: "Second" }],
      },
      {
        type: "list",
        ordered: false,
        items: [
          { text: "Done", checked: true },
          { text: "Todo", checked: false },
        ],
      },
    ]);
  });

  it("parses blockquotes and horizontal rules", () => {
    expect(parseBodyBlocks("> Important\n> second line\n\n---\nAfter")).toEqual([
      { type: "quote", text: "Important\nsecond line" },
      { type: "rule" },
      { type: "paragraph", text: "After" },
    ]);
  });

  it("parses markdown tables into table blocks", () => {
    expect(
      parseBodyBlocks(
        "Failure window:\n| Date | Commit | What |\n|---|---|---|\n| Jul 3 | `fb1c8ee99` | refactor demand-gated subscriptions |\n| Jul 5 | `a42465d3c` | follow-up cached delivery board orders |",
      ),
    ).toEqual([
      { type: "paragraph", text: "Failure window:" },
      {
        type: "table",
        headers: ["Date", "Commit", "What"],
        rows: [
          ["Jul 3", "`fb1c8ee99`", "refactor demand-gated subscriptions"],
          ["Jul 5", "`a42465d3c`", "follow-up cached delivery board orders"],
        ],
      },
    ]);
  });

  it("keeps extra pipe characters inside the final table cell", () => {
    expect(parseBodyBlocks("| Name | Detail |\n|---|---|\n| A | left | right |")).toEqual([
      {
        type: "table",
        headers: ["Name", "Detail"],
        rows: [["A", "left | right"]],
      },
    ]);
  });

  it("renders task notifications as structured blocks", () => {
    expect(
      parseBodyBlocks(
        '<task-notification>\n<task-id>bdqti8rec</task-id>\n<summary>Monitor event: "suite results"</summary>\n<event>[1A] low-network &amp; flaky</event>\n</task-notification>',
      ),
    ).toEqual([
      {
        type: "task-notification",
        taskId: "bdqti8rec",
        summary: 'Monitor event: "suite results"',
        event: "[1A] low-network & flaky",
      },
    ]);
  });

  it("does not treat partial task tags as a notification", () => {
    expect(parseTaskNotification("<task-notification><summary>unfinished</summary>")).toBeNull();
  });
});
