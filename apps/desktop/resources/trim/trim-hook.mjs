#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: "Bash"). Reads the tool-call JSON on
// stdin; if a profile matches and none of the safety exclusions apply, prints
// a rewrite that routes the command through trim-run.mjs. No match, or any
// error, or an excluded shape: exit 0 with no output, so the command runs
// completely unchanged. Never exit 2 — that blocks the tool call outright.
import { readFileSync } from "node:fs";
import { matchProfile } from "./profiles.mjs";

// Conservative denylist: anything that looks like a heredoc, an explicit
// redirect/tee the agent chose deliberately, or an interactive tool. When
// unsure, leave the command alone — passthrough is always the safe answer.
const EXCLUSION_PATTERN = /<<[-~]?\s*['"]?\w|(?<!\d)>{1,2}(?!&)|\|\s*tee\b|--interactive\b|\s-it\b|\bssh\b|\bvim\b|\bnano\b|\bless\b|\bmore\b/;

function escapeForSingleQuotes(text) {
  return text.replace(/'/g, `'\\''`);
}

function main() {
  const raw = readFileSync(0, "utf8");
  const input = JSON.parse(raw);

  if (input.tool_name !== "Bash") return;

  const toolInput = input.tool_input ?? {};
  // Panda's UI shows a live tail of a background command's own stdout; buffering
  // it through trim-run to trim would leave that card blank for the whole run.
  if (toolInput.run_in_background === true) return;

  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (!command.trim()) return;
  if (EXCLUSION_PATTERN.test(command)) return;

  const profile = matchProfile(command);
  if (!profile) return;

  const runScript = process.env.PANDA_TRIM_RUN;
  if (!runScript) return;

  const logPath = process.env.PANDA_TRIM_LOG ?? "";
  const escapedCommand = escapeForSingleQuotes(command);
  const escapedRunScript = escapeForSingleQuotes(runScript);
  const envPrefix = logPath ? `PANDA_TRIM_LOG='${escapeForSingleQuotes(logPath)}' ` : "";
  const rewritten = `${envPrefix}node '${escapedRunScript}' --profile ${profile.id} -- '${escapedCommand}'`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: rewritten },
        permissionDecision: "allow",
      },
    }),
  );
}

try {
  main();
} catch {
  // Fail open: any parse or logic error means the command runs unchanged.
}
process.exit(0);
