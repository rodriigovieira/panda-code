import { redactDiagnosticValue } from "../shared/diagnostic-privacy";
import { browserUrlAllowed, externalUrlAllowed, configureBrowserPermissions } from "./browserSecurity";
import { pathToFileURL } from "node:url";
import { confinedPath, readBoundedFile, writeConfinedText } from "./confinedFiles";
import { parseWorkflowRuns } from "../shared/workflow-runs";
import { normalizeNotificationChannels, resolveNotificationChannels, patchNotificationChannels, agentAttentionAllowed } from "../shared/notification-channels";
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
  watch,
  writeFileSync,
  type Dirent,
  type FSWatcher,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { ClipboardItem, BrowserWindow, Menu, Tray, app, clipboard, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, powerSaveBlocker, safeStorage, shell, webContents } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { spawn, type IPty } from "node-pty";
import type {
  AgentActivity,
  AgentRuntime,
  AppPreferences,
  ArtifactRun,
  ArtifactsListRequest,
  BacklogMutation,
  BacklogMutationResult,
  BrowserAttachRequest,
  BrowserNavigateRequest,
  BrowserOpenRequest,
  BrowserReportRequest,
  BrowserResolveNoteRequest,
  BrowserSetNoteHiddenRequest,
  BrowserTabRequest,
  BtwAskRequest,
  BtwAskResult,
  BtwClearRequest,
  BtwEvent,
  ConversationExportRequest,
  ConversationExportResult,
  ConversationLoadRequest,
  ConversationSearchRequest,
  ConversationSearchResult,
  AppLogEvent,
  ClaudeConversationResult,
  CodexModel,
  GroqModel,
  ClaudeSessionExistsRequest,
  ConversationItem,
  DictationStartRequest,
  EditorId,
  EditorTarget,
  OpenInEditorRequest,
  PersistedThread,
  SavePastedImageRequest,
  SavePastedImageResult,
  SessionApprovalAnswer,
  SessionApprovalResult,
  SessionExitEvent,
  SessionHibernatedEvent,
  SessionFileChange,
  SessionFileChanges,
  SessionFileChangesRequest,
  SessionInputRequest,
  SessionResizeRequest,
  SessionStartRequest,
  SessionStartResult,
  SessionStopRequest,
  KillSectionCommandsRequest,
  KillSectionCommandsResult,
  SessionTitleEvent,
  ScheduleMutation,
  ScheduleMutationResult,
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
  TextFileContents,
  TextFileRequest,
  TextFileWriteRequest,
  TextFileWriteResult,
  WorkspaceGitCommit,
  WorkspaceGitFetchRequest,
  WorkspaceGitLog,
  WorkspaceGitLogRequest,
  WorkspaceGitRequest,
  WorkspaceGitStatus,
  WorkspaceGitTree,
  WorkspaceGitTreeEntry,
  WorkspaceGitTreeRequest,
  WorkspaceGitWorktree,
  WorkspaceWorkflowRuns,
  WorkspaceWorkflowRunsRequest,
} from "../shared/ipc";
import { effectiveHygiene } from "../shared/ipc";
import {
  applyAppServerNotification,
  applyStreamJsonEvent,
  codexTranscriptTurnSummaryItem,
  codexTranscriptMessageId,
  looksLikeSyntheticUserText,
  createStreamJsonState,
  messageItemId,
  parseStreamJsonLine,
  hasBackgroundWork,
  pushItem,
  streamRuntimeEvent,
  strippedBodyForComparison,
  toolResultItemId,
  toolUseItemId,
  syntheticUserTitle,
  toolResultBody,
  type StreamJsonState,
} from "../shared/stream-json";
import {
  backgroundOutputSystemPrompt,
  conserveSystemPrompt,
  inlineMediaSystemPrompt,
  stripDeveloperInstructions,
  tldrSystemPrompt,
  workspaceBacklogMcpPrompt,
  workspaceBrowserMcpPrompt,
  workspacePeersMcpPrompt,
  workspaceScheduleMcpPrompt,
} from "../shared/agent-prompts";
import { createBrowserService, describeBrowser, type BrowserService, type GuestContents } from "./browserService";
import { GroqSessionManager } from "./groqSession";
import { createBrowserAudit, type BrowserAudit } from "./browserAudit";
import { collectEditedPaths } from "../shared/session-files";
import { PerfRecorder, formatPerfOperation } from "../shared/perf";
import { browserDiagnosticAttach, browserDiagnosticContents, browserDiagnosticPayload, browserDiagnosticRecord, diagnosticRole, startBrowserDiagnostics } from "./browserDiagnostics";
import { readTailLineEntries, readTailLines } from "./tail-lines";
import { TranscriptIndexClient } from "./transcript-index";
import type { TranscriptIndexPage, TranscriptRegistration } from "../shared/transcript-index";
import { compactSectionTitle } from "../shared/section-title";
import { LatestValueThrottle } from "./latestValueThrottle";
import {
  addBacklogItem,
  emptyBacklog,
  linkBacklogSection,
  moveBacklogItem,
  normalizeColumn,
  parseBacklog,
  unlinkBacklogSection,
  type WorkspaceBacklog,
} from "../shared/backlog";
import {
  createBacklogStore,
  storeAddEpic as backlogStoreAddEpic,
  storeDeleteEpic as backlogStoreDeleteEpic,
  storeDelete as backlogStoreDelete,
  storeUpdateEpic as backlogStoreUpdateEpic,
  storeUpdate as backlogStoreUpdate,
  type BacklogStore,
} from "../shared/backlog-store";
import { DICTATION_FALLBACK_LOCALE, normalizeDictationLocale } from "../shared/dictation";
import { DictationHost, dictationResourcePaths } from "./dictation";
import { collectMachineStats, resolveSectionKillTargets } from "../shared/machine-probe";
import type { MachineStats } from "../shared/machine-stats";
import {
  addScheduledTask,
  deleteScheduledTask,
  dueScheduledTasks,
  emptySchedule,
  parseSchedule,
  updateScheduledTask,
  type WorkspaceSchedule,
} from "../shared/schedule";
import { createScheduleStore, readAllSchedules, storeMarkRun, type ScheduleStore } from "../shared/schedule-store";
import { createSessionService, type ManagedStreamSession } from "./sessionService";
import { selectEvictions, type Eviction, type LiveSection } from "./sessionReaper";
import { createUsageLedger, type UsageLedger } from "./usageLedger";
import { CodexAppServerClient } from "./codex/appServerClient";
import { CodexAppServerSessionManager, type CodexAppServerSession } from "./codex/appServerSession";
import {
  createRelayBridge,
  type RelayBridge,
  type RemoteBacklogRequest,
  type RemoteBtwRequest,
  type RemoteBtwResult,
} from "./remote/relayBridge";
import { startPeerMessageServer, type BrowserRequest, type PeerAttentionRequest, type PeerMessageServer, type PeerSectionSpec } from "./peerMessaging";
import { loadPeerTranscript } from "./peers-entry";
import { sameWorkspace } from "../shared/workspace-peers";
import {
  resolveClaudeLaunchPermission,
  tokenizeLaunchCommand as tokenizeCommand,
} from "./remote/effectivePermission";
import {
  compactBody,
  createTranscriptAgentCards,
  resolveTranscriptTaskNotification,
  toolItemsFromContent,
  trimTrailingSpaces,
  type TranscriptAgentCards,
} from "./transcript-items";

const sessions = new Map<string, IPty>();
const streamSessions = new Map<string, StreamSession>();
const streamResumeRequests = new Map<string, SessionStartRequest>();

// Auto-retry for a Claude turn that ends in a transient `error_during_execution`
// result (dropped connection / server error mid-stream — see stream-json.ts).
// Keyed by section id; cleared whenever the section produces a non-retryable
// result or its process goes away, so a stale timer never fires into a dead
// or restarted section.
const autoRetryState = new Map<string, { attempt: number; timer: NodeJS.Timeout }>();
const AUTO_RETRY_MAX_ATTEMPTS = 5;
const AUTO_RETRY_BASE_MS = 5_000;
const AUTO_RETRY_MAX_MS = 5 * 60_000;
let remoteBridge: RelayBridge | null = null;
let peerMessageServer: PeerMessageServer | null = null;

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
  "Answer concisely and directly using the session's context. This is a read/consult-only aside: you may read files and run " +
  "read-only commands to answer, but you do NOT change anything — do not edit or create files, run mutating commands, " +
  "create plan files, or use plan mode. Never offer to make a change here; the section next door does the work. " +
  "Just answer the question.\n\n" +
  // The aside is rendered by the same markdown feed as the main conversation, so
  // the recap the section's turns end with belongs here too.
  tldrSystemPrompt;

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
// Section -> workspace membership. The actual timer is one per workspace below,
// never one per live section.
const claudeSessionDetectors = new Map<string, string>();
const detectedClaudeSessions = new Map<string, string>();
type ClaudeWorkspaceSubscriber = { id: string; startedAt: number };
type ClaudeWorkspaceDetector = {
  snapshot: ClaudeSessionSnapshot;
  subscribers: Map<string, ClaudeWorkspaceSubscriber>;
  seenPromptKeys: Set<string>;
  timer: NodeJS.Timeout;
  running: boolean;
};
const claudeWorkspaceDetectors = new Map<string, ClaudeWorkspaceDetector>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultShellPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const defaultWorkspace = process.env.PANDA_CODE_DEFAULT_WORKSPACE?.trim() || homedir();
const defaultCommand = "claude";
const defaultCodexCommand = "codex";
const maxRecoveredThreads = 40;
// One indexed history page. The renderer may retain multiple pages after an
// explicit "Load earlier" action, while its own render window bounds the DOM.
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
    model?: string;
    content?: unknown;
    turn_id?: string;
    duration_ms?: number;
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
        details: redactDiagnosticValue(event.details ?? {}),
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
  browserDiagnosticPayload(channel, payload);
  remoteBridge?.observeLocalEvent(channel, payload);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      const started = performance.now();
      window.webContents.send(channel, payload);
      browserDiagnosticRecord(`send:${diagnosticRole(window.webContents)}:${channel}`, performance.now() - started);
    }
  }
}

function sendToRendererWindows(channel: string, payload: unknown): void {
  browserDiagnosticPayload(channel, payload);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      const started = performance.now();
      window.webContents.send(channel, payload);
      browserDiagnosticRecord(`send:${diagnosticRole(window.webContents)}:${channel}`, performance.now() - started);
    }
  }
}

function rendererUrl(): string | undefined {
  return process.env.ELECTRON_RENDERER_URL;
}

/**
 * The MCP server key Claude prefixes its tool names with. Underscores only: the
 * tool names it derives (`mcp__<server>__<tool>`) are what `--allowed-tools`
 * has to match, and a hyphen there does not survive the round trip.
 */
const peersServerName = "panda_workspace";
const peersToolNames = [
  `mcp__${peersServerName}__list_sessions`,
  `mcp__${peersServerName}__read_session`,
  `mcp__${peersServerName}__wait_for_session`,
  `mcp__${peersServerName}__send_message`,
  `mcp__${peersServerName}__create_session`,
  `mcp__${peersServerName}__backlog_list`,
  `mcp__${peersServerName}__backlog_add`,
  `mcp__${peersServerName}__backlog_update`,
  `mcp__${peersServerName}__backlog_delete`,
  `mcp__${peersServerName}__schedule_list`,
  `mcp__${peersServerName}__schedule_add`,
  `mcp__${peersServerName}__schedule_update`,
  `mcp__${peersServerName}__schedule_delete`,
  `mcp__${peersServerName}__machine_status`,
  // The browser tools. Every one lands on `runBrowserRequest` below, over the
  // same peer socket the messaging tools use — the browser only exists inside
  // the running app, so unlike the backlog there is no disk path to it.
  `mcp__${peersServerName}__browser_list`,
  `mcp__${peersServerName}__browser_open`,
  `mcp__${peersServerName}__browser_navigate`,
  `mcp__${peersServerName}__browser_read`,
  `mcp__${peersServerName}__browser_inspect`,
  `mcp__${peersServerName}__browser_click`,
  `mcp__${peersServerName}__browser_type`,
  `mcp__${peersServerName}__browser_screenshot`,
  `mcp__${peersServerName}__browser_note`,
  `mcp__${peersServerName}__browser_close`,
  `mcp__${peersServerName}__browser_back`,
  `mcp__${peersServerName}__browser_wait`,
  `mcp__${peersServerName}__browser_hover`,
  `mcp__${peersServerName}__browser_drag`,
  `mcp__${peersServerName}__browser_key`,
  `mcp__${peersServerName}__browser_cursor`,
  `mcp__${peersServerName}__browser_scroll`,
  `mcp__${peersServerName}__browser_select_option`,
  `mcp__${peersServerName}__browser_upload`,
  `mcp__${peersServerName}__browser_record`,
  `mcp__${peersServerName}__browser_activity`,
];

/**
 * The workspace-awareness helper, as it sits next to the built main bundle. It
 * runs as a plain Node program under Electron's own binary, so no separate node
 * install has to exist on the user's machine.
 */
function peersEntryPath(): string {
  return join(__dirname, "peers-entry.js");
}

function peersShimDir(): string {
  return join(app.getPath("userData"), "bin");
}

/**
 * Where the app listens for peer messages. In `userData` so it is per-install and
 * user-private, and short enough to stay under the ~104-byte limit a unix socket
 * path has.
 */
function peersSocketPath(): string {
  return join(app.getPath("userData"), "peers.sock");
}

/**
 * Journal of messages one section sent another. Written by the deliverer, read
 * by the helper, so `read_session` can report whether a message was read rather
 * than only that it was accepted.
 */
function peerMessagesPath(): string {
  return join(app.getPath("userData"), "peer-messages.json");
}

/**
 * Where the per-workspace kanban boards live: one JSON file per project folder.
 *
 * In `userData` rather than inside the repo. A board is the operator's own
 * working memory, and writing a file into someone's checkout — which they then
 * have to gitignore, review in diffs, and explain to their team — is a decision
 * the app has no business making on their behalf. The file carries its `cwd`, so
 * a board can still be found and read by hand.
 */
function backlogDirectory(): string {
  return join(app.getPath("userData"), "backlogs");
}

let backlogStoreCache: BacklogStore | undefined;

/** Lazy because `app.getPath` is only meaningful once Electron has a userData dir. */
function getBacklogStore(): BacklogStore {
  backlogStoreCache ??= createBacklogStore(backlogDirectory());
  return backlogStoreCache;
}

function applyBacklogMutation(mutation: BacklogMutation): BacklogMutationResult {
  const store = getBacklogStore();
  const cwd = typeof mutation?.cwd === "string" ? mutation.cwd : "";
  if (!cwd) {
    return { ok: false, message: "A backlog mutation needs a workspace." };
  }

  // `update` and `delete` go through the store wrappers rather than a bare
  // `store.apply`, so an attachment a card loses here (removed, or deleted with
  // the card) has its file cleaned up too — the same path `backlog_update` and
  // `backlog_delete` use from the agent side.
  const result =
    mutation.op === "epic-add"
      ? backlogStoreAddEpic(store, cwd, mutation)
      : mutation.op === "epic-update"
        ? backlogStoreUpdateEpic(store, cwd, mutation.id, mutation)
        : mutation.op === "epic-delete"
          ? backlogStoreDeleteEpic(store, cwd, mutation.id)
          : mutation.op === "update"
      ? backlogStoreUpdate(store, cwd, mutation.id, {
          title: mutation.title,
          summary: mutation.summary,
          description: mutation.description,
          metadata: mutation.metadata,
          column: mutation.column,
          onHold: mutation.onHold,
          verificationNotes: mutation.verificationNotes,
          epicId: mutation.epicId,
          addVerificationScenario: mutation.addVerificationScenario,
          removeAttachmentIds: mutation.removeAttachmentIds,
        })
      : mutation.op === "delete"
        ? backlogStoreDelete(store, cwd, mutation.id)
        : store.apply(cwd, (backlog) => {
            switch (mutation.op) {
              case "add":
                return addBacklogItem(backlog, {
                  title: mutation.title,
                  summary: mutation.summary,
                  description: mutation.description,
                  metadata: mutation.metadata,
                  column: mutation.column,
                  createdBy: "user",
                });
              case "move":
                return moveBacklogItem(backlog, mutation.id, mutation.column, mutation.index);
              case "link":
                return linkBacklogSection(backlog, mutation.id, mutation.sectionId);
              case "unlink":
                return unlinkBacklogSection(backlog, mutation.id, mutation.sectionId);
              default:
                return { ok: false, message: "Unknown backlog operation." };
            }
          });

  if (!result.ok) {
    logMain("backlog-mutation-refused", { op: mutation.op, message: result.message });
    return result;
  }

  publishBacklog(result.backlog);
  return { ok: true, backlog: result.backlog };
}

/**
 * The phone's version of {@link applyBacklogMutation}.
 *
 * Same file, same mutations, but the request arrives as loose strings off the
 * wire rather than as a typed IPC message — so the column is normalized here
 * (the phone may say "doing") and an unusable one is refused with a sentence the
 * phone can show, instead of being coerced into a column the user did not pick.
 */
function applyRemoteBacklog(request: RemoteBacklogRequest): BacklogMutationResult {
  const column = request.column === undefined ? undefined : normalizeColumn(request.column);
  if (request.column !== undefined && !column) {
    return { ok: false, message: `Unknown column "${request.column}".` };
  }

  switch (request.op) {
    case "list":
      return { ok: true, backlog: getBacklogStore().read(request.cwd) };
    case "add":
      return applyBacklogMutation({
        op: "add",
        cwd: request.cwd,
        title: request.title ?? "",
        summary: request.summary,
        description: request.description,
        metadata: request.metadata,
        column,
      });
    case "update":
      if (!request.id) return { ok: false, message: "Updating a backlog item needs its id." };
      return applyBacklogMutation({
        op: "update",
        cwd: request.cwd,
        id: request.id,
        title: request.title,
        summary: request.summary,
        description: request.description,
        metadata: request.metadata,
        column,
        onHold: request.onHold,
        verificationNotes: request.verificationNotes,
        epicId: request.epicId,
        removeAttachmentIds: request.removeAttachmentIds,
      });
    case "epic-add":
      return applyBacklogMutation({ op: "epic-add", cwd: request.cwd, title: request.title ?? "", summary: request.summary, scope: request.scope, acceptanceCriteria: request.acceptanceCriteria, acceptanceScenario: request.acceptanceScenario });
    case "epic-update":
      if (!request.id) return { ok: false, message: "Updating an Epic needs its id." };
      return applyBacklogMutation({ op: "epic-update", cwd: request.cwd, id: request.id, title: request.title, summary: request.summary, scope: request.scope, acceptanceCriteria: request.acceptanceCriteria, acceptanceScenario: request.acceptanceScenario });
    case "epic-delete":
      if (!request.id) return { ok: false, message: "Deleting an Epic needs its id." };
      return applyBacklogMutation({ op: "epic-delete", cwd: request.cwd, id: request.id });
    case "move":
      if (!request.id) return { ok: false, message: "Moving a backlog item needs its id." };
      if (!column) return { ok: false, message: "Moving a backlog item needs a target column." };
      return applyBacklogMutation({ op: "move", cwd: request.cwd, id: request.id, column, index: request.index ?? 0 });
    case "delete":
      if (!request.id) return { ok: false, message: "Deleting a backlog item needs its id." };
      return applyBacklogMutation({ op: "delete", cwd: request.cwd, id: request.id });
    default:
      return { ok: false, message: `Unknown backlog operation "${request.op}".` };
  }
}

function publishBacklog(backlog: WorkspaceBacklog): void {
  sendToRendererWindows("backlog:changed", { cwd: backlog.cwd, backlog });
}

/**
 * Watch for boards changed by somebody other than this process.
 *
 * An agent's `backlog_add` runs in the MCP helper and writes the file directly —
 * the app never hears about it — so without this the operator's open board would
 * quietly disagree with what the agent just told them it did. `fs.watch` on the
 * directory is enough: the files are small, and a re-read costs nothing next to
 * being wrong.
 */
function startBacklogWatcher(): void {
  const directory = backlogDirectory();
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    logMain("backlog-directory-create-failed", { directory, error: String(error) });
    return;
  }

  // A single rename fires more than once, and a burst of agent writes should
  // cost one broadcast rather than one per event.
  const pending = new Map<string, NodeJS.Timeout>();

  try {
    backlogWatcher = watch(directory, (_event, filename) => {
      if (!filename || !filename.endsWith(".json")) {
        return;
      }

      clearTimeout(pending.get(filename));
      const timer = setTimeout(() => {
        pending.delete(filename);
        try {
          // The board carries its own `cwd`, which is the only way back from the
          // flattened file name to the workspace it belongs to.
          const backlog = parseBacklog(readFileSync(join(directory, filename), "utf8"), "");
          if (backlog.cwd) {
            publishBacklog(backlog);
          }
        } catch {
          // Deleted or half-written; the next event carries the settled state.
        }
      }, BACKLOG_WATCH_DEBOUNCE_MS);
      timer.unref?.();
      pending.set(filename, timer);
    });
  } catch (error) {
    logMain("backlog-watch-failed", { directory, error: String(error) });
  }
}

const BACKLOG_WATCH_DEBOUNCE_MS = 150;
let backlogWatcher: FSWatcher | undefined;

/**
 * Where per-workspace schedules live: one JSON file per project folder, same
 * layout and rationale as {@link backlogDirectory}.
 */
function scheduleDirectory(): string {
  return join(app.getPath("userData"), "schedules");
}

let scheduleStoreCache: ScheduleStore | undefined;

function getScheduleStore(): ScheduleStore {
  scheduleStoreCache ??= createScheduleStore(scheduleDirectory());
  return scheduleStoreCache;
}

function applyScheduleMutation(mutation: ScheduleMutation): ScheduleMutationResult {
  const store = getScheduleStore();
  const cwd = typeof mutation?.cwd === "string" ? mutation.cwd : "";
  if (!cwd) {
    return { ok: false, message: "A schedule mutation needs a workspace." };
  }

  const result = store.apply(cwd, (schedule) => {
    switch (mutation.op) {
      case "add":
        return addScheduledTask(schedule, { title: mutation.title, prompt: mutation.prompt, frequency: mutation.frequency, createdBy: "user" });
      case "update":
        return updateScheduledTask(schedule, mutation.id, { title: mutation.title, prompt: mutation.prompt, frequency: mutation.frequency, enabled: mutation.enabled });
      case "delete":
        return deleteScheduledTask(schedule, mutation.id);
      default:
        return { ok: false, message: "Unknown schedule operation." };
    }
  });

  if (!result.ok) {
    logMain("schedule-mutation-refused", { op: mutation.op, message: result.message });
    return result;
  }

  publishSchedule(result.schedule);
  return { ok: true, schedule: result.schedule };
}

