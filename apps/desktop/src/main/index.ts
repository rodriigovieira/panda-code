import { execFile, spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, powerSaveBlocker, shell } from "electron";
import { spawn, type IPty } from "node-pty";
import type {
  AgentRuntime,
  AppPreferences,
  ArtifactRun,
  ArtifactsListRequest,
  BtwAskRequest,
  BtwAskResult,
  BtwClearRequest,
  BtwEvent,
  ConversationExportRequest,
  ConversationExportResult,
  ConversationSearchRequest,
  ConversationSearchResult,
  AppLogEvent,
  ClaudeConversationResult,
  ClaudeSessionExistsRequest,
  ConversationItem,
  PersistedThread,
  SavePastedImageRequest,
  SavePastedImageResult,
  SessionApprovalAnswer,
  SessionApprovalResult,
  SessionExitEvent,
  SessionInputRequest,
  SessionResizeRequest,
  SessionStartRequest,
  SessionStartResult,
  SessionStopRequest,
  SessionTitleEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalStartRequest,
  TerminalStartResult,
  UsageBundle,
  UsageCostQuery,
  UsageCostReport,
  UsageProvider,
  UsageSnapshot,
  UsageWindow,
  WorkspaceGitBranch,
  WorkspaceGitChange,
  WorkspaceGitRequest,
  WorkspaceGitStatus,
  WorkspaceGitWorktree,
} from "../shared/ipc";
import {
  applyAppServerNotification,
  applyStreamJsonEvent,
  createStreamJsonState,
  messageItemId,
  parseStreamJsonLine,
  streamRuntimeEvent,
  strippedBodyForComparison,
  thinkingItemId,
  toolInputBody,
  toolResultBody,
  toolResultItemId,
  toolUseItemId,
  type StreamJsonState,
} from "../shared/stream-json";
import { tldrSystemPrompt } from "../shared/agent-prompts";
import { createSessionService, type ManagedStreamSession } from "./sessionService";
import { createUsageLedger, type UsageLedger } from "./usageLedger";
import { CodexAppServerClient } from "./codex/appServerClient";
import { CodexAppServerSessionManager, type CodexAppServerSession } from "./codex/appServerSession";
import { createRelayBridge, type RelayBridge, type RemoteBtwRequest, type RemoteBtwResult } from "./remote/relayBridge";

const sessions = new Map<string, IPty>();
const streamSessions = new Map<string, StreamSession>();
const streamResumeRequests = new Map<string, SessionStartRequest>();
let remoteBridge: RelayBridge | null = null;

// "By the way" side-chat state. `btwIdentities` remembers the forked side-session
// id per section thread so follow-up questions resume the same aside;
// `btwProcesses` holds the in-flight one-shot query (if any); `btwSideSessionIds`
// is every side-session id we have created, excluded from the main session
// detector so a /btw fork can never be mistaken for the section's real session.
type BtwIdentity = { sideSessionId?: string; cwd: string; runtime?: AgentRuntime };
type BtwProcess = {
  process?: ChildProcessWithoutNullStreams;
  cancel?: () => void;
  state: StreamJsonState;
  stdoutBuffer: string;
  sideSessionId?: string;
};
const btwIdentities = new Map<string, BtwIdentity>();
const btwProcesses = new Map<string, BtwProcess>();
const btwSideSessionIds = new Set<string>();
const btwSystemPrompt =
  "You are answering a quick side question about the current Claude Code session, shown in a separate side-panel next to it. " +
  "Answer concisely and directly using the session's context. This is a read-only aside: do NOT edit files, run mutating commands, " +
  "create plan files, or use plan mode — just answer the question.";

// Hold a macOS "prevent idle sleep" assertion while work is running, or while
// the user has explicitly opted into idle relay reachability. This still lets
// the display turn off; it only prevents the app from being suspended.
let sleepBlockerId: number | null = null;
let onBatteryPower = false;

function shouldKeepRelayReachable(): boolean {
  if (!remoteBridge?.isEnabled()) return false;
  if (appPreferences.remoteKeepAwake === "always") return true;
  if (appPreferences.remoteKeepAwake === "while-plugged-in") return !onBatteryPower;
  return false;
}

function refreshSleepBlocker(): void {
  const active = sessions.size > 0 || streamSessions.size > 0;
  const shouldHold = active || shouldKeepRelayReachable();
  const held = sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId);
  if (shouldHold && !held) {
    sleepBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    logMain("sleep-blocker:start", { id: sleepBlockerId, active, remoteReachable: shouldKeepRelayReachable() });
  } else if (!shouldHold && held) {
    powerSaveBlocker.stop(sleepBlockerId as number);
    logMain("sleep-blocker:stop", { id: sleepBlockerId });
    sleepBlockerId = null;
  }
  // Presence shares the executor's existing active/idle lifecycle instead of
  // introducing a second power assertion. A transition also refreshes relay
  // presence immediately; the normal 12-second heartbeat continues in between.
  remoteBridge?.heartbeatNow();
}

type TerminalSession = {
  pty: IPty;
  buffer: string;
};

// Standalone shell terminals (one per terminal tab in the UI). Main owns the
// ptys so they survive renderer reloads; the buffer replays scrollback on
// re-attach.
const terminals = new Map<string, TerminalSession>();
const terminalBufferCap = 200_000;
const claudeSessionDetectors = new Map<string, NodeJS.Timeout>();
const detectedClaudeSessions = new Map<string, string>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultShellPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const defaultWorkspace = process.env.PANDA_CODE_DEFAULT_WORKSPACE?.trim() || homedir();
const defaultCommand = "claude";
const defaultCodexCommand = "codex";
const maxRecoveredThreads = 40;
// Keep in sync with the renderer's MERGE_LIMIT (500): the transcript window
// must stay below it so a reload can never push live items out of the feed.
const transcriptItemLimit = 400;

type ClaudeSessionSnapshot = Map<string, number>;
type PtyEnvironment = NodeJS.ProcessEnv;
type StreamSession = ManagedStreamSession;
type ClaudeJsonLine = {
  uuid?: string;
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  aiTitle?: string;
  isMeta?: boolean;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
    usage?: ClaudeUsage;
    model?: string;
  };
  toolUseResult?: unknown;
};

type CodexJsonLine = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: unknown;
    input?: unknown;
    output?: unknown;
    message?: unknown;
    content?: unknown;
    info?: {
      total_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
        cached_input_tokens?: number;
        cache_read_input_tokens?: number;
        total_tokens?: number;
      };
    };
  };
};

type CodexTokenUsage = NonNullable<NonNullable<CodexJsonLine["payload"]>["info"]>["total_token_usage"];

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

function debugLogPath(): string {
  return join(app.getPath("userData"), "panda-code-debug.log");
}

function compactLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(compactLogValue);
  }

  if (value && typeof value === "object") {
    const compacted: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, 30)) {
      compacted[key] = compactLogValue(nestedValue);
    }
    return compacted;
  }

  return value;
}

// Every stream event is logged, so this is one of the hottest paths in the main
// process. Two rules keep it from costing real money:
//
//  1. NEVER write synchronously. `appendFileSync` per event blocked the Electron
//     main thread thousands of times per turn — the whole UI paid for it. Lines
//     are buffered and flushed on a timer.
//  2. Bound the file. Unrotated, it reached 265 MB / 757k lines in normal use.
//     At the cap the log is rolled to `.1` (one generation kept), so worst case
//     on disk is 2 × the cap.
const debugLogMaxBytes = 24 * 1024 * 1024;
const debugLogFlushMs = 1_000;
let debugLogBuffer: string[] = [];
let debugLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
let debugLogBytes: number | null = null;

function rollDebugLogIfNeeded(pendingBytes: number): void {
  const path = debugLogPath();
  if (debugLogBytes === null) {
    try {
      debugLogBytes = statSync(path).size;
    } catch {
      debugLogBytes = 0;
    }
  }
  debugLogBytes += pendingBytes;
  if (debugLogBytes < debugLogMaxBytes) {
    return;
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // A failed roll must not stop logging; the file just keeps growing until the
    // next attempt succeeds.
  }
  debugLogBytes = pendingBytes;
}

function flushDebugLog(): void {
  debugLogFlushTimer = null;
  if (debugLogBuffer.length === 0) {
    return;
  }
  const payload = debugLogBuffer.join("");
  debugLogBuffer = [];
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    rollDebugLogIfNeeded(Buffer.byteLength(payload));
    appendFile(debugLogPath(), payload, () => undefined);
  } catch {
    // Logging must never break the app.
  }
}

function writeDebugLog(event: AppLogEvent): void {
  try {
    debugLogBuffer.push(
      `${JSON.stringify({
        at: new Date().toISOString(),
        source: event.source,
        event: event.event,
        details: compactLogValue(event.details ?? {}),
      })}\n`,
    );
  } catch {
    return;
  }
  // A burst that outruns the timer flushes early so memory stays bounded too.
  if (debugLogBuffer.length >= 512) {
    if (debugLogFlushTimer) {
      clearTimeout(debugLogFlushTimer);
    }
    flushDebugLog();
    return;
  }
  debugLogFlushTimer ??= setTimeout(flushDebugLog, debugLogFlushMs);
}

/** Flush synchronously on the way out — a buffered tail must not be lost. */
function flushDebugLogNow(): void {
  if (debugLogFlushTimer) {
    clearTimeout(debugLogFlushTimer);
    debugLogFlushTimer = null;
  }
  if (debugLogBuffer.length === 0) {
    return;
  }
  const payload = debugLogBuffer.join("");
  debugLogBuffer = [];
  try {
    appendFileSync(debugLogPath(), payload);
  } catch {
    // Nothing left to do at shutdown.
  }
}

function logMain(event: string, details?: Record<string, unknown>): void {
  writeDebugLog({ source: "main", event, details });
}

function sendToLiveWindows(channel: string, payload: unknown): void {
  remoteBridge?.observeLocalEvent(channel, payload);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function sendToRendererWindows(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function rendererUrl(): string | undefined {
  return process.env.ELECTRON_RENDERER_URL;
}

function ptyEnvironment(): PtyEnvironment {
  const env: PtyEnvironment = {
    ...process.env,
    PATH: [process.env.PATH, defaultShellPath].filter(Boolean).join(":"),
    TERM: "xterm-256color",
    TERM_PROGRAM: "Panda Code",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
  };

  delete env.NO_COLOR;
  return env;
}

function claudeProjectDir(cwd: string): string {
  // The Claude CLI encodes a workspace path into a project-dir name by replacing
  // every non-alphanumeric character (slashes, underscores, dots, spaces, …) with
  // "-". Matching only "/" here would miss paths like ".../Echo_React", whose
  // transcripts the CLI actually stores under ".../Echo-React".
  return join(app.getPath("home"), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function readClaudeSessions(cwd: string): ClaudeSessionSnapshot {
  const projectDir = claudeProjectDir(cwd);
  const snapshot: ClaudeSessionSnapshot = new Map();

  if (!existsSync(projectDir)) {
    return snapshot;
  }

  try {
    for (const entry of readdirSync(projectDir)) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }

      const claudeSessionId = entry.slice(0, -".jsonl".length);
      // Side-sessions spawned by /btw live in the same project dir; hide them so
      // the session detector never adopts a fork as the section's real session.
      if (uuidPattern.test(claudeSessionId) && !btwSideSessionIds.has(claudeSessionId)) {
        snapshot.set(claudeSessionId, statSync(join(projectDir, entry)).mtimeMs);
      }
    }
  } catch {
    return snapshot;
  }

  return snapshot;
}

function newestChangedSession(before: ClaudeSessionSnapshot, after: ClaudeSessionSnapshot, startedAt: number): string | null {
  const changed = Array.from(after.entries())
    .filter(([id, mtimeMs]) => {
      const previousMtime = before.get(id);
      return previousMtime === undefined ? mtimeMs >= startedAt - 2_000 : mtimeMs > previousMtime + 1;
    })
    .sort((first, second) => second[1] - first[1]);

  return changed[0]?.[0] ?? null;
}

function changedExistingSession(before: ClaudeSessionSnapshot, after: ClaudeSessionSnapshot, claudeSessionId: string): boolean {
  const nextMtime = after.get(claudeSessionId);
  if (nextMtime === undefined) {
    return false;
  }

  const previousMtime = before.get(claudeSessionId);
  return previousMtime === undefined || nextMtime > previousMtime + 1;
}

function resumedSessionFromCommand(command: string): string | null {
  const match = command.match(/(?:^|\s)(?:--resume|-r)\s+['"]?([0-9a-f-]{36})['"]?/i);
  const candidate = match?.[1];
  return candidate && uuidPattern.test(candidate) ? candidate : null;
}

function hasSessionFlag(command: string): boolean {
  return /(?:^|\s)(?:--resume|-r|--continue|-c|--session-id)(?:\s|=|$)/.test(command);
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function streamCompatibleCommandParts(command: string): { executable: string; args: string[] } {
  const tokens = tokenizeCommand(command);
  const executable = tokens[0] || defaultCommand;
  const args: string[] = [];
  const booleanFlags = new Set([
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--json",
    "--search",
    "--strict-config",
  ]);
  const valueFlags = new Set([
    "--permission-mode",
    "--model",
    "-m",
    "--resume",
    "-r",
    "--continue",
    "-c",
    "--session-id",
    "--ask-for-approval",
    "-a",
    "--sandbox",
    "--config",
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--disallowed-tools",
  ]);

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    const flagName = token.split("=", 1)[0] ?? token;
    if (booleanFlags.has(token)) {
      args.push(token);
      continue;
    }

    if (valueFlags.has(flagName)) {
      args.push(token);
      if (!token.includes("=") && index + 1 < tokens.length) {
        const nextToken = tokens[index + 1];
        if (nextToken && !nextToken.startsWith("-")) {
          args.push(nextToken);
          index += 1;
        }
      }
    }
  }

  return { executable, args };
}

function hasModelFlag(command: string): boolean {
  return /(?:^|\s)--model(?:\s|=|$)/.test(command);
}

function hasPermissionFlag(command: string): boolean {
  return /(?:^|\s)(?:--permission-mode|--dangerously-skip-permissions|--allow-dangerously-skip-permissions)(?:\s|=|$)/.test(command);
}

function hasEffortFlag(command: string): boolean {
  return /(?:^|\s)--effort(?:\s|=|$)/.test(command);
}

function buildStreamClaudeCommand(
  command: string,
  claudeSessionId?: string,
  model?: string,
  permissionMode?: string,
  effort?: string,
): { executable: string; args: string[] } {
  const { executable, args } = streamCompatibleCommandParts(command.trim() || defaultCommand);
  const streamArgs = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--replay-user-messages",
    "--append-system-prompt",
    tldrSystemPrompt,
    ...args,
  ];

  if (claudeSessionId && !hasSessionFlag(command)) {
    streamArgs.push("--resume", claudeSessionId);
  }

  if (model?.trim() && !hasModelFlag(command)) {
    streamArgs.push("--model", model.trim());
  }

  if (permissionMode?.trim() && !hasPermissionFlag(command)) {
    const mode = permissionMode.trim();
    // Headless (`-p`) Claude sessions refuse `--permission-mode bypassPermissions`
    // ("Cannot set permission mode to bypassPermissions because the session was not
    // launched with --dangerously-skip-permissions"). The launch flag is the only
    // way to start a bypass session non-interactively; the UI gates it behind Face ID.
    if (mode === "bypassPermissions") {
      streamArgs.push("--dangerously-skip-permissions");
    } else {
      streamArgs.push("--permission-mode", mode);
    }
  }

  if (effort?.trim() && !hasEffortFlag(command)) {
    streamArgs.push("--effort", effort.trim());
  }

  return { executable, args: streamArgs };
}

// Claude only: Codex sessions never reach here — they run on the app-server
// transport (startStreamSession routes them to CodexAppServerSessionManager
// before any command is built).
function buildStreamCommand(request: SessionStartRequest): { executable: string; args: string[]; runtime: AgentRuntime } {
  const runtime = request.runtime ?? "claude";
  return {
    runtime,
    ...buildStreamClaudeCommand(
      request.command,
      request.claudeSessionId,
      request.model,
      request.permissionMode,
      request.effort,
    ),
  };
}

function streamPromptPayload(prompt: string): string {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: prompt.replace(/\r+$/, ""),
    },
  })}\n`;
}

function latestClaudeSession(cwd: string): string | null {
  const latest = Array.from(readClaudeSessions(cwd).entries()).sort((first, second) => second[1] - first[1]);
  return latest[0]?.[0] ?? null;
}

function codexSessionRoots(): string[] {
  return [join(app.getPath("home"), ".codex", "sessions"), join(app.getPath("home"), ".codex", "archived_sessions")];
}

function findCodexSessionFile(codexThreadId: string): string | null {
  for (const root of codexSessionRoots()) {
    if (!existsSync(root)) {
      continue;
    }

    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop();
      if (!directory) {
        continue;
      }

      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }

        if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(codexThreadId)) {
          return entryPath;
        }
      }
    }
  }

  return null;
}

function threadsStorePath(): string {
  return join(app.getPath("userData"), "threads.json");
}

// Project-less sections ("no project") still need a real working directory for
// the agent process, so they all share one scratch folder. Sharing a single
// path — rather than a folder per section — is what lets the sidebar group them
// together, since grouping keys off `cwd`.
function scratchWorkspacePath(): string {
  return join(app.getPath("home"), ".panda-code", "scratch");
}

function ensureScratchWorkspace(): string {
  const path = scratchWorkspacePath();
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    logMain("scratch-workspace-create-failed", { path, error: String(error) });
  }
  return path;
}

function pastedImageExtension(mimeType: string, name: string): string {
  const existingExtension = name.match(/\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i)?.[0]?.toLowerCase();
  if (existingExtension) {
    return existingExtension;
  }

  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    case "image/tiff":
      return ".tiff";
    case "image/bmp":
      return ".bmp";
    default:
      return ".png";
  }
}

function savePastedImage(request: SavePastedImageRequest): SavePastedImageResult {
  if (!request.mimeType.startsWith("image/")) {
    return { ok: false, message: "Clipboard item is not an image." };
  }

  try {
    const directory = join(app.getPath("userData"), "pasted-images");
    mkdirSync(directory, { recursive: true });
    const extension = pastedImageExtension(request.mimeType, request.name);
    const path = join(directory, `pasted-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);
    writeFileSync(path, Buffer.from(request.data));
    return { ok: true, path };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save pasted image.";
    return { ok: false, message };
  }
}

