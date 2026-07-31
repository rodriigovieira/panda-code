import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderInline } from "./inline";

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
});