function publishSchedule(schedule: WorkspaceSchedule): void {
  sendToRendererWindows("schedule:changed", { cwd: schedule.cwd, schedule });
}

/**
 * Watch for schedules changed by somebody other than this process — an
 * agent's `schedule_add` in the MCP helper, same reasoning as
 * {@link startBacklogWatcher}.
 */
function startScheduleWatcher(): void {
  const directory = scheduleDirectory();
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    logMain("schedule-directory-create-failed", { directory, error: String(error) });
    return;
  }

  const pending = new Map<string, NodeJS.Timeout>();

  try {
    scheduleWatcher = watch(directory, (_event, filename) => {
      if (!filename || !filename.endsWith(".json")) {
        return;
      }

      clearTimeout(pending.get(filename));
      const timer = setTimeout(() => {
        pending.delete(filename);
        try {
          const schedule = parseSchedule(readFileSync(join(directory, filename), "utf8"), "");
          if (schedule.cwd) {
            publishSchedule(schedule);
          }
        } catch {
          // Deleted or half-written; the next event carries the settled state.
        }
      }, BACKLOG_WATCH_DEBOUNCE_MS);
      timer.unref?.();
      pending.set(filename, timer);
    });
  } catch (error) {
    logMain("schedule-watch-failed", { directory, error: String(error) });
  }
}

let scheduleWatcher: FSWatcher | undefined;
let scheduleTickTimer: NodeJS.Timeout | undefined;
const SCHEDULE_TICK_MS = 30_000;

/**
 * The scheduler's clock. Runs only while the desktop app is open — there is no
 * server-side compute behind a schedule, the same trade-off the backlog makes
 * for the same reason (see `backlogDirectory`'s comment) — and scans every
 * workspace's schedule file each tick rather than keeping a timer per job, so
 * a job created by an agent while the app is busy is never missed.
 */
async function tickSchedules(): Promise<void> {
  const store = getScheduleStore();
  const now = new Date();
  let schedules: WorkspaceSchedule[];
  try {
    schedules = readAllSchedules(scheduleDirectory());
  } catch (error) {
    logMain("schedule-tick-read-failed", { error: String(error) });
    return;
  }

  for (const schedule of schedules) {
    for (const task of dueScheduledTasks(schedule, now)) {
      if (!existsSync(schedule.cwd)) {
        logMain("schedule-run-skipped", { cwd: schedule.cwd, id: task.id, reason: "workspace-missing" });
        continue;
      }

      const id = randomUUID();
      const started = sessionService.startSession({
        id,
        cwd: schedule.cwd,
        command: defaultCommand,
        runtime: "claude",
        executionMode: "stream-json",
        cols: 100,
        rows: 30,
      });
      if (!started.ok) {
        logMain("schedule-run-failed", { cwd: schedule.cwd, id: task.id, message: started.message });
        continue;
      }

      sendToLiveWindows("session:title", { id, title: task.title });
      const sent = await sessionService.sendInput({ id, data: task.prompt });
      logMain("schedule-run", { cwd: schedule.cwd, taskId: task.id, sectionId: id, sent: sent.ok });

      const marked = storeMarkRun(store, schedule.cwd, task.id);
      if (marked.ok) {
        publishSchedule(marked.schedule);
      }
    }
  }
}

function startScheduleTicker(): void {
  void tickSchedules();
  scheduleTickTimer = setInterval(() => {
    void tickSchedules();
  }, SCHEDULE_TICK_MS);
  scheduleTickTimer.unref?.();
}

/**
 * A `panda-peers` shim on the agent's PATH.
 *
 * Codex takes its MCP servers from the user's own `~/.codex/config.toml`, which
 * is not ours to edit, and terminal sections have no tool layer at all — so the
 * shell is the one channel every runtime shares. The shim hides the awkward part
 * (Electron's binary, ELECTRON_RUN_AS_NODE, the threads.json path) behind a name
 * an agent can be told to type.
 */
function installPeersShim(): void {
  const directory = peersShimDir();
  const shimPath = join(directory, "panda-peers");
  const script = [
    "#!/bin/sh",
    "# Generated by Panda Code. Lists the agent sessions sharing this workspace.",
    `exec env ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(process.execPath)} ${JSON.stringify(peersEntryPath())} --threads ${JSON.stringify(threadsStorePath())} --socket ${JSON.stringify(peersSocketPath())} --messages ${JSON.stringify(peerMessagesPath())} --backlog ${JSON.stringify(backlogDirectory())} --schedule ${JSON.stringify(scheduleDirectory())} "$@"`,
    "",
  ].join("\n");

  try {
    mkdirSync(directory, { recursive: true });
    // Rewritten on every launch: `process.execPath` moves when the app is
    // updated or run from a different location, and a stale shim would point at
    // a binary that no longer exists.
    writeFileSync(shimPath, script, { mode: 0o755 });
  } catch (error) {
    logMain("peers-shim-install-failed", { path: shimPath, error: String(error) });
  }
}

/**
 * `section` scopes the environment to one agent process: the helper needs to
 * know which section is asking so it can mark it "(you)" and leave it out of the
 * peer list. Codex has no per-section environment — one app-server serves every
 * thread — so it passes no section and sees itself listed like any other.
 */
