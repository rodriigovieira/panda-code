import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentReader } from "./DocumentReader";
import type { DesktopApi, TextFileContents } from "../../shared/ipc";

/**
 * Static markup only, as with the other view tests: effects do not run, so what
 * is asserted is the frame the reader puts around a document — its title, its
 * path, and which doors it offers — not what a finished read looks like.
 */

const api = {
  readTextFile: () =>
    Promise.resolve<TextFileContents>({ path: "/repo/docs/plan.md", name: "plan.md", content: "# Plan", size: 6, truncated: false }),
} as unknown as DesktopApi;

function markup(path: string): string {
  return renderToStaticMarkup(
    <DocumentReader
      path={path}
      desktopApi={api}
      editorName="Cursor"
      onOpenInEditor={() => undefined}
      onReveal={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe("DocumentReader", () => {
  it("names the file and its path, and offers the editor by name", () => {
    const html = markup("/repo/docs/plan.md");
    expect(html).toContain("plan.md");
    expect(html).toContain("/repo/docs/plan.md");
    expect(html).toContain("Open in Cursor");
  });

  it("offers the rendered/source toggle for markdown", () => {
    expect(markup("/repo/docs/plan.md")).toContain("Rendered");
  });

  it("hides the toggle for a file it will only ever show as source", () => {
    expect(markup("/repo/build.log")).not.toContain("Rendered");
  });

  it("offers editing for markdown, and only for markdown", () => {
    expect(markup("/repo/docs/plan.md")).toContain(">Edit<");
    expect(markup("/repo/build.log")).not.toContain(">Edit<");
  });

  it("shows text with no file as a scratch document, without the file doors", () => {
    const html = renderToStaticMarkup(
      <DocumentReader
        text={"# Report\n\nBody."}
        title="Reply"
        desktopApi={api}
        editorName="Cursor"
        onOpenInEditor={() => undefined}
        onReveal={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("Reply");
    expect(html).toContain("not saved to a file");
    // No path behind it, so nothing to reload, reveal, or hand to an editor.
    expect(html).not.toContain("Open in Cursor");
    expect(html).not.toContain("Reveal in Finder");
    expect(html).not.toContain("Reload from disk");
    // Still a Markdown document: rendered by default, editable as a copy.
    expect(html).toContain("Rendered");
    expect(html).toContain(">Edit<");
  });

  it("carries a column-width slider, and a centred column at that width", () => {
    const html = markup("/repo/docs/plan.md");
    expect(html).toContain("Column width");
    expect(html).toContain("--doc-measure:760px");
    expect(html).toContain("doc-reader-measure");
  });

  it("shows history buttons only when the app gives it a history", () => {
    expect(markup("/repo/docs/plan.md")).not.toContain("Reader history");
    const html = renderToStaticMarkup(
      <DocumentReader
        path="/repo/docs/plan.md"
        desktopApi={api}
        onOpenInEditor={() => undefined}
        onReveal={() => undefined}
        onBack={() => undefined}
        onForward={() => undefined}
        canGoBack
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("Reader history");
    // Back is live, forward is the end of the stack.
    expect(html).toContain('title="Back (⌘[)"');
    expect(html).toMatch(/disabled[^>]*aria-label="Forward"|aria-label="Forward"[^>]*disabled/);
  });

  it("carries a text-size adjuster, starting two points above the transcript's", () => {
    const html = markup("/repo/docs/plan.md");
    expect(html).toContain("Larger text");
    expect(html).toContain("Smaller text");
    expect(html).toContain("--doc-font-size:16px");
  });
});
