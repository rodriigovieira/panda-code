import type { ConversationItem } from "./ipc";

/**
 * Which files did *this section* write to?
 *
 * Git alone cannot answer that — a working tree holds every change from every
 * source, and a repo shared by three sections would report the same diff to all
 * three. The transcript can: every write goes through a tool call, and those
 * calls are already in the conversation as `tool` items. So the attribution
 * comes from the transcript and the line counts come from git, joined on path.
 *
 * The parsing is deliberately shape-based rather than schema-based: by the time
 * an item reaches here, `stream-json` has already rendered the tool input down
 * to a display body (see `toolInputBody` / `fileChangeBody`), so the structured
 * arguments are gone. Both renderings keep the path on its own line, which is
 * what these matchers key off.
 */

/** Claude tool names whose whole purpose is writing a file. */
const CLAUDE_WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

/** Codex renders its patches into a single "File change" item, or an apply_patch call in the raw transcript. */
const CODEX_WRITE_TOOL = "file change";
const CODEX_APPLY_PATCH_TOOL = "apply_patch";

/** Guards against a runaway transcript producing an unbounded pathspec. */
const MAX_PATHS = 400;

// `toolInputBody` falls back to a pretty-printed JSON block whenever the input
// carries no `file_path` (NotebookEdit's `notebook_path`, MCP editors, …), so
// try the structured form first — it is unambiguous where line-scanning is not.
const PATH_KEY_PATTERN = /"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/**
 * A line belonging to a unified diff rather than naming a file. Context lines
 * start with a space, which survives into the body: `compactBody` only strips
 * *trailing* horizontal whitespace.
 */
function isDiffLine(line: string): boolean {
  return /^[\s+\-@\\]/.test(line) || /^(?:diff |index |new file|deleted file|similarity index|rename )/.test(line);
}

function looksLikePath(line: string): boolean {
  if (!line || line.length > 512) {
    return false;
  }

  if (line.startsWith("```") || line.startsWith("{") || line.startsWith("}") || line.startsWith("[")) {
    return false;
  }

  // Either a real path separator, or a bare filename with an extension.
  return line.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(line);
}

function extractPaths(body: string): string[] {
  const found: string[] = [];

  PATH_KEY_PATTERN.lastIndex = 0;
  let match = PATH_KEY_PATTERN.exec(body);
  while (match) {
    const raw = match[1];
    if (raw) {
      found.push(unescapeJsonString(raw));
    }
    match = PATH_KEY_PATTERN.exec(body);
  }

  if (found.length > 0) {
    return found;
  }

  for (const line of body.split("\n")) {
    if (isDiffLine(line)) {
      continue;
    }

    const trimmed = line.trim();
    if (looksLikePath(trimmed)) {
      found.push(trimmed);
    }
  }

  return found;
}

function extractApplyPatchPaths(body: string): string[] {
  const found: string[] = [];

  for (const line of body.split("\n")) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim());
    if (match?.[1]) {
      found.push(match[1]);
      continue;
    }

    const moved = /^\*\*\* Move to: (.+)$/.exec(line.trim());
    if (moved?.[1]) {
      found.push(moved[1]);
    }
  }

  return found;
}

function isWriteTool(title: string | undefined): boolean {
  if (!title) {
    return false;
  }

  const normalized = title.trim().toLowerCase();
  return normalized === CODEX_WRITE_TOOL || normalized === CODEX_APPLY_PATCH_TOOL || CLAUDE_WRITE_TOOLS.has(normalized);
}

/**
 * Every file path this section's transcript shows a write to, first-touch
 * order, de-duplicated. Paths are returned exactly as the agent wrote them —
 * usually absolute, occasionally workspace-relative — so the caller resolves
 * them against the section's cwd.
 */
export function collectEditedPaths(items: readonly ConversationItem[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const item of items) {
    if (item.kind !== "tool" || !isWriteTool(item.title)) {
      continue;
    }

    const extracted =
      item.title?.trim().toLowerCase() === CODEX_APPLY_PATCH_TOOL ? extractApplyPatchPaths(item.body ?? "") : extractPaths(item.body ?? "");
    for (const path of extracted) {
      if (seen.has(path)) {
        continue;
      }

      seen.add(path);
      paths.push(path);
      if (paths.length >= MAX_PATHS) {
        return paths;
      }
    }
  }

  return paths;
}
