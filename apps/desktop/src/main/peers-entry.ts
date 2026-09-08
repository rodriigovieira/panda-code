import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:net";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PersistedThread } from "../shared/ipc";
import {
  BACKLOG_COLUMNS,
  emptyBacklog,
  findBacklogEpic,
  renderBacklog,
  renderBacklogItemDetail,
  renderEpics,
  normalizeColumn,
  type BacklogAttachment,
  type BacklogColumn,
  type VerificationOutcome,
} from "../shared/backlog";
import {
  attachBacklogFile,
  createBacklogStore,
  deleteBacklogAttachmentFiles,
  storeAdd as backlogStoreAdd,
  storeAddEpic as backlogStoreAddEpic,
  storeDelete as backlogStoreDelete,
  storeDeleteEpic as backlogStoreDeleteEpic,
  storeUpdate as backlogStoreUpdate,
  storeUpdateEpic as backlogStoreUpdateEpic,
} from "../shared/backlog-store";
import { collectMachineStats } from "../shared/machine-probe";
import { renderMachineStats } from "../shared/machine-stats";
import {
  emptySchedule,
  parseFrequency,
  renderSchedule,
  renderScheduledTaskDetail,
  type ScheduleFrequency,
} from "../shared/schedule";
import { createScheduleStore, storeAdd as scheduleStoreAdd, storeDelete as scheduleStoreDelete, storeUpdate as scheduleStoreUpdate } from "../shared/schedule-store";
import {
  DEFAULT_PAGE_TURNS,
  isSettled,
  isWaitingForInput,
  matchThread,
  missingTranscript,
  parseActivity,
  parseTurns,
  peerStatus,
  renderInbox,
  renderPeerDetail,
  renderPeerList,
  renderPeerTurn,
  selectWorkspacePeers,
  summarizePeer,
  type PeerMessageRecord,
  type PeerSession,
  type PeerTranscript,
} from "../shared/workspace-peers";

/**
 * The agent-facing half of workspace awareness.
 *
 * This file is a SECOND entry point of the main bundle, not part of the app: it
 * is spawned per session as an MCP server (Claude reaches it through
 * `--mcp-config`) and can also be run one-shot from a shell (`panda-peers`,
 * which is how Codex and plain terminal sections reach it, since neither takes
 * MCP servers from us without editing the user's own config).
 *
 * It deliberately talks to disk rather than to the running app: no port, no
 * token, no lifecycle to get wrong, and it keeps working while the desktop is
 * busy. `threads.json` is written by the renderer on every state change, so the
 * snapshot it reads is at most one UI tick old — but only a snapshot, which is
 * why every status verdict here is cross-checked against the transcript on disk
 * (see `peerStatus`).
 *
 * Nothing here may import `electron` — the process is Node (Electron started
 * with ELECTRON_RUN_AS_NODE=1), so there is no app object to ask for paths.
 */

const MCP_PROTOCOL_VERSION = "2024-11-05";
/** Matches the `mcpServers` key the main process writes into `--mcp-config`. */
const SERVER_NAME = "panda_workspace";

type Options = {
  threadsPath: string;
  cwd: string;
  selfId?: string;
  home: string;
  /** Unix socket the running app answers `send_message` on; absent → read-only. */
  socketPath?: string;
  /** Journal of peer messages, so `read_session` can report what was read. */
  messagesPath?: string;
  /** Directory holding the per-workspace kanban boards; absent → no backlog. */
  backlogDir?: string;
  /** Directory holding the per-workspace schedules; absent → no schedule. */
  scheduleDir?: string;
};

/** Flags that take a value; everything else is a bare switch or a positional. */
const VALUE_FLAGS = new Set([
  "threads",
  "cwd",
  "self",
  "home",
  "socket",
  "messages",
  "backlog",
  "schedule",
  "summary",
  "description",
  "metadata",
  "column",
  "title",
  "prompt",
  "hourly",
  "daily",
  "once",
  "mode",
  "runtime",
  "model",
  "effort",
  "permission-mode",
  "limit",
  "offset",
  "turn",
  "part",
  "timeout",
  "tab",
  "url",
  "selector",
  "text",
  "button",
  "clicks",
  "keys",
  "to",
  "delta",
  "start",
  "end",
  "value",
  "label",
  "paths",
  "fps",
]);

type ParsedArgv = { options: Options; positionals: string[]; switches: Set<string>; flags: Map<string, string> };

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    if (VALUE_FLAGS.has(name)) {
      flags.set(name, argv[index + 1] ?? "");
      index += 1;
    } else {
      switches.add(name);
    }
  }

  return {
    options: {
      threadsPath: flags.get("threads") ?? process.env.PANDA_CODE_THREADS ?? "",
      // Shell users expect `panda-peers` to describe the directory where the
      // command is run. `PANDA_CODE_WORKSPACE` is still the right fallback for
      // MCP mode, where the helper is spawned out-of-process and cannot rely on
      // the client's cwd being the section cwd.
      cwd: flags.get("cwd") ?? (switches.has("mcp") ? process.env.PANDA_CODE_WORKSPACE : undefined) ?? process.cwd(),
      selfId: flags.get("self") ?? process.env.PANDA_CODE_SECTION_ID ?? undefined,
      home: flags.get("home") ?? process.env.PANDA_CODE_HOME ?? homedir(),
      socketPath: flags.get("socket") ?? process.env.PANDA_CODE_PEERS_SOCKET ?? undefined,
      messagesPath: flags.get("messages") ?? process.env.PANDA_CODE_PEER_MESSAGES ?? undefined,
      backlogDir: flags.get("backlog") ?? process.env.PANDA_CODE_BACKLOG ?? undefined,
      scheduleDir: flags.get("schedule") ?? process.env.PANDA_CODE_SCHEDULE ?? undefined,
    },
    positionals,
    switches,
    flags,
  };
}

/** How many times a torn read of the store is retried before it is believed. */
const THREADS_READ_ATTEMPTS = 4;
const THREADS_READ_BACKOFF_MS = 25;

/** A synchronous pause; this entry point is a short-lived CLI with no event loop to yield to. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read the store, saying whether the read actually succeeded.
 *
 * "Parsed, and there are no sections" and "could not parse the file" are the
 * same value — an empty array — and collapsing them is what made
 * `wait_for_session` report a live sub-thread as gone. The main process rewrites
 * a multi-megabyte `threads.json` about once a second while sections are live,
 * so a reader in another process lands mid-write often enough that a two-second
 * poll loop is near-certain to hit it. The write side is atomic now; this is the
 * belt to that pair of braces, since the store is also hand-editable and any
 * other writer is outside our control.
 */
function loadThreads(threadsPath: string): { ok: boolean; threads: PersistedThread[] } {
  for (let attempt = 0; attempt < THREADS_READ_ATTEMPTS; attempt += 1) {
    try {
      const parsed = JSON.parse(readFileSync(threadsPath, "utf8")) as unknown;
      return { ok: true, threads: Array.isArray(parsed) ? (parsed as PersistedThread[]) : [] };
    } catch (error) {
      // A store that is not there yet is a real, readable "no sections"; only a
      // torn or malformed read is worth retrying.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { ok: true, threads: [] };
      }
      if (attempt < THREADS_READ_ATTEMPTS - 1) {
        sleepSync(THREADS_READ_BACKOFF_MS);
      }
    }
  }

  return { ok: false, threads: [] };
}

function readThreads(threadsPath: string): PersistedThread[] {
  return loadThreads(threadsPath).threads;
}

/**
 * Same encoding the Claude CLI uses for its project directories: every
 * non-alphanumeric character becomes "-". Kept in sync with `claudeProjectDir`
 * in the main process.
 */