// `/export` lands here with the transcript already rendered. Main only decides
// where it goes: the clipboard, an explicit path, or wherever the save dialog
// points. A bare filename resolves inside the section's workspace so
// `/export notes.md` writes next to the code it is about, not into $HOME.
async function exportConversation(request: ConversationExportRequest): Promise<ConversationExportResult> {
  if (request.target === "clipboard") {
    clipboard.writeText(request.content);
    return { ok: true, target: "clipboard" };
  }

  const base = request.cwd && existsSync(request.cwd) ? request.cwd : app.getPath("downloads");
  let path: string;

  if (request.filename) {
    // Default to Markdown when the argument carries no extension of its own,
    // mirroring how the transcript is serialized.
    const named = /\.[a-z0-9]+$/i.test(request.filename) ? request.filename : `${request.filename}.md`;
    // A typed `~/…` is a shell convention the renderer never expands; resolving
    // it verbatim would create a literal "~" directory inside the workspace.
    path = named.startsWith("~/") ? join(homedir(), named.slice(2)) : resolve(base, named);
  } else {
    const result = await dialog.showSaveDialog({
      title: "Export conversation",
      defaultPath: join(base, request.defaultFilename),
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Text", extensions: ["txt"] },
      ],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    path = result.filePath;
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, request.content, "utf8");
    return { ok: true, target: "file", path };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not write the export.";
    return { ok: false, message };
  }
}

function normalizeStoredThread(thread: PersistedThread): PersistedThread {
  const runtime = thread.runtime ?? "claude";
  return {
    ...thread,
    runtime,
    command:
      runtime === "codex" && (!thread.command.trim() || thread.command.trim() === defaultCommand)
        ? defaultCodexCommand
        : thread.command,
    titleSource: thread.titleSource ?? "auto",
    executionMode: "stream-json",
    status: thread.status === "running" ? "exited" : thread.status,
    agentState: thread.status === "running" ? "exited" : (thread.agentState ?? "exited"),
  };
}

// Stable key for ORDERING the session list — mirrors the renderer's
// `threadOrderKey`. NOT `lastActiveAt`: that gets restamped to `now` on
// non-prompt events (session-id/title resolution, snapshot replay on reload),
// which floated old, never-prompted sessions to the top. `lastPromptAt` (real
// user activity) with a `createdAt` fallback is stable across reloads.
function threadOrderKey(thread: PersistedThread): string {
  return thread.lastPromptAt ?? thread.createdAt;
}

function dedupeThreadsByClaudeSession(threads: PersistedThread[]): PersistedThread[] {
  const byClaudeSession = new Map<string, PersistedThread>();
  const byCodexThread = new Map<string, PersistedThread>();
  const withoutClaudeSession: PersistedThread[] = [];

  for (const thread of threads.map(normalizeStoredThread)) {
    if (thread.runtime === "codex" && thread.codexThreadId) {
      const existing = byCodexThread.get(thread.codexThreadId);
      if (!existing) {
        byCodexThread.set(thread.codexThreadId, thread);
        continue;
      }

      const existingActivity = existing.lastPromptAt ?? existing.lastActiveAt;
      const threadActivity = thread.lastPromptAt ?? thread.lastActiveAt;
      if (threadActivity > existingActivity) {
        byCodexThread.set(thread.codexThreadId, thread);
      }
      continue;
    }

    if (!thread.claudeSessionId) {
      withoutClaudeSession.push(thread);
      continue;
    }

    const existing = byClaudeSession.get(thread.claudeSessionId);
    if (!existing) {
      byClaudeSession.set(thread.claudeSessionId, thread);
      continue;
    }

    const existingActivity = existing.lastPromptAt ?? existing.lastActiveAt;
    const threadActivity = thread.lastPromptAt ?? thread.lastActiveAt;
    if (threadActivity > existingActivity) {
      byClaudeSession.set(thread.claudeSessionId, thread);
    }
  }

  return [...withoutClaudeSession, ...byClaudeSession.values(), ...byCodexThread.values()].sort((first, second) =>
    threadOrderKey(second).localeCompare(threadOrderKey(first)),
  );
}

