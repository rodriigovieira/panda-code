/**
 * A marker-preserving Markdown highlighter, for the reader's edit mode.
 *
 * Unlike `FormattedBody`'s render — which turns Markdown into prose and throws
 * the source away — this one keeps every character of the source and only
 * *styles* it: a heading is set large with its `#` still there, dimmed; `**` is
 * still on either side of the bold run. That invariant is what lets the editor
 * treat a contenteditable's own text as the Markdown source, because styling
 * never adds or removes a character and caret offsets stay meaningful.
 *
 * Formally, for any input `md`:
 *   textOf(renderMarkdownHighlight(md)), lines joined by "\n"  ===  md
 *
 * Ported from the notes editor in the PandaPDV monorepo, which is where this
 * approach was worked out; kept dependency-free so it is cheap to test.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Link URLs are rendered as text, never as an anchor — but a `javascript:` URL
 * has no business being shown as a destination either, so it degrades to `#`. */
const ALLOWED_URL_SCHEMES = new Set(["http", "https", "mailto", "tel", "file", "panda"]);

export function sanitizeUrl(url: string): string {
  const stripped = url.replace(/\s+/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(stripped);
  if (scheme && !ALLOWED_URL_SCHEMES.has(scheme[1] ?? "")) return "#";
  return url;
}

function syntax(text: string): string {
  return `<span class="mdl-syntax">${escapeHtml(text)}</span>`;
}

// Anchored (sticky) inline matchers, tried in priority order so `**` wins over
// `*`. Each one keeps its markers, so the rendered text round-trips.
const CODE_RE = /`([^`\n]+)`/y;
const BOLD_RE = /\*\*([^\n]+?)\*\*/y;
const ITALIC_RE = /\*([^*\n]+?)\*/y;
const UNDERSCORE_ITALIC_RE = /_([^_\n]+?)_/y;
const STRIKE_RE = /~~([^\n]+?)~~/y;
const LINK_RE = /\[([^\]\n]*)\]\(([^)\n]*)\)/y;

/** Highlight the inline span of a line (block marker already stripped). */
export function renderInlineHighlight(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] ?? "";

    if (ch === "`") {
      CODE_RE.lastIndex = i;
      const m = CODE_RE.exec(raw);
      if (m) {
        out += `${syntax("`")}<code class="mdl-code">${escapeHtml(m[1] ?? "")}</code>${syntax("`")}`;
        i += m[0].length;
        continue;
      }
    }

    if (ch === "*") {
      BOLD_RE.lastIndex = i;
      const bold = BOLD_RE.exec(raw);
      if (bold) {
        out += `${syntax("**")}<strong>${renderInlineHighlight(bold[1] ?? "")}</strong>${syntax("**")}`;
        i += bold[0].length;
        continue;
      }
      ITALIC_RE.lastIndex = i;
      const italic = ITALIC_RE.exec(raw);
      if (italic) {
        out += `${syntax("*")}<em>${renderInlineHighlight(italic[1] ?? "")}</em>${syntax("*")}`;
        i += italic[0].length;
        continue;
      }
    }

    if (ch === "_") {
      UNDERSCORE_ITALIC_RE.lastIndex = i;
      const italic = UNDERSCORE_ITALIC_RE.exec(raw);
      if (italic) {
        out += `${syntax("_")}<em>${renderInlineHighlight(italic[1] ?? "")}</em>${syntax("_")}`;
        i += italic[0].length;
        continue;
      }
    }

    if (ch === "~") {
      STRIKE_RE.lastIndex = i;
      const strike = STRIKE_RE.exec(raw);
      if (strike) {
        out += `${syntax("~~")}<span class="mdl-strike">${renderInlineHighlight(strike[1] ?? "")}</span>${syntax("~~")}`;
        i += strike[0].length;
        continue;
      }
    }

    if (ch === "[") {
      LINK_RE.lastIndex = i;
      const link = LINK_RE.exec(raw);
      if (link) {
        const label = link[1] ?? "";
        const url = link[2] ?? "";
        out +=
          syntax("[") +
          `<span class="mdl-link" data-href="${escapeHtml(sanitizeUrl(url))}">${escapeHtml(label)}</span>` +
          syntax("](") +
          `<span class="mdl-url">${escapeHtml(url)}</span>` +
          syntax(")");
        i += link[0].length;
        continue;
      }
    }

    out += escapeHtml(ch);
    i += 1;
  }
  return out;
}

