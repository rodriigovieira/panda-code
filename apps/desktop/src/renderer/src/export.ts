import type { ConversationItem } from "../../shared/ipc";

// Serializing a section's transcript for humans: `/export` writes it to a file
// or the clipboard, and `/btw` reuses the same rendering (capped to a tail) as
// the aside's context. Both want the same thing — what the UI already shows,
// flattened to Markdown — so they share one serializer and can't drift apart.

export type ExportMeta = {
  title?: string;
  cwd?: string;
  runtime?: string;
  model?: string;
  /** ISO timestamp the export was taken; defaults to now. */
  exportedAt?: string;
};

export type SerializeOptions = {
  /** Keep only the last N characters of the body, dropping whole leading items. */
  limit?: number;
  /** Prepend a `# title` + metadata block. Off for the /btw context slice. */
  header?: ExportMeta | false;
};

// The item's own title is the best label we have (a tool's name, the runtime's
// display name), so it wins; the kind is only the fallback.
function speakerFor(item: ConversationItem): string {
  const title = item.title?.trim();
  if (title) return title;
  switch (item.kind) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "agent":
      return "Agent";
    case "system":
      return "System";
    default:
      return "Note";
  }
}

function isRenderable(item: ConversationItem): boolean {
  // Markers are UI chrome ("Steering applied"), and `local-thinking:` is the
  // optimistic placeholder that a real answer replaces — neither is transcript.
  if (item.kind === "marker") return false;
  if (item.id.startsWith("local-thinking:")) return false;
  return Boolean(item.body?.trim());
}

// One item → one Markdown block. Subagent items are indented as a blockquote so
// a nested agent's work still reads as nested once the cards are gone.
function blockFor(item: ConversationItem): string {
  const body = item.body.trim();
  const block = `## ${speakerFor(item)}\n${body}`;
  if (!item.parentAgentId) return block;
  return block
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function headerFor(meta: ExportMeta, items: ConversationItem[]): string {
  const lines = [`# ${meta.title?.trim() || "Panda Code session"}`, ""];
  const agent = [meta.runtime === "codex" ? "Codex" : "Claude Code", meta.model].filter(Boolean).join(" · ");
  lines.push(`- Exported: ${formatStamp(meta.exportedAt ?? new Date().toISOString())}`);
  if (meta.cwd) lines.push(`- Workspace: ${meta.cwd}`);
  lines.push(`- Agent: ${agent}`);
  lines.push(`- Items: ${items.length}`);
  lines.push("", "---", "");
  return lines.join("\n");
}

/**
 * Render conversation items to a Markdown transcript. With `limit`, whole
 * leading blocks are dropped until the result fits (never cutting a block
 * mid-sentence) — the newest turns are the ones worth keeping.
 */
export function serializeConversation(items: ConversationItem[], options: SerializeOptions = {}): string {
  const blocks = items.filter(isRenderable).map(blockFor);

  const { limit } = options;
  if (limit !== undefined) {
    while (blocks.length > 1 && blocks.join("\n\n").length > limit) {
      blocks.shift();
    }
  }

  let transcript = blocks.join("\n\n");
  if (limit !== undefined && transcript.length > limit) {
    // A single block can still exceed the limit; fall back to a hard tail slice.
    transcript = transcript.slice(-limit);
  }

  const header = options.header;
  if (!header) return transcript;
  return `${headerFor(header, items)}${transcript}\n`;
}

// Claude Code's naming scheme, which reads well in a Downloads folder:
// `2026-07-30-143512-fix-the-relay-reconnect-loop.md`.
function timestampSlug(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** First user prompt, normalized and clipped — the memorable half of the filename. */
export function firstPromptSummary(items: ConversationItem[]): string {
  const first = items.find((item) => item.kind === "user" && item.body.trim().length > 0);
  if (!first) return "";
  const text = first.body.replace(/\s+/g, " ").trim();
  return text.length > 50 ? `${text.slice(0, 49)}…` : text;
}

export function exportFilename(items: ConversationItem[], now: Date = new Date()): string {
  const stamp = timestampSlug(now);
  const slug = slugify(firstPromptSummary(items));
  return slug ? `${stamp}-${slug}.md` : `conversation-${stamp}.md`;
}

export type ExportCommand = { target: "clipboard" | "file"; filename?: string };

/**
 * Parse a `/export` composer line. Bare `/export` copies to the clipboard —
 * pasting the transcript somewhere is the common case, and it needs no dialog.
 * `/export file` (or `save`) opens the save dialog; `/export notes.md` writes
 * straight to that path, matching Claude Code's `[filename]` argument.
 */
export function parseExportCommand(input: string): ExportCommand | null {
  const trimmed = input.trim();
  if (!/^\/export(\s|$)/i.test(trimmed)) return null;

  const rest = trimmed.replace(/^\/export\s*/i, "").trim();
  const keyword = rest.toLowerCase();
  if (keyword === "clipboard" || keyword === "copy") return { target: "clipboard" };
  if (keyword === "file" || keyword === "save") return { target: "file" };
  return rest ? { target: "file", filename: rest } : { target: "clipboard" };
}