function claudeTranscriptPath(home: string, cwd: string, claudeSessionId: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${claudeSessionId}.jsonl`);
}

function codexSessionRoots(home: string): string[] {
  return [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];
}

function walkCodexFiles(home: string, visit: (path: string, name: string) => boolean): void {
  for (const root of codexSessionRoots(home)) {
    if (!existsSync(root)) {
      continue;
    }

    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop();
      if (!directory) {
        continue;
      }

      let entries: string[];
      try {
        entries = readdirSync(directory);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const path = join(directory, entry);
        if (entry.endsWith(".jsonl")) {
          if (visit(path, entry)) {
            return;
          }
          continue;
        }

        try {
          if (statSync(path).isDirectory()) {
            stack.push(path);
          }
        } catch {
          // Raced with a rotation; the remaining candidates still stand.
        }
      }
    }
  }
}

/** Codex files its sessions under dated directories, so the id has to be hunted. */
function codexTranscriptPath(home: string, codexThreadId: string): string | null {
  let found: string | null = null;
  walkCodexFiles(home, (path, name) => {
    if (name.includes(codexThreadId)) {
      found = path;
      return true;
    }
    return false;
  });
  return found;
}

/** How far either side of a section's creation a rollout file may sit and still be its own. */
const CODEX_MATCH_WINDOW_MS = 10 * 60_000;

/**
 * Find a Codex section's transcript when the app never learned its thread id.
 *
 * A section that dies early — or one whose app-server never reported back —
 * leaves a thread row with no `codexThreadId`, and the old code gave up there
 * and reported the section as having produced nothing. It had: Codex writes a
 * `session_meta` first line carrying the workspace and the start time, which is
 * enough to identify the file. Costlier than a path lookup, so it only runs when
 * the id lookup has already failed.
 */
export function findCodexTranscriptByWorkspace(home: string, cwd: string, createdAt: string): string | null {
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) {
    return null;
  }

  const candidates: { path: string; distance: number }[] = [];
  walkCodexFiles(home, (path) => {
    let modified: number;
    try {
      modified = statSync(path).mtimeMs;
    } catch {
      return false;
    }

    // The file is written from the section's start onwards, so anything that
    // stopped being touched before the section began cannot be it.
    if (modified < started - CODEX_MATCH_WINDOW_MS) {
      return false;
    }

    let head: string;
    try {
      head = readHead(path, 4096);
    } catch {
      return false;
    }

    const line = head.split("\n", 1)[0] ?? "";
    let meta: { payload?: { cwd?: string; timestamp?: string } };
    try {
      meta = JSON.parse(line) as { payload?: { cwd?: string; timestamp?: string } };
    } catch {
      return false;
    }

    if (meta.payload?.cwd !== cwd) {
      return false;
    }

    const openedAt = Date.parse(meta.payload?.timestamp ?? "");
    const distance = Number.isNaN(openedAt) ? CODEX_MATCH_WINDOW_MS : Math.abs(openedAt - started);
    if (distance > CODEX_MATCH_WINDOW_MS) {
      return false;
    }
    candidates.push({ path, distance });
    return false;
  });

  return candidates.sort((first, second) => first.distance - second.distance)[0]?.path ?? null;
}

function readHead(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readTail(path: string, bytes: number, size: number): string {
  const fd = openSync(path, "r");
  try {
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the whole transcript when it is anything like a normal size.
 *
 * The old code took a flat 200 KB tail, and that is precisely how a working
 * section came to look dead: a long stretch of tool calls with no prose fills
 * 200 KB easily, the tail parsed to zero turns, and the reader announced "no
 * transcript is readable for this section yet" about a file with hundreds of
 * turns in it. A window that can contain no answer is not a window worth having.
 */
const FULL_READ_BYTES = 4_000_000;

/** Beyond `FULL_READ_BYTES` a tail is unavoidable — but the shortfall is reported. */
const TAIL_BYTES = 2_000_000;

/** All `loadPeerTranscript` needs; the main process has no `Options` to hand. */
export type TranscriptLookup = { home: string };

function locateTranscript(thread: PersistedThread, options: TranscriptLookup): { path: string | null; linked: boolean } {
  const runtime = thread.runtime ?? "claude";
  if (runtime === "codex") {
    if (thread.codexThreadId) {
      return { path: codexTranscriptPath(options.home, thread.codexThreadId), linked: true };
    }
    const guessed = findCodexTranscriptByWorkspace(options.home, thread.cwd, thread.createdAt);
    return { path: guessed, linked: guessed !== null };
  }

  return thread.claudeSessionId
    ? { path: claudeTranscriptPath(options.home, thread.cwd, thread.claudeSessionId), linked: true }
    : { path: null, linked: false };
}

/**
 * A section's transcript, read once and handed to every renderer.
 *
 * `list_sessions`, `read_session` and `wait_for_session` all go through here, so
 * they cannot contradict each other about what a section has said.
 */
export function loadPeerTranscript(thread: PersistedThread, options: TranscriptLookup): PeerTranscript {
  const runtime = thread.runtime ?? "claude";
  const located = locateTranscript(thread, options);
  if (!located.path) {
    return missingTranscript(located.linked ? "not-found" : "not-linked");
  }

  let size: number;
  let modifiedAt: number;
  try {
    const stats = statSync(located.path);
    size = stats.size;
    modifiedAt = stats.mtimeMs;
  } catch {
    return missingTranscript("not-found", located.path);
  }

  let text: string;
  let omittedBytes = 0;
  try {
    if (size <= FULL_READ_BYTES) {
      text = readFileSync(located.path, "utf8");
    } else {
      text = readTail(located.path, TAIL_BYTES, size);
      omittedBytes = size - TAIL_BYTES;
    }
  } catch {
    return { ...missingTranscript("unreadable", located.path), modifiedAt };
  }

  const turns = parseTurns(runtime, text);
  return {
    found: true,
    turns,
    activity: parseActivity(runtime, text),
    complete: omittedBytes === 0,
    omittedBytes,
    modifiedAt,
    path: located.path,
  };
}

function readMessageJournal(options: Options): PeerMessageRecord[] {
  if (!options.messagesPath) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(options.messagesPath, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as PeerMessageRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * The machine, in one line, next to the sections sharing it.
 *
 * Every section is one agent's worth of good intentions on one laptop, and none
 * of them can feel the box swapping. Load average against core count is the
 * cheap version of that feeling: over 1.0 per core means work is already queued
 * behind other work, and a second `pnpm typecheck` will not be fast.
 *
 * `os` only — no shelling out — because this runs on the path of every
 * `list_sessions` call.
 */
function machineHeadline(): string {
  const cores = cpus().length || 1;
  const [oneMinute = 0, fiveMinute = 0] = loadavg();
  const freeGb = freemem() / 1024 ** 3;
  const totalGb = totalmem() / 1024 ** 3;
  const perCore = oneMinute / cores;
  const verdict =
    perCore > 1.5 ? "**heavily loaded — prefer cheap, scoped commands**" : perCore > 0.8 ? "busy — think before starting a build" : "quiet";

  return [
    `Machine: load ${oneMinute.toFixed(1)} (5m ${fiveMinute.toFixed(1)}) across ${cores} cores · ` +
      `RAM ${freeGb.toFixed(1)} GB free of ${totalGb.toFixed(0)} GB · ${verdict}.`,
    "Heavy checks (`typecheck`, `build`, `test`, `package:mac`) take a workspace lock — `pnpm machine` shows who holds it.",
  ].join("\n");
}

export function listPeers(options: Options, includeSelf: boolean): { peers: PeerSession[]; text: string } {
  const stored = readThreads(options.threadsPath);
  const threads = selectWorkspacePeers(stored, {
    cwd: options.cwd,
    selfId: options.selfId,
    includeSelf,
  });
  // The tree is resolved against EVERY section in the workspace, not just the
  // listed ones: the most common parent of all is the caller itself, and it is
  // filtered out of the list by default. Resolving against the visible set only
  // would print "sub-thread of (id)" for exactly the relationship the caller
  // most needs named.
  const workspace = selectWorkspacePeers(stored, { cwd: options.cwd, includeSelf: true });

  const peers = threads.map((thread) =>
    summarizePeer(thread, { selfId: options.selfId, transcript: loadPeerTranscript(thread, options), threads: workspace }),
  );
  return { peers, text: renderPeerList(peers, options.cwd, options.selfId, machineHeadline()) };
}

/** Ids are long; matching a title or an id prefix makes the tool usable by hand. */
function findThread(options: Options, idOrTitle: string): PersistedThread | undefined {
  return resolveThread(options, idOrTitle).thread;
}

/**
 * `findThread`, keeping "the store could not be read" apart from "no such
 * section" for the one caller — the wait loop — that must not confuse them.
 */
function resolveThread(options: Options, idOrTitle: string): { ok: boolean; thread: PersistedThread | undefined } {
  const { ok, threads } = loadThreads(options.threadsPath);
  return { ok, thread: matchThread(selectWorkspacePeers(threads, { cwd: options.cwd, selfId: options.selfId }), idOrTitle) };
}

export type ReadPeerRequest = {
  limit?: number;
  offset?: number;
  full?: boolean;
  /** Return this one turn, whole, in `part`-sized slices. */
  turn?: number;
  part?: number;
};

export function readPeer(options: Options, idOrTitle: string, request: ReadPeerRequest): string {
  const thread = findThread(options, idOrTitle);
  if (!thread) {
    return `No section matching "${idOrTitle}" is open in ${options.cwd}. Call list_sessions first.`;
  }

  const transcript = loadPeerTranscript(thread, options);
  const peer = summarizePeer(thread, {
    selfId: options.selfId,
    transcript,
    threads: selectWorkspacePeers(readThreads(options.threadsPath), { cwd: options.cwd, includeSelf: true }),
  });

  if (request.turn !== undefined) {
    return renderPeerTurn(peer, transcript, request.turn, request.part ?? 1);
  }

  const detail = renderPeerDetail(peer, transcript, {
    limit: request.limit ?? DEFAULT_PAGE_TURNS,
    offset: request.offset ?? 0,
    full: request.full,
  });

  const inbox = renderInbox(
    readMessageJournal(options).filter((record) => record.to === thread.id),
    transcript,
  );
  return inbox ? `${detail}\n\n${inbox}` : detail;
}

/** How often `wait_for_session` re-reads the disk. Cheap; the files are small. */
const WAIT_POLL_MS = 2_000;
const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 600_000;

/**
 * Block until a section is done, instead of making the caller build a timer.
 *
 * Polling was the only option before this, and in a harness where a foreground
 * sleep is refused, "poll" means burning model turns on background timers and
 * guessing between them. One call that returns when there is something to read
 * removes the guessing and the turns.
 */
export async function waitForSession(
  options: Options,
  idOrTitle: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<string> {
  const deadline = now() + Math.min(Math.max(timeoutMs, 1_000), MAX_WAIT_MS);
  let confirmedMisses = 0;

  for (;;) {
    const { ok, thread } = resolveThread(options, idOrTitle);
    if (!thread) {
      // A section cannot un-exist and come back, so one glance saying it is gone
      // is far more likely to be a bad read of the store than the truth. Only a
      // readable store counts as evidence, and only twice in a row: this loop is
      // the last thing standing between a parent and a sub-thread it will
      // otherwise abandon while the sub-thread is still working.
      confirmedMisses = ok ? confirmedMisses + 1 : 0;
      if (confirmedMisses >= 2) {
        return `No section matching "${idOrTitle}" is open in ${options.cwd}. Call list_sessions first.`;
      }

      if (now() >= deadline) {
        return `Still could not resolve "${idOrTitle}" in ${options.cwd} before the wait ran out. Call list_sessions and try again.`;
      }
      await sleep(WAIT_POLL_MS);
      continue;
    }

    confirmedMisses = 0;

    const transcript = loadPeerTranscript(thread, options);
    const status = peerStatus(thread, transcript, now());
    if (isWaitingForInput(status)) {
      const reason = status.reason ? ` (${status.reason})` : "";
      return [
        `Section "${thread.title}" (\`${thread.id}\`) is **idle**${reason}.`,
        `${transcript.turns.length} turn${transcript.turns.length === 1 ? "" : "s"} are readable so far.`,
        "It has NOT finished — resolve the requested input before expecting a result.",
      ].join(" ");
    }

    if (isSettled(status, transcript)) {
      const reason = status.reason ? ` (${status.reason})` : "";
      const settled =
        status.state === "idle"
          ? `is **idle** — it has answered and is waiting for a prompt${reason}`
          : `is **${status.state}**${reason}`;
      return [
        `Section "${thread.title}" (\`${thread.id}\`) ${settled}.`,
        `${transcript.turns.length} turn${transcript.turns.length === 1 ? "" : "s"} are readable; call read_session with that id to read them.`,
      ].join(" ");
    }

    if (now() >= deadline) {
      return [
        `Section "${thread.title}" (\`${thread.id}\`) is still **${status.state}** after the wait.`,
        `${transcript.turns.length} turn${transcript.turns.length === 1 ? "" : "s"} are readable so far.`,
        "It has NOT failed — call wait_for_session again to keep waiting.",
      ].join(" ");
    }

    await sleep(WAIT_POLL_MS);
  }
}

/** How long to wait for the app to accept and route a message. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Ask the running app to do something only it can do.
 *
 * Listing peers is a disk read this process can do alone; sending a message and
 * opening a section are not — the app owns the live transports and the section
 * list — so these are the two places the helper needs the app to be up. It is,
 * whenever an agent is running: the app is what spawned the agent.
 */