function lineToHtml(line: string, inFence: boolean): string {
  // Inside a fence: no inline parsing, just escaped monospace text.
  if (inFence) {
    return `<div class="mdl-line mdl-code-line">${line === "" ? "<br>" : escapeHtml(line)}</div>`;
  }

  // A blank source line is the gap *between* blocks, so it is tagged: the
  // stylesheet gives it the height of a paragraph gap rather than of a line of
  // text, and uses it to decide whether a neighbouring heading needs its own
  // margin.
  if (line === "") return `<div class="mdl-line mdl-blank"><br></div>`;

  if (/^```/.test(line)) {
    return `<div class="mdl-line mdl-code-line mdl-fence">${escapeHtml(line)}</div>`;
  }

  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
    return `<div class="mdl-line mdl-hr">${syntax(line)}</div>`;
  }

  const heading = /^(#{1,6})(?=\s|$)/.exec(line);
  if (heading) {
    const hashes = heading[1] ?? "";
    const level = Math.min(hashes.length, 6);
    return `<div class="mdl-line mdl-h${level}">${syntax(hashes)}${renderInlineHighlight(line.slice(hashes.length))}</div>`;
  }

  const quote = /^(\s*>\s?)/.exec(line);
  if (quote) {
    const marker = quote[1] ?? "";
    return `<div class="mdl-line mdl-quote">${syntax(marker)}${renderInlineHighlight(line.slice(marker.length))}</div>`;
  }

  const bullet = /^(\s*[-*+]\s)/.exec(line);
  if (bullet) {
    const marker = bullet[1] ?? "";
    return `<div class="mdl-line mdl-li"><span class="mdl-bullet">${escapeHtml(marker)}</span>${renderInlineHighlight(line.slice(marker.length))}</div>`;
  }

  const numbered = /^(\s*\d+[.)]\s)/.exec(line);
  if (numbered) {
    const marker = numbered[1] ?? "";
    return `<div class="mdl-line mdl-li"><span class="mdl-bullet">${escapeHtml(marker)}</span>${renderInlineHighlight(line.slice(marker.length))}</div>`;
  }

  return `<div class="mdl-line">${renderInlineHighlight(line)}</div>`;
}

/**
 * Markdown → highlighted HTML, one `<div class="mdl-line">` per source line.
 * Joining each line div's text content with "\n" reproduces the input exactly,
 * which is the property the editor's serializer depends on.
 */
export function renderMarkdownHighlight(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  const parts: string[] = [];
  for (const line of lines) {
    const opens = !inFence && /^```/.test(line);
    const closes = inFence && /^```/.test(line);
    parts.push(lineToHtml(line, inFence && !closes));
    if (opens) inFence = true;
    else if (closes) inFence = false;
  }
  return parts.join("");
}

// ---- Enter: list continuation ---------------------------------------------

type ListMarker = {
  /** What follows the marker on this line — empty means an empty item. */
  content: string;
  /** The marker the continuation line starts with, e.g. "- " or "3. ". */
  next: string;
};

function parseListMarker(line: string): ListMarker | null {
  const unordered = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (unordered) {
    return { content: unordered[3] ?? "", next: `${unordered[1] ?? ""}${unordered[2] ?? "-"} ` };
  }
  const ordered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
  if (ordered) {
    const num = Number.parseInt(ordered[2] ?? "1", 10);
    return { content: ordered[4] ?? "", next: `${ordered[1] ?? ""}${num + 1}${ordered[3] ?? "."} ` };
  }
  return null;
}

/**
 * What pressing Enter at `caret` does to `markdown`.
 *
 * The list behaviour every editor has: inside a non-empty list item, Enter
 * continues the list; inside an empty one it drops the marker and leaves the
 * list. Anywhere else it is a plain newline.
 */
export function applyEnter(markdown: string, caret: number): { markdown: string; caret: number } {
  const offset = Math.max(0, Math.min(caret, markdown.length));
  const lineStart = markdown.lastIndexOf("\n", offset - 1) + 1;
  const nextNewline = markdown.indexOf("\n", offset);
  const lineEnd = nextNewline === -1 ? markdown.length : nextNewline;
  const marker = parseListMarker(markdown.slice(lineStart, lineEnd));

  if (marker) {
    if (marker.content.trim() === "") {
      return { markdown: markdown.slice(0, lineStart) + markdown.slice(lineEnd), caret: lineStart };
    }
    return {
      markdown: `${markdown.slice(0, offset)}\n${marker.next}${markdown.slice(offset)}`,
      caret: offset + 1 + marker.next.length,
    };
  }

  return { markdown: `${markdown.slice(0, offset)}\n${markdown.slice(offset)}`, caret: offset + 1 };
}

/** The cheatsheet under the editor. */
export const MARKDOWN_HINTS = "# Heading · **bold** · *italic* · `code` · - list · > quote · [link](url)";
