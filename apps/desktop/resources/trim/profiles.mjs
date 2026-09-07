// Conserve-mode command-output profiles.
//
// Each profile is a pure function of (stdout, stderr, exitCode) -> string.
// trim-run.mjs picks a profile by id (chosen by trim-hook.mjs from the command
// text) and calls it only on a *successful* run — the "only trim on success"
// rule lives in trim-run.mjs, not here, so every onFailure below is really
// "what to do with a failure that this profile's own command shape produces,"
// scoped tightly to noise-only removal, never truncation of unique detail.
//
// Keep these conservative: a profile that misreads its input should fall back
// to raw text via capOutput() rather than fabricate a summary.

const HEAD_LINES = 40;
const TAIL_LINES = 40;

// Universal backstop: head N + tail N lines with an explicit marker. Only
// ever applied *inside* a profile (never when no profile matched at all).
export function capOutput(text, headLines = HEAD_LINES, tailLines = TAIL_LINES) {
  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines + 1) return text;
  const head = lines.slice(0, headLines);
  const tail = lines.slice(lines.length - tailLines);
  const trimmed = lines.length - headLines - tailLines;
  return [...head, `… ${trimmed} lines trimmed …`, ...tail].join("\n");
}

function combine(stdout, stderr) {
  return [stdout, stderr].filter((s) => s && s.trim().length > 0).join("\n");
}

function keepLines(text, predicate) {
  return text
    .split("\n")
    .filter(predicate)
    .join("\n");
}