function ptyEnvironment(section?: { id?: string; cwd?: string }): PtyEnvironment {
  const env: PtyEnvironment = {
    ...process.env,
    PATH: [peersShimDir(), process.env.PATH, defaultShellPath].filter(Boolean).join(":"),
    PANDA_CODE_THREADS: threadsStorePath(),
    PANDA_CODE_PEERS_SOCKET: peersSocketPath(),
    PANDA_CODE_PEER_MESSAGES: peerMessagesPath(),
    PANDA_CODE_BACKLOG: backlogDirectory(),
    PANDA_CODE_SCHEDULE: scheduleDirectory(),
    ...(section?.id ? { PANDA_CODE_SECTION_ID: section.id } : {}),
    ...(section?.cwd ? { PANDA_CODE_WORKSPACE: section.cwd } : {}),
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

function claudeTranscriptKey(cwd: string, claudeSessionId: string): string {
  return `claude:${cwd}:${claudeSessionId}`;
}

function codexTranscriptKey(codexThreadId: string): string {
  return `codex:${codexThreadId}`;
}

let transcriptIndexInstance: TranscriptIndexClient | undefined;

function transcriptIndex(): TranscriptIndexClient {
  transcriptIndexInstance ??= new TranscriptIndexClient(
    join(__dirname, "transcript-index-worker.js"),
    join(app.getPath("userData"), "transcript-index"),
    app.getPath("home"),
  );
  return transcriptIndexInstance;
}

function transcriptRegistrations(threads: PersistedThread[]): TranscriptRegistration[] {
  const registrations = new Map<string, TranscriptRegistration>();
  for (const thread of threads) {
    if (thread.claudeSessionId) {
      const key = claudeTranscriptKey(thread.cwd, thread.claudeSessionId);
      registrations.set(key, {
        key,
        runtime: "claude",
        path: join(claudeProjectDir(thread.cwd), `${thread.claudeSessionId}.jsonl`),
      });
    }
    if (thread.codexThreadId) {
      const key = codexTranscriptKey(thread.codexThreadId);
      registrations.set(key, { key, runtime: "codex", codexThreadId: thread.codexThreadId });
    }
  }
  return [...registrations.values()];
}

function registerTranscriptSources(threads: PersistedThread[]): void {
  const registrations = transcriptRegistrations(threads);
  if (registrations.length === 0) return;
  void transcriptIndex().register(registrations).catch((error) => {
    logMain("transcript-index:register-error", { message: error instanceof Error ? error.message : String(error) });
  });
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

function hasEffortFlag(command: string): boolean {
  return /(?:^|\s)--effort(?:\s|=|$)/.test(command);
}

function hasSettingsFlag(command: string): boolean {
  return /(?:^|\s)(?:--settings)(?:\s|=|$)/.test(command);
}

/**
 * Where conserve mode's command-output trimmer scripts sit.
 *
 * Same packaged/dev split as `dictationResourcePaths`: packaged they are
 * unpacked resources next to the app (see `extraResources` in package.json),
 * in development they are still in the source tree.
 */
function trimResourcePaths(packaged: boolean, dirname: string, resourcesPath: string): {
  hookScript: string;
  runScript: string;
} {
  const root = packaged ? join(resourcesPath, "trim") : join(dirname, "../../resources/trim");
  return { hookScript: join(root, "trim-hook.mjs"), runScript: join(root, "trim-run.mjs") };
}

/**
 * Wires the workspace-awareness helper in as an MCP server for this section.
 *
 * Passed as JSON rather than a file so there is no temp file to clean up, and
 * scoped per section (`--self`) so the section never lists itself as a peer.
 * All three tools are allow-listed: a headless `-p` session cannot answer a
 * permission prompt, and an unapproved tool is a denied tool. Two of them only
 * read; `send_message` writes, but only ever into another section of this same
 * workspace, through the same path a phone prompt takes.
 */
function workspacePeersArgs(sessionId: string, cwd: string): string[] {
  const config = {
    mcpServers: {
      [peersServerName]: {
        type: "stdio",
        command: process.execPath,
        args: [
          peersEntryPath(),
          "--mcp",
          "--threads",
          threadsStorePath(),
          "--socket",
          peersSocketPath(),
          "--messages",
          peerMessagesPath(),
          "--backlog",
          backlogDirectory(),
          "--schedule",
          scheduleDirectory(),
          "--cwd",
          cwd,
          "--self",
          sessionId,
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  };

  return [
    "--mcp-config",
    JSON.stringify(config),
    "--allowed-tools",
    peersToolNames.join(","),
  ];
}

function buildStreamClaudeCommand(
  command: string,
  sessionId: string,
  cwd: string,
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
    [
      tldrSystemPrompt,
      backgroundOutputSystemPrompt,
      inlineMediaSystemPrompt,
      workspacePeersMcpPrompt,
      workspaceBacklogMcpPrompt,
      workspaceScheduleMcpPrompt,
      workspaceBrowserMcpPrompt,
      // Last so it reads as the operative policy for this session, and so it
      // can override the peers prompt's "don't spawn agents unless asked".
      ...(appPreferences.conserveMode ? [conserveSystemPrompt] : []),
    ].join("\n\n"),
    ...args,
    // After the caller's own args: `--allowed-tools` is variadic, so ahead of
    // them it would swallow any bare token the user's command ends with.
    ...workspacePeersArgs(sessionId, cwd),
  ];

  if (claudeSessionId && !hasSessionFlag(command)) {
    streamArgs.push("--resume", claudeSessionId);
  }

  if (model?.trim() && !hasModelFlag(command)) {
    streamArgs.push("--model", model.trim());
  }

  // This pure decision is also used by the remote delivery guard. Quoted and
  // escaped flags therefore cannot make the launcher and guard disagree.
  streamArgs.push(...resolveClaudeLaunchPermission(command, permissionMode).appendedArgs);

  if (effort?.trim() && !hasEffortFlag(command)) {
    streamArgs.push("--effort", effort.trim());
  }

  if (appPreferences.conserveMode && !hasSettingsFlag(command)) {
    streamArgs.push("--settings", ensureConserveSettingsFile());
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
      request.id,
      request.cwd,
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
    await clipboard.writeText(request.content);
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

/**
 * Fill in the SHAPE of a stored thread — never its liveness.
 *
 * This runs inside `dedupeThreadsByClaudeSession`, which sits on both the read
 * AND the write path, so anything decided here is decided every time the store
 * is touched. It used to coerce `running` → `exited` here, which meant
 * `writeStoredThreads` rewrote every live section as terminal on its way to
 * disk: the renderer would report `status: "running", agentState: "working"`,
 * and the file would come back `exited`. `lastActiveAt` updated second by
 * second while the state next to it was a lie, so nothing looked stale.
 *
 * Everything downstream reads that file as fact. `peerStatus` treats `exited`
 * as terminal, so every section in the workspace looked terminal forever, and
 * the only thing keeping a running sub-thread from being reported finished was
 * the 45s transcript-freshness heuristic in `peerStatus` — which any section
 * that spends a quiet minute thinking, building, or waiting on a background
 * command trips. That is the false "has finished" notice parents were acting
 * on. Settling a crashed section is a decision about ONE moment (app start,
 * against the processes that actually exist), so it lives in
 * `settleUnbackedThreads` and is applied there, not on every write.
 */
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
    agentState: thread.agentState ?? "exited",
  };
}

/** Session ids with a real process behind them right now, side-effect free. */
function liveSessionIdSet(): Set<string> {
  return new Set<string>([...sessions.keys(), ...streamSessions.keys(), ...codexAppServerManager.ids()]);
}

/**
 * Mark as exited any section recorded `running` that no process backs.
 *
 * The crash case: the app died with sections mid-turn, so the store still says
 * they were running. Checking against the live processes rather than assuming
 * everything is dead is what makes this safe to run on every `threads:load` —
 * opening a second window must not declare the first window's running sections
 * terminal.
 */
function settleUnbackedThreads(threads: PersistedThread[]): PersistedThread[] {
  const live = liveSessionIdSet();
  return threads.map((thread) =>
    thread.status === "running" && !live.has(thread.id)
      ? { ...thread, status: "exited" as const, agentState: "exited" as const }
      : thread,
  );
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

/**
 * Written through a temp file and renamed into place, never straight onto the
 * store.
 *
 * This file is megabytes and is rewritten about once a second while sections are
 * live, and `peers-entry.ts` reads it from a *separate process* on every
 * `list_sessions`, `read_session` and — every two seconds, for minutes — every
 * `wait_for_session` poll. An in-place `writeFileSync` leaves a window where that
 * reader sees a truncated file, and a truncated read parses as "no sections in
 * this workspace": `wait_for_session` answered "No section matching <id>" for a
 * sub-thread that was running perfectly well, three minutes into waiting on it.
 * `rename` is atomic within a filesystem, so a reader sees either the whole old
 * file or the whole new one.
 */
function writeStoredThreads(threads: PersistedThread[]): void {
  const storePath = threadsStorePath();
  mkdirSync(app.getPath("userData"), { recursive: true });
  const tempPath = `${storePath}.tmp-${process.pid}`;
  const capped = threads.map((thread) => ({ ...thread, title: compactSectionTitle(thread.title) || "Untitled" }));
  writeFileSync(tempPath, `${JSON.stringify(dedupeThreadsByClaudeSession(capped), null, 2)}\n`);
  renameSync(tempPath, storePath);
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
  return compactSectionTitle(value || fallback);
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

/**
 * Parsed-conversation cache, keyed by file path and validated by mtime+size.
 *
 * Both the open path (`conversation:load`) and the 1 Hz session detector parse
 * whole transcripts — multi-MB files, per-line JSON.parse, on the main process
 * thread where the work blocks every other IPC. A transcript that has not
 * changed parses to the identical result, so switching back to an idle section
 * should never pay that cost twice. Live sections still miss on every tick
 * (their file genuinely changed), which is correct.
 */
type ConversationCacheEntry = { mtimeMs: number; size: number; result: ClaudeConversationResult };
const conversationReadCache = new Map<string, ConversationCacheEntry>();
const conversationReadCacheLimit = 12;

/**
 * Returns the cached result while the file's mtime+size still match, or the
 * current stat to stamp a new entry with. The stat is taken BEFORE the caller
 * reads the file: a transcript appended mid-parse then fails validation on the
 * next lookup instead of being served stale.
 */
function lookupConversationCache(
  filePath: string,
): { result: ClaudeConversationResult } | { stat: { mtimeMs: number; size: number } } | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  const entry = conversationReadCache.get(filePath);
  if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
    // Refresh recency so eviction tracks use, not insertion.
    conversationReadCache.delete(filePath);
    conversationReadCache.set(filePath, entry);
    return { result: entry.result };
  }
  return { stat: { mtimeMs: stat.mtimeMs, size: stat.size } };
}

function storeCachedConversation(
  filePath: string,
  stat: { mtimeMs: number; size: number },
  result: ClaudeConversationResult,
): void {
  conversationReadCache.delete(filePath);
  conversationReadCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  if (conversationReadCache.size > conversationReadCacheLimit) {
    const oldest = conversationReadCache.keys().next().value;
    if (oldest !== undefined) conversationReadCache.delete(oldest);
  }
}

function readClaudeConversation(cwd: string, claudeSessionId: string): ClaudeConversationResult {
  const filePath = join(claudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  if (!existsSync(filePath)) {
    return { items: [], tokenUsage: emptyTokenUsage() };
  }

  const cacheLookup = lookupConversationCache(filePath);
  if (cacheLookup && "result" in cacheLookup) {
    return cacheLookup.result;
  }

  const items: ConversationItem[] = [];
  // Assistant cards coalesce by message id; an `items.find` per assistant line
  // is O(n²) over the un-truncated list, which on a multi-MB transcript is the
  // dominant cost of this whole function.
  const assistantById = new Map<string, ConversationItem>();
  const tokenUsage = emptyTokenUsage();
  const agentCards: TranscriptAgentCards = createTranscriptAgentCards();
  const parseStarted = Date.now();
  let parsedBytes = 0;
  const finish = (): ClaudeConversationResult => {
    mainPerf.record("read:claude-conversation", Date.now() - parseStarted, parsedBytes);
    const result = { items: items.slice(-transcriptItemLimit), tokenUsage };
    if (cacheLookup) storeCachedConversation(filePath, cacheLookup.stat, result);
    return result;
  };
  try {
    const text = readFileSync(filePath, "utf8");
    parsedBytes = text.length;
    const lines = text.split("\n").filter(Boolean);
    lines.forEach((line, lineIndex) => {
      const entry = JSON.parse(line) as ClaudeJsonLine;
      if (entry.type === "assistant") {
        addUsage(tokenUsage, entry.message?.usage);
      }

      if (entry.type === "user") {
        const userText = conversationTextFromContent(entry.message?.content);
        // `isMeta` marks a turn Claude Code injected itself (a skill body, a
        // system reminder, a slash-command wrapper) — it is not a prompt, so it
        // gets the same collapsed system row the live stream now gives it.
        // Task notifications arrive unflagged, so the wrapper text counts too.
        // ai-title entries carry no timestamp; a timestamp-less item makes the
        // feed sort comparator inconsistent and scrambles ordering. The title
        // already shows in the header/sidebar, so skip the card entirely.
        const syntheticUser = Boolean(entry.isMeta) || (!!userText && looksLikeSyntheticUserText(userText));
        if (userText) {
          resolveTranscriptTaskNotification(agentCards, userText);
        }
        if (userText && (!entry.isMeta || entry.timestamp)) {
          items.push({
            // Same id scheme as the live stream (which reuses the transcript
            // uuid), so merges never duplicate messages across sources.
            id: messageItemId(entry.uuid ?? `${claudeSessionId}:user:${lineIndex}`),
            kind: syntheticUser ? "system" : "user",
            ...(syntheticUser ? { title: syntheticUserTitle(userText) } : {}),
            body: messageBody(userText),
            timestamp: entry.timestamp,
            sequence: lineIndex * 100,
          });
        }
        items.push(...toolItemsFromContent(entry, lineIndex, agentCards));
        return;
      }

      if (entry.type === "assistant") {
        const assistantText = conversationTextFromContent(entry.message?.content);
        if (assistantText) {
          // The stream keys assistant text by API message id and coalesces
          // multiple content blocks into one card; mirror that here.
          const id = messageItemId(entry.message?.id ?? entry.uuid ?? `${claudeSessionId}:assistant:${lineIndex}`);
          const existing = assistantById.get(id);
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
            const item: ConversationItem = {
              id,
              kind: "assistant",
              body,
              timestamp: entry.timestamp,
              sequence: lineIndex * 100,
              model: entry.message?.model,
            };
            items.push(item);
            assistantById.set(id, item);
          }
        }
        items.push(...toolItemsFromContent(entry, lineIndex, agentCards));
      }
    });
  } catch {
    return finish();
  }

  return finish();
}

/** Parse only the indexed records selected for one history page. */
function parseIndexedClaudePage(claudeSessionId: string, page: TranscriptIndexPage): ClaudeConversationResult {
  const items: ConversationItem[] = [];
  const assistantById = new Map<string, ConversationItem>();
  const agentCards: TranscriptAgentCards = createTranscriptAgentCards();
  for (const { text: line, offset: lineIndex } of page.lines) {
    try {
      const entry = JSON.parse(line) as ClaudeJsonLine;
      if (entry.type === "user") {
        const userText = conversationTextFromContent(entry.message?.content);
        const syntheticUser = Boolean(entry.isMeta) || (!!userText && looksLikeSyntheticUserText(userText));
        if (userText) resolveTranscriptTaskNotification(agentCards, userText);
        if (userText && (!entry.isMeta || entry.timestamp)) {
          items.push({
            id: messageItemId(entry.uuid ?? `${claudeSessionId}:user:${lineIndex}`),
            kind: syntheticUser ? "system" : "user",
            ...(syntheticUser ? { title: syntheticUserTitle(userText) } : {}),
            body: messageBody(userText),
            timestamp: entry.timestamp,
            sequence: lineIndex,
          });
        }
        items.push(...toolItemsFromContent(entry, lineIndex, agentCards));
        continue;
      }
      if (entry.type !== "assistant") continue;
      const assistantText = conversationTextFromContent(entry.message?.content);
      if (assistantText) {
        const id = messageItemId(entry.message?.id ?? entry.uuid ?? `${claudeSessionId}:assistant:${lineIndex}`);
        const existing = assistantById.get(id);
        const body = messageBody(assistantText);
        if (existing) {
          const previous = strippedBodyForComparison(existing.body);
          const incoming = strippedBodyForComparison(body);
          existing.body = incoming.startsWith(previous) ? body : previous.includes(incoming) ? existing.body : `${existing.body}\n\n${body}`;
          existing.timestamp = entry.timestamp ?? existing.timestamp;
          existing.model = entry.message?.model ?? existing.model;
        } else {
          const item: ConversationItem = {
            id,
            kind: "assistant",
            body,
            timestamp: entry.timestamp,
            sequence: lineIndex,
            model: entry.message?.model,
          };
          items.push(item);
          assistantById.set(id, item);
        }
      }
      items.push(...toolItemsFromContent(entry, lineIndex, agentCards));
    } catch {
      // One malformed historical record must not discard the rest of the page.
    }
  }
  // The page cursor advances past every line returned by the worker. Do not
  // apply the legacy tail cap here: dropping parsed items would make them
  // unreachable on the next cursor request. The worker already bounds each
  // page and the renderer separately windows what it mounts.
  return { items, tokenUsage: page.metadata.tokenUsage };
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

  const cacheLookup = lookupConversationCache(filePath);
  if (cacheLookup && "result" in cacheLookup) {
    return cacheLookup.result;
  }

  const items: ConversationItem[] = [];
  const tokenUsage = emptyTokenUsage();
  let currentModel: string | undefined;
  const parseStarted = Date.now();
  let parsedBytes = 0;
  const finish = (): ClaudeConversationResult => {
    mainPerf.record("read:codex-conversation", Date.now() - parseStarted, parsedBytes);
    const result = { items: items.slice(-transcriptItemLimit), tokenUsage };
    if (cacheLookup) storeCachedConversation(filePath, cacheLookup.stat, result);
    return result;
  };

  try {
    // Codex rollout files can be enormous because tool output is recorded
    // verbatim (real files in this install exceed 1 GB), while the desktop feed
    // deliberately keeps only the newest 400 items. Reading the whole rollout
    // made a first visit to an old section block Electron's main thread for
    // seconds. A generous bounded tail covers far more than 400 displayable
    // events in normal transcripts and makes the cost independent of age.
    const codexTailBytes = 64 * 1024 * 1024;
    const lines = readTailLineEntries(filePath, 10_000, codexTailBytes);
    const prefersResponseMessages = lines.some(({ text }) => {
      try {
        const entry = JSON.parse(text) as CodexJsonLine;
        return (
          entry.type === "response_item" &&
          entry.payload?.type === "message" &&
          (entry.payload.role === "user" || entry.payload.role === "assistant")
        );
      } catch {
        return false;
      }
    });
    parsedBytes = Math.min(cacheLookup?.stat.size ?? codexTailBytes, codexTailBytes);
    lines.forEach(({ text: line, byteOffset: lineIndex }) => {
      const entry = JSON.parse(line) as CodexJsonLine;
      const payload = entry.payload;
      if (!payload) {
        return;
      }

      if (entry.type === "turn_context") {
        currentModel = payload.model ?? currentModel;
        return;
      }

      if (
        entry.type === "response_item" &&
        payload.type === "message" &&
        (payload.role === "user" || payload.role === "assistant")
      ) {
        const raw = codexPayloadText(payload.content) ?? "";
        const body = payload.role === "user" ? stripDeveloperInstructions(raw) : raw;
        if (body) {
          const kind = payload.role === "user" ? "user" : "assistant";
          items.push({
            id: codexTranscriptMessageId(codexThreadId, kind, lineIndex),
            kind,
            ...(kind === "assistant" ? { title: "Codex", model: currentModel } : {}),
            body: messageBody(body),
            timestamp: entry.timestamp,
            sequence: lineIndex * 100,
          });
        }
        return;
      }

      if (!prefersResponseMessages && entry.type === "event_msg" && payload.type === "user_message") {
        // The rollout records the payload we submitted, wrapper and all. Strip it
        // exactly as the live stream does: otherwise every reloaded Codex prompt
        // shows the TL;DR instructions, and its body no longer matches the live
        // copy it is meant to dedupe against.
        const body = stripDeveloperInstructions(codexPayloadText(payload.message) ?? "");
        if (body) {
          items.push({
            id: codexTranscriptMessageId(codexThreadId, "user", lineIndex),
            kind: "user",
            body: messageBody(body),
            timestamp: entry.timestamp,
            sequence: lineIndex * 100,
          });
        }
        return;
      }

      if (!prefersResponseMessages && entry.type === "event_msg" && payload.type === "agent_message") {
        const body = codexPayloadText(payload.message);
        if (body) {
          items.push({
            id: codexTranscriptMessageId(codexThreadId, "assistant", lineIndex),
            kind: "assistant",
            title: "Codex",
            body: messageBody(body),
            timestamp: entry.timestamp,
            sequence: lineIndex * 100,
            model: currentModel,
          });
        }
        return;
      }

      if (entry.type === "event_msg" && payload.type === "token_count") {
        applyCodexTokenUsage(tokenUsage, payload.info?.total_token_usage);
        return;
      }

      if (entry.type === "event_msg" && payload.type === "task_complete") {
        const summary = codexTranscriptTurnSummaryItem({
          threadId: codexThreadId,
          turnId: payload.turn_id,
          durationMs: Number(payload.duration_ms ?? 0),
          timestamp: entry.timestamp,
          sequence: lineIndex * 100,
        });
        if (summary) items.push(summary);
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
    return finish();
  }

  return finish();
}

function parseIndexedCodexPage(codexThreadId: string, page: TranscriptIndexPage): ClaudeConversationResult {
  const items: ConversationItem[] = [];
  let currentModel: string | undefined;
  const prefersResponseMessages = page.lines.some(({ text }) => {
    try {
      const entry = JSON.parse(text) as CodexJsonLine;
      return (
        entry.type === "response_item" &&
        entry.payload?.type === "message" &&
        (entry.payload.role === "user" || entry.payload.role === "assistant")
      );
    } catch {
      return false;
    }
  });
  for (const { text: line, offset: lineIndex, model } of page.lines) {
    try {
      const entry = JSON.parse(line) as CodexJsonLine;
      const payload = entry.payload;
      if (!payload) continue;
      if (entry.type === "turn_context") {
        currentModel = payload.model ?? currentModel;
        continue;
      }
      if (
        entry.type === "response_item" &&
        payload.type === "message" &&
        (payload.role === "user" || payload.role === "assistant")
      ) {
        const raw = codexPayloadText(payload.content) ?? "";
        const body = payload.role === "user" ? stripDeveloperInstructions(raw) : raw;
        if (body) {
          const kind = payload.role === "user" ? "user" : "assistant";
          items.push({
            id: codexTranscriptMessageId(codexThreadId, kind, lineIndex),
            kind,
            ...(kind === "assistant" ? { title: "Codex", model: model ?? currentModel } : {}),
            body: messageBody(body),
            timestamp: entry.timestamp,
            sequence: lineIndex,
          });
        }
        continue;
      }
      if (!prefersResponseMessages && entry.type === "event_msg" && payload.type === "user_message") {
        const body = stripDeveloperInstructions(codexPayloadText(payload.message) ?? "");
        if (body) {
          items.push({
            id: codexTranscriptMessageId(codexThreadId, "user", lineIndex),
            kind: "user",
            body: messageBody(body),
            timestamp: entry.timestamp,
            sequence: lineIndex,
          });
        }
        continue;
      }
      if (!prefersResponseMessages && entry.type === "event_msg" && payload.type === "agent_message") {
        const body = codexPayloadText(payload.message);
        if (body) {
          items.push({
            id: codexTranscriptMessageId(codexThreadId, "assistant", lineIndex),
            kind: "assistant",
            title: "Codex",
            body: messageBody(body),
            timestamp: entry.timestamp,
            sequence: lineIndex,
            model: model ?? currentModel,
          });
        }
        continue;
      }
      if (entry.type === "event_msg" && payload.type === "task_complete") {
        const summary = codexTranscriptTurnSummaryItem({
          threadId: codexThreadId,
          turnId: payload.turn_id,
          durationMs: Number(payload.duration_ms ?? 0),
          timestamp: entry.timestamp,
          sequence: lineIndex,
        });
        if (summary) items.push(summary);
        continue;
      }
      if (entry.type !== "response_item") continue;
      if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "web_search_call") {
        const callId = payload.call_id ?? payload.id ?? `${codexThreadId}:tool:${lineIndex}`;
        items.push({
          id: toolUseItemId(String(callId)),
          kind: "tool",
          title: payload.name ?? (payload.type === "web_search_call" ? "Web search" : "Tool call"),
          body: compactBody(codexToolBody(payload.arguments ?? payload.input)),
          timestamp: entry.timestamp,
          sequence: lineIndex,
        });
      } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const callId = payload.call_id ?? payload.id ?? `${codexThreadId}:result:${lineIndex}`;
        items.push({
          id: toolResultItemId(String(callId)),
          kind: "tool",
          title: "Tool result",
          body: compactBody(codexToolBody(payload.output)),
          timestamp: entry.timestamp,
          sequence: lineIndex,
        });
      }
    } catch {
      // Keep the rest of the page usable.
    }
  }
  return { items, tokenUsage: page.metadata.tokenUsage };
}

function conversationItemTime(item: ConversationItem): number {
  const time = item.timestamp ? Date.parse(item.timestamp) : NaN;
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

function conversationItemSequence(item: ConversationItem): number {
  return typeof item.sequence === "number" ? item.sequence : Number.POSITIVE_INFINITY;
}

function mergeLoadedConversations(
  results: ClaudeConversationResult[],
  itemLimit = transcriptItemLimit,
): ClaudeConversationResult {
  const seen = new Set<string>();
  const sortedItems = results
    .flatMap((result) => result.items)
    .filter((item) => {
      if (seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    })
    .sort((first, second) => {
      const timeDelta = conversationItemTime(first) - conversationItemTime(second);
      if (timeDelta !== 0) {
        return timeDelta;
      }
      const sequenceDelta = conversationItemSequence(first) - conversationItemSequence(second);
      return sequenceDelta !== 0 ? sequenceDelta : first.id.localeCompare(second.id);
    });
  const items = Number.isFinite(itemLimit) ? sortedItems.slice(-itemLimit) : sortedItems;

  const tokenUsage = results.at(-1)?.tokenUsage ?? emptyTokenUsage();
  return { items, tokenUsage };
}

function readConversation(request: { cwd: string; claudeSessionId?: string; codexThreadId?: string }): ClaudeConversationResult {
  if (request.claudeSessionId && request.codexThreadId) {
    return mergeLoadedConversations([
      readClaudeConversation(request.cwd, request.claudeSessionId),
      readCodexConversation(request.codexThreadId),
    ]);
  }

  if (request.claudeSessionId) {
    return readClaudeConversation(request.cwd, request.claudeSessionId);
  }

  if (request.codexThreadId) {
    return readCodexConversation(request.codexThreadId);
  }

  return { items: [], tokenUsage: emptyTokenUsage() };
}

async function readIndexedConversation(request: ConversationLoadRequest): Promise<ClaudeConversationResult> {
  const registrations: TranscriptRegistration[] = [];
  if (request.claudeSessionId) {
    const key = claudeTranscriptKey(request.cwd, request.claudeSessionId);
    registrations.push({ key, runtime: "claude", path: join(claudeProjectDir(request.cwd), `${request.claudeSessionId}.jsonl`) });
  }
  if (request.codexThreadId) {
    const key = codexTranscriptKey(request.codexThreadId);
    registrations.push({ key, runtime: "codex", codexThreadId: request.codexThreadId });
  }
  if (registrations.length === 0) return { items: [], tokenUsage: emptyTokenUsage(), hasEarlier: false };
  await transcriptIndex().register(registrations);

  const paging = request.beforeCursor !== undefined;
  const [claudePage, codexPage] = await Promise.all([
    request.claudeSessionId && (!paging || request.beforeCursor?.claude !== undefined)
      ? transcriptIndex().page(
          claudeTranscriptKey(request.cwd, request.claudeSessionId),
          request.beforeCursor?.claude,
        )
      : Promise.resolve(undefined),
    request.codexThreadId && (!paging || request.beforeCursor?.codex !== undefined)
      ? transcriptIndex().page(codexTranscriptKey(request.codexThreadId), request.beforeCursor?.codex)
      : Promise.resolve(undefined),
  ]);
  const results: ClaudeConversationResult[] = [];
  if (claudePage && request.claudeSessionId) results.push(parseIndexedClaudePage(request.claudeSessionId, claudePage));
  if (codexPage && request.codexThreadId) results.push(parseIndexedCodexPage(request.codexThreadId, codexPage));
  const merged = results.length > 1
    ? mergeLoadedConversations(results, Number.POSITIVE_INFINITY)
    : (results[0] ?? { items: [], tokenUsage: emptyTokenUsage() });
  const beforeCursor = {
    ...(claudePage?.hasEarlier && claudePage.beforeOffset !== undefined ? { claude: claudePage.beforeOffset } : {}),
    ...(codexPage?.hasEarlier && codexPage.beforeOffset !== undefined ? { codex: codexPage.beforeOffset } : {}),
  };
  const hasEarlier = claudePage?.hasEarlier === true || codexPage?.hasEarlier === true;
  return { ...merged, hasEarlier, ...(hasEarlier ? { beforeCursor } : {}) };
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

async function searchIndexedConversations(request: ConversationSearchRequest): Promise<ConversationSearchResult[]> {
  const query = request.query.trim().toLocaleLowerCase();
  if (!query) return [];
  const titleHits: ConversationSearchResult[] = [];
  const documents: import("../shared/transcript-index").TranscriptIndexSearchDocument[] = [];
  const registrations: TranscriptRegistration[] = [];
  for (const session of request.sessions) {
    if (session.title.toLocaleLowerCase().includes(query)) {
      titleHits.push({ id: session.id, title: session.title, workspaceName: session.workspaceName, snippet: "", matchedInTitle: true });
      continue;
    }
    const key = session.codexThreadId
      ? codexTranscriptKey(session.codexThreadId)
      : session.claudeSessionId
        ? claudeTranscriptKey(session.cwd, session.claudeSessionId)
        : undefined;
    if (!key) continue;
    if (session.codexThreadId) registrations.push({ key, runtime: "codex", codexThreadId: session.codexThreadId });
    else registrations.push({ key, runtime: "claude", path: join(claudeProjectDir(session.cwd), `${session.claudeSessionId}.jsonl`) });
    documents.push({ key, id: session.id, title: session.title, workspaceName: session.workspaceName });
  }
  if (registrations.length > 0) await transcriptIndex().register(registrations);
  const hits = await transcriptIndex().search(query, documents, 100);
  return [
    ...titleHits,
    ...hits.map((hit) => ({
      id: hit.id,
      title: hit.title,
      workspaceName: hit.workspaceName,
      snippet: searchSnippet(hit.text, hit.matchIndex, query.length),
      matchedInTitle: false,
    })),
  ];
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
  const storedThreads = settleUnbackedThreads(readStoredThreads());
  const firstStoredThread = storedThreads[0];
  const shouldRecover =
    storedThreads.length === 0 || (storedThreads.length === 1 && firstStoredThread && isPlaceholderThread(firstStoredThread));

  if (!shouldRecover) {
    // A title persisted on the section is canonical at startup. The previous
    // loader re-opened every auto-titled transcript to rediscover it — 1,700+
    // files and ~1.5 GB on the current install before the window could settle.
    // Live workspace indexing updates a title when (and only when) that source
    // transcript appends new bytes.
    const trustedThreads = storedThreads.map((thread) => {
      if (thread.titleSource === "manual") return thread;
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
    if (trustedThreads.some((thread, index) => thread !== storedThreads[index])) writeStoredThreads(trustedThreads);
    registerTranscriptSources(trustedThreads);
    return trustedThreads;
  }

  const recoveredThreads = recoverClaudeThreads([defaultWorkspace, ...storedThreads.map((thread) => thread.cwd)]);
  if (recoveredThreads.length > 0) {
    writeStoredThreads(recoveredThreads);
    registerTranscriptSources(recoveredThreads);
    return recoveredThreads;
  }

  return storedThreads;
}

/**
 * `current` is the sweep the caller already performed. Taking it as a parameter
 * removes a second full readdir+stat of the project directory on every tick of
 * every live section's detector — the old code called `readClaudeSessions`
 * again here, doubling that cost for no new information.
 */
function readNewUserPrompts(
  cwd: string,
  before: ClaudeSessionSnapshot,
  startedAt: number,
  seenPromptKeys: Set<string>,
  current: ClaudeSessionSnapshot,
): Array<{ claudeSessionId: string; submittedAt: string }> {
  const projectDir = claudeProjectDir(cwd);
  const prompts: Array<{ claudeSessionId: string; submittedAt: string }> = [];

  if (!existsSync(projectDir)) {
    return prompts;
  }

  for (const [claudeSessionId, mtimeMs] of current) {
    const previousMtime = before.get(claudeSessionId);
    if (previousMtime !== undefined && mtimeMs <= previousMtime + 1) {
      continue;
    }

    try {
      const filePath = join(projectDir, `${claudeSessionId}.jsonl`);
      // Bounded tail read: this runs once per live section per second against
      // every transcript that changed, and transcripts here reach 8 MB.
      const lines = readTailLines(filePath, 25);
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
  const cwd = claudeSessionDetectors.get(id);
  if (cwd) {
    const workspace = claudeWorkspaceDetectors.get(cwd);
    workspace?.subscribers.delete(id);
    if (workspace && workspace.subscribers.size === 0) {
      clearInterval(workspace.timer);
      claudeWorkspaceDetectors.delete(cwd);
    }
  }
  claudeSessionDetectors.delete(id);
  detectedClaudeSessions.delete(id);
}

async function runClaudeWorkspaceDetector(cwd: string, detector: ClaudeWorkspaceDetector): Promise<void> {
  if (detector.running) return;
  detector.running = true;
  const tickStarted = Date.now();
  try {
    for (const id of detector.subscribers.keys()) {
      if (!sessions.has(id)) stopClaudeSessionDetector(id);
    }
    if (detector.subscribers.size === 0) return;
    const nextSnapshot = readClaudeSessions(cwd);
    const earliestStart = Math.min(...[...detector.subscribers.values()].map((subscriber) => subscriber.startedAt));
    // One tail parse for the workspace, regardless of how many sections are
    // listening. Prompt ownership is filtered per subscriber below.
    const prompts = readNewUserPrompts(cwd, detector.snapshot, earliestStart, detector.seenPromptKeys, nextSnapshot);
    const pageBySession = new Map<string, Promise<{ page: TranscriptIndexPage; conversation: ClaudeConversationResult }>>();
    const indexedPage = (claudeSessionId: string) => {
      let pending = pageBySession.get(claudeSessionId);
      if (!pending) {
        const key = claudeTranscriptKey(cwd, claudeSessionId);
        pending = transcriptIndex()
          .register([{ key, runtime: "claude", path: join(claudeProjectDir(cwd), `${claudeSessionId}.jsonl`) }])
          .then(() => transcriptIndex().page(key))
          .then((page) => ({ page, conversation: parseIndexedClaudePage(claudeSessionId, page) }));
        pageBySession.set(claudeSessionId, pending);
      }
      return pending;
    };

    for (const subscriber of detector.subscribers.values()) {
      const matchingPrompts = prompts.filter(
        (prompt) => new Date(prompt.submittedAt).getTime() >= subscriber.startedAt - 2_000,
      );
      let claudeSessionId = detectedClaudeSessions.get(subscriber.id);
      const promptSessionId = matchingPrompts.at(-1)?.claudeSessionId;
      if (!claudeSessionId && promptSessionId) {
        claudeSessionId = promptSessionId;
        detectedClaudeSessions.set(subscriber.id, promptSessionId);
      }
      if (!claudeSessionId) {
        const changed = newestChangedSession(detector.snapshot, nextSnapshot, subscriber.startedAt);
        if (changed) {
          claudeSessionId = changed;
          detectedClaudeSessions.set(subscriber.id, changed);
        }
      }
      if (claudeSessionId && changedExistingSession(detector.snapshot, nextSnapshot, claudeSessionId)) {
        sendToLiveWindows("session:claude-session", { id: subscriber.id, claudeSessionId });
        try {
          const { page, conversation } = await indexedPage(claudeSessionId);
          if (page.metadata.title) sendToLiveWindows("session:title", { id: subscriber.id, title: page.metadata.title });
          sendToLiveWindows("session:conversation", { id: subscriber.id, claudeSessionId, ...conversation });
        } catch (error) {
          logMain("transcript-index:refresh-error", {
            id: subscriber.id,
            claudeSessionId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const prompt of matchingPrompts) {
        if (claudeSessionId && prompt.claudeSessionId !== claudeSessionId) continue;
        sendToLiveWindows("session:prompt-submitted", { id: subscriber.id, submittedAt: prompt.submittedAt });
      }
    }
    detector.snapshot = nextSnapshot;
  } finally {
    detector.running = false;
    mainPerf.record("detect:claude-workspace", Date.now() - tickStarted, detector.subscribers.size);
  }
}

function detectClaudeSession(id: string, cwd: string, before: ClaudeSessionSnapshot, startedAt: number): void {
  stopClaudeSessionDetector(id);
  let detector = claudeWorkspaceDetectors.get(cwd);
  if (!detector) {
    const subscribers = new Map<string, ClaudeWorkspaceSubscriber>();
    const placeholder = {
      snapshot: before,
      subscribers,
      seenPromptKeys: new Set<string>(),
      timer: undefined as unknown as NodeJS.Timeout,
      running: false,
    };
    placeholder.timer = setInterval(() => void runClaudeWorkspaceDetector(cwd, placeholder), 1_000);
    placeholder.timer.unref?.();
    detector = placeholder;
    claudeWorkspaceDetectors.set(cwd, detector);
  }
  detector.subscribers.set(id, { id, startedAt });
  claudeSessionDetectors.set(id, cwd);
}

/** Most a task's output tail may contribute to a snapshot. */
const taskOutputTailLimit = 4_000;
const taskOutputPollMs = 750;

/**
 * A background shell writes its stdout/stderr to a file and streams none of it,
 * so its card would otherwise have nothing to show. Read the tail here (main
 * has fs; the shared reducer is imported by the renderer too) and attach it.
 * Only shell tasks: a real subagent's output_file is its whole JSONL
 * transcript, and its content already arrives as nested items.
 */
function readFileTail(path: string): string | undefined {
  try {
    const { size } = statSync(path);
    const start = Math.max(0, size - taskOutputTailLimit);
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(size, taskOutputTailLimit));
      readSync(handle, buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8").trim();
      if (!text) {
        return undefined;
      }
      return start > 0 ? `…${text}` : text;
    } finally {
      closeSync(handle);
    }
  } catch {
    // The file may not exist yet, or at all.
    return undefined;
  }
}

/**
 * The files a shell task's output could be in, best first: the CLI's own
 * capture, then the file the command itself writes to. The second is what makes
 * `… | tee log | tail -20` readable — the CLI's file stays empty until the
 * command exits, while tee's log fills from the first second.
 */
function taskOutputCandidates(agent: AgentActivity): string[] {
  if (agent.subagentType !== undefined) {
    // A subagent's output_file is its whole JSONL transcript, already rendered
    // as nested items.
    return [];
  }
  return [agent.outputFile, agent.commandOutputFile].filter((path): path is string => Boolean(path));
}

function withHydratedTaskOutput(items: ConversationItem[]): ConversationItem[] {
  return items.map((item) => {
    const agent = item.agent;
    if (item.kind !== "agent" || !agent) {
      return item;
    }

    for (const path of taskOutputCandidates(agent)) {
      const tail = readFileTail(path);
      if (tail) {
        return { ...item, agent: { ...agent, outputTail: tail } };
      }
    }
    return item;
  });
}

function taskOutputSignature(items: ConversationItem[]): string | undefined {
  const signatures = items.flatMap((item) => {
    const agent = item.agent;
    if (item.kind !== "agent" || !agent || agent.status !== "running") {
      return [];
    }

    return taskOutputCandidates(agent).map((path) => {
      try {
        const { mtimeMs, size } = statSync(path);
        return `${path}:${size}:${mtimeMs}`;
      } catch {
        return `${path}:missing`;
      }
    });
  });
  return signatures.length > 0 ? signatures.join("|") : undefined;
}

function pollTaskOutputTails(): void {
  for (const [id, streamSession] of streamSessions) {
    const signature = taskOutputSignature(streamSession.state.items);
    if (!signature) {
      streamSession.taskOutputSignature = undefined;
      continue;
    }
    if (signature === streamSession.taskOutputSignature) {
      continue;
    }
    streamSession.taskOutputSignature = signature;
    sendStreamSnapshot(id, streamSession);
  }
}

setInterval(pollTaskOutputTails, taskOutputPollMs);

type SnapshotStreamSession = {
  state: StreamJsonState;
  runtime?: AgentRuntime;
  request?: { runtime?: AgentRuntime; model?: string; cwd?: string; claudeSessionId?: string; codexThreadId?: string };
};

function emitStreamSnapshot(id: string, streamSession: SnapshotStreamSession): void {
  const runtimeKind = streamSession.runtime ?? streamSession.request?.runtime ??
    (streamSession.state.codexThreadId ? "codex" : "claude");
  sendToLiveWindows("session:runtime", streamRuntimeEvent(id, streamSession.state, runtimeKind));
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

// A full conversation is tens or hundreds of KB. Cap each section at 10 UI
// snapshots/second; parser/accounting work still observes every delta, while
// the renderer receives the newest state rather than every intermediate copy.
const streamSnapshotThrottle = new LatestValueThrottle<SnapshotStreamSession>(100, emitStreamSnapshot);

function sendStreamSnapshot(id: string, streamSession: SnapshotStreamSession): void {
  // The exec path passes a full StreamSession (has `.runtime`); the app-server
  // path passes a CodexAppServerSession (has `.request.runtime`, always codex).
  // Fall back to the codex thread id, then claude, so a remote client can always
  // resolve which runtime backs the session.
  const runtimeKind =
    streamSession.runtime ??
    streamSession.request?.runtime ??
    (streamSession.state.codexThreadId ? "codex" : "claude");
  const counterId =
    runtimeKind === "codex"
      ? (streamSession.state.codexThreadId ?? streamSession.request?.codexThreadId)
      : (streamSession.state.claudeSessionId ?? streamSession.request?.claudeSessionId);
  const runtime = streamRuntimeEvent(id, streamSession.state, runtimeKind);
  // Snapshots are the one place every runtime's usage passes through, so this is
  // where the durable cost ledger is fed. It stores deltas, so being called on
  // every event is cheap and idempotent.
  usageLedger().record({
    sessionId: id,
    runtime: runtimeKind,
    counterId,
    // Claude reports the resolved model on every assistant message. Codex only
    // reports it when a thread is *started* (not resumed), so fall back to the
    // model the section was launched with; an unset model stays unattributed
    // rather than being priced as a guess.
    model: streamSession.state.latestModel || streamSession.request?.model,
    cumulative: streamSession.state.tokenUsage,
  });
  scheduleSessionFileSnapshot(id, streamSession);
  streamSnapshotThrottle.push(id, streamSession, runtime.agentState !== "working");
}

function clearAutoRetry(id: string): void {
  const existing = autoRetryState.get(id);
  if (!existing) {
    return;
  }
  clearTimeout(existing.timer);
  autoRetryState.delete(id);
}

/**
 * Called once per section turn that just ended in a retryable
 * `error_during_execution` result. Resends the turn itself with exponential
 * backoff (5s, 10s, 20s, 40s, 80s) instead of leaving the section sitting on a
 * transient failure until a human notices and taps "continue". Gives up after
 * `AUTO_RETRY_MAX_ATTEMPTS` and surfaces the section as `needs_action` so it
 * still gets a human's attention rather than looking silently finished.
 */
function scheduleAutoRetry(id: string): void {
  const streamSession = streamSessions.get(id);
  if (!streamSession) {
    return;
  }

  const attempt = (autoRetryState.get(id)?.attempt ?? 0) + 1;
  clearAutoRetry(id);

  if (attempt > AUTO_RETRY_MAX_ATTEMPTS) {
    pushItem(streamSession.state, {
      id: `retry:gave-up:${id}:${Date.now()}`,
      kind: "system",
      title: "Auto-retry",
      body: `Gave up retrying automatically after ${AUTO_RETRY_MAX_ATTEMPTS} transient API errors. Send a message to continue.`,
      timestamp: new Date().toISOString(),
    });
    streamSession.state.agentState = "needs_action";
    sendStreamSnapshot(id, streamSession);
    return;
  }

  const delayMs = Math.min(AUTO_RETRY_BASE_MS * 2 ** (attempt - 1), AUTO_RETRY_MAX_MS);
  pushItem(streamSession.state, {
    id: `retry:scheduled:${id}:${attempt}`,
    kind: "system",
    title: "Auto-retry",
    body: `Transient API error mid-response. Retrying automatically in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${AUTO_RETRY_MAX_ATTEMPTS}).`,
    timestamp: new Date().toISOString(),
  });
  sendStreamSnapshot(id, streamSession);

  const timer = setTimeout(() => {
    autoRetryState.delete(id);
    if (!streamSessions.has(id)) {
      return;
    }
    void sessionService.sendInput({ id, data: "Continue exactly where you left off." });
  }, delayMs);
  timer.unref?.();
  autoRetryState.set(id, { attempt, timer });
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
  if (streamSession.runtime === "claude" && parsed.event.type === "result") {
    if (streamSession.state.lastResultError?.subtype === "error_during_execution") {
      scheduleAutoRetry(id);
    } else {
      clearAutoRetry(id);
    }
  }
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

function syncSessionTitle(id: string, streamSession: StreamSession): void {
  if (streamSession.titleLocked) return;
  const claudeSessionId = streamSession.state.claudeSessionId;
  const codexThreadId = streamSession.state.codexThreadId;
  const key = streamSession.runtime === "codex" && codexThreadId
    ? codexTranscriptKey(codexThreadId)
    : claudeSessionId
      ? claudeTranscriptKey(streamSession.cwd, claudeSessionId)
      : undefined;
  if (!key) return;
  const registration: TranscriptRegistration = streamSession.runtime === "codex" && codexThreadId
    ? { key, runtime: "codex", codexThreadId }
    : { key, runtime: "claude", path: join(claudeProjectDir(streamSession.cwd), `${claudeSessionId}.jsonl`) };
  void transcriptIndex()
    .register([registration])
    .then(() => transcriptIndex().metadata(key, true))
    .then((metadata) => {
      if (!metadata.title || streamSession.titleLocked) return;
      if (metadata.title !== streamSession.emittedTitle) {
        streamSession.emittedTitle = metadata.title;
        sendToLiveWindows("session:title", { id, title: metadata.title });
      }
      if (metadata.titleSource === "ai" || streamSession.runtime === "codex") streamSession.titleLocked = true;
    })
    .catch((error) => logMain("transcript-index:title-error", { id, message: String(error) }));
}

// Sync a codex app-server section's title. app-server threads persist to
// ~/.codex/sessions like exec threads, so the prompt-derived title reader works
// once the thread id is known. Codex titles are final, so this locks after one hit.
function syncAppServerTitle(id: string, session: CodexAppServerSession): void {
  if (session.titleLocked || !session.threadId) return;
  const key = codexTranscriptKey(session.threadId);
  void transcriptIndex()
    .register([{ key, runtime: "codex", codexThreadId: session.threadId }])
    .then(() => transcriptIndex().metadata(key, true))
    .then((metadata) => {
      if (!metadata.title || session.titleLocked) return;
      const indexedResult: ClaudeTitleResult = {
        title: metadata.title,
        source: metadata.titleSource === "handoff" ? "handoff" : metadata.titleSource === "ai" ? "ai" : "prompt",
      };
      // A runtime switch commonly opens Codex with only "Continue" after a
      // transcript handoff. The section still carries its original Claude
      // session id, whose ai-title is both semantic and already familiar to the
      // user; preserve it instead of renaming the section after transport text
      // or the last incidental question in the handoff excerpt.
      const resolved = fallbackClaudeTitleForContinuation(
        session.request.cwd,
        session.request.claudeSessionId,
        indexedResult,
      );
      if (!resolved) return;
      if (resolved.title !== session.emittedTitle) {
        session.emittedTitle = resolved.title;
        sendToLiveWindows("session:title", { id, title: resolved.title });
      }
      session.titleLocked = true;
    })
    .catch((error) => logMain("transcript-index:title-error", { id, message: String(error) }));
}

/**
 * Publish a model-generated name and stop every fallback title reader first.
 * The previous peer-title callback only notified the renderer, so the async
 * Codex transcript sync could subsequently overwrite the good title with the
 * first injected input block (often the recommended-plugin catalog).
 */
function publishGeneratedSectionTitle(id: string, value: string): void {
  const title = compactSectionTitle(value);
  if (!title) return;
  const streamSession = streamSessions.get(id);
  if (streamSession) {
    streamSession.emittedTitle = title;
    streamSession.titleLocked = true;
  }
  codexAppServerManager.lockTitle(id, title);
  sendToLiveWindows("session:title", { id, title });
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
  setTitle: publishGeneratedSectionTitle,
});

/**
 * Sections whose composer holds text the user has written but not sent, as last
 * reported by the renderer. The draft itself never leaves the renderer — this is
 * only the set of ids, and only so the reaper can leave those processes alone.
 * A window that dies without clearing its ids costs nothing worse than a section
 * that outstays the sweep until the next report replaces the set.
 */
let unsentDraftSessionIds = new Set<string>();

/**
 * Every section currently holding a live agent process, across both transports.
 * The cap counts Claude and Codex sections together — they compete for the same
 * RAM, and a cap that only saw one map would let the other grow unbounded.
 */
function liveSections(): LiveSection[] {
  const sections: LiveSection[] = [];
  for (const [id, session] of streamSessions) {
    sections.push({
      id,
      runtime: session.runtime,
      agentState: session.state.agentState,
      resumable: Boolean(session.state.claudeSessionId ?? session.request.claudeSessionId),
      lastPromptAt: session.lastPromptAt,
      hasUnsentDraft: unsentDraftSessionIds.has(id),
      hasBackgroundWork: hasBackgroundWork(session.state),
    });
  }
  for (const id of codexAppServerManager.ids()) {
    const session = codexAppServerManager.get(id);
    if (!session) continue;
    sections.push({
      id,
      runtime: "codex",
      agentState: session.state.agentState,
      resumable: Boolean(session.threadId ?? session.request.codexThreadId),
      lastPromptAt: session.lastPromptAt,
      hasUnsentDraft: unsentDraftSessionIds.has(id),
      hasBackgroundWork: hasBackgroundWork(session.state),
    });
  }
  for (const id of groqSessionManager.ids()) {
    const session = groqSessionManager.get(id);
    if (!session) continue;
    sections.push({
      id,
      runtime: "groq",
      agentState: session.state.agentState,
      resumable: true,
      lastPromptAt: session.lastPromptAt,
      hasUnsentDraft: unsentDraftSessionIds.has(id),
      hasBackgroundWork: false,
    });
  }
  return sections;
}

function applyEvictions(evictions: Eviction[]): void {
  for (const eviction of evictions) {
    const hibernated = sessionService.hibernateSession(eviction.id);
    logMain("session:reap", { id: eviction.id, reason: eviction.reason, hibernated });
    if (hibernated) {
      // The renderer holds this section's whole transcript too, and it is the
      // same judgement — the section is cold. One policy, both sides of the app.
      const payload: SessionHibernatedEvent = { id: eviction.id, reason: eviction.reason };
      sendToLiveWindows("session:hibernated", payload);
    }
  }
}

/**
 * Make room for a section that is about to spawn. Run before the spawn rather
 * than after it so the live process count never actually crosses the ceiling —
 * on a machine already in swap, briefly holding cap + 1 is the moment that hurts.
 */
function enforceLiveSessionCap(incomingId: string): void {
  const maxLive = effectiveHygiene(appPreferences).maxLiveSessions;
  if (maxLive <= 0) return;
  const sections = liveSections();
  // A start for a section that is already live replaces nothing and adds nothing.
  const incoming = sections.some((section) => section.id === incomingId) ? 0 : 1;
  applyEvictions(
    selectEvictions({ sections, maxLive, idleTimeoutMs: 0, now: Date.now(), incoming, exempt: [incomingId] }),
  );
}

/**
 * Hibernate sections that have sat idle past the configured timeout. This is the
 * half of the policy that gives memory back when you walk away — the cap alone
 * would happily hold its full quota of processes overnight, sleep blocker and
 * all.
 */
function sweepIdleSessions(): void {
  const idleTimeoutMs = effectiveHygiene(appPreferences).idleSessionTimeoutMinutes * 60_000;
  if (idleTimeoutMs <= 0) return;
  applyEvictions(
    selectEvictions({ sections: liveSections(), maxLive: 0, idleTimeoutMs, now: Date.now() }),
  );
}

/**
 * Release idle browser pages on the same clock as idle sections.
 *
 * One sweep, one policy: a tab is a renderer process the same way a section is
 * an agent process, and both should give memory back when the user walks away.
 * The browser's own timeouts are shorter (waking a tab is a page load, not a
 * model round trip) so this passes its defaults through rather than the session
 * preference.
 */
function sweepIdleBrowserTabs(): void {
  if (!browserServiceInstance) return;
  browserServiceInstance.sweep({ visibleThreadId: activeThreadId });
}

setInterval(() => {
  sweepIdleSessions();
  sweepIdleBrowserTabs();
}, 60_000);

function startStreamSession(request: SessionStartRequest): SessionStartResult {
  enforceLiveSessionCap(request.id);

  if (request.runtime === "groq") {
    logMain("groq:start", { id: request.id, cwd: request.cwd, model: request.model });
    streamResumeRequests.set(request.id, request);
    return groqSessionManager.start(request);
  }

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
    if (request.codexThreadId) {
      const key = codexTranscriptKey(request.codexThreadId);
      void transcriptIndex()
        .register([{ key, runtime: "codex", codexThreadId: request.codexThreadId }])
        .then(() => transcriptIndex().metadata(key, true))
        .then((metadata) => usageLedger().seed({ sessionId: request.id, runtime: "codex", counterId: request.codexThreadId!, cumulative: metadata.tokenUsage }))
        .catch((error) => logMain("transcript-index:usage-seed-error", { id: request.id, message: String(error) }));
    }
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
    if (request.claudeSessionId) {
      const key = claudeTranscriptKey(request.cwd, request.claudeSessionId);
      void transcriptIndex()
        .register([{ key, runtime: "claude", path: join(claudeProjectDir(request.cwd), `${request.claudeSessionId}.jsonl`) }])
        .then(() => transcriptIndex().metadata(key, true))
        .then((metadata) => usageLedger().seed({ sessionId: request.id, runtime, counterId: request.claudeSessionId!, cumulative: metadata.tokenUsage }))
        .catch((error) => logMain("transcript-index:usage-seed-error", { id: request.id, message: String(error) }));
    }
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
      env: ptyEnvironment({ id: request.id, cwd: request.cwd }),
      stdio: "pipe",
    });
    child.stdin.setDefaultEncoding("utf8");
    streamResumeRequests.set(request.id, request);

    const streamSession: StreamSession = {
      process: child,
      runtime,
      // A launch only ever happens to carry a prompt, and the CLI says nothing
      // until it has booted (3s warm, 30s+ with MCP servers to load). A fresh
      // state defaults to "waiting", so the launch snapshot below — and every
      // system notice until the first `user` event — reported the section idle
      // for the whole cold start: spinner off, and the renderer's finish timer
      // fired a "ready" notification for a turn that had not begun.
      state: { ...createStreamJsonState(), agentState: "working" },
      stdoutBuffer: "",
      cwd: request.cwd,
      request,
      // A launch only ever happens to carry a prompt, so the section starts its
      // life at the front of the eviction queue rather than at the back.
      lastPromptAt: Date.now(),
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
      clearAutoRetry(request.id);
      logMain("stream-json:error", { id: request.id, message: error.message });
      streamSession.state.agentState = "needs_action";
      streamSession.state.currentEventType = "process:error";
      streamSession.state.lastEventAt = new Date().toISOString();
      sendStreamSnapshot(request.id, streamSession);
    });

    child.on("close", (exitCode, signal) => {
      clearAutoRetry(request.id);
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
  return undefined;
}

async function indexedCodexBtwTranscript(request: { transcript?: string; cwd: string; codexThreadId?: string }): Promise<string | undefined> {
  const provided = codexBtwTranscript(request);
  if (provided || !request.codexThreadId) return provided;
  try {
    return serializeBtwContextForMain((await readIndexedConversation(request)).items);
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
            // /btw owns a compact transcript and never consumes resumed turns.
            excludeTurns: true,
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
      const transcript = await indexedCodexBtwTranscript(request);
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
// button, a turn finishing, and the relay usage push all funnel through
// loadUsageSnapshot, so this is the only place the network rate is set.
//
// The background rate is deliberately slow: plan usage only moves when a turn
// runs, and `api.anthropic.com/api/oauth/usage` throttles an account that calls
// it on a tight loop (which is what a 60s poll was — 1,440 calls a day for
// numbers that change a handful of times an hour). The claude CLI only calls it
// when you type /usage, which is why /usage kept working while this card sat
// rate-limited.
const usageMinFetchIntervalMs = 5 * 60_000;
// A refresh the user actually clicked may cut ahead of the background interval —
// otherwise the button is a lie. It still cannot bypass a 429 cooldown.
const usageForcedMinFetchIntervalMs = 30_000;
// First cooldown after a 429 that carries no Retry-After header. Repeated 429s
// double it (see usageRateLimitStrikes) up to the cap, because coming back at a
// fixed 5m into a limit we are still inside just earns another 429.
const usageRateLimitCooldownMs = 5 * 60_000;
const usageRateLimitCooldownMaxMs = 60 * 60_000;
const usageFetchTimeoutMs = 12_000;
const codexUsageTimeoutMs = 15_000;
const usageCache: Partial<Record<UsageProvider, { snapshot: UsageSnapshot | null; fetchedAtMs: number }>> = {};
const usageInFlight: Partial<Record<UsageProvider, Promise<UsageSnapshot | null>>> = {};
// Last snapshot that actually carried windows, per provider. A transient failure
// serves this back marked stale instead of blanking the card.
const usageLastGood: Partial<Record<UsageProvider, UsageSnapshot>> = {};
// Epoch ms until which a provider is off limits because it answered 429.
const usageCooldownUntil: Partial<Record<UsageProvider, number>> = {};
// Consecutive 429s with no success in between, so the cooldown can back off.
const usageRateLimitStrikes: Partial<Record<UsageProvider, number>> = {};

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

function runGit(cwd: string, args: string[], timeout = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

type GhResult = { stdout: string; stderr: string; error: (Error & { code?: string | number | null }) | null };

function runGh(cwd: string, args: string[], timeout = 20_000): Promise<GhResult> {
  return new Promise((resolveRun) => {
    execFile(
      "gh",
      args,
      {
        cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        // Finder-launched apps do not inherit the user's shell PATH. Homebrew
        // is where `gh` normally lives on Apple Silicon and Intel Macs.
        env: { ...process.env, PATH: [process.env.PATH, defaultShellPath].filter(Boolean).join(":") },
      },
      (error, stdout, stderr) => resolveRun({ stdout, stderr, error }),
    );
  });
}

/** Talking to a remote crosses the network — give it far more than a local read. */
const GIT_FETCH_TIMEOUT_MS = 60_000;

/**
 * Where the repo last heard from a remote. FETCH_HEAD is rewritten by every
 * fetch/pull, so its mtime is the age of the ahead/behind counts.
 */
function lastFetchTime(cwd: string, gitDir: string | undefined): string | undefined {
  if (!gitDir) {
    return undefined;
  }

  try {
    const stat = statSync(join(isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir), "FETCH_HEAD"));
    return new Date(stat.mtimeMs).toISOString();
  } catch {
    // Never fetched (or a worktree without one) — the UI says "never fetched".
    return undefined;
  }
}

/**
 * Ahead/behind of HEAD against one remote-tracking ref. `--left-right` counts
 * "only on the left" then "only on the right", i.e. behind then ahead.
 */
async function countAgainstRef(cwd: string, ref: string): Promise<{ ahead: number; behind: number } | null> {
  const out = await runGit(cwd, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
  if (!out) {
    return null;
  }

  const [behindRaw, aheadRaw] = out.trim().split(/\s+/);
  const behind = Number(behindRaw);
  const ahead = Number(aheadRaw);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return null;
  }

  return { ahead, behind };
}

/**
 * Every remote, each with the current branch's standing against it. A repo
 * usually has one remote — but a fork setup has origin+upstream, and "am I in
 * sync?" has a different answer for each.
 */
async function loadRemotes(cwd: string, branch: string | undefined, upstream: string | undefined) {
  const remoteOut = await runGit(cwd, ["remote", "-v"]);
  if (!remoteOut) {
    return [];
  }

  const urls = new Map<string, string>();
  for (const line of remoteOut.split("\n")) {
    const [name, rest] = line.split("\t");
    if (!name || !rest) continue;
    if (!urls.has(name)) {
      urls.set(name, rest.replace(/\s+\(\w+\)$/, ""));
    }
  }

  const detached = !branch || branch === "(detached)";
  return Promise.all(
    [...urls].map(async ([name, url]) => {
      if (detached) {
        return { name, url, upstream: false };
      }

      const ref = `${name}/${branch}`;
      // The branch may simply not exist on this remote yet; that is "unpublished",
      // not an error, and rev-list would fail on the missing ref.
      const exists = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]);
      if (!exists) {
        return { name, url, upstream: upstream?.startsWith(`${name}/`) === true };
      }

      const counts = await countAgainstRef(cwd, ref);
      return {
        name,
        url,
        ref,
        ahead: counts?.ahead,
        behind: counts?.behind,
        upstream: upstream === ref,
      };
    }),
  );
}

/**
 * Machine state for the drawer, the phone sheet and the agent tool.
 *
 * The pid map is what makes the answer Panda's rather than Activity Monitor's:
 * every live section's root process is handed to the probe, which walks each
 * process up its parent chain, so the `node` at 300% CPU is reported as the
 * section that started it. The Codex app-server is deliberately absent — one
 * process serves every Codex section, so naming one of them would be a lie.
 */
async function readMachineStats(force = false): Promise<MachineStats> {
  return collectMachineStats({ ownerPids: sectionOwnerPids(), force });
}

function sectionOwnerPids(): Map<number, string> {
  const ownerPids = new Map<number, string>();
  for (const [id, session] of sessions) {
    if (typeof session.pid === "number") ownerPids.set(session.pid, id);
  }
  for (const [id, session] of streamSessions) {
    if (typeof session.process.pid === "number") ownerPids.set(session.process.pid, id);
  }
  return ownerPids;
}

/**
 * The drawer's "stop every command" — free the machine without ending a section.
 *
 * SIGKILL rather than SIGTERM because this is the button someone presses when
 * the box is already swapping and a build is ignoring polite requests; the
 * agent waiting on it sees a killed command and reports it, which is the honest
 * outcome. Targets are resolved from a fresh `ps` inside the probe, so nothing
 * here can signal a pid that is not currently a section's own child.
 */
async function killSectionCommands(request: KillSectionCommandsRequest): Promise<KillSectionCommandsResult> {
  const targets = await resolveSectionKillTargets(sectionOwnerPids(), request?.pids);
  const names: string[] = [];
  let killed = 0;
  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGKILL");
      killed += 1;
      if (!names.includes(target.name)) names.push(target.name);
    } catch {
      // Already gone between the read and the signal — the outcome we wanted.
    }
  }
  logMain("machine:kill-commands", { requested: request?.pids?.length ?? "all", killed });
  return { killed, names };
}

async function loadWorkspaceGitStatus(cwd: string): Promise<WorkspaceGitStatus> {
  const base: WorkspaceGitStatus = {
    isRepo: false,
    remotes: [],
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

  const [statusOut, stashOut, worktreeOut, branchOut, upstreamOut, gitDirOut] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v1", "--branch"]),
    runGit(cwd, ["stash", "list"]),
    runGit(cwd, ["worktree", "list", "--porcelain"]),
    runGit(cwd, ["branch", "--format=%(HEAD)%(refname:short)"]),
    runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    runGit(cwd, ["rev-parse", "--git-dir"]),
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

  const upstream = upstreamOut?.trim() || undefined;
  const remotes = await loadRemotes(cwd, branch, upstream);
  const lastFetchAt = lastFetchTime(cwd, gitDirOut?.trim() || undefined);

  return {
    isRepo: true,
    branch,
    ahead,
    behind,
    upstream,
    remotes,
    lastFetchAt,
    changes,
    stashes,
    worktrees,
    branches,
    folders,
  };
}

// ---------------------------------------------------------------------------
// Commit history
// ---------------------------------------------------------------------------

/** Page size when the caller doesn't say, and the ceiling when it asks for too much. */
const GIT_LOG_PAGE = 50;
const GIT_LOG_PAGE_MAX = 200;

/**
 * One page of `git log`, newest first.
 *
 * Fields are separated by US (0x1f) and records by RS (0x1e) so a subject
 * containing tabs, newlines or the word "commit" can't be mistaken for
 * structure. One extra commit is asked for beyond the page and then dropped:
 * that is what tells the caller whether a "load more" is worth offering,
 * without paying for a full `rev-list --count` of the repo.
 */
async function loadWorkspaceGitLog(request: WorkspaceGitLogRequest): Promise<WorkspaceGitLog> {
  const cwd = request?.cwd;
  const skip = Math.max(0, Math.floor(Number(request?.skip) || 0));
  const requested = Math.floor(Number(request?.limit) || GIT_LOG_PAGE);
  const limit = Math.min(Math.max(requested, 1), GIT_LOG_PAGE_MAX);
  const base: WorkspaceGitLog = { isRepo: false, commits: [], skip, hasMore: false };

  if (typeof cwd !== "string" || !cwd) {
    return { ...base, error: "No workspace path" };
  }

  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside === null || inside.trim() !== "true") {
    return { ...base, error: "Not a git repository" };
  }

  const [logOut, branchOut] = await Promise.all([
    runGit(cwd, [
      "log",
      `--skip=${skip}`,
      `--max-count=${limit + 1}`,
      "--date=iso-strict",
      "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s%x1e",
    ]),
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  if (logOut === null) {
    // An empty repo has no HEAD to log — that is a state, not a failure.
    return { ...base, isRepo: true, error: "No commits yet" };
  }

  const commits: WorkspaceGitCommit[] = [];
  for (const record of logOut.split("\x1e")) {
    const line = record.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [hash, shortHash, author, date, refs, ...subject] = line.split("\x1f");
    if (!hash) continue;
    commits.push({
      hash,
      shortHash: shortHash ?? hash.slice(0, 8),
      author: author ?? "",
      date: date ?? "",
      refs: (refs ?? "")
        .split(",")
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0),
      subject: subject.join("\x1f"),
    });
  }

  const hasMore = commits.length > limit;
  return {
    isRepo: true,
    branch: branchOut?.trim() || undefined,
    commits: hasMore ? commits.slice(0, limit) : commits,
    skip,
    hasMore,
  };
}

const WORKFLOW_RUN_PAGE = 10;
const WORKFLOW_RUN_MAX = 50;

/** Latest GitHub Actions runs for the repository containing `cwd`. */
async function loadWorkspaceWorkflowRuns(request: WorkspaceWorkflowRunsRequest): Promise<WorkspaceWorkflowRuns> {
  const cwd = request?.cwd;
  const requested = Math.floor(Number(request?.limit) || WORKFLOW_RUN_PAGE);
  const limit = Math.min(Math.max(requested, 1), WORKFLOW_RUN_MAX);
  const base: WorkspaceWorkflowRuns = { runs: [], limit, hasMore: false };

  if (typeof cwd !== "string" || !cwd) return { ...base, error: "No workspace path" };
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return { ...base, error: "Not a git repository" };

  const result = await runGh(cwd, [
    "run",
    "list",
    `--limit=${limit + 1}`,
    "--json=databaseId,name,displayTitle,status,conclusion,headBranch,event,createdAt,updatedAt,url",
  ]);
  if (result.error) {
    if (result.error.code === "ENOENT") {
      return { ...base, error: "GitHub CLI (gh) is not installed." };
    }
    const detail = result.stderr.trim();
    if (/auth login|authentication|not logged/i.test(detail)) {
      return { ...base, error: "Sign in to GitHub with `gh auth login`, then refresh." };
    }
    return { ...base, error: detail || "Could not load GitHub Actions runs." };
  }

  try {
    const parsed = parseWorkflowRuns(result.stdout, limit);
    return { ...parsed, limit };
  } catch {
    return { ...base, error: "GitHub CLI returned an unreadable workflow list." };
  }
}

// ---------------------------------------------------------------------------
// Workspace file tree
// ---------------------------------------------------------------------------

/** A directory with more children than this is truncated — the drawer is a browser, not a crawler. */
const TREE_ENTRY_CAP = 2_000;

/**
 * One directory's children, folders first. Read a level at a time as the user
 * expands: walking a monorepo up front would cost hundreds of thousands of
 * stats for a panel nobody has opened yet.
 */
async function loadWorkspaceTree(request: WorkspaceGitTreeRequest): Promise<WorkspaceGitTree> {
  const cwd = request?.cwd;
  const relPath = typeof request?.path === "string" ? request.path.replace(/^\/+|\/+$/g, "") : "";
  if (typeof cwd !== "string" || !cwd) {
    return { path: relPath, entries: [], error: "No workspace path" };
  }

  const root = resolve(cwd);
  const target = resolve(root, relPath);
  // The path arrives from a renderer — and, over the relay, from a phone. Refuse
  // anything that climbs out of the workspace that was trusted in the first place.
  if (target !== root && !target.startsWith(root + "/")) {
    return { path: relPath, entries: [], error: "Path is outside the workspace" };
  }

  let dirents: Dirent[];
  try {
    dirents = readdirSync(confinedPath(root, target), { withFileTypes: true });
  } catch {
    return { path: relPath, entries: [], error: "Directory unreadable" };
  }

  const names = dirents.map((entry) => entry.name).slice(0, TREE_ENTRY_CAP);
  const ignored = await gitIgnoredNames(root, relPath, names);

  const entries: WorkspaceGitTreeEntry[] = [];
  for (const dirent of dirents.slice(0, TREE_ENTRY_CAP)) {
    const childPath = relPath ? `${relPath}/${dirent.name}` : dirent.name;
    const absolutePath = join(target, dirent.name);
    const directory = dirent.isDirectory();
    let size: number | undefined;
    if (!directory) {
      try {
        size = statSync(absolutePath).size;
      } catch {
        // Broken symlink or a file that vanished mid-read — list it without a size.
      }
    }
    entries.push({
      name: dirent.name,
      path: childPath,
      absolutePath,
      kind: directory ? "directory" : "file",
      size,
      ignored: dirent.name === ".git" || ignored.has(dirent.name) ? true : undefined,
    });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    path: relPath,
    entries,
    error: dirents.length > TREE_ENTRY_CAP ? `Showing the first ${TREE_ENTRY_CAP} of ${dirents.length} entries` : undefined,
  };
}

/** Default ceiling for the in-app reader, and the hard one no request can raise. */
const TEXT_FILE_DEFAULT_BYTES = 2 * 1024 * 1024;
const TEXT_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A text file, read for the in-app reader.
 *
 * No workspace containment check here, unlike the tree: the reader opens what
 * the user clicked, and the paths that reach it are absolute ones the app
 * already put on screen (a tree entry, a file a section wrote, a link in a
 * transcript) — several of which legitimately live outside the workspace, like
 * a report an agent wrote to a temp dir. What it does refuse is everything that
 * is not a document: directories, files past the cap, and binaries, which are
 * caught by a NUL byte in the head rather than by trusting the extension.
 */
function readTextFile(request: TextFileRequest): TextFileContents {
  const path = typeof request?.path === "string" ? request.path.trim() : "";
  const name = path.split("/").filter(Boolean).at(-1) ?? "file";
  const empty: TextFileContents = { path, name, content: "", size: 0, truncated: false };
  if (!path || !isAbsolute(path)) {
    return { ...empty, error: "No file path" };
  }

  const cap = Math.min(
    typeof request?.maxBytes === "number" && request.maxBytes > 0 ? request.maxBytes : TEXT_FILE_DEFAULT_BYTES,
    TEXT_FILE_MAX_BYTES,
  );

  let size: number;
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return { ...empty, error: "That is a folder, not a file" };
    }
    size = stat.size;
  } catch {
    return { ...empty, error: "File not found" };
  }

  let buffer: Buffer;
  try {
    buffer = readBoundedFile(path, cap).bytes;
  } catch {
    return { ...empty, size, error: "File unreadable" };
  }

  // A NUL in the first few KB means this is not text. Checking the head rather
  // than the whole buffer keeps a large-but-legitimate document cheap.
  if (buffer.subarray(0, 8192).includes(0)) {
    return { ...empty, size, error: "That file is binary" };
  }

  const truncated = size > cap;
  return {
    path,
    name,
    // Slicing bytes can split a multi-byte character; `toString` replaces the
    // dangling half with U+FFFD, which is the right end for a truncated read.
    content: (truncated ? buffer.subarray(0, cap) : buffer).toString("utf8"),
    size,
    truncated,
  };
}

/**
 * Write a document back, for the reader's edit mode.
 *
 * Overwrite only: the path has to already be a file this same reader would
 * open, which makes an autosave incapable of creating anything. It also means
 * the checks that keep the reader off directories and binaries do double duty
 * here — a typo'd path fails the read and so never reaches the write.
 */
function writeTextFile(request: TextFileWriteRequest): TextFileWriteResult {
  const path = typeof request?.path === "string" ? request.path.trim() : "";
  const content = typeof request?.content === "string" ? request.content : "";
  if (!path || !isAbsolute(path)) {
    return { path, size: 0, savedAt: 0, error: "No file path" };
  }

  const existing = readTextFile({ path });
  if (existing.error) {
    return { path, size: 0, savedAt: 0, error: existing.error };
  }
  // A truncated read means the editor only ever held the head of the file;
  // saving that back would silently delete the rest.
  if (existing.truncated) {
    return { path, size: existing.size, savedAt: 0, error: "This file is too large to edit here" };
  }

  try {
    writeFileSync(path, content, "utf8");
  } catch {
    return { path, size: existing.size, savedAt: 0, error: "Could not write this file" };
  }
  return { path, size: Buffer.byteLength(content, "utf8"), savedAt: Date.now() };
}

/**
 * The same read, for a phone.
 *
 * The difference from `readTextFile` is containment, and it is not optional:
 * the desktop reader opens paths the app itself put on screen, while this one
 * takes a path off the network. The workspace has been trusted for remote
 * access; nothing above it has, so `~/.ssh/id_rsa` is refused however it is
 * spelled. Accepts either a workspace-relative path or an absolute one that
 * resolves inside the workspace, because the phone's two callers (the file tree
 * and a section's changed-file list) each have only one of those.
 */
function readRemoteTextFile(request: { cwd: string; path: string; maxBytes?: number }): TextFileContents {
  const name = request.path.split("/").at(-1) ?? "file";
  try {
    const cap = Math.min(request.maxBytes ?? TEXT_FILE_DEFAULT_BYTES, TEXT_FILE_MAX_BYTES);
    const { bytes, size, truncated } = readBoundedFile(resolve(request.cwd, request.path), cap, request.cwd);
    if (bytes.subarray(0, 8192).includes(0)) throw new Error("That file is binary.");
    return { path: request.path, name, content: bytes.toString("utf8"), size, truncated };
  } catch (error) {
    return { path: request.path, name, content: "", size: 0, truncated: false, error: error instanceof Error ? error.message : "File unreadable" };
  }
}

function writeRemoteTextFile(request: { cwd: string; path: string; content: string }): TextFileWriteResult {
  try {
    const size = writeConfinedText(request.cwd, resolve(request.cwd, request.path), request.content);
    return { path: request.path, size, savedAt: Date.now() };
  } catch (error) {
    return { path: request.path, size: 0, savedAt: 0, error: error instanceof Error ? error.message : "Could not save file" };
  }
}

/**
 * Which of these names git ignores. One `check-ignore` per expansion rather
 * than per entry; a non-repo (or a git that errors) just reports nothing
 * ignored, which is the right answer for a plain folder.
 */
async function gitIgnoredNames(root: string, relPath: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();

  const paths = names.map((name) => (relPath ? `${relPath}/${name}` : name));
  const out = await new Promise<string | null>((resolve_) => {
    const child = execFile(
      "git",
      ["check-ignore", "--stdin"],
      { cwd: root, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
      // Exit 1 means "nothing ignored", which execFile reports as an error.
      (error, stdout) => resolve_(error && !stdout ? null : stdout),
    );
    child.stdin?.end(paths.join("\n") + "\n");
  });

  if (!out) return new Set();
  const ignored = new Set<string>();
  for (const line of out.split("\n")) {
    const name = line.trim().split("/").pop();
    if (name) ignored.add(name);
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Section file changes
// ---------------------------------------------------------------------------

/** Batch size for `git … -- <pathspec>` so a long section can't blow argv. */
const GIT_PATHSPEC_BATCH = 80;

/** Untracked files are counted by hand; refuse to slurp something enormous. */
const UNTRACKED_COUNT_CAP = 4 * 1024 * 1024;

function resolveWorkspacePath(cwd: string, path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function insideRoot(root: string, absolutePath: string): boolean {
  const rel = relative(root, absolutePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function* batchedGit(cwd: string, args: string[], paths: string[]): AsyncGenerator<string> {
  for (let index = 0; index < paths.length; index += GIT_PATHSPEC_BATCH) {
    const batch = paths.slice(index, index + GIT_PATHSPEC_BATCH);
    const out = await runGit(cwd, [...args, "--", ...batch]);
    if (out) {
      yield out;
    }
  }
}

/** Lines added/removed per path, from `git diff --numstat`. */
type NumstatEntry = { added: number; removed: number; binary: boolean };
type SessionFileSnapshot = {
  updatedAt: string;
  root?: string;
  branch?: string;
  files: SessionFileChange[];
};
type SessionFileSnapshotFile = {
  version: 1;
  entries: Record<string, SessionFileSnapshot>;
};

const sessionFileSnapshotVersion = 1;
const sessionFileSnapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sessionFileSnapshots: Map<string, SessionFileSnapshot> | null = null;

function parseNumstat(output: string, into: Map<string, NumstatEntry>): void {
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const [addedRaw, removedRaw, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) {
      continue;
    }

    // Git reports binary diffs as `-\t-`, which is not "zero lines changed" —
    // it is "lines are not the unit here". Keep them apart in the UI.
    const binary = addedRaw === "-" || removedRaw === "-";
    into.set(path, {
      added: binary ? 0 : Number(addedRaw) || 0,
      removed: binary ? 0 : Number(removedRaw) || 0,
      binary,
    });
  }
}

function countLines(absolutePath: string): number {
  try {
    if (statSync(absolutePath).size > UNTRACKED_COUNT_CAP) {
      return 0;
    }

    const text = readFileSync(absolutePath, "utf8");
    if (!text) {
      return 0;
    }

    // A trailing newline terminates the last line rather than starting a new one.
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return 0;
  }
}

function sessionFileSnapshotsPath(): string {
  return join(app.getPath("userData"), "session-file-snapshots.json");
}

function readSessionFileSnapshots(): Map<string, SessionFileSnapshot> {
  if (sessionFileSnapshots) {
    return sessionFileSnapshots;
  }

  const entries = new Map<string, SessionFileSnapshot>();
  try {
    const parsed = JSON.parse(readFileSync(sessionFileSnapshotsPath(), "utf8")) as Partial<SessionFileSnapshotFile>;
    if (parsed.version === sessionFileSnapshotVersion) {
      for (const [key, value] of Object.entries(parsed.entries ?? {})) {
        if (!key || !Array.isArray(value?.files)) {
          continue;
        }
        entries.set(key, {
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
          root: typeof value.root === "string" ? value.root : undefined,
          branch: typeof value.branch === "string" ? value.branch : undefined,
          files: value.files.filter((file) => typeof file?.absolutePath === "string" && typeof file?.path === "string"),
        });
      }
    }
  } catch {
    // Missing/corrupt snapshots are non-fatal; current transcript+git state below
    // still gives the best answer available.
  }

  sessionFileSnapshots = entries;
  return entries;
}

function persistSessionFileSnapshots(): void {
  const entries = readSessionFileSnapshots();
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(
      sessionFileSnapshotsPath(),
      `${JSON.stringify({ version: sessionFileSnapshotVersion, entries: Object.fromEntries(entries) } satisfies SessionFileSnapshotFile)}\n`,
    );
  } catch (error) {
    logMain("session-files:snapshot-persist-error", { message: error instanceof Error ? error.message : String(error) });
  }
}

function sessionFileSnapshotKeys(request: Pick<SessionFileChangesRequest, "sessionId" | "claudeSessionId" | "codexThreadId">): string[] {
  return [
    request.sessionId ? `section:${request.sessionId}` : undefined,
    request.claudeSessionId ? `claude:${request.claudeSessionId}` : undefined,
    request.codexThreadId ? `codex:${request.codexThreadId}` : undefined,
  ].filter((key): key is string => Boolean(key));
}

function nonZeroChange(file: SessionFileChange): boolean {
  return file.binary === true || file.added > 0 || file.removed > 0 || file.status === "deleted" || file.status === "untracked";
}

/**
 * Join "what this section wrote" (transcript) to "how much changed" (git).
 *
 * The counts are working-tree-vs-HEAD, which is the number an operator wants
 * when deciding whether to review or revert. A file the section wrote and then
 * committed therefore reports zero — it stays in the list as `clean` rather
 * than vanishing, because "we touched this, nothing is pending" is information
 * and a silent omission is not.
 */
async function computeSessionFileChanges(request: SessionFileChangesRequest, touched: readonly string[]): Promise<SessionFileChanges> {
  const cwd = request?.cwd;
  if (typeof cwd !== "string" || !cwd) {
    return { isRepo: false, files: [], added: 0, removed: 0, error: "No workspace path" };
  }

  const absolutePaths: string[] = [];
  const seen = new Set<string>();
  for (const path of touched) {
    const absolute = resolveWorkspacePath(cwd, path);
    if (!seen.has(absolute)) {
      seen.add(absolute);
      absolutePaths.push(absolute);
    }
  }

  const rootOut = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const root = rootOut?.trim();
  if (!root) {
    // No repo: still list what the section wrote, just without line counts.
    return {
      isRepo: false,
      files: absolutePaths.map((absolutePath) => ({
        path: absolutePath,
        absolutePath,
        status: existsSync(absolutePath) ? ("clean" as const) : ("missing" as const),
        added: 0,
        removed: 0,
        exists: existsSync(absolutePath),
      })),
      added: 0,
      removed: 0,
      error: "Not a git repository",
    };
  }

  const branchOut = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchOut?.trim() || undefined;
  const tracked = absolutePaths.filter((absolutePath) => insideRoot(root, absolutePath));
  const relatives = tracked.map((absolutePath) => relative(root, absolutePath));

  const numstat = new Map<string, NumstatEntry>();
  const statusCodes = new Map<string, string>();

  if (relatives.length > 0) {
    // `diff HEAD` covers staged and unstaged in one pass. On a repo with no
    // commits yet there is no HEAD to diff against, so fall back to the index.
    const hasHead = (await runGit(root, ["rev-parse", "--verify", "HEAD"])) !== null;
    // `core.quotepath=false` keeps non-ASCII paths readable so they still match
    // the relative paths we are looking them up by.
    const quiet = ["-c", "core.quotepath=false"];
    const diffArgs = hasHead ? [...quiet, "diff", "--numstat", "HEAD"] : [...quiet, "diff", "--numstat"];
    for await (const out of batchedGit(root, diffArgs, relatives)) {
      parseNumstat(out, numstat);
    }

    for await (const out of batchedGit(root, [...quiet, "status", "--porcelain=v1"], relatives)) {
      for (const line of out.split("\n")) {
        if (line.length < 4) {
          continue;
        }
        // A rename reads `R  old -> new`; the destination is the path we track.
        const path = line.slice(3);
        const arrow = path.indexOf(" -> ");
        statusCodes.set(arrow === -1 ? path : path.slice(arrow + 4), line.slice(0, 2));
      }
    }
  }

  const files: SessionFileChange[] = absolutePaths.map((absolutePath) => {
    const exists = existsSync(absolutePath);
    if (!insideRoot(root, absolutePath)) {
      return {
        path: absolutePath,
        absolutePath,
        status: exists ? ("clean" as const) : ("missing" as const),
        added: 0,
        removed: 0,
        exists,
      };
    }

    const rel = relative(root, absolutePath);
    const stat = numstat.get(rel);
    const code = statusCodes.get(rel) ?? "";

    if (code === "??") {
      return { path: rel, absolutePath, status: "untracked", added: countLines(absolutePath), removed: 0, exists };
    }

    if (code.includes("D")) {
      return {
        path: rel,
        absolutePath,
        status: "deleted",
        added: stat?.added ?? 0,
        removed: stat?.removed ?? 0,
        binary: stat?.binary,
        exists,
      };
    }

    if (!stat) {
      return { path: rel, absolutePath, status: exists ? "clean" : "missing", added: 0, removed: 0, exists };
    }

    return {
      path: rel,
      absolutePath,
      status: code.includes("A") ? "added" : "modified",
      added: stat.added,
      removed: stat.removed,
      binary: stat.binary,
      exists,
    };
  });

  files.sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path));

  return {
    isRepo: true,
    root,
    branch,
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  };
}

function mergeSessionFileSnapshot(request: SessionFileChangesRequest, current: SessionFileChanges): SessionFileChanges {
  const snapshots = readSessionFileSnapshots();
  const snapshot = sessionFileSnapshotKeys(request)
    .map((key) => snapshots.get(key))
    .find((candidate): candidate is SessionFileSnapshot => Boolean(candidate));
  if (!snapshot) {
    return current;
  }

  const remembered = new Map(snapshot.files.map((file) => [file.absolutePath, file]));
  const files = current.files.map((file) => {
    const previous = remembered.get(file.absolutePath);
    if (!previous || nonZeroChange(file)) {
      return file;
    }
    return {
      ...file,
      added: previous.added,
      removed: previous.removed,
      binary: previous.binary,
    };
  });
  for (const previous of snapshot.files) {
    if (files.some((file) => file.absolutePath === previous.absolutePath)) {
      continue;
    }
    files.push({
      ...previous,
      status: existsSync(previous.absolutePath) ? "clean" : "missing",
      exists: existsSync(previous.absolutePath),
    });
  }

  files.sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path));
  return {
    ...current,
    root: current.root ?? snapshot.root,
    branch: current.branch ?? snapshot.branch,
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  };
}

async function loadSessionFileChanges(request: SessionFileChangesRequest): Promise<SessionFileChanges> {
  const touched = collectEditedPaths((await readIndexedConversation(request)).items);
  const current = await computeSessionFileChanges(request, touched);
  return mergeSessionFileSnapshot(request, current);
}

function storeSessionFileSnapshot(request: SessionFileChangesRequest, changes: SessionFileChanges): void {
  const keys = sessionFileSnapshotKeys(request);
  if (keys.length === 0 || changes.files.length === 0 || !changes.files.some(nonZeroChange)) {
    return;
  }

  const snapshots = readSessionFileSnapshots();
  const remembered = new Map<string, SessionFileChange>();
  for (const key of keys) {
    for (const file of snapshots.get(key)?.files ?? []) {
      remembered.set(file.absolutePath, file);
    }
  }
  for (const file of changes.files) {
    if (nonZeroChange(file)) {
      remembered.set(file.absolutePath, file);
    }
  }

  const snapshot: SessionFileSnapshot = {
    updatedAt: new Date().toISOString(),
    root: changes.root,
    branch: changes.branch,
    files: [...remembered.values()],
  };
  for (const key of keys) {
    snapshots.set(key, snapshot);
  }
  persistSessionFileSnapshots();
}

function scheduleSessionFileSnapshot(
  id: string,
  streamSession: {
    state: StreamJsonState;
    request?: { cwd?: string; claudeSessionId?: string; codexThreadId?: string };
  },
): void {
  const cwd = streamSession.request?.cwd;
  if (!cwd || sessionFileSnapshotTimers.has(id)) {
    return;
  }

  const touched = collectEditedPaths(streamSession.state.items);
  if (touched.length === 0) {
    return;
  }

  const request: SessionFileChangesRequest = {
    sessionId: id,
    cwd,
    claudeSessionId: streamSession.state.claudeSessionId ?? streamSession.request?.claudeSessionId,
    codexThreadId: streamSession.state.codexThreadId ?? streamSession.request?.codexThreadId,
  };
  const timer = setTimeout(() => {
    sessionFileSnapshotTimers.delete(id);
    void computeSessionFileChanges(request, touched)
      .then((changes) => storeSessionFileSnapshot(request, changes))
      .catch((error) =>
        logMain("session-files:snapshot-error", { id, message: error instanceof Error ? error.message : String(error) }),
      );
  }, 1_500);
  timer.unref?.();
  sessionFileSnapshotTimers.set(id, timer);
}

// ---------------------------------------------------------------------------
// External editors
// ---------------------------------------------------------------------------

type EditorDefinition = {
  id: EditorId;
  name: string;
  /** macOS bundle name, looked for in the usual install locations. */
  bundle?: string;
  /** CLI shim, used on Linux/Windows and as a macOS fallback. */
  cli?: string;
};

const EDITOR_DEFINITIONS: EditorDefinition[] = [
  { id: "cursor", name: "Cursor", bundle: "Cursor.app", cli: "cursor" },
  { id: "vscode", name: "VS Code", bundle: "Visual Studio Code.app", cli: "code" },
];

function macAppPath(bundle: string): string | null {
  const candidates = [join("/Applications", bundle), join(homedir(), "Applications", bundle)];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function cliPath(cli: string): string | null {
  const searchPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  for (const dir of searchPath.split(":")) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, cli);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function editorAvailable(definition: EditorDefinition): boolean {
  if (process.platform === "darwin" && definition.bundle && macAppPath(definition.bundle)) {
    return true;
  }

  return Boolean(definition.cli && cliPath(definition.cli));
}

function listEditors(): EditorTarget[] {
  const editors: EditorTarget[] = EDITOR_DEFINITIONS.map((definition) => ({
    id: definition.id,
    name: definition.name,
    available: editorAvailable(definition),
  }));

  // Always last, always present: the OS file manager needs no install.
  editors.push({ id: "finder", name: process.platform === "darwin" ? "Finder" : "File manager", available: true });
  return editors;
}

async function openInEditor(request: OpenInEditorRequest): Promise<boolean> {
  const target = request?.path;
  if (typeof target !== "string" || !target || !existsSync(target)) {
    return false;
  }

  if (request.editor === "finder") {
    // A file is *revealed* (selected in its parent); a folder is *opened*, since
    // revealing a project would show it selected inside the folder above it,
    // which is not what "open this project in Finder" means.
    if (statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      await shell.openPath(target);
      return true;
    }
    shell.showItemInFolder(target);
    return true;
  }

  const definition = EDITOR_DEFINITIONS.find((candidate) => candidate.id === request.editor);
  if (!definition) {
    return false;
  }

  const bundlePath = process.platform === "darwin" && definition.bundle ? macAppPath(definition.bundle) : null;
  const [command, args] = bundlePath
    ? (["open", ["-a", bundlePath, target]] as const)
    : ([definition.cli ? cliPath(definition.cli) : null, [target]] as const);

  if (!command) {
    return false;
  }

  return new Promise((resolveOpen) => {
    execFile(command, [...args], { timeout: 10_000 }, (error) => {
      if (error) {
        logMain("editor:open-error", { editor: request.editor, message: error.message });
      }
      resolveOpen(!error);
    });
  });
}

async function copyFileToClipboard(target: string): Promise<boolean> {
  if (typeof target !== "string" || !target || !existsSync(target)) {
    return false;
  }

  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(target)) {
    const image = nativeImage.createFromPath(target);
    if (!image.isEmpty()) {
      await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
      return true;
    }
  }

  // Not an image (or a gif nativeImage failed to decode): put the file itself
  // on the pasteboard, the way Finder's own Copy does, so it can be pasted as
  // a file anywhere — Finder, Mail, Slack.
  return new Promise((resolveCopy) => {
    execFile(
      "osascript",
      ["-e", `set the clipboard to (POSIX file "${target.replace(/"/g, '\\"')}")`],
      { timeout: 5_000 },
      (error) => {
        if (error) {
          logMain("clipboard:copy-file-error", { message: error.message });
        }
        resolveCopy(!error);
      },
    );
  });
}

function showAttachmentContextMenu(event: IpcMainInvokeEvent, target: string): boolean {
  if (typeof target !== "string" || !target || !isAbsolute(target) || !existsSync(target)) {
    return false;
  }

  const menu = Menu.buildFromTemplate([
    {
      label: "Reveal in Finder",
      click: () => shell.showItemInFolder(target),
    },
    {
      label: "Copy",
      click: () => void copyFileToClipboard(target),
    },
  ]);
  const window = BrowserWindow.fromWebContents(event.sender);
  menu.popup(window ? { window } : undefined);
  return true;
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
      const strikes = (usageRateLimitStrikes.claude ?? 0) + 1;
      usageRateLimitStrikes.claude = strikes;
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const cooldownMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds * 1_000, usageRateLimitCooldownMaxMs)
          : Math.min(usageRateLimitCooldownMs * 2 ** (strikes - 1), usageRateLimitCooldownMaxMs);
      usageCooldownUntil.claude = Date.now() + cooldownMs;
      logMain("usage:rate-limited", { provider: "claude", cooldownMs, strikes });
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
const codexModelsSpawnMinIntervalMs = 15 * 60_000;
let codexModelsLastSpawnAt = 0;
let codexModelsCache: CodexModel[] = [];

function codexModelsFromPayload(payload: unknown): CodexModel[] {
  const root = objectValue(payload);
  const data = Array.isArray(root?.data) ? root.data : [];
  return data.flatMap((entry): CodexModel[] => {
    const record = objectValue(entry);
    const id = stringValue(record?.id) ?? stringValue(record?.model);
    if (!id || record?.hidden === true) {
      return [];
    }
    const supportedReasoningEfforts = Array.isArray(record?.supportedReasoningEfforts)
      ? record.supportedReasoningEfforts.flatMap((effort): CodexModel["supportedReasoningEfforts"] => {
          const effortRecord = objectValue(effort);
          const value = stringValue(effortRecord?.reasoningEffort) ?? stringValue(effortRecord?.value);
          return value ? [{ value, description: stringValue(effortRecord?.description) ?? value }] : [];
        })
      : [];
    return [{
      id,
      displayName: stringValue(record?.displayName) ?? id,
      description: stringValue(record?.description) ?? "",
      supportedReasoningEfforts,
      defaultReasoningEffort: stringValue(record?.defaultReasoningEffort),
      isDefault: record?.isDefault === true,
    }];
  });
}

async function readCodexModelsViaAppServer(): Promise<CodexModel[]> {
  const shared = await codexAppServerManager.listModels(codexUsageTimeoutMs);
  if (shared !== null) {
    const models = codexModelsFromPayload(shared);
    if (models.length > 0) {
      codexModelsCache = models;
      return models;
    }
  }

  if (codexModelsCache.length > 0 && Date.now() - codexModelsLastSpawnAt < codexModelsSpawnMinIntervalMs) {
    return codexModelsCache;
  }
  const now = Date.now();
  if (now - codexModelsLastSpawnAt < codexModelsSpawnMinIntervalMs) {
    return codexModelsCache;
  }
  codexModelsLastSpawnAt = now;
  const client = new CodexAppServerClient({
    spawn: () => spawnChild("codex", ["app-server"], { cwd: app.getPath("home"), env: ptyEnvironment() }),
    clientInfo: { name: "panda_code", title: "Panda Code", version: app.getVersion() },
    logMain,
  });
  try {
    await client.start();
    const models = codexModelsFromPayload(await client.request("model/list", {}, { timeoutMs: codexUsageTimeoutMs }));
    if (models.length > 0) {
      codexModelsCache = models;
    }
    return codexModelsCache;
  } finally {
    client.dispose();
  }
}

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
    delete usageRateLimitStrikes[provider];
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

async function loadUsageSnapshot(provider: UsageProvider, force = false): Promise<UsageSnapshot | null> {
  const cached = usageCache[provider];
  const now = Date.now();

  const cooldownUntil = usageCooldownUntil[provider] ?? 0;
  if (now < cooldownUntil) {
    const minutes = Math.max(1, Math.round((cooldownUntil - now) / 60_000));
    const reason = `Rate-limited by the usage API. Retrying in ${minutes}m.`;
    // Keep the reason current as the cooldown counts down — the cached snapshot
    // still carries the minutes figure from when the 429 landed.
    const fallback = withStaleFallback(provider, usageUnavailable(provider, reason));
    return fallback ?? cached?.snapshot ?? usageUnavailable(provider, reason);
  }

  // Background callers get one real request per provider per
  // usageMinFetchIntervalMs; a refresh the user clicked gets a shorter floor so
  // the button visibly does something. Neither can bypass the cooldown above.
  const minInterval = force ? usageForcedMinFetchIntervalMs : usageMinFetchIntervalMs;
  if (cached && now - cached.fetchedAtMs < minInterval) {
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
async function loadUsageBundle(force = false): Promise<UsageBundle> {
  const [claude, codex] = await Promise.all([
    loadUsageSnapshot("claude", force).catch(() => null),
    loadUsageSnapshot("codex", force).catch(() => null),
  ]);
  return { claude, codex };
}

const TRAY_ICON_1X =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJklEQVR4nGNgGAXYwH8optiAUUNQDRgGmv9jwXgNwGUoVWKGugAAR5kg4LS6Mh4AAAAASUVORK5CYII=";
const TRAY_ICON_2X =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAARUlEQVR4nO3TMQoAMAjAQP//6XYvlFIEDZKAs+dghJnZu3WMgHJIOwADaQdgIO0ADAQHKM/LvRy3+PaWaTgG8AudA7DZbXKKg30awljvAAAAAElFTkSuQmCC";

/**
 * Relay URL a fresh install starts with. Empty in a downloaded build, which is
 * the whole point: pairing is opt-in and means running your own deployment.
 * Only ever a seed — once the preference exists, the preference wins.
 */
const SEED_RELAY_URL = (process.env.PANDA_CODE_RELAY_URL?.trim() || "").replace(/\/+$/, "");

/** Empty (pairing off) or an absolute http(s) URL; anything else is not a relay. */
function sanitizeRelayUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : "";
}

const DEFAULT_PREFERENCES: AppPreferences = {
  quickStartShortcut: "",
  hideDockIcon: false,
  notificationsPaused: false,
  remoteKeepAwake: "off",
  conserveMode: false,
  preferredEditor: "cursor",
  relayUrl: SEED_RELAY_URL,
  dictationLocale: DICTATION_FALLBACK_LOCALE,
  // Deliberately conservative defaults: the machine this was written on has 8 GB
  // and was 4.8 GB into swap with 21 live sections. Someone on a bigger box
  // raises them in Settings; nobody has to discover the problem first.
  maxLiveSessions: 6,
  idleSessionTimeoutMinutes: 30,
  transcriptWindowSize: 2000,
  retainedTranscripts: 12,
};

/** Clamp a preference that must be a non-negative whole number (0 = disabled). */
function sanitizeCount(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), 0), max);
}

let appPreferences: AppPreferences = { ...DEFAULT_PREFERENCES };
let tray: Tray | null = null;
let currentBadgeCount = 0;

function preferencesPath(): string {
  return join(app.getPath("userData"), "app-preferences.json");
}

function groqApiKeyPath(): string {
  return join(app.getPath("userData"), "groq-api-key");
}

function readGroqApiKey(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(readFileSync(groqApiKeyPath()));
  } catch {
    return null;
  }
}

function writeGroqApiKey(value: string): boolean {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    if (!value.trim()) {
      if (existsSync(groqApiKeyPath())) unlinkSync(groqApiKeyPath());
      return true;
    }
    if (!safeStorage.isEncryptionAvailable()) return false;
    writeFileSync(groqApiKeyPath(), safeStorage.encryptString(value.trim()));
    return true;
  } catch (error) {
    logMain("groq:key-write-error", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function listGroqModels(): Promise<GroqModel[]> {
  const apiKey = readGroqApiKey();
  if (!apiKey) return [];
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: Array<{ id?: string; owned_by?: string }> };
    return (payload.data ?? []).flatMap((model) => {
      const id = model.id?.trim();
      return id ? [{ id, displayName: id, description: model.owned_by ? `Provided by ${model.owned_by}` : "Groq model" }] : [];
    });
  } catch {
    return [];
  }
}

function conserveSettingsPath(): string {
  return join(app.getPath("userData"), "trim-settings.json");
}

function conserveTrimLogPath(): string {
  return join(app.getPath("userData"), "trim-log.jsonl");
}

/**
 * Writes (or overwrites) the `--settings` file conserve mode passes to
 * `claude`, wiring conserve mode's PreToolUse hook in additively alongside
 * the user's own `~/.claude/settings.json`. Returns the settings file's path.
 */
function ensureConserveSettingsFile(): string {
  const paths = trimResourcePaths(app.isPackaged, __dirname, process.resourcesPath);
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `PANDA_TRIM_RUN='${paths.runScript}' PANDA_TRIM_LOG='${conserveTrimLogPath()}' node '${paths.hookScript}'`,
            },
          ],
        },
      ],
    },
  };

  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(conserveSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  return conserveSettingsPath();
}

let dictationHostInstance: DictationHost | null = null;

/**
 * The speech helper, built on first use.
 *
 * One per app rather than per session: it owns the microphone, so two live
 * recognisers would fight over it.
 */
function dictationHost(): DictationHost {
  if (!dictationHostInstance) {
    const paths = dictationResourcePaths(app.isPackaged, __dirname, process.resourcesPath);
    dictationHostInstance = new DictationHost(
      paths.binary,
      paths.vocabulary,
      (event) => sendToRendererWindows("dictation:event", event),
      logMain,
    );
  }
  return dictationHostInstance;
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
  const preferredEditor =
    value.preferredEditor === "vscode" || value.preferredEditor === "finder" ? value.preferredEditor : "cursor";
  // Absent (an install from before this was a setting, or a first run) seeds
  // from the build; present — including deliberately emptied — is authoritative.
  const relayUrl = typeof value.relayUrl === "string" ? sanitizeRelayUrl(value.relayUrl) : SEED_RELAY_URL;
  return {
    ...DEFAULT_PREFERENCES,
    ...value,
    ...(value.notificationChannels ? { notificationChannels: normalizeNotificationChannels(value.notificationChannels) } : {}),
    remoteKeepAwake,
    conserveMode: value.conserveMode === true,
    preferredEditor,
    relayUrl,
    remoteAllowFullAccess: value.remoteAllowFullAccess === true,
    dictationLocale: normalizeDictationLocale(value.dictationLocale),
    maxLiveSessions: sanitizeCount(value.maxLiveSessions, DEFAULT_PREFERENCES.maxLiveSessions, 64),
    idleSessionTimeoutMinutes: sanitizeCount(
      value.idleSessionTimeoutMinutes,
      DEFAULT_PREFERENCES.idleSessionTimeoutMinutes,
      24 * 60,
    ),
    transcriptWindowSize: sanitizeCount(
      value.transcriptWindowSize,
      DEFAULT_PREFERENCES.transcriptWindowSize,
      100_000,
    ),
    retainedTranscripts: sanitizeCount(value.retainedTranscripts, DEFAULT_PREFERENCES.retainedTranscripts, 500),
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

let mainWindowInstance: BrowserWindow | null = null;

/**
 * The app window, as opposed to any other window the app happens to own.
 *
 * The floating browser is a `BrowserWindow` too, so "the first window that is
 * not destroyed" is not the app — with the browser detached and the main window
 * closed, that guess returns the browser, and everything routed through it (the
 * tray, the quick-start shortcut, `app:focus`) lands somewhere that has no
 * listener for it and silently does nothing.
 */
function liveMainWindow(): BrowserWindow | null {
  return mainWindowInstance && !mainWindowInstance.isDestroyed() ? mainWindowInstance : null;
}

function focusMainWindow(): BrowserWindow | null {
  let targetWindow = liveMainWindow();
  if (!targetWindow) {
    // The window can be gone entirely (closed while the Dock icon is hidden);
    // recreate it so the tray and shortcut can always bring Panda Code back.
    // Note this asks for the MAIN window specifically: the floating browser is
    // also a window, and "any open window" used to be enough to make the tray
    // and the quick-start shortcut believe the app was still on screen.
    createWindow();
    targetWindow = liveMainWindow();
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

const attentionLastShown = new Map<string, number>();

async function showAgentAttention(request: PeerAttentionRequest): Promise<{ ok: boolean; message: string }> {
  const threadId = request.from?.trim() ?? "";
  const summary = request.summary?.trim() ?? "";
  if (!threadId || !summary) return { ok: false, message: "An attention request needs its source section and a summary." };
  if (summary.length > 240) return { ok: false, message: "Keep the attention TL;DR under 240 characters." };
  if ((request.detail?.length ?? 0) > 800) return { ok: false, message: "Keep attention details under 800 characters." };

  const thread = readStoredThreads().find((candidate) => candidate.id === threadId && sameWorkspace(candidate.cwd, request.cwd ?? ""));
  if (!thread) return { ok: false, message: "The requesting section is not open in this workspace." };
  if (!agentAttentionAllowed(appPreferences.notificationChannels, threadId, appPreferences.notificationsPaused, request.userRequested === true)) {
    return { ok: false, message: "Agent attention is disabled for this section. Continue without interrupting. Only an explicit user request permits userRequested/--user-requested." };
  }
  const choices = (Array.isArray(request.choices) ? request.choices : []).slice(0, 3).flatMap((choice) => {
    const label = typeof choice?.label === "string" ? choice.label.trim().slice(0, 40) : "";
    const response = typeof choice?.response === "string" ? choice.response.trim().slice(0, 500) : "";
    return label && response ? [{ label, response }] : [];
  });
  const now = Date.now();
  if (now - (attentionLastShown.get(threadId) ?? 0) < 30_000) {
    return { ok: false, message: "An attention request from this section was already shown in the last 30 seconds." };
  }
  attentionLastShown.set(threadId, now);
  const event = {
    id: `${threadId}:${now}`,
    threadId,
    threadTitle: thread.title || "Untitled section",
    summary,
    detail: request.detail?.trim() || undefined,
    severity: request.severity === "important" ? "important" as const : "urgent" as const,
    choices,
    createdAt: new Date(now).toISOString(),
  };
  const target = focusMainWindow();
  if (!target) return { ok: false, message: "Panda Code could not open its main window." };
  const send = (): void => target.webContents.send("agent:attention", event);
  if (target.webContents.isLoading()) target.webContents.once("did-finish-load", send);
  else send();
  return { ok: true, message: `Raised an urgent attention request for "${thread.title || "Untitled section"}". Stop and wait for the user's response.` };
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
  const previousRelayUrl = appPreferences.relayUrl;
  appPreferences = normalizePreferences({ ...appPreferences, ...patch });
  persistPreferences();

  if (appPreferences.relayUrl !== previousRelayUrl) {
    // Reconnect in place. Requiring a relaunch here is how a wrong URL turns
    // into "it just doesn't work" — the bridge reports its new state through the
    // pairing panel instead.
    logMain("remote:url-changed", { configured: Boolean(appPreferences.relayUrl) });
    remoteBridge?.setUrl(appPreferences.relayUrl || undefined);
  }

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

/**
 * Popups opened by a page in the built-in browser.
 *
 * A social login is not a link — it is `window.open`, and the opened window
 * talks back to the page that opened it (`window.opener.postMessage`, then
 * `window.close()`). Routing it to a new tab, or to the system browser, severs
 * that link and the flow hangs on a spinner forever. So we let Chromium make a
 * real child window, which keeps the opener relationship and the session
 * (a popup inherits its opener's partition, so it is signed in the same way),
 * and only override how it looks: a plain window, sized like a real popup.
 *
 * These windows are the human's, not the agent's — they are not tabs, so no
 * browser tool can drive one. That is the right split: the popup is where the
 * user types a password we must never touch.
 *
 * Applied to every `<webview>` the host window attaches, and to the popup's own
 * descendants, since consent screens routinely open one more.
 */
function wireGuestPopups(host: Electron.WebContents): void {
  const wire = (contents: Electron.WebContents): void => {
    configureBrowserPermissions(contents.session);
    contents.on("will-navigate", (event, url) => { if (!browserUrlAllowed(url)) event.preventDefault(); });
    contents.on("will-redirect", (event, url) => { if (!browserUrlAllowed(url)) event.preventDefault(); });
    contents.setWindowOpenHandler(({ url, frameName }) => {
      if (url !== "about:blank" && !browserUrlAllowed(url)) return { action: "deny" };
      logMain("browser-popup-open", { url: url.slice(0, 200), frameName });
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          minWidth: 360,
          minHeight: 360,
          title: "Panda Code — Browser",
          backgroundColor: "#111318",
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    });
    contents.on("did-create-window", (child) => {
      wire(child.webContents);
    });
  };

  host.on("did-attach-webview", (_event, guest) => wire(guest));
}

/**
 * Strip node access off every guest page a window attaches, and log what it was
 * handed.
 *
 * The renderer already asks for a partitioned, isolated webview, but the
 * renderer is the thing loading arbitrary web content — so main enforces it
 * rather than trusting the attributes it was given.
 *
 * `host` names which window is attaching, because the two hosts are not
 * interchangeable when something goes wrong: a guest that misbehaves only in
 * the detached window is a different bug from one that misbehaves in the dock.
 * This used to be two copies of the same block and only the main window's was
 * logged, which left the detached window unobservable exactly when it broke.
 */
function hardenGuests(window: BrowserWindow, host: "main" | "floating"): void {
  window.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (typeof params.src !== "string" || !browserUrlAllowed(params.src)) _event.preventDefault();
    logMain("browser-webview-attach", {
      host,
      src: typeof params.src === "string" ? params.src : undefined,
    });
  });
  wireGuestPopups(window.webContents);
}

let browserWindowInstance: BrowserWindow | null = null;

/**
 * The detached browser window.
 *
 * Same renderer bundle, entered with `?view=browser`, which renders the browser
 * on its own instead of the whole app. It hosts the guest pages while it is
 * open — a page can only live in one window, so the docked panel steps aside for
 * the duration (see `BrowserService.setFloating`).
 *
 * It shows EVERY section's tabs, grouped by section, which is also the place to
 * see which thread a page belongs to and jump to it.
 */
function openFloatingBrowser(): void {
  if (browserWindowInstance && !browserWindowInstance.isDestroyed()) {
    browserWindowInstance.show();
    browserWindowInstance.focus();
    return;
  }

  const floating = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 520,
    minHeight: 420,
    title: "Panda Code — Browser",
    backgroundColor: "#111318",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  browserWindowInstance = floating;

  floating.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrlAllowed(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  floating.webContents.on("will-navigate", (event, url) => { if (!trustedAppUrl(url)) event.preventDefault(); });
  hardenGuests(floating, "floating");

  // The window has been seen showing the wrong document entirely — blank, with
  // the renderer's own JS bundle rendered as text. Nothing in the log said so,
  // because the only signal was the pixels. These three say what it was asked
  // to load, whether that load failed, and whether its renderer died, so the
  // next occurrence is diagnosable from the log alone.
  floating.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logMain("browser-window-load-failed", { errorCode, errorDescription, url: validatedURL, isMainFrame });
  });
  floating.webContents.on("render-process-gone", (_event, details) => {
    logMain("browser-window-renderer-gone", { reason: details.reason, exitCode: details.exitCode });
  });
  floating.webContents.on("did-finish-load", () => {
    logMain("browser-window-loaded", { url: floating.webContents.getURL() });
  });

  const devServerUrl = rendererUrl();
  if (devServerUrl) {
    logMain("browser-window-loading", { mode: "dev", url: `${devServerUrl}?view=browser` });
    void floating.loadURL(`${devServerUrl}?view=browser`);
  } else {
    const file = join(__dirname, "../renderer/index.html");
    logMain("browser-window-loading", { mode: "file", url: file });
    void floating.loadFile(file, { query: { view: "browser" } });
  }

  // Closing the window hands the pages back to the docked panel rather than
  // losing them: the tabs still exist, they just need a host again.
  floating.on("closed", () => {
    browserWindowInstance = null;
    browserService().setFloating(false);
  });

  browserService().setFloating(true);
  logMain("browser-window-opened", {});
}

function closeFloatingBrowser(): void {
  if (browserWindowInstance && !browserWindowInstance.isDestroyed()) {
    // The `closed` handler is what returns the pages to the dock.
    browserWindowInstance.close();
    return;
  }
  browserService().setFloating(false);
}

/**
 * The right-click menu on plain text, in every window and every guest page.
 *
 * Electron ships no context menu of its own, so without this a right-click on
 * a transcript, a composer or a web page does nothing at all. The UI's own
 * menus (a session row, a workspace, a board card) call `preventDefault` on the
 * DOM event, which stops the renderer from ever asking for this one — so the
 * two never fight over the same click.
 *
 * The items are built from what was actually clicked: an editable field gets
 * the full edit set and its spelling suggestions, a selection gets Copy, a link
 * gets its own pair.
 */
function attachTextContextMenu(contents: Electron.WebContents): void {
  contents.on("context-menu", (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];

    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      template.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (template.length > 0) {
      template.push({ type: "separator" });
    }

    if (params.linkURL) {
      template.push(
        { label: "Open Link in Browser", click: () => { if (externalUrlAllowed(params.linkURL)) void shell.openExternal(params.linkURL); } },
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }

    const hasSelection = params.selectionText.trim().length > 0;
    if (params.isEditable) {
      template.push(
        { label: "Cut", role: "cut", enabled: hasSelection && params.editFlags.canCut },
        { label: "Copy", role: "copy", enabled: hasSelection && params.editFlags.canCopy },
        { label: "Paste", role: "paste", enabled: params.editFlags.canPaste },
        { label: "Paste and Match Style", role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { label: "Select All", role: "selectAll" },
      );
    } else if (hasSelection) {
      template.push(
        { label: "Copy", role: "copy" },
        {
          label: "Search with Google",
          click: () =>
            void shell.openExternal(
              `https://www.google.com/search?q=${encodeURIComponent(params.selectionText.trim().slice(0, 400))}`,
            ),
        },
        { type: "separator" },
        { label: "Select All", role: "selectAll" },
      );
    }

    // Nothing worth offering — a right-click on empty chrome shouldn't pop an
    // empty box.
    while (template.length > 0 && template[template.length - 1]?.type === "separator") {
      template.pop();
    }
    if (template.length === 0) {
      return;
    }

    const window = BrowserWindow.fromWebContents(contents);
    const menu = Menu.buildFromTemplate(template);
    if (window) {
      menu.popup({ window });
    } else {
      menu.popup();
    }
  });
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
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The built-in browser's pages live in `<webview>` guests inside the
      // renderer, so the panel can lay out, clip and stack like any other part
      // of the UI. Guests get no preload and no node access — see below.
      webviewTag: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrlAllowed(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Belt and braces on the guest pages — see `hardenGuests`.
  mainWindow.webContents.on("will-navigate", (event, url) => { if (!trustedAppUrl(url)) event.preventDefault(); });
  hardenGuests(mainWindow, "main");

  const devServerUrl = rendererUrl();
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindowInstance = mainWindow;
  mainWindow.on("closed", () => {
    if (mainWindowInstance === mainWindow) {
      mainWindowInstance = null;
    }
  });
}

function stopAllSessions(): void {
  streamSnapshotThrottle.clear();
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

  void transcriptIndexInstance?.close();
  transcriptIndexInstance = undefined;

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
    command: thread.command?.trim() || (runtime === "codex" ? defaultCodexCommand : runtime === "groq" ? "groq" : defaultCommand),
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

/**
 * Open a section on behalf of another section (see `peerMessaging.ts`).
 *
 * Deliberately the same path a phone-started session takes: `startSession`
 * emits `session:started`, and the renderer materializes a thread for any id it
 * has never seen — which is what puts the new section in the sidebar and, from
 * there, into `threads.json` and the relay. Nothing here talks to the window
 * directly, so a section can be opened while the UI is busy or closed.
 */
async function openPeerSection(spec: PeerSectionSpec): Promise<{ ok: boolean; id?: string; message?: string }> {
  if (!existsSync(spec.cwd)) {
    return { ok: false, message: "Workspace folder does not exist." };
  }

  const id = randomUUID();
  const result = sessionService.startSession({
    id,
    cwd: spec.cwd,
    command: spec.runtime === "codex" ? defaultCodexCommand : spec.runtime === "groq" ? "groq" : defaultCommand,
    runtime: spec.runtime,
    model: spec.model,
    effort: spec.effort,
    permissionMode: spec.permissionMode,
    executionMode: "stream-json",
    cols: 100,
    rows: 30,
    // Rides the start request so the renderer materializes the new section
    // already nested (see `SessionStartRequest.parentId`) — the alternative, a
    // follow-up message, lands after the sidebar has drawn it at top level and
    // makes the tree visibly reshuffle a beat later.
    parentId: spec.parentId,
  });
  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  // Provisional: the runtime replaces it with a generated title after the first
  // turn, exactly as it would for a section the user opened by hand. Sent after
  // the start so the thread the renderer just materialized exists to receive it.
  if (spec.title) {
    sendToLiveWindows("session:title", { id, title: spec.title });
  }

  return { ok: true, id };
}

let browserServiceInstance: BrowserService | null = null;
let browserAuditInstance: BrowserAudit | null = null;
const pendingBrowserCaptureStages = new Map<
  string,
  { webContentsId: number; resolve: (ready: boolean) => void }
>();
let browserCaptureStageTail: Promise<void> = Promise.resolve();

/**
 * Put the existing live guest on a rasterable surface without switching the
 * user's section or opening/focusing a window. The hosting renderer applies a
 * nearly-transparent in-viewport stage and acknowledges after two frames.
 */
async function stageBrowserCapture(tabId: string): Promise<(() => void) | undefined> {
  const previousStage = browserCaptureStageTail;
  let unlockStage = (): void => {};
  browserCaptureStageTail = previousStage.then(
    () =>
      new Promise<void>((resolve) => {
        unlockStage = resolve;
      }),
  );
  await previousStage;

  const floating = browserService().state().floating;
  const host = floating ? browserWindowInstance : mainWindowInstance;
  if (!host || host.isDestroyed() || host.webContents.isDestroyed()) {
    unlockStage();
    return undefined;
  }

  const requestId = randomUUID();
  host.webContents.setBackgroundThrottling(false);
  const staged = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      pendingBrowserCaptureStages.delete(requestId);
      resolve(false);
    }, 1_500);
    timeout.unref();
    pendingBrowserCaptureStages.set(requestId, {
      webContentsId: host.webContents.id,
      resolve: (ready) => {
        clearTimeout(timeout);
        resolve(ready);
      },
    });
    host.webContents.send("browser:capture-stage", { requestId, tabId });
  });
  pendingBrowserCaptureStages.delete(requestId);

  const release = (): void => {
    if (!host.isDestroyed() && !host.webContents.isDestroyed()) {
      host.webContents.send("browser:capture-release", { requestId });
      host.webContents.setBackgroundThrottling(true);
    }
    unlockStage();
  };
  if (!staged) {
    release();
    return undefined;
  }

  return release;
}
/**
 * The section the user is looking at, as last reported by the renderer.
 *
 * Tabs belong to sections, and an agent's own section id scopes its calls. A
 * shell caller (`panda-peers browser …` typed into a terminal) has no section,
 * so it acts on the one in front of the user — which is what a person typing
 * that command means.
 */
let activeThreadId: string | undefined;

/**
 * The built-in browser, created on first use.
 *
 * Lazy because it needs `app.getPath`, and because a run of the app that never
 * opens a page should not pay for it. Everything below — the IPC the panel
 * talks over, and the socket op the agents' `browser_*` tools land on — shares
 * this one instance, which is the whole point: one browser, two drivers.
 */
/** Where the built-in browser writes screenshots and recordings — shared by `browserService()` and the phone's on-demand `media` fetch. */
function browserShotsDir(): string {
  return join(app.getPath("userData"), "browser-shots");
}

function browserService(): BrowserService {
  if (!browserServiceInstance) {
    const audit = createBrowserAudit({ path: join(app.getPath("userData"), "browser-activity.jsonl"), log: logMain });
    browserAuditInstance = audit;
    browserServiceInstance = createBrowserService({
      broadcast: (state) => sendToRendererWindows("browser:state", state),
      broadcastActivity: (record) => sendToRendererWindows("browser:activity", record),
      revealPanel: (threadId) => sendToRendererWindows("browser:reveal", { threadId }),
      stageCapture: stageBrowserCapture,
      sectionTitle: (id) => readStoredThreads().find((thread) => thread.id === id)?.title,
      // The one place `electron` meets the service: everything else about a
      // guest page is described structurally, so the service stays testable.
      contentsById: (id) => (webContents.fromId(id) as unknown as GuestContents | undefined) ?? undefined,
      screenshotDir: browserShotsDir(),
      audit: (record) => audit.append(record),
      activity: (limit) => audit.recent(limit),
      encodeVideo: encodeBrowserRecording,
      log: logMain,
    });
  }
  return browserServiceInstance;
}

/** Ceiling on a screenshot's long edge before it is handed to a phone — a raw
 * retina capture is several MB; nothing about reading it on a 6" screen needs
 * that resolution. A recording's mp4 already went through its own encoder, so
 * it passes through untouched. */
const MEDIA_SCREENSHOT_MAX_EDGE = 1600;
const MEDIA_SCREENSHOT_JPEG_QUALITY = 82;

/**
 * Read one capture off disk for a phone-issued `media` command.
 *
 * `path` is untrusted: it round-trips through the relay from text a phone
 * regexed out of a tool result (or a backlog card's attachment record), so the
 * only thing trusted about it is that it resolves inside one of the two
 * directories this app itself writes captures to — the browser's shots
 * directory, and the backlog's attachments directory (where
 * `attachBacklogFile` copies a card's evidence). Same containment rule
 * `loadRemoteFile`/`writeRemoteFile` apply to a workspace, just anchored to
 * fixed directories instead of a trusted-workspace allowlist.
 */
async function readBrowserMediaFile(request: { path: string }): Promise<{ mimeType: string; bytes: Buffer }> {
  const allowedRoots = [browserShotsDir(), join(backlogDirectory(), "attachments")];
  const resolved = resolve(request.path);
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + sep))) {
    throw new Error("That path is not inside a Panda Code capture directory.");
  }
  const root = allowedRoots.find((candidate) => resolved === candidate || resolved.startsWith(candidate + sep))!;
  const media = readBoundedFile(resolved, 8 * 1024 * 1024, root);
  if (media.truncated) throw new Error("This capture exceeds the 8 MiB transfer limit.");

  // Every raster format the backlog accepts as an image attachment, except
  // gif: nativeImage flattens a gif to its first frame, and a still of an
  // animation is worse than the bytes as they are.
  if (/\.(png|jpe?g|webp)$/i.test(resolved)) {
    const image = nativeImage.createFromBuffer(media.bytes);
    const { width, height } = image.getSize();
    const longEdge = Math.max(width, height, 1);
    const scale = Math.min(1, MEDIA_SCREENSHOT_MAX_EDGE / longEdge);
    const shrunk =
      scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : image;
    return { mimeType: "image/jpeg", bytes: shrunk.toJPEG(MEDIA_SCREENSHOT_JPEG_QUALITY) };
  }
  if (/\.gif$/i.test(resolved)) {
    return { mimeType: "image/gif", bytes: media.bytes };
  }
  const video = /\.(mp4|mov|webm)$/i.exec(resolved)?.[1]?.toLowerCase();
  if (video) {
    const mimeType = video === "webm" ? "video/webm" : video === "mov" ? "video/quicktime" : "video/mp4";
    return { mimeType, bytes: media.bytes };
  }
  throw new Error("Only images (png, jpg, webp, gif) and recordings (mp4, mov, webm) can be fetched this way.");
}

/**
 * Turn a recording's frames into an mp4, if this machine can.
 *
 * ffmpeg is not ours to ship — it is a large binary with its own licensing —
 * so this uses the user's, and says so plainly when there is none rather than
 * failing the recording. The frames are the real artefact either way; the video
 * is the convenient form of it.
 */
async function encodeBrowserRecording(request: {
  framesDir: string;
  outPath: string;
  fps: number;
}): Promise<{ ok: boolean; message: string }> {
  const candidates = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
  const ffmpeg = candidates.find((candidate) => existsSync(candidate));
  if (!ffmpeg) {
    return { ok: false, message: "ffmpeg is not installed — `brew install ffmpeg` to get videos instead of frames" };
  }

  return new Promise((resolve) => {
    const child = spawnChild(
      ffmpeg,
      [
        "-y",
        "-framerate",
        String(request.fps),
        "-pattern_type",
        "glob",
        "-i",
        join(request.framesDir, "frame-*.png"),
        // yuv420p and the even-dimension filter: without them the file plays in
        // ffplay and nothing else, QuickTime included.
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-pix_fmt",
        "yuv420p",
        request.outPath,
      ],
      { stdio: "ignore" },
    );
    child.on("error", (error) => resolve({ ok: false, message: String(error) }));
    child.on("exit", (code) => {
      logMain("browser-recording-encoded", { outPath: request.outPath, code });
      resolve(code === 0 ? { ok: true, message: request.outPath } : { ok: false, message: `ffmpeg exited ${String(code)}` });
    });
  });
}

/**
 * An agent's `browser_*` tool, arriving over the peer socket.
 *
 * The action names are the tool names with `browser_` stripped, so the helper
 * needs no table of its own and a tool added there needs no second edit here
 * beyond an arm in this switch.
 */
async function runBrowserRequest(request: BrowserRequest): Promise<{ ok: boolean; message: string }> {
  const service = browserService();
  const from = typeof request.from === "string" ? request.from : undefined;
  const tab = request.tab;
  // A section drives its own browser. `from` is the section id, which is also
  // the thread id — the two have always been the same thing.
  const threadId = from ?? activeThreadId;
  if (!threadId) {
    return {
      ok: false,
      message: "The browser is scoped to a section, and this call has none — open a section in Panda Code first.",
    };
  }
  const scope = { threadId, by: from };

  // A page has to be somewhere to be shown. If the window was closed to the
  // tray, an agent reaching for the browser brings it back rather than failing.
  if (request.action !== "list" && !liveMainWindow()) {
    createWindow();
  }

  switch (request.action) {
    case "list":
      return { ok: true, message: describeBrowser(service.state(), threadId) };
    case "activity":
      return service.activity({ threadId, limit: request.limit });
    case "open":
      return service.open({ ...scope, url: request.url ?? "" });
    case "navigate":
      return service.navigate({ ...scope, tab, url: request.url ?? "" });
    case "read":
      return service.read({ ...scope, tab, selector: request.selector, links: request.links, values: request.values });
    case "inspect":
      return service.inspect({
        ...scope,
        tab,
        selector: request.selector,
        text: request.text,
        role: request.role,
        within: request.within,
        limit: request.limit,
      });
    case "wait":
      return service.waitFor({
        ...scope,
        tab,
        selector: request.selector,
        text: request.text,
        timeoutMs: typeof request.timeout === "number" ? request.timeout * 1000 : undefined,
      });
    case "click":
      return service.click({
        ...scope,
        tab,
        selector: request.selector,
        text: request.text,
        button: request.button === "right" || request.button === "middle" ? request.button : "left",
        clickCount: request.clickCount,
      });
    case "hover":
      return service.hover({ ...scope, tab, selector: request.selector, text: request.text });
    case "drag":
      return service.drag({ ...scope, tab, from: request.start ?? "", to: request.end ?? "" });
    case "type":
      return service.type({
        ...scope,
        tab,
        selector: request.selector ?? "",
        text: request.text ?? "",
        submit: request.submit,
        clear: request.clear,
      });
    case "key":
      return service.key({ ...scope, tab, keys: request.keys ?? "" });
    case "cursor": {
      const actions = ["move", "click", "down", "up", "drag", "wheel", "where", "hide"] as const;
      const action = actions.find((known) => known === request.mode) ?? "move";
      return service.cursor({
        ...scope,
        tab,
        action,
        x: request.x,
        y: request.y,
        dx: request.dx,
        dy: request.dy,
        selector: request.selector,
        text: request.text,
        toX: request.toX,
        toY: request.toY,
        toSelector: request.toSelector,
        toText: request.toText,
        button: request.button === "right" || request.button === "middle" ? request.button : undefined,
        clickCount: request.clickCount,
        deltaY: request.deltaY,
      });
    }
    case "scroll":
      return service.scroll({ ...scope, tab, to: request.to, text: request.text, deltaY: request.deltaY });
    case "select_option":
      return service.selectOption({ ...scope, tab, selector: request.selector ?? "", value: request.value, label: request.label });
    case "upload":
      return service.upload({ ...scope, tab, selector: request.selector ?? "", paths: request.paths ?? [] });
    case "screenshot":
      return service.screenshot({ ...scope, tab, background: request.background });
    case "record":
      return service.record({
        ...scope,
        tab,
        action: request.mode === "stop" ? "stop" : "start",
        fps: request.fps,
        background: request.background,
      });
    case "note": {
      const result = await service.note({
        ...scope,
        tab,
        text: request.text ?? "",
        selector: request.selector,
        clear: request.clear,
      });
      // A note is a hand-off, so it is worth the user's attention even if they
      // are in another app: this is the one browser op that surfaces the window.
      // Taking one back off is not — the user did not ask for that window.
      if (result.ok && !request.clear) {
        focusMainWindow();
      }
      return result;
    }
    case "close":
      return service.close({ ...scope, tab: tab ?? "" });
    case "back":
      return service.back({ ...scope, tab });
    default:
      return { ok: false, message: `Unknown browser action: ${String(request.action)}` };
  }
}

const groqSessionManager = new GroqSessionManager({
  getApiKey: readGroqApiKey,
  sendSnapshot: (id, session) => sendStreamSnapshot(id, session),
  updateRequest: (id, request) => streamResumeRequests.set(id, request),
  logMain,
});

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
    threadId: (id) => codexAppServerManager.get(id)?.threadId,
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
  groq: {
    has: (id) => groqSessionManager.has(id),
    ids: () => groqSessionManager.ids(),
    sendInput: (id, data) => groqSessionManager.sendInput(id, data),
    stop: (id) => groqSessionManager.stop(id),
  },
});