function callApp(options: Options, payload: Record<string, unknown>, unavailable: string): Promise<string> {
  return new Promise((resolve) => {
    if (!options.socketPath) {
      resolve(unavailable);
      return;
    }

    const socket = connect(options.socketPath);
    let response = "";
    let settled = false;
    const finish = (message: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(message);
    };

    const timer = setTimeout(() => finish("The app did not answer in time; the request may not have been carried out."), SEND_TIMEOUT_MS);
    timer.unref?.();

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ ...payload, from: options.selfId, cwd: options.cwd })}\n`);
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline)) as { ok?: boolean; message?: string };
        // The `ok` flag is not cosmetic: a refused message has to read as a
        // failure, not as a success with a sad sentence in it.
        finish(parsed.ok ? (parsed.message ?? "Done.") : `FAILED: ${parsed.message ?? "the request was not carried out."}`);
      } catch {
        finish("The app sent back a malformed reply; the request may not have been carried out.");
      }
      clearTimeout(timer);
    });
    socket.on("error", (error: Error) => {
      clearTimeout(timer);
      finish(`Could not reach the Panda Code app: ${error.message}`);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      finish("The app closed the connection before answering; the request may not have been carried out.");
    });
  });
}

export function sendPeerMessage(options: Options, target: string, text: string): Promise<string> {
  return callApp(
    options,
    { op: "send", to: target, text },
    "Messaging is unavailable: this helper was started without a socket to the app.",
  );
}

/** Publish a model-generated title for the calling section. */
export function setSectionTitle(options: Options, title: string): Promise<string> {
  return callApp(
    options,
    { op: "title", title },
    "Section naming is unavailable: this helper was started without a socket to the app.",
  );
}

export type AttentionCall = {
  userRequested?: boolean;
  summary: string;
  detail?: string;
  severity?: string;
  choices?: Array<{ label: string; response: string }>;
};

/** Interrupt the user's desktop only for a genuinely time-sensitive decision. */
export function requestAttention(options: Options, request: AttentionCall): Promise<string> {
  return callApp(
    options,
    { op: "attention", ...request },
    "Attention requests are unavailable: this helper was started without a socket to the app.",
  );
}

export type NewSectionRequest = {
  task: string;
  title?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** `subthread` (default) nests it under the caller; `sibling` opens it alongside. */
  mode?: string;
};

/** Open a section in this workspace — under the caller or beside it — and hand it an opening task. */
export function createPeerSection(options: Options, request: NewSectionRequest): Promise<string> {
  return callApp(
    options,
    { op: "create", ...request },
    "Opening sections is unavailable: this helper was started without a socket to the app.",
  );
}

export type BrowserCall = {
  action: string;
  tab?: string;
  url?: string;
  selector?: string;
  text?: string;
  links?: boolean;
  /** read: report form-control state alongside the text. */
  values?: boolean;
  submit?: boolean;
  /** type: empty the field first. note: take the note back off the page. */
  clear?: boolean;
  /** inspect: narrow by ARIA role, and to a subtree. */
  role?: string;
  within?: string;
  button?: string;
  clickCount?: number;
  timeout?: number;
  keys?: string;
  to?: string;
  deltaY?: number;
  start?: string;
  end?: string;
  /** cursor: where to aim, in page CSS pixels, and where a drag ends. */
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  toX?: number;
  toY?: number;
  toSelector?: string;
  toText?: string;
  value?: string;
  label?: string;
  paths?: string[];
  mode?: string;
  fps?: number;
  background?: boolean;
  limit?: number;
};

/**
 * Drive the browser the user is looking at.
 *
 * The most app-bound of all these calls: the browser is a window, not a file, so
 * unlike the backlog there is no disk fallback and nothing to do when the app is
 * closed. Every action is one round trip — the app runs it, waits for the page
 * to settle, and answers with what the agent should read.
 */
export function callBrowser(options: Options, call: BrowserCall): Promise<string> {
  return callApp(
    options,
    { op: "browser", ...call },
    "The browser is unavailable: this helper was started without a socket to the app.",
  );
}

/**
 * The workspace backlog, agent side.
 *
 * Like listing peers and unlike sending a message, this is a plain disk job: the
 * board is a file, and going through the app would make an agent's `backlog_add`
 * fail whenever the desktop is busy or closed. The app watches the directory, so
 * a board open on screen updates itself within a tick of a write landing here.
 */
function backlogUnavailable(): string {
  return "The workspace backlog is unavailable: this helper was started without a backlog directory. Update Panda Code, or open a new section.";
}

/** The name a card is filed under, so the board says who asked for it. */
function selfLabel(options: Options): string | undefined {
  if (!options.selfId) {
    return undefined;
  }
  // The title, or nothing: a card reading "filed by agent" is honest, while one
  // reading "filed by 45cce0ae-…" is a uuid on a whiteboard.
  return readThreads(options.threadsPath).find((candidate) => candidate.id === options.selfId)?.title;
}

export function listBacklog(options: Options, column?: string): string {
  if (!options.backlogDir) {
    return backlogUnavailable();
  }
  const normalized = column === undefined ? undefined : normalizeColumn(column);
  if (column !== undefined && !normalized) {
    return `Unknown column ${JSON.stringify(column)}. Use one of: ${BACKLOG_COLUMNS.join(", ")}.`;
  }

  const store = createBacklogStore(options.backlogDir);
  return renderBacklog(store.read(options.cwd) ?? emptyBacklog(options.cwd), normalized);
}

export type BacklogAttachmentRequest = { path: string; caption?: string };

export type BacklogAddRequest = {
  title: string;
  summary?: string;
  description?: string;
  metadata?: string;
  column?: string;
  verificationNotes?: string;
  attachments?: BacklogAttachmentRequest[];
  epicId?: string;
};

/**
 * Copy every requested attachment in, stopping (and rolling back what it
 * already copied) at the first one that fails — a screenshot that does not
 * exist should not silently drop the ones that did.
 */
function resolveAttachments(
  options: Options,
  requests: BacklogAttachmentRequest[] | undefined,
): { ok: true; attachments: BacklogAttachment[] } | { ok: false; message: string } {
  if (!requests?.length || !options.backlogDir) {
    return { ok: true, attachments: [] };
  }
  const resolved: BacklogAttachment[] = [];
  for (const request of requests) {
    const attached = attachBacklogFile(options.backlogDir, request.path, { caption: request.caption, createdBySection: selfLabel(options) });
    if (!attached.ok) {
      deleteBacklogAttachmentFiles(resolved);
      return { ok: false, message: attached.message };
    }
    resolved.push(attached.attachment);
  }
  return { ok: true, attachments: resolved };
}

export function addBacklog(options: Options, request: BacklogAddRequest): string {
  if (!options.backlogDir) {
    return backlogUnavailable();
  }

  const { attachments: attachmentRequests, ...rest } = request;
  const attached = resolveAttachments(options, attachmentRequests);
  if (!attached.ok) {
    return `FAILED: ${attached.message}`;
  }

  // Linked to the section that filed it, not just labelled with its title:
  // the label is for reading, the id is what the app resolves back to a live
  // section — so the user can get from the card to the conversation it came
  // out of, months later, from a title that has since been renamed.
  const result = backlogStoreAdd(createBacklogStore(options.backlogDir), options.cwd, {
    ...rest,
    createdBy: "agent",
    createdBySection: selfLabel(options),
    sections: options.selfId ? [options.selfId] : undefined,
    attachments: attached.attachments.length > 0 ? attached.attachments : undefined,
    // Agent side, so the evidence bar on `done` applies. The app's own path
    // (`index.ts`) deliberately does not set this: the user is the review step.
    requireEvidence: true,
  });
  if (!result.ok) {
    deleteBacklogAttachmentFiles(attached.attachments);
  }
  return result.ok && result.item ? `${result.message}\n\n${renderBacklogItemDetail(result.item)}` : `FAILED: ${result.message}`;
}

export type BacklogUpdateRequest = {
  title?: string;
  summary?: string;
  description?: string;
  metadata?: string;
  column?: string;
  onHold?: boolean;
  verificationNotes?: string;
  addAttachments?: BacklogAttachmentRequest[];
  removeAttachmentIds?: string[];
  epicId?: string | null;
  addVerificationScenario?: {
    title: string;
    setup: string;
    actions: string;
    expectedOutcome: string;
    actualOutcome: string;
    outcome: VerificationOutcome;
    verificationType: string;
    evidenceAttachmentIds?: string[];
    coverageLimits?: string;
    createdBySection?: string;
  };
};

export function updateBacklog(options: Options, idOrTitle: string, patch: BacklogUpdateRequest): string {
  if (!options.backlogDir) {
    return backlogUnavailable();
  }

  const { addAttachments: attachmentRequests, ...rest } = patch;
  const attached = resolveAttachments(options, attachmentRequests);
  if (!attached.ok) {
    return `FAILED: ${attached.message}`;
  }

  // Touching a card is the honest signal that this section is working on it —
  // marking it in_progress most of all — so the link comes free with the edit.
  const result = backlogStoreUpdate(createBacklogStore(options.backlogDir), options.cwd, idOrTitle, {
    ...rest,
    linkSection: options.selfId,
    addAttachments: attached.attachments.length > 0 ? attached.attachments : undefined,
    requireEvidence: true,
  });
  if (!result.ok) {
    deleteBacklogAttachmentFiles(attached.attachments);
  }
  return result.ok && result.item ? `${result.message}\n\n${renderBacklogItemDetail(result.item)}` : `FAILED: ${result.message}`;
}

export function deleteBacklog(options: Options, idOrTitle: string): string {
  if (!options.backlogDir) {
    return backlogUnavailable();
  }

  const result = backlogStoreDelete(createBacklogStore(options.backlogDir), options.cwd, idOrTitle);
  return result.ok ? result.message : `FAILED: ${result.message}`;
}

export function listEpics(options: Options): string {
  if (!options.backlogDir) return backlogUnavailable();
  return renderEpics(createBacklogStore(options.backlogDir).read(options.cwd));
}

export function addEpic(options: Options, input: { title: string; summary?: string; scope?: string; acceptanceCriteria?: string; acceptanceScenario?: string }): string {
  if (!options.backlogDir) return backlogUnavailable();
  const result = backlogStoreAddEpic(createBacklogStore(options.backlogDir), options.cwd, input);
  return result.ok ? `${result.message}\n\n${renderEpics(result.backlog)}` : `FAILED: ${result.message}`;
}

export function updateEpic(options: Options, id: string, patch: { title?: string; summary?: string; scope?: string; acceptanceCriteria?: string; acceptanceScenario?: string }): string {
  if (!options.backlogDir) return backlogUnavailable();
  const result = backlogStoreUpdateEpic(createBacklogStore(options.backlogDir), options.cwd, id, patch);
  return result.ok ? `${result.message}\n\n${renderEpics(result.backlog)}` : `FAILED: ${result.message}`;
}

export function deleteEpic(options: Options, id: string): string {
  if (!options.backlogDir) return backlogUnavailable();
  const result = backlogStoreDeleteEpic(createBacklogStore(options.backlogDir), options.cwd, id);
  return result.ok ? result.message : `FAILED: ${result.message}`;
}

function resolveEpicId(options: Options, value: string | undefined): string | undefined {
  if (!value || !options.backlogDir) return undefined;
  return findBacklogEpic(createBacklogStore(options.backlogDir).read(options.cwd), value)?.id;
}

/**
 * The workspace schedule, agent side — same file-based reasoning as the
 * backlog functions above: `schedule_add` runs in this out-of-process helper,
 * and going through the app would make it fail whenever the desktop is busy
 * or closed. The in-process ticker (see `index.ts`) is the only piece that
 * actually needs the app running, since it is the one that fires a job.
 */
function scheduleUnavailable(): string {
  return "The workspace schedule is unavailable: this helper was started without a schedule directory. Update Panda Code, or open a new section.";
}

export function listSchedule(options: Options): string {
  if (!options.scheduleDir) {
    return scheduleUnavailable();
  }
  const store = createScheduleStore(options.scheduleDir);
  return renderSchedule(store.read(options.cwd) ?? emptySchedule(options.cwd));
}

export type ScheduleAddRequest = { title: string; prompt: string; frequency: ScheduleFrequency };

export function addSchedule(options: Options, request: ScheduleAddRequest): string {
  if (!options.scheduleDir) {
    return scheduleUnavailable();
  }
  const store = createScheduleStore(options.scheduleDir);
  const result = scheduleStoreAdd(store, options.cwd, { ...request, createdBy: "agent", createdBySection: selfLabel(options) });
  return result.ok && result.item ? `${result.message}\n\n${renderScheduledTaskDetail(result.item)}` : `FAILED: ${result.message}`;
}

export type ScheduleUpdateRequest = { title?: string; prompt?: string; frequency?: ScheduleFrequency; enabled?: boolean };

export function updateSchedule(options: Options, idOrTitle: string, patch: ScheduleUpdateRequest): string {
  if (!options.scheduleDir) {
    return scheduleUnavailable();
  }
  const store = createScheduleStore(options.scheduleDir);
  const result = scheduleStoreUpdate(store, options.cwd, idOrTitle, patch);
  return result.ok && result.item ? `${result.message}\n\n${renderScheduledTaskDetail(result.item)}` : `FAILED: ${result.message}`;
}

export function deleteSchedule(options: Options, idOrTitle: string): string {
  if (!options.scheduleDir) {
    return scheduleUnavailable();
  }
  const store = createScheduleStore(options.scheduleDir);
  const result = scheduleStoreDelete(store, options.cwd, idOrTitle);
  return result.ok ? result.message : `FAILED: ${result.message}`;
}

const COLUMN_ENUM: readonly BacklogColumn[] = ["backlog", "in_progress", "review", "done"];

const FREQUENCY_SCHEMA = {
  type: "object",
  description: 'One of three shapes: { "type": "hourly", "everyHours": N }, { "type": "daily", "time": "HH:MM" } (24h, local time), or { "type": "once", "at": ISO-timestamp }.',
  properties: {
    type: { type: "string", enum: ["hourly", "daily", "once"] },
    everyHours: { type: "number", description: "hourly only: 1-168." },
    time: { type: "string", description: 'daily only: "HH:MM", 24h, local time.' },
    at: { type: "string", description: "once only: an ISO-8601 timestamp, in the future." },
  },
  required: ["type"],
} as const;

const TOOLS = [
  {
    name: "list_sessions",
    description:
      "List the other Panda Code sections (agent sessions) open in this workspace, with the state of each one (running / idle / finished / failed), the command each running section is executing right now, how many transcript turns are readable, and an excerpt of its latest exchange. It also reports the shared machine's load and free memory. Use it before starting work that another section may already be doing, and before starting anything expensive — a build, a full typecheck, a test sweep — since every section runs on one laptop. Sections the user has starred are marked ★: those are standing sections kept on purpose, often the one holding a device, a logged-in app or a long-running investigation — the section to `send_message` when you need something only it can see.",
    inputSchema: {
      type: "object",
      properties: {
        includeSelf: { type: "boolean", description: "Include this section in the list. Defaults to false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_session",
    description:
      "Read the conversation of one section in this workspace, by the id or title from list_sessions. Pages: the newest turns come first, `offset` steps back through older ones, and any turn shortened for length says so and can be fetched whole with `turn`. Nothing is ever dropped silently.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Section id, or a title fragment." },
        limit: { type: "number", description: "Turns per page. Defaults to 12, maximum 100." },
        offset: { type: "number", description: "Turns to step back from the newest. 0 (default) is the latest page." },
        full: { type: "boolean", description: "Return every turn on the page whole, however long. Defaults to false." },
        turn: { type: "number", description: "Return this single turn in full, by the turn number shown in a page." },
        part: { type: "number", description: "With `turn`: which slice of a very long turn to return. Defaults to 1." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_session",
    description:
      "Block until a section in this workspace reaches a terminal state (finished or failed), then report it. Use this instead of polling list_sessions on a timer when you are waiting on a section you opened. Returns early with the current state if the wait runs out — that is not a failure, just call it again.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Section id, or a title fragment, from list_sessions." },
        timeout: { type: "number", description: "Seconds to wait before returning with a progress report. Defaults to 120, maximum 600." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Send a message, instruction or course-correction to another section in this workspace. It arrives as that section's next prompt, labelled as coming from you (and, when you are its parent or its sub-thread, labelled as that too). The result says whether the target could actually receive it — a section that cannot is an error, not a silent no-op — and the next read_session of that section reports whether it has been read. Use it to report a sub-thread's result to your parent (id \"parent\"), steer a sub-thread you opened, hand off work, warn a neighbour off a file you are rewriting, or answer something another section asked you — not for chatter.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Section id, or a title fragment, from list_sessions. The literal \"parent\" reaches the section this one is a sub-thread of, without a lookup — that is how a sub-thread reports its result back.",
        },
        message: { type: "string", description: "What to tell that section. Be specific: it has none of your context." },
      },
      required: ["id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "request_attention",
    description:
      "Pull Panda Code to the front with a compact urgent hand-off from THIS section: a short TL;DR, optional detail, and up to three quick replies. Use this only when waiting would materially waste time or leave important work blocked (for example an aborted release that needs a decision), then stop and wait for the user's response. Respect the section’s Agent attention switch. When disabled, only an explicit user request permits userRequested=true. Without an explicit user request, do not use it for ordinary completion, status, or chatter. An explicit request to notify on completion is allowed. A quick reply is an ordinary user prompt; it does not bypass approvals or authorize destructive, paid, publishing, or external-message actions.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The decision or blocker in one or two short lines (maximum 240 characters)." },
        detail: { type: "string", description: "Optional context needed to choose, maximum 800 characters." },
        userRequested: { type: "boolean", description: "True only when the user explicitly asked for agent attention; permits that request even when the channel is disabled." },
        severity: { type: "string", enum: ["important", "urgent"], description: "Defaults to urgent." },
        choices: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short button label." },
              response: { type: "string", description: "Prompt sent back to this section when selected." },
            },
            required: ["label", "response"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "create_session",
    description:
      "Open a NEW Panda Code section in this workspace and give it a task, with its own transcript and its own agent process. Two shapes, and you choose: mode 'subthread' (the default) hangs it UNDER this section — the user sees it nested beneath yours in the sidebar and on their phone, and you remain answerable for the outcome; mode 'sibling' opens it ALONGSIDE this one as an independent section the user steers themselves, which is right when the work is a separate errand rather than a piece of what you were asked for. Either way it is a real section the user can open, read and steer — not a hidden subagent. You are NOT notified when it finishes — call wait_for_session to block until it does, or read it when you next need its result; you are only interrupted if it becomes blocked waiting for input. Do not open one for work you can simply do yourself.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The opening prompt for the new section. It starts empty and has none of your context, so state the goal, the files or commands involved, and what done looks like.",
        },
        title: { type: "string", description: "Short name for the section in the sidebar, e.g. \"Flaky test hunt\"." },
        mode: {
          type: "string",
          enum: ["subthread", "sibling"],
          description:
            "'subthread' (default): nested under this section, reports back to you, you own the result. 'sibling': independent, top-level, the user steers it. Sub-threads nest at most 3 levels deep; past that a requested sub-thread is opened as a sibling and the reply says so.",
        },
        runtime: { type: "string", enum: ["claude", "codex"], description: "Agent to run it on. Defaults to the one you are running on." },
        model: { type: "string", description: "Model override. Defaults to yours." },
        effort: { type: "string", description: "Reasoning effort override. Defaults to yours." },
        permissionMode: {
          type: "string",
          description:
            "Permission/sandbox mode to carry into the new section. Defaults to yours and cannot be more permissive than yours.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "backlog_list",
    description:
      "Read this workspace's backlog board — the shared, persistent task list for this project folder, with columns backlog, in_progress, review and done (plus a `pending` triage inbox, shown only when automation has filed something into it). It outlives every section, and the user sees the same board in the app. Read it when the user refers to work that was agreed earlier ('the thing we said we'd do about X'), before proposing what to work on next, and before filing an item so you do not duplicate one that is already there.",
    inputSchema: {
      type: "object",
      properties: {
        column: { type: "string", enum: COLUMN_ENUM, description: "Only this column. Omit for the whole board." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "backlog_add",
    description:
      "File a new item on this workspace's backlog board. Use it when the user describes work to do LATER — a follow-up, a deferred fix, an idea they want kept — or when you find something worth doing that is outside what you were asked for. Do not file the task you are already doing, and do not file it as a way of avoiding work you were asked to finish. The user sees the card immediately, tagged as filed by you.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line, as the user would say it. This is what shows on the card." },
        summary: {
          type: "string",
          description:
            "One-sentence TL;DR: what this is and where it stands, for someone deciding whether to open the card. Always write one — the description can be long, this cannot.",
        },
        description: {
          type: "string",
          description:
            "What the work is, and enough context for whoever picks it up cold. Rendered as Markdown in the app: use headings, bullet lists, `code`, and links, and keep paragraphs short.",
        },
        metadata: {
          type: "string",
          description: "Free-form notes the board takes no position on — files involved, an estimate, a label, a link. Optional.",
        },
        column: { type: "string", enum: COLUMN_ENUM, description: "Where it lands. Defaults to backlog." },
        verificationNotes: {
          type: "string",
          description:
            "The evidence for this card, distinct from the description — what you actually checked, and what you did NOT. Paste the command and its real output for a backend change; pair with `attachments` for anything with pixels.",
        },
        epic: { type: "string", description: "Optional Epic reference such as E2, or an unambiguous Epic title." },
        attachments: {
          type: "array",
          description:
            "Screenshots or recordings to pin to the card, most often the output of browser_screenshot or browser_record — pass the file path it gave you, the file is copied in. png, jpg, gif, webp, mp4, mov, webm only.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path to the file, e.g. what browser_screenshot returned." },
              caption: { type: "string", description: "One line about what it shows. Optional." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "backlog_update",
    description:
      "Change a backlog item, or move it between columns — this is how you mark work started ('in_progress') and finished ('review'). Fields you omit are left as they are. Whenever you rewrite the description, rewrite the summary with it so the TL;DR does not describe an older state of the work.\n\nWhen the work is done, move it to 'review', not 'done': record what you actually checked and attach whatever shows it, then leave the card for the user. 'done' is their call once they have looked. This is enforced, not advice — an attachment by itself is not a verification result.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The card number shown by backlog_list — \"#12\" or \"12\" — or an unambiguous piece of the title. A `#12` the user typed names this card." },
        title: { type: "string" },
        summary: { type: "string", description: "One-sentence TL;DR of the card as it now stands." },
        description: { type: "string", description: "Markdown body. Replaces the current one." },
        metadata: { type: "string" },
        column: {
          type: "string",
          enum: COLUMN_ENUM,
          description: "'in_progress' when you start, 'review' when you finish and have the evidence to show for it. Only the user moves a card to 'done'.",
        },
        onHold: {
          type: "boolean",
          description:
            "Park the card (true) or bring it back (false). Held cards keep their column but drop out of the board and out of backlog_list's columns — they are kept, deliberately not to be worked on now. Park one only when the user says to set it aside; never as a way of clearing work you were asked to do.",
        },
        verificationNotes: {
          type: "string",
          description:
            "The evidence for this card, in Markdown — what you actually checked, and what you did NOT. For a backend or CLI change, paste the command and its real output in a fenced block. For a UI change, describe what the attached screenshot shows. 'It compiles' and 'tests pass' without the output are claims, not evidence. Replaces the current note.",
        },
        epic: { type: "string", description: "Epic reference to assign. Use an empty string to remove membership." },
        addAttachments: {
          type: "array",
          description:
            "Screenshots or recordings to add to the card, most often the output of browser_screenshot or browser_record — pass the file path it gave you, the file is copied in. png, jpg, gif, webp, mp4, mov, webm only. Additive: existing attachments are kept.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path to the file, e.g. what browser_screenshot returned." },
              caption: { type: "string", description: "One line about what it shows. Optional." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
        removeAttachmentIds: {
          type: "array",
          items: { type: "string" },
          description: "Ids of attachments to drop, from the ids backlog_list/backlog_update show for this card.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "backlog_verify",
    description:
      "Append one scenario-based verification attempt to a card. Attempts are historical and immutable; the newest is shown as Latest. Record the actual result honestly—passed, failed, blocked, or not_run—and reference existing attachment ids rather than duplicating files.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Card number, id, or unambiguous title." },
        title: { type: "string" },
        setup: { type: "string", description: "Environment plus relevant build or revision." },
        actions: { type: "string" },
        expectedOutcome: { type: "string" },
        actualOutcome: { type: "string" },
        outcome: { type: "string", enum: ["passed", "failed", "blocked", "not_run"] },
        verificationType: { type: "string", description: "For example live_e2e, mocked, renderer_only, installed_app, unit, or api." },
        evidenceAttachmentIds: { type: "array", items: { type: "string" } },
        coverageLimits: { type: "string", description: "What remains unverified or what this scenario does not cover." },
      },
      required: ["id", "title", "setup", "actions", "expectedOutcome", "actualOutcome", "outcome", "verificationType"],
      additionalProperties: false,
    },
  },
  {
    name: "epic_list",
    description: "List this workspace's Epics, progress counts, blocked work, overall acceptance scenario, and member cards grouped by status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "epic_add",
    description: "Create a flat outcome-level Epic. Epics group existing cards; they do not own or nest conversation sections.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, summary: { type: "string" }, scope: { type: "string" },
        acceptanceCriteria: { type: "string" }, acceptanceScenario: { type: "string" },
      },
      required: ["title"], additionalProperties: false,
    },
  },
  {
    name: "epic_update",
    description: "Edit an Epic's title, summary, scope/outcome, acceptance criteria, or overall acceptance scenario.",
    inputSchema: {
      type: "object", properties: {
        id: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, scope: { type: "string" },
        acceptanceCriteria: { type: "string" }, acceptanceScenario: { type: "string" },
      }, required: ["id"], additionalProperties: false,
    },
  },
  {
    name: "epic_delete",
    description: "Delete an Epic and remove membership from its cards without deleting those cards or their evidence.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "backlog_delete",
    description:
      "Remove an item from this workspace's backlog board. Deleting is not the same as finishing: work that got done belongs in the done column, where the user can still see it. Delete only what the user says is no longer wanted, or what you filed by mistake.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The card number shown by backlog_list — \"#12\" or \"12\" — or an unambiguous piece of the title. A `#12` the user typed names this card." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_list",
    description:
      "Read this workspace's schedule — recurring or one-off jobs that open a new section with a prompt when they come due. It outlives every section, and the user sees the same schedule in the app and on their phone. Read it before proposing recurring or deferred work, so you do not duplicate a job that already exists.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "schedule_add",
    description:
      "Create a new scheduled job in this workspace. Use it when the user wants something to run automatically later — a recurring check, a daily summary, a one-off reminder at a specific time — not for work to do right now. Jobs only fire while the desktop app is running. Write the prompt as a complete, standalone instruction: the section that receives it will have none of this conversation's context.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line, as the user would say it. Shown on the schedule." },
        prompt: { type: "string", description: "The opening prompt the new section receives when this job fires." },
        frequency: FREQUENCY_SCHEMA,
      },
      required: ["title", "prompt", "frequency"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_update",
    description:
      "Change a scheduled job, reschedule it, or turn it on/off. Fields you omit are left as they are.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The short id shown by schedule_list, or an unambiguous piece of the title." },
        title: { type: "string" },
        prompt: { type: "string" },
        frequency: FREQUENCY_SCHEMA,
        enabled: { type: "boolean", description: "Turn the job on or off without deleting it." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "machine_status",
    description:
      "Read the shared machine's current state in detail: CPU load, memory and swap pressure, disk headroom, and the heaviest processes right now with their pids. `list_sessions` gives the one-line headline; call this when you need the detail — before starting a build or a full typecheck on a box that may already be saturated, or when a command of yours is taking far longer than it should and you want to see what it is competing with. A process at the top of this list is usually another section's work, so waiting for it to finish beats killing it.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Processes to list per table. Defaults to 8, maximum 12." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "schedule_delete",
    description: "Remove a scheduled job from this workspace. Delete only what the user says is no longer wanted, or what you filed by mistake.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The short id shown by schedule_list, or an unambiguous piece of the title." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  // ---------------------------------------------------------------------------
  // The browser tools.
  //
  // Descriptions here are load-bearing rather than decorative: they are the only
  // thing an agent reads before deciding whether to open a page on the user's
  // screen, so each one says what the tool is FOR and what it costs the user,
  // not just what it does. Every call is one round trip over the peer socket to
  // the running app (`callBrowser`); the shape of the system is documented in
  // `shared/browser.ts`.
  // ---------------------------------------------------------------------------
  {
    name: "browser_list",
    description:
      "List the tabs open in THIS section's browser. This is a real, visible browser inside the app that you and the user drive TOGETHER: it runs in their session with their logins, they watch what you do in it, and they can take the keyboard at any moment. Tabs are scoped to a section like terminals are — you see and drive your own, and another section's are not yours to touch. Read this before opening a tab, so you reuse one that is already on the right page.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open",
    description:
      "Open a new tab in the built-in browser and bring the panel to the front. Use it when the user asks you to look at, check, or work on something on the web, when a task needs a page they are logged into, or when you want to SHOW them something rather than describe it. Not a substitute for WebFetch on a page you only need to read once — it costs the user screen space and their attention. Waits for the page to load before answering.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open. A bare host gets https://; anything that is not address-shaped is searched for." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_navigate",
    description: "Point an existing tab at a new URL and wait for it to load. Prefer this over opening more tabs.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id from browser_list. Defaults to the tab the user is looking at." },
        url: { type: "string", description: "Where to go." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_read",
    description:
      "Read a tab's current page as text — what a reader sees, with scripts and markup stripped. Long pages are clipped, so narrow with `selector` when you know where to look. This is how you find out what happened after a click or a form submission.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        selector: { type: "string", description: "CSS selector to read instead of the whole page." },
        links: { type: "boolean", description: "Also list the page's links. Defaults to false." },
        values: {
          type: "boolean",
          description:
            "Also report the state of the form controls — what is actually IN each field, what is checked, what a dropdown is set to. Rendered text cannot tell you that, so use it to confirm your own edit from the DOM instead of from a screenshot. Defaults to false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_inspect",
    description:
      "Report the STATE of elements rather than the words on the page: tag, ARIA role, accessible name, value, checked/selected/expanded, disabled, whether it is on screen, and — for each match — a CSS selector that will address it again. Two uses. (1) Verification: read back what a field now contains after you typed into it, which browser_read cannot tell you. (2) Discovery: on a site with hashed class names you cannot guess a selector, so ask by visible `text` or by `role` and get a real handle to act on. With no arguments it reports every form control on the page.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        selector: { type: "string", description: "CSS selector to inspect. Shadow DOM and iframes are searched too." },
        text: { type: "string", description: "Visible text to find elements by, when you have a label but no selector." },
        role: { type: "string", description: 'ARIA role to list, e.g. "combobox", "button", "textbox" — how you find the div-based controls that are not <select> or <input>.' },
        within: { type: "string", description: "CSS selector of a subtree to restrict the report to." },
        limit: { type: "number", description: "Most matches to report. Defaults to 30, maximum 100." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description:
      "Click something in a tab, named either by CSS selector or by the visible text on it (\"Save\", \"Accept\"). Sends a real mouse event at the element, so flows that browsers gate on genuine user input still work. Remember the user is watching: do not click through anything irreversible, paid, or destructive without their say-so.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        selector: { type: "string", description: "CSS selector of the element to click. Shadow DOM and iframes are searched too." },
        text: { type: "string", description: "Visible text of the control, when you do not have a selector." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left. `right` opens a context menu." },
        clickCount: { type: "number", description: "2 for a double-click, 3 for a triple. Defaults to 1." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "Type into a field in a tab. The field is focused and cleared first (unless `clear` is false), then the text is inserted as if typed. Never type a credential: the browser holds the user's own logged-in session, so if a site wants a password, leave a note with browser_note and let them do it.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        selector: { type: "string", description: "CSS selector of the input, textarea or contenteditable." },
        text: { type: "string", description: "What to type." },
        submit: { type: "boolean", description: "Press Enter afterwards and wait for the page. Defaults to false." },
        clear: { type: "boolean", description: "Empty the field first. Defaults to true." },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a tab as a PNG and return the file path, which you can then read as an image. Use it when the page's meaning is visual — a layout, a chart, a rendered design — where browser_read would only give you the words. By default it brings the tab to the front of the panel first, which is what the user sees; pass background:true to capture without touching their screen.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        background: {
          type: "boolean",
          description:
            "Capture without revealing the panel or switching the front tab — the page is rendered rather than photographed, so it works on a hidden tab. Use it for a check you do not need the user to watch. The app window still has to be open, and the tab must not have been slept. Defaults to false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_note",
    description:
      "Leave the page for the user to look at, with a note saying what you want from them. This is the hand-off: it brings the browser to the front, pins your note to the tab, draws it onto the page and — if you name a selector — rings and scrolls to the exact element. Use it when the next step is genuinely theirs: a login, a payment, a consent, a judgement call, or 'here is what I did, check it'. They get a Resolve button, and when they use it you receive a message saying so — so leave the note, say in your reply that you are waiting on them, and stop. Do NOT poll for it.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        text: { type: "string", description: "What you want them to see or do. One or two sentences, specific." },
        selector: { type: "string", description: "CSS selector of the thing you are pointing at, if there is one." },
        clear: {
          type: "boolean",
          description:
            "Take your own note back off the page instead of leaving one — for when you left a note, then found you could carry on after all. Only clears a note this section left; the user's Resolve is what clears one they still owe you an answer on.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_close",
    description: "Close a tab. Close the tabs you opened when you are done with them; leave alone any the user opened.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id from browser_list." },
      },
      required: ["tab"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_back",
    description: "Go back one page in a tab's history, and wait for it to load.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait",
    description:
      "Wait for something to appear on the page, by CSS selector or by visible text, then report it. A page load is not the same as a page being ready — anything that renders after fetching (most apps) needs this, and it is the fix for a browser_read that came back with a spinner in it. Returns as soon as the thing is there.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        selector: { type: "string", description: "CSS selector to wait for." },
        text: { type: "string", description: "Visible text to wait for, when you do not have a selector." },
        timeout: { type: "number", description: "Seconds to wait. Defaults to 10, maximum 60." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    description:
      "Move the mouse onto an element without clicking, so whatever it reveals — a dropdown menu, a tooltip, a row's action buttons — appears. Follow it with browser_read to see what showed up.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        selector: { type: "string", description: "CSS selector of the element to hover." },
        text: { type: "string", description: "Visible text of it, when you do not have a selector." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_drag",
    description: "Drag one element onto another — reordering a list, moving a card between columns, a drag-to-upload target. Both ends are CSS selectors.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        start: { type: "string", description: "CSS selector of what to pick up." },
        end: { type: "string", description: "CSS selector of where to drop it." },
      },
      required: ["start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_key",
    description:
      "Press a key or a chord in the page: \"Escape\" to dismiss a dialog, \"Tab\" to move focus, \"ArrowDown\" then \"Enter\" to work an autocomplete, \"Cmd+A\" to select all. Modifiers are cmd, ctrl, alt and shift, joined with +.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        keys: { type: "string", description: 'The chord, e.g. "Escape", "Tab", "ArrowDown", "Cmd+A", "ctrl+shift+k".' },
      },
      required: ["keys"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_cursor",
    description:
      "Drive the tab's mouse pointer directly, in page coordinates — the way out of \"everything needs a selector\". The pointer is REAL and it PERSISTS: it stays where you put it between calls, so a hover menu stays open, a press and its release can be separate calls, and a drag follows a path rather than teleporting. Use it for what has no control to name: a canvas, a map, a chart, a custom slider, a drag handle, a menu that closes the moment the pointer leaves. Coordinates are CSS pixels relative to the viewport (not the document) — browser_screenshot tells you the page's size and scale so you can convert a point you saw in the image. Every call reports what is under the pointer, so check that before you click something you cannot see. Prefer browser_click when the thing has a selector or visible text: it is more robust than a coordinate, which goes stale the moment the layout moves.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        mode: {
          type: "string",
          enum: ["move", "click", "down", "up", "drag", "wheel", "where", "hide"],
          description:
            '"move" puts the pointer somewhere (and leaves it there), "click" presses and releases, "down"/"up" hold and release a button across separate calls, "drag" presses here and releases at the destination, "wheel" scrolls under the pointer, "where" reports the pointer and what is beneath it without touching anything, "hide" takes the drawn cursor off the page. Defaults to move.',
        },
        x: { type: "number", description: "Absolute page coordinate, CSS pixels from the left of the viewport." },
        y: { type: "number", description: "Absolute page coordinate, CSS pixels from the top of the viewport." },
        dx: { type: "number", description: "Or move relative to where the pointer already is — pixels right." },
        dy: { type: "number", description: "Or relative — pixels down." },
        selector: { type: "string", description: "Or put the pointer on this element, letting the page say where that is." },
        text: { type: "string", description: "Or on the element with this visible text." },
        toX: { type: "number", description: "drag: destination x." },
        toY: { type: "number", description: "drag: destination y." },
        toSelector: { type: "string", description: "drag: destination element instead of coordinates." },
        toText: { type: "string", description: "drag: destination named by its visible text." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left." },
        clickCount: { type: "number", description: "2 for a double-click, 3 for a triple. Defaults to 1." },
        deltaY: { type: "number", description: "wheel: pixels to scroll — positive is down." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description:
      "Scroll to \"top\", to \"bottom\", to an element named by CSS selector or by its visible `text`, or by a pixel delta. It scrolls the pane the content actually lives in, not just the window — most apps put their form inside a nested scroll container that `window.scrollBy` cannot move. You rarely need this before clicking: browser_click and browser_type scroll to their target on their own.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        to: { type: "string", description: '"top", "bottom", or a CSS selector to bring into view.' },
        text: { type: "string", description: "Visible text of the thing to bring into view, when you have a label but no selector." },
        deltaY: { type: "number", description: "Pixels to scroll by instead — positive is down." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_select_option",
    description:
      "Set a dropdown to a named option — a native <select>, or the div-based ARIA combobox that every modern component library ships instead. For a <select> it sets the value directly (clicking one does nothing useful: the native popup opens outside the page where no click can reach it). For an ARIA control it clicks the trigger, finds the option in the popup wherever the app portalled it, clicks it, and reads the control back so the result is confirmed rather than assumed. Use browser_inspect with role \"combobox\" if you need to find the trigger's selector first.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        selector: { type: "string", description: "CSS selector of the <select>, or of the combobox trigger for an ARIA dropdown." },
        value: { type: "string", description: "The option's value attribute." },
        label: { type: "string", description: "The option's visible text, when you do not know its value." },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_upload",
    description:
      "Attach files to a file input, by absolute path. Use it for an upload form the user asked you to fill. Only attach files the user has pointed you at or that you produced for this task — this puts a file from their disk onto a website.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        selector: { type: "string", description: 'CSS selector of the input, e.g. \'input[type="file"]\'.' },
        paths: { type: "array", items: { type: "string" }, description: "Absolute paths of the files to attach." },
      },
      required: ["selector", "paths"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_record",
    description:
      "Record the tab as a series of frames and, if the machine has ffmpeg, an mp4 — for showing the user a flow working end to end, or capturing a bug that only shows up in motion. Start it, do the thing, stop it: the result is a file path you can hand over. By default the browser panel has to stay visible while it records, and it stops itself after five minutes. Prefer browser_screenshot when a still would do; this writes a lot of frames to disk.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id. Defaults to the tab the user is looking at." },
        mode: { type: "string", enum: ["start", "stop"], description: "Defaults to start." },
        fps: { type: "number", description: "Frames per second, 1-10. Defaults to 2." },
        background: {
          type: "boolean",
          description:
            "Record without revealing the panel or switching the front tab. Every frame is then rendered rather than photographed, which costs real CPU — keep fps low (1-2) and the recording short. Defaults to false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_activity",
    description:
      "Read the activity log for this section's browser: every action taken in it, by you or by the user, with arguments, outcome and how long it took. Use it to work out what a page has already been through — after a click that did not do what you expected, or when picking up a tab the user was driving.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many of the newest records to return. Defaults to 40." },
      },
      additionalProperties: false,
    },
  },
] as const;

type JsonRpcRequest = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `[{ path, caption? }]` off the wire — anything else in the array is dropped rather than failing the whole call. */
function parseAttachmentRequests(value: unknown): BacklogAttachmentRequest[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const requests: BacklogAttachmentRequest[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path) continue;
    requests.push({ path, caption: typeof record.caption === "string" ? record.caption : undefined });
  }
  return requests.length > 0 ? requests : undefined;
}

function callTool(options: Options, name: string, args: Record<string, unknown>): string | Promise<string> {
  switch (name) {
    case "list_sessions":
      return listPeers(options, args.includeSelf === true).text;
    case "read_session": {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return "read_session needs an `id`. Call list_sessions first.";
      const limit = positiveNumber(args.limit);
      return readPeer(options, id, {
        limit: limit === undefined ? undefined : Math.min(limit, 100),
        offset: typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0,
        full: args.full === true,
        turn: positiveNumber(args.turn) === undefined ? undefined : Math.floor(args.turn as number),
        part: positiveNumber(args.part) === undefined ? undefined : Math.floor(args.part as number),
      });
    }
    case "wait_for_session": {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return "wait_for_session needs an `id`. Call list_sessions first.";
      const seconds = positiveNumber(args.timeout);
      return waitForSession(options, id, seconds === undefined ? DEFAULT_WAIT_MS : seconds * 1000);
    }
    case "send_message": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!id) return "send_message needs an `id`. Call list_sessions first.";
      if (!message) return "send_message needs a non-empty `message`.";
      return sendPeerMessage(options, id, message);
    }
    case "request_attention": {
      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      if (!summary) return "request_attention needs a concise `summary`.";
      const choices = Array.isArray(args.choices)
        ? args.choices.flatMap((raw) => {
            if (!raw || typeof raw !== "object") return [];
            const value = raw as Record<string, unknown>;
            return typeof value.label === "string" && typeof value.response === "string"
              ? [{ label: value.label, response: value.response }]
              : [];
          })
        : undefined;
      return requestAttention(options, {
        summary,
        userRequested: args.userRequested === true,
        detail: typeof args.detail === "string" ? args.detail : undefined,
        severity: typeof args.severity === "string" ? args.severity : undefined,
        choices,
      });
    }
    case "create_session": {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) return "create_session needs a `task`: the opening prompt for the new section.";
      return createPeerSection(options, {
        task,
        title: typeof args.title === "string" ? args.title : undefined,
        mode: typeof args.mode === "string" ? args.mode : undefined,
        runtime: typeof args.runtime === "string" ? args.runtime : undefined,
        model: typeof args.model === "string" ? args.model : undefined,
        effort: typeof args.effort === "string" ? args.effort : undefined,
        permissionMode: typeof args.permissionMode === "string" ? args.permissionMode : undefined,
      });
    }
    case "backlog_list":
      return listBacklog(options, typeof args.column === "string" ? args.column : undefined);
    case "backlog_add": {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) return "backlog_add needs a `title`.";
      const epicId = resolveEpicId(options, typeof args.epic === "string" ? args.epic : undefined);
      if (typeof args.epic === "string" && args.epic.trim() && !epicId) return `No Epic matches ${JSON.stringify(args.epic)}. Call epic_list first.`;
      return addBacklog(options, {
        title,
        summary: typeof args.summary === "string" ? args.summary : undefined,
        description: typeof args.description === "string" ? args.description : undefined,
        metadata: typeof args.metadata === "string" ? args.metadata : undefined,
        column: typeof args.column === "string" ? args.column : undefined,
        verificationNotes: typeof args.verificationNotes === "string" ? args.verificationNotes : undefined,
        attachments: parseAttachmentRequests(args.attachments),
        epicId,
      });
    }
    case "backlog_update": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return "backlog_update needs an `id` — a card number like \"#12\". Call backlog_list first.";
      return updateBacklog(options, id, {
        title: typeof args.title === "string" ? args.title : undefined,
        summary: typeof args.summary === "string" ? args.summary : undefined,
        description: typeof args.description === "string" ? args.description : undefined,
        metadata: typeof args.metadata === "string" ? args.metadata : undefined,
        column: typeof args.column === "string" ? args.column : undefined,
        onHold: typeof args.onHold === "boolean" ? args.onHold : undefined,
        verificationNotes: typeof args.verificationNotes === "string" ? args.verificationNotes : undefined,
        epicId:
          typeof args.epic === "string"
            ? args.epic.trim()
              ? (resolveEpicId(options, args.epic) ?? "__missing_epic__")
              : null
            : undefined,
        addAttachments: parseAttachmentRequests(args.addAttachments),
        removeAttachmentIds: Array.isArray(args.removeAttachmentIds) ? args.removeAttachmentIds.filter((id): id is string => typeof id === "string") : undefined,
      });
    }
    case "backlog_verify": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const outcome = typeof args.outcome === "string" ? args.outcome : "";
      if (!id || !["passed", "failed", "blocked", "not_run"].includes(outcome)) return "backlog_verify needs a card id and valid outcome.";
      return updateBacklog(options, id, {
        addVerificationScenario: {
          title: String(args.title ?? "Verification"),
          setup: String(args.setup ?? ""),
          actions: String(args.actions ?? ""),
          expectedOutcome: String(args.expectedOutcome ?? ""),
          actualOutcome: String(args.actualOutcome ?? ""),
          outcome: outcome as VerificationOutcome,
          verificationType: String(args.verificationType ?? "other"),
          evidenceAttachmentIds: Array.isArray(args.evidenceAttachmentIds) ? args.evidenceAttachmentIds.filter((value): value is string => typeof value === "string") : undefined,
          coverageLimits: typeof args.coverageLimits === "string" ? args.coverageLimits : undefined,
          createdBySection: selfLabel(options),
        },
      });
    }
    case "epic_list":
      return listEpics(options);
    case "epic_add":
      return addEpic(options, { title: String(args.title ?? ""), summary: typeof args.summary === "string" ? args.summary : undefined, scope: typeof args.scope === "string" ? args.scope : undefined, acceptanceCriteria: typeof args.acceptanceCriteria === "string" ? args.acceptanceCriteria : undefined, acceptanceScenario: typeof args.acceptanceScenario === "string" ? args.acceptanceScenario : undefined });
    case "epic_update":
      return updateEpic(options, String(args.id ?? ""), { title: typeof args.title === "string" ? args.title : undefined, summary: typeof args.summary === "string" ? args.summary : undefined, scope: typeof args.scope === "string" ? args.scope : undefined, acceptanceCriteria: typeof args.acceptanceCriteria === "string" ? args.acceptanceCriteria : undefined, acceptanceScenario: typeof args.acceptanceScenario === "string" ? args.acceptanceScenario : undefined });
    case "epic_delete":
      return deleteEpic(options, String(args.id ?? ""));
    case "backlog_delete": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return "backlog_delete needs an `id` — a card number like \"#12\". Call backlog_list first.";
      return deleteBacklog(options, id);
    }
    case "machine_status": {
      const limit = positiveNumber(args.limit);
      return collectMachineStats().then((stats) =>
        renderMachineStats(stats, limit === undefined ? 8 : Math.min(Math.floor(limit), 12)),
      );
    }
    case "schedule_list":
      return listSchedule(options);
    case "schedule_add": {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!title) return "schedule_add needs a `title`.";
      if (!prompt) return "schedule_add needs a `prompt`.";
      const frequency = parseFrequency(args.frequency);
      if (!frequency) return 'schedule_add needs a valid `frequency`: { "type": "hourly"|"daily"|"once", ... }.';
      return addSchedule(options, { title, prompt, frequency });
    }
    case "schedule_update": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return "schedule_update needs an `id`. Call schedule_list first.";
      const frequency = args.frequency === undefined ? undefined : parseFrequency(args.frequency);
      if (args.frequency !== undefined && !frequency) {
        return 'schedule_update was given an invalid `frequency`: { "type": "hourly"|"daily"|"once", ... }.';
      }
      return updateSchedule(options, id, {
        title: typeof args.title === "string" ? args.title : undefined,
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        frequency,
        enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
      });
    }
    case "schedule_delete": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return "schedule_delete needs an `id`. Call schedule_list first.";
      return deleteSchedule(options, id);
    }
    // Every browser tool is the same round trip to the app, so they share one
    // arm: only the argument checks differ, and those are the ones an agent can
    // actually get wrong.
    case "browser_list":
    case "browser_activity":
    case "browser_open":
    case "browser_navigate":
    case "browser_read":
    case "browser_inspect":
    case "browser_wait":
    case "browser_click":
    case "browser_hover":
    case "browser_drag":
    case "browser_type":
    case "browser_key":
    case "browser_cursor":
    case "browser_scroll":
    case "browser_select_option":
    case "browser_upload":
    case "browser_screenshot":
    case "browser_record":
    case "browser_note":
    case "browser_close":
    case "browser_back": {
      const action = name.slice("browser_".length);
      const url = typeof args.url === "string" ? args.url.trim() : "";
      const text = typeof args.text === "string" ? args.text : "";
      const selector = typeof args.selector === "string" ? args.selector.trim() : "";
      const tab = typeof args.tab === "string" ? args.tab.trim() : "";
      const keys = typeof args.keys === "string" ? args.keys.trim() : "";
      const start = typeof args.start === "string" ? args.start.trim() : "";
      const end = typeof args.end === "string" ? args.end.trim() : "";
      const paths = Array.isArray(args.paths) ? args.paths.filter((path): path is string => typeof path === "string") : [];

      if ((action === "open" || action === "navigate") && !url) return `${name} needs a \`url\`.`;
      if (action === "type" && !selector) return "browser_type needs a `selector` for the field to type into.";
      if (action === "type" && !text) return "browser_type needs `text`.";
      if (action === "note" && args.clear !== true && !text.trim()) {
        return "browser_note needs `text` — what you want the user to look at. (Pass `clear: true` to take your own note back off instead.)";
      }
      if ((action === "click" || action === "hover") && !selector && !text.trim()) {
        return `${name} needs either a \`selector\` or the visible \`text\` of the element.`;
      }
      if (action === "wait" && !selector && !text.trim()) {
        return "browser_wait needs either a `selector` or the `text` you are waiting for.";
      }
      if (action === "drag" && (!start || !end)) return "browser_drag needs both `start` and `end` selectors.";
      if (action === "key" && !keys) return 'browser_key needs `keys` — e.g. "Escape" or "Cmd+A".';
      if (action === "select_option" && !selector) {
        return "browser_select_option needs a `selector` for the <select> or the combobox trigger. `browser_inspect` with role \"combobox\" will find you one.";
      }
      if (action === "select_option" && typeof args.value !== "string" && typeof args.label !== "string") {
        return "browser_select_option needs either a `value` or a `label` to choose.";
      }
      if (action === "upload" && (!selector || !paths.length)) {
        return "browser_upload needs a `selector` for the file input and at least one absolute path in `paths`.";
      }
      if (action === "scroll" && typeof args.to !== "string" && typeof args.deltaY !== "number" && !text.trim()) {
        return 'browser_scroll needs `to` ("top", "bottom" or a selector), the visible `text` to scroll to, or a `deltaY`.';
      }
      if (action === "close" && !tab) return "browser_close needs a `tab`. Call browser_list first.";
      if (action === "cursor") {
        const aimed =
          typeof args.x === "number" || typeof args.y === "number" ||
          typeof args.dx === "number" || typeof args.dy === "number" ||
          Boolean(selector) || Boolean(text.trim());
        const standing = args.mode === "click" || args.mode === "up" || args.mode === "wheel" || args.mode === "where" || args.mode === "hide";
        if (!aimed && !standing) {
          return "browser_cursor needs somewhere to aim: `x`/`y`, `dx`/`dy`, or a `selector`/`text`. (`click`, `up`, `wheel` and `where` can act where the pointer already is.)";
        }
        if (args.mode === "drag" && typeof args.toX !== "number" && typeof args.toY !== "number" && typeof args.toSelector !== "string" && typeof args.toText !== "string") {
          return "browser_cursor drag needs a destination — `toX`/`toY`, or `toSelector`/`toText`.";
        }
      }

      return callBrowser(options, {
        action,
        tab: tab || undefined,
        url: url || undefined,
        selector: selector || undefined,
        text: text || undefined,
        links: args.links === true,
        values: args.values === true,
        submit: args.submit === true,
        // `clear` means two different things: "empty the field first", which is
        // on by default, and "take my note off", which is not.
        clear: action === "type" ? args.clear !== false : args.clear === true,
        role: typeof args.role === "string" ? args.role : undefined,
        within: typeof args.within === "string" ? args.within : undefined,
        button: typeof args.button === "string" ? args.button : undefined,
        clickCount: positiveNumber(args.clickCount),
        timeout: positiveNumber(args.timeout),
        keys: keys || undefined,
        to: typeof args.to === "string" ? args.to : undefined,
        deltaY: typeof args.deltaY === "number" ? args.deltaY : undefined,
        start: start || undefined,
        end: end || undefined,
        x: typeof args.x === "number" ? args.x : undefined,
        y: typeof args.y === "number" ? args.y : undefined,
        dx: typeof args.dx === "number" ? args.dx : undefined,
        dy: typeof args.dy === "number" ? args.dy : undefined,
        toX: typeof args.toX === "number" ? args.toX : undefined,
        toY: typeof args.toY === "number" ? args.toY : undefined,
        toSelector: typeof args.toSelector === "string" ? args.toSelector : undefined,
        toText: typeof args.toText === "string" ? args.toText : undefined,
        value: typeof args.value === "string" ? args.value : undefined,
        label: typeof args.label === "string" ? args.label : undefined,
        paths: paths.length ? paths : undefined,
        // `mode` carries the record verb and the cursor verb alike; they are
        // disjoint sets, and the app validates whichever it is given.
        mode:
          action === "cursor"
            ? typeof args.mode === "string"
              ? args.mode
              : "move"
            : args.mode === "stop"
              ? "stop"
              : action === "record"
                ? "start"
                : undefined,
        fps: positiveNumber(args.fps),
        background: args.background === true ? true : undefined,
        limit: positiveNumber(args.limit),
      });
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

function runMcpServer(options: Options): void {
  const write = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const handle = (request: JsonRpcRequest): void => {
    const { id, method } = request;
    // Notifications (no id) need no reply — `notifications/initialized` is the
    // only one the client sends us.
    if (id === undefined || id === null) {
      return;
    }

    switch (method) {
      case "initialize":
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: "1.0.0" },
          },
        });
        return;
      case "tools/list":
        write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      case "tools/call": {
        const params = request.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const fail = (error: unknown): void => {
          write({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `Workspace lookup failed: ${String(error)}` }], isError: true },
          });
        };
        try {
          // `send_message` round-trips to the app, so a result may be a promise.
          Promise.resolve(callTool(options, name, args))
            .then((text) => write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }))
            .catch(fail);
        } catch (error) {
          fail(error);
        }
        return;
      }
      default:
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        handle(JSON.parse(line) as JsonRpcRequest);
      } catch {
        // A malformed frame is not worth killing the server over.
      }
    }
  });
  process.stdin.on("close", () => process.exit(0));
}

