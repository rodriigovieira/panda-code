import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readTailLineEntries, readTailLines } from "./tail-lines";

const dir = mkdtempSync(join(tmpdir(), "tail-lines-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("readTailLines", () => {
  it("returns the last N lines", () => {
    const path = write("small.jsonl", ["a", "b", "c", "d", "e"].join("\n"));
    expect(readTailLines(path, 3)).toEqual(["c", "d", "e"]);
  });

  it("returns every line when the file has fewer than N", () => {
    const path = write("short.jsonl", "only\n");
    expect(readTailLines(path, 25)).toEqual(["only"]);
  });

  it("handles an empty file", () => {
    expect(readTailLines(write("empty.jsonl", ""), 25)).toEqual([]);
  });

  it("reads only the tail window, not the whole file", () => {
    // 5000 lines, but a window that can only cover the last handful. The point
    // of the module: cost must not scale with the leading bulk of the file.
    const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
    const path = write("big.jsonl", lines.join("\n"));
    expect(readTailLines(path, 3, 64)).toEqual(["line-4997", "line-4998", "line-4999"]);
  });

  it("drops the fragment at the window boundary rather than emitting a partial line", () => {
    const path = write("frag.jsonl", ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"].join("\n"));
    // A window landing mid-"bbbb..." must not yield a truncated "bbb" line.
    const tail = readTailLines(path, 5, 15);
    expect(tail).toEqual(["cccccccccc"]);
    expect(tail.every((line) => !line.startsWith("b"))).toBe(true);
  });

  it("never splits a multi-byte character, even when the window cuts one", () => {
    // Each emoji is 4 bytes; a byte-aligned window will land inside one.
    const path = write("utf8.jsonl", ["😀😀😀😀", "🎉🎉🎉🎉", "done"].join("\n"));
    const tail = readTailLines(path, 5, 10);
    expect(tail).toEqual(["done"]);
    expect(tail.join("")).not.toContain("�");
  });

  it("keeps the first line when the whole file fits in the window", () => {
    const path = write("fits.jsonl", ["first", "second"].join("\n"));
    expect(readTailLines(path, 25, 1024)).toEqual(["first", "second"]);
  });

  it("ignores a trailing newline instead of returning a blank line", () => {
    const path = write("trailing.jsonl", "x\ny\n");
    expect(readTailLines(path, 25)).toEqual(["x", "y"]);
  });

  it("reports stable byte offsets for lines in a moving tail window", () => {
    const path = write("offsets.jsonl", "zero\none\ntwo\nthree");
    expect(readTailLineEntries(path, 2, 64)).toEqual([
      { text: "two", byteOffset: 9 },
      { text: "three", byteOffset: 13 },
    ]);
    expect(readTailLineEntries(path, 2, 9)).toEqual([
      { text: "three", byteOffset: 13 },
    ]);
  });
});
