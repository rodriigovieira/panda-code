#!/usr/bin/env node
// Compile the dictation helper and stage the vocabulary it is biased with.
//
// The helper is a real Swift executable (see native/dictation/main.swift)
// because Electron cannot reach the Speech framework in-process, and Chromium's
// Web Speech API is a dead end here — its implementation calls a Google
// endpoint through an API key Electron does not ship, so it fails with a
// `network` error and no transcript.
//
// Every failure in this script is non-fatal. A machine without the Xcode
// command line tools still builds and runs the app; dictation simply reports
// itself unavailable and the composer shows no microphone.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "../..");

const sources = [
  join(desktop, "native/dictation/main.swift"),
  join(desktop, "native/dictation/Analyzer.swift"),
];
const plist = join(desktop, "native/dictation/Info.plist");
const outDir = join(desktop, "resources");
const binary = join(outDir, "panda-dictation");
const vocabularyOut = join(outDir, "dictation-vocabulary.json");

mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Vocabulary
//
// Shared with the phone rather than mined twice: `mine_dictation_vocabulary.py`
// reads this machine's Claude Code transcripts, which is the same corpus either
// way. The seed list is checked in and the mined file is not, so a fresh clone
// still gets the team's project nouns.

function readTerms(path, key) {
  if (!existsSync(path)) return { terms: [], phrases: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const strings = (raw) =>
      Array.isArray(raw) ? raw.filter((s) => typeof s === "string" && s.trim().length > 0) : [];
    return { terms: strings(parsed.terms), phrases: strings(parsed[key]) };
  } catch (error) {
    console.warn(`[dictation] ${path} unreadable: ${error.message}`);
    return { terms: [], phrases: [] };
  }
}

const mined = readTerms(join(repo, "apps/mobile/assets/dictation_vocabulary.json"), "phrases");
const seed = readTerms(join(repo, "apps/mobile/assets/dictation_seed_vocabulary.json"), "phrases");

// Mined terms come first because they are ranked by how much this user actually
// says them, and the helper truncates the list. The seed then fills what is
// left with team vocabulary this machine happens not to have mined yet.
const seen = new Set(mined.terms.map((term) => term.toLowerCase()));
const terms = [...mined.terms];
for (const term of seed.terms) {
  if (!seen.has(term.toLowerCase())) {
    seen.add(term.toLowerCase());
    terms.push(term);
  }
}

writeFileSync(vocabularyOut, `${JSON.stringify({ terms, phrases: mined.phrases }, null, 2)}\n`);
console.log(
  `[dictation] vocabulary: ${terms.length} terms, ${mined.phrases.length} phrases` +
    (mined.terms.length === 0 ? " (nothing mined on this machine — seed only)" : ""),
);

// ---------------------------------------------------------------------------
// Helper binary

function swiftcAvailable() {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!swiftcAvailable()) {
  console.warn("[dictation] swiftc not found — skipping helper; dictation will be unavailable");
  process.exit(0);
}

const newest = Math.max(...[...sources, plist].map((file) => statSync(file).mtimeMs));
if (existsSync(binary) && statSync(binary).mtimeMs > newest) {
  console.log("[dictation] helper up to date");
  process.exit(0);
}

// macOS 14 is the floor for `SFSpeechLanguageModel` (the custom language model
// trained from the user's own phrasing). Everything else in the legacy path
// works further back, but shipping two code paths for a Mac-only developer tool
// is not worth the branch.
//
// The `SpeechAnalyzer` engine in Analyzer.swift needs macOS 26, and is reached
// through `@available` rather than by raising this floor: the binary still runs
// on 14-25, where dictation falls back to `SFSpeechRecognizer`. Building it does
// require an SDK of 26 or newer — an older toolchain fails the compile, which
// this script already treats as "no dictation" rather than a broken build.
const args = [
  "-O",
  "-target",
  "arm64-apple-macos14",
  "-framework",
  "Speech",
  "-framework",
  "AVFoundation",
  // Usage descriptions have to live *inside* the executable — see Info.plist.
  "-Xlinker",
  "-sectcreate",
  "-Xlinker",
  "__TEXT",
  "-Xlinker",
  "__info_plist",
  "-Xlinker",
  plist,
  "-o",
  binary,
  ...sources,
];

try {
  console.log("[dictation] compiling helper…");
  execFileSync("xcrun", ["swiftc", ...args], { stdio: "inherit" });
  // Apple silicon refuses to run an unsigned binary. swiftc normally ad-hoc
  // signs, but not when the linker rewrites sections as it does above.
  execFileSync("codesign", ["--force", "--sign", "-", binary], { stdio: "inherit" });
  console.log(`[dictation] helper built → ${binary}`);
} catch (error) {
  console.warn(`[dictation] helper build failed: ${error.message}`);
  console.warn("[dictation] continuing without dictation");
}