function readStoredThreads(): PersistedThread[] {
  const storePath = threadsStorePath();
  if (!existsSync(storePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as PersistedThread[];
    return Array.isArray(parsed) ? dedupeThreadsByClaudeSession(parsed) : [];
  } catch {
    return [];
  }
}

function writeStoredThreads(threads: PersistedThread[]): void {
  const storePath = threadsStorePath();
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(dedupeThreadsByClaudeSession(threads), null, 2)}\n`);
}

function trustedRemoteWorkspacePaths(): Set<string> {
  const paths = new Set<string>();
  if (existsSync(defaultWorkspace)) {
    paths.add(resolve(defaultWorkspace));
  }
  // The shared scratch folder backs project-less sections, so mobile is allowed
  // to start and resume them just like a real project.
  if (existsSync(scratchWorkspacePath())) {
    paths.add(resolve(scratchWorkspacePath()));
  }
  for (const thread of readStoredThreads()) {
    if (thread.cwd && existsSync(thread.cwd)) {
      paths.add(resolve(thread.cwd));
    }
  }
  return paths;
}

function isRemoteWorkspaceAllowed(cwd: string): boolean {
  const target = resolve(cwd);
  if (!trustedRemoteWorkspacePaths().has(target)) {
    return false;
  }
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isPlaceholderThread(thread: PersistedThread): boolean {
  return (
    !thread.claudeSessionId &&
    thread.title === "Untitled" &&
    thread.command === defaultCommand &&
    (thread.status === "idle" || thread.status === "exited") &&
    thread.createdAt === thread.lastActiveAt
  );
}

function titleFromUserContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const candidate = part as { type?: unknown; text?: unknown; content?: unknown };
    if (candidate.type === "tool_result") {
      continue;
    }

    if (typeof candidate.text === "string") {
      textParts.push(candidate.text);
    } else if (typeof candidate.content === "string" && candidate.type !== "tool_result") {
      textParts.push(candidate.content);
    }
  }

  return textParts.join(" ").trim() || null;
}

function compactTitle(value: string | null, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
}

// System/tooling wrappers that Claude and Codex inject into the transcript as
// "user" turns. None of these are a real prompt, so they must never become a
// title — otherwise sessions show raw XML like "<command-message>…" or the
// slash-command caveat instead of what the user actually asked.
const metaTitlePrefixes = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<system-reminder>",
  "<task-notification>",
  "<user-prompt-submit-hook>",
  "<environment_context>",
  "<user_instructions>",
  "<developer_instructions>",
  // A runtime handoff prepends a "<runtime-handoff …>…</runtime-handoff>" block
  // to the first prompt of the new runtime. cleanCandidateTitle strips a
  // complete block below; this prefix is the fallback for a truncated block
  // that has no closing tag, so it never becomes a title verbatim.
  "<runtime-handoff",
];

function looksLikeMetaTitle(value: string): boolean {
  return metaTitlePrefixes.some((prefix) => value.startsWith(prefix));
}

const removableMetaTitleTags = [
  "local-command-caveat",
  "local-command-stdout",
  "system-reminder",
  "task-notification",
  "user-prompt-submit-hook",
  "environment_context",
  "user_instructions",
  "developer_instructions",
];

function stripRemovableMetaTitleBlocks(value: string): string {
  let stripped = value;
  for (const tag of removableMetaTitleTags) {
    stripped = stripped.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  return stripped.replace(/\s+/g, " ").trim();
}

function normalizeCandidateTitle(value: string | null): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) {
    return null;
  }

  // A slash-command turn (e.g. `<command-name>/verify</command-name>`) has no
  // free-text prompt to summarize — surface the command name itself so these
  // sessions get a readable title instead of being dropped.
  if (normalized.startsWith("<command-name>") || normalized.startsWith("<command-message>")) {
    const match = normalized.match(/<command-(?:name|message)>([^<]+)<\/command-(?:name|message)>/);
    const command = match?.[1]?.replace(/^\//, "").trim();
    return command && command.length >= 2 ? command : null;
  }

  const withoutMetaBlocks = stripRemovableMetaTitleBlocks(normalized);
  if (!withoutMetaBlocks || looksLikeMetaTitle(withoutMetaBlocks) || withoutMetaBlocks.length < 3) {
    return null;
  }

  return withoutMetaBlocks;
}

function continuationTitleFallback(value: string): boolean {
  return value.trim().toLowerCase() === "continue";
}

function titleFromRuntimeHandoff(value: string): string | null {
  const handoffPattern = /<runtime-handoff\b[^>]*>([\s\S]*?)<\/runtime-handoff>/gi;
  let title: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = handoffPattern.exec(value)) !== null) {
    const body = match[1] ?? "";
    const userMarkers = Array.from(body.matchAll(/^### User @ [^\n]*\n/gm));
    const marker = userMarkers.at(-1);
    if (!marker || marker.index === undefined) {
      continue;
    }

    const start = marker.index + marker[0].length;
    const remainder = body.slice(start);
    const nextTranscriptMarker = remainder.search(/\n### [^\n]+ @ /);
    const candidate = remainder.slice(0, nextTranscriptMarker >= 0 ? nextTranscriptMarker : undefined);
    title = normalizeCandidateTitle(candidate) ?? title;
  }

  return title;
}

/** A session title plus where it came from. "ai" is final; "prompt" is provisional. */
type ClaudeTitleResult = { title: string; source: "ai" | "prompt" | "handoff" };

function cleanCandidateTitleResult(value: string | null): Pick<ClaudeTitleResult, "title" | "source"> | null {
  if (!value) {
    return null;
  }

  // A runtime handoff prepends "<runtime-handoff …>…</runtime-handoff>" to the
  // first prompt of the new runtime. Usually the user's real request follows
  // the closing tag; when the runtime switch sends only "Continue", fall back to
  // the last user request embedded in the handoff transcript.
  const handoffTitle = titleFromRuntimeHandoff(value);
  const normalized = normalizeCandidateTitle(value.replace(/<runtime-handoff\b[^>]*>[\s\S]*?<\/runtime-handoff>/gi, " "));
  if (normalized && !(handoffTitle && continuationTitleFallback(normalized))) {
    return { title: normalized, source: "prompt" };
  }

  return handoffTitle ? { title: handoffTitle, source: "handoff" } : null;
}

function cleanCandidateTitle(value: string | null): string | null {
  return cleanCandidateTitleResult(value)?.title ?? null;
}

function readClaudeSessionTitleDetailed(cwd: string, claudeSessionId: string): ClaudeTitleResult | null {
  const filePath = join(claudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  let promptTitle: string | null = null;

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as ClaudeJsonLine;
      if (entry.type === "ai-title") {
        const title = cleanCandidateTitle(entry.aiTitle ?? null);
        if (title) {
          return { title: compactTitle(title, title), source: "ai" };
        }
      }

      if (!promptTitle && entry.type === "user" && !entry.isMeta) {
        promptTitle = cleanCandidateTitle(titleFromUserContent(entry.message?.content));
      }
    }
  } catch {
    return null;
  }

  return promptTitle ? { title: compactTitle(promptTitle, promptTitle), source: "prompt" } : null;
}

function readClaudeSessionTitle(cwd: string, claudeSessionId: string): string | null {
  return readClaudeSessionTitleDetailed(cwd, claudeSessionId)?.title ?? null;
}

function fallbackClaudeTitleForContinuation(
  cwd: string,
  claudeSessionId: string | undefined,
  codexResult: ClaudeTitleResult | null,
): ClaudeTitleResult | null {
  if (!codexResult) {
    return null;
  }

  if (codexResult.source !== "handoff" && !continuationTitleFallback(codexResult.title)) {
    return codexResult;
  }

  const claudeResult = claudeSessionId ? readClaudeSessionTitleDetailed(cwd, claudeSessionId) : null;
  if (claudeResult) {
    return claudeResult;
  }

  return continuationTitleFallback(codexResult.title) ? null : codexResult;
}

/**
 * Codex sessions have no AI-generated title (there is no `ai-title` line in the
 * Codex transcript), so the best available title is the first real user message.
 * This mirrors the "prompt" fallback in readClaudeSessionTitleDetailed so both
 * runtimes produce a title the same way. Runtime handoffs are marked separately
 * so migrated sections can prefer the previous Claude title when it exists.
 */
function readCodexSessionTitleDetailed(codexThreadId: string): ClaudeTitleResult | null {
  const filePath = findCodexSessionFile(codexThreadId);
  if (!filePath) {
    return null;
  }

  try {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as CodexJsonLine;
      const payload = entry.payload;
      if (entry.type === "event_msg" && payload?.type === "user_message") {
        const result = cleanCandidateTitleResult(codexPayloadText(payload.message));
        if (result) {
          return { title: compactTitle(result.title, result.title), source: result.source };
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

// Trailing-whitespace trim that keeps blank lines. `\s+\n` would also match the
// newline itself, collapsing every paragraph break — see compactBody in
// shared/stream-json.ts.
function trimTrailingSpaces(value: string): string {
  return value.replace(/[^\S\n]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function compactBody(value: string, maxLength = 10_000): string {
  const normalized = trimTrailingSpaces(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function messageBody(value: string): string {
  return trimTrailingSpaces(value);
}

function conversationTextFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    // This is a conversation body, not a title: preserve the literal text.
    // Routing it through cleanCandidateTitle() (a title heuristic) dropped any
    // message under 3 chars — so short prompts like "hi"/"ok" vanished from the
    // transcript on reload while their assistant replies (array content) stayed.
    return content.trim() ? content : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const candidate = part as { type?: unknown; text?: unknown; content?: unknown };
    if (candidate.type === "tool_result") {
      continue;
    }

    if (typeof candidate.text === "string") {
      textParts.push(candidate.text);
    } else if (typeof candidate.content === "string" && candidate.type !== "tool_result") {
      textParts.push(candidate.content);
    }
  }

  return textParts.join("\n\n").trim() || null;
}

function toolItemsFromContent(entry: ClaudeJsonLine, lineIndex: number): ConversationItem[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const messageId = entry.message?.id ?? entry.uuid ?? String(lineIndex);
  const items: ConversationItem[] = [];
  content.forEach((part, partIndex) => {
    if (!part || typeof part !== "object") {
      return;
    }

    const candidate = part as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
      content?: unknown;
      thinking?: unknown;
      tool_use_id?: unknown;
    };
    if (candidate.type === "thinking") {
      items.push({
        id: thinkingItemId(messageId, partIndex),
        kind: "system",
        title: "Thinking",
        body:
          typeof candidate.thinking === "string" && candidate.thinking.trim()
            ? compactBody(candidate.thinking)
            : "Private reasoning step. Claude Code records that thinking happened, but does not expose readable thinking text.",
        timestamp: entry.timestamp,
        sequence: lineIndex * 100 + partIndex,
      });
    }

    if (candidate.type === "tool_use") {
      items.push({
        id: typeof candidate.id === "string" && candidate.id ? toolUseItemId(candidate.id) : `stream:${messageId}:tool:${partIndex}`,
        kind: "tool",
        title: typeof candidate.name === "string" ? candidate.name : "Tool call",
        body: compactBody(toolInputBody(candidate.input)),
        timestamp: entry.timestamp,
        sequence: lineIndex * 100 + partIndex,
      });
    }

    if (candidate.type === "tool_result") {
      const result = toolResultBody(candidate.content);
      items.push({
        id:
          typeof candidate.tool_use_id === "string" && candidate.tool_use_id
            ? toolResultItemId(candidate.tool_use_id)
            : `stream:${messageId}:result:${partIndex}`,
        kind: "tool",
        title: "Tool result",
        body: compactBody(result),
        timestamp: entry.timestamp,
        sequence: lineIndex * 100 + partIndex,
      });
    }
  });

  return items;
}

function emptyTokenUsage(): ClaudeConversationResult["tokenUsage"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(total: ClaudeConversationResult["tokenUsage"], usage?: ClaudeUsage): void {
  if (!usage) {
    return;
  }

  total.inputTokens += usage.input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
  total.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  total.totalTokens =
    total.inputTokens + total.outputTokens + total.cacheCreationInputTokens + total.cacheReadInputTokens;
}

function readClaudeConversation(cwd: string, claudeSessionId: string): ClaudeConversationResult {
  const filePath = join(claudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  if (!existsSync(filePath)) {
    return { items: [], tokenUsage: emptyTokenUsage() };
  }

  const items: ConversationItem[] = [];
  const tokenUsage = emptyTokenUsage();
  try {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    lines.forEach((line, lineIndex) => {
      const entry = JSON.parse(line) as ClaudeJsonLine;
      if (entry.type === "assistant") {
        addUsage(tokenUsage, entry.message?.usage);
      }

      // ai-title entries carry no timestamp; a timestamp-less item makes the
      // feed sort comparator inconsistent and scrambles ordering. The title
      // already shows in the header/sidebar, so skip the card entirely.
      if (entry.type === "user" && !entry.isMeta) {
        const userText = conversationTextFromContent(entry.message?.content);
        if (userText) {
          items.push({
            // Same id scheme as the live stream (which reuses the transcript
            // uuid), so merges never duplicate messages across sources.
            id: messageItemId(entry.uuid ?? `${claudeSessionId}:user:${lineIndex}`),
            kind: "user",
            body: messageBody(userText),
            timestamp: entry.timestamp,
            sequence: lineIndex * 100,
          });
        }
        items.push(...toolItemsFromContent(entry, lineIndex));
        return;
      }

      if (entry.type === "assistant") {
        const assistantText = conversationTextFromContent(entry.message?.content);
        if (assistantText) {
          // The stream keys assistant text by API message id and coalesces
          // multiple content blocks into one card; mirror that here.
          const id = messageItemId(entry.message?.id ?? entry.uuid ?? `${claudeSessionId}:assistant:${lineIndex}`);
          const existing = items.find((item) => item.id === id && item.kind === "assistant");
          const body = messageBody(assistantText);
          if (existing) {
            const existingStripped = strippedBodyForComparison(existing.body);
            const incomingStripped = strippedBodyForComparison(body);
            existing.body = incomingStripped.startsWith(existingStripped)
              ? body
              : existingStripped.includes(incomingStripped)
                ? existing.body
                : `${existing.body}\n\n${body}`;
            existing.timestamp = entry.timestamp ?? existing.timestamp;
            existing.model = entry.message?.model ?? existing.model;
          } else {
            items.push({
              id,
              kind: "assistant",
              body,
              timestamp: entry.timestamp,
              sequence: lineIndex * 100,
              model: entry.message?.model,
            });
          }
        }
        items.push(...toolItemsFromContent(entry, lineIndex));
      }
    });
  } catch {
    return { items: items.slice(-transcriptItemLimit), tokenUsage };
  }

  return { items: items.slice(-transcriptItemLimit), tokenUsage };
}

function codexPayloadText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  const text = conversationTextFromContent(value);
  return text?.trim() || null;
}

function codexToolBody(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function applyCodexTokenUsage(total: ClaudeConversationResult["tokenUsage"], usage: CodexTokenUsage): void {
  if (!usage || typeof usage !== "object") {
    return;
  }

  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0) + Number(usage.reasoning_output_tokens ?? 0);
  const cacheReadInputTokens = Number(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? 0) || inputTokens + outputTokens + cacheReadInputTokens;

  if (totalTokens < total.totalTokens) {
    return;
  }

  total.inputTokens = inputTokens;
  total.outputTokens = outputTokens;
  total.cacheCreationInputTokens = 0;
  total.cacheReadInputTokens = cacheReadInputTokens;
  total.totalTokens = totalTokens;
}

function readCodexConversation(codexThreadId: string): ClaudeConversationResult {
  const filePath = findCodexSessionFile(codexThreadId);
  if (!filePath) {
    return { items: [], tokenUsage: emptyTokenUsage() };
  }

  const items: ConversationItem[] = [];
  const tokenUsage = emptyTokenUsage();

  try {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    lines.forEach((line, lineIndex) => {
      const entry = JSON.parse(line) as CodexJsonLine;
      const payload = entry.payload;
      if (!payload) {
        return;
      }

      if (entry.type === "event_msg" && payload.type === "user_message") {
        const body = codexPayloadText(payload.message);
        if (body) {
          items.push({
            id: messageItemId(`codex:${codexThreadId}:user:${lineIndex}`),
            kind: "user",
            body: messageBody(body),
            timestamp: entry.timestamp,
            sequence: lineIndex * 100,
          });
        }
        return;
      }

      if (entry.type === "event_msg" && payload.type === "agent_message") {
        const body = codexPayloadText(payload.message);
        if (body) {
          items.push({
            id: messageItemId(`codex:${codexThreadId}:assistant:${lineIndex}`),
            kind: "assistant",
            title: "Codex",
            body: messageBody(body),
            timestamp: entry.timestamp,
            sequence: lineIndex * 100,
          });
        }
        return;
      }

      if (entry.type === "event_msg" && payload.type === "token_count") {
        applyCodexTokenUsage(tokenUsage, payload.info?.total_token_usage);
        return;
      }

      if (entry.type !== "response_item") {
        return;
      }

      if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "web_search_call") {
        const callId = payload.call_id ?? payload.id ?? `${codexThreadId}:tool:${lineIndex}`;
        const input = payload.arguments ?? payload.input;
        items.push({
          id: toolUseItemId(String(callId)),
          kind: "tool",
          title: payload.name ?? (payload.type === "web_search_call" ? "Web search" : "Tool call"),
          body: compactBody(codexToolBody(input)),
          timestamp: entry.timestamp,
          sequence: lineIndex * 100,
        });
        return;
      }

      if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const callId = payload.call_id ?? payload.id ?? `${codexThreadId}:result:${lineIndex}`;
        items.push({
          id: toolResultItemId(String(callId)),
          kind: "tool",
          title: "Tool result",
          body: compactBody(codexToolBody(payload.output)),
          timestamp: entry.timestamp,
          sequence: lineIndex * 100,
        });
      }
    });
  } catch {
    return { items: items.slice(-transcriptItemLimit), tokenUsage };
  }

  return { items: items.slice(-transcriptItemLimit), tokenUsage };
}

function readConversation(request: { cwd: string; claudeSessionId?: string; codexThreadId?: string }): ClaudeConversationResult {
  if (request.codexThreadId) {
    return readCodexConversation(request.codexThreadId);
  }

  if (request.claudeSessionId) {
    return readClaudeConversation(request.cwd, request.claudeSessionId);
  }

  return { items: [], tokenUsage: emptyTokenUsage() };
}

// Flattened, searchable user+assistant text per transcript, cached by file
// mtime so repeated searches only re-read a session when it actually changes.
const searchTextCache = new Map<string, { mtimeMs: number; text: string }>();
const searchTextCap = 1_500_000;

function conversationSearchText(cwd: string, claudeSessionId: string): string {
  const filePath = join(claudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return "";
  }

  const cached = searchTextCache.get(claudeSessionId);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.text;
  }

  let text = "";
  try {
    const parts: string[] = [];
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as ClaudeJsonLine;
        if (entry.type === "user" || entry.type === "assistant") {
          const entryText = conversationTextFromContent(entry.message?.content);
          if (entryText) {
            parts.push(entryText);
          }
        }
      } catch {
        // Skip malformed lines; a partial index is better than none.
      }
    }
    text = parts.join("\n").slice(0, searchTextCap);
  } catch {
    text = "";
  }

  searchTextCache.set(claudeSessionId, { mtimeMs, text });
  return text;
}

function searchSnippet(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - 48);
  const end = Math.min(text.length, matchIndex + matchLength + 72);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`;
}

function searchConversations(request: ConversationSearchRequest): ConversationSearchResult[] {
  const query = request.query.trim().toLowerCase();
  if (!query) {
    return [];
  }

  const titleHits: ConversationSearchResult[] = [];
  const contentHits: ConversationSearchResult[] = [];

  for (const session of request.sessions) {
    if (session.title.toLowerCase().includes(query)) {
      titleHits.push({
        id: session.id,
        title: session.title,
        workspaceName: session.workspaceName,
        snippet: "",
        matchedInTitle: true,
      });
      continue;
    }

    if (!session.claudeSessionId) {
      continue;
    }

    const text = conversationSearchText(session.cwd, session.claudeSessionId);
    const matchIndex = text.toLowerCase().indexOf(query);
    if (matchIndex >= 0) {
      contentHits.push({
        id: session.id,
        title: session.title,
        workspaceName: session.workspaceName,
        snippet: searchSnippet(text, matchIndex, query.length),
        matchedInTitle: false,
      });
    }
  }

  // Titles first (the strongest signal), then content matches; both keep the
  // caller's order, which is recency.
  return [...titleHits, ...contentHits];
}

function readRecoveredThread(cwd: string, claudeSessionId: string, mtimeMs: number): PersistedThread | null {
  const filePath = join(claudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  const fallbackTime = new Date(mtimeMs).toISOString();
  let createdAt: string | undefined;
  let lastActiveAt = fallbackTime;
  let lastPromptAt: string | undefined;
  let title: string | null = null;
  let sessionCwd = cwd;

  try {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as ClaudeJsonLine;
      if (entry.timestamp) {
        createdAt ??= entry.timestamp;
        lastActiveAt = entry.timestamp;
      }

      if (entry.cwd) {
        sessionCwd = entry.cwd;
      }

      if (entry.type === "ai-title") {
        const aiTitle = cleanCandidateTitle(entry.aiTitle ?? null);
        if (aiTitle) {
          title = aiTitle;
        }
      }

      if (entry.type === "user" && !entry.isMeta) {
        const userTitle = cleanCandidateTitle(titleFromUserContent(entry.message?.content));
        if (userTitle) {
          lastPromptAt = entry.timestamp ?? lastPromptAt;
          title ??= userTitle;
        }
      }
    }
  } catch {
    return null;
  }

  return {
    id: `claude-${claudeSessionId}`,
    title: compactTitle(title, `Claude ${claudeSessionId.slice(0, 8)}`),
    titleSource: "auto",
    cwd: sessionCwd,
    command: defaultCommand,
    runtime: "claude",
    executionMode: "stream-json",
    claudeSessionId,
    status: "exited",
    agentState: "exited",
    createdAt: createdAt ?? fallbackTime,
    lastActiveAt,
    lastPromptAt,
  };
}

function recoverClaudeThreads(cwds: string[]): PersistedThread[] {
  const candidates: PersistedThread[] = [];

  for (const cwd of new Set(cwds)) {
    const sessionsByMtime = Array.from(readClaudeSessions(cwd).entries()).sort((first, second) => second[1] - first[1]);
    for (const [claudeSessionId, mtimeMs] of sessionsByMtime.slice(0, maxRecoveredThreads)) {
      const thread = readRecoveredThread(cwd, claudeSessionId, mtimeMs);
      if (thread) {
        candidates.push(thread);
      }
    }
  }

  const bySessionId = new Map<string, PersistedThread>();
  for (const thread of candidates.sort((first, second) => second.lastActiveAt.localeCompare(first.lastActiveAt))) {
    if (thread.claudeSessionId && !bySessionId.has(thread.claudeSessionId)) {
      bySessionId.set(thread.claudeSessionId, thread);
    }
  }

  return Array.from(bySessionId.values()).slice(0, maxRecoveredThreads);
}

