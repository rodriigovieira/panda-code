import { describe, expect, it } from "vitest";
import { docFileName, documentWordCount, isMarkdownPath, isReadableDocPath, localDocPath } from "./documents";

describe("isMarkdownPath", () => {
  it("accepts the markdown extensions agents actually write", () => {
    expect(isMarkdownPath("/tmp/PLAN.md")).toBe(true);
    expect(isMarkdownPath("/tmp/notes.markdown")).toBe(true);
    expect(isMarkdownPath("/tmp/page.MDX")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isMarkdownPath("/tmp/notes.txt")).toBe(false);
    expect(isMarkdownPath("/tmp/md")).toBe(false);
    expect(isMarkdownPath("/tmp/report.md.zip")).toBe(false);
  });
});

describe("isReadableDocPath", () => {
  it("covers plain text too — shown as source rather than rendered", () => {
    expect(isReadableDocPath("/tmp/run.log")).toBe(true);
    expect(isReadableDocPath("/tmp/data.json")).toBe(true);
    expect(isReadableDocPath("/tmp/shot.png")).toBe(false);
    expect(isReadableDocPath("/tmp/app.bin")).toBe(false);
  });
});

describe("localDocPath", () => {
  it("takes a bare absolute path", () => {
    expect(localDocPath("/Users/example/docs/plan.md")).toBe("/Users/example/docs/plan.md");
  });

  it("takes an encoded file:// URL", () => {
    expect(localDocPath("file:///Users/example/my%20docs/plan.md")).toBe("/Users/example/my docs/plan.md");
  });

  it("refuses remote URLs, relative paths and files it cannot show", () => {
    expect(localDocPath("https://example.com/readme.md")).toBeNull();
    expect(localDocPath("docs/plan.md")).toBeNull();
    expect(localDocPath("/Users/example/archive.zip")).toBeNull();
  });
});

describe("docFileName", () => {
  it("is the last segment", () => {
    expect(docFileName("/Users/example/docs/plan.md")).toBe("plan.md");
    expect(docFileName("plan.md")).toBe("plan.md");
  });
});

describe("documentWordCount", () => {
  it("counts words across whitespace and returns zero for blank text", () => {
    expect(documentWordCount("one two  three\nfour")).toBe(4);
    expect(documentWordCount("   \n ")).toBe(0);
  });
});
