import { describe, expect, it } from "vitest";
import { applyEnter, renderMarkdownHighlight, sanitizeUrl } from "./markdownLive";

/**
 * The editor treats the highlighted DOM's own text as the Markdown source, so
 * the property that actually matters is round-tripping: whatever goes in comes
 * back out character for character. Everything else here is the styling that
 * makes it worth doing.
 */

/** The text of the rendered HTML, the way the editor's serializer reads it:
 * one line per `.mdl-line` block, `<br>` fillers dropped. */
function textOf(html: string): string {
  return html
    .split(/<div class="mdl-line[^"]*">/)
    .slice(1)
    .map((block) =>
      block
        .replace(/<\/div>$/, "")
        .replace(/<br>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&"),
    )
    .join("\n");
}

describe("renderMarkdownHighlight", () => {
  it("keeps every character of the source", () => {
    const source = [
      "# Heading",
      "",
      "Some **bold** and *italic* and `code` and ~~gone~~.",
      "",
      "- a list item",
      "2. a numbered one",
      "> a quote",
      "",
      "[label](https://example.com)",
      "```ts",
      "const x = 1 < 2 && 3 > 2;",
      "```",
      "---",
    ].join("\n");
    expect(textOf(renderMarkdownHighlight(source))).toBe(source);
  });

  it("styles the block while leaving its marker in the text", () => {
    const html = renderMarkdownHighlight("## Title");
    expect(html).toContain("mdl-h2");
    expect(html).toContain(">##<");
  });

  it("does not parse inline markdown inside a fence", () => {
    const html = renderMarkdownHighlight("```\n**not bold**\n```");
    expect(html).not.toContain("<strong>");
  });

  it("escapes HTML rather than rendering it", () => {
    expect(renderMarkdownHighlight("<img src=x>")).toContain("&lt;img");
  });
});

describe("sanitizeUrl", () => {
  it("keeps ordinary links and defuses script ones", () => {
    expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
    expect(sanitizeUrl("javascript:alert(1)")).toBe("#");
    expect(sanitizeUrl("java\nscript:alert(1)")).toBe("#");
  });
});

describe("applyEnter", () => {
  it("continues a list", () => {
    const result = applyEnter("- one", 5);
    expect(result.markdown).toBe("- one\n- ");
    expect(result.caret).toBe(8);
  });

  it("numbers the next item", () => {
    expect(applyEnter("3. three", 8).markdown).toBe("3. three\n4. ");
  });

  it("leaves the list on an empty item", () => {
    const result = applyEnter("- one\n- ", 8);
    expect(result.markdown).toBe("- one\n");
    expect(result.caret).toBe(6);
  });

  it("is a plain newline in prose, mid-line included", () => {
    expect(applyEnter("hello world", 5).markdown).toBe("hello\n world");
  });
});