function loadPersistedThreads(): PersistedThread[] {
  const storedThreads = readStoredThreads();
  const firstStoredThread = storedThreads[0];
  const shouldRecover =
    storedThreads.length === 0 || (storedThreads.length === 1 && firstStoredThread && isPlaceholderThread(firstStoredThread));

  if (!shouldRecover) {
    const refreshedThreads = storedThreads.map((thread) => {
      if (thread.titleSource === "manual") {
        return thread;
      }

      const fromTranscript =
        thread.runtime === "codex" && thread.codexThreadId
          ? fallbackClaudeTitleForContinuation(
              thread.cwd,
              thread.claudeSessionId,
              readCodexSessionTitleDetailed(thread.codexThreadId),
            )?.title ?? null
          : thread.claudeSessionId
            ? readClaudeSessionTitle(thread.cwd, thread.claudeSessionId)
            : null;
      if (fromTranscript) {
        return fromTranscript !== thread.title
          ? { ...thread, title: fromTranscript, titleSource: "auto" as const }
          : thread;
      }

      // No transcript title available (e.g. the session file was rotated away).
      // Older builds sometimes stored a raw system wrapper as the title; salvage
      // a command name if we can, otherwise fall back to the neutral placeholder
      // so the list never shows leaked XML.
      const salvaged = cleanCandidateTitle(thread.title);
      if (salvaged && salvaged !== thread.title) {
        return { ...thread, title: salvaged, titleSource: "auto" as const };
      }
      if (!salvaged && looksLikeMetaTitle(thread.title)) {
        return { ...thread, title: "Untitled" };
      }
      return thread;
    });
    writeStoredThreads(refreshedThreads);
    return refreshedThreads;
  }

  const recoveredThreads = recoverClaudeThreads([defaultWorkspace, ...storedThreads.map((thread) => thread.cwd)]);
  if (recoveredThreads.length > 0) {
    writeStoredThreads(recoveredThreads);
    return recoveredThreads;
  }

  return storedThreads;
}

function readNewUserPrompts(
  cwd: string,
  before: ClaudeSessionSnapshot,
  startedAt: number,
  seenPromptKeys: Set<string>,
): Array<{ claudeSessionId: string; submittedAt: string }> {
  const projectDir = claudeProjectDir(cwd);
  const prompts: Array<{ claudeSessionId: string; submittedAt: string }> = [];

  if (!existsSync(projectDir)) {
    return prompts;
  }

  for (const [claudeSessionId, mtimeMs] of readClaudeSessions(cwd)) {
    const previousMtime = before.get(claudeSessionId);
    if (previousMtime !== undefined && mtimeMs <= previousMtime + 1) {
      continue;
    }

    try {
      const filePath = join(projectDir, `${claudeSessionId}.jsonl`);
      const lines = readFileSync(filePath, "utf8").trim().split("\n").slice(-25);
      for (const line of lines) {
        const entry = JSON.parse(line) as ClaudeJsonLine;
        if (entry.type === "user" && entry.timestamp && new Date(entry.timestamp).getTime() >= startedAt - 2_000) {
          const promptKey = `${entry.sessionId ?? claudeSessionId}:${entry.timestamp}`;
          if (!seenPromptKeys.has(promptKey)) {
            seenPromptKeys.add(promptKey);
            prompts.push({ claudeSessionId: entry.sessionId ?? claudeSessionId, submittedAt: entry.timestamp });
          }
        }
      }
    } catch {
      continue;
    }
  }

  return prompts.sort((first, second) => first.submittedAt.localeCompare(second.submittedAt));
}

function stopClaudeSessionDetector(id: string): void {
  const detector = claudeSessionDetectors.get(id);
  if (detector) {
    clearInterval(detector);
    claudeSessionDetectors.delete(id);
  }
  detectedClaudeSessions.delete(id);
}

function detectClaudeSession(id: string, cwd: string, before: ClaudeSessionSnapshot, startedAt: number): void {
  stopClaudeSessionDetector(id);

  let snapshot = before;
  const seenPromptKeys = new Set<string>();
  const detector = setInterval(() => {
    if (!sessions.has(id)) {
      stopClaudeSessionDetector(id);
      return;
    }

    const nextSnapshot = readClaudeSessions(cwd);
    const prompts = readNewUserPrompts(cwd, snapshot, startedAt, seenPromptKeys);
    const promptSessionId = prompts.at(-1)?.claudeSessionId;
    let claudeSessionId = detectedClaudeSessions.get(id);

    if (!claudeSessionId && promptSessionId) {
      claudeSessionId = promptSessionId;
      detectedClaudeSessions.set(id, promptSessionId);
    }

    if (!claudeSessionId) {
      const changedClaudeSessionId = newestChangedSession(snapshot, nextSnapshot, startedAt);
      if (changedClaudeSessionId) {
        claudeSessionId = changedClaudeSessionId;
        detectedClaudeSessions.set(id, changedClaudeSessionId);
      }
    }

    if (claudeSessionId && changedExistingSession(snapshot, nextSnapshot, claudeSessionId)) {
      sendToLiveWindows("session:claude-session", { id, claudeSessionId });
      const title = readClaudeSessionTitle(cwd, claudeSessionId);
      if (title) {
        sendToLiveWindows("session:title", { id, title });
      }
      const conversation = readClaudeConversation(cwd, claudeSessionId);
      sendToLiveWindows("session:conversation", { id, claudeSessionId, ...conversation });
    }

    for (const prompt of prompts) {
      if (claudeSessionId && prompt.claudeSessionId !== claudeSessionId) {
        continue;
      }
      sendToLiveWindows("session:prompt-submitted", { id, submittedAt: prompt.submittedAt });
    }

    snapshot = nextSnapshot;
  }, 1_000);

  claudeSessionDetectors.set(id, detector);
}

/** Most a task's output tail may contribute to a snapshot. */
const taskOutputTailLimit = 4_000;

/**
 * A background shell writes its stdout/stderr to a file and streams none of it,
 * so its card would otherwise have nothing to show. Read the tail here (main
 * has fs; the shared reducer is imported by the renderer too) and attach it.
 * Only shell tasks: a real subagent's output_file is its whole JSONL
 * transcript, and its content already arrives as nested items.
 */
function withHydratedTaskOutput(items: ConversationItem[]): ConversationItem[] {
  return items.map((item) => {
    const agent = item.agent;
    if (item.kind !== "agent" || !agent?.outputFile || agent.subagentType !== undefined) {
      return item;
    }

    try {
      const { size } = statSync(agent.outputFile);
      const start = Math.max(0, size - taskOutputTailLimit);
      const handle = openSync(agent.outputFile, "r");
      try {
        const buffer = Buffer.alloc(Math.min(size, taskOutputTailLimit));
        readSync(handle, buffer, 0, buffer.length, start);
        const text = buffer.toString("utf8").trim();
        if (!text) {
          return item;
        }
        return { ...item, agent: { ...agent, outputTail: start > 0 ? `…${text}` : text } };
      } finally {
        closeSync(handle);
      }
    } catch {
      // The file is written by the CLI and may not exist yet, or at all.
      return item;
    }
  });
}

function sendStreamSnapshot(
  id: string,
  streamSession: {
    state: StreamJsonState;
    runtime?: AgentRuntime;
    request?: { runtime?: AgentRuntime; model?: string };
  },
): void {
  // The exec path passes a full StreamSession (has `.runtime`); the app-server
  // path passes a CodexAppServerSession (has `.request.runtime`, always codex).
  // Fall back to the codex thread id, then claude, so a remote client can always
  // resolve which runtime backs the session.
  const runtimeKind =
    streamSession.runtime ??
    streamSession.request?.runtime ??
    (streamSession.state.codexThreadId ? "codex" : "claude");
  const runtime = streamRuntimeEvent(id, streamSession.state, runtimeKind);
  // Snapshots are the one place every runtime's usage passes through, so this is
  // where the durable cost ledger is fed. It stores deltas, so being called on
  // every event is cheap and idempotent.
  usageLedger().record({
    sessionId: id,
    runtime: runtimeKind,
    // Claude reports the resolved model on every assistant message. Codex only
    // reports it when a thread is *started* (not resumed), so fall back to the
    // model the section was launched with; an unset model stays unattributed
    // rather than being priced as a guess.
    model: streamSession.state.latestModel || streamSession.request?.model,
    cumulative: streamSession.state.tokenUsage,
  });
  sendToLiveWindows("session:runtime", runtime);
  sendToLiveWindows("session:conversation", {
    id,
    claudeSessionId: streamSession.state.claudeSessionId,
    codexThreadId: streamSession.state.codexThreadId,
    items: withHydratedTaskOutput(streamSession.state.items.slice(-120)),
    tokenUsage: streamSession.state.tokenUsage,
  });

  if (streamSession.state.claudeSessionId) {
    sendToLiveWindows("session:claude-session", { id, claudeSessionId: streamSession.state.claudeSessionId });
  }
}

function processStreamLine(id: string, line: string): void {
  const streamSession = streamSessions.get(id);
  if (!streamSession) {
    return;
  }

  const parsed = parseStreamJsonLine(line);
  if (!parsed.ok) {
    logMain("stream-json:parse-error", { id, error: parsed.error, line: parsed.line });
    return;
  }

  const previousSessionId = streamSession.state.claudeSessionId;
  const previousCodexThreadId = streamSession.state.codexThreadId;
  applyStreamJsonEvent(streamSession.state, parsed.event);
  if (streamSession.runtime === "codex" && streamSession.state.codexThreadId !== previousCodexThreadId) {
    streamSession.request = {
      ...streamSession.request,
      codexThreadId: streamSession.state.codexThreadId,
    };
    streamResumeRequests.set(id, streamSession.request);
  }
  logMain("stream-json:event", {
    id,
    runtime: streamSession.runtime,
    type: streamSession.state.currentEventType,
    claudeSessionId: streamSession.state.claudeSessionId,
    codexThreadId: streamSession.state.codexThreadId,
    latestTool: streamSession.state.latestTool,
    latestCommand: streamSession.state.latestCommand,
  });
  sendStreamSnapshot(id, streamSession);

  // Sync the session title on the first appearance of the runtime's session id
  // (provisional prompt-derived title) and again on every turn boundary until
  // the final title lands — the transcript file may not be written yet at start,
  // so a single read would miss it and leave the mobile list showing the raw
  // session id. Claude upgrades the prompt title to an AI one after the first
  // exchange; Codex has no AI title but still needs the same prompt-derived
  // title synced, otherwise its sessions show up untitled on mobile.
  if (streamSession.runtime === "claude" && streamSession.state.claudeSessionId) {
    const turnEnded = streamSession.state.currentEventType.startsWith("result");
    if (!previousSessionId || turnEnded) {
      syncSessionTitle(id, streamSession);
    }
  } else if (streamSession.runtime === "codex" && streamSession.state.codexThreadId) {
    const turnEnded = streamSession.state.currentEventType === "turn.completed";
    if (!previousCodexThreadId || turnEnded) {
      syncSessionTitle(id, streamSession);
    }
  }
}

/** Reads the current best title for a stream session, dispatching by runtime. */
function readStreamSessionTitleDetailed(streamSession: StreamSession): ClaudeTitleResult | null {
  if (streamSession.runtime === "codex") {
    const threadId = streamSession.state.codexThreadId;
    return threadId
      ? fallbackClaudeTitleForContinuation(
          streamSession.cwd,
          streamSession.request.claudeSessionId,
          readCodexSessionTitleDetailed(threadId),
        )
      : null;
  }
  const claudeSessionId = streamSession.state.claudeSessionId;
  return claudeSessionId ? readClaudeSessionTitleDetailed(streamSession.cwd, claudeSessionId) : null;
}

function syncSessionTitle(id: string, streamSession: StreamSession): void {
  if (streamSession.titleLocked) {
    return;
  }
  const result = readStreamSessionTitleDetailed(streamSession);
  if (!result) {
    return;
  }
  if (result.title !== streamSession.emittedTitle) {
    streamSession.emittedTitle = result.title;
    sendToLiveWindows("session:title", { id, title: result.title });
  }
  // Claude replaces its provisional prompt title with an AI one after the first
  // exchange; Codex has no AI title, so its prompt-derived title is already
  // final. In both cases the title never changes again once we reach it, so
  // stop re-reading.
  if (result.source === "ai" || streamSession.runtime === "codex") {
    streamSession.titleLocked = true;
  }
}

// Sync a codex app-server section's title. app-server threads persist to
// ~/.codex/sessions like exec threads, so the prompt-derived title reader works
// once the thread id is known. Codex titles are final, so this locks after one hit.
function syncAppServerTitle(id: string, session: CodexAppServerSession): void {
  if (session.titleLocked || !session.threadId) {
    return;
  }
  const result = fallbackClaudeTitleForContinuation(
    session.cwd,
    session.request.claudeSessionId,
    readCodexSessionTitleDetailed(session.threadId),
  );
  if (!result) {
    return;
  }
  if (result.title !== session.emittedTitle) {
    session.emittedTitle = result.title;
    sendToLiveWindows("session:title", { id, title: result.title });
  }
  session.titleLocked = true;
}

const codexAppServerManager = new CodexAppServerSessionManager({
  createClient: (handlers) =>
    new CodexAppServerClient({
      spawn: () => spawnChild("codex", ["app-server"], { cwd: app.getPath("home"), env: ptyEnvironment() }),
      clientInfo: { name: "panda_code", title: "Panda Code", version: app.getVersion() },
      logMain,
      onNotification: handlers.onNotification,
      onServerRequest: handlers.onServerRequest,
      onExit: handlers.onExit,
    }),
  logMain,
  // Opt-in: lets Codex ask the operator a question mid-turn
  // (`item/tool/requestUserInput`). Panda can answer it, but Codex still ships
  // the tool off by default, so we honor that unless asked.
  experimentalFeatures:
    process.env.PANDA_CODE_CODEX_REQUEST_USER_INPUT === "1" ? { default_mode_request_user_input: true } : undefined,
  sendSnapshot: (id, session) => sendStreamSnapshot(id, session),
  syncTitle: syncAppServerTitle,
});