if (process.env.PANDA_CODE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.PANDA_CODE_DEBUG_PORT);
}

// Every page the app ever loads — both windows and every `<webview>` guest in
// the built-in browser — gets the same right-click menu.
app.on("web-contents-created", (_event, contents) => {
  attachTextContextMenu(contents);
  browserDiagnosticContents(contents);
});

/**
 * Main-process timings. Read via the `perf:snapshot` IPC and shown in the
 * machine panel, so a slow app can be diagnosed from inside the app instead of
 * by sampling a release Electron build from outside (which yields unsymbolized
 * frames and cannot see JS at all).
 */
const mainPerf = new PerfRecorder();

/**
 * The recorder was instrumented but never given a readout: no panel calls
 * `perf:snapshot`, and the numbers live only in this process's memory, so a
 * slow app cannot be diagnosed after the fact. Dump the snapshot to a file on
 * an interval and on quit, so the profiling data survives to be read (by an
 * agent over the workspace, or by hand). Bounded and best-effort: telemetry
 * must never become the thing it measures, so a failed write is swallowed.
 */
function perfSnapshotPath(): string {
  return join(app.getPath("userData"), "perf-snapshot.json");
}

function dumpPerfSnapshot(): void {
  try {
    const snapshot = mainPerf.snapshot();
    const payload = {
      writtenAt: new Date().toISOString(),
      sinceIso: new Date(snapshot.since).toISOString(),
      // Pre-formatted so the file is legible without post-processing.
      operations: snapshot.operations.map(formatPerfOperation),
      slowest: snapshot.slowest,
      raw: snapshot,
    };
    writeFileSync(perfSnapshotPath(), JSON.stringify(redactDiagnosticValue(payload), null, 2));
  } catch {
    // A busy window whose only problem is that it is busy must not also crash
    // on its own telemetry write.
  }
}

