#!/usr/bin/env node
// Drive CodexAppServerSessionManager against a REAL `codex app-server`.
//
// Unit tests pin the protocol we *think* Codex speaks; this pins the protocol it
// actually speaks. It runs the same manager the app runs, prints every state
// transition, and asserts the outcome of each scenario.
//
//   pnpm probe:codex all
//   pnpm probe:codex turn "reply DONE and nothing else"
//   pnpm probe:codex steer | queue | image <path> | approve | question | usage
//
// PROBE_VERBOSE=1 prints every manager event and state transition.
//
// Requires the `codex` CLI on PATH and a logged-in Codex account. Scenarios run
// in a scratch directory under the OS temp dir, never in a real repo.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingApproval, SessionStartRequest } from "../src/shared/ipc.ts";
import { CodexAppServerClient } from "../src/main/codex/appServerClient.ts";
import { CodexAppServerSessionManager, type CodexAppServerSession } from "../src/main/codex/appServerSession.ts";

const VERBOSE = process.env.PROBE_VERBOSE === "1";
const TURN_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 180_000);

type Probe = {
  manager: CodexAppServerSessionManager;
  /** Every snapshot the manager pushed, newest last. */
  states: string[];
  session: () => CodexAppServerSession | undefined;
};

function makeProbe(sectionId: string, experimentalFeatures?: Record<string, boolean>): Probe {
  const states: string[] = [];
  const manager = new CodexAppServerSessionManager({
    experimentalFeatures,
    createClient: (handlers) =>
      new CodexAppServerClient({
        spawn: () => spawn("codex", ["app-server"], { cwd: tmpdir(), stdio: "pipe" }),
        clientInfo: { name: "panda_code_probe", title: "Panda Code Probe", version: "0.0.0" },
        logMain: (event, details) => {
          if (VERBOSE) console.log(`  · ${event}`, details ?? "");
        },
        onNotification: handlers.onNotification,
        onServerRequest: handlers.onServerRequest,
        onExit: handlers.onExit,
      }),
    logMain: (event, details) => {
      // Always show the events that explain a scenario's outcome.
      if (VERBOSE || /approval|steer|queued|turn-|client-exit|thread-ready/.test(event)) {
        console.log(`  · ${event}`, details ?? "");
      }
    },
    sendSnapshot: (_id, session) => {
      const line = `${session.state.agentState}/${session.state.currentEventType}`;
      if (states.at(-1) !== line) {
        states.push(line);
        if (VERBOSE) console.log(`  → ${line}`);
      }
    },
  });
  return { manager, states, session: () => manager.get(sectionId) };
}