function startStreamSession(request: SessionStartRequest): SessionStartResult {
  // Every Codex section runs on the app-server transport: one persistent
  // process, threads per section, turns per prompt. The legacy
  // `codex exec --json` path (a child process per turn, respawned to resume,
  // with a blank state each time) is gone.
  if (request.runtime === "codex") {
    // The app-server path is async (thread/start over JSON-RPC) but callers
    // expect a synchronous ack. Kick it off and let state flow via snapshots;
    // startup failures surface as a needs_action snapshot from the manager.
    logMain("app-server:start", { id: request.id, cwd: request.cwd, codexThreadId: request.codexThreadId });
    refreshSleepBlocker();
    // Record how to re-open this thread. Without it, a prompt arriving after the
    // section left the manager (stopped, or the app-server died) has nothing to
    // resume from and is reported as dropped.
    streamResumeRequests.set(request.id, request);
    void codexAppServerManager.start(request).then((result) => {
      if (!result.ok) {
        logMain("app-server:start-failed", { id: request.id, message: result.message });
        return;
      }
      const threadId = codexAppServerManager.get(request.id)?.threadId;
      if (threadId && threadId !== request.codexThreadId) {
        streamResumeRequests.set(request.id, { ...request, codexThreadId: threadId });
      }
    });
    return { ok: true };
  }

  const existing = streamSessions.get(request.id);
  if (existing) {
    logMain("stream-json:start-existing", { id: request.id });
    return { ok: true };
  }

  try {
    const { executable, args, runtime } = buildStreamCommand(request);
    logMain("stream-json:start", {
      id: request.id,
      runtime,
      cwd: request.cwd,
      executable,
      args,
      claudeSessionId: request.claudeSessionId,
      codexThreadId: request.codexThreadId,
      model: request.model,
      effort: request.effort,
      permissionMode: request.permissionMode,
    });
    const child = spawnChild(executable, args, {
      cwd: request.cwd,
      env: ptyEnvironment(),
      stdio: "pipe",
    });
    child.stdin.setDefaultEncoding("utf8");
    streamResumeRequests.set(request.id, request);

    const streamSession: StreamSession = {
      process: child,
      runtime,
      state: createStreamJsonState(),
      stdoutBuffer: "",
      cwd: request.cwd,
      request,
    };
    streamSessions.set(request.id, streamSession);
    refreshSleepBlocker();
    sendStreamSnapshot(request.id, streamSession);

    child.stdout.on("data", (chunk: Buffer) => {
      sendToLiveWindows("session:data", { id: request.id, data: chunk.toString("utf8") });
      streamSession.stdoutBuffer += chunk.toString("utf8");
      const lines = streamSession.stdoutBuffer.split(/\r?\n/);
      streamSession.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processStreamLine(request.id, line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      logMain("stream-json:stderr", { id: request.id, data: compactLogValue(data) });
      sendToLiveWindows("session:data", { id: request.id, data });
    });

    child.on("error", (error) => {
      logMain("stream-json:error", { id: request.id, message: error.message });
      streamSession.state.agentState = "needs_action";
      streamSession.state.currentEventType = "process:error";
      streamSession.state.lastEventAt = new Date().toISOString();
      sendStreamSnapshot(request.id, streamSession);
    });

    child.on("close", (exitCode, signal) => {
      if (streamSessions.get(request.id) !== streamSession) {
        logMain("stream-json:stale-exit", { id: request.id, exitCode, signal });
        return;
      }
      if (streamSession.stdoutBuffer.trim()) {
        processStreamLine(request.id, streamSession.stdoutBuffer);
      }
      streamSessions.delete(request.id);
      refreshSleepBlocker();

      streamSession.state.agentState = "exited";
      streamSession.state.currentEventType = "process:exit";
      streamSession.state.lastEventAt = new Date().toISOString();
      sendStreamSnapshot(request.id, streamSession);
      logMain("stream-json:exit", { id: request.id, exitCode, signal });
      const payload: SessionExitEvent = { id: request.id, exitCode: exitCode ?? undefined, signal: undefined };
      sendToLiveWindows("session:exit", payload);
    });

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start agent stream.";
    logMain("stream-json:start-error", { id: request.id, message });
    return { ok: false, message };
  }
}

type BtwArgsDecision = {
  mode: "fork" | "resume";
  sideSessionId: string;
  parentClaudeSessionId?: string;
  transcript?: string;
  model?: string;
  question: string;
};

// Wrap the section's transcript tail and the question into a single prompt so the
// aside reads the recent work as context. Runtime-agnostic: the transcript may
// span Claude and Codex and already carries tool calls and code.
function buildBtwSeedPrompt(transcript: string, question: string): string {
  return [
    "You are answering a side question about the Panda Code session transcribed below.",
    "The transcript is the recent activity of that session, oldest first and most recent last.",
    "It may span multiple agent runtimes (e.g. Claude and Codex) and includes tool calls and code.",
    "",
    "<session-transcript>",
    transcript,
    "</session-transcript>",
    "",
    `Question: ${question}`,
  ].join("\n");
}

function buildCodexBtwPrompt(transcript: string | undefined, question: string): string {
  const seed = transcript?.trim() ? buildBtwSeedPrompt(transcript, question) : `Question: ${question}`;
  return [btwSystemPrompt, "", seed].join("\n");
}

function buildBtwArgs(decision: BtwArgsDecision): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt",
    btwSystemPrompt,
  ];

  let prompt = decision.question;
  const transcript = decision.transcript?.trim();
  if (decision.mode === "resume") {
    // Follow-up question: continue the same aside so it remembers earlier /btw
    // turns (and the context it was seeded/forked with).
    args.push("--resume", decision.sideSessionId);
  } else if (transcript) {
    // First question: seed a fresh aside with the section's live transcript
    // instead of forking the runtime session. This stays current across a
    // Claude→Codex handoff and never trips auto-compaction on a long run. The
    // side-session id is one we control, so it's excluded from session detection.
    args.push("--session-id", decision.sideSessionId);
    prompt = buildBtwSeedPrompt(transcript, decision.question);
  } else if (decision.parentClaudeSessionId) {
    // No transcript supplied (e.g. a phone-issued ask): fall back to forking the
    // live Claude session so the aside still inherits its context natively.
    args.push("--resume", decision.parentClaudeSessionId, "--fork-session", "--session-id", decision.sideSessionId);
  } else {
    // Nothing to seed from: a fresh side-session with no prior context.
    args.push("--session-id", decision.sideSessionId);
  }

  if (decision.model?.trim()) {
    args.push("--model", decision.model.trim());
  }

  args.push(prompt);
  return args;
}

function emitBtwEvent(threadId: string, state: StreamJsonState, status: BtwEvent["status"], error?: string): void {
  const event: BtwEvent = {
    threadId,
    sideSessionId: state.claudeSessionId ?? state.codexThreadId,
    items: state.items.slice(-200),
    tokenUsage: state.tokenUsage,
    status,
    error,
  };
  sendToLiveWindows("btw:data", event);
}

function processBtwLine(threadId: string, line: string): void {
  const btw = btwProcesses.get(threadId);
  if (!btw) {
    return;
  }

  const parsed = parseStreamJsonLine(line);
  if (!parsed.ok) {
    logMain("btw:parse-error", { threadId, error: parsed.error, line: parsed.line });
    return;
  }

  applyStreamJsonEvent(btw.state, parsed.event);
  emitBtwEvent(threadId, btw.state, "running");
}

