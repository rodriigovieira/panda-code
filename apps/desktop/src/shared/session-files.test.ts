import { describe, expect, it } from "vitest";
import type { ConversationItem } from "./ipc";
import { collectEditedPaths } from "./session-files";

function tool(title: string, body: string, id = title): ConversationItem {
  return { id: `tool:${id}`, kind: "tool", title, body };
}

describe("collectEditedPaths", () => {
  it("takes the path from Claude Edit/Write bodies", () => {
    const items = [
      tool("Write", "/repo/src/new.ts", "a"),
      tool("Edit", "/repo/src/app.tsx", "b"),
    ];

    expect(collectEditedPaths(items)).toEqual(["/repo/src/new.ts", "/repo/src/app.tsx"]);
  });

  it("ignores tools that only read", () => {
    const items = [
      tool("Read", "/repo/src/app.tsx", "a"),
      tool("Bash", "ls -la\n/repo/src", "b"),
      tool("Grep", "/repo/src", "c"),
      tool("Tool result", "/repo/src/app.tsx", "d"),
    ];

    expect(collectEditedPaths(items)).toEqual([]);
  });

  it("pulls notebook_path out of the JSON fallback body", () => {
    const body = ["```json", "{", '  "notebook_path": "/repo/analysis.ipynb",', '  "cell_id": "abc"', "}", "```"].join("\n");

    expect(collectEditedPaths([tool("NotebookEdit", body)])).toEqual(["/repo/analysis.ipynb"]);
  });

  it("unescapes JSON string paths", () => {
    const body = '{ "file_path": "/repo/a b/c\\"d.ts" }';

    expect(collectEditedPaths([tool("Edit", body)])).toEqual(['/repo/a b/c"d.ts']);
  });

  it("reads every path out of a Codex File change body, skipping the diff", () => {
    const body = [
      "/repo/src/one.ts",
      "@@ -1,4 +1,4 @@",
      "-const a = 1;",
      "+const a = 2;",
      " const b = /repo/decoy.ts;",
      "",
      "/repo/src/two.ts",
      "@@ -9,2 +9,3 @@",
      "+added",
    ].join("\n");

    expect(collectEditedPaths([tool("File change", body)])).toEqual(["/repo/src/one.ts", "/repo/src/two.ts"]);
  });

  it("reads paths from Codex apply_patch calls", () => {
    const body = [
      "*** Begin Patch",
      "*** Update File: apps/desktop/src/main/index.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: apps/desktop/src/main/peers-entry.ts",
      "+export {};",
      "*** Delete File: apps/desktop/src/old.ts",
      "*** Update File: apps/desktop/src/temp.ts",
      "*** Move to: apps/desktop/src/new.ts",
      "*** End Patch",
    ].join("\n");

    expect(collectEditedPaths([tool("apply_patch", body)])).toEqual([
      "apps/desktop/src/main/index.ts",
      "apps/desktop/src/main/peers-entry.ts",
      "apps/desktop/src/old.ts",
      "apps/desktop/src/temp.ts",
      "apps/desktop/src/new.ts",
    ]);
  });

  it("keeps relative paths for the caller to resolve", () => {
    expect(collectEditedPaths([tool("Edit", "src/app.tsx")])).toEqual(["src/app.tsx"]);
  });

  it("de-duplicates repeat edits but keeps first-touch order", () => {
    const items = [
      tool("Edit", "/repo/b.ts", "1"),
      tool("Edit", "/repo/a.ts", "2"),
      tool("Edit", "/repo/b.ts", "3"),
    ];

    expect(collectEditedPaths(items)).toEqual(["/repo/b.ts", "/repo/a.ts"]);
  });

  it("skips bodies with nothing path-shaped in them", () => {
    expect(collectEditedPaths([tool("Edit", "the file was updated")])).toEqual([]);
  });
});