// (`synthesizeDiffStat` lived here; removed with the git-diff profile.)
export const profiles = [
  {
    id: "typecheck-build",
    // pnpm typecheck / pnpm build / bare tsc --noEmit — this repo's gate command.
    match: (command) => /(^|[;&|]\s*)(pnpm\s+(run\s+)?(typecheck|build)\b|tsc\b[^\n]*--noEmit\b)/.test(command),
    // Success is genuinely one bit of information ("it compiles"); the
    // hundreds of lines of vite/tsc project-reference chatter carry nothing.
    onSuccess: () => "✓ typecheck/build succeeded — no errors.",
    // Failure output from tsc/vite *is* the diagnostics, nothing else to
    // drop, so just apply the universal cap.
    onFailure: (stdout, stderr) => capOutput(combine(stdout, stderr)),
  },
  {
    id: "test",
    // pnpm test / vitest run / bare vitest.
    match: (command) => /(^|[;&|]\s*)(pnpm\s+(run\s+)?test\b|vitest\b)/.test(command),
    onSuccess: (stdout, stderr) => {
      const combined = combine(stdout, stderr);
      const summary = keepLines(
        combined,
        (line) => /Test Files\s/.test(line) || /^\s*Tests\s/.test(line) || /Duration\s/.test(line) || /^\s*✓.*passed/i.test(line),
      );
      return summary.trim() ? summary : capOutput(combined, 5, 5);
    },
    // Drop the per-test "✓ passed" noise, keep everything else — failure
    // blocks, stack traces, assertion diffs, and the final summary — intact.
    onFailure: (stdout, stderr) => {
      const combined = combine(stdout, stderr);
      const withoutPassLines = keepLines(combined, (line) => !/^\s*✓/.test(line));
      return capOutput(withoutPassLines);
    },
  },
  {
    id: "install",
    // pnpm install / pnpm i.
    match: (command) => /(^|[;&|]\s*)pnpm\s+i(nstall)?\b(?!\S)/.test(command),
    onSuccess: (stdout, stderr) => {
      const combined = combine(stdout, stderr);
      const summary = keepLines(
        combined,
        (line) => /warn/i.test(line) || /^Done in/i.test(line) || /^\+\s|packages?:/i.test(line) || /Progress:\s*resolved/i.test(line),
      );
      return summary.trim() ? summary : capOutput(combined, 5, 5);
    },
    onFailure: (stdout, stderr) => capOutput(combine(stdout, stderr)),
  },
  {
    id: "package-mac",
    // pnpm package:mac — electron-builder's chatter is ~hundreds of lines;
    // the [relay] seed line is read deliberately by the team, so it must
    // survive verbatim (see agent-prompts.ts backgroundOutputSystemPrompt
    // notes on packaging output).
    match: (command) => /(^|[;&|]\s*)pnpm\s+package:mac\b/.test(command),
    onSuccess: (stdout, stderr) => {
      const combined = combine(stdout, stderr);
      const summary = keepLines(
        combined,
        (line) => /\[relay\]/.test(line) || /release\/mac-arm64/.test(line) || /\.app\b/.test(line) || /building\s+target/i.test(line),
      );
      return summary.trim() ? summary : capOutput(combined, 10, 10);
    },
    onFailure: (stdout, stderr) => capOutput(combine(stdout, stderr)),
  },
  {
    id: "git-status",
    match: (command) => /(^|[;&|]\s*)git\s+status\b/.test(command) && !/(^|\s)(-s|--short|-sb|--porcelain)\b/.test(command),
    // git status's own output is already small; nothing to compress beyond
    // the universal cap, so this exists mainly to document that we saw it
    // and chose not to touch it.
    onSuccess: (stdout, stderr) => capOutput(combine(stdout, stderr), 60, 10),
    onFailure: (stdout, stderr) => capOutput(combine(stdout, stderr)),
  },
  {
    id: "git-log",
    match: (command) =>
      /(^|[;&|]\s*)git\s+log\b/.test(command) && !/--oneline\b|--pretty\b|-p\b|--patch\b/.test(command),
    onSuccess: (stdout, stderr) => {
      const combined = combine(stdout, stderr);
      // Best-effort one-line-per-commit reduction of the verbose default
      // format; falls back to a plain cap if the shape isn't recognized.
      const commitLines = [];
      let hash = null;
      let subject = null;
      for (const line of combined.split("\n")) {
        const commitMatch = line.match(/^commit\s+([0-9a-f]+)/);
        if (commitMatch) {
          if (hash) commitLines.push(`${hash.slice(0, 7)} ${subject ?? ""}`.trim());
          hash = commitMatch[1];
          subject = null;
          continue;
        }
        if (hash && subject === null && line.trim() && !/^(Author|Date|Merge):/.test(line.trim())) {
          subject = line.trim();
        }
      }
      if (hash) commitLines.push(`${hash.slice(0, 7)} ${subject ?? ""}`.trim());
      return commitLines.length ? capOutput(commitLines.join("\n"), 60, 10) : capOutput(combined);
    },
    onFailure: (stdout, stderr) => capOutput(combine(stdout, stderr)),
  },
  // NOTE: there was a `git-diff` profile here. It was removed after measurement.
  // `git diff -- <path>` is a *deliberate read* of a specific file, not noise:
  // the trim log caught it replacing an 8 kB requested diff with a 97-byte
  // synthesized stat, which is the single most expensive kind of mistake this
  // trimmer can make — the agent has to re-run it, and a retry costs far more
  // than the bytes saved. Do not re-add it without a way to tell an exploratory
  // diff from a requested one.
  {
    id: "mobile-build-deploy",
    // flutter build ... / apps/mobile/scripts/deploy.sh.
    match: (command) => /(^|[;&|]\s*)flutter\s+build\b/.test(command) || /apps\/mobile\/scripts\/deploy\.sh\b/.test(command),
    onSuccess: (stdout, stderr) => {
      const combined = combine(stdout, stderr);
      const summary = keepLines(
        combined,
        (line) => /version|build number|Uploaded|Built|IPA|TestFlight/i.test(line),
      );
      return summary.trim() ? summary : capOutput(combined, 10, 10);
    },
    onFailure: (stdout, stderr) => capOutput(combine(stdout, stderr)),
  },
];

export function findProfile(id) {
  return profiles.find((p) => p.id === id);
}

// A command joined by `&&`, `;` or a pipe does several things, and a profile
// only knows how to summarize one of them. Measured failure: an agent ran
// `cp … && pnpm exec vitest run … && pnpm run typecheck`, it matched the
// `typecheck-build` profile, and the whole 195-byte result — including the
// vitest output actually being asked for — collapsed to a 44-byte "typecheck
// clean" line. A chain is never safe to summarize, so it is never rewritten.
//
// `\n` counts too: a multi-line command is a script, same argument.
const COMPOUND_PATTERN = /(&&|\|\||[;\n]|\|(?!\|))/;

export function isCompoundCommand(command) {
  return COMPOUND_PATTERN.test(command);
}

export function matchProfile(command) {
  if (isCompoundCommand(command)) return undefined;
  return profiles.find((p) => p.match(command));
}