function removeBtwTranscript(cwd: string, sideSessionId: string): void {
  try {
    const filePath = join(claudeProjectDir(cwd), `${sideSessionId}.jsonl`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (error) {
    logMain("btw:cleanup-error", { sideSessionId, message: error instanceof Error ? error.message : String(error) });
  }
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function codexThreadIdFromNotification(method: string, params: unknown): string | undefined {
  const payload = recordFrom(params) ?? {};
  const direct = payload.threadId;
  if (typeof direct === "string") return direct;
  if (method === "thread/started") {
    const thread = recordFrom(payload.thread);
    if (typeof thread?.id === "string") return thread.id;
  }
  return undefined;
}

const BTW_CONTEXT_CHAR_LIMIT = 20_000;
const BTW_TIMEOUT_MS = 180_000;

function speakerForBtwContext(item: ConversationItem): string {
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

function serializeBtwContextForMain(items: ConversationItem[], limit = BTW_CONTEXT_CHAR_LIMIT): string {
  const blocks = items
    .filter((item) => item.kind !== "marker" && !item.id.startsWith("local-thinking:") && item.body.trim())
    .map((item) => {
      const block = `## ${speakerForBtwContext(item)}\n${item.body.trim()}`;
      if (!item.parentAgentId) return block;
      return block
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    });

  while (blocks.length > 1 && blocks.join("\n\n").length > limit) {
    blocks.shift();
  }

  const transcript = blocks.join("\n\n");
  return transcript.length > limit ? transcript.slice(-limit) : transcript;
}

function codexBtwTranscript(request: { transcript?: string; cwd: string; codexThreadId?: string }): string | undefined {
  const provided = request.transcript?.trim();
  if (provided) return provided;
  if (!request.codexThreadId) return undefined;
  try {
    return serializeBtwContextForMain(readConversation({ cwd: request.cwd, codexThreadId: request.codexThreadId }).items);
  } catch (error) {
    logMain("btw:codex-context-error", {
      codexThreadId: request.codexThreadId,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

type CodexBtwRunRequest = {
  threadId: string;
  cwd: string;
  question: string;
  transcript?: string;
  sideThreadId?: string;
  model?: string;
  effort?: string;
  state?: StreamJsonState;
  onUpdate?: (state: StreamJsonState) => void;
  onSideThreadId?: (sideThreadId: string) => void;
};

type CodexBtwRun = {
  state: StreamJsonState;
  cancel: () => void;
  promise: Promise<RemoteBtwResult & { sideThreadId?: string }>;
};

function createCodexBtwRun(request: CodexBtwRunRequest): CodexBtwRun {
  const state = request.state ?? createStreamJsonState();
  let client: CodexAppServerClient | null = null;
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
    client?.dispose();
  };

  const promise = new Promise<RemoteBtwResult & { sideThreadId?: string }>((resolve) => {
    let settled = false;
    let sideThreadId = request.sideThreadId;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: RemoteBtwResult & { sideThreadId?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.dispose();
      resolve({ ...result, sideThreadId });
    };
    timer = setTimeout(() => {
      finish({ ok: false, message: "Codex /btw timed out." });
    }, BTW_TIMEOUT_MS);

    client = new CodexAppServerClient({
      spawn: () => spawnChild(defaultCodexCommand, ["app-server"], { cwd: app.getPath("home"), env: ptyEnvironment() }),
      clientInfo: { name: "panda_code_btw", title: "Panda Code /btw", version: app.getVersion() },
      logMain,
      onNotification: (note) => {
        const noteThreadId = codexThreadIdFromNotification(note.method, note.params);
        if (noteThreadId && sideThreadId && noteThreadId !== sideThreadId) return;
        if (noteThreadId && !sideThreadId) {
          sideThreadId = noteThreadId;
          request.onSideThreadId?.(noteThreadId);
        }
        applyAppServerNotification(state, note.method, note.params);
        request.onUpdate?.(state);
        if (note.method !== "turn/completed") return;
        const turn = recordFrom(recordFrom(note.params)?.turn);
        const status = typeof turn?.status === "string" ? turn.status : undefined;
        const error = recordFrom(turn?.error);
        const message =
          typeof error?.message === "string" && error.message.trim()
            ? error.message.trim()
            : status === "failed"
              ? "Codex failed to answer /btw."
              : undefined;
        finish(message ? { ok: false, message } : { ok: true, answer: finalAssistantText(state) || "(No answer was produced.)" });
      },
      onServerRequest: (serverRequest) => {
        client?.respondError(serverRequest.id, -32601, "/btw is a read-only side question and cannot answer tool requests.");
      },
      onExit: (code) => {
        if (!settled && !cancelled) {
          finish({ ok: false, message: `Codex exited with code ${code ?? "unknown"}.` });
        }
      },
    });

    void (async () => {
      try {
        await client!.start();
        if (sideThreadId) {
          const resumed = (await client!.request("thread/resume", {
            threadId: sideThreadId,
            cwd: request.cwd,
            sandbox: "read-only",
            approvalPolicy: "never",
          })) as { thread?: { id?: string } };
          sideThreadId = resumed?.thread?.id ?? sideThreadId;
        } else {
          const threadParams: Record<string, unknown> = {
            cwd: request.cwd,
            sandbox: "read-only",
            approvalPolicy: "never",
          };
          if (request.model?.trim()) threadParams.model = request.model.trim();
          const started = (await client!.request("thread/start", threadParams)) as { thread?: { id?: string }; model?: string };
          sideThreadId = started?.thread?.id;
          if (typeof started?.model === "string") state.latestModel = started.model;
        }
        if (!sideThreadId) {
          finish({ ok: false, message: "Codex did not return a /btw thread id." });
          return;
        }
        state.codexThreadId = sideThreadId;
        request.onSideThreadId?.(sideThreadId);
        request.onUpdate?.(state);
        const overrides: Record<string, unknown> = {};
        if (request.model?.trim()) overrides.model = request.model.trim();
        if (request.effort?.trim()) overrides.effort = request.effort.trim();
        await client!.request("turn/start", {
          threadId: sideThreadId,
          input: [{ type: "text", text: buildCodexBtwPrompt(request.transcript, request.question), text_elements: [] }],
          ...overrides,
        });
      } catch (error) {
        if (!settled && !cancelled) {
          finish({ ok: false, message: error instanceof Error ? error.message : "Could not start Codex /btw." });
        }
      }
    })();
  });

  return { state, cancel, promise };
}

function startBtwAsk(request: BtwAskRequest): BtwAskResult {
  if (btwProcesses.has(request.threadId)) {
    return { ok: false, message: "A /btw question is already in progress." };
  }

  if (!existsSync(request.cwd)) {
    return { ok: false, message: "Workspace folder does not exist." };
  }

  const question = request.question.trim();
  if (!question) {
    return { ok: false, message: "Ask a question after /btw." };
  }

  const identity = btwIdentities.get(request.threadId);
  const resuming = Boolean(identity?.sideSessionId);
  const runtime = request.runtime ?? "claude";

  if (runtime === "codex") {
    const transcript = codexBtwTranscript(request);
    const run = createCodexBtwRun({
      threadId: request.threadId,
      cwd: request.cwd,
      question,
      transcript,
      sideThreadId: identity?.sideSessionId,
      model: request.model,
      effort: request.effort,
      onUpdate: (state) => emitBtwEvent(request.threadId, state, "running"),
      onSideThreadId: (sideThreadId) => {
        btwIdentities.set(request.threadId, { sideSessionId: sideThreadId, cwd: request.cwd, runtime });
      },
    });
    const btw: BtwProcess = {
      cancel: run.cancel,
      state: run.state,
      stdoutBuffer: "",
      sideSessionId: identity?.sideSessionId,
    };
    btwProcesses.set(request.threadId, btw);
    if (!identity) {
      btwIdentities.set(request.threadId, { cwd: request.cwd, runtime });
    }
    emitBtwEvent(request.threadId, run.state, "running");
    logMain("btw:start", {
      threadId: request.threadId,
      runtime,
      sideSessionId: identity?.sideSessionId,
      resuming,
      seeded: !resuming && Boolean(transcript?.trim()),
      forkedFrom: undefined,
      model: request.model,
    });
    void run.promise.then((result) => {
      if (btwProcesses.get(request.threadId) !== btw) return;
      btwProcesses.delete(request.threadId);
      logMain("btw:exit", {
        threadId: request.threadId,
        runtime,
        ok: result.ok,
        sideSessionId: result.sideThreadId,
      });
      emitBtwEvent(request.threadId, run.state, result.ok ? "idle" : "error", result.ok ? undefined : result.message);
    });
    return { ok: true };
  }

  let sideSessionId: string;
  let args: string[];
  if (identity?.sideSessionId) {
    sideSessionId = identity.sideSessionId;
    args = buildBtwArgs({ mode: "resume", sideSessionId, model: request.model, question });
  } else {
    sideSessionId = randomUUID();
    btwSideSessionIds.add(sideSessionId);
    btwIdentities.set(request.threadId, { sideSessionId, cwd: request.cwd, runtime });
    args = buildBtwArgs({
      mode: "fork",
      sideSessionId,
      parentClaudeSessionId: request.parentClaudeSessionId,
      transcript: request.transcript,
      model: request.model,
      question,
    });
  }

  try {
    const { executable } = streamCompatibleCommandParts(defaultCommand);
    logMain("btw:start", {
      threadId: request.threadId,
      sideSessionId,
      resuming,
      seeded: !resuming && Boolean(request.transcript?.trim()),
      forkedFrom: resuming || request.transcript?.trim() ? undefined : request.parentClaudeSessionId,
      model: request.model,
    });
    const child = spawnChild(executable, args, {
      cwd: request.cwd,
      env: ptyEnvironment(),
      stdio: "pipe",
    });
    // The question rides in as a positional arg; nothing is read from stdin, so
    // close it right away rather than leaving the child waiting on input.
    child.stdin.end();

    const btw: BtwProcess = {
      process: child,
      state: createStreamJsonState(),
      stdoutBuffer: "",
      sideSessionId,
    };
    btwProcesses.set(request.threadId, btw);
    emitBtwEvent(request.threadId, btw.state, "running");

    child.stdout.on("data", (chunk: Buffer) => {
      btw.stdoutBuffer += chunk.toString("utf8");
      const lines = btw.stdoutBuffer.split(/\r?\n/);
      btw.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processBtwLine(request.threadId, line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      logMain("btw:stderr", { threadId: request.threadId, data: compactLogValue(chunk.toString("utf8")) });
    });

    child.on("error", (error) => {
      logMain("btw:error", { threadId: request.threadId, message: error.message });
      btwProcesses.delete(request.threadId);
      emitBtwEvent(request.threadId, btw.state, "error", error.message);
    });

    child.on("close", (exitCode) => {
      if (btw.stdoutBuffer.trim()) {
        processBtwLine(request.threadId, btw.stdoutBuffer);
      }
      btwProcesses.delete(request.threadId);
      const failed = typeof exitCode === "number" && exitCode !== 0;
      logMain("btw:exit", { threadId: request.threadId, exitCode, sideSessionId });
      emitBtwEvent(
        request.threadId,
        btw.state,
        failed ? "error" : "idle",
        failed ? `Claude exited with code ${exitCode}.` : undefined,
      );
    });

    return { ok: true };
  } catch (error) {
    btwProcesses.delete(request.threadId);
    const message = error instanceof Error ? error.message : "Could not start the /btw query.";
    logMain("btw:start-error", { threadId: request.threadId, message });
    return { ok: false, message };
  }
}

function clearBtw(threadId: string): void {
  const running = btwProcesses.get(threadId);
  if (running) {
    running.cancel?.();
    running.process?.kill();
    btwProcesses.delete(threadId);
  }

  const identity = btwIdentities.get(threadId);
  btwIdentities.delete(threadId);
  if (identity?.sideSessionId && (identity.runtime ?? "claude") === "claude") {
    btwSideSessionIds.delete(identity.sideSessionId);
    removeBtwTranscript(identity.cwd, identity.sideSessionId);
  }
  logMain("btw:clear", { threadId, sideSessionId: identity?.sideSessionId });
}

// Remote (phone-issued) /btw asides. Kept separate from the desktop panel's
// btw maps so the two never collide on the same session id. One aside per
// session is reused across turns (resume), so follow-ups keep their context.
const remoteBtwIdentities = new Map<string, { sideSessionId: string; cwd: string }>();
const remoteBtwInFlight = new Set<string>();

function finalAssistantText(state: StreamJsonState): string {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (item && item.kind === "assistant" && item.body.trim()) return item.body.trim();
  }
  return "";
}

async function runRemoteBtwAsk(request: RemoteBtwRequest): Promise<RemoteBtwResult> {
  if (remoteBtwInFlight.has(request.threadId)) {
    return { ok: false, message: "A /btw question is already in progress." };
  }
  if (!existsSync(request.cwd)) {
    return { ok: false, message: "Workspace folder does not exist." };
  }
  const question = request.question.trim();
  if (!question) {
    return { ok: false, message: "Ask a question after /btw." };
  }

  const runtime = request.runtime ?? "claude";
  const identity = remoteBtwIdentities.get(request.threadId);
  remoteBtwInFlight.add(request.threadId);

  if (runtime === "codex") {
    try {
      const transcript = codexBtwTranscript(request);
      const run = createCodexBtwRun({
        threadId: request.threadId,
        cwd: request.cwd,
        question,
        transcript,
        sideThreadId: identity?.sideSessionId,
        model: request.model,
        effort: request.effort,
      });
      logMain("remote-btw:start", {
        threadId: request.threadId,
        runtime,
        sideSessionId: identity?.sideSessionId,
        resuming: Boolean(identity?.sideSessionId),
        seeded: !identity?.sideSessionId && Boolean(transcript?.trim()),
      });
      const result = await run.promise;
      if (result.sideThreadId) {
        remoteBtwIdentities.set(request.threadId, { sideSessionId: result.sideThreadId, cwd: request.cwd });
      }
      logMain("remote-btw:exit", { threadId: request.threadId, runtime, ok: result.ok, sideSessionId: result.sideThreadId });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the Codex /btw query.";
      logMain("remote-btw:start-error", { threadId: request.threadId, runtime, message });
      return { ok: false, message };
    } finally {
      remoteBtwInFlight.delete(request.threadId);
    }
  }

  let sideSessionId: string;
  let args: string[];
  if (identity?.sideSessionId) {
    sideSessionId = identity.sideSessionId;
    args = buildBtwArgs({ mode: "resume", sideSessionId, model: "haiku", question });
  } else {
    sideSessionId = randomUUID();
    btwSideSessionIds.add(sideSessionId);
    remoteBtwIdentities.set(request.threadId, { sideSessionId, cwd: request.cwd });
    args = buildBtwArgs({
      mode: "fork",
      sideSessionId,
      parentClaudeSessionId: request.parentClaudeSessionId,
      model: "haiku",
      question,
    });
  }

  return new Promise((resolve) => {
    const done = (result: RemoteBtwResult): void => {
      remoteBtwInFlight.delete(request.threadId);
      resolve(result);
    };

    try {
      const { executable } = streamCompatibleCommandParts(defaultCommand);
      logMain("remote-btw:start", { threadId: request.threadId, runtime, sideSessionId, resuming: Boolean(identity?.sideSessionId) });
      const child = spawnChild(executable, args, { cwd: request.cwd, env: ptyEnvironment(), stdio: "pipe" });
      child.stdin.end();

      const state = createStreamJsonState();
      let stdoutBuffer = "";
      const handleLine = (line: string): void => {
        const parsed = parseStreamJsonLine(line);
        if (!parsed.ok) return;
        applyStreamJsonEvent(state, parsed.event);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logMain("remote-btw:stderr", { threadId: request.threadId, data: compactLogValue(chunk.toString("utf8")) });
      });
      child.on("error", (error) => {
        logMain("remote-btw:error", { threadId: request.threadId, message: error.message });
        done({ ok: false, message: error.message });
      });
      child.on("close", (exitCode) => {
        if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
        const failed = typeof exitCode === "number" && exitCode !== 0;
        logMain("remote-btw:exit", { threadId: request.threadId, runtime, exitCode, sideSessionId });
        if (failed) {
          done({ ok: false, message: `Claude exited with code ${exitCode}.` });
          return;
        }
        const answer = finalAssistantText(state);
        done({ ok: true, answer: answer || "(No answer was produced.)" });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the /btw query.";
      logMain("remote-btw:start-error", { threadId: request.threadId, runtime, message });
      done({ ok: false, message });
    }
  });
}

// One throttle for every caller — the renderer poll, window focus, the refresh
// button, a turn finishing, and the relay heartbeat all funnel through
// loadUsageSnapshot, so this is the only place the network rate is set. Nothing
// bypasses it, not even a forced refresh: anything sooner is served from cache.
const usageMinFetchIntervalMs = 60_000;
// How long to stop calling after a 429 that carries no Retry-After header.
const usageRateLimitCooldownMs = 5 * 60_000;
const usageFetchTimeoutMs = 12_000;
const codexUsageTimeoutMs = 15_000;
const usageCache: Partial<Record<UsageProvider, { snapshot: UsageSnapshot | null; fetchedAtMs: number }>> = {};
const usageInFlight: Partial<Record<UsageProvider, Promise<UsageSnapshot | null>>> = {};
// Last snapshot that actually carried windows, per provider. A transient failure
// serves this back marked stale instead of blanking the card.
const usageLastGood: Partial<Record<UsageProvider, UsageSnapshot>> = {};
// Epoch ms until which a provider is off limits because it answered 429.
const usageCooldownUntil: Partial<Record<UsageProvider, number>> = {};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

async function loadWorkspaceGitStatus(cwd: string): Promise<WorkspaceGitStatus> {
  const base: WorkspaceGitStatus = {
    isRepo: false,
    changes: [],
    stashes: [],
    worktrees: [],
    branches: [],
    folders: [],
  };

  if (typeof cwd !== "string" || !cwd) {
    return { ...base, error: "No workspace path" };
  }

  const folders: string[] = [];
  try {
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== ".git") {
        folders.push(entry.name);
      }
    }
    folders.sort((a, b) => a.localeCompare(b));
  } catch {
    // directory unreadable — leave folders empty
  }

  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside === null || inside.trim() !== "true") {
    return { ...base, folders, error: "Not a git repository" };
  }

  const [statusOut, stashOut, worktreeOut, branchOut] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v1", "--branch"]),
    runGit(cwd, ["stash", "list"]),
    runGit(cwd, ["worktree", "list", "--porcelain"]),
    runGit(cwd, ["branch", "--format=%(HEAD)%(refname:short)"]),
  ]);

  const changes: WorkspaceGitChange[] = [];
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  if (statusOut) {
    for (const line of statusOut.split("\n")) {
      if (!line) continue;
      if (line.startsWith("##")) {
        const info = line.slice(2).trim();
        if (info.startsWith("HEAD (no branch)")) {
          branch = "(detached)";
        } else {
          branch = (info.split("...")[0] ?? info).split(" ")[0];
          const aheadMatch = info.match(/ahead (\d+)/);
          const behindMatch = info.match(/behind (\d+)/);
          if (aheadMatch) ahead = Number(aheadMatch[1]);
          if (behindMatch) behind = Number(behindMatch[1]);
        }
      } else {
        changes.push({ code: line.slice(0, 2), path: line.slice(3) });
      }
    }
  }

  const stashes = stashOut ? stashOut.split("\n").filter((line) => line.trim().length > 0) : [];

  const worktrees: WorkspaceGitWorktree[] = [];
  if (worktreeOut) {
    let current: WorkspaceGitWorktree | null = null;
    for (const line of worktreeOut.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current) worktrees.push(current);
        current = { path: line.slice("worktree ".length) };
      } else if (current && line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length).slice(0, 8);
      } else if (current && line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).replace("refs/heads/", "");
      } else if (current && line === "detached") {
        current.branch = "(detached)";
      }
    }
    if (current) worktrees.push(current);
  }

  const branches: WorkspaceGitBranch[] = [];
  if (branchOut) {
    for (const line of branchOut.split("\n")) {
      if (!line.trim()) continue;
      const name = line.slice(1).trim();
      if (name) branches.push({ name, current: line.startsWith("*") });
    }
  }

  return { isRepo: true, branch, ahead, behind, changes, stashes, worktrees, branches, folders };
}

function readClaudeAccessToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        try {
          const credentials = JSON.parse(stdout.trim()) as { claudeAiOauth?: { accessToken?: unknown } };
          const accessToken = credentials.claudeAiOauth?.accessToken;
          resolve(typeof accessToken === "string" && accessToken ? accessToken : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function usageWindowFromPayload(key: string, label: string, value: unknown): UsageWindow | null {
  const candidate = objectValue(value);
  if (!candidate) {
    return null;
  }

  if (typeof candidate.utilization !== "number" || !Number.isFinite(candidate.utilization)) {
    return null;
  }

  return {
    key,
    label,
    utilization: clampPercent(candidate.utilization),
    resetsAt: typeof candidate.resets_at === "string" ? candidate.resets_at : undefined,
  };
}

function usageUnavailable(provider: UsageProvider, reason: string): UsageSnapshot {
  return { provider, windows: [], fetchedAt: new Date().toISOString(), unavailableReason: reason };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ClaudeUsageAttempt =
  | { ok: true; payload: Record<string, unknown> }
  // "token" — the OAuth token looks stale; Claude Code rotates it in the keychain,
  // so a re-read may already have a fresh one. "backoff" — transient, wait and retry.
  | { ok: false; reason: string; retry: "token" | "backoff" | "none" };

async function attemptClaudeUsage(accessToken: string): Promise<ClaudeUsageAttempt> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(usageFetchTimeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "Claude sign-in expired. Run a Claude session to refresh the token.", retry: "token" };
    }
    if (response.status === 429) {
      // Never retry a 429 — that is what got us throttled. Sit out the window the
      // server asks for (or a default) and serve the last good numbers meanwhile.
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const cooldownMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds * 1_000, 30 * 60_000)
          : usageRateLimitCooldownMs;
      usageCooldownUntil.claude = Date.now() + cooldownMs;
      logMain("usage:rate-limited", { provider: "claude", cooldownMs });
      return {
        ok: false,
        reason: `Claude usage API is rate-limiting us. Retrying in ${Math.max(1, Math.round(cooldownMs / 60_000))}m.`,
        retry: "none",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `Claude usage API returned HTTP ${response.status}.`,
        retry: response.status >= 500 ? "backoff" : "none",
      };
    }
    return { ok: true, payload: (await response.json()) as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /abort|timeout|timed out/i.test(message);
    return {
      ok: false,
      reason: timedOut ? "Claude usage request timed out." : "Could not reach the Claude usage API.",
      retry: "backoff",
    };
  }
}

async function fetchClaudeUsageSnapshot(): Promise<UsageSnapshot> {
  const accessToken = await readClaudeAccessToken();
  if (!accessToken) {
    logMain("usage:no-credentials", { provider: "claude" });
    return usageUnavailable("claude", "No Claude Code credentials in the keychain. Sign in with the claude CLI.");
  }

  let attempt = await attemptClaudeUsage(accessToken);
  if (!attempt.ok && attempt.retry !== "none") {
    logMain("usage:retry", { provider: "claude", reason: attempt.reason, retry: attempt.retry });
    if (attempt.retry === "backoff") {
      await wait(1_200);
    }
    attempt = await attemptClaudeUsage((await readClaudeAccessToken()) ?? accessToken);
  }

  if (!attempt.ok) {
    logMain("usage:fetch-failed", { provider: "claude", reason: attempt.reason });
    return usageUnavailable("claude", attempt.reason);
  }

  const payload = attempt.payload;
  const windows = [
    usageWindowFromPayload("five_hour", "5-hour", payload.five_hour),
    usageWindowFromPayload("seven_day", "Weekly", payload.seven_day),
    usageWindowFromPayload("seven_day_opus", "Weekly Opus", payload.seven_day_opus),
  ].filter((window): window is UsageWindow => window !== null);

  if (windows.length === 0) {
    logMain("usage:empty-payload", { provider: "claude", keys: Object.keys(payload) });
    return usageUnavailable("claude", "Claude returned no usage windows for this account.");
  }

  logMain("usage:loaded", {
    provider: "claude",
    windows: windows.map((window) => `${window.key}=${window.utilization}%`),
  });
  return { provider: "claude", windows, fetchedAt: new Date().toISOString() };
}

