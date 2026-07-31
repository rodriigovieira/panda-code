import { hostname, platform } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import QRCode from "qrcode";
import type {
  AgentRuntime,
  AgentState,
  ConversationItem,
  ExecutionMode,
  PendingApproval,
  RemotePairedDevice,
  RemotePairingInfo,
  SessionRuntimeEvent,
  SessionStarredEvent,
  SessionStartRequest,
  SessionStartResult,
  SessionStatus,
  SessionTitleEvent,
  TokenUsageStats,
  UsageBundle,
  UsageCostQuery,
  UsageCostReport,
} from "../../shared/ipc";
import type { SessionService } from "../sessionService";
import { decryptJson, encryptJson, generateSecretboxKey, keyFromBase64, keyToBase64 } from "./crypto";
import { readKeychainSecret, writeKeychainSecret } from "./keychain";

type Logger = (event: string, details?: Record<string, unknown>) => void;
type CommandType = "start" | "input" | "stop" | "switch" | "approve" | "deny" | "btw" | "usage-cost";

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
type CommandDispatchResult = {
  succeeded: boolean;
  // Most commands answer with a human-readable message; a usage-cost request
  // answers with the report itself.
  payload: SessionStartResult | { message: string } | { report: UsageCostReport };
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
   * The runtime badge changed. Serialized last-sent snapshot rather than a
   * boolean: a session replaying its transcript re-emits identical runtime
   * events, and an unchanged badge is a write nobody needs (see
   * `stableItemFingerprint` for the same problem on the conversation path).
   */
  runtimeSent?: string;
  /** Whether the relay is known to hold a routing row for this session already. */
  registered: boolean;
  pendingItems: Map<string, PendingConversationItem>;
  sentItems: Map<string, string>;
  timer?: NodeJS.Timeout;
  flushing: boolean;
};

type RelayBridgeOptions = {
  url?: string;
  appVersion: string;
  userDataPath?: string;
  sessionService: SessionService;
  isRemoteWorkspaceAllowed: (cwd: string) => boolean;
  log: Logger;
  pairingChanged: (info: RemotePairingInfo) => void;
  starredChanged?: (event: SessionStarredEvent) => void;
  // Fetch both providers' plan-usage snapshots (only the desktop holds the creds).
  getUsageBundle: () => Promise<UsageBundle | null>;
  // Run a forked, read-only /btw side-question to completion and return its answer.
  runBtw: (request: RemoteBtwRequest) => Promise<RemoteBtwResult>;
  // Token→dollar report from the desktop's usage ledger (the phone has no ledger
  // of its own — the desktop is the only place spend is recorded).
  loadUsageCost: (query: UsageCostQuery) => UsageCostReport;
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
type RevokeMobileClientArgs = { deviceId: string; token: string; mobileId: string };
type SetStarredArgs = { deviceId: string; token: string; sessionId: string; starred: boolean };
type SetTitleArgs = { deviceId: string; token: string; sessionId: string; titleCipher: string };
type StarredForDeviceArgs = { deviceId: string; token: string };
type StarredRow = { sessionId: string; starred: boolean; starredAt?: number; updatedAt: number };

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
const starredForDeviceRef = makeFunctionReference<"query", StarredForDeviceArgs, StarredRow[]>("sessions:starredForDevice");
const listMobileClientsRef = makeFunctionReference<"query", ListMobileClientsArgs, RemotePairedDevice[]>("pairing:listMobileClients");
const revokeMobileClientRef = makeFunctionReference<"mutation", RevokeMobileClientArgs, RemotePairedDevice[]>("pairing:revokeMobileClient");

const HEARTBEAT_MS = 12_000;
const EVENT_FLUSH_MS = 1_000;
const COMMAND_MAX_AGE_MS = 2 * 60_000;
// Plan usage barely moves; refetch on a slow timer and let the heartbeat carry
// the latest ciphertext up. Matches the desktop's own cache TTL upstream.
const USAGE_PUSH_MS = 60_000;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "terminal" || value === "stream-json";
}