function scratchRequest(id: string, overrides: Partial<SessionStartRequest> = {}): SessionStartRequest {
  const cwd = mkdtempSync(join(tmpdir(), "panda-probe-"));
  return {
    id,
    cwd,
    command: "codex",
    runtime: "codex",
    executionMode: "stream-json",
    permissionMode: "workspace-write",
    cols: 100,
    rows: 30,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until it returns true, or fail loudly on timeout. */
async function waitFor(label: string, check: () => boolean, timeoutMs = TURN_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

const waitForIdle = (probe: Probe): Promise<void> =>
  waitFor("the turn to finish", () => {
    const state = probe.session()?.state.agentState;
    return state === "waiting" || state === "needs_action" || state === "exited";
  });

const assistantText = (probe: Probe): string =>
  (probe.session()?.state.items ?? [])
    .filter((item) => item.kind === "assistant")
    .map((item) => item.body)
    .join("\n");

const userText = (probe: Probe): string =>
  (probe.session()?.state.items ?? [])
    .filter((item) => item.kind === "user")
    .map((item) => item.body)
    .join("\n");

function itemTitles(probe: Probe): string[] {
  return (probe.session()?.state.items ?? []).map((item) => `${item.kind}:${item.title ?? ""}`);
}

type Check = { label: string; ok: boolean; detail?: string };

function report(name: string, checks: Check[]): boolean {
  const failed = checks.filter((check) => !check.ok);
  console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}  ${name}`);
  for (const check of checks) {
    console.log(`   ${check.ok ? "✓" : "✗"} ${check.label}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  return failed.length === 0;
}

// --- scenarios -------------------------------------------------------------

/** One prompt, one turn: the baseline the whole transport rests on. */
async function scenarioTurn(prompt = "Reply with exactly: DONE"): Promise<boolean> {
  const probe = makeProbe("probe-turn");
  const request = scratchRequest("probe-turn");
  const start = await probe.manager.start(request, prompt);
  await waitForIdle(probe);
  const state = probe.session()!.state;
  const text = assistantText(probe);
  // Snapshot anything derived from the session BEFORE stop() drops it.
  const titles = itemTitles(probe);
  console.log(`   assistant: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
  probe.manager.stop("probe-turn");
  return report("turn — a prompt runs and streams a reply", [
    { label: "start ok", ok: start.ok, detail: start.ok ? undefined : start.message },
    { label: "thread id resolved", ok: Boolean(state.codexThreadId), detail: state.codexThreadId },
    { label: "assistant text arrived", ok: text.trim().length > 0 },
    { label: "ended waiting (not needs_action)", ok: state.agentState === "waiting", detail: state.agentState },
    { label: "token usage recorded", ok: state.tokenUsage.totalTokens > 0, detail: String(state.tokenUsage.totalTokens) },
    { label: "turn summary emitted", ok: titles.some((title) => title.includes("Turn summary")) },
  ]);
}

/** Mid-turn steer: the thing turn/start-during-a-turn could never do. */
async function scenarioSteer(): Promise<boolean> {
  const probe = makeProbe("probe-steer");
  // workspace-write so the shell tool runs without an approval detour.
  const request = scratchRequest("probe-steer");
  // The first turn has to still be running when we steer, so give it real work
  // to wait on rather than tokens to emit (a chatty turn can finish in the time
  // it takes us to notice it started).
  await probe.manager.start(
    request,
    "Run the shell command `sleep 25` and wait for it to finish. Then reply exactly FIRST-DONE.",
  );
  await waitFor("a tool call to be under way", () => Boolean(probe.session()?.state.latestTool));
  const steer = await probe.manager.sendInput("probe-steer", "While that runs: also reply with the word STEERED.");
  const steered = steer.ok && probe.states.some((state) => state.endsWith("input:steered"));
  await waitForIdle(probe);
  const text = assistantText(probe);
  // Codex echoes the steered message back as a userMessage item on the SAME turn,
  // which proves delivery into the live turn. Whether the model then says the magic
  // word is up to the model, so that check is advisory.
  const landed = userText(probe).includes("STEERED");
  console.log(`   assistant: ${text.replace(/\s+/g, " ").slice(0, 260)}`);
  probe.manager.stop("probe-steer");
  return report("steer — a mid-turn prompt reaches the live turn", [
    { label: "steer accepted", ok: steer.ok, detail: steer.ok ? undefined : steer.message },
    { label: "went out as a steer (not a second turn)", ok: steered },
    { label: "the steered message landed in the live turn", ok: landed },
    { label: "the model acted on it (advisory — model's call)", ok: true, detail: /STEERED/i.test(text) ? "obeyed" : "not echoed this run" },
  ]);
}

/** Two prompts inside the thread-opening window: neither may be lost. */
async function scenarioQueue(): Promise<boolean> {
  const probe = makeProbe("probe-queue");
  const request = scratchRequest("probe-queue");
  // Do NOT await start(): send both prompts while the handshake is in flight,
  // which is exactly the window the old single-slot buffer dropped one in.
  const startPromise = probe.manager.start(request);
  const first = await probe.manager.sendInput("probe-queue", "Remember the word ALPHA.");
  const second = await probe.manager.sendInput("probe-queue", "Remember the word BRAVO. Now reply with both words.");
  await startPromise;
  await waitForIdle(probe);
  const text = assistantText(probe);
  console.log(`   assistant: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  probe.manager.stop("probe-queue");
  return report("queue — prompts racing the handshake are all delivered", [
    { label: "first accepted", ok: first.ok },
    { label: "second accepted", ok: second.ok },
    { label: "ALPHA survived", ok: /ALPHA/i.test(text) },
    { label: "BRAVO survived", ok: /BRAVO/i.test(text) },
  ]);
}

/** Images must arrive as localImage inputs, not as a path in the prose. */
async function scenarioImage(imagePath?: string): Promise<boolean> {
  const probe = makeProbe("probe-image");
  const request = scratchRequest("probe-image");
  let path = imagePath;
  if (!path) {
    // A 1x1 red PNG is enough to prove the input type is accepted end to end.
    path = join(request.cwd, "probe.png");
    writeFileSync(
      path,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
  }
  const start = await probe.manager.start(request);
  const sent = await probe.manager.sendInput("probe-image", "Describe the attached image in one short sentence.", [path]);
  await waitForIdle(probe);
  const text = assistantText(probe);
  const titles = itemTitles(probe);
  console.log(`   assistant: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  probe.manager.stop("probe-image");
  return report("image — a localImage input is accepted and seen", [
    { label: "start ok", ok: start.ok },
    { label: "send accepted (server did not reject the input type)", ok: sent.ok, detail: sent.ok ? undefined : sent.message },
    { label: "a reply arrived", ok: text.trim().length > 0 },
    { label: "no Codex error item", ok: !titles.some((title) => title.includes("Codex error")) },
  ]);
}

/**
 * The scenario from the bug report: Codex needs to escape its sandbox, which
 * used to be answered with JSON-RPC -32601 ("cannot answer") and end the turn.
 */
async function scenarioApprove(): Promise<boolean> {
  const probe = makeProbe("probe-approve");
  // read-only forces an approval for any write.
  const request = scratchRequest("probe-approve", { permissionMode: "read-only" });
  await probe.manager.start(request, `Create a file named approved.txt containing the word OK in ${request.cwd}.`);

  let seen: PendingApproval | undefined;
  try {
    await waitFor("Codex to request an approval", () => {
      seen = probe.session()?.state.pendingApproval;
      return Boolean(seen);
    }, 90_000);
  } catch {
    probe.manager.stop("probe-approve");
    return report("approve — a sandbox escape becomes an answerable prompt", [
      {
        label: "Codex asked for approval",
        ok: false,
        detail: "no approval request arrived; Codex may have refused without asking (retry, or check the sandbox mode)",
      },
    ]);
  }

  const approval = seen!;
  console.log(`   asked: [${approval.kind}] ${approval.title} — ${approval.body.replace(/\s+/g, " ").slice(0, 120)}`);
  const parked = probe.session()!.state.agentState;
  const answered = probe.manager.answerApproval({
    id: "probe-approve",
    promptId: approval.promptId,
    optionId: approval.options.find((option) => option.id === "accept")?.id ?? approval.options[0]?.id,
  });
  await waitForIdle(probe);
  const state = probe.session()!.state;
  const text = assistantText(probe);
  console.log(`   assistant: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  probe.manager.stop("probe-approve");
  return report("approve — a sandbox escape becomes an answerable prompt", [
    { label: "Codex asked instead of giving up", ok: true },
    { label: "section parked at needs_action", ok: parked === "needs_action", detail: parked },
    { label: "prompt carried options", ok: approval.options.length > 0 },
    { label: "answer accepted", ok: answered.ok, detail: answered.ok ? undefined : answered.message },
    { label: "prompt cleared", ok: state.pendingApproval === undefined },
    { label: "turn continued after the answer", ok: state.agentState === "waiting", detail: state.agentState },
  ]);
}

/**
 * `item/tool/requestUserInput` — the "interactive prompt tool is not available in
 * this mode" dead end. Best-effort: only newer Codex builds offer the tool, and
 * the model chooses whether to reach for it.
 */
async function scenarioQuestion(): Promise<boolean> {
  // Codex gates the tool behind an under-development flag, off by default, so the
  // model cannot ask anything until it is on. Process-wide only — this never
  // touches the user's ~/.codex config.
  const probe = makeProbe("probe-question", { default_mode_request_user_input: true });
  const request = scratchRequest("probe-question");
  await probe.manager.start(
    request,
    "I want you to scaffold a config file here, but I have not told you which format. " +
      "Do NOT assume and do NOT write anything yet. Ask me to choose between TOML and JSON using your " +
      "request_user_input tool, and wait for my answer before doing anything else.",
  );

  let approval: PendingApproval | undefined;
  try {
    await waitFor("Codex to ask a question", () => {
      approval = probe.session()?.state.pendingApproval;
      return approval?.kind === "userInput";
    }, 90_000);
  } catch {
    const declined = itemTitles(probe).some((title) => title.includes("can't answer"));
    probe.manager.stop("probe-question");
    return report("question — requestUserInput is answerable (best effort)", [
      { label: "Codex reached for the tool", ok: false, detail: "no requestUserInput arrived; the model answered without asking" },
      { label: "nothing was refused with -32601", ok: !declined },
    ]);
  }

  const asked = approval!;
  console.log(`   asked: ${asked.body} [${asked.options.map((option) => option.label).join(" | ")}]`);
  const answered = probe.manager.answerApproval({
    id: "probe-question",
    promptId: asked.promptId,
    optionId: asked.options[0]?.id,
    text: asked.options.length === 0 ? "red" : undefined,
  });
  await waitForIdle(probe);
  const state = probe.session()!.state;
  probe.manager.stop("probe-question");
  return report("question — requestUserInput is answerable (best effort)", [
    { label: "question surfaced as a prompt", ok: true },
    { label: "answer accepted", ok: answered.ok, detail: answered.ok ? undefined : answered.message },
    { label: "prompt cleared", ok: state.pendingApproval === undefined },
    { label: "turn finished", ok: state.agentState === "waiting", detail: state.agentState },
  ]);
}

/** Rate limits over the shared client — no throwaway process spawned. */
async function scenarioUsage(): Promise<boolean> {
  const probe = makeProbe("probe-usage");
  const request = scratchRequest("probe-usage");
  await probe.manager.start(request, "Reply with exactly: DONE");
  await waitForIdle(probe);
  const payload = await probe.manager.readRateLimits(15_000, 60_000);
  probe.manager.stop("probe-usage");
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  console.log(`   payload keys: ${record ? Object.keys(record).join(", ") : "none"}`);
  return report("usage — rate limits come off the live client", [
    { label: "a payload came back", ok: Boolean(record) },
    { label: "it carries rate-limit data", ok: Boolean(record && ("rateLimits" in record || "rateLimitsByLimitId" in record)) },
  ]);
}

// --- entry point -----------------------------------------------------------

async function main(): Promise<void> {
  const [command = "all", ...rest] = process.argv.slice(2);
  const results: boolean[] = [];

  switch (command) {
    case "turn":
      results.push(await scenarioTurn(rest.join(" ") || undefined));
      break;
    case "steer":
      results.push(await scenarioSteer());
      break;
    case "queue":
      results.push(await scenarioQueue());
      break;
    case "image":
      results.push(await scenarioImage(rest[0]));
      break;
    case "approve":
      results.push(await scenarioApprove());
      break;
    case "question":
      results.push(await scenarioQuestion());
      break;
    case "usage":
      results.push(await scenarioUsage());
      break;
    case "all":
      // Deterministic scenarios only: `question` depends on the model choosing to
      // use a tool, so it stays opt-in.
      results.push(await scenarioTurn());
      results.push(await scenarioQueue());
      results.push(await scenarioSteer());
      results.push(await scenarioImage());
      results.push(await scenarioApprove());
      results.push(await scenarioUsage());
      break;
    default:
      console.error(`Unknown scenario "${command}". Try: all | turn | steer | queue | image | approve | question | usage`);
      process.exit(2);
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed.`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error("\nProbe crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