function codexResetIso(value: unknown): string | undefined {
  const seconds = numberValue(value) ?? (typeof value === "string" ? Number(value) : NaN);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

function codexLimitLabel(limitId: string, snapshot: Record<string, unknown>): string {
  const limitName = stringValue(snapshot.limitName);
  if (limitName) {
    return limitName.replace(/^GPT-[^-]+-Codex-/, "");
  }
  return limitId === "codex" ? "Codex" : limitId.replace(/^codex_/, "").replace(/_/g, " ");
}

function codexWindowFromRateLimit(
  limitId: string,
  snapshot: Record<string, unknown>,
  windowKey: "primary" | "secondary",
): UsageWindow | null {
  const window = objectValue(snapshot[windowKey]);
  const usedPercent = numberValue(window?.usedPercent);
  if (!window || usedPercent === undefined) {
    return null;
  }

  const baseLabel = codexLimitLabel(limitId, snapshot);
  const label = windowKey === "primary" ? baseLabel : `${baseLabel} 2`;
  return {
    key: `${limitId}:${windowKey}`,
    label,
    utilization: clampPercent(usedPercent),
    resetsAt: codexResetIso(window.resetsAt),
  };
}

function codexUsageWindowsFromRateLimits(payload: unknown): UsageWindow[] {
  const root = objectValue(payload);
  if (!root) {
    return [];
  }

  const byLimitId = objectValue(root.rateLimitsByLimitId);
  const snapshots = byLimitId
    ? Object.entries(byLimitId).flatMap(([limitId, snapshot]) => {
        const record = objectValue(snapshot);
        return record ? [{ limitId, snapshot: record }] : [];
      })
    : (() => {
        const snapshot = objectValue(root.rateLimits);
        const limitId = stringValue(snapshot?.limitId) ?? "codex";
        return snapshot ? [{ limitId, snapshot }] : [];
      })();

  return snapshots
    .sort((first, second) => {
      if (first.limitId === "codex") {
        return -1;
      }
      if (second.limitId === "codex") {
        return 1;
      }
      return codexLimitLabel(first.limitId, first.snapshot).localeCompare(codexLimitLabel(second.limitId, second.snapshot));
    })
    .flatMap(({ limitId, snapshot }) =>
      [codexWindowFromRateLimit(limitId, snapshot, "primary"), codexWindowFromRateLimit(limitId, snapshot, "secondary")].filter(
        (window): window is UsageWindow => window !== null,
      ),
    );
}

/**
 * Read Codex rate limits, cheapest source first.
 *
 * The session manager's client is already up whenever a Codex section is live, so
 * ask it. Only when nothing is running do we spawn a throwaway `codex app-server`
 * — and rarely, because that used to happen on every poll: the usage card
 * refreshes each minute (plus once per relay heartbeat cycle), which meant a
 * process spawned and SIGTERMed every ~2 minutes for the life of the app.
 * Plan usage barely moves, so a stale-by-minutes number is fine.
 */
const codexUsageSpawnMinIntervalMs = 15 * 60_000;
let codexUsageLastSpawnAt = 0;

async function readCodexRateLimitsViaAppServer(): Promise<unknown> {
  const shared = await codexAppServerManager.readRateLimits(codexUsageTimeoutMs, codexUsageSpawnMinIntervalMs);
  if (shared !== null) {
    return shared;
  }

  const now = Date.now();
  if (now - codexUsageLastSpawnAt < codexUsageSpawnMinIntervalMs) {
    throw new Error("No live codex app-server to read rate limits from.");
  }
  codexUsageLastSpawnAt = now;
  logMain("usage:codex-spawn-read", {});
  const client = new CodexAppServerClient({
    spawn: () => spawnChild("codex", ["app-server"], { cwd: app.getPath("home"), env: ptyEnvironment() }),
    clientInfo: { name: "panda_code", title: "Panda Code", version: app.getVersion() },
    logMain,
  });
  try {
    await client.start();
    return await client.request("account/rateLimits/read", undefined, { timeoutMs: codexUsageTimeoutMs });
  } finally {
    client.dispose();
  }
}

async function fetchCodexUsageSnapshot(): Promise<UsageSnapshot | null> {
  try {
    const payload = await readCodexRateLimitsViaAppServer();
    const windows = codexUsageWindowsFromRateLimits(payload);
    if (windows.length === 0) {
      logMain("usage:empty-payload", { provider: "codex" });
      return {
        provider: "codex",
        windows: [],
        fetchedAt: new Date().toISOString(),
        unavailableReason: "Codex app-server did not return rate-limit windows.",
      };
    }

    logMain("usage:loaded", {
      provider: "codex",
      windows: windows.map((window) => `${window.key}=${window.utilization}%`),
    });
    return { provider: "codex", windows, fetchedAt: new Date().toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMain("usage:fetch-error", { provider: "codex", message });
    return {
      provider: "codex",
      windows: [],
      fetchedAt: new Date().toISOString(),
      unavailableReason: `Could not read Codex rate limits: ${message}`,
    };
  }
}

function fetchUsageSnapshot(provider: UsageProvider): Promise<UsageSnapshot | null> {
  if (provider === "codex") {
    return fetchCodexUsageSnapshot();
  }
  return fetchClaudeUsageSnapshot();
}

// A snapshot with windows is the new last-good. One without falls back to the
// previous last-good, marked stale and carrying the failure reason, so a blip in
// the keychain read or the network doesn't wipe the card.
function withStaleFallback(provider: UsageProvider, snapshot: UsageSnapshot | null): UsageSnapshot | null {
  if (snapshot && snapshot.windows.length > 0) {
    usageLastGood[provider] = snapshot;
    delete usageCooldownUntil[provider];
    return snapshot;
  }

  const lastGood = usageLastGood[provider];
  if (!lastGood) {
    return snapshot;
  }

  return {
    ...lastGood,
    stale: true,
    unavailableReason: snapshot?.unavailableReason ?? "Could not refresh plan usage.",
  };
}

async function loadUsageSnapshot(provider: UsageProvider): Promise<UsageSnapshot | null> {
  const cached = usageCache[provider];
  const now = Date.now();

  const cooldownUntil = usageCooldownUntil[provider] ?? 0;
  if (now < cooldownUntil) {
    const minutes = Math.max(1, Math.round((cooldownUntil - now) / 60_000));
    return (
      cached?.snapshot ??
      withStaleFallback(provider, usageUnavailable(provider, `Rate-limited by the usage API. Retrying in ${minutes}m.`))
    );
  }

  // `force` no longer means "call now" — it only means "don't wait for the next
  // poll". At most one real request per provider per minute, whoever asks.
  if (cached && now - cached.fetchedAtMs < usageMinFetchIntervalMs) {
    return cached.snapshot;
  }

  usageInFlight[provider] ??= fetchUsageSnapshot(provider)
    .then((fetched) => {
      const snapshot = withStaleFallback(provider, fetched);
      usageCache[provider] = { snapshot, fetchedAtMs: Date.now() };
      return snapshot;
    })
    .finally(() => {
      delete usageInFlight[provider];
    });
  return usageInFlight[provider];
}

// Both providers at once for the heartbeat push, so the phone can toggle between
// Claude and Codex usage. A provider that errors or isn't configured stays null.
async function loadUsageBundle(): Promise<UsageBundle> {
  const [claude, codex] = await Promise.all([
    loadUsageSnapshot("claude").catch(() => null),
    loadUsageSnapshot("codex").catch(() => null),
  ]);
  return { claude, codex };
}

const TRAY_ICON_1X =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJklEQVR4nGNgGAXYwH8optiAUUNQDRgGmv9jwXgNwGUoVWKGugAAR5kg4LS6Mh4AAAAASUVORK5CYII=";
const TRAY_ICON_2X =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAARUlEQVR4nO3TMQoAMAjAQP//6XYvlFIEDZKAs+dghJnZu3WMgHJIOwADaQdgIO0ADAQHKM/LvRy3+PaWaTgG8AudA7DZbXKKg30awljvAAAAAElFTkSuQmCC";

const DEFAULT_PREFERENCES: AppPreferences = {
  quickStartShortcut: "",
  hideDockIcon: false,
  notificationsPaused: false,
  remoteKeepAwake: "off",
};

let appPreferences: AppPreferences = { ...DEFAULT_PREFERENCES };
let tray: Tray | null = null;
let currentBadgeCount = 0;

function preferencesPath(): string {
  return join(app.getPath("userData"), "app-preferences.json");
}

let usageLedgerInstance: UsageLedger | null = null;

/** Lazily built so `app.getPath` is only touched once Electron can answer it. */
function usageLedger(): UsageLedger {
  usageLedgerInstance ??= createUsageLedger({
    filePath: join(app.getPath("userData"), "usage-ledger.json"),
    log: logMain,
  });
  return usageLedgerInstance;
}

function normalizePreferences(value: Partial<AppPreferences>): AppPreferences {
  const remoteKeepAwake =
    value.remoteKeepAwake === "while-plugged-in" || value.remoteKeepAwake === "always" ? value.remoteKeepAwake : "off";
  return {
    ...DEFAULT_PREFERENCES,
    ...value,
    remoteKeepAwake,
  };
}

function loadPreferences(): AppPreferences {
  try {
    const stored = JSON.parse(readFileSync(preferencesPath(), "utf8")) as Partial<AppPreferences>;
    return normalizePreferences(stored);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function persistPreferences(): void {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(preferencesPath(), `${JSON.stringify(appPreferences, null, 2)}\n`);
  } catch (error) {
    logMain("preferences:persist-error", { message: error instanceof Error ? error.message : String(error) });
  }
}

function applyBadge(): void {
  // A paused state forces the badge to zero regardless of what the renderer
  // last reported, but the count is remembered so unpausing restores it.
  const effective = appPreferences.notificationsPaused ? 0 : currentBadgeCount;
  app.setBadgeCount(effective);
  if (process.platform === "darwin" && app.dock) {
    app.dock.setBadge(effective > 0 ? String(effective) : "");
  }
}

function applyDockVisibility(): void {
  if (process.platform !== "darwin" || !app.dock) {
    return;
  }

  if (appPreferences.hideDockIcon) {
    void app.dock.hide();
  } else {
    void app.dock.show();
  }
}

function registerQuickStartShortcut(): void {
  globalShortcut.unregisterAll();
  const accelerator = appPreferences.quickStartShortcut.trim();
  if (!accelerator) {
    return;
  }

  try {
    const ok = globalShortcut.register(accelerator, openQuickStart);
    logMain("shortcut:register", { accelerator, ok });
  } catch (error) {
    logMain("shortcut:register-error", { accelerator, message: error instanceof Error ? error.message : String(error) });
  }
}

function focusMainWindow(): BrowserWindow | null {
  let targetWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null;
  if (!targetWindow) {
    // The window can be gone entirely (closed while the Dock icon is hidden);
    // recreate it so the tray and shortcut can always bring Panda Code back.
    createWindow();
    targetWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null;
  }

  if (!targetWindow) {
    return null;
  }

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  targetWindow.show();
  targetWindow.focus();
  app.focus({ steal: true });
  return targetWindow;
}

function openQuickStart(): void {
  const targetWindow = focusMainWindow();
  if (!targetWindow) {
    return;
  }

  // A window recreated on demand is still loading; defer the event so the
  // renderer's listener exists when it arrives.
  if (targetWindow.webContents.isLoading()) {
    targetWindow.webContents.once("did-finish-load", () => targetWindow.webContents.send("app:quick-start"));
  } else {
    targetWindow.webContents.send("app:quick-start");
  }
}

function broadcastPreferences(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("app:preferences-changed", appPreferences);
    }
  }
}

function updatePreferences(patch: Partial<AppPreferences>): AppPreferences {
  const shortcutChanged = "quickStartShortcut" in patch && patch.quickStartShortcut !== appPreferences.quickStartShortcut;
  const remoteKeepAwakeChanged = "remoteKeepAwake" in patch && patch.remoteKeepAwake !== appPreferences.remoteKeepAwake;
  appPreferences = normalizePreferences({ ...appPreferences, ...patch });
  persistPreferences();

  applyBadge();
  applyDockVisibility();
  if (shortcutChanged) {
    registerQuickStartShortcut();
  }
  if (remoteKeepAwakeChanged) {
    refreshSleepBlocker();
  }
  refreshTrayMenu();
  broadcastPreferences();
  return appPreferences;
}

function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }

  const menu = Menu.buildFromTemplate([
    { label: "Show Panda Code", click: () => focusMainWindow() },
    {
      label: "New section…",
      accelerator: appPreferences.quickStartShortcut.trim() || undefined,
      click: openQuickStart,
    },
    { type: "separator" },
    {
      label: "Hide Dock Icon",
      type: "checkbox",
      checked: appPreferences.hideDockIcon,
      click: (item) => updatePreferences({ hideDockIcon: item.checked }),
    },
    {
      label: "Pause Notifications & Badges",
      type: "checkbox",
      checked: appPreferences.notificationsPaused,
      click: (item) => updatePreferences({ notificationsPaused: item.checked }),
    },
    {
      label: "Keep Phone Reachable",
      submenu: [
        {
          label: "Off",
          type: "radio",
          checked: appPreferences.remoteKeepAwake === "off",
          click: () => updatePreferences({ remoteKeepAwake: "off" }),
        },
        {
          label: "While Plugged In",
          type: "radio",
          checked: appPreferences.remoteKeepAwake === "while-plugged-in",
          click: () => updatePreferences({ remoteKeepAwake: "while-plugged-in" }),
        },
        {
          label: "Always",
          type: "radio",
          checked: appPreferences.remoteKeepAwake === "always",
          click: () => updatePreferences({ remoteKeepAwake: "always" }),
        },
      ],
    },
    { type: "separator" },
    { label: "Quit Panda Code", role: "quit" },
  ]);
  tray.setContextMenu(menu);
}

function setupTray(): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_1X}`);
  icon.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${TRAY_ICON_2X}` });
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip("Panda Code");
  tray.on("click", () => focusMainWindow());
  refreshTrayMenu();
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Panda Code",
    backgroundColor: "#111318",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServerUrl = rendererUrl();
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function stopAllSessions(): void {
  for (const id of claudeSessionDetectors.keys()) {
    stopClaudeSessionDetector(id);
  }

  for (const [, session] of sessions) {
    session.kill();
  }
  sessions.clear();

  for (const [, session] of streamSessions) {
    session.process.kill();
  }
  streamSessions.clear();

  codexAppServerManager.disposeAll();

  for (const [, btw] of btwProcesses) {
    btw.cancel?.();
    btw.process?.kill();
  }
  btwProcesses.clear();
  // Drop the throwaway /btw fork transcripts we own so they never accumulate in
  // ~/.claude/projects across app restarts.
  for (const [, identity] of btwIdentities) {
    if (identity.sideSessionId && (identity.runtime ?? "claude") === "claude") {
      removeBtwTranscript(identity.cwd, identity.sideSessionId);
    }
  }
  btwIdentities.clear();
  btwSideSessionIds.clear();
  refreshSleepBlocker();
}

