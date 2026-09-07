#!/usr/bin/env node
// Invoked by the PreToolUse hook rewrite (see trim-hook.mjs) as:
//   PANDA_TRIM_LOG=<path> node trim-run.mjs --profile <id> -- '<original command>'
//
// Runs the original command unchanged through the shell, captures its
// stdout/stderr, and only *replaces* what reaches the agent when the command
// succeeded and a profile matched — the "only trim on success, fail open on
// any error" rules live here, not in the profile functions.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { findProfile, capOutput } from "./profiles.mjs";

function parseArgs(argv) {
  const dashIndex = argv.indexOf("--");
  if (dashIndex === -1) return null;
  const profileFlagIndex = argv.indexOf("--profile");
  const profileId = profileFlagIndex !== -1 ? argv[profileFlagIndex + 1] : null;
  const command = argv.slice(dashIndex + 1).join(" ");
  if (!profileId || !command) return null;
  return { profileId, command };
}

function logTrim(entry) {
  const logPath = process.env.PANDA_TRIM_LOG;
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // Logging is best-effort observability, never allowed to affect the run.
  }
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  // Malformed invocation should never happen from our own hook, but if it
  // does, fail open by doing nothing useful — exit non-zero so it's obvious
  // in testing, never silently swallow.
  process.stderr.write("trim-run: could not parse --profile/-- <command>\n");
  process.exit(1);
}

const { profileId, command } = parsed;
const child = spawn(command, { shell: true, stdio: ["inherit", "pipe", "pipe"] });

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("close", (code) => {
  const exitCode = code ?? 1;
  const bytesBefore = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  let output;

  try {
    const profile = findProfile(profileId);
    if (!profile) throw new Error(`unknown profile: ${profileId}`);
    if (exitCode !== 0) {
      // Failure is exactly when the agent needs detail; profiles only get to
      // drop known-noise on failure (e.g. passing-test lines), never truncate
      // unique detail. See profiles.mjs onFailure implementations.
      output = profile.onFailure(stdout, stderr);
    } else {
      output = profile.onSuccess(stdout, stderr);
    }
  } catch {
    // Fail open: any error in profile logic falls back to raw output,
    // subject only to the universal cap.
    output = capOutput([stdout, stderr].filter(Boolean).join("\n"));
  }

  const bytesAfter = Buffer.byteLength(output);
  logTrim({
    ts: new Date().toISOString(),
    command,
    profile: profileId,
    exitCode,
    bytesBefore,
    bytesAfter,
  });

  process.stdout.write(output);
  if (!output.endsWith("\n")) process.stdout.write("\n");
  process.exit(exitCode);
});

child.on("error", (err) => {
  // Spawn itself failed (e.g. shell missing) — fail open by surfacing the
  // error like a normal failed command would.
  process.stderr.write(`trim-run: failed to spawn command: ${err.message}\n`);
  process.exit(1);
});