let perfDumpTimer: ReturnType<typeof setInterval> | undefined;
function startPerfSnapshotDump(): void {
  if (perfDumpTimer) return;
  // 30s is frequent enough to catch a slow session before the user quits, and
  // rare enough that the write itself never shows up in the numbers.
  perfDumpTimer = setInterval(dumpPerfSnapshot, 30_000);
  perfDumpTimer.unref?.();
  app.on("before-quit", dumpPerfSnapshot);
}

/**
 * Wrap every `ipcMain.handle` once, rather than editing 80 registration sites.
 * Installed at module scope, which runs at import time — before `whenReady`
 * fires and the handlers are registered, so none escape instrumentation.
 */
function trustedAppUrl(value: string): boolean {
  try {
    const actual = new URL(value);
    const expected = new URL(process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(__dirname, "../renderer/index.html")).href);
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname;
  } catch { return false; }
}
function trustedIpcSender(event: IpcMainInvokeEvent): boolean {
  return (event.sender === mainWindowInstance?.webContents || event.sender === browserWindowInstance?.webContents) &&
    event.senderFrame === event.sender.mainFrame && trustedAppUrl(event.senderFrame.url);
}

function instrumentIpcHandlers(): void {
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    register(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!trustedIpcSender(event)) throw new Error("Untrusted IPC sender.");
      const started = performance.now();
      const role = diagnosticRole(event.sender);
      try {
        return await listener(event, ...args);
      } finally {
        mainPerf.record(`ipc:${channel}`, performance.now() - started);
        browserDiagnosticRecord(`ipc:${role}:${channel}`, performance.now() - started);
      }
    })) as typeof ipcMain.handle;
}