function isAgentRuntime(value: unknown): value is AgentRuntime {
  return value === "claude" || value === "codex";
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

function assertRemotePermission(runtime: AgentRuntime, permissionMode: string | undefined): string | undefined {
  const trimmed = cleanOptionalString(permissionMode);
  if (runtime === "codex") {
    const sandbox = trimmed ?? "read-only";
    // "danger-full-access" removes the sandbox entirely; the mobile app gates it
    // behind a Face ID confirmation before the start command is ever enqueued.
    if (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") {
      throw new Error("Remote Codex sessions may only use read-only, workspace-write, or danger-full-access sandbox modes.");
    }
    return sandbox;
  }

  // "bypassPermissions" skips every Claude permission check. It is allowed for
  // remote sessions because the mobile app requires a Face ID confirmation
  // before enqueuing the start command.
  return trimmed;
}

function buildRemoteSessionStartRequest(payload: RemoteSessionStartPayload): SessionStartRequest {
  const runtime = payload.runtime ?? "claude";
  return {
    id: payload.id,
    cwd: payload.cwd,
    runtime,
    command: runtime === "codex" ? "codex" : "claude",
    model: cleanOptionalString(payload.model),
    effort: cleanOptionalString(payload.effort),
    permissionMode: assertRemotePermission(runtime, payload.permissionMode),
    executionMode: "stream-json",
    cols: 100,
    rows: 30,
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

  constructor(options: RelayBridgeOptions) {
    this.options = options;
    this.pairingInfo = initialPairingInfo(options.url);
  }

  getPairingInfo(): RemotePairingInfo {
    return this.pairingInfo;
  }

  isEnabled(): boolean {
    return Boolean(this.options.url);
  }

  async listPairedDevices(): Promise<RemotePairedDevice[]> {
    if (!this.options.url) return [];
    if (!this.client || !this.credentials) {
      await this.start();
    }
    if (!this.client || !this.credentials) return [];
    return this.client.query(listMobileClientsRef, {
      deviceId: this.credentials.deviceId,
      token: this.credentials.token,
    });
  }

  async revokePairedDevice(mobileId: string): Promise<RemotePairedDevice[]> {
    if (!this.options.url) return [];
    if (!this.client || !this.credentials) {
      await this.start();
    }
    if (!this.client || !this.credentials) return [];
    return this.client.mutation(revokeMobileClientRef, {
      deviceId: this.credentials.deviceId,
      token: this.credentials.token,
      mobileId,
    });
  }

  async start(): Promise<void> {
    if (!this.options.url || this.client || this.stopped) return;
    try {
      this.client = new ConvexClient(this.options.url);
      // Fresh connection: re-push the usage snapshot once, in case this is a new
      // (or wiped) relay deployment that has never seen it.
      this.sentUsageCipher = undefined;
      this.credentials = await this.loadCredentials();
      await this.client.mutation(registerDeviceRef, {
        deviceId: this.credentials.deviceId,
        name: hostname(),
        platform: platform(),
        token: this.credentials.token,
      });
      await this.reconcileStrandedSessions();
      await this.refreshUsage();
      await this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_MS);
      this.usageTimer = setInterval(() => void this.refreshUsage(), USAGE_PUSH_MS);
      this.unsubscribePending = this.client.onUpdate(
        pendingRef,
        { deviceId: this.credentials.deviceId, token: this.credentials.token },
        (commands) => void this.handlePendingCommands(commands),
        (error) => this.options.log("remote:commands-error", { message: error.message }),
      );
      this.unsubscribeStarred = this.client.onUpdate(
        starredForDeviceRef,
        { deviceId: this.credentials.deviceId, token: this.credentials.token },
        (rows) => this.handleStarredRows(rows),
        (error) => this.options.log("remote:starred-error", { message: error.message }),
      );
      this.pushKnownStarred();
      // Renames recorded before the relay came up (the renderer saves threads
      // seconds after launch, this connects later).
      this.pushKnownManualTitles();
      await this.refreshPairingCode();
      this.options.log("remote:started", { deviceId: this.credentials.deviceId, url: this.options.url });
    } catch (error) {
      const failedClient = this.client;
      this.client = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.usageTimer) clearInterval(this.usageTimer);
      this.usageTimer = null;
      this.unsubscribePending?.();
      this.unsubscribePending = null;
      this.unsubscribeStarred?.();
      this.unsubscribeStarred = null;
      if (failedClient) void failedClient.close();
      this.setPairingInfo({ status: "error", message: commandErrorMessage(error) });
      this.options.log("remote:start-error", { message: commandErrorMessage(error) });
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
    this.unsubscribePending?.();
    this.unsubscribePending = null;
    this.unsubscribeStarred?.();
    this.unsubscribeStarred = null;
    for (const mirror of this.mirrors.values()) {
      if (mirror.timer) clearTimeout(mirror.timer);
    }
    if (this.client) void this.client.close();
    this.client = null;
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

  private pushSessionStarred(sessionId: string, starred: boolean): void {
    if (!this.client || !this.credentials) return;
    void this.client
      .mutation(setStarredRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        sessionId,
        starred,
      })
      .catch((error) => this.options.log("remote:set-starred-error", { sessionId, message: commandErrorMessage(error) }));
  }

  private pushKnownStarred(): void {
    for (const [sessionId, starred] of this.starredBySession) {
      this.pushSessionStarred(sessionId, starred);
    }
  }

  syncLocalStarredThreads(threads: Array<{ id: string; starred?: boolean }>): void {
    for (const thread of threads) {
      if (thread.starred && this.starredBySession.get(thread.id) !== true) {
        this.setSessionStarred({ id: thread.id, starred: true });
      }
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
    void this.client
      .mutation(setTitleRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        sessionId,
        titleCipher,
      })
      .catch((error) => {
        this.pushedTitles.delete(sessionId);
        this.options.log("remote:set-title-error", { sessionId, message: commandErrorMessage(error) });
      });
  }

  private pushKnownManualTitles(): void {
    for (const sessionId of this.manualTitles.keys()) {
      this.pushManualTitle(sessionId);
    }
  }

  async refreshPairingCode(): Promise<RemotePairingInfo> {
    if (!this.options.url) return this.pairingInfo;
    if (!this.client || !this.credentials) {
      await this.start();
      return this.pairingInfo;
    }
    try {
      this.setPairingInfo({ status: "loading", message: "Creating a secure pairing code…" });
      const code = randomBytes(18).toString("base64url");
      await this.client.mutation(createCodeRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        code,
      });
      const payload = JSON.stringify({
        url: this.options.url,
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
      mirror.metadataDirty = true;
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
        if (typeof payload.title === "string") {
          mirror.title = payload.title;
          mirror.metadataDirty = true;
          this.scheduleFlush(id, true);
        }
        break;
      case "session:claude-session":
        if (typeof payload.claudeSessionId === "string") {
          mirror.claudeSessionId = payload.claudeSessionId;
          mirror.metadataDirty = true;
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
        mirror.metadataDirty = true;
        this.scheduleFlush(id, true);
        break;
    }
  }

  private async loadCredentials(): Promise<RelayCredentials> {
    const storedDeviceId = await readKeychainSecret("device-id");
    const storedToken = await readKeychainSecret("device-token");
    const storedKey = await readKeychainSecret("e2e-key");
    const deviceId = storedDeviceId || randomUUID();
    const token = storedToken || randomToken();
    const key = storedKey ? keyFromBase64(storedKey) : generateSecretboxKey();
    if (!storedDeviceId) await writeKeychainSecret("device-id", deviceId);
    if (!storedToken) await writeKeychainSecret("device-token", token);
    if (!storedKey) await writeKeychainSecret("e2e-key", keyToBase64(key));
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
      await this.client.mutation(heartbeatRef, {
        deviceId: this.credentials.deviceId,
        token: this.credentials.token,
        appVersion: this.options.appVersion,
        ...(usageCipher ? { usageCipher } : {}),
      });
      if (usageCipher) this.sentUsageCipher = usageCipher;
    } catch (error) {
      this.options.log("remote:heartbeat-error", { message: commandErrorMessage(error) });
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
  private async refreshUsage(): Promise<void> {
    if (!this.credentials) return;
    try {
      const bundle = await this.options.getUsageBundle();
      const hasData =
        (bundle?.claude?.windows.length ?? 0) > 0 || (bundle?.codex?.windows.length ?? 0) > 0;
      if (bundle && hasData) {
        const plain = JSON.stringify(bundle);
        if (plain === this.latestUsagePlain) return;
        this.latestUsagePlain = plain;
        this.latestUsageCipher = encryptJson(bundle, this.credentials.key);
      }
    } catch (error) {
      this.options.log("remote:usage-error", { message: commandErrorMessage(error) });
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
      if (previous === row.starred) continue;
      this.starredBySession.set(row.sessionId, row.starred);
      const mirror = this.mirror(row.sessionId);
      mirror.starred = row.starred;
      this.options.starredChanged?.({ id: row.sessionId, starred: row.starred });
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
    switch (command.type) {
      case "start":
        return this.dispatchStart(command);
      case "input":
        return this.dispatchInput(command);
      case "stop":
        if (!command.sessionId) throw new Error("Stop command is missing sessionId.");
        this.options.sessionService.stopSession({ id: command.sessionId });
        return { succeeded: true, payload: { message: "Session stopped." } };
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
          ? assertRemotePermission(targetRuntime, payload.permissionMode)
          : payload.permissionMode;
        this.options.sessionService.switchSession({
          id: command.sessionId,
          runtime: payload.runtime,
          model: payload.model,
          effort: payload.effort,
          permissionMode,
        });
        const message = payload.runtime
          ? `Switched to ${payload.runtime === "codex" ? "Codex" : "Claude"} for the next message.`
          : "Model updated for the next message.";
        return { succeeded: true, payload: { message } };
      }
      case "btw":
        return this.dispatchBtw(command);
      case "usage-cost":
        return this.dispatchUsageCost(command);
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
    const request = buildRemoteSessionStartRequest(payload);
    const result = this.options.sessionService.startSession(request);
    if (!result.ok) return { succeeded: false, payload: result };

    const mirror = this.mirror(request.id);
    mirror.startedByMobileId = command.mobileId;
    mirror.notifyOnExit = true;
    mirror.metadataDirty = true;
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

  /** Shared by `input` and the first turn of a prompt-carrying `start`. */
  private async deliverPrompt(
    sessionId: string,
    data: string,
    attachments: unknown,
  ): Promise<{ ok: boolean; message?: string }> {
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
    }
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
        registered: false,
        pendingItems: new Map(),
        sentItems: new Map(),
        flushing: false,
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
      mirror.metadataDirty = true;
    }
    mirror.runtime = runtime;
    mirror.executionMode = runtime.executionMode;
    mirror.agentState = runtime.agentState;
    mirror.status = status;
    if (runtime.claudeSessionId) mirror.claudeSessionId = runtime.claudeSessionId;
    this.scheduleFlush(sessionId, runtime.agentState === "exited" || runtime.agentState === "needs_action");
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
    mirror.timer = setTimeout(() => {
      mirror.timer = undefined;
      void this.flushSession(sessionId);
    }, immediate ? 0 : EVENT_FLUSH_MS);
  }

  private async flushSession(sessionId: string): Promise<void> {
    const mirror = this.mirror(sessionId);
    if (mirror.flushing || !this.client || !this.credentials) return;
    const client = this.client;
    const credentials = this.credentials;
    mirror.flushing = true;
    const pending = Array.from(mirror.pendingItems.entries());
    // The badge, and whether it actually moved since the last flush.
    const runtimeSnapshot = mirror.runtime ? JSON.stringify(mirror.runtime) : undefined;
    const runtimeChanged = runtimeSnapshot !== undefined && runtimeSnapshot !== mirror.runtimeSent;
    // `appendEvents` requires the routing row to exist, so an unregistered
    // session is upserted before its first batch — but only the first: repeating
    // it on every batch is what kept the per-second upsert alive even after the
    // lifecycle diff above.
    const needsUpsert = mirror.metadataDirty || (pending.length > 0 && !mirror.registered);
    if (!needsUpsert && !runtimeChanged && pending.length === 0) {
      mirror.flushing = false;
      return;
    }
    try {
      if (needsUpsert) {
        await client.mutation(upsertRef, {
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
          ...(mirror.startedByMobileId ? { startedByMobileId: mirror.startedByMobileId } : {}),
          ...(mirror.notifyOnExit !== undefined ? { notifyOnExit: mirror.notifyOnExit } : {}),
          ...(mirror.starred !== undefined ? { starred: mirror.starred } : {}),
        });
        mirror.metadataDirty = false;
        mirror.registered = true;
        if (runtimeChanged) mirror.runtimeSent = runtimeSnapshot;
      } else if (runtimeChanged && mirror.runtime) {
        // The steady state during a turn: one small write to `sessionRuntime`,
        // touching neither the session row nor its notification subscriptions.
        await client.mutation(putRuntimeRef, {
          deviceId: credentials.deviceId,
          token: credentials.token,
          sessionId,
          runtimeCipher: encryptJson(mirror.runtime, credentials.key),
        });
        mirror.runtimeSent = runtimeSnapshot;
      }
      if (pending.length > 0) {
        await client.mutation(appendRef, {
          deviceId: credentials.deviceId,
          token: credentials.token,
          sessionId,
          events: pending.map(([, entry]) => ({
            kind: entry.item.kind,
            payloadCipher: encryptJson(entry.item, credentials.key),
          })),
        });
        for (const [itemId, entry] of pending) {
          mirror.sentItems.set(itemId, entry.serialized);
          if (mirror.pendingItems.get(itemId)?.serialized === entry.serialized) mirror.pendingItems.delete(itemId);
        }
      }
    } catch (error) {
      // A failed flush may have been the one that created the routing row, and
      // `appendEvents` fails outright without it — re-state everything next time.
      mirror.metadataDirty = true;
      mirror.registered = false;
      this.options.log("remote:flush-error", { sessionId, message: commandErrorMessage(error) });
    } finally {
      mirror.flushing = false;
      if (mirror.metadataDirty || mirror.pendingItems.size > 0) this.scheduleFlush(sessionId, false);
    }
  }
}

export function createRelayBridge(options: RelayBridgeOptions): RelayBridge {
  return new RelayBridge(options);
}
