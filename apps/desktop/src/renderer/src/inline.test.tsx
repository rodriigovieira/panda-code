import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BacklogCardsContext, backlogLinkId, renderInline } from "./inline";

const html = (value: string): string => renderToStaticMarkup(<>{renderInline(value)}</>);

describe("renderInline", () => {
  it("renders bold, italic, code, strikethrough and links", () => {
    expect(html("**bold**")).toBe("<strong>bold</strong>");
    expect(html("_italic_")).toBe("<em>italic</em>");
    expect(html("`code`")).toBe("<code>code</code>");
    expect(html("~~gone~~")).toBe("<del>gone</del>");
    expect(html("[label](https://ex.com)")).toBe(
      '<a href="https://ex.com" rel="noreferrer" target="_blank">label</a>',
    );
  });

  it("still bolds when a stray asterisk precedes the span (the old regex leaked the markers)", () => {
    // `*.ts` used to desync `**...**` pairing for the rest of the line, leaving
    // literal ** on screen. CommonMark pairs correctly.
    expect(html("edit *.ts then **Fixed** it")).toBe("edit *.ts then <strong>Fixed</strong> it");
  });

  it("bolds spans that contain underscores", () => {
    expect(html("**GLOBAL_MAX_QUERY_STARTS**")).toBe("<strong>GLOBAL_MAX_QUERY_STARTS</strong>");
  });

  it("nests emphasis inside bold", () => {
    expect(html("**bold _and italic_**")).toBe("<strong>bold <em>and italic</em></strong>");
  });

  it("escapes html rather than injecting it", () => {
    expect(html("a <img src=x> b")).toBe("a &lt;img src=x&gt; b");
  });

  it("keeps special characters literal inside code spans", () => {
    expect(html("`a < b && c`")).toBe("<code>a &lt; b &amp;&amp; c</code>");
  });

  it("renders a backlog link as an in-app link, not a new window", () => {
    // No target=_blank: the OS has nothing registered for `panda://`, so the
    // click is handled in the renderer.
    const rendered = html("[Fix the flake](panda://backlog/9e532a84)");
    expect(rendered).toContain('class="inline-app-link"');
    expect(rendered).not.toContain("_blank");
    expect(rendered).toContain("Fix the flake");
  });

  it("opens a link to a local markdown file in the reader, not a new window", () => {
    const rendered = html("[the plan](/Users/example/docs/plan.md)");
    expect(rendered).toContain('class="inline-app-link"');
    expect(rendered).not.toContain("_blank");
  });

  it.each([
    ["video", "/tmp/five-second pilot.mp4"],
    ["image", "/tmp/final frame.png"],
  ])("opens a local %s link in the inline media viewer, not a new window", (_kind, path) => {
    const rendered = html(`[the preview](<${path}>)`);
    expect(rendered).toContain('class="inline-app-link inline-media-link"');
    expect(rendered).toContain(`title="${path}"`);
    expect(rendered).not.toContain("_blank");
  });

  it("recognizes a file URL to a local video link", () => {
    const rendered = html("[the recording](file:///tmp/the%20recording.mov)");
    expect(rendered).toContain('class="inline-app-link inline-media-link"');
    expect(rendered).toContain('title="/tmp/the recording.mov"');
    expect(rendered).not.toContain("_blank");
  });

  it("leaves a remote markdown link as an ordinary link", () => {
    expect(html("[readme](https://ex.com/readme.md)")).toBe(
      '<a href="https://ex.com/readme.md" rel="noreferrer" target="_blank">readme</a>',
    );
  });
});

describe("card references", () => {
  const board = new Map([[12, { id: "8c2d1f00", title: "Collapse the three window readers" }]]);
  const withBoard = (value: string): string =>
    renderToStaticMarkup(
      <BacklogCardsContext.Provider value={board}>{renderInline(value)}</BacklogCardsContext.Provider>,
    );

  it("links a bare #12 when the board has that card", () => {
    const rendered = withBoard("filed as #12 for later");
    expect(rendered).toContain('class="inline-app-link inline-card-ref"');
    expect(rendered).toContain('title="Collapse the three window readers"');
    expect(rendered).toContain("#12");
  });

  it("leaves a number the board does not have as text", () => {
    // `#42` in a sentence about a pull request is the common case; a link that
    // opens nothing would be worse than no link.
    expect(withBoard("see #42")).toBe("see #42");
  });

  it("leaves colours, headings and word-internal hashes alone", () => {
    expect(withBoard("#ff0000 and #123456 and a#12")).toBe("#ff0000 and #123456 and a#12");
  });

  it("does not touch a reference inside a code span", () => {
    expect(withBoard("`#12`")).toBe("<code>#12</code>");
  });

  it("renders the number as text with no board in context", () => {
    expect(html("about #12")).toBe("about #12");
  });
});

