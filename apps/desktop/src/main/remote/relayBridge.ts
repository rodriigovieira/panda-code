import type { NotificationChannels } from "../../shared/notification-channels";
import { hostname, platform } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import QRCode from "qrcode";
import type {
  AgentRuntime,
  AgentState,
  ConversationItem,
  ExecutionMode,
  PendingApproval,
  RemotePairedDevice,
  RemotePairingInfo,
  QueuedPromptSync,
  SessionFileChanges,
  SessionFileChangesRequest,
  SessionArchivedEvent,
  SessionRemotePromptEvent,
  SessionRuntimeEvent,
  SessionMobileNotificationStatus,
  SessionStarredEvent,
  SessionStartRequest,
  SessionStartResult,
  SessionStatus,
  SessionTitleEvent,
  TextFileContents,
  TextFileWriteResult,
  TokenUsageStats,
  UsageBundle,
  UsageCostQuery,
  UsageCostReport,
  WorkspaceGitLog,
  WorkspaceGitLogRequest,
  WorkspaceGitStatus,
  WorkspaceGitTree,
  WorkspaceGitTreeRequest,
  WorkspaceWorkflowRuns,
  WorkspaceWorkflowRunsRequest,
} from "../../shared/ipc";
import type { BacklogMutationResult } from "../../shared/ipc";
import type { WorkspaceBacklog } from "../../shared/backlog";
import type { MachineStats } from "../../shared/machine-stats";
import type { WorkspaceSchedule } from "../../shared/schedule";
import type { SessionService } from "../sessionService";
import { decryptJson, encryptJson, generateSecretboxKey, keyFromBase64, keyToBase64 } from "./crypto";
import { readKeychainSecret, writeKeychainSecret } from "./keychain";
import { CommandReplayGuard } from "./commandAuth";
import { effectiveRemotePermission } from "./effectivePermission";

type Logger = (event: string, details?: Record<string, unknown>) => void;
type CommandType =
  | "start"
  | "input"
  | "queue"
  | "stop"
  | "notification-settings"
  | "switch"
  | "approve"
  | "deny"
  | "btw"
  | "usage-cost"
  | "session-files"
  | "usage-refresh"
  | "backlog"
  | "schedule"
  | "git-status"
  | "machine-stats"
  | "scratch-workspace"
  | "media";

export type RemoteBtwRequest = {
  threadId: string;
  cwd: string;
  runtime?: AgentRuntime;
  question: string;
  parentClaudeSessionId?: string;
  codexThreadId?: string;
  model?: string;
  effort?: string;
};
export type RemoteBtwResult = {
  ok: boolean;
  answer?: string;
  message?: string;
};
type PendingCommand = {
  _id: string;
  mobileId: string;
  sessionId?: string;
  type: CommandType;
  payloadCipher?: string;
  createdAt: number;
};
type RelayCredentials = {
  deviceId: string;
  token: string;
  key: Uint8Array;
};
type PendingConversationItem = {
  item: ConversationItem;
  serialized: string;
};
/**
 * A prompt a mobile client asked to hold behind the active turn. Kept here —
 * not in the phone's own state — so it survives the phone being killed and
 * reopened: the desktop, not the phone, is the durable half of this pairing.
 * `data`/`attachments` mirror the shape `dispatchInput` already hands to
 * `deliverPrompt`; this is the same delivery, just deferred.
 */
type QueuedPromptEntry = {
  id: string;
  data: string;
  attachments?: unknown;
  imageCount: number;
  queuedAt: number;
};
type CommandDispatchResult = {
  succeeded: boolean;
  // Most commands answer with a human-readable message; a usage-cost request
  // answers with the report itself, and a changed-files request with the file list.
  payload:
    | SessionStartResult
    | { message: string }
    | { settings: NotificationChannels }
    | { report: UsageCostReport }
    | { changes: SessionFileChanges }
    | { backlog: WorkspaceBacklog }
    | { schedule: WorkspaceSchedule }
    | { status: WorkspaceGitStatus }
    | { log: WorkspaceGitLog }
    | { workflows: WorkspaceWorkflowRuns }
    | { tree: WorkspaceGitTree }
    | { file: TextFileContents }
    | { saved: TextFileWriteResult }
    | { stats: MachineStats }
    | { bundle: UsageBundle | null }
    | { path: string }
    | { storageId: string; mimeType: string };
};
type MirrorState = {
  cwd?: string;
  title?: string;
  /**
   * The last {plaintext → ciphertext} pair sent for the title and cwd. Every
   * `encryptJson` call picks a fresh nonce, so re-encrypting an unchanged title
   * produces a different string, the relay sees the row as changed, and every
   * phone's `sessions.list` subscription re-fires — on every runtime tick. Reuse
   * the ciphertext while the plaintext holds and those writes disappear.
   */
  titleCipher?: { plain: string; cipher: string };
  cwdCipher?: { plain: string; cipher: string };
  status: SessionStatus;
  agentState: AgentState;
  executionMode: ExecutionMode;
  claudeSessionId?: string;
  runtime?: Omit<SessionRuntimeEvent, "id">;
  /** Sub-thread parent, mirrored so the phone nests the list the way the sidebar does. */
  parentSessionId?: string;
  startedByMobileId?: string;
  notifyOnExit?: boolean;
  starred?: boolean;
  /**
   * A LOW-CHURN field changed (status, agentState, title, cwd, …) — the state the
   * relay's `sessions` row carries, which every phone's list subscription reads.
   * Only this warrants a full `upsertSession`.
   */
  metadataDirty: boolean;
  /**
   * Bumped with every `metadataDirty` flag. A flush reads the low-churn fields
   * before awaiting the upsert, so a state change that lands DURING that await
   * (the common one: working → waiting, arriving while the "working" upsert is
   * still in flight) is not in the payload — clearing the flag afterwards would
   * drop it, stranding the relay's `sessions` row mid-turn while the badge on
   * `sessionRuntime` moves on. Only clear the flag when the version still
   * matches what was sent.
   */
  metadataVersion: number;
  /**
   * The runtime badge changed. Serialized last-sent snapshot rather than a
   * boolean: a session replaying its transcript re-emits identical runtime
   * events, and an unchanged badge is a write nobody needs (see
   * `stableItemFingerprint` for the same problem on the conversation path).
   */
  runtimeSent?: string;
  /** When the badge last went up, for the {@link RUNTIME_PUSH_MS} throttle. */
  runtimeSentAt?: number;
  /** The `agentState` in the badge the relay holds, so a transition can skip that throttle. */
  runtimeSentState?: string;
  /** The queued prompts in the badge the relay holds, for the same reason. */
  runtimeSentQueued?: string;
  /** Whether the relay is known to hold a routing row for this session already. */
  registered: boolean;
  pendingItems: Map<string, PendingConversationItem>;
  sentItems: Map<string, string>;
  timer?: NodeJS.Timeout;
  flushing: boolean;
  /** Prompts queued by a mobile client, oldest first. See `QueuedPromptEntry`. */
  queuedPrompts: QueuedPromptEntry[];
  /** Guards the auto-flush-on-waiting below against firing twice for one entry
   * while its delivery is still in flight (runtime ticks arrive ~1/s). */
  autoFlushingQueue: boolean;
};

/** Flag the low-churn state as needing a full `upsertSession`. See `metadataVersion`. */
function markMetadataDirty(mirror: MirrorState): void {
  mirror.metadataDirty = true;
  mirror.metadataVersion += 1;
}

type RelayBridgeOptions = {
  allowRemoteFullAccess?: () => boolean;
  notificationSettings?: (sessionId: string, patch?: Partial<NotificationChannels>) => NotificationChannels;
  url?: string;
  appVersion: string;
  userDataPath?: string;
  sessionService: SessionService;
  isRemoteWorkspaceAllowed: (cwd: string) => boolean;
  log: Logger;
  pairingChanged: (info: RemotePairingInfo) => void;
  starredChanged?: (event: SessionStarredEvent) => void;
  archivedChanged?: (event: SessionArchivedEvent) => void;
  /** A phone-delivered prompt, so the renderer can draw it like a local one. */
  remotePromptDelivered?: (event: SessionRemotePromptEvent) => void;
  // Fetch both providers' plan-usage snapshots (only the desktop holds the creds).
  // `force` bypasses the periodic cache floor for a user-initiated refresh —
  // see `loadUsageSnapshot`'s `usageForcedMinFetchIntervalMs`.
  getUsageBundle: (force?: boolean) => Promise<UsageBundle | null>;
  // Run a forked, read-only /btw side-question to completion and return its answer.
  runBtw: (request: RemoteBtwRequest) => Promise<RemoteBtwResult>;
  // Token→dollar report from the desktop's usage ledger (the phone has no ledger
  // of its own — the desktop is the only place spend is recorded).
  loadUsageCost: (query: UsageCostQuery) => UsageCostReport;
  // "What did this section change?" — transcript-attributed paths joined to git.
  // Only the desktop can see the working tree, so this is a round-trip too.
  loadSessionFiles: (request: SessionFileChangesRequest) => Promise<SessionFileChanges>;
  // Read or edit a workspace's kanban board. Disk-backed and shared with the
  // agents' own writes, so the desktop is the only place that can answer.
  applyBacklog: (request: RemoteBacklogRequest) => BacklogMutationResult;
  // Read a workspace's schedule. View-only from the phone in V1 — no mutation
  // path — same disk-backed reasoning as the backlog.
  loadRemoteSchedule: (cwd: string) => WorkspaceSchedule;
  // Read a workspace's git status (branch, ahead/behind, changes, stashes,
  // worktrees, branches) — the same read the desktop's own git panel uses.
  loadRemoteGitStatus: (cwd: string) => Promise<WorkspaceGitStatus>;
  // One page of a workspace's commit history, and one level of its file tree.
  // Both ride the same `git-status` command as the status read — same trust
  // gate, same "only the desktop can see this disk" reasoning — discriminated
  // by the payload's `view`.
  loadRemoteGitLog: (request: WorkspaceGitLogRequest) => Promise<WorkspaceGitLog>;
  loadRemoteWorkflowRuns?: (request: WorkspaceWorkflowRunsRequest) => Promise<WorkspaceWorkflowRuns>;
  loadRemoteTree: (request: WorkspaceGitTreeRequest) => Promise<WorkspaceGitTree>;
  /**
   * One text file out of a trusted workspace, for the phone's document reader.
   * Rides the same command for the same reason as the tree — and, like the
   * tree, is the desktop's job because only it can see this disk. The
   * implementation is responsible for keeping the read inside `cwd`.
   */
  loadRemoteFile: (request: { cwd: string; path: string; maxBytes?: number }) => TextFileContents;
  /**
   * Write one back, for the phone reader's edit mode. The only command on this
   * bridge that changes a workspace file, and it carries the same containment
   * duty as `loadRemoteFile`: the implementation keeps the write inside `cwd`
   * and overwrites an existing text file rather than creating anything.
   */
  writeRemoteFile: (request: { cwd: string; path: string; content: string }) => TextFileWriteResult;
  /** This Mac's load, memory and heaviest processes, for the phone's device sheet. */
  loadMachineStats: (force?: boolean) => Promise<MachineStats>;
  /**
   * The shared "no project" scratch folder path, creating it on disk if it
   * doesn't exist yet — the same call the renderer's own IPC path makes on
   * launch (`directory:ensure-scratch`), so desktop and phone agree on one
   * folder without the phone having to first observe a session already
   * running there.
   */
  ensureRemoteScratchWorkspace: () => Promise<string> | string;
  /**
   * One screenshot or recording off the built-in browser's disk, for a
   * `media` command. `path` is exactly what a `browser_screenshot`/
   * `browser_record` tool result printed (the phone regexes it back out of
   * the already-synced transcript text) — the implementation is responsible
   * for refusing anything outside the screenshot directory and for whatever
   * downscaling keeps a screenshot small on the wire; a recording's mp4
   * passes through as-is.
   */
  readBrowserMedia: (request: { path: string }) => Promise<{ mimeType: string; bytes: Buffer }>;
};

/**
 * One phone-issued board operation. `list` reads; the rest mutate and answer
 * with the same whole board, so the phone never has to reconcile a partial
 * update against a file agents are also writing.
 */
export type RemoteBacklogRequest = {
  cwd: string;
  op: string;
  id?: string;
  title?: string;
  summary?: string;
  description?: string;
  metadata?: string;
  column?: string;
  /** Park the card or bring it back; its column is untouched either way. */
  onHold?: boolean;
  index?: number;
  verificationNotes?: string;
  /** The phone can drop an attachment but not add one — no bytes ride this channel yet. */
  removeAttachmentIds?: string[];
};

type RegisterArgs = { deviceId: string; name: string; platform: string; token: string };
type HeartbeatArgs = { deviceId: string; token: string; appVersion?: string; usageCipher?: string };
type CreateCodeArgs = { deviceId: string; token: string; code: string };
type PendingArgs = { deviceId: string; token: string };
type ClaimArgs = { deviceId: string; token: string; commandId: string };
type ClaimResult = { claimed: boolean };
type AckArgs = {
  deviceId: string;
  token: string;
  commandId: string;
  status: "done" | "error";
  resultCipher?: string;
};
type UpsertArgs = {
  deviceId: string;
  token: string;
  sessionId: string;
  titleCipher?: string;
  cwdCipher?: string;
  status: SessionStatus;
  agentState: AgentState;
  executionMode: ExecutionMode;
  claudeSessionId?: string;
  runtimeCipher?: string;
  parentSessionId?: string;
  startedByMobileId?: string;
  notifyOnExit?: boolean;
  starred?: boolean;
};
type PutRuntimeArgs = { deviceId: string; token: string; sessionId: string; runtimeCipher: string };
type ReconcileArgs = { deviceId: string; token: string; activeSessionIds: string[] };
type AppendArgs = {
  deviceId: string;
  token: string;
  sessionId: string;
  events: Array<{ kind: ConversationItem["kind"]; payloadCipher: string }>;
};
type ListMobileClientsArgs = { deviceId: string; token: string };
type SetMobileNotificationsArgs = { deviceId: string; token: string; enabled: boolean };
type SessionMobileNotificationsArgs = { deviceId: string; token: string; sessionId: string };
type SetSessionMobileNotificationsArgs = SessionMobileNotificationsArgs & { subscribed: boolean };
type RevokeMobileClientArgs = { deviceId: string; token: string; mobileId: string };
type SetStarredArgs = { deviceId: string; token: string; sessionId: string; starred: boolean };
type SetTitleArgs = { deviceId: string; token: string; sessionId: string; titleCipher: string };
type SetParentArgs = { deviceId: string; token: string; sessionId: string; parentSessionId?: string };
type StarredForDeviceArgs = { deviceId: string; token: string; since?: number };
type StarredRow = { sessionId: string; starred: boolean; starredAt?: number; updatedAt: number };
type SetArchivedArgs = { deviceId: string; token: string; sessionId: string; archived: boolean };
type ArchivedForDeviceArgs = { deviceId: string; token: string; since?: number };
type ArchivedRow = { sessionId: string; archived: boolean; archivedAt?: number; updatedAt: number };

type RemoteSessionStartPayload = {
  id: string;
  cwd: string;
  runtime?: AgentRuntime;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /**
   * The draft's first prompt, delivered in the same command that starts the
   * session. The phone composes a session before it exists (see the mobile
   * "new session" route), so start and first turn are one user action and must
   * be one command: a separate `input` would race the start, and any window
   * between them is a session that reads as running with an empty transcript —
   * which the phone's composer then treats as busy and queues into. Optional,
   * so an older phone that starts bare still works.
   */
  prompt?: string;
  attachments?: unknown;
  /**
   * Opened from the phone as a SUB-THREAD of this section. Rides the encrypted
   * start payload rather than a schema field because it is the phone stating
   * intent, not the relay routing anything — the relay learns the link from the
   * desktop's own upsert, once the section exists.
   */
  parentSessionId?: string;
};

