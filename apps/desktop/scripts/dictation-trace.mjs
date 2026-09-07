#!/usr/bin/env node
// Read the dictation diagnostics out of the app's debug log.
//
// Both halves of dictation trace into `panda-code-debug.log`: the Swift helper
// emits `native.*` (legacy SFSpeechRecognizer) and `analyzer.*` (macOS 26
// SpeechAnalyzer) events, and the renderer emits `renderer.*` for the decisions
// it makes in response. Counts and generations only — never transcript text.
//
// Reading them by hand does not scale: a minute of speech is several hundred
// partials. This rolls them up into the three things that have actually gone
// wrong in practice.
//
//   node scripts/dictation-trace.mjs [--since 23:00] [--all]
//
// What the sections mean when something is wrong:
//
//   engine overlap        Any overlap at all is the two-engines bug: both
//                         recognisers transcribing one utterance into one
//                         composer. Was 43% before the single-owner fix.
//                         `engine.conflict` lines name it outright.
//   time to first text    The user-visible "it took ten seconds to start".
//                         Dead generations below are the usual cause — the
//                         press is waiting on an analyzer that never delivers.
//   dead generations      Opened, never produced a partial. A run of them is a
//                         restart storm, and the trigger is almost always
//                         `renderer.manual_edit_restart` firing repeatedly
//                         without the user actually typing.
//   utterance restarts    Banked text rescued from being overwritten. Watch the
//                         lengths: `banked=186 next=185` means the bank was
//                         probably wrong and the text got DUPLICATED rather
//                         than saved. Near-equal lengths are the signature.
//                         `by=timestamp` vs `by=text` says which detector fired.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = join(
  homedir(),
  "Library/Application Support/Panda Code/panda-code-debug.log",
);

// The debug log rolls at 24 MB and `session:runtime` alone can fill that in a
// few hours, so a dictation session from this morning is routinely in `.1` by
// the afternoon. Read the rolled generation first, then the live one.
function readLines() {
  const lines = [];
  for (const path of [`${LOG}.1`, LOG]) {
    try {
      lines.push(...readFileSync(path, "utf8").split("\n"));
    } catch {
      // Missing rolled generation is the normal case on a fresh install.
    }
  }
  return lines;
}

const args = process.argv.slice(2);
const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : null;
const showAll = args.includes("--all");

/** @type {{at: Date, hhmm: string, event: string, gen?: number, textLen?: number, note?: string, ms?: number}[]} */
const rows = [];
for (const line of readLines()) {
  if (!line.includes("dictation:trace")) continue;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  if (parsed.event !== "dictation:trace") continue;
  const d = parsed.details ?? {};
  // Renderer traces nest the real event name; helper traces carry it flat.
  if (!d.event) continue;
  const at = new Date(parsed.at);
  const hhmm = parsed.at.slice(11, 23);
  if (since && hhmm < since) continue;
  rows.push({ at, hhmm, event: d.event, gen: d.gen, textLen: d.textLen, note: d.note, ms: d.ms });
}

if (rows.length === 0) {
  console.log("No dictation traces found" + (since ? ` since ${since}` : "") + ".");
  process.exit(0);
}

const family = (event) => event.split(".")[0];
console.log(`${rows.length} traces  ${rows[0].hhmm} -> ${rows.at(-1).hhmm}\n`);

// 1. Two engines on one microphone. This is the bug that produced duplicated
//    text: both engines transcribe the same speech into the same composer.
const buckets = new Map();
for (const r of rows) {
  if (r.event.startsWith("renderer.")) continue;
  const bucket = Math.floor(r.at.getTime() / 2000);
  if (!buckets.has(bucket)) buckets.set(bucket, new Set());
  buckets.get(bucket).add(family(r.event));
}
const overlapping = [...buckets.values()].filter((f) => f.size > 1).length;
const pct = buckets.size ? Math.round((100 * overlapping) / buckets.size) : 0;
console.log("== engine overlap ==");
console.log(`  ${overlapping}/${buckets.size} two-second windows had BOTH engines emitting (${pct}%)`);
const conflicts = rows.filter((r) => r.event === "engine.conflict");
console.log(`  explicit engine.conflict traces: ${conflicts.length}`);
for (const c of conflicts.slice(-5)) console.log(`    ${c.hhmm} ${c.note}`);
if (pct > 0 && conflicts.length === 0) {
  console.log("  (overlap with no conflict trace means a build older than the single-owner fix)");
}

// 2. Startup latency, as the user experiences it: press -> first text on screen.
console.log("\n== time to first text (renderer.begin -> renderer.first_text) ==");
const firstText = rows.filter((r) => r.event === "renderer.first_text" && typeof r.ms === "number");
if (firstText.length === 0) {
  console.log("  no renderer timings yet (needs a build with renderer dictation traces)");
} else {
  const ms = firstText.map((r) => r.ms).sort((a, b) => a - b);
  const at = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  console.log(`  n=${ms.length}  p50=${at(0.5)}ms  p90=${at(0.9)}ms  max=${ms.at(-1)}ms`);
  for (const slow of firstText.filter((r) => r.ms > 3000).slice(-5)) {
    console.log(`    slow: ${slow.hhmm} ${slow.ms}ms (${slow.kind ?? "?"})`);
  }
}

// 3. Restart storms. A generation that opens and never yields a partial is work
//    the user is waiting on that will never arrive.
console.log("\n== generations that opened but never produced a partial ==");
let dead = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (r.event !== "analyzer.open" && r.event !== "native.task_start") continue;
  const fam = family(r.event);
  const produced = rows
    .slice(i + 1)
    .find(
      (n) =>
        family(n.event) === fam &&
        (n.event.endsWith(".partial") || n.event.endsWith(".segment")) &&
        n.gen === r.gen,
    );
  if (!produced) {
    dead++;
    if (showAll || dead <= 8) console.log(`  ${r.hhmm} ${r.event} gen=${r.gen}`);
  }
}
console.log(`  ${dead} dead generation(s)` + (dead > 8 && !showAll ? " (--all to list every one)" : ""));

const restarts = rows.filter((r) => r.event.endsWith(".restart") || r.event === "renderer.manual_edit_restart");
console.log(`\n== restarts ==\n  ${restarts.length} total`);
const byCause = {};
for (const r of restarts) byCause[r.event] = (byCause[r.event] ?? 0) + 1;
for (const [event, n] of Object.entries(byCause)) console.log(`  ${event}: ${n}`);

// Transcript erasure — the bug the iOS telemetry originally caught.
const erased = rows.filter((r) => r.event === "native.utterance_restart");
if (erased.length) {
  console.log(`\n== utterance restarts (banked text before it was overwritten) ==`);
  for (const e of erased.slice(-8)) console.log(`  ${e.hhmm} gen=${e.gen} banked=${e.textLen} ${e.note ?? ""}`);
}