/** `--hourly <n>` / `--daily <HH:MM>` / `--once <ISO timestamp>` → a frequency, or undefined if none was given (or it was invalid). */
function frequencyFromFlags(flags: Map<string, string>): ScheduleFrequency | undefined {
  if (flags.has("hourly")) {
    return parseFrequency({ type: "hourly", everyHours: Number.parseInt(flags.get("hourly") ?? "", 10) });
  }
  if (flags.has("daily")) {
    return parseFrequency({ type: "daily", time: flags.get("daily") });
  }
  if (flags.has("once")) {
    return parseFrequency({ type: "once", at: flags.get("once") });
  }
  return undefined;
}

function main(): void {
  const { options, positionals, switches, flags } = parseArgv(process.argv.slice(2));

  if (switches.has("mcp")) {
    runMcpServer(options);
    return;
  }

  const [command, target, ...rest] = positionals;
  if (command === "title") {
    const title = [target, ...rest].filter(Boolean).join(" ").trim();
    if (!title) {
      process.stdout.write('Usage: panda-peers title "<concise section title>"\n');
      process.exitCode = 1;
      return;
    }
    void setSectionTitle(options, title).then((result) => process.stdout.write(`${result}\n`));
    return;
  }

  if (command === "show" || command === "read") {
    const turn = Number.parseInt(flags.get("turn") ?? "", 10);
    process.stdout.write(
      `${readPeer(options, target ?? "", {
        limit: Number.parseInt(flags.get("limit") ?? "", 10) || undefined,
        offset: Number.parseInt(flags.get("offset") ?? "", 10) || 0,
        full: switches.has("full"),
        turn: Number.isNaN(turn) ? undefined : turn,
        part: Number.parseInt(flags.get("part") ?? "", 10) || undefined,
      })}\n`,
    );
    return;
  }

  if (command === "wait") {
    const seconds = Number.parseInt(flags.get("timeout") ?? "", 10);
    void waitForSession(options, target ?? "", Number.isNaN(seconds) ? DEFAULT_WAIT_MS : seconds * 1000).then((result) => {
      process.stdout.write(`${result}\n`);
    });
    return;
  }

  if (command === "send" || command === "tell") {
    // The message may be one quoted argument or several bare words; joining
    // covers both without making the caller quote carefully.
    const message = rest.join(" ").trim();
    if (!target || !message) {
      process.stdout.write('Usage: panda-peers send <section-id-or-title> "<message>"\n');
      process.exitCode = 1;
      return;
    }

    void sendPeerMessage(options, target, message).then((result) => {
      process.stdout.write(`${result}\n`);
    });
    return;
  }

  if (command === "attention" || command === "alert") {
    const summary = [target, ...rest].filter(Boolean).join(" ").trim();
    if (!summary) {
      process.stdout.write('Usage: panda-peers attention "<urgent TL;DR>" [--detail <context>] [--important] [--user-requested]\n');
      process.exitCode = 1;
      return;
    }
    void requestAttention(options, {
      summary,
      detail: flags.get("detail"),
      userRequested: switches.has("user-requested"),
      severity: switches.has("important") ? "important" : "urgent",
    }).then((result) => process.stdout.write(`${result}\n`));
    return;
  }

  if (command === "machine" || command === "status") {
    const limit = Number.parseInt(flags.get("limit") ?? "", 10);
    void collectMachineStats().then((stats) => {
      process.stdout.write(`${renderMachineStats(stats, Number.isNaN(limit) ? 8 : Math.min(limit, 12))}\n`);
    });
    return;
  }

  if (command === "browser") {
    // Same verbs as the MCP tools, spelled the way they get typed. Bare
    // `panda-peers browser` lists the tabs, which is the common case.
    const [verb, ...words] = [target, ...rest].filter((token) => token !== undefined);
    const subject = words.join(" ").trim();
    const action = verb === undefined || verb === "list" ? "list" : verb === "select" ? "select_option" : verb;
    const known = [
      "list",
      "activity",
      "open",
      "navigate",
      "read",
      "inspect",
      "wait",
      "click",
      "hover",
      "drag",
      "type",
      "key",
      "cursor",
      "scroll",
      "select_option",
      "upload",
      "screenshot",
      "record",
      "note",
      "close",
      "back",
    ];
    if (!known.includes(action)) {
      process.stdout.write(`Unknown browser command ${JSON.stringify(verb)}. Use ${known.join(", ")}.\n`);
      process.exitCode = 1;
      return;
    }

    // The positional is whatever that verb is mostly about: a URL for open and
    // navigate, the note text for note, the tab for close, the click target
    // otherwise. Flags override it when a command needs both.
    const positionalUrl = action === "open" || action === "navigate" ? subject : undefined;
    const positionalText =
      action === "note" || action === "type" || action === "click" || action === "hover" || action === "wait" || action === "inspect"
        ? subject
        : undefined;
    void callBrowser(options, {
      action,
      tab: flags.get("tab") ?? (action === "close" ? subject : undefined),
      url: flags.get("url") ?? positionalUrl,
      selector: flags.get("selector"),
      text: flags.get("text") ?? positionalText,
      links: switches.has("links"),
      values: switches.has("values"),
      // `--keep` leaves a field's contents alone; `--clear` takes a note back off.
      clear: action === "type" ? !switches.has("keep") : switches.has("clear"),
      role: flags.get("role"),
      within: flags.get("within"),
      submit: switches.has("submit"),
      button: switches.has("right") ? "right" : flags.get("button"),
      clickCount: Number.parseInt(flags.get("clicks") ?? "", 10) || undefined,
      timeout: Number.parseInt(flags.get("timeout") ?? "", 10) || undefined,
      keys: flags.get("keys") ?? (action === "key" ? subject : undefined),
      to: flags.get("to") ?? (action === "scroll" ? subject : undefined),
      deltaY: Number.parseInt(flags.get("delta") ?? "", 10) || undefined,
      start: flags.get("start"),
      end: flags.get("end"),
      x: Number.parseInt(flags.get("x") ?? "", 10) || undefined,
      y: Number.parseInt(flags.get("y") ?? "", 10) || undefined,
      dx: Number.parseInt(flags.get("dx") ?? "", 10) || undefined,
      dy: Number.parseInt(flags.get("dy") ?? "", 10) || undefined,
      toX: Number.parseInt(flags.get("to-x") ?? "", 10) || undefined,
      toY: Number.parseInt(flags.get("to-y") ?? "", 10) || undefined,
      toSelector: flags.get("to-selector"),
      toText: flags.get("to-text"),
      value: flags.get("value"),
      label: flags.get("label"),
      paths: flags.get("paths")?.split(",").map((path) => path.trim()).filter(Boolean),
      // For `cursor` the verb is the positional: `browser cursor click --x 40 --y 90`.
      mode:
        action === "cursor"
          ? subject || "move"
          : action === "record"
            ? subject === "stop" || switches.has("stop")
              ? "stop"
              : "start"
            : undefined,
      fps: Number.parseInt(flags.get("fps") ?? "", 10) || undefined,
      limit: Number.parseInt(flags.get("limit") ?? "", 10) || undefined,
    }).then((result) => {
      process.stdout.write(`${result}\n`);
    });
    return;
  }

  if (command === "backlog") {
    // `panda-peers backlog` with no verb is the common case — "show me the
    // board" — so it reads rather than erroring about a missing subcommand.
    const [verb, ...words] = [target, ...rest].filter((token) => token !== undefined);
    const subject = words.join(" ").trim();
    const patch = {
      summary: flags.get("summary"),
      description: flags.get("description"),
      metadata: flags.get("metadata"),
      column: flags.get("column"),
      verificationNotes: flags.get("verification"),
      epicId:
        flags.has("epic")
          ? flags.get("epic")?.trim()
            ? (resolveEpicId(options, flags.get("epic")) ?? "__missing_epic__")
            : null
          : undefined,
    };
    // One `--attach` per call, like every other repeatable-in-spirit flag here —
    // the underlying map holds one value per name. An agent attaching several
    // files calls update more than once; each call is additive.
    const attachPath = flags.get("attach");
    const attachments = attachPath ? [{ path: attachPath, caption: flags.get("caption") }] : undefined;

    if (verb === undefined || verb === "list" || verb === "show") {
      // `backlog list done` names a column, not a card — the same thing
      // `--column done` says, spelled the way it gets typed.
      process.stdout.write(`${listBacklog(options, flags.get("column") ?? (subject || undefined))}\n`);
      return;
    }

    if (verb === "add") {
      if (!subject) {
        process.stdout.write(
          'Usage: panda-peers backlog add "<title>" [--summary <one line>] [--description <markdown>] [--metadata <text>] [--column backlog|in_progress|review|done] [--verification <text>] [--attach <path>] [--caption <text>]\n',
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${addBacklog(options, { title: subject, ...patch, epicId: patch.epicId ?? undefined, attachments })}\n`);
      return;
    }

    if (verb === "update" || verb === "move" || verb === "review" || verb === "done" || verb === "hold" || verb === "unhold" || verb === "verify") {
      if (!subject) {
        process.stdout.write(
          'Usage: panda-peers backlog update <#number-or-title> [--title <text>] [--summary <one line>] [--description <markdown>] [--metadata <text>] [--column backlog|in_progress|review|done] [--verification <text>] [--attach <path>] [--caption <text>] [--unattach <attachment id>]\n' +
            '       panda-peers backlog review <#number-or-title> --verification "<what you checked, and what you did not>" [--attach <path>]\n' +
            "       panda-peers backlog done <#number-or-title>   (the user's move — needs evidence on the card)\n" +
            "       panda-peers backlog hold|unhold <#number-or-title>\n",
        );
        process.exitCode = 1;
        return;
      }
      // `review <id>` and `done <id>` are the shorthands worth having: handing
      // work back is the move an agent makes most, and spelling out
      // `--column review` every time is friction with no upside. `hold`/`unhold`
      // are the same shape for parking a card, which has no column to name at all.
      const column = verb === "review" || verb === "done" ? verb : patch.column;
      const onHold = verb === "hold" ? true : verb === "unhold" ? false : undefined;
      const unattach = flags.get("unattach");
      const scenarioOutcome = flags.get("outcome");
      const addVerificationScenario = verb === "verify" && scenarioOutcome
        ? {
            title: flags.get("scenario") ?? "Verification",
            setup: flags.get("setup") ?? "",
            actions: flags.get("actions") ?? "",
            expectedOutcome: flags.get("expected") ?? "",
            actualOutcome: flags.get("actual") ?? "",
            outcome: scenarioOutcome as VerificationOutcome,
            verificationType: flags.get("type") ?? "other",
            evidenceAttachmentIds: flags.get("evidence")?.split(",").map((id) => id.trim()).filter(Boolean),
            coverageLimits: flags.get("limits"),
            createdBySection: selfLabel(options),
          }
        : undefined;
      if (verb === "verify" && !["passed", "failed", "blocked", "not_run"].includes(scenarioOutcome ?? "")) {
        process.stdout.write('Usage: panda-peers backlog verify <card> --outcome passed|failed|blocked|not_run --scenario "<name>" --setup "<environment/revision>" --actions "<steps>" --expected "<expected>" --actual "<actual>" [--type live_e2e|mocked|renderer_only|installed_app|unit|api] [--evidence <attachment ids>] [--limits <gaps>]\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `${updateBacklog(options, subject, {
          ...patch,
          title: flags.get("title"),
          column,
          onHold,
          addAttachments: attachments,
          removeAttachmentIds: unattach ? [unattach] : undefined,
          addVerificationScenario,
        })}\n`,
      );
      return;
    }

    if (verb === "delete" || verb === "remove") {
      if (!subject) {
        process.stdout.write("Usage: panda-peers backlog delete <#number-or-title>\n");
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${deleteBacklog(options, subject)}\n`);
      return;
    }

    process.stdout.write(`Unknown backlog command ${JSON.stringify(verb)}. Use list, add, update, review, done, hold, unhold or delete.\n`);
    process.exitCode = 1;
    return;
  }

  if (command === "epic") {
    const [verb, ...words] = [target, ...rest].filter((token) => token !== undefined);
    const subject = words.join(" ").trim();
    if (!verb || verb === "list" || verb === "show") {
      process.stdout.write(`${listEpics(options)}\n`);
      return;
    }
    if (verb === "add") {
      if (!subject) { process.stdout.write('Usage: panda-peers epic add "<title>" [--summary <text>] [--scope <text>] [--acceptance <text>] [--scenario <text>]\n'); process.exitCode = 1; return; }
      process.stdout.write(`${addEpic(options, { title: subject, summary: flags.get("summary"), scope: flags.get("scope"), acceptanceCriteria: flags.get("acceptance"), acceptanceScenario: flags.get("scenario") })}\n`);
      return;
    }
    if (verb === "update") {
      if (!subject) { process.stdout.write('Usage: panda-peers epic update <E#-or-title> [--title <text>] [--summary <text>] [--scope <text>] [--acceptance <text>] [--scenario <text>]\n'); process.exitCode = 1; return; }
      process.stdout.write(`${updateEpic(options, subject, { title: flags.get("title"), summary: flags.get("summary"), scope: flags.get("scope"), acceptanceCriteria: flags.get("acceptance"), acceptanceScenario: flags.get("scenario") })}\n`);
      return;
    }
    if (verb === "delete" || verb === "remove") {
      process.stdout.write(`${deleteEpic(options, subject)}\n`);
      return;
    }
    process.stdout.write(`Unknown epic command ${JSON.stringify(verb)}. Use list, add, update or delete.\n`);
    process.exitCode = 1;
    return;
  }

  if (command === "schedule") {
    const [verb, ...words] = [target, ...rest].filter((token) => token !== undefined);
    const subject = words.join(" ").trim();

    if (verb === undefined || verb === "list" || verb === "show") {
      process.stdout.write(`${listSchedule(options)}\n`);
      return;
    }

    if (verb === "add") {
      const prompt = flags.get("prompt")?.trim() ?? "";
      const frequency = frequencyFromFlags(flags);
      if (!subject || !prompt || !frequency) {
        process.stdout.write(
          'Usage: panda-peers schedule add "<title>" --prompt "<text>" --hourly <n>|--daily <HH:MM>|--once <ISO timestamp>\n',
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${addSchedule(options, { title: subject, prompt, frequency })}\n`);
      return;
    }

    if (verb === "update") {
      if (!subject) {
        process.stdout.write(
          'Usage: panda-peers schedule update <id-or-title> [--title <text>] [--prompt <text>] [--hourly <n>|--daily <HH:MM>|--once <ISO timestamp>] [--enable|--disable]\n',
        );
        process.exitCode = 1;
        return;
      }
      const enabled = switches.has("enable") ? true : switches.has("disable") ? false : undefined;
      process.stdout.write(
        `${updateSchedule(options, subject, {
          title: flags.get("title"),
          prompt: flags.get("prompt"),
          frequency: frequencyFromFlags(flags),
          enabled,
        })}\n`,
      );
      return;
    }

    if (verb === "delete" || verb === "remove") {
      if (!subject) {
        process.stdout.write("Usage: panda-peers schedule delete <id-or-title>\n");
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${deleteSchedule(options, subject)}\n`);
      return;
    }

    process.stdout.write(`Unknown schedule command ${JSON.stringify(verb)}. Use list, add, update or delete.\n`);
    process.exitCode = 1;
    return;
  }

  if (command === "new" || command === "start") {
    // Unlike `send`, there is no target here: everything after the verb is the
    // task, quoted or not.
    const task = [target, ...rest].filter(Boolean).join(" ").trim();
    if (!task) {
      process.stdout.write(
        'Usage: panda-peers new "<task for the new section>" [--title <name>] [--mode subthread|sibling] [--runtime claude|codex|groq] [--model <model>] [--effort <effort>] [--permission-mode <mode>]\n',
      );
      process.exitCode = 1;
      return;
    }

    void createPeerSection(options, {
      task,
      title: flags.get("title"),
      mode: flags.get("mode"),
      runtime: flags.get("runtime"),
      model: flags.get("model"),
      effort: flags.get("effort"),
      permissionMode: flags.get("permission-mode"),
    }).then((result) => {
      process.stdout.write(`${result}\n`);
    });
    return;
  }

  process.stdout.write(`${listPeers(options, switches.has("with-self")).text}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