instrumentIpcHandlers();

app.whenReady().then(() => {
  // Created up front so a project-less section can start from anywhere (window,
  // tray, relay) without first round-tripping to the renderer.
  ensureScratchWorkspace();

  // Give the perf recorder a durable readout so a slow session can be diagnosed
  // from the snapshot file instead of guessed at.
  startPerfSnapshotDump();
  startBrowserDiagnostics(() => {
    const state = browserServiceInstance?.state();
    return state ? {
      floating: state.floating, activeTabByThread: state.activeTabByThread,
      tabs: state.tabs.map((tab) => ({ id: tab.id, threadId: tab.threadId, asleep: tab.asleep,
        loading: tab.loading, recording: Boolean(tab.recording) })),
    } : { tabs: [] };
  });

  // Rewritten every launch so `panda-peers` always points at this build.
  installPeersShim();

  // Boards are written by agents out-of-process; this is how an open board on
  // screen learns about it.
  startBacklogWatcher();

  // Same for schedules, plus the clock that actually fires them.
  startScheduleWatcher();
  startScheduleTicker();

  // The write half of workspace awareness: sections hand each other messages
  // through here, since only the main process can drive a live transport.
  peerMessageServer = startPeerMessageServer({
    socketPath: peersSocketPath(),
    readThreads: readStoredThreads,
    sendInput: (request) => sessionService.sendInput(request),
    createSection: openPeerSection,
    // The renderer owns thread persistence and respects manual names when it
    // receives this event; the peer server checks the same rule before sending.
    setTitle: publishGeneratedSectionTitle,
    // Live ids and the stored start request are what decide whether a peer
    // message can land at all; `threads.json` only records what the UI last saw.
    liveSessionIds: () => sessionService.listSessions(),
    canRestart: (id) => Boolean(storedSessionStartRequest(id)),
    // Same reader the agent-facing tools use, so a completion notice cannot
    // claim a section finished when its output is not there to read.
    readTranscript: (thread) => loadPeerTranscript(thread, { home: homedir() }),
    messagesPath: peerMessagesPath(),
    // The browser is a window, not a file, so — unlike the backlog — an agent
    // cannot reach it except through the running app. Same socket, one more op.
    browser: (request) => runBrowserRequest(request),
    attention: showAgentAttention,
    log: logMain,
  });

  // Before the bridge: the relay URL is a preference now, and the bridge needs
  // it at construction.
  appPreferences = loadPreferences();

  remoteBridge = createRelayBridge({
    url: appPreferences.relayUrl || undefined,
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    sessionService,
    notificationSettings: (sessionId, patch) => {
      if (patch) updatePreferences({ notificationChannels: patchNotificationChannels(appPreferences.notificationChannels, sessionId, patch) });
      return resolveNotificationChannels(appPreferences.notificationChannels, sessionId);
    },
    isRemoteWorkspaceAllowed,
    allowRemoteFullAccess: () => appPreferences.remoteAllowFullAccess === true,
    log: logMain,
    pairingChanged: (info) => sendToLiveWindows("remote:pairing", info),
    starredChanged: (event) => sendToRendererWindows("remote:session-starred", event),
    archivedChanged: (event) => sendToRendererWindows("remote:session-archived", event),
    remotePromptDelivered: (event) => sendToRendererWindows("session:remote-prompt", event),
    getUsageBundle: (force) => loadUsageBundle(force),
    runBtw: (request) => runRemoteBtwAsk(request),
    loadUsageCost: (query) => usageLedger().query(query),
    loadSessionFiles: (request) => loadSessionFileChanges(request),
    applyBacklog: (request) => applyRemoteBacklog(request),
    loadRemoteSchedule: (cwd) => getScheduleStore().read(cwd),
    loadRemoteGitStatus: (cwd) => loadWorkspaceGitStatus(cwd),
    loadRemoteGitLog: (request) => loadWorkspaceGitLog(request),
    loadRemoteWorkflowRuns: (request) => loadWorkspaceWorkflowRuns(request),
    loadRemoteTree: (request) => loadWorkspaceTree(request),
    loadRemoteFile: (request) => readRemoteTextFile(request),
    writeRemoteFile: (request) => writeRemoteTextFile(request),
    loadMachineStats: (force) => readMachineStats(force),
    ensureRemoteScratchWorkspace: () => ensureScratchWorkspace(),
    readBrowserMedia: (request) => readBrowserMediaFile(request),
  });

  ipcMain.handle("app:log", (_event, logEvent: AppLogEvent) => {
    writeDebugLog(logEvent);
  });

  ipcMain.handle("app:set-badge", (_event, count: unknown) => {
    currentBadgeCount = typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    applyBadge();
  });

  ipcMain.handle("conversation:search", (_event, request: ConversationSearchRequest) => searchIndexedConversations(request));

  ipcMain.handle("machine:stats", (_event, force: unknown) => readMachineStats(force === true));

  ipcMain.handle("machine:kill-commands", (_event, request: KillSectionCommandsRequest) =>
    killSectionCommands(request),
  );

  ipcMain.handle("dictation:available", () => dictationHost().available);

  ipcMain.handle("dictation:prepare", () => {
    dictationHost().prepare(appPreferences.dictationLocale);
  });

  ipcMain.handle("dictation:start", (_event, request: DictationStartRequest) => {
    const targetId = typeof request?.targetId === "string" ? request.targetId : "";
    if (!targetId) return false;
    return dictationHost().start(targetId, appPreferences.dictationLocale);
  });

  ipcMain.handle("dictation:stop", () => dictationHost().stop());
  ipcMain.handle("dictation:cancel", () => dictationHost().cancel());
  ipcMain.handle("dictation:restart", () => dictationHost().restart());

  ipcMain.handle("git:workspace-status", (_event, request: WorkspaceGitRequest) => loadWorkspaceGitStatus(request?.cwd));

  ipcMain.handle("git:fetch-remotes", async (_event, request: WorkspaceGitFetchRequest) => {
    const cwd = request?.cwd;
    if (typeof cwd === "string" && cwd) {
      // Refs only — never touches the working tree, so it is safe to run from a button.
      await runGit(cwd, ["fetch", "--all", "--prune"], GIT_FETCH_TIMEOUT_MS);
    }

    return loadWorkspaceGitStatus(cwd);
  });

  ipcMain.handle("git:workspace-log", (_event, request: WorkspaceGitLogRequest) => loadWorkspaceGitLog(request));

  ipcMain.handle("git:workflow-runs", (_event, request: WorkspaceWorkflowRunsRequest) =>
    loadWorkspaceWorkflowRuns(request),
  );

  ipcMain.handle("git:workspace-tree", (_event, request: WorkspaceGitTreeRequest) => loadWorkspaceTree(request));
  ipcMain.handle("file:read-text", (_event, request: TextFileRequest) => readTextFile(request));
  ipcMain.handle("file:write-text", (_event, request: TextFileWriteRequest) => writeTextFile(request));

  ipcMain.handle("session:file-changes", (_event, request: SessionFileChangesRequest) => loadSessionFileChanges(request));

  ipcMain.handle("backlog:load", (_event, cwd: unknown) =>
    typeof cwd === "string" && cwd ? getBacklogStore().read(cwd) : emptyBacklog(""),
  );

  ipcMain.handle("backlog:mutate", (_event, mutation: BacklogMutation): BacklogMutationResult => applyBacklogMutation(mutation));

  ipcMain.handle("schedule:load", (_event, cwd: unknown) =>
    typeof cwd === "string" && cwd ? getScheduleStore().read(cwd) : emptySchedule(""),
  );

  ipcMain.handle("schedule:mutate", (_event, mutation: ScheduleMutation): ScheduleMutationResult => applyScheduleMutation(mutation));

  ipcMain.handle("editor:list", () => listEditors());

  ipcMain.handle("editor:open", (_event, request: OpenInEditorRequest) => openInEditor(request));
  ipcMain.handle("clipboard:copy-file", (_event, path: string) => copyFileToClipboard(path));
  ipcMain.handle("attachment:show-context-menu", (event, path: string) => showAttachmentContextMenu(event, path));

  ipcMain.handle(
    "usage:cost",
    (_event, query: UsageCostQuery | undefined): UsageCostReport => usageLedger().query(query ?? {}),
  );

  ipcMain.handle("app:load-preferences", () => appPreferences);

  ipcMain.handle("app:save-preferences", (_event, patch: Partial<AppPreferences>) => updatePreferences(patch ?? {}));

  ipcMain.handle("remote:get-pairing", () => remoteBridge?.getPairingInfo());

  ipcMain.handle("remote:refresh-pairing", () => remoteBridge?.refreshPairingCode());

  ipcMain.handle("remote:list-devices", () => remoteBridge?.listPairedDevices() ?? []);
  ipcMain.handle("remote:set-mobile-notifications", (_event, enabled: unknown) =>
    typeof enabled === "boolean" ? (remoteBridge?.setMobileNotifications(enabled) ?? []) : [],
  );
  ipcMain.handle("app:set-notification-channels", (_event, sessionId: unknown, patch: unknown) => {
    if ((sessionId !== null && typeof sessionId !== "string") || !patch || typeof patch !== "object") throw new Error("Invalid notification settings.");
    return updatePreferences({ notificationChannels: patchNotificationChannels(appPreferences.notificationChannels, sessionId as string | null, patch) });
  });
  ipcMain.handle("remote:get-session-mobile-notifications", (_event, sessionId: unknown) =>
    typeof sessionId === "string"
      ? (remoteBridge?.getSessionMobileNotifications(sessionId) ?? { available: false, phoneCount: 0, subscribedPhones: 0 })
      : { available: false, phoneCount: 0, subscribedPhones: 0 },
  );
  ipcMain.handle("remote:set-session-mobile-notifications", (_event, sessionId: unknown, subscribed: unknown) =>
    typeof sessionId === "string" && typeof subscribed === "boolean"
      ? (remoteBridge?.setSessionMobileNotifications(sessionId, subscribed) ?? { available: false, phoneCount: 0, subscribedPhones: 0 })
      : { available: false, phoneCount: 0, subscribedPhones: 0 },
  );

  ipcMain.handle("remote:revoke-device", async (_event, mobileId: unknown) => {
    if (typeof mobileId !== "string" || !remoteBridge) return [];
    const decision = await dialog.showMessageBox({ type: "warning", buttons: ["Cancel", "Revoke phone"], defaultId: 0, cancelId: 0,
      message: "Revoke this paired phone?",
      detail: "Its relay credential and independent command identity will be removed. Other paired phones remain authorized. Content already downloaded by this phone cannot be recalled.",
    });
    return decision.response === 1 ? remoteBridge.revokePairedDevice(mobileId) : remoteBridge.listPairedDevices();
  });

  ipcMain.handle("app:focus", () => {
    focusMainWindow();
  });

  ipcMain.handle("image:save-pasted", (_event, request: SavePastedImageRequest) => savePastedImage(request));

  ipcMain.handle("export:conversation", (_event, request: ConversationExportRequest) => exportConversation(request));

  ipcMain.handle("perf:snapshot", () => mainPerf.snapshot());

  ipcMain.handle("perf:reset", () => {
    mainPerf.reset();
  });

  /**
   * The renderer measures its own work (its long tasks and its persist writes
   * never cross the IPC boundary, so main cannot see them) and forwards it here
   * in batches, keeping one merged view of where time goes across both processes.
   */
  ipcMain.handle("perf:report", (event, samples: unknown) => {
    if (!Array.isArray(samples)) return;
    for (const sample of samples.slice(0, 200)) {
      if (typeof sample?.name !== "string" || sample.name.length > 120 ||
        !sample.name.startsWith("renderer:") || typeof sample?.ms !== "number" ||
        !Number.isFinite(sample.ms) || sample.ms < 0) continue;
      const detail = typeof sample.detail === "number" && Number.isFinite(sample.detail) ? sample.detail : undefined;
      mainPerf.record(sample.name, sample.ms, detail);
      browserDiagnosticRecord(`${diagnosticRole(event.sender)}:${sample.name}`, sample.ms, detail);
    }
  });

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
      const title = compactSectionTitle((event as SessionTitleEvent).title);
      if (title) remoteBridge?.setSessionTitle({ id: (event as SessionTitleEvent).id, title });
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

  ipcMain.handle("session:set-archived", (_event, event: unknown) => {
    if (
      event &&
      typeof event === "object" &&
      typeof (event as { id?: unknown }).id === "string" &&
      typeof (event as { archived?: unknown }).archived === "boolean"
    ) {
      remoteBridge?.setSessionArchived(event as { id: string; archived: boolean });
    }
  });

  ipcMain.handle("session:sync-local-archived", (_event, archivedIds: unknown) => {
    if (Array.isArray(archivedIds) && archivedIds.every((id) => typeof id === "string")) {
      remoteBridge?.syncLocalArchivedThreads(archivedIds as string[]);
    }
  });

  ipcMain.handle("session:set-parent", (_event, event: unknown) => {
    if (
      event &&
      typeof event === "object" &&
      typeof (event as { id?: unknown }).id === "string" &&
      ["string", "undefined"].includes(typeof (event as { parentId?: unknown }).parentId)
    ) {
      remoteBridge?.setSessionParent(event as { id: string; parentId?: string });
    }
  });

  ipcMain.handle("session:set-unsent-drafts", (_event, ids: unknown) => {
    if (!Array.isArray(ids)) return;
    unsentDraftSessionIds = new Set(ids.filter((id): id is string => typeof id === "string"));
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

  // The browser panel. Every one of these is the same call an agent's tool
  // makes — the human's URL bar and `browser_navigate` are one code path — so
  // neither driver can end up looking at a browser the other has moved.
  ipcMain.handle("browser:state", () => browserService().state());
  ipcMain.handle("browser:activity-list", (_event, limit?: number) => {
    // Touch the service first so the audit store exists on a cold panel open.
    browserService();
    return browserAuditInstance?.recent(typeof limit === "number" ? limit : 200) ?? [];
  });
  // The panel's calls carry the section the user is in; an agent's carry its own.
  ipcMain.handle("browser:panel-visible", (_event, request: { threadId: string; visible: boolean }) => {
    if (typeof request?.threadId !== "string" || !request.threadId) return;
    browserService().setPanelVisible({ threadId: request.threadId, visible: Boolean(request.visible) });
  });

  ipcMain.handle("browser:set-floating", (_event, on: boolean) => {
    if (on) openFloatingBrowser();
    else closeFloatingBrowser();
  });

  /**
   * "Take me to the section this page belongs to."
   *
   * The floating window shows tabs from every section, so a tab there is often
   * the first place the user sees that a section did something. This brings the
   * main window forward and switches it to that section.
   */
  ipcMain.handle("browser:focus-thread", (_event, threadId: string) => {
    if (typeof threadId !== "string" || !threadId) return;
    focusMainWindow();
    sendToRendererWindows("browser:focus-thread", { threadId });
  });

  ipcMain.handle("browser:active-thread", (_event, threadId: string) => {
    activeThreadId = typeof threadId === "string" && threadId ? threadId : undefined;
  });
  ipcMain.handle("browser:open", (_event, request: BrowserOpenRequest) =>
    browserService().open({ threadId: request.threadId, url: request.url }),
  );
  ipcMain.handle("browser:navigate", (_event, request: BrowserNavigateRequest) =>
    browserService().navigate({ threadId: request.threadId, tab: request.tabId, url: request.url }),
  );
  ipcMain.handle("browser:close", (_event, request: BrowserTabRequest) =>
    browserService().close({ threadId: request.threadId, tab: request.tabId }),
  );
  ipcMain.handle("browser:select", (_event, request: BrowserTabRequest) =>
    browserService().select({ threadId: request.threadId, tabId: request.tabId }),
  );
  ipcMain.handle("browser:back", (_event, request: BrowserTabRequest) =>
    browserService().back({ threadId: request.threadId, tab: request.tabId }),
  );
  ipcMain.handle("browser:forward", (_event, request: BrowserTabRequest) =>
    browserService().forward({ threadId: request.threadId, tab: request.tabId }),
  );
  ipcMain.handle("browser:reload", (_event, request: BrowserTabRequest) =>
    browserService().reload({ threadId: request.threadId, tab: request.tabId }),
  );
  ipcMain.handle("browser:attach", (_event, request: BrowserAttachRequest) => {
    browserService().attach(request.tabId, request.webContentsId);
    browserDiagnosticAttach(request.tabId, request.webContentsId);
  });
  ipcMain.handle("browser:report", (_event, request: BrowserReportRequest) => {
    const { tabId, ...patch } = request;
    browserService().report(tabId, patch);
  });
  ipcMain.handle("browser:capture-stage-ready", (event, request: { requestId?: string }) => {
    if (typeof request?.requestId !== "string") return;
    const pending = pendingBrowserCaptureStages.get(request.requestId);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    pending.resolve(true);
  });
  ipcMain.handle("browser:set-note-hidden", (_event, request: BrowserSetNoteHiddenRequest) =>
    browserService().setNoteHidden(request.tabId, request.hidden),
  );

  /**
   * The human answering an agent's note.
   *
   * This closes the loop the note opened: the agent stopped and said it was
   * waiting on the user, and this is the user coming back. It arrives at that
   * section as an ordinary prompt, so a section that has since gone dormant is
   * restarted to receive it — exactly what happens when a peer sends a message.
   */
  ipcMain.handle("browser:resolve-note", async (_event, request: BrowserResolveNoteRequest) => {
    const resolved = browserService().resolveNote(request.tabId);
    if (!resolved?.from) {
      return { ok: true };
    }

    const reply = request.reply?.trim();
    const body =
      `[The user looked at the page you left for them — "${resolved.tabTitle}" (${resolved.url}) — and cleared your note.\n` +
      `Your note was: ${resolved.note?.text ?? ""}]\n\n` +
      (reply || "They cleared it without leaving a message. Carry on from where you stopped.");
    const sent = await sessionService.sendInput({ id: resolved.from, data: body });
    logMain("browser-note-resolved", { tabId: request.tabId, to: resolved.from, delivered: sent.ok });
    return { ok: sent.ok, message: "message" in sent ? sent.message : undefined };
  });

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

  ipcMain.handle("usage:load", (_event, provider?: UsageProvider, force?: boolean) =>
    loadUsageSnapshot(provider === "codex" ? "codex" : "claude", force === true),
  );

  ipcMain.handle("codex:models", async () => {
    try {
      return await readCodexModelsViaAppServer();
    } catch (error) {
      logMain("codex:model-list-error", { message: error instanceof Error ? error.message : String(error) });
      return codexModelsCache;
    }
  });
  ipcMain.handle("groq:key-configured", () => Boolean(readGroqApiKey()));
  ipcMain.handle("groq:set-key", (_event, value: unknown) => typeof value === "string" && writeGroqApiKey(value));
  ipcMain.handle("groq:models", () => listGroqModels());

  ipcMain.handle("conversation:load", async (_event, request: ConversationLoadRequest) => {
    const conversation = await readIndexedConversation(request);
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
    // The floating browser being open does not count as the app being on
    // screen: clicking the Dock icon has to bring the main window back either
    // way.
    if (!liveMainWindow()) {
      createWindow();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  remoteBridge?.stop();
  peerMessageServer?.close();
  backlogWatcher?.close();
  // Releases the microphone. Left running, the recording indicator stays lit
  // after the app is gone.
  dictationHostInstance?.dispose();
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