// --- Evidence artifacts -----------------------------------------------------
//
// A section's cwd lives somewhere inside a repo whose `pnpm evidence` runs write
// to `<repo>/.review-artifacts/evidence/<ts>/<app>/<scenario>/`. We walk up from
// the cwd to find that evidence root, then collect each run's manifest.

function findEvidenceRoot(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 24; i++) {
    const candidate = join(dir, ".review-artifacts", "evidence");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findManifests(dir: string, depth: number): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === "manifest.json") out.push(full);
    else if (entry.isDirectory() && depth > 0) out.push(...findManifests(full, depth - 1));
  }
  return out;
}

function listArtifacts(request: ArtifactsListRequest): ArtifactRun[] {
  if (!request?.cwd) return [];
  const root = findEvidenceRoot(request.cwd);
  if (!root) return [];
  const since = request.sinceIso ? Date.parse(request.sinceIso) : NaN;
  const runs: ArtifactRun[] = [];
  // root/<timestamp>/<app>/<scenario>/manifest.json → depth 4 is enough.
  for (const manifestPath of findManifests(root, 4)) {
    const runDir = dirname(manifestPath);
    let manifest: Record<string, unknown> | null = null;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    } catch {
      manifest = null;
    }
    let createdAtMs: number;
    let createdAtIso: string;
    const manifestCreatedAt = typeof manifest?.createdAt === "string" ? manifest.createdAt : null;
    if (manifestCreatedAt && !Number.isNaN(Date.parse(manifestCreatedAt))) {
      createdAtIso = manifestCreatedAt;
      createdAtMs = Date.parse(manifestCreatedAt);
    } else {
      try {
        const stat = statSync(manifestPath);
        createdAtMs = stat.mtimeMs;
        createdAtIso = new Date(stat.mtimeMs).toISOString();
      } catch {
        continue;
      }
    }
    if (!Number.isNaN(since) && createdAtMs < since) continue;
    const screenshots = Array.isArray(manifest?.screenshots) ? (manifest!.screenshots as unknown[]).length : 0;
    runs.push({
      dir: runDir,
      createdAt: createdAtIso,
      app: typeof manifest?.app === "string" ? manifest.app : null,
      scenario: typeof manifest?.scenario === "string" ? manifest.scenario : null,
      description: typeof manifest?.description === "string" ? manifest.description : null,
      screenshots,
      hasVideo: Boolean(manifest?.video),
    });
  }
  runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return runs;
}

async function revealPath(targetPath: unknown): Promise<boolean> {
  if (typeof targetPath !== "string" || !targetPath) return false;
  try {
    const stat = statSync(targetPath);
    if (stat.isDirectory()) {
      const error = await shell.openPath(targetPath);
      return error === "";
    }
    shell.showItemInFolder(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuild the launch request for a dormant section from the persisted thread
 * store — the same fields the composer passes to `session:start`, so a section
 * restarted for a remote prompt resumes the same conversation with the same
 * model, effort and permissions.
 *
 * Returns undefined when there is nothing safe to launch (unknown section, or a
 * workspace folder that has since moved); the caller reports the drop instead.
 */
function storedSessionStartRequest(id: string): SessionStartRequest | undefined {
  const thread = readStoredThreads().find((candidate) => candidate.id === id);
  if (!thread || !existsSync(thread.cwd)) {
    return undefined;
  }

  const runtime = thread.runtime ?? "claude";
  // A recorded conversation id that no longer exists on disk would make
  // `claude --resume` exit immediately; drop it and let the section open a fresh
  // conversation, exactly as the renderer does before it starts a section.
  const claudeSessionId =
    runtime === "claude" && thread.claudeSessionId && !readClaudeSessions(thread.cwd).has(thread.claudeSessionId)
      ? undefined
      : thread.claudeSessionId;

  return {
    id,
    cwd: thread.cwd,
    command: thread.command?.trim() || (runtime === "codex" ? defaultCodexCommand : defaultCommand),
    runtime,
    model: thread.model,
    effort: thread.effort,
    permissionMode: thread.permissionMode,
    executionMode: "stream-json",
    claudeSessionId,
    codexThreadId: thread.codexThreadId,
    cols: 100,
    rows: 30,
  };
}

const sessionService = createSessionService({
  sessions,
  streamSessions,
  ptyEnvironment,
  logMain,
  startStreamSession,
  refreshSleepBlocker,
  readClaudeSessions,
  detectClaudeSession,
  stopClaudeSessionDetector,
  resumedSessionFromCommand,
  detectedClaudeSessions,
  sendToLiveWindows,
  sendStreamSnapshot,
  streamPromptPayload,
  getStreamResumeRequest: (id) => streamResumeRequests.get(id),
  setStreamResumeRequest: (id, request) => streamResumeRequests.set(id, request),
  getStoredStartRequest: storedSessionStartRequest,
  appServer: {
    has: (id) => codexAppServerManager.has(id),
    ids: () => codexAppServerManager.ids(),
    getRequest: (id) => codexAppServerManager.get(id)?.request,
    sendInput: (id, data, imagePaths) => codexAppServerManager.sendInput(id, data, imagePaths),
    answerApproval: (answer) => codexAppServerManager.answerApproval(answer),
    stop: (id) => codexAppServerManager.stop(id),
    updateOverrides: (id, overrides) => codexAppServerManager.updateOverrides(id, overrides),
    replay: () => {
      for (const id of codexAppServerManager.ids()) {
        const session = codexAppServerManager.get(id);
        if (session) {
          sendStreamSnapshot(id, session);
        }
      }
    },
  },
});

if (process.env.PANDA_CODE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.PANDA_CODE_DEBUG_PORT);
}

app.whenReady().then(() => {
  // Created up front so a project-less section can start from anywhere (window,
  // tray, relay) without first round-tripping to the renderer.
  ensureScratchWorkspace();

  const relayUrl = process.env.PANDA_CODE_RELAY_URL?.trim() || process.env.CONVEX_URL?.trim() || undefined;
  remoteBridge = createRelayBridge({
    url: relayUrl,
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    sessionService,
    isRemoteWorkspaceAllowed,
    log: logMain,
    pairingChanged: (info) => sendToLiveWindows("remote:pairing", info),
    starredChanged: (event) => sendToRendererWindows("remote:session-starred", event),
    getUsageBundle: () => loadUsageBundle(),
    runBtw: (request) => runRemoteBtwAsk(request),
    loadUsageCost: (query) => usageLedger().query(query),
  });

  ipcMain.handle("app:log", (_event, logEvent: AppLogEvent) => {
    writeDebugLog(logEvent);
  });

  ipcMain.handle("app:set-badge", (_event, count: unknown) => {
    currentBadgeCount = typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    applyBadge();
  });

  ipcMain.handle("conversation:search", (_event, request: ConversationSearchRequest) => searchConversations(request));

  ipcMain.handle("git:workspace-status", (_event, request: WorkspaceGitRequest) => loadWorkspaceGitStatus(request?.cwd));

  ipcMain.handle(
    "usage:cost",
    (_event, query: UsageCostQuery | undefined): UsageCostReport => usageLedger().query(query ?? {}),
  );

  ipcMain.handle("app:load-preferences", () => appPreferences);

  ipcMain.handle("app:save-preferences", (_event, patch: Partial<AppPreferences>) => updatePreferences(patch ?? {}));

  ipcMain.handle("remote:get-pairing", () => remoteBridge?.getPairingInfo());

  ipcMain.handle("remote:refresh-pairing", () => remoteBridge?.refreshPairingCode());

  ipcMain.handle("remote:list-devices", () => remoteBridge?.listPairedDevices() ?? []);

  ipcMain.handle("remote:revoke-device", (_event, mobileId: unknown) =>
    typeof mobileId === "string" ? (remoteBridge?.revokePairedDevice(mobileId) ?? []) : [],
  );

  ipcMain.handle("app:focus", () => {
    const targetWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    if (targetWindow) {
      if (targetWindow.isMinimized()) {
        targetWindow.restore();
      }
      targetWindow.show();
      targetWindow.focus();
    }
    app.focus({ steal: true });
  });

  ipcMain.handle("image:save-pasted", (_event, request: SavePastedImageRequest) => savePastedImage(request));

  ipcMain.handle("export:conversation", (_event, request: ConversationExportRequest) => exportConversation(request));

  ipcMain.handle("threads:load", () => loadPersistedThreads());

  ipcMain.handle("threads:save", (_event, threads: PersistedThread[]) => {
    writeStoredThreads(threads);
    remoteBridge?.syncLocalStarredThreads(threads);
    remoteBridge?.syncLocalThreadTitles(threads);
  });

  ipcMain.handle("session:set-title", (_event, event: unknown) => {
    if (
      event &&
      typeof event === "object" &&
      typeof (event as { id?: unknown }).id === "string" &&
      typeof (event as { title?: unknown }).title === "string"
    ) {
      remoteBridge?.setSessionTitle(event as SessionTitleEvent);
    }
  });

  ipcMain.handle("session:set-starred", (_event, event: unknown) => {
    if (
      event &&
      typeof event === "object" &&
      typeof (event as { id?: unknown }).id === "string" &&
      typeof (event as { starred?: unknown }).starred === "boolean"
    ) {
      remoteBridge?.setSessionStarred(event as { id: string; starred: boolean });
    }
  });

  ipcMain.handle("directory:ensure-scratch", () => ensureScratchWorkspace());

  ipcMain.handle("directory:select", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Choose a workspace folder",
    });

    if (result.canceled) {
      return null;
    }

    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("session:start", (_event, request: SessionStartRequest): SessionStartResult =>
    sessionService.startSession(request),
  );

  ipcMain.handle("terminal:start", (_event, request: TerminalStartRequest): TerminalStartResult => {
    const existing = terminals.get(request.id);
    if (existing) {
      try {
        existing.pty.resize(request.cols, request.rows);
      } catch {
        // Resizing a just-exited pty throws; the exit event will clean up.
      }
      return { ok: true, buffer: existing.buffer };
    }

    try {
      const shell = process.env.SHELL?.trim() || "/bin/zsh";
      const pty = spawn(shell, ["-l"], {
        name: "xterm-256color",
        cwd: request.cwd,
        env: ptyEnvironment(),
        cols: request.cols,
        rows: request.rows,
      });
      const terminal: TerminalSession = { pty, buffer: "" };
      terminals.set(request.id, terminal);
      logMain("terminal:start", { id: request.id, cwd: request.cwd, shell });

      pty.onData((data) => {
        terminal.buffer = (terminal.buffer + data).slice(-terminalBufferCap);
        sendToLiveWindows("terminal:data", { id: request.id, data } satisfies TerminalDataEvent);
      });
      pty.onExit(({ exitCode }) => {
        terminals.delete(request.id);
        logMain("terminal:exit", { id: request.id, exitCode });
        sendToLiveWindows("terminal:exit", { id: request.id, exitCode } satisfies TerminalExitEvent);
      });

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the shell.";
      logMain("terminal:start-error", { id: request.id, message });
      return { ok: false, message };
    }
  });

  ipcMain.handle("terminal:input", (_event, request: SessionInputRequest) => {
    terminals.get(request.id)?.pty.write(request.data);
  });

  ipcMain.handle("terminal:resize", (_event, request: SessionResizeRequest) => {
    try {
      terminals.get(request.id)?.pty.resize(request.cols, request.rows);
    } catch {
      // Ignore resize races against shell exit.
    }
  });

  ipcMain.handle("terminal:stop", (_event, request: SessionStopRequest) => {
    const terminal = terminals.get(request.id);
    terminals.delete(request.id);
    terminal?.pty.kill();
  });

  // Ids of the ptys main is actually holding. Renderer uses this to prune
  // terminal tabs it persisted in localStorage whose shell no longer exists —
  // ptys survive a renderer reload (main owns them) but not an app restart, so
  // after a restart the persisted tabs would otherwise show phantom badges.
  ipcMain.handle("terminal:list", () => Array.from(terminals.keys()));

  ipcMain.handle("session:list", () => sessionService.listSessions());

  ipcMain.handle("claude-session:exists", (_event, request: ClaudeSessionExistsRequest) =>
    readClaudeSessions(request.cwd).has(request.claudeSessionId),
  );

  ipcMain.handle("claude-session:latest", (_event, cwd: string) => latestClaudeSession(cwd));

  ipcMain.handle("usage:load", (_event, provider?: UsageProvider) =>
    loadUsageSnapshot(provider === "codex" ? "codex" : "claude"),
  );

  ipcMain.handle("conversation:load", (_event, request: { cwd: string; claudeSessionId?: string; codexThreadId?: string }) => {
    const conversation = readConversation(request);
    logMain("conversation:load", {
      claudeSessionId: request.claudeSessionId,
      codexThreadId: request.codexThreadId,
      cwd: request.cwd,
      items: conversation.items.length,
      totalTokens: conversation.tokenUsage.totalTokens,
    });
    return conversation;
  });

  ipcMain.handle("session:input", (_event, request: SessionInputRequest) => sessionService.sendInput(request));

  ipcMain.handle("session:answer-approval", (_event, answer: SessionApprovalAnswer): SessionApprovalResult => {
    const result = sessionService.answerApproval(answer);
    logMain("session:answer-approval", { id: answer.id, promptId: answer.promptId, ok: result.ok });
    return result;
  });

  ipcMain.handle("session:resize", (_event, request: SessionResizeRequest) => {
    sessions.get(request.id)?.resize(Math.max(40, request.cols), Math.max(12, request.rows));
  });

  ipcMain.handle("session:stop", (_event, request: SessionStopRequest) => sessionService.stopSession(request));

  ipcMain.handle("btw:ask", (_event, request: BtwAskRequest): BtwAskResult => startBtwAsk(request));

  ipcMain.handle("btw:clear", (_event, request: BtwClearRequest) => {
    clearBtw(request.threadId);
  });

  ipcMain.handle("artifacts:list", (_event, request: ArtifactsListRequest) => listArtifacts(request));

  ipcMain.handle("path:reveal", (_event, targetPath: unknown) => revealPath(targetPath));

  appPreferences = loadPreferences();
  onBatteryPower = powerMonitor.isOnBatteryPower();
  powerMonitor.on("on-battery", () => {
    onBatteryPower = true;
    refreshSleepBlocker();
  });
  powerMonitor.on("on-ac", () => {
    onBatteryPower = false;
    refreshSleepBlocker();
  });
  applyDockVisibility();
  registerQuickStartShortcut();
  setupTray();

  createWindow();
  void remoteBridge.start();
  refreshSleepBlocker();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  remoteBridge?.stop();
  usageLedgerInstance?.flush();
  stopAllSessions();
  flushDebugLogNow();
});

app.on("window-all-closed", () => {
  stopAllSessions();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