const registerDeviceRef = makeFunctionReference<"mutation", RegisterArgs, { deviceId: string }>("pairing:registerDevice");
const heartbeatRef = makeFunctionReference<"mutation", HeartbeatArgs, null>("devices:heartbeat");
const createCodeRef = makeFunctionReference<"mutation", CreateCodeArgs, string>("pairing:createCode");
const pendingRef = makeFunctionReference<"query", PendingArgs, PendingCommand[]>("commands:pending");
const claimRef = makeFunctionReference<"mutation", ClaimArgs, ClaimResult>("commands:claim");
const ackRef = makeFunctionReference<"mutation", AckArgs, null>("commands:ack");
const upsertRef = makeFunctionReference<"mutation", UpsertArgs, null>("sessions:upsertSession");
const putRuntimeRef = makeFunctionReference<"mutation", PutRuntimeArgs, null>("sessions:putRuntime");
const appendRef = makeFunctionReference<"mutation", AppendArgs, { headSeq: number }>("sessions:appendEvents");
const reconcileRef = makeFunctionReference<"mutation", ReconcileArgs, { demoted: number }>("sessions:reconcileDevice");
const setStarredRef = makeFunctionReference<"mutation", SetStarredArgs, null>("sessions:setStarredByDevice");
const setTitleRef = makeFunctionReference<"mutation", SetTitleArgs, null>("sessions:setTitleByDevice");
const setParentRef = makeFunctionReference<"mutation", SetParentArgs, null>("sessions:setParentByDevice");
const starredForDeviceRef = makeFunctionReference<"query", StarredForDeviceArgs, StarredRow[]>("sessions:starredForDevice");
const setArchivedRef = makeFunctionReference<"mutation", SetArchivedArgs, null>("sessions:setArchivedByDevice");
const archivedForDeviceRef = makeFunctionReference<"query", ArchivedForDeviceArgs, ArchivedRow[]>(
  "sessions:archivedForDevice",
);
const listMobileClientsRef = makeFunctionReference<"query", ListMobileClientsArgs, RemotePairedDevice[]>("pairing:listMobileClients");
const setMobileNotificationsRef = makeFunctionReference<"mutation", SetMobileNotificationsArgs, RemotePairedDevice[]>(
  "pairing:setMobileNotifications",
);
const sessionMobileNotificationsRef = makeFunctionReference<"query", SessionMobileNotificationsArgs, SessionMobileNotificationStatus>(
  "notifications:sessionSubscriptionForDevice",
);
const setSessionMobileNotificationsRef = makeFunctionReference<"mutation", SetSessionMobileNotificationsArgs, SessionMobileNotificationStatus>(
  "notifications:setSessionSubscriptionByDevice",
);
const resetPairingRef = makeFunctionReference<"mutation", { deviceId: string; token: string; resetId: string }, { complete: boolean }>("pairing:resetPairing");
type MediaAuthArgs = { deviceId: string; token: string };
type MediaRegisterArgs = MediaAuthArgs & { storageId: string; mimeType: string };
const mediaUploadUrlRef = makeFunctionReference<"mutation", MediaAuthArgs, string>("media:generateUploadUrl");
const mediaRegisterBlobRef = makeFunctionReference<"mutation", MediaRegisterArgs, null>("media:registerBlob");

const HEARTBEAT_MS = 12_000;
/**
 * A wedged socket does not reject — it just never answers.
 *
 * `ConvexClient` queues a mutation until its websocket comes back, so a
 * connection that dies in a way the client never notices (the usual one: the Mac
 * sleeps and the socket is half-open on wake) turns every relay call into a
 * promise that hangs forever. Nothing rejected, so nothing logged: the desktop
 * simply stopped heartbeating, the prune cron flipped it to `offline`, the phone
 * said "Mac offline", and Settings → Phone sat on "Creating a secure pairing
 * code…" until the app was relaunched. These two put a deadline on it.
 */
const RELAY_CALL_TIMEOUT_MS = 15_000;
/** No heartbeat acknowledged for this long ⇒ the connection is gone; rebuild it. */
const CONNECTION_STALE_MS = 60_000;
/** How often a HEALTHY bridge says so. Once a minute is nothing next to the event firehose. */
const HEALTH_LOG_MS = 15_000;
/**
 * How often the supervisor checks that there is a live connection at all.
 *
 * The heartbeat watchdog can only run when a heartbeat timer exists, so it
 * covers exactly one failure mode: a connection that came up and later went
 * deaf. A `connect()` that THREW left `client = null` with every timer cleared
 * and nothing scheduled to try again — the bridge stayed dead until something
 * else happened to call `start()`, which in practice meant opening Settings →
 * Phone (`listPairedDevices` calls `start()` when it finds no client). That is
 * why the phone "came back" from merely looking at the pairing panel. This tick
 * lives outside every connection attempt and is the only thing that owns
 * "should there be a connection right now".
 */
const SUPERVISE_MS = 15_000;
/** Backoff bounds for reconnect attempts, so a genuinely dead relay is not hammered. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/**
 * Stop issuing session traffic once this many mutations are outstanding.
 *
 * A healthy bridge sits in the low single digits: one flush per section, each
 * awaited before the next. The measured failure had **1417** queued against a
 * websocket that was down and retrying, and every reconnect re-sent the backlog
 * — so the queue was both the symptom and what kept the socket from surviving
 * long enough to drain it. Session mirrors are the elastic part of the load and
 * re-state themselves on the next tick, so they are what yields; the heartbeat
 * never does, because it is the only thing that can prove the socket works.
 */
const MAX_INFLIGHT_MUTATIONS = 64;
/** Most seed writes one PASS may issue, so a backlog can never become a burst. */
const MAX_SEED_PUSHES = 32;
/** Basename of the persisted archive-flip timestamps, under `userDataPath`. */
const ARCHIVE_FLIPS_FILE = "archive-flips.json";
/** How long a burst of flips waits before it becomes one write instead of many. */
const ARCHIVE_FLIPS_SAVE_DEBOUNCE_MS = 2_000;
/** Entries older than this are dropped on save so the file cannot grow forever. */
const ARCHIVE_FLIPS_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/**
 * How often the leftovers of a capped seed pass are retried.
 *
 * The cap alone made the backlog someone else's problem: a seed pass ran once
 * per connect, so anything past the 32nd row waited for the NEXT connect —
 * which, before the connection supervisor existed, could mean the next time the
 * user relaunched the app. Measured on this Mac: 41 sessions archived on the
 * desktop that the relay had never heard of, all of them recent, so the phone
 * showed 41 threads the desktop considered hidden. At 32 per tick this drains
 * a 1500-row backlog in about twelve minutes and a normal one in one tick,
 * without ever putting more than 32 writes on the socket at once.
 */
const SEED_DRAIN_MS = 15_000;
/** Must match the `.take()` in `starredForDevice`/`archivedForDevice`. */
const FLAG_PAGE_SIZE = 200;
/** Safety stop for the paging loop: 200k flag rows is far past anything real. */
const FLAG_PAGE_LIMIT = 1000;
const EVENT_FLUSH_MS = 1_000;
/**
 * How often the runtime BADGE may go up, independently of the event flush.
 *
 * The badge is a "latest tool / latest command / token count" chip on one open
 * session's header. At the event flush's 1 Hz it was the single most-written
 * thing on the relay — one document per second per running section, times the
 * thirty-odd sections this machine runs. Nothing in it needs to be that fresh:
 * a chip that lags a second or two is imperceptible, whereas an agentState
 * TRANSITION (a turn ending, a permission prompt appearing) is what the user is
 * actually waiting on, and that skips this throttle entirely.
 */
const RUNTIME_PUSH_MS = 3_000;
const COMMAND_MAX_AGE_MS = 2 * 60_000;
// Plan usage barely moves; refetch on a slow timer and let the heartbeat carry
// the latest ciphertext up. Matches the desktop's own cache TTL upstream — this
// timer used to sit exactly on that TTL, so the app called Anthropic's usage
// endpoint every single minute it was running and got the account rate-limited.
const USAGE_PUSH_MS = 5 * 60_000;

/**
 * Reject a relay call that never answers, so its caller can react.
 *
 * The underlying request is NOT cancelled — Convex has no such handle — and a
 * late reply is simply ignored. That is fine for everything this wraps: each is
 * idempotent (a heartbeat, a single-use pairing code) and the reconnect that
 * follows re-establishes the state anyway.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * What the Convex client itself thinks is going on.
 *
 * Reasoning about this bridge from the outside produced two confident, wrong
 * diagnoses, because every failure mode it has — a closed client, a dead socket,
 * a mutation queued behind one the server never finished — presents identically
 * from here: a promise that does not settle. The client tracks all three
 * separately, so ask it rather than inferring.
 */
function describeConnection(client: ConvexClient | null): Record<string, unknown> {
  if (!client) return { client: "none" };
  try {
    const state = client.connectionState();
    const oldest = state.timeOfOldestInflightRequest;
    return {
      socket: state.isWebSocketConnected,
      everConnected: state.hasEverConnected,
      connections: state.connectionCount,
      retries: state.connectionRetries,
      inflightMutations: state.inflightMutations,
      inflightActions: state.inflightActions,
      oldestInflightMs: oldest ? Date.now() - oldest.getTime() : null,
    };
  } catch (error) {
    return { stateError: commandErrorMessage(error) };
  }
}

/** Outstanding mutations, or 0 when the client cannot say. */
function inflightMutations(client: ConvexClient | null): number {
  if (!client) return 0;
  try {
    return client.connectionState().inflightMutations;
  } catch {
    return 0;
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip a queue entry to its display copy — no image bytes cross this. */
function toQueuedPromptSync(entries: QueuedPromptEntry[]): QueuedPromptSync[] {
  return entries.map((entry) => ({
    id: entry.id,
    text: entry.data,
    imageCount: entry.imageCount,
    queuedAt: entry.queuedAt,
  }));
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "terminal" || value === "stream-json";
}

function isAgentRuntime(value: unknown): value is AgentRuntime {
  return value === "claude" || value === "codex" || value === "groq";
}

function isSessionStartRequest(value: unknown): value is SessionStartRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    typeof value.command === "string" &&
    isExecutionMode(value.executionMode) &&
    typeof value.cols === "number" &&
    typeof value.rows === "number" &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.effort === undefined || typeof value.effort === "string") &&
    (value.permissionMode === undefined || typeof value.permissionMode === "string") &&
    (value.claudeSessionId === undefined || typeof value.claudeSessionId === "string")
  );
}

function isRemoteSessionStartPayload(value: unknown): value is RemoteSessionStartPayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    (value.runtime === undefined || isAgentRuntime(value.runtime)) &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.effort === undefined || typeof value.effort === "string") &&
    (value.permissionMode === undefined || typeof value.permissionMode === "string") &&
    (value.prompt === undefined || typeof value.prompt === "string") &&
    (value.parentSessionId === undefined || typeof value.parentSessionId === "string") &&
    (value.attachments === undefined || Array.isArray(value.attachments)) &&
    value.command === undefined &&
    value.executionMode === undefined
  );
}

type RemoteLaunchOverridePayload = {
  runtime?: AgentRuntime;
  model?: string;
  effort?: string;
  permissionMode?: string;
};

function isRemoteLaunchOverridePayload(value: unknown): value is RemoteLaunchOverridePayload {
  if (!isRecord(value)) return false;
  return (
    (value.runtime === undefined || isAgentRuntime(value.runtime)) &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.effort === undefined || typeof value.effort === "string") &&
    (value.permissionMode === undefined || typeof value.permissionMode === "string")
  );
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function assertRemotePermission(runtime: AgentRuntime, permissionMode: string | undefined, allowFullAccess = false): string | undefined {
  const mode = cleanOptionalString(permissionMode);
  if (runtime === "groq") return undefined;
  const safe = runtime === "codex" ? ["read-only", "workspace-write"] : ["default", "acceptEdits", "plan", "dontAsk"];
  const full = runtime === "codex" ? "danger-full-access" : "bypassPermissions";
  if (mode && (safe.includes(mode) || (allowFullAccess && mode === full))) return mode;
  throw new Error("This permission mode is blocked by the Mac's phone access settings.");
}

function buildRemoteSessionStartRequest(payload: RemoteSessionStartPayload, allowFullAccess = false): SessionStartRequest {
  const runtime = payload.runtime ?? "claude";
  return {
    id: payload.id,
    cwd: payload.cwd,
    runtime,
    command: runtime === "codex" ? "codex" : runtime === "groq" ? "groq" : "claude",
    model: cleanOptionalString(payload.model),
    effort: cleanOptionalString(payload.effort),
    permissionMode: assertRemotePermission(
      runtime,
      cleanOptionalString(payload.permissionMode) ?? (runtime === "codex" ? "read-only" : runtime === "claude" ? "default" : undefined),
      allowFullAccess,
    ),
    executionMode: "stream-json",
    cols: 100,
    rows: 30,
    parentId: cleanOptionalString(payload.parentSessionId),
  };
}

function readTokenUsage(value: unknown): TokenUsageStats | undefined {
  if (!isRecord(value)) return undefined;
  const { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, totalTokens } = value;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof cacheCreationInputTokens !== "number" ||
    typeof cacheReadInputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens,
  };
}

function commandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Remote command failed.";
}

/**
 * Dedup fingerprint for a conversation item — stable content only. Excludes
 * `sequence`, a per-StreamJsonState counter that gets re-stamped whenever the
 * desktop rebuilds/replays a session's state, which would otherwise make
 * unchanged items look new and re-append on every replay.
 */
function stableItemFingerprint(item: ConversationItem): string {
  const { sequence: _sequence, ...stable } = item;
  return JSON.stringify(stable);
}

function remoteImageExtension(mimeType: string, name: string): string {
  const existingExtension = name.match(/\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i)?.[0]?.toLowerCase();
  if (existingExtension) return existingExtension;

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

function safeImageName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "") || "remote-image";
}

function saveRemoteImageAttachments(value: unknown, userDataPath: string): string[] {
  if (!Array.isArray(value)) return [];

  const directory = join(userDataPath, "remote-images");
  mkdirSync(directory, { recursive: true });

  const paths: string[] = [];
  for (const attachment of value) {
    if (!isRecord(attachment)) continue;
    const data = typeof attachment.data === "string" ? attachment.data : "";
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType : "image/png";
    const rawName = typeof attachment.name === "string" ? attachment.name : "remote-image.png";
    if (!data || !mimeType.startsWith("image/")) continue;

    const extension = remoteImageExtension(mimeType, rawName);
    // Prefer the mobile-provided id as the filename stem. It gets embedded in
    // the message-body path that round-trips back to the phone, letting the
    // phone re-hydrate the image from its local cache on reload. Fall back to a
    // random name for older clients that don't send an id.
    const rawId = typeof attachment.id === "string" ? attachment.id : "";
    const safeId = /^[a-zA-Z0-9_-]{1,64}$/.test(rawId) ? rawId : "";
    const baseName = safeImageName(rawName.replace(/\.[^.]+$/, ""));
    const stem = safeId || `${Date.now()}-${randomBytes(4).toString("hex")}-${baseName}`;
    const path = join(directory, `${stem}${extension}`);
    writeFileSync(path, Buffer.from(data, "base64"));
    paths.push(path);
  }

  return paths;
}

function promptWithImageAttachments(prompt: string, imagePaths: string[]): string {
  const trimmedPrompt = prompt.trim();
  if (imagePaths.length === 0) return trimmedPrompt;

  const body = trimmedPrompt || "Please inspect the attached image(s).";
  const attachmentList = imagePaths.map((path) => `- ${path}`).join("\n");
  return `${body}\n\nAttached image file${imagePaths.length === 1 ? "" : "s"}:\n${attachmentList}`;
}

/**
 * Stable per-deployment suffix for keychain accounts. The host is enough to tell
 * two relays apart and stays readable in Keychain Access, which matters when
 * someone is trying to work out what the app has stored.
 */
function relayScope(url: string | undefined): string {
  if (!url) return "none";
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/[^a-zA-Z0-9.-]/g, "-");
  }
}

function initialPairingInfo(url?: string): RemotePairingInfo {
  return url
    ? { status: "loading", message: "Connecting to the relay…" }
    : {
        status: "disabled",
        // The default state for a downloaded build, not an error. Everything
        // else in the app works without a relay; this panel is the only feature
        // that needs one, and turning it on means running your own deployment.
        message:
          "Phone pairing is off. Panda Code runs fully on this Mac — no account, nothing uploaded. To control sessions from your phone, run your own relay: see docs/self-hosting.md.",
      };
}