describe("backlogLinkId", () => {
  it("takes card numbers, in the form the composer and agents write", () => {
    expect(backlogLinkId("panda://backlog/12")).toBe("12");
    expect(backlogLinkId("panda://backlog/#12")).toBe("#12");
  });

  it("takes full ids and the short prefixes agents quote", () => {
    expect(backlogLinkId("panda://backlog/9e532a84-1c5e-4c0a-9c4a-2f0b6d1f0aa1")).toBe(
      "9e532a84-1c5e-4c0a-9c4a-2f0b6d1f0aa1",
    );
    expect(backlogLinkId("panda://backlog/9e532a84")).toBe("9e532a84");
  });

  it("ignores anything that is not a backlog id", () => {
    expect(backlogLinkId("https://example.com")).toBeNull();
    expect(backlogLinkId("panda://backlog/")).toBeNull();
    expect(backlogLinkId("panda://backlog/../../etc/passwd")).toBeNull();
  });
});

describe("images an agent writes into its own message", () => {
  it("renders an absolute local image as a clickable thumbnail", () => {
    const markup = html("![the fixed card](/tmp/shot.png)");
    expect(markup).toContain('class="inline-media"');
    expect(markup).toContain('src="file:///tmp/shot.png"');
    expect(markup).toContain("the fixed card");
  });

  it("renders a local recording as a video thumbnail seeked past the first frame", () => {
    const markup = html("![the flow](/tmp/run.mp4)");
    expect(markup).toContain("<video");
    // `preload="metadata"` alone decodes nothing, so the tile would be blank.
    expect(markup).toContain("file:///tmp/run.mp4#t=0.1");
  });

  it("encodes path segments, for the angle-bracket form a path with spaces needs", () => {
    // CommonMark: a destination containing a space has to be written `<…>`. This
    // is the common case for screenshots ("Screenshot 2026-08-11 at 22.22.24.png"),
    // which is why the agent prompt spells the form out.
    expect(html("![shot](</tmp/my shots/a b.png>)")).toContain("file:///tmp/my%20shots/a%20b.png");
  });

  it("still shows the picture when the spaced path was written without the brackets", () => {
    // CommonMark stops parsing the image entirely, so this used to render as the
    // literal markup — and it is the common case, since both the browser-shot
    // directory ("Application Support") and macOS screenshot names have spaces.
    const markup = html("![drawer after](/Users/me/Library/Application Support/Panda Code/tab-1.png)");
    expect(markup).toContain('class="inline-media"');
    expect(markup).toContain("file:///Users/me/Library/Application%20Support/Panda%20Code/tab-1.png");
    expect(markup).toContain("drawer after");
  });

  it("keeps the prose around a recovered image", () => {
    const markup = html("see ![a](/tmp/my shots/a b.png) then **done**");
    expect(markup).toContain("see ");
    expect(markup).toContain("file:///tmp/my%20shots/a%20b.png");
    expect(markup).toContain("<strong>done</strong>");
  });

  it("does not recover one inside a code span", () => {
    expect(html("`![a](/tmp/a b.png)`")).toBe("<code>![a](/tmp/a b.png)</code>");
  });

  it("leaves a spaced remote or undisplayable destination as written", () => {
    // (the url half of the remote one is GFM-autolinked, as any bare url in
    // prose is — the point is that no image is loaded from it)
    expect(html("![x](https://ex.com/a b.png)")).not.toContain("inline-media");
    expect(html("![x](/tmp/a b.pdf)")).toBe("![x](/tmp/a b.pdf)");
  });

  it("takes the file:// form of the same path", () => {
    expect(html("![shot](file:///tmp/a.png)")).toContain('src="file:///tmp/a.png"');
  });

  it("leaves a remote image as its alt text, so agent output cannot make the app fetch a URL", () => {
    expect(html("![tracker](https://example.com/pixel.png)")).toBe("<span>tracker</span>");
    expect(html("![x](data:image/png;base64,AAAA)")).toBe("<span>x</span>");
  });

  it("leaves a local file we cannot display as its alt text", () => {
    expect(html("![notes](/tmp/notes.pdf)")).toBe("<span>notes</span>");
  });

  it("falls back to the file name when there is no caption", () => {
    expect(html("![](/tmp/shot.png)")).toContain("shot.png");
  });
});