/**
 * Load `archivedChangedAt` off disk so the staleness check at
 * `handleArchivedRows` survives a relaunch — without this, a relay row's own
 * (often stale) `false` always won on the first connect after every restart,
 * because there was nothing in memory yet to compare its `updatedAt` against.
 * Tolerates a missing or corrupt file: this is a best-effort cache, not a
 * source of truth, and a bad read should behave exactly like a cold start.
 */
function loadArchiveFlips(userDataPath: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const raw = readFileSync(join(userDataPath, ARCHIVE_FLIPS_FILE), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) map.set(id, value);
    }
  } catch {
    // Missing on first run, or corrupt — either way, start empty.
  }
  return map;
}

/** Atomic write (temp file + rename), mirroring `writeStoredThreads` in `index.ts`. */
function saveArchiveFlips(userDataPath: string, flips: Map<string, number>): void {
  const cutoff = Date.now() - ARCHIVE_FLIPS_MAX_AGE_MS;
  const record: Record<string, number> = {};
  for (const [id, changedAt] of flips) {
    if (changedAt < cutoff) continue; // Prune ancient entries so the file can't grow forever.
    record[id] = changedAt;
  }
  const storePath = join(userDataPath, ARCHIVE_FLIPS_FILE);
  mkdirSync(userDataPath, { recursive: true });
  const tempPath = `${storePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tempPath, storePath);
}

export class RelayBridge {
  private readonly options: RelayBridgeOptions;
  private client: ConvexClient | null = null;
  private credentials: RelayCredentials | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private latestUsageCipher: string | undefined;
  /** Plaintext of `latestUsageCipher`, to detect a genuinely new snapshot. */
  private latestUsagePlain: string | undefined;
  /** The snapshot the relay already holds, so the heartbeat sends each one once. */
  private sentUsageCipher: string | undefined;
  private unsubscribePending: (() => void) | null = null;
  private unsubscribeStarred: (() => void) | null = null;
  private readonly starredBySession = new Map<string, boolean>();
  private unsubscribeArchived: (() => void) | null = null;
  private readonly archivedBySession = new Map<string, boolean>();
  /**
   * Archive flips this Mac made that the relay has NOT confirmed yet — either the
   * socket was down when the user clicked, or the mutation failed.
   *
   * Without this, an archive made while offline was lost for good: the push was
   * dropped on the floor (see {@link pushSessionArchived}), and the next connect
   * replayed the relay's stale `archived: false` row over it, un-hiding the
   * section AND flipping `archivedBySession` to false so the seed pass then
   * skipped it. The user archived a thread and it came back.
   */
  private readonly pendingArchived = new Map<string, boolean>();
  /**
   * When this Mac last changed each session's archive flag. The relay rows carry
   * their own `updatedAt`, so a row older than our local change is a stale echo
   * (a re-read of a flip we have since reversed) and must not be applied.
   *
   * Seeded from {@link localFlipAt} on startup, which is what makes the check
   * survive a relaunch: without it, the very first connect after restart had
   * nothing to compare a stale relay row's `updatedAt` against, so the row
   * always won and archived sections came back.
   */
  private readonly archivedChangedAt = new Map<string, number>();
  /**
   * When THIS Mac last flipped each session itself — a strict subset of
   * {@link archivedChangedAt}, and the only part of it that is persisted (to
   * `archive-flips.json`; `undefined` `userDataPath` means no persistence and
   * the old in-memory-only behaviour).
   *
   * Deliberately not written by `handleArchivedRows`: a timestamp copied off a
   * relay row is not a record of our own decision, and persisting it would make
   * the bug's own stale row look, on the next launch, like a flip we have always
   * known about — permanently disqualifying the session from the self-heal in
   * `syncLocalArchivedThreads`. That mattered because the two are racing: if the
   * connect-time replay lands before the renderer's sync call, the heal does not
   * get its chance until the NEXT launch, and only an unpoisoned file leaves that
   * chance open.
   */
  private readonly localFlipAt = new Map<string, number>();
  private archiveFlipsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Sessions the relay has told us about since this connection came up, so the
   * startup reconciliation only pushes what it has NOT already seen. Cleared on
   * connect, because a fresh connection re-reads the authoritative set.
   */
  private readonly starredOnRelay = new Set<string>();
  /**
   * The relay's last known archive value per session — NOT merely "a row
   * exists". A `Set` of "rows we've seen" made `false` rows indistinguishable
   * from `true` ones: a session the relay had explicitly marked `false` looked
   * "already seeded" to `pushKnownArchived`/`syncLocalArchivedThreads`, so a
   * local `true` that disagreed with it was silently never pushed, forever.
   */
  private readonly relayArchived = new Map<string, boolean>();
  /**
   * Titles the user typed, by session. Two jobs: they are pushed to the relay so
   * the phone shows the same name as the desktop, and they make the transcript
   * readers' auto-titles non-authoritative for these sections — otherwise the
   * next `session:title` from a resumed transcript would overwrite the rename.
   */
  private readonly manualTitles = new Map<string, string>();
  /** Manual titles the relay has already been told about, to push each once. */
  private readonly pushedTitles = new Map<string, string>();
  private readonly processingCommands = new Set<string>();
  private readonly mirrors = new Map<string, MirrorState>();
  private pairingInfo: RemotePairingInfo;
  private stopped = false;
  /** When the relay last ACKNOWLEDGED a heartbeat — the liveness signal for {@link reconnect}. */
  private lastHeartbeatAckAt = 0;
  /**
   * When the live attempt started talking to the relay.
   *
   * The staleness window used to be gated on `lastHeartbeatAckAt > 0`, which
   * made a connection that never acked a single heartbeat — the exact shape of a
   * socket that comes up and immediately wedges, and of every rebuild, since
   * {@link reconnect} resets the ack to 0 — permanently exempt from the
   * watchdog. This is the fallback baseline so "never acked" ages out too.
   */
  private connectStartedAt = 0;
  /** Consecutive failed connection attempts, for the retry backoff. */
  private connectFailures = 0;
  /** Earliest the supervisor may try again after a failure. */
  private nextConnectAttemptAt = 0;
  /** Liveness tick that outlives every connection attempt. */
  private superviseTimer: NodeJS.Timeout | null = null;
  /** Repeats the capped seed passes until the relay agrees with this Mac. */
  private seedTimer: NodeJS.Timeout | null = null;
  /** Seed writes currently in flight, so a drain tick cannot double-send one. */
  private readonly seedingArchived = new Set<string>();
  private readonly seedingStarred = new Set<string>();
  /** Rate limit for the healthy-heartbeat line. */
  private lastHealthLogAt = 0;
  /**
   * Mutations issued since the last health tick, by kind.
   *
   * `connectionState()` reported 1417 mutations in flight on a client seconds
   * old, which is two orders of magnitude more than this bridge should ever have
   * outstanding — but it does not say WHICH call is producing them. This does.
   */
  private readonly callCounts = new Map<string, number>();
  /** Telemetry tick, installed before `connect()` awaits anything. */
  private healthTimer: NodeJS.Timeout | null = null;
  /** Rate limit for the backpressure line — it would otherwise fire per session per tick. */
  private lastBackpressureLogAt = 0;
  /** Guards against a second rebuild while one is already in flight. */
  private reconnecting = false;
  /**
   * Bumped by every {@link teardown}. A `connect()` compares it across each of
   * its awaits to find out whether it is still the attempt that owns the bridge.
   */
  private connectionEpoch = 0;
  /** The in-flight connection attempt, so racing callers share one. */
  private starting: Promise<void> | null = null;
  /**
   * Live relay URL. Mutable because it is a user setting: `setUrl` reconnects in
   * place rather than making the user relaunch.
   */
  private url: string | undefined;

  private readonly commandGuard?: CommandReplayGuard;
  private readonly commandGuardError?: unknown;

  constructor(options: RelayBridgeOptions) {
    try {
      this.commandGuard = new CommandReplayGuard(options.userDataPath ? join(options.userDataPath, "remote-command-replays.json") : undefined);
    } catch (error) { this.commandGuardError = error; }
    this.options = options;
    this.url = options.url;
    this.pairingInfo = initialPairingInfo(options.url);
    if (options.userDataPath) {
      for (const [id, changedAt] of loadArchiveFlips(options.userDataPath)) {
        this.archivedChangedAt.set(id, changedAt);
        this.localFlipAt.set(id, changedAt);
      }
    }
    this.superviseTimer = setInterval(() => this.superviseConnection(), SUPERVISE_MS);
    // Never a reason to hold the process open on its own.
    this.superviseTimer.unref?.();
  }

  /**
   * Make sure a bridge that is supposed to be connected actually is.
   *
   * Two cases, both of which previously needed a human: no client at all (a
   * failed `connect()` cleans up and schedules nothing), and a client that has
   * never acknowledged anything since it was built (a hung attempt, or a rebuild
   * whose socket was dead on arrival — the heartbeat's own check cannot see
   * either, because it needs a prior ack to measure from).
   */
  private superviseConnection(): void {
    if (this.stopped || !this.url || this.reconnecting) return;
    if (!this.client) {
      if (this.starting || Date.now() < this.nextConnectAttemptAt) return;
      this.options.log("remote:supervisor-restart", { failures: this.connectFailures });
      void this.start();
      return;
    }
    const since = this.lastHeartbeatAckAt || this.connectStartedAt;
    if (since > 0 && Date.now() - since > CONNECTION_STALE_MS) {
      void this.reconnect(this.lastHeartbeatAckAt ? "supervisor-stale" : "supervisor-never-acked");
    }
  }

  getPairingInfo(): RemotePairingInfo {
    return this.pairingInfo;
  }

  isEnabled(): boolean {
    return Boolean(this.url);
  }

  async listPairedDevices(): Promise<RemotePairedDevice[]> {
    if (!this.url) return [];
    if (!this.client || !this.credentials) {
      await this.start();
    }
    if (!this.client || !this.credentials) return [];
    return this.client.query(listMobileClientsRef, {
      deviceId: this.credentials.deviceId,
      token: this.credentials.token,
    });
  }

  private rotatingPhones: Promise<RemotePairedDevice[]> | undefined;
  revokePairedDevice(_mobileId: string): Promise<RemotePairedDevice[]> {
    return this.rotatingPhones ??= this.resetPhoneAccess().finally(() => { this.rotatingPhones = undefined; });
  }

  private async resetPhoneAccess(): Promise<RemotePairedDevice[]> {
    if (!this.url) return [];
    if (!this.credentials) await this.start();
    if (!this.credentials) throw new Error("Relay credentials are unavailable.");
    // Pending record is durable first, so even a crash resumes the reset before
    // any phone command or old-key publication can be accepted.
    // Retry the same durable rotation after a failure, never overwrite its ID.
    if (!(await readKeychainSecret(this.credentialAccount("rotation-pending")))) {
      await writeKeychainSecret(this.credentialAccount("rotation-pending"), JSON.stringify({ id: randomUUID(), key: keyToBase64(generateSecretboxKey()) }));
    }
    this.teardown();
    this.credentials = null;
    this.mirrors.clear();
    this.pushedTitles.clear();
    this.latestUsageCipher = undefined;
    this.latestUsagePlain = undefined;
    this.sentUsageCipher = undefined;
    await this.start();
    if (await readKeychainSecret(this.credentialAccount("rotation-pending"))) throw new Error("Phone access reset is still pending. Panda Code will retry before reconnecting.");
    return [];
  }

  async setMobileNotifications(enabled: boolean): Promise<RemotePairedDevice[]> {
    if (!this.url) return [];
    if (!this.client || !this.credentials) await this.start();
    if (!this.client || !this.credentials) return [];
    return this.client.mutation(setMobileNotificationsRef, {
      deviceId: this.credentials.deviceId,
      token: this.credentials.token,
      enabled,
    });
  }

  async getSessionMobileNotifications(sessionId: string): Promise<SessionMobileNotificationStatus> {
    if (!this.url) return { available: false, phoneCount: 0, subscribedPhones: 0 };
    if (!this.client || !this.credentials) await this.start();
    if (!this.client || !this.credentials) return { available: false, phoneCount: 0, subscribedPhones: 0 };
    try {
      return await withTimeout(this.client.query(sessionMobileNotificationsRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        sessionId,
      }), 3_000, "mobile notification status");
    } catch (error) {
      this.options.log("remote:notification-status-error", { sessionId, message: commandErrorMessage(error) });
      return { available: false, phoneCount: 0, subscribedPhones: 0 };
    }
  }

  async setSessionMobileNotifications(sessionId: string, subscribed: boolean): Promise<SessionMobileNotificationStatus> {
    if (!this.url) return { available: false, phoneCount: 0, subscribedPhones: 0 };
    if (!this.client || !this.credentials) await this.start();
    if (!this.client || !this.credentials) return { available: false, phoneCount: 0, subscribedPhones: 0 };
    try {
      return await withTimeout(this.client.mutation(setSessionMobileNotificationsRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        sessionId,
        subscribed,
      }), 5_000, "mobile notification update");
    } catch (error) {
      this.options.log("remote:notification-update-error", { sessionId, message: commandErrorMessage(error) });
      return { available: false, phoneCount: 0, subscribedPhones: 0 };
    }
  }

  /**
   * Connect, at most one attempt at a time.
   *
   * Several callers race to get a connection up — `setUrl`, `reconnect`, and the
   * IPC handlers that call `start()` whenever they find no client. Two
   * overlapping runs of {@link connect} each build a client, each install
   * timers, and — the one that actually bit — each clean up on failure by
   * closing `this.client`, which by then may be the OTHER run's healthy client.
   */
  async start(): Promise<void> {
    if (!this.url || this.client || this.stopped) return;
    this.starting ??= this.connect().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Record one outgoing call for the health tick. */
  private counted<T>(kind: string, promise: Promise<T>): Promise<T> {
    this.callCounts.set(kind, (this.callCounts.get(kind) ?? 0) + 1);
    return promise;
  }

  /**
   * Report connection health on a fixed tick.
   *
   * Installed at the TOP of `connect()`, before it awaits anything, and cleared
   * only by `teardown`. That placement is deliberate: the previous build hung
   * inside `connect()` on a call with no deadline, so no timers were ever
   * installed, the watchdog never ran, and the bridge went permanently silent —
   * the one state where telemetry matters most is the one it had none in.
   */
  private startHealthTicker(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      const calls = Object.fromEntries(this.callCounts);
      this.callCounts.clear();
      this.options.log("remote:health", {
        sinceAckMs: this.lastHeartbeatAckAt > 0 ? Date.now() - this.lastHeartbeatAckAt : null,
        ...describeConnection(this.client),
        calls,
      });
    }, HEALTH_LOG_MS);
  }

  /**
   * Read a flag table (stars, archives) in full, one page at a time.
   *
   * `starredForDevice`/`archivedForDevice` cap at 200 rows. That was sized for
   * stars, of which there are a couple of dozen — but this Mac had **1421**
   * archived sessions, so a single read confirmed 200 and left 1221 looking
   * unknown. `pushKnown*` then "seeded" all 1221 back to the relay on EVERY
   * connect: 1221 no-op mutations in one burst, which buried the websocket, took
   * the heartbeat down with it, and did it again on the reconnect that followed.
   *
   * Paging costs one extra round trip per 200 rows, once per connect. The burst
   * it replaces cost the connection.
   */
  private async readAllFlagRows<T extends { updatedAt: number }>(
    client: ConvexClient,
    ref: FunctionReference<"query", "public", { deviceId: string; token: string; since?: number }, T[]>,
    auth: { deviceId: string; token: string },
    handle: (rows: T[]) => void,
  ): Promise<void> {
    let since = 0;
    // The index is ordered by `updatedAt`, so the last row of a page is the
    // cursor for the next. Bounded so a clock skew or a tie storm cannot spin.
    for (let page = 0; page < FLAG_PAGE_LIMIT; page++) {
      const rows = await withTimeout(
        client.query(ref, { ...auth, since }),
        RELAY_CALL_TIMEOUT_MS,
        "flag page",
      );
      if (rows.length === 0) return;
      handle(rows);
      const newest = rows[rows.length - 1]?.updatedAt ?? since;
      // A page that cannot advance the cursor (every row sharing one timestamp)
      // would loop forever on the same rows.
      if (newest <= since) return;
      since = newest;
      if (rows.length < FLAG_PAGE_SIZE) return;
    }
  }

  private async connect(): Promise<void> {
    // Everything below belongs to THIS attempt. `teardown` bumps the epoch, so
    // an attempt that was superseded while awaiting can tell, drop its own
    // client, and touch none of the shared state the live attempt now owns.
    const epoch = ++this.connectionEpoch;
    const stale = (): boolean => this.connectionEpoch !== epoch;
    const url = this.url;
    if (!url) return;
    // Held locally as well as on `this`: a closed ConvexClient NEVER settles a
    // call — it does not reject, it hangs forever (verified against the relay).
    // That makes "which client is this line talking to" the difference between
    // working and a silent, permanent stall, so no line below re-reads
    // `this.client`.
    const client = new ConvexClient(url);
    try {
      this.client = client;
      this.connectStartedAt = Date.now();
      this.startHealthTicker();
      // Fresh connection: re-push the usage snapshot once, in case this is a new
      // (or wiped) relay deployment that has never seen it.
      this.sentUsageCipher = undefined;
      this.credentials = await this.loadCredentials();
      if (stale()) return void client.close();
      const pendingRotation = await readKeychainSecret(this.credentialAccount("rotation-pending"));
      if (pendingRotation) {
        const pending = JSON.parse(pendingRotation) as { id: string; key: string };
        const key = keyFromBase64(pending.key);
        await writeKeychainSecret(this.credentialAccount("e2e-key"), pending.key);
        this.credentials.key = key;
        this.setPairingInfo({ status: "loading", message: "Resetting phone access and replacing the shared encryption key…" });
        while (!(await withTimeout(client.mutation(resetPairingRef, { deviceId: this.credentials.deviceId, token: this.credentials.token, resetId: pending.id }), RELAY_CALL_TIMEOUT_MS, "reset phone access")).complete) {
          if (stale()) return void client.close();
        }
        if (stale()) return void client.close();
        await writeKeychainSecret(this.credentialAccount("rotation-pending"), "");
      }
      await withTimeout(
        this.counted("register", client.mutation(registerDeviceRef, {
          deviceId: this.credentials.deviceId,
          name: hostname(),
          platform: platform(),
          token: this.credentials.token,
        })),
        RELAY_CALL_TIMEOUT_MS,
        "register device",
      );
      // Pairing is the only startup work the Settings panel is waiting for.
      // Keep it ahead of usage collection and heartbeat: both are auxiliary,
      // may involve slower provider/network reads, and must not strand the UI
      // at "Connecting to the relay…" when device registration already worked.
      if (stale()) return void client.close();
      await this.refreshPairingCode();
      if (stale()) return void client.close();
      await this.reconcileStrandedSessions();
      if (stale()) return void client.close();
      await this.refreshUsage();
      await this.sendHeartbeat();
      if (stale()) return void client.close();
      this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_MS);
      this.usageTimer = setInterval(() => void this.refreshUsage(), USAGE_PUSH_MS);
      this.unsubscribePending = client.onUpdate(
        pendingRef,
        { deviceId: this.credentials.deviceId, token: this.credentials.token },
        (commands) => void this.handlePendingCommands(commands),
        (error) => this.options.log("remote:commands-error", { message: error.message }),
      );
      // Star/archive state is read in two phases: the whole set once, then a
      // subscription to everything that changes AFTER that instant.
      //
      // These two subscriptions stay open for the entire run of the app, and a
      // reactive query re-ships every row it returns on every re-execution. Read
      // as a plain `by_device` range they were re-shipping all ~200 rows to
      // report one flipped boolean — together 1.35 GB over ten days, for four
      // booleans. With the cursor, the open subscription's read set is the empty
      // tail of the index until a star or an archive actually moves.
      const flagsSince = Date.now();
      const auth = { deviceId: this.credentials.deviceId, token: this.credentials.token };
      this.starredOnRelay.clear();
      this.relayArchived.clear();
      await this.readAllFlagRows(client, starredForDeviceRef, auth, (rows) => this.handleStarredRows(rows));
      if (stale()) return void client.close();
      if (stale()) return void client.close();
      this.unsubscribeStarred = client.onUpdate(
        starredForDeviceRef,
        { ...auth, since: flagsSince },
        (rows) => this.handleStarredRows(rows),
        (error) => this.options.log("remote:starred-error", { message: error.message }),
      );
      this.pushKnownStarred();
      await this.readAllFlagRows(client, archivedForDeviceRef, auth, (rows) => this.handleArchivedRows(rows));
      if (stale()) return void client.close();
      if (stale()) return void client.close();
      this.unsubscribeArchived = client.onUpdate(
        archivedForDeviceRef,
        { ...auth, since: flagsSince },
        (rows) => this.handleArchivedRows(rows),
        (error) => this.options.log("remote:archived-error", { message: error.message }),
      );
      // Clicks made while the socket was down, before the bulk seed pass so the
      // user's own flips are never queued behind a historical backlog.
      this.flushPendingArchived();
      this.pushKnownArchived();
      // Renames recorded before the relay came up (the renderer saves threads
      // seconds after launch, this connects later).
      this.pushKnownManualTitles();
      this.startSeedDrain();
      this.connectFailures = 0;
      this.nextConnectAttemptAt = 0;
      this.options.log("remote:started", { deviceId: this.credentials.deviceId, url: this.url });
    } catch (error) {
      // Only the LIVE attempt may tear down shared state. A superseded attempt
      // that fails here used to read `this.client` into `failedClient` and close
      // it — closing whatever healthy client had replaced it, after which every
      // relay call on the bridge hung forever with nothing logged. It closes its
      // own `client` and nothing else.
      void client.close();
      if (stale()) {
        this.options.log("remote:start-abandoned", { message: commandErrorMessage(error) });
        return;
      }
      this.client = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.usageTimer) clearInterval(this.usageTimer);
      this.usageTimer = null;
      this.unsubscribePending?.();
      this.unsubscribePending = null;
      this.unsubscribeStarred?.();
      this.unsubscribeStarred = null;
      this.unsubscribeArchived?.();
      this.unsubscribeArchived = null;
      // The supervisor is what tries again; all this decides is how soon, so a
      // relay that is genuinely down is retried once a minute rather than
      // every tick.
      this.connectFailures++;
      const backoffMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.connectFailures - 1));
      this.nextConnectAttemptAt = Date.now() + backoffMs;
      this.setPairingInfo({ status: "error", message: commandErrorMessage(error) });
      this.options.log("remote:start-error", { message: commandErrorMessage(error), retryInMs: backoffMs });
    }
  }

  /**
   * Close out whatever the previous run left mid-turn. A force-quit (or crash,
   * or a lid closed on a dying battery) never writes a terminal state, so those
   * sessions stay `running`/`working` on the relay and the phone spins on them
   * forever — this launch reloads the same threads as idle and has no
   * transition to report. Tell the relay which sessions are genuinely live now;
   * it demotes the rest. Best-effort: a failure here must not stop the bridge
   * from coming up, and the prune cron's heartbeat sweep is the other net.
   */
  private async reconcileStrandedSessions(): Promise<void> {
    if (!this.client || !this.credentials) return;
    try {
      const result = await this.client.mutation(reconcileRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        activeSessionIds: this.options.sessionService.listSessions(),
      });
      if (result.demoted > 0) this.options.log("remote:reconciled", { demoted: result.demoted });
    } catch (error) {
      this.options.log("remote:reconcile-error", { message: commandErrorMessage(error) });
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.superviseTimer) clearInterval(this.superviseTimer);
    this.superviseTimer = null;
    this.teardown();
  }

  /**
   * Point the bridge at a different relay (or at none) without a relaunch.
   *
   * Everything cached here describes the OLD deployment — credentials it issued,
   * which sessions it already knows, which titles and usage snapshots it has
   * been told about — so all of it is dropped. The new deployment gets a clean
   * bridge that re-upserts from scratch on the next tick.
   */
  setUrl(url: string | undefined): void {
    const next = url?.trim() || undefined;
    if (next === this.url) return;

    this.teardown();
    this.credentials = null;
    this.sentUsageCipher = undefined;
    this.mirrors.clear();
    this.pushedTitles.clear();
    this.processingCommands.clear();
    this.url = next;
    this.setPairingInfo(initialPairingInfo(next));
    this.stopped = false;
    // A different deployment owes nothing to the old one's failures.
    this.connectFailures = 0;
    this.nextConnectAttemptAt = 0;
    this.superviseTimer ??= (() => {
      const timer = setInterval(() => this.superviseConnection(), SUPERVISE_MS);
      timer.unref?.();
      return timer;
    })();
    if (next) void this.start();
  }

  /** Close the live connection but stay usable — `setUrl` reconnects after it. */
  private teardown(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.callCounts.clear();
    // Anything still connecting is now superseded; it will drop its own client
    // at its next checkpoint rather than installing it over the new one.
    this.connectionEpoch++;
    this.starting = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
    if (this.seedTimer) clearInterval(this.seedTimer);
    this.seedTimer = null;
    // Nothing survives the socket, so nothing is still in flight — and a stale
    // entry here would make the next connection's seed pass skip that row.
    this.seedingArchived.clear();
    this.seedingStarred.clear();
    this.unsubscribePending?.();
    this.unsubscribePending = null;
    this.unsubscribeStarred?.();
    this.unsubscribeStarred = null;
    this.unsubscribeArchived?.();
    this.unsubscribeArchived = null;
    for (const mirror of this.mirrors.values()) {
      if (mirror.timer) clearTimeout(mirror.timer);
      // Clear the HANDLE too, not just the timer: `scheduleFlush` treats a
      // non-null `timer` as "a flush is already coming" and returns. `setUrl`
      // discards the mirrors right after this, so it never noticed — `reconnect`
      // keeps them, and would have left every one of them permanently unable to
      // schedule another flush.
      mirror.timer = undefined;
    }
    if (this.client) void this.client.close();
    this.client = null;
    this.connectStartedAt = 0;
  }

  heartbeatNow(): void {
    if (this.client && this.credentials) void this.sendHeartbeat();
  }

  setSessionStarred({ id, starred }: SessionStarredEvent): void {
    this.starredBySession.set(id, starred);
    const mirror = this.mirror(id);
    mirror.starred = starred;
    // Star-only changes patch an existing relay row. Do not force an upsert from
    // this path: local idle sections may not exist on the relay yet.
    this.pushSessionStarred(id, starred);
  }

  /**
   * A section was nested under another, or detached from one.
   *
   * Patches the relay row rather than upserting, for the same reason a rename
   * does: re-arranging the tree is a thing the user does to sections that are
   * not running, and creating a routing row for a dormant one would float it to
   * the top of the phone's list as if it had come back to life. The mirror is
   * updated too, so a section that DOES flush later carries the new parent
   * without waiting for another move.
   */
  setSessionParent({ id, parentId }: { id: string; parentId?: string }): void {
    const mirror = this.mirror(id);
    mirror.parentSessionId = parentId;
    if (!this.client || !this.credentials) return;
    void this.counted("setParent", this.client
      .mutation(setParentRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        sessionId: id,
        ...(parentId ? { parentSessionId: parentId } : {}),
      })
      .catch((error) => this.options.log("remote:set-parent-error", { sessionId: id, message: commandErrorMessage(error) })));
  }

  private pushSessionStarred(sessionId: string, starred: boolean): void {
    if (!this.client || !this.credentials) return;
    void this.counted("setStarred", this.client
      .mutation(setStarredRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        sessionId,
        starred,
      })
      // Record what the relay now holds, so the repeating seed pass stops
      // considering it missing — without this the drain tick would re-send
      // every star it ever seeded, once per tick, forever.
      .then(() => this.starredOnRelay.add(sessionId))
      .catch((error) => this.options.log("remote:set-starred-error", { sessionId, message: commandErrorMessage(error) }))
      .finally(() => this.seedingStarred.delete(sessionId)));
  }

  /**
   * Reconcile state this desktop knew before the relay came up. Anything the
   * relay just reported is skipped: the startup read is authoritative, and
   * re-pushing it fired one mutation per session on every launch — each of which
   * inserts-or-no-ops against the same index the open subscription reads.
   */
  private pushKnownStarred(): void {
    for (const [sessionId, starred] of this.starredBySession) {
      if (this.starredOnRelay.has(sessionId)) continue;
      // See `pushKnownArchived`: the drain tick repeats this pass, so a write
      // still in flight must not be sent again.
      if (this.seedingStarred.has(sessionId)) continue;
      // Absence of a relay row already MEANS false, so seeding `false` writes
      // nothing and is indistinguishable from not sending it. Only a `true`
      // carries information the relay does not already have.
      if (!starred) continue;
      this.seedingStarred.add(sessionId);
      this.pushSessionStarred(sessionId, starred);
    }
  }

  syncLocalStarredThreads(threads: Array<{ id: string; starred?: boolean }>): void {
    let pushed = 0;
    for (const thread of threads) {
      if (!thread.starred || this.starredBySession.get(thread.id) === true) continue;
      // Same shape as `syncLocalArchivedThreads` — see the reasoning there. Stars
      // never grew big enough to bring the socket down, but the code path is
      // identical and there is no reason for it to stay unbounded.
      this.starredBySession.set(thread.id, true);
      if (this.starredOnRelay.has(thread.id)) continue;
      if (!this.client) continue;
      if (pushed >= MAX_SEED_PUSHES) continue;
      pushed++;
      this.pushSessionStarred(thread.id, true);
    }
    if (pushed >= MAX_SEED_PUSHES) {
      this.options.log("remote:seed-deferred", { kind: "starred-sync", pushed });
    }
  }

  /**
   * The user archived (or unarchived) a section, from either device. Same
   * split-table contract as {@link setSessionStarred}: never touches the
   * `sessions` row, so archiving never forces an upsert for a section that may
   * be long dormant.
   */
  setSessionArchived({ id, archived }: SessionArchivedEvent): void {
    this.archivedBySession.set(id, archived);
    this.recordLocalFlip(id);
    // Held until the relay confirms it. Cleared in `pushSessionArchived`.
    this.pendingArchived.set(id, archived);
    this.pushSessionArchived(id, archived);
  }

  /** This Mac decided this session's archive state just now — remember it, on disk. */
  private recordLocalFlip(sessionId: string): void {
    const now = Date.now();
    this.archivedChangedAt.set(sessionId, now);
    this.localFlipAt.set(sessionId, now);
    this.scheduleArchiveFlipsSave();
  }

  /**
   * Debounce `localFlipAt` writes so a burst of flips (e.g. the self-heal
   * pass below, or the user archiving several sections in a row) becomes one
   * disk write instead of one per flip. No-op when there is no `userDataPath`
   * (some tests, and any config that hasn't set one) — persistence is strictly
   * best-effort on top of the in-memory map, never required for it to work.
   */
  private scheduleArchiveFlipsSave(): void {
    if (!this.options.userDataPath) return;
    if (this.archiveFlipsSaveTimer) return;
    this.archiveFlipsSaveTimer = setTimeout(() => {
      this.archiveFlipsSaveTimer = null;
      if (!this.options.userDataPath) return;
      try {
        saveArchiveFlips(this.options.userDataPath, this.localFlipAt);
      } catch (error) {
        this.options.log("remote:archive-flips-save-error", { message: commandErrorMessage(error) });
      }
    }, ARCHIVE_FLIPS_SAVE_DEBOUNCE_MS);
    this.archiveFlipsSaveTimer.unref?.();
  }

  private pushSessionArchived(sessionId: string, archived: boolean): void {
    // Offline: leave it in `pendingArchived` for the next connect rather than
    // dropping the user's click.
    if (!this.client || !this.credentials) return;
    void this.counted("setArchived", this.client
      .mutation(setArchivedRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        sessionId,
        archived,
      })
      .then(() => {
        // Only clear if the relay now holds THIS value — a newer click that
        // landed while this call was in flight owns the entry.
        if (this.pendingArchived.get(sessionId) === archived) {
          this.pendingArchived.delete(sessionId);
        }
        this.relayArchived.set(sessionId, archived);
      })
      .catch((error) => this.options.log("remote:set-archived-error", { sessionId, message: commandErrorMessage(error) }))
      // Settled either way: the next drain tick may retry it, and a failed seed
      // that stayed marked in-flight would never be retried at all.
      .finally(() => this.seedingArchived.delete(sessionId)));
  }

  /** Same startup contract as {@link pushKnownStarred}. */
  private pushKnownArchived(): void {
    let pushed = 0;
    let remaining = 0;
    for (const [sessionId, archived] of this.archivedBySession) {
      // "Already agrees" means the relay's OWN value matches ours, not merely
      // that it has a row — a `false` row is a value too, and if it disagreed
      // with a local `true` it needs to be corrected, not treated as seeded.
      if (this.relayArchived.get(sessionId) === archived) continue;
      if (!archived) continue; // see pushKnownStarred
      // Even with the paging read above, a genuinely unseeded backlog must go up
      // as a trickle rather than a burst — one burst is what took the socket
      // down. The rest rides the drain tick, a few seconds later.
      if (pushed >= MAX_SEED_PUSHES) {
        remaining++;
        continue;
      }
      // An in-flight seed write has not reached `relayArchived` yet, so a
      // drain tick landing on top of a slow one would send it a second time.
      if (this.seedingArchived.has(sessionId)) continue;
      this.seedingArchived.add(sessionId);
      pushed++;
      this.pushSessionArchived(sessionId, archived);
    }
    if (remaining > 0) this.options.log("remote:seed-deferred", { kind: "archived", pushed, remaining });
  }

  /**
   * Keep pushing capped seed passes until there is nothing left to seed.
   *
   * Every seed pass is deliberately capped, and for a long time the leftovers
   * simply waited for the next CONNECT — so a Mac with more archived sessions
   * than the cap stayed permanently out of step with the phone, by exactly the
   * overflow, no matter how long it ran. This is the thing that finishes the
   * job. It costs nothing when the sets already agree: both passes walk two maps
   * and send nothing.
   */
  private startSeedDrain(): void {
    if (this.seedTimer) clearInterval(this.seedTimer);
    this.seedTimer = setInterval(() => {
      if (!this.client || !this.credentials) return;
      // Clicks first, always: these are flips the user is waiting to see.
      this.flushPendingArchived();
      this.pushKnownStarred();
      this.pushKnownArchived();
    }, SEED_DRAIN_MS);
    this.seedTimer.unref?.();
  }

  /**
   * Push the desktop's device-local archive set (`localStorage`, not a thread
   * field) up on startup, in case the relay has never seen it — mirroring
   * {@link syncLocalStarredThreads}'s "known-but-unsent" reconciliation.
   */
  syncLocalArchivedThreads(archivedIds: string[]): void {
    let pushed = 0;
    let healed = 0;
    for (const id of archivedIds) {
      // One-time self-heal for a session stuck by the bug this file used to
      // have: local storage (the caller's set, `archivedIds`) is device-local
      // truth, the relay explicitly disagrees with a `false` row, and we hold
      // no persisted memory of ever flipping this id ourselves — so that `false`
      // row cannot be a stale echo of OUR change, it predates any timestamp we
      // have ever recorded. Treat local as authoritative: push `true` (still
      // subject to the usual cap/deferral) and tell the renderer directly,
      // because if `connect`'s replay already fired `archivedChanged(false)`
      // this pass, the renderer needs an explicit correction, not silence.
      // Guarded by `localFlipAt` rather than `archivedChangedAt` — see the
      // comment on that field. Recording the heal as a local flip is also what
      // makes it fire ONCE: from here on this session has a persisted timestamp,
      // so a genuinely newer unarchive from the phone outranks it normally.
      if (this.relayArchived.get(id) === false && !this.localFlipAt.has(id)) {
        this.archivedBySession.set(id, true);
        this.recordLocalFlip(id);
        this.options.archivedChanged?.({ id, archived: true });
        healed++;
        if (this.client && pushed < MAX_SEED_PUSHES) {
          pushed++;
          this.pushSessionArchived(id, true);
        }
        continue;
      }
      if (this.archivedBySession.get(id) === true) continue;
      // Record locally first and unconditionally: this map is what `connect`'s
      // seed pass diffs against, and what stops a later sync re-walking the same
      // ids. Whether it is also SENT is a separate question, below.
      this.archivedBySession.set(id, true);
      // The relay has a value for this one already — either it agrees, or it is
      // a `false` the self-heal above deliberately declined to override (we hold
      // a persisted flip of our own, so that `false` is a real, newer unarchive
      // from the phone). Pushing `true` here would undo the phone's decision on
      // every drain tick; only genuinely unknown sessions get seeded.
      if (this.relayArchived.has(id)) continue;
      // Not connected yet: `pushKnownArchived` runs after `connect` has read the
      // relay's full set, and will know then whether anything is genuinely
      // missing. Sending now, against an empty `relayArchived`, is what turned
      // one renderer startup into 1417 no-op mutations in a single burst.
      if (!this.client) continue;
      // Whatever this pass does not send is now recorded in `archivedBySession`
      // and still disagreeing in `relayArchived`, which is exactly what the
      // drain tick looks for — so the overflow goes up a few seconds later
      // rather than waiting for the next launch.
      if (pushed >= MAX_SEED_PUSHES) continue;
      pushed++;
      this.pushSessionArchived(id, true);
    }
    if (healed > 0) this.options.log("remote:archive-reconciled", { count: healed });
    if (pushed >= MAX_SEED_PUSHES) {
      this.options.log("remote:seed-deferred", { kind: "archived-sync", pushed });
    }
  }

  /**
   * The user renamed a section on the desktop. The relay row carries the title
   * the phone renders, so push it — and remember the rename, so the transcript
   * reader's auto-title can't undo it on the section's next turn.
   */
  setSessionTitle({ id, title }: SessionTitleEvent): void {
    const manual = title.trim();
    if (!manual || this.manualTitles.get(id) === manual) return;
    this.manualTitles.set(id, manual);
    this.pushManualTitle(id);
  }

  /**
   * Reconcile manual titles from the persisted thread store (written on every
   * renderer change). Catches renames this process never saw the event for —
   * chiefly ones made before this build, or before the relay came up.
   */
  syncLocalThreadTitles(threads: Array<{ id: string; title?: string; titleSource?: "auto" | "manual" }>): void {
    for (const thread of threads) {
      const manual = thread.titleSource === "manual" ? thread.title?.trim() : undefined;
      if (!manual) {
        // Back to an auto title: let the transcript readers own it again.
        this.manualTitles.delete(thread.id);
        continue;
      }
      if (this.manualTitles.get(thread.id) === manual) continue;
      this.manualTitles.set(thread.id, manual);
      this.pushManualTitle(thread.id);
    }
  }

  /**
   * Push a section's manual title, once each. Goes through the title-only
   * mutation rather than the session upsert: that one would create a relay row
   * for a section the phone has never seen (a rename would make a long-dormant
   * section pop up as brand new) and would carry mirror status this section may
   * not have. A section with no relay row keeps its title in `manualTitles`,
   * which `mirror()` seeds from, so its first real flush carries it.
   */
  private pushManualTitle(sessionId: string): void {
    const title = this.manualTitles.get(sessionId);
    if (!title || this.pushedTitles.get(sessionId) === title) return;
    if (!this.client || !this.credentials) return;
    this.pushedTitles.set(sessionId, title);
    // Reuse the mirror's cipher cache when there is one, so the next metadata
    // flush doesn't rewrite the row with a fresh nonce for the same name.
    const mirror = this.mirrors.get(sessionId);
    if (mirror) mirror.title = title;
    const titleCipher = mirror
      ? this.stableCipher(mirror, "titleCipher", title)
      : encryptJson(title, this.credentials.key);
    void this.counted("setTitle", this.client
      .mutation(setTitleRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        sessionId,
        titleCipher,
      })
      .catch((error) => {
        this.pushedTitles.delete(sessionId);
        this.options.log("remote:set-title-error", { sessionId, message: commandErrorMessage(error) });
      }));
  }

  private pushKnownManualTitles(): void {
    for (const sessionId of this.manualTitles.keys()) {
      this.pushManualTitle(sessionId);
    }
  }

  async refreshPairingCode(): Promise<RemotePairingInfo> {
    if (!this.url) return this.pairingInfo;
    if (!this.client || !this.credentials) {
      await this.start();
      return this.pairingInfo;
    }
    try {
      this.setPairingInfo({ status: "loading", message: "Creating a secure pairing code…" });
      const code = randomBytes(18).toString("base64url");
      await withTimeout(
        this.client.mutation(createCodeRef, {
          deviceId: this.credentials.deviceId,
          token: this.credentials.token,
          code,
        }),
        RELAY_CALL_TIMEOUT_MS,
        "create pairing code",
      );
      const payload = JSON.stringify({
        url: this.url,
        deviceId: this.credentials.deviceId,
        code,
        k: keyToBase64(this.credentials.key),
      });
      const qrDataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 2, width: 360 });
      this.setPairingInfo({
        status: "ready",
        qrDataUrl,
        code,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    } catch (error) {
      this.setPairingInfo({ status: "error", message: commandErrorMessage(error) });
      // Deliberately NOT reconnecting from here. `connect()` calls this, so a
      // rebuild triggered from inside it races the very attempt that is running
      // — which is how a stale attempt came to close the live client. The
      // heartbeat watchdog owns reconnection; it runs outside any attempt.
    }
    return this.pairingInfo;
  }

  observeLocalEvent(channel: string, payload: unknown): void {
    // The terminal/stdout firehose is deliberately local-only (protocol §5).
    if (channel === "session:data") return;
    if (!isRecord(payload)) return;

    if (channel === "session:started" && isRecord(payload.request) && isSessionStartRequest(payload.request)) {
      const request = payload.request;
      const mirror = this.mirror(request.id);
      mirror.cwd = request.cwd;
      mirror.executionMode = request.executionMode;
      mirror.status = "running";
      mirror.agentState = "working";
      mirror.claudeSessionId = request.claudeSessionId;
      if (request.parentId) mirror.parentSessionId = request.parentId;
      markMetadataDirty(mirror);
      this.scheduleFlush(request.id, true);
      return;
    }

    const id = typeof payload.id === "string" ? payload.id : null;
    if (!id) return;
    const mirror = this.mirror(id);

    switch (channel) {
      case "session:title":
        // An auto-title read out of the transcript never overrides a rename —
        // the renderer applies the same rule to its own list.
        if (this.manualTitles.has(id)) break;
        // Both of these arrive RE-STATED on every stream tick (index.ts re-emits
        // the resolved title/claudeSessionId alongside `session:runtime`), so
        // flagging metadata dirty on arrival rather than on CHANGE put a full
        // `upsertSession` back on the per-second path — exactly what splitting
        // the badge onto `putRuntime` was meant to remove. Diff first.
        if (typeof payload.title === "string" && payload.title !== mirror.title) {
          mirror.title = payload.title;
          markMetadataDirty(mirror);
          this.scheduleFlush(id, true);
        }
        break;
      case "session:claude-session":
        if (typeof payload.claudeSessionId === "string" && payload.claudeSessionId !== mirror.claudeSessionId) {
          mirror.claudeSessionId = payload.claudeSessionId;
          markMetadataDirty(mirror);
          this.scheduleFlush(id, true);
        }
        break;
      case "session:runtime":
        this.observeRuntime(id, payload);
        break;
      case "session:conversation":
        this.observeConversation(id, payload);
        break;
      case "session:prompt-submitted":
        this.scheduleFlush(id, true);
        break;
      case "session:exit":
        mirror.status = "exited";
        mirror.agentState = "exited";
        if (mirror.runtime) {
          mirror.runtime = {
            ...mirror.runtime,
            agentState: "exited",
            currentEventType: "process:exit",
            lastEventAt: new Date().toISOString(),
            pendingApproval: undefined,
            pendingPromptId: undefined,
          };
        }
        markMetadataDirty(mirror);
        this.scheduleFlush(id, true);
        break;
    }
  }

  /**
   * Keychain accounts are scoped per deployment. A device id and token are
   * issued BY a relay, so presenting one deployment's credentials to another
   * fails as an auth error that looks nothing like "you changed the URL". The
   * e2e key is scoped with them because it is shared with the phones paired
   * against that relay, and those pairings do not carry across.
   */
  private credentialAccount(name: string): string {
    return `${name}.${relayScope(this.url)}`;
  }

  private async loadCredentials(): Promise<RelayCredentials> {
    // One-time adoption: before the relay URL was a setting there was a single
    // unscoped credential set. Whatever URL is configured at that moment is the
    // one it belonged to, so claim it for that scope rather than making an
    // already-paired phone re-pair. The marker stops a later, different relay
    // from adopting it too.
    if (!(await readKeychainSecret("relay-scope-migrated"))) {
      const legacyDeviceId = await readKeychainSecret("device-id");
      const legacyToken = await readKeychainSecret("device-token");
      const legacyKey = await readKeychainSecret("e2e-key");
      if (legacyDeviceId && legacyToken && legacyKey) {
        await writeKeychainSecret(this.credentialAccount("device-id"), legacyDeviceId);
        await writeKeychainSecret(this.credentialAccount("device-token"), legacyToken);
        await writeKeychainSecret(this.credentialAccount("e2e-key"), legacyKey);
        this.options.log("remote:credentials-adopted", { scope: relayScope(this.url) });
      }
      await writeKeychainSecret("relay-scope-migrated", "1");
    }

    const storedDeviceId = await readKeychainSecret(this.credentialAccount("device-id"));
    const storedToken = await readKeychainSecret(this.credentialAccount("device-token"));
    const storedKey = await readKeychainSecret(this.credentialAccount("e2e-key"));
    const deviceId = storedDeviceId || randomUUID();
    const token = storedToken || randomToken();
    const key = storedKey ? keyFromBase64(storedKey) : generateSecretboxKey();
    if (!storedDeviceId) await writeKeychainSecret(this.credentialAccount("device-id"), deviceId);
    if (!storedToken) await writeKeychainSecret(this.credentialAccount("device-token"), token);
    if (!storedKey) await writeKeychainSecret(this.credentialAccount("e2e-key"), keyToBase64(key));
    return { deviceId, token, key };
  }

  private setPairingInfo(info: RemotePairingInfo): void {
    this.pairingInfo = info;
    this.options.pairingChanged(info);
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.client || !this.credentials) return;
    // Send the usage snapshot only when it is new to the relay. The heartbeat
    // fires every 12s; re-sending an unchanged multi-KB blob each time rewrote a
    // relay document — and re-fired every phone's `devices:status` subscription —
    // five times a minute to say nothing.
    const usageCipher =
      this.latestUsageCipher && this.latestUsageCipher !== this.sentUsageCipher
        ? this.latestUsageCipher
        : undefined;
    try {
      await withTimeout(
        this.client.mutation(heartbeatRef, {
          deviceId: this.credentials.deviceId,
          token: this.credentials.token,
          appVersion: this.options.appVersion,
          ...(usageCipher ? { usageCipher } : {}),
        }),
        RELAY_CALL_TIMEOUT_MS,
        "heartbeat",
      );
      if (usageCipher) this.sentUsageCipher = usageCipher;
      const previousAck = this.lastHeartbeatAckAt;
      this.lastHeartbeatAckAt = Date.now();
      // One line a minute, plus one the moment it recovers. Successes were
      // silent, so a healthy bridge and a permanently stalled one wrote exactly
      // the same thing to the log — nothing — and "when did it stop" was not
      // answerable at all.
      const recovered = previousAck > 0 && Date.now() - previousAck > HEARTBEAT_MS * 2;
      if (recovered || Date.now() - this.lastHealthLogAt >= HEALTH_LOG_MS) {
        this.lastHealthLogAt = Date.now();
        this.options.log("remote:health", {
          ...(recovered ? { recoveredAfterMs: Date.now() - previousAck } : {}),
          ...describeConnection(this.client),
        });
      }
    } catch (error) {
      this.options.log("remote:heartbeat-error", {
        message: commandErrorMessage(error),
        sinceAckMs: this.lastHeartbeatAckAt > 0 ? Date.now() - this.lastHeartbeatAckAt : null,
        ...describeConnection(this.client),
      });
      // An auth failure is permanent and reconnecting cannot fix it; a socket
      // that stopped answering is exactly what reconnecting is for. Both look
      // the same from here, so the STALENESS window — not this one failure — is
      // what decides, and a genuinely broken deployment just retries once a
      // minute instead of hammering.
      // Measured from the last ack, or — for a socket that has never acked at
      // all — from when this attempt was built. Requiring a prior ack made the
      // never-acked case, which is the common one after a rebuild, invisible.
      const since = this.lastHeartbeatAckAt || this.connectStartedAt;
      if (since > 0 && Date.now() - since > CONNECTION_STALE_MS) {
        void this.reconnect(this.lastHeartbeatAckAt ? "heartbeat-stale" : "heartbeat-never-acked");
      }
    }
  }

  /**
   * Rebuild the connection in place, keeping this deployment's caches.
   *
   * `setUrl` also tears down and restarts, but it is a DEPLOYMENT change: it
   * drops credentials, mirrors and pushed-title state because a different relay
   * knows none of it. Here the relay is the same one and still holds everything,
   * so only the socket is replaced. `start()` re-reads the authoritative starred
   * and archived sets, so those two are the ones that must not be trusted across
   * the gap — it clears them itself.
   */
  private async reconnect(reason: string): Promise<void> {
    if (this.reconnecting || this.stopped || !this.url) return;
    this.reconnecting = true;
    this.options.log("remote:reconnecting", { reason, ...describeConnection(this.client) });
    try {
      this.teardown();
      this.lastHeartbeatAckAt = 0;
      // A rebuild is a fresh chance, not a continuation of the failure that
      // caused it: don't make the user wait out an accumulated backoff.
      this.nextConnectAttemptAt = 0;
      await this.start();
      if (this.client) {
        // Anything buffered while the socket was dead goes up now rather than
        // waiting for the section's next event — a finished turn may produce none.
        for (const [sessionId, mirror] of this.mirrors) {
          if (mirror.pendingItems.size > 0 || mirror.metadataDirty) this.scheduleFlush(sessionId, false);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Refetch the plan-usage snapshot and stash its ciphertext. The heartbeat
   * carries it up; the phone can then render account usage it has no way to
   * fetch on its own (no OAuth creds live on the phone).
   *
   * Re-encrypt only when the numbers moved: `encryptJson` picks a fresh nonce
   * every call, so an unchanged bundle would still produce a "new" ciphertext and
   * defeat the heartbeat's send-once check (same trick as `stableCipher`).
   */
  private async refreshUsage(force = false): Promise<UsageBundle | null> {
    if (!this.credentials) return null;
    try {
      const bundle = await this.options.getUsageBundle(force);
      const hasData =
        (bundle?.claude?.windows.length ?? 0) > 0 || (bundle?.codex?.windows.length ?? 0) > 0;
      if (bundle && hasData) {
        const plain = JSON.stringify(bundle);
        if (plain !== this.latestUsagePlain) {
          this.latestUsagePlain = plain;
          this.latestUsageCipher = encryptJson(bundle, this.credentials.key);
        }
      }
      return bundle;
    } catch (error) {
      this.options.log("remote:usage-error", { message: commandErrorMessage(error) });
      return null;
    }
  }

  private async handlePendingCommands(commands: PendingCommand[]): Promise<void> {
    for (const command of commands) {
      if (this.processingCommands.has(command._id)) continue;
      this.processingCommands.add(command._id);
      void this.executeCommand(command).finally(() => this.processingCommands.delete(command._id));
    }
  }

  private handleStarredRows(rows: StarredRow[]): void {
    for (const row of rows) {
      const previous = this.starredBySession.get(row.sessionId);
      // Recorded even when it matches what we already had: this is what tells
      // `pushKnownStarred` the relay already agrees, so startup doesn't fire a
      // no-op mutation per session (see there).
      this.starredOnRelay.add(row.sessionId);
      if (previous === row.starred) continue;
      this.starredBySession.set(row.sessionId, row.starred);
      const mirror = this.mirror(row.sessionId);
      mirror.starred = row.starred;
      this.options.starredChanged?.({ id: row.sessionId, starred: row.starred });
    }
  }

  private handleArchivedRows(rows: ArchivedRow[]): void {
    for (const row of rows) {
      const previous = this.archivedBySession.get(row.sessionId);
      this.relayArchived.set(row.sessionId, row.archived);
      // A flip of ours the relay has not accepted yet always wins: this row is
      // the state from BEFORE that click, and applying it would silently undo
      // what the user just did. `flushPendingArchived` sends it instead.
      if (this.pendingArchived.has(row.sessionId)) continue;
      // Same rule for a row written before our last local change. `archivedRows`
      // are replayed in full on every connect, so without this an old `false`
      // outranks a newer local `true` purely because it arrived later.
      const changedAt = this.archivedChangedAt.get(row.sessionId);
      if (changedAt !== undefined && row.updatedAt < changedAt) continue;
      if (previous === row.archived) continue;
      this.archivedBySession.set(row.sessionId, row.archived);
      // In-memory only, and NOT a local flip: this is the relay's timestamp for
      // someone else's decision. See `localFlipAt` for why persisting it here
      // would disqualify the session from ever self-healing.
      this.archivedChangedAt.set(row.sessionId, row.updatedAt);
      this.options.archivedChanged?.({ id: row.sessionId, archived: row.archived });
    }
  }

  /**
   * Send the archive flips that never reached the relay. Runs on every connect,
   * after the authoritative read — uncapped, unlike the {@link pushKnownArchived}
   * seed pass, because these are individual clicks the user made and is waiting
   * to see honoured, not a thousand-row historical backlog.
   */
  private flushPendingArchived(): void {
    for (const [sessionId, archived] of this.pendingArchived) {
      this.pushSessionArchived(sessionId, archived);
    }
  }

  private async executeCommand(command: PendingCommand): Promise<void> {
    if (!this.client || !this.credentials) return;
    const auth = { deviceId: this.credentials.deviceId, token: this.credentials.token };
    try {
      if (Date.now() - command.createdAt > COMMAND_MAX_AGE_MS) {
        throw new Error("Remote command expired before it reached the desktop.");
      }
      const claim = await this.client.mutation(claimRef, { ...auth, commandId: command._id });
      if (!claim.claimed) return;
      const result = await this.dispatchCommand(command);
      await this.client.mutation(ackRef, {
        ...auth,
        commandId: command._id,
        status: result.succeeded ? "done" : "error",
        resultCipher: encryptJson(result.payload, this.credentials.key),
      });
    } catch (error) {
      const message = commandErrorMessage(error);
      this.options.log("remote:command-error", { commandId: command._id, type: command.type, message });
      try {
        await this.client.mutation(ackRef, {
          ...auth,
          commandId: command._id,
          status: "error",
          resultCipher: encryptJson({ message }, this.credentials.key),
        });
      } catch (ackError) {
        this.options.log("remote:ack-error", { commandId: command._id, message: commandErrorMessage(ackError) });
      }
    }
  }

  private dispatchCommand(command: PendingCommand): CommandDispatchResult | Promise<CommandDispatchResult> {
    if (!this.credentials) throw new Error("Relay credentials are unavailable.");
    if (!this.commandGuard) throw this.commandGuardError ?? new Error("Remote replay protection is unavailable.");
    const envelope = this.commandGuard.open(command, this.credentials.deviceId, this.credentials.key);
    this.commandGuard.consume(envelope);
    if (command.sessionId && ["input", "queue", "switch", "btw", "approve"].includes(command.type)) this.assertRemoteSession(command.sessionId);
    // Existing handlers consume the inner payload. Only this authenticated entry
    // point is reachable from the relay; routing and replay checks precede effects.
    command = { ...command, payloadCipher: encryptJson(envelope.payload, this.credentials.key) };
    switch (command.type) {
      case "start":
        return this.dispatchStart(command);
      case "input":
        return this.dispatchInput(command);
      case "queue":
        return this.dispatchQueue(command);
      case "stop":
        if (!command.sessionId) throw new Error("Stop command is missing sessionId.");
        this.options.sessionService.stopSession({ id: command.sessionId });
        return { succeeded: true, payload: { message: "Session stopped." } };
      case "notification-settings": {
        if (!command.sessionId || !command.payloadCipher) throw new Error("Notification settings need a section and payload.");
        const payload = decryptJson(command.payloadCipher, this.credentials!.key);
        if (!isRecord(payload) || (payload.op !== "get" && payload.op !== "set")) throw new Error("Invalid notification settings operation.");
        if (!this.options.notificationSettings) throw new Error("Update Panda Code on the Mac to manage notification channels.");
        const patch = payload.op === "set" ? {
          ...(typeof payload.desktop === "boolean" ? { desktop: payload.desktop } : {}),
          ...(typeof payload.agent === "boolean" ? { agent: payload.agent } : {}),
        } : undefined;
        return { succeeded: true, payload: { settings: this.options.notificationSettings(command.sessionId, patch) } };
      }
      case "switch": {
        if (!command.sessionId) throw new Error("Switch command is missing sessionId.");
        if (!command.payloadCipher) throw new Error("Switch command is missing its encrypted payload.");
        const payload = decryptJson(command.payloadCipher, this.credentials.key);
        if (!isRemoteLaunchOverridePayload(payload)) throw new Error("Invalid switch payload.");
        // Validate a sandbox/permission change against the same allowlist as a
        // remote start — but only when one is actually being changed, so a
        // model-only switch never silently resets an existing sandbox. Validate
        // against the TARGET runtime (a provider switch also swaps sandbox rules).
        const targetRuntime = payload.runtime ?? this.mirror(command.sessionId).runtime?.runtime ?? "claude";
        const permissionMode = cleanOptionalString(payload.permissionMode)
          ? assertRemotePermission(targetRuntime, payload.permissionMode, this.options.allowRemoteFullAccess?.() === true)
          : payload.permissionMode;
        this.options.sessionService.switchSession({
          id: command.sessionId,
          runtime: payload.runtime,
          model: payload.model,
          effort: payload.effort,
          permissionMode,
        });
        const runtimeLabel =
          payload.runtime === "codex" ? "Codex" : payload.runtime === "groq" ? "Groq" : "Claude";
        const message = payload.runtime
          ? `Switched to ${runtimeLabel} for the next message.`
          : "Model updated for the next message.";
        return { succeeded: true, payload: { message } };
      }
      case "btw":
        return this.dispatchBtw(command);
      case "usage-cost":
        return this.dispatchUsageCost(command);
      case "session-files":
        return this.dispatchSessionFiles(command);
      case "usage-refresh":
        return this.dispatchUsageRefresh();
      case "backlog":
        return this.dispatchBacklog(command);
      case "schedule":
        return this.dispatchSchedule(command);
      case "git-status":
        return this.dispatchGitStatus(command);
      case "machine-stats":
        return this.dispatchMachineStats();
      case "scratch-workspace":
        return this.dispatchScratchWorkspace();
      case "media":
        return this.dispatchMedia(command);
      case "approve":
      case "deny":
        return this.dispatchApproval(command);
    }
  }

  /**
   * Start a phone-composed session, and — when the command carries one — deliver
   * its first prompt before acking. Awaited as one unit so the phone learns the
   * turn actually landed: a start that succeeds but whose prompt is refused is
   * reported as a failure, because a bare running session is not what was asked
   * for and would sit there looking busy with nothing in it.
   */
  private async dispatchStart(command: PendingCommand): Promise<CommandDispatchResult> {
    if (!command.payloadCipher) throw new Error("Start command is missing its encrypted payload.");
    const payload = decryptJson(command.payloadCipher, this.credentials!.key);
    if (!isRemoteSessionStartPayload(payload)) throw new Error("Invalid remote session start payload.");
    if (!this.options.isRemoteWorkspaceAllowed(payload.cwd)) {
      throw new Error("Workspace is not trusted for remote start. Open it in the desktop app first.");
    }
    const request = buildRemoteSessionStartRequest(payload, this.options.allowRemoteFullAccess?.() === true);
    const result = this.options.sessionService.startSession(request);
    if (!result.ok) return { succeeded: false, payload: result };

    const mirror = this.mirror(request.id);
    mirror.startedByMobileId = command.mobileId;
    mirror.notifyOnExit = true;
    markMetadataDirty(mirror);
    this.scheduleFlush(request.id, true);

    const prompt = payload.prompt ?? "";
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : undefined;
    if (!prompt.trim() && !attachments?.length) {
      return { succeeded: true, payload: result };
    }
    const sent = await this.deliverPrompt(request.id, prompt, attachments);
    if (!sent.ok) return { succeeded: false, payload: { message: sent.message ?? "Could not send the prompt." } };
    return { succeeded: true, payload: { ...result, message: "Session started." } };
  }

  /**
   * Deliver a phone-issued prompt. Awaited: the Codex app-server transport
   * reports queued-vs-refused truthfully, and the phone shows that result.
   */
  private async dispatchInput(command: PendingCommand): Promise<CommandDispatchResult> {
    if (!command.sessionId) throw new Error("Input command is missing sessionId.");
    if (!command.payloadCipher) throw new Error("Input command is missing its encrypted payload.");
    const payload = decryptJson(command.payloadCipher, this.credentials!.key);
    if (!isRecord(payload) || typeof payload.data !== "string") throw new Error("Invalid input payload.");
    const sent = await this.deliverPrompt(command.sessionId, payload.data, payload.attachments);
    if (!sent.ok) return { succeeded: false, payload: { message: sent.message ?? "Could not send the input." } };
    return { succeeded: true, payload: { message: "Input sent." } };
  }

  /**
   * Add, remove, or immediately promote a phone-queued prompt. This is the
   * durable half of mobile's "queue a follow-up" composer state — the entry
   * lives here (main process), not on the phone, so it survives the phone
   * being killed and reopened; `observeRuntime`'s auto-flush hook sends it on
   * once the turn it's queued behind finishes.
   */
  private async dispatchQueue(command: PendingCommand): Promise<CommandDispatchResult> {
    if (!command.sessionId) throw new Error("Queue command is missing sessionId.");
    if (!command.payloadCipher) throw new Error("Queue command is missing its encrypted payload.");
    const payload = decryptJson(command.payloadCipher, this.credentials!.key);
    if (!isRecord(payload) || typeof payload.action !== "string" || typeof payload.id !== "string") {
      throw new Error("Invalid queue payload.");
    }
    const sessionId = command.sessionId;
    const mirror = this.mirror(sessionId);

    if (payload.action === "add") {
      if (typeof payload.data !== "string") throw new Error("Invalid queue payload.");
      const attachments = payload.attachments;
      // The phone may have queued against a stale badge, or the turn ended
      // while this command was in transit. No future waiting tick is promised
      // for an idle/exited section: deliver now and report the real outcome.
      if (mirror.agentState === "waiting" || mirror.agentState === "exited") {
        const sent = await this.deliverPrompt(sessionId, payload.data, attachments);
        return {
          succeeded: sent.ok,
          payload: { message: sent.ok ? "Sent." : sent.message ?? "Could not send the prompt." },
        };
      }
      mirror.queuedPrompts.push({
        id: payload.id,
        data: payload.data,
        attachments,
        imageCount: Array.isArray(attachments) ? attachments.length : 0,
        queuedAt: Date.now(),
      });
      this.syncQueuedPrompts(sessionId);
      return { succeeded: true, payload: { message: "Queued." } };
    }

    if (payload.action === "remove") {
      mirror.queuedPrompts = mirror.queuedPrompts.filter((entry) => entry.id !== payload.id);
      this.syncQueuedPrompts(sessionId);
      return { succeeded: true, payload: { message: "Removed." } };
    }

    if (payload.action === "send-now") {
      const entry = mirror.queuedPrompts.find((e) => e.id === payload.id);
      if (!entry) return { succeeded: true, payload: { message: "Already sent." } };
      mirror.queuedPrompts = mirror.queuedPrompts.filter((e) => e.id !== payload.id);
      this.syncQueuedPrompts(sessionId);
      const sent = await this.deliverPrompt(sessionId, entry.data, entry.attachments);
      if (!sent.ok) return { succeeded: false, payload: { message: sent.message ?? "Could not send the prompt." } };
      return { succeeded: true, payload: { message: "Sent." } };
    }

    throw new Error(`Unknown queue action: ${payload.action}`);
  }

  private assertRemoteSession(sessionId: string): void {
    const request = this.options.sessionService.getRequest?.(sessionId);
    if (!request || request.executionMode === "terminal") throw new Error("This session is not available for secure phone control.");
    const effective = effectiveRemotePermission(request);
    assertRemotePermission(effective.runtime, effective.permissionMode, this.options.allowRemoteFullAccess?.() === true);
  }

  /** Shared by `input` and the first turn of a prompt-carrying `start`. */
  private async deliverPrompt(
    sessionId: string,
    data: string,
    attachments: unknown,
  ): Promise<{ ok: boolean; message?: string }> {
    this.assertRemoteSession(sessionId);
    const imagePaths = saveRemoteImageAttachments(attachments, this.options.userDataPath ?? process.cwd());
    const sent = await this.options.sessionService.sendInput({
      id: sessionId,
      // The text keeps its readable attachment list (that is what both renderers
      // build thumbnails from); `imagePaths` is what actually reaches the model.
      data: promptWithImageAttachments(data, imagePaths),
      imagePaths,
    });
    if (!sent.ok) {
      this.options.log("remote:input-dropped", { sessionId, message: sent.message });
      return sent;
    }
    // Tell the window, which had no way to know: this path runs entirely in the
    // main process. Sent AFTER delivery so a dropped prompt never leaves a
    // bubble for a message the session never received.
    this.options.remotePromptDelivered?.({ id: sessionId, body: data, timestamp: Date.now() });
    return sent;
  }

  /**
   * Answer a Codex approval from the phone (docs/protocol.md §6). `approve`/`deny`
   * map onto the once-off decisions; a payload may also name an explicit
   * `optionId`/`text`, which is how a `requestUserInput` question gets answered.
   */
  private dispatchApproval(command: PendingCommand): CommandDispatchResult {
    if (!command.sessionId) throw new Error("Approval command is missing sessionId.");
    if (!command.payloadCipher) throw new Error("Approval command is missing its encrypted payload.");
    const payload = decryptJson(command.payloadCipher, this.credentials!.key);
    if (!isRecord(payload) || typeof payload.promptId !== "string" || !payload.promptId.trim()) {
      throw new Error("Approval command is missing promptId.");
    }
    const optionId =
      cleanOptionalString(typeof payload.optionId === "string" ? payload.optionId : undefined) ??
      (command.type === "approve" ? "accept" : "decline");
    if (optionId !== "decline" && this.options.allowRemoteFullAccess?.() !== true) {
      throw new Error("Grant this approval on the Mac. Phone approvals are disabled in the Mac's phone access settings.");
    }
    const result = this.options.sessionService.answerApproval({
      id: command.sessionId,
      promptId: payload.promptId.trim(),
      optionId,
      text: cleanOptionalString(typeof payload.text === "string" ? payload.text : undefined),
    });
    this.options.log("remote:approval", {
      sessionId: command.sessionId,
      promptId: payload.promptId,
      optionId,
      ok: result.ok,
    });
    if (!result.ok) {
      return { succeeded: false, payload: { message: result.message } };
    }
    return { succeeded: true, payload: { message: command.type === "approve" ? "Approved." : "Denied." } };
  }

  /**
   * Answer a phone-issued /btw side question. Forks the session's live Claude
   * context into a throwaway, read-only aside (same as the desktop panel) and
   * rides the answer back through the command's `resultCipher`. Request/response
   * rather than live-streamed — a pragmatic fit for the mobile round-trip.
   */
  private async dispatchBtw(command: PendingCommand): Promise<CommandDispatchResult> {
    if (!command.sessionId) throw new Error("/btw command is missing sessionId.");
    if (!command.payloadCipher) throw new Error("/btw command is missing its encrypted payload.");
    const payload = decryptJson(command.payloadCipher, this.credentials!.key);
    if (!isRecord(payload) || typeof payload.question !== "string" || !payload.question.trim()) {
      throw new Error("Ask a question after /btw.");
    }
    const mirror = this.mirror(command.sessionId);
    if (!mirror.cwd) throw new Error("This session isn't ready for /btw yet.");
    const runtime = mirror.runtime?.runtime ?? "claude";
    const result = await this.options.runBtw({
      threadId: command.sessionId,
      cwd: mirror.cwd,
      runtime,
      question: payload.question.trim(),
      parentClaudeSessionId: mirror.claudeSessionId,
      codexThreadId: mirror.runtime?.codexThreadId,
      model: mirror.runtime?.latestModel,
    });
    return {
      succeeded: result.ok,
      payload: { message: result.ok ? result.answer ?? "" : result.message ?? "The /btw question failed." },
    };
  }

  /**
   * Answer a phone-issued usage/cost report. Either scoped to one session (the
   * mobile session info sheet) or to a date range (the mobile usage screen). The
   * ledger lives only on the desktop, so this is a plain request/response —
   * nothing about spend is ever stored on the relay in the clear.
   */
  private dispatchUsageCost(command: PendingCommand): CommandDispatchResult {
    const payload = command.payloadCipher ? decryptJson(command.payloadCipher, this.credentials!.key) : {};
    const query: UsageCostQuery = {};
    const field = (value: unknown): string | undefined =>
      typeof value === "string" ? cleanOptionalString(value) : undefined;
    if (isRecord(payload)) {
      // A session-scoped request may either name the session in the payload or
      // ride on the command's own sessionId.
      const sessionId = field(payload.sessionId) ?? command.sessionId;
      if (sessionId) query.sessionId = sessionId;
      const fromIso = field(payload.fromIso);
      const toIso = field(payload.toIso);
      if (fromIso) query.fromIso = fromIso;
      if (toIso) query.toIso = toIso;
    } else if (command.sessionId) {
      query.sessionId = command.sessionId;
    }
    return { succeeded: true, payload: { report: this.options.loadUsageCost(query) } };
  }

  /**
   * Mobile-triggered "Refresh" tap on the plan-usage sheet — same force path as
   * the desktop's own refresh button: bypass the periodic cache floor (but not
   * an active rate-limit cooldown) and answer with the bundle directly, rather
   * than making the phone wait for the next heartbeat's slow-timer refresh.
   * Also pushes the freshened snapshot up immediately so other reads of it
   * (`deviceStatus`) don't lag behind this answer.
   */
  private async dispatchUsageRefresh(): Promise<CommandDispatchResult> {
    const bundle = await this.refreshUsage(true);
    this.heartbeatNow();
    return { succeeded: true, payload: { bundle } };
  }

  /**
   * Answer "what did this section change?" for the phone. The attribution needs
   * the section's transcript and the counts need its working tree, and neither
   * exists on the relay — so, like `usage-cost`, this is a request/response the
   * desktop answers from local state and returns encrypted.
   */
  /**
   * Read or edit a workspace's kanban board from the phone.
   *
   * The board is a file on this Mac that agents also write from their own
   * processes, so there is no useful copy of it on the relay to keep in sync —
   * the phone asks, the desktop applies it to the file as it stands right now,
   * and the whole board comes back. Every operation answers with the full board
   * for the same reason the desktop's IPC does: a phone holding a diff of a file
   * three other writers are editing would be inventing state.
   *
   * The workspace path rides inside the encrypted payload; the relay never sees
   * which folder is being read.
   */
  private dispatchBacklog(command: PendingCommand): CommandDispatchResult {
    if (!command.payloadCipher) throw new Error("Backlog command is missing its encrypted payload.");
    const payload = decryptJson(command.payloadCipher, this.credentials!.key);
    if (!isRecord(payload) || typeof payload.cwd !== "string" || !payload.cwd) {
      throw new Error("Invalid backlog payload.");
    }
    // Same trust gate as a remote session start: the phone may only reach a
    // workspace the desktop already knows about, so a stolen phone token cannot
    // read arbitrary folders' boards by guessing paths.
    if (!this.options.isRemoteWorkspaceAllowed(payload.cwd)) {
      throw new Error("Workspace is not trusted for remote access. Open it in the desktop app first.");
    }

    const result = this.options.applyBacklog({
      cwd: payload.cwd,
      op: typeof payload.op === "string" ? payload.op : "list",
      id: typeof payload.id === "string" ? payload.id : undefined,
      title: typeof payload.title === "string" ? payload.title : undefined,
      // The phone has sent a summary since it could edit one; this end was
      // dropping it on the floor, so a TL;DR rewritten on the phone came back
      // unchanged and looked like the edit had failed.
      summary: typeof payload.summary === "string" ? payload.summary : undefined,
      description: typeof payload.description === "string" ? payload.description : undefined,
      metadata: typeof payload.metadata === "string" ? payload.metadata : undefined,
      column: typeof payload.column === "string" ? payload.column : undefined,
      onHold: typeof payload.onHold === "boolean" ? payload.onHold : undefined,
      index: typeof payload.index === "number" ? payload.index : undefined,
      verificationNotes: typeof payload.verificationNotes === "string" ? payload.verificationNotes : undefined,
      removeAttachmentIds: Array.isArray(payload.removeAttachmentIds)
        ? payload.removeAttachmentIds.filter((id): id is string => typeof id === "string")
        : undefined,
    });
    if (!result.ok) return { succeeded: false, payload: { message: result.message } };
    return { succeeded: true, payload: { backlog: result.backlog } };
  }

  /**
   * Read a workspace's schedule from the phone. View-only in V1: mobile can
   * see what is scheduled and by whom, but creating or editing a job is a
   * desktop/agent-only action for now — same trust gate as the backlog.
   */
  private dispatchSchedule(command: PendingCommand): CommandDispatchResult {
    if (!command.payloadCipher) throw new Error("Schedule command is missing its encrypted payload.");
    const payload = decryptJson(command.payloadCipher, this.credentials!.key);
    if (!isRecord(payload) || typeof payload.cwd !== "string" || !payload.cwd) {
      throw new Error("Invalid schedule payload.");
    }
    if (!this.options.isRemoteWorkspaceAllowed(payload.cwd)) {
      throw new Error("Workspace is not trusted for remote access. Open it in the desktop app first.");
    }

    const schedule = this.options.loadRemoteSchedule(payload.cwd);
    return { succeeded: true, payload: { schedule } };
  }

  /**
   * Read a workspace's git status from the phone — branch, ahead/behind,
   * changed files, stashes, worktrees, branches. Same trust gate and
   * disk-backed reasoning as the backlog/schedule: only the desktop can see
   * the working tree, so this is a request/response the phone can't cache.
   *
   * `view` picks what: the status (default), a page of `git log`, one directory
   * of the file tree, one text file, or — the one writer here — `write`, which
   * saves an edited document back. They are all the same look at one trusted
   * workspace through one gate, so they share a command kind rather than
   * spending relay schema literals; the payload is opaque ciphertext to the
   * relay either way.
   */
  private async dispatchGitStatus(command: PendingCommand): Promise<CommandDispatchResult> {
    if (!command.payloadCipher) throw new Error("Git status command is missing its encrypted payload.");
    const payload = decryptJson(command.payloadCipher, this.credentials!.key);
    if (!isRecord(payload) || typeof payload.cwd !== "string" || !payload.cwd) {
      throw new Error("Invalid git status payload.");
    }
    if (!this.options.isRemoteWorkspaceAllowed(payload.cwd)) {
      throw new Error("Workspace is not trusted for remote access. Open it in the desktop app first.");
    }

    if (payload.view === "log") {
      const log = await this.options.loadRemoteGitLog({
        cwd: payload.cwd,
        skip: typeof payload.skip === "number" ? payload.skip : undefined,
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
      });
      return { succeeded: true, payload: { log } };
    }

    if (payload.view === "actions") {
      if (!this.options.loadRemoteWorkflowRuns) {
        throw new Error("GitHub Actions are unavailable in this desktop build.");
      }
      const workflows = await this.options.loadRemoteWorkflowRuns({
        cwd: payload.cwd,
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
      });
      return { succeeded: true, payload: { workflows } };
    }

    if (payload.view === "write") {
      const saved = this.options.writeRemoteFile({
        cwd: payload.cwd,
        path: typeof payload.path === "string" ? payload.path : "",
        content: typeof payload.content === "string" ? payload.content : "",
      });
      return { succeeded: true, payload: { saved } };
    }

    if (payload.view === "file") {
      const file = this.options.loadRemoteFile({
        cwd: payload.cwd,
        path: typeof payload.path === "string" ? payload.path : "",
        maxBytes: typeof payload.maxBytes === "number" ? payload.maxBytes : undefined,
      });
      return { succeeded: true, payload: { file } };
    }

    if (payload.view === "tree") {
      const tree = await this.options.loadRemoteTree({
        cwd: payload.cwd,
        path: typeof payload.path === "string" ? payload.path : undefined,
      });
      return { succeeded: true, payload: { tree } };
    }

    const status = await this.options.loadRemoteGitStatus(payload.cwd);
    return { succeeded: true, payload: { status } };
  }

  /**
   * The Mac's own vital signs, on demand.
   *
   * Deliberately NOT carried on the heartbeat: CPU and RSS move every second, so
   * a snapshot on each beat would rewrite the device document five times a
   * minute and re-fire every phone's `devices:status` subscription — the exact
   * cost the usage blob was moved off that path to avoid. The phone asks when
   * the sheet is open, and only then.
   */
  private async dispatchMachineStats(): Promise<CommandDispatchResult> {
    const stats = await this.options.loadMachineStats(true);
    return { succeeded: true, payload: { stats } };
  }

  /**
   * The shared "no project" scratch folder, for a phone that wants to pin a
   * "No project" entry without waiting to see a session already running
   * there. Mirrors the renderer's own `directory:ensure-scratch` IPC call —
   * same underlying folder, created if missing.
   */
  private async dispatchScratchWorkspace(): Promise<CommandDispatchResult> {
    const path = await this.options.ensureRemoteScratchWorkspace();
    return { succeeded: true, payload: { path } };
  }

  /**
   * A browser screenshot or recording, on demand.
   *
   * Unlike every other request/response command, the answer does not fit in
   * `resultCipher` — Convex's 1 MiB document cap is what `image_prep.dart`
   * fights on the way IN, and a recording is bigger still. So this command's
   * OWN result stays tiny (`{storageId, mimeType}`); the bytes travel as a
   * sealed envelope (same `encryptJson` shape as everything else, just too
   * big to inline) through Convex file storage, which has no such cap. See
   * `media.ts` on the relay for the ownership/auth gate on the other end.
   */
  private async dispatchMedia(command: PendingCommand): Promise<CommandDispatchResult> {
    if (!this.client) throw new Error("Relay connection is unavailable.");
    const client = this.client;
    if (!command.payloadCipher) throw new Error("Media command is missing its encrypted payload.");
    const payload = decryptJson(command.payloadCipher, this.credentials!.key);
    if (!isRecord(payload) || typeof payload.path !== "string" || !payload.path) {
      throw new Error("Invalid media payload.");
    }
    const { mimeType, bytes } = await this.options.readBrowserMedia({ path: payload.path });
    const envelope = encryptJson({ dataBase64: bytes.toString("base64") }, this.credentials!.key);

    const auth = { deviceId: this.credentials!.deviceId, token: this.credentials!.token };
    const uploadUrl = await client.mutation(mediaUploadUrlRef, auth);
    const uploaded = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Authorization": `Bearer ${auth.token}`, "X-Panda-Device": auth.deviceId },
      body: envelope,
    });
    if (!uploaded.ok) throw new Error(`Could not upload media to the relay (HTTP ${uploaded.status}).`);
    const { storageId } = (await uploaded.json()) as { storageId: string };
    await client.mutation(mediaRegisterBlobRef, { ...auth, storageId, mimeType });

    return { succeeded: true, payload: { storageId, mimeType } };
  }

  private async dispatchSessionFiles(command: PendingCommand): Promise<CommandDispatchResult> {
    if (!command.sessionId) throw new Error("Changed-files command is missing sessionId.");
    const mirror = this.mirror(command.sessionId);
    if (!mirror.cwd) throw new Error("This session has no workspace yet.");
    const changes = await this.options.loadSessionFiles({
      sessionId: command.sessionId,
      cwd: mirror.cwd,
      claudeSessionId: mirror.claudeSessionId,
      codexThreadId: mirror.runtime?.codexThreadId,
    });
    return { succeeded: true, payload: { changes } };
  }

  private mirror(sessionId: string): MirrorState {
    let mirror = this.mirrors.get(sessionId);
    if (!mirror) {
      mirror = {
        status: "idle",
        agentState: "exited",
        executionMode: "stream-json",
        // A section the user renamed by hand keeps that name on the phone: seed
        // the mirror from the known manual titles so the first flush carries it
        // instead of whatever the transcript reader last resolved.
        title: this.manualTitles.get(sessionId),
        metadataDirty: false,
        metadataVersion: 0,
        registered: false,
        pendingItems: new Map(),
        sentItems: new Map(),
        flushing: false,
        queuedPrompts: [],
        autoFlushingQueue: false,
      };
      this.mirrors.set(sessionId, mirror);
    }
    return mirror;
  }

  /** Encrypt once per distinct plaintext; see `MirrorState.titleCipher`. */
  private stableCipher(mirror: MirrorState, field: "titleCipher" | "cwdCipher", plain: string): string {
    const cached = mirror[field];
    if (cached?.plain === plain) {
      return cached.cipher;
    }
    const cipher = encryptJson(plain, this.credentials!.key);
    mirror[field] = { plain, cipher };
    return cipher;
  }

  private observeRuntime(sessionId: string, payload: Record<string, unknown>): void {
    if (!isExecutionMode(payload.executionMode)) return;
    if (
      payload.agentState !== "working" &&
      payload.agentState !== "waiting" &&
      payload.agentState !== "needs_action" &&
      payload.agentState !== "exited"
    ) return;
    if (typeof payload.currentEventType !== "string" || typeof payload.lastEventAt !== "string") return;
    const tokenUsage = readTokenUsage(payload.tokenUsage);
    const runtime: Omit<SessionRuntimeEvent, "id"> = {
      executionMode: payload.executionMode,
      ...(isAgentRuntime(payload.runtime) ? { runtime: payload.runtime } : {}),
      agentState: payload.agentState,
      currentEventType: payload.currentEventType,
      lastEventAt: payload.lastEventAt,
      ...(typeof payload.latestTool === "string" ? { latestTool: payload.latestTool } : {}),
      ...(typeof payload.latestCommand === "string" ? { latestCommand: payload.latestCommand } : {}),
      ...(typeof payload.latestModel === "string" ? { latestModel: payload.latestModel } : {}),
      ...(typeof payload.latestAssistantText === "string" ? { latestAssistantText: payload.latestAssistantText } : {}),
      ...(typeof payload.claudeSessionId === "string" ? { claudeSessionId: payload.claudeSessionId } : {}),
      ...(typeof payload.codexThreadId === "string" ? { codexThreadId: payload.codexThreadId } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      // What Codex is blocked on, so the phone can render Approve/Deny (or the
      // question's options) and answer with the exact promptId.
      ...(isRecord(payload.pendingApproval) ? { pendingApproval: payload.pendingApproval as PendingApproval } : {}),
      ...(typeof payload.pendingPromptId === "string" ? { pendingPromptId: payload.pendingPromptId } : {}),
    };
    const mirror = this.mirror(sessionId);
    const status: SessionStatus =
      runtime.agentState === "exited" ? "exited" : runtime.currentEventType === "process:error" ? "error" : "running";
    // A runtime tick arrives about once a second per streaming session, and only
    // rarely carries a change to the low-churn state on the relay's `sessions`
    // row. Flagging it dirty regardless meant a full `upsertSession` — which
    // reads that row and its notification subscriptions to diff them — every
    // second, for a badge refresh. Diff here instead, and let the badge take the
    // `putRuntime` path (see `flushSession`).
    if (
      mirror.executionMode !== runtime.executionMode ||
      mirror.agentState !== runtime.agentState ||
      mirror.status !== status ||
      (runtime.claudeSessionId !== undefined && mirror.claudeSessionId !== runtime.claudeSessionId) ||
      !mirror.registered
    ) {
      markMetadataDirty(mirror);
    }
    if (mirror.queuedPrompts.length > 0) runtime.queuedPrompts = toQueuedPromptSync(mirror.queuedPrompts);
    mirror.runtime = runtime;
    mirror.executionMode = runtime.executionMode;
    mirror.agentState = runtime.agentState;
    mirror.status = status;
    if (runtime.claudeSessionId) mirror.claudeSessionId = runtime.claudeSessionId;
    this.scheduleFlush(sessionId, runtime.agentState === "exited" || runtime.agentState === "needs_action");
    // The turn just ended with something queued behind it — flush the oldest
    // entry now instead of waiting for the user to notice and tap "send now".
    // Guarded by `autoFlushingQueue` because a "waiting" tick can repeat before
    // this delivery (and the `working` tick it causes) lands.
    const next = mirror.queuedPrompts[0];
    if (runtime.agentState === "waiting" && next && !mirror.autoFlushingQueue) {
      mirror.autoFlushingQueue = true;
      void this.flushQueuedPrompt(sessionId, next.id).finally(() => {
        mirror.autoFlushingQueue = false;
      });
    }
  }

  /** Deliver the queued entry [id] (if still queued) and drop it from the queue. */
  private async flushQueuedPrompt(sessionId: string, id: string): Promise<void> {
    const mirror = this.mirror(sessionId);
    const entry = mirror.queuedPrompts.find((q) => q.id === id);
    if (!entry) return;
    mirror.queuedPrompts = mirror.queuedPrompts.filter((q) => q.id !== id);
    this.syncQueuedPrompts(sessionId);
    const sent = await this.deliverPrompt(sessionId, entry.data, entry.attachments);
    if (!sent.ok) {
      this.options.log("remote:queued-prompt-dropped", { sessionId, message: sent.message });
    }
  }

  /**
   * Patch the queue's display copy into `mirror.runtime` and push it now,
   * rather than waiting for the next incidental runtime tick — the phone is
   * usually looking right at this list when it changes (added/removed/sent).
   */
  private syncQueuedPrompts(sessionId: string): void {
    const mirror = this.mirror(sessionId);
    if (!mirror.runtime) return;
    mirror.runtime = { ...mirror.runtime, queuedPrompts: toQueuedPromptSync(mirror.queuedPrompts) };
    this.scheduleFlush(sessionId, true);
  }

  private observeConversation(sessionId: string, payload: Record<string, unknown>): void {
    if (!Array.isArray(payload.items)) return;
    const mirror = this.mirror(sessionId);
    for (const candidate of payload.items) {
      if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.body !== "string") continue;
      const item = candidate as ConversationItem;
      if (item.kind !== "user" && item.kind !== "assistant" && item.kind !== "tool" && item.kind !== "system" && item.kind !== "marker") continue;
      // Fingerprint on STABLE content only. `sequence` is a per-StreamJsonState
      // counter re-stamped on every state rebuild/replay/resume (stream-json.ts
      // `pushItem`), so including it here made an idle session's items look
      // "changed" on each replay and re-append forever — climbing the relay
      // headSeq and leaving the mobile tail spinning. Mobile ignores `sequence`
      // (it dedups by id + sorts by timestamp), so it is safe to exclude.
      const serialized = stableItemFingerprint(item);
      if (mirror.sentItems.get(item.id) !== serialized) {
        mirror.pendingItems.set(item.id, { item, serialized });
      }
    }
    if (typeof payload.claudeSessionId === "string") mirror.claudeSessionId = payload.claudeSessionId;
    if (mirror.pendingItems.size > 0) this.scheduleFlush(sessionId, false);
  }

  private scheduleFlush(sessionId: string, immediate: boolean): void {
    const mirror = this.mirror(sessionId);
    if (immediate && mirror.timer) {
      clearTimeout(mirror.timer);
      mirror.timer = undefined;
    }
    if (mirror.timer || mirror.flushing) return;
    mirror.timer = setTimeout(
      () => {
        mirror.timer = undefined;
        void this.flushSession(sessionId);
      },
      // An `immediate` flush that is only going to hit backpressure anyway waits
      // out the normal interval instead of spinning at 0ms.
      immediate && inflightMutations(this.client) < MAX_INFLIGHT_MUTATIONS ? 0 : EVENT_FLUSH_MS,
    );
  }

  /** Record that the relay now holds this badge, and restart the push throttle. */
  private markRuntimeSent(mirror: MirrorState, snapshot: string | undefined): void {
    mirror.runtimeSent = snapshot;
    mirror.runtimeSentAt = Date.now();
    mirror.runtimeSentState = mirror.runtime?.agentState;
    mirror.runtimeSentQueued = JSON.stringify(mirror.runtime?.queuedPrompts ?? []);
  }

  private async flushSession(sessionId: string): Promise<void> {
    const mirror = this.mirror(sessionId);
    if (mirror.flushing || !this.client || !this.credentials) return;
    const client = this.client;
    // Backpressure. Nothing here is lost by waiting: the mirror keeps its
    // pending items and dirty flags and re-schedules, so a queue that drains
    // picks all of it up on the next tick.
    if (inflightMutations(client) >= MAX_INFLIGHT_MUTATIONS) {
      if (Date.now() - this.lastBackpressureLogAt >= HEALTH_LOG_MS) {
        this.lastBackpressureLogAt = Date.now();
        this.options.log("remote:backpressure", { sessionId, ...describeConnection(client) });
      }
      this.scheduleFlush(sessionId, false);
      return;
    }
    const credentials = this.credentials;
    mirror.flushing = true;
    const pending = Array.from(mirror.pendingItems.entries());
    // The badge, and whether it actually moved since the last flush.
    const runtimeSnapshot = mirror.runtime ? JSON.stringify(mirror.runtime) : undefined;
    const runtimeChanged = runtimeSnapshot !== undefined && runtimeSnapshot !== mirror.runtimeSent;
    // A badge that only moved WITHIN a state (another tool, more tokens) waits
    // for RUNTIME_PUSH_MS. Two things skip that queue because the user is
    // actively waiting on them: an agentState transition (a turn ending, a
    // permission prompt appearing), and a change to the queued prompts — that
    // one is the phone's only acknowledgement that a prompt it just queued
    // landed. When a badge does wait, the flush is rescheduled so it can't be
    // stranded by a turn that ends.
    const queuedSnapshot = JSON.stringify(mirror.runtime?.queuedPrompts ?? []);
    const runtimeUrgent =
      runtimeChanged &&
      (mirror.runtime?.agentState !== mirror.runtimeSentState ||
        queuedSnapshot !== mirror.runtimeSentQueued);
    const runtimeDue =
      runtimeChanged &&
      (runtimeUrgent || Date.now() - (mirror.runtimeSentAt ?? 0) >= RUNTIME_PUSH_MS);
    // `appendEvents` requires the routing row to exist, so an unregistered
    // session is upserted before its first batch — but only the first: repeating
    // it on every batch is what kept the per-second upsert alive even after the
    // lifecycle diff above.
    const needsUpsert = mirror.metadataDirty || (pending.length > 0 && !mirror.registered);
    if (!needsUpsert && !runtimeDue && pending.length === 0) {
      mirror.flushing = false;
      // Nothing to send now, but a deferred badge still has to land.
      if (runtimeChanged) this.scheduleFlush(sessionId, false);
      return;
    }
    // The low-churn state as it stands NOW — the upsert's args are read before it
    // awaits, so anything that changes mid-flight is not in this call.
    const metadataVersion = mirror.metadataVersion;
    try {
      if (needsUpsert) {
        await this.counted("upsert", client.mutation(upsertRef, {
          deviceId: credentials.deviceId,
          token: credentials.token,
          sessionId,
          ...(mirror.title !== undefined ? { titleCipher: this.stableCipher(mirror, "titleCipher", mirror.title) } : {}),
          ...(mirror.cwd !== undefined ? { cwdCipher: this.stableCipher(mirror, "cwdCipher", mirror.cwd) } : {}),
          status: mirror.status,
          agentState: mirror.agentState,
          executionMode: mirror.executionMode,
          ...(mirror.claudeSessionId ? { claudeSessionId: mirror.claudeSessionId } : {}),
          // Ride the badge along when it moved: this call is already paid for.
          ...(runtimeChanged && mirror.runtime
            ? { runtimeCipher: encryptJson(mirror.runtime, credentials.key) }
            : {}),
          ...(mirror.parentSessionId ? { parentSessionId: mirror.parentSessionId } : {}),
          ...(mirror.startedByMobileId ? { startedByMobileId: mirror.startedByMobileId } : {}),
          ...(mirror.notifyOnExit !== undefined ? { notifyOnExit: mirror.notifyOnExit } : {}),
          ...(mirror.starred !== undefined ? { starred: mirror.starred } : {}),
        }));
        // Clear the flag only if nothing moved while the mutation was in flight.
        // A turn ending mid-upsert (working -> waiting) used to be swallowed
        // here: the row kept the "working" this call carried, and the follow-up
        // state rode the `putRuntime` path, which never touches the `sessions`
        // row the phone's list reads — a session that finished 13 minutes ago,
        // still spinning in the list but "Ready" once opened.
        if (mirror.metadataVersion === metadataVersion) mirror.metadataDirty = false;
        mirror.registered = true;
        // The badge rode along on a call already being made, so the throttle
        // doesn't apply — but it did just go up, so the clock restarts here too.
        if (runtimeChanged) this.markRuntimeSent(mirror, runtimeSnapshot);
      } else if (runtimeDue && mirror.runtime) {
        // The steady state during a turn: one small write to `sessionRuntime`,
        // touching neither the session row nor its notification subscriptions.
        await this.counted("runtime", client.mutation(putRuntimeRef, {
          deviceId: credentials.deviceId,
          token: credentials.token,
          sessionId,
          runtimeCipher: encryptJson(mirror.runtime, credentials.key),
        }));
        this.markRuntimeSent(mirror, runtimeSnapshot);
      } else if (runtimeChanged) {
        // Held back by the throttle; make sure it still lands.
        this.scheduleFlush(sessionId, false);
      }
      if (pending.length > 0) {
        await this.counted("append", client.mutation(appendRef, {
          deviceId: credentials.deviceId,
          token: credentials.token,
          sessionId,
          events: pending.map(([, entry]) => ({
            kind: entry.item.kind,
            payloadCipher: encryptJson(entry.item, credentials.key),
          })),
        }));
        for (const [itemId, entry] of pending) {
          mirror.sentItems.set(itemId, entry.serialized);
          if (mirror.pendingItems.get(itemId)?.serialized === entry.serialized) mirror.pendingItems.delete(itemId);
        }
      }
    } catch (error) {
      // A failed flush may have been the one that created the routing row, and
      // `appendEvents` fails outright without it — re-state everything next time.
      markMetadataDirty(mirror);
      mirror.registered = false;
      this.options.log("remote:flush-error", {
        sessionId,
        message: commandErrorMessage(error),
        ...describeConnection(client),
      });
    } finally {
      mirror.flushing = false;
      // A badge that moved mid-flight is left unsent too — `scheduleFlush` is a
      // no-op while a flush is running, so this is the only place that catches
      // it. Without it an idle session (no further ticks to nudge a flush) keeps
      // the phone on a stale badge.
      const badgeStale =
        mirror.runtime !== undefined && JSON.stringify(mirror.runtime) !== mirror.runtimeSent;
      if (mirror.metadataDirty || badgeStale || mirror.pendingItems.size > 0) {
        this.scheduleFlush(sessionId, false);
      }
    }
  }
}

export function createRelayBridge(options: RelayBridgeOptions): RelayBridge {
  return new RelayBridge(options);
}
