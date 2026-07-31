export type SessionStatus = "idle" | "running" | "exited" | "error";
export type AgentState = "working" | "waiting" | "needs_action" | "exited";
export type ExecutionMode = "terminal" | "stream-json";
export type AgentRuntime = "claude" | "codex";

export type PersistedThread = {
  id: string;
  title: string;
  titleSource?: "auto" | "manual";
  cwd: string;
  command: string;
  runtime?: AgentRuntime;
  model?: string;
  effort?: string;
  permissionMode?: string;
  executionMode?: ExecutionMode;
  claudeSessionId?: string;
  codexThreadId?: string;
  handoffFromRuntime?: AgentRuntime;
  handoffCreatedAt?: string;
  handoffContext?: string;
  status: SessionStatus;
  agentState: AgentState;
  starred?: boolean;
  /**
   * Section created without a project: it runs in the shared scratch workspace
   * instead of a real repository, and the UI hides project-only affordances.
   */
  scratch?: boolean;
  /**
   * The New Session route's uncommitted section: launch settings and a composer,
   * with no process, no relay row, and no place in the persisted list. It exists
   * only in renderer state and is never written to threads.json — creating a
   * section promotes a copy of it to a real thread with a fresh id and leaves the
   * draft behind, empty, for the next one. Never set on a persisted thread; the
   * flag rides this type only so the renderer can hold both in one list.
   */
  draft?: boolean;
  createdAt: string;
  lastActiveAt: string;
  lastPromptAt?: string;
};

export type SessionStartRequest = {
  id: string;
  cwd: string;
  command: string;
  runtime?: AgentRuntime;
  model?: string;
  effort?: string;
  permissionMode?: string;
  executionMode: ExecutionMode;
  claudeSessionId?: string;
  codexThreadId?: string;
  cols: number;
  rows: number;
};

export type SessionInputRequest = {
  id: string;
  data: string;
  /**
   * Absolute paths of images to send alongside the text. The app-server takes
   * them as first-class `localImage` inputs; older transports embedded the paths
   * in `data` instead, which is why this is optional and additive.
   */
  imagePaths?: string[];
};

/** One choice offered for a {@link PendingApproval}. */
export type ApprovalOption = {
  /** Answered back verbatim as `optionId`. */
  id: string;
  label: string;
  hint?: string;
  /** Styles the destructive/negative choice apart from the affirmative ones. */
  tone?: "approve" | "deny";
};

/**
 * What Codex is blocked on. `command`/`fileChange` are sandbox escapes it wants
 * permission for; `userInput` is the agent asking the operator a question
 * (`item/tool/requestUserInput`). One at a time per section — Codex does not
 * issue a second request until the first is answered.
 */
export type PendingApprovalKind = "command" | "fileChange" | "userInput";

export type PendingApproval = {
  /** Opaque id the desktop and the phone answer with. Unique per section. */
  promptId: string;
  kind: PendingApprovalKind;
  title: string;
  /** The command, the patch summary, or the question being asked. */
  body: string;
  /** Codex's own justification, when it offered one. */
  reason?: string;
  cwd?: string;
  options: ApprovalOption[];
  /** True when a typed answer is accepted instead of one of `options`. */
  allowsFreeText?: boolean;
  requestedAt: string;
  /** ">1" while a multi-question request is being answered one at a time. */
  questionCount?: number;
  questionIndex?: number;
};

/** Operator's answer to a {@link PendingApproval}. */
export type SessionApprovalAnswer = {
  /** Section id. */
  id: string;
  promptId: string;
  optionId?: string;
  /** Free-text answer; only honored when the prompt allows it. */
  text?: string;
};

export type SessionApprovalResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
    };

/**
 * Change the model/effort/permission of an already-running session. Mirrors what
 * the desktop's ModelSelector does locally, but arrives from a remote (mobile)
 * client. An `undefined` field leaves the current value untouched; an empty
 * string clears it back to the runtime default. The switch takes effect on the
 * session's next turn (the desktop resumes the section with the new settings).
 */
export type SessionSwitchRequest = {
  id: string;
  // Switching runtime (Claude ↔ Codex) starts a fresh thread in the other
  // provider — conversation context does not transfer between them. Useful when
  // one provider's plan hits its usage limit.
  runtime?: AgentRuntime;
  model?: string;
  effort?: string;
  permissionMode?: string;
};

export type TerminalStartRequest = {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
};

export type TerminalStartResult = {
  ok: boolean;
  message?: string;
  // Scrollback replayed when re-attaching to a shell that is already running
  // (e.g. after a window reload).
  buffer?: string;
};

export type ConversationSearchSession = {
  id: string;
  cwd: string;
  claudeSessionId?: string;
  title: string;
  workspaceName: string;
};

export type ConversationSearchRequest = {
  query: string;
  sessions: ConversationSearchSession[];
};

export type ConversationSearchResult = {
  id: string;
  title: string;
  workspaceName: string;
  snippet: string;
  matchedInTitle: boolean;
};

export type AppPreferences = {
  // System-wide accelerator that pops the quick-start input. Empty = disabled.
  quickStartShortcut: string;
  hideDockIcon: boolean;
  notificationsPaused: boolean;
  remoteKeepAwake: "off" | "while-plugged-in" | "always";
};

export type RemotePairingInfo =
  | { status: "disabled" | "loading" | "error"; message: string }
  | { status: "ready"; qrDataUrl: string; code: string; expiresAt: string };

export type RemotePairedDevice = {
  mobileId: string;
  name?: string;
  createdAt: number;
};

export type TerminalDataEvent = {
  id: string;
  data: string;
};

export type TerminalExitEvent = {
  id: string;
  exitCode?: number;
};

export type SessionResizeRequest = {
  id: string;
  cols: number;
  rows: number;
};

export type SessionStopRequest = {
  id: string;
};

export type SavePastedImageRequest = {
  name: string;
  mimeType: string;
  data: ArrayBuffer;
};

export type SavePastedImageResult =
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      message: string;
    };

/**
 * A `/export` run. The renderer serializes the transcript (it is the side that
 * holds it) and hands main the finished document plus where to put it:
 * `clipboard`, a `filename` to write without asking, or neither — which opens
 * the native save dialog anchored at `defaultFilename` inside the section's cwd.
 */
export type ConversationExportRequest = {
  content: string;
  target: "clipboard" | "file";
  /** Explicit path from `/export <filename>`; relative paths resolve against `cwd`. */
  filename?: string;
  defaultFilename: string;
  cwd?: string;
};

export type ConversationExportResult =
  | { ok: true; target: "clipboard" }
  | { ok: true; target: "file"; path: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; message: string };

export type ClaudeSessionExistsRequest = {
  cwd: string;
  claudeSessionId: string;
};

export type ConversationLoadRequest = {
  cwd: string;
  claudeSessionId?: string;
  codexThreadId?: string;
};

export type ConversationItemKind = "user" | "assistant" | "tool" | "system" | "marker" | "agent";

/**
 * A subagent the main Claude turn delegated to (Task/Agent tool). Surfaced as
 * its own `agent`-kind conversation item so the renderer can nest the child's
 * transcript under a collapsible card. Both join keys Claude emits are kept:
 * `toolUseId` (the spawning tool_use id, == `parentAgentId` on every child
 * item) and `taskId` (used by the `task_updated`/`task_notification` events,
 * which omit the tool_use id).
 */
export type AgentActivity = {
  toolUseId: string;
  taskId?: string;
  subagentType?: string;
  status: "running" | "completed" | "failed";
  /** True once the main agent's turn ended while this subagent was still
   * running (a run_in_background agent): it keeps running across turn
   * boundaries and must not hold the section at "working". */
  background?: boolean;
  /** Tool the subagent is currently using, from task_progress. */
  lastTool?: string;
  /** File Claude streams this task's output to. A background shell writes its
   * plain stdout/stderr here and nothing else ever reaches the event stream. */
  outputFile?: string;
  /** Tail of `outputFile`, hydrated by the main process for shell tasks. */
  outputTail?: string;
  totalTokens?: number;
  durationMs?: number;
  summary?: string;
};

export type ConversationItem = {
  id: string;
  kind: ConversationItemKind;
  title?: string;
  body: string;
  timestamp?: string;
  sequence?: number;
  model?: string;
  /** Set on items produced inside a subagent; equals the owning agent's toolUseId. */
  parentAgentId?: string;
  /** Present only on `agent`-kind items: the subagent's lifecycle state. */
  agent?: AgentActivity;
};

export type TokenUsageStats = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
};

export type ClaudeConversationResult = {
  items: ConversationItem[];
  tokenUsage: TokenUsageStats;
};

/**
 * One hour of token spend for a single (section, runtime, model) triple. Live
 * `tokenUsage` snapshots are per-thread and reset whenever the underlying agent
 * process restarts — and a Claude → Codex handoff throws the old thread away
 * entirely — so a section's real lifetime cost only survives in this ledger.
 * Hour buckets keep the file small while staying fine-grained enough for the
 * date ranges the settings report offers.
 */
export type UsageLedgerEntry = {
  sessionId: string;
  runtime: AgentRuntime;
  /** Raw model id as the runtime reported it; empty when it never said. */
  model: string;
  /** ISO timestamp of the start of the hour this spend landed in. */
  at: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
};

/** Dollar split of a token total. Mirrors `CostBreakdown` in shared/pricing.ts. */
export type UsageCostBreakdown = {
  inputUsd: number;
  outputUsd: number;
  cacheWriteUsd: number;
  cacheReadUsd: number;
  totalUsd: number;
  priced: boolean;
};

export type UsageCostGroup = {
  runtime: AgentRuntime;
  model: string;
  modelLabel: string;
  /** "$5.00 in · $25.00 out per Mtok", or null when the model has no rate. */
  rateSummary: string | null;
  tokens: TokenUsageStats;
  cost: UsageCostBreakdown;
};

/**
 * `sessionId` narrows the report to one section (the info card); `fromIso` /
 * `toIso` bound it by time (the settings report). Omitting everything reports
 * all recorded usage.
 */
export type UsageCostQuery = {
  sessionId?: string;
  fromIso?: string;
  toIso?: string;
};

export type UsageCostReport = {
  tokens: TokenUsageStats;
  cost: UsageCostBreakdown;
  /** Per (runtime, model), heaviest spend first. */
  groups: UsageCostGroup[];
  /** Models we saw tokens for but hold no rate for, so cost under-reports. */
  unpricedModels: string[];
  /** Distinct sections the report covers. */
  sessionCount: number;
  generatedAt: string;
};

export type SessionDataEvent = {
  id: string;
  data: string;
};

export type ClaudeSessionEvent = {
  id: string;
  claudeSessionId: string;
};

export type SessionTitleEvent = {
  id: string;
  title: string;
};

export type ConversationEvent = {
  id: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  items: ConversationItem[];
  tokenUsage?: TokenUsageStats;
};

export type SessionRuntimeEvent = {
  id: string;
  executionMode: ExecutionMode;
  // Which agent runtime backs this session. Lets a remote client pick the right
  // model/effort option lists when offering a mid-session switch.
  runtime?: AgentRuntime;
  agentState: AgentState;
  currentEventType: string;
  lastEventAt: string;
  latestTool?: string;
  latestCommand?: string;
  latestModel?: string;
  latestAssistantText?: string;
  tokenUsage?: TokenUsageStats;
  claudeSessionId?: string;
  codexThreadId?: string;
  /** Set whenever `agentState === "needs_action"` because Codex is waiting on an
   * approval or a question. `pendingPromptId` is the flat form reserved for
   * protocol v1 clients (see docs/protocol.md §6). */
  pendingApproval?: PendingApproval;
  pendingPromptId?: string;
};

export type PromptSubmittedEvent = {
  id: string;
  submittedAt: string;
};

// Fired whenever a session starts in the main process — including sessions
// kicked off remotely from the paired phone. The renderer uses this to
// materialize a thread for mobile-initiated sessions so they show up in the
// desktop list (sessions started locally already have their thread).
export type SessionStartedEvent = {
  request: SessionStartRequest;
};

export type SessionStarredEvent = {
  id: string;
  starred: boolean;
};

// "By the way" side-chat. A /btw query answers questions about the session in a
// throwaway side-session, without ever steering or interrupting the running
// agent. The desktop panel seeds the aside with the section's live transcript
// (`transcript`); phone-issued asks with no transcript fall back to provider-
// specific persisted context where available. Keyed by the section's thread id;
// the main process owns the side-session id per thread so follow-up questions
// resume the same aside.
export type BtwAskRequest = {
  threadId: string;
  cwd: string;
  runtime?: AgentRuntime;
  parentClaudeSessionId?: string;
  codexThreadId?: string;
  // Serialized tail of the section's live transcript (all runtimes, tools, and
  // code). When present, the aside is seeded with this text instead of forking
  // the runtime session — runtime-agnostic and free of auto-compaction.
  transcript?: string;
  question: string;
  model?: string;
  effort?: string;
};

export type BtwClearRequest = {
  threadId: string;
};

export type BtwStatus = "running" | "idle" | "error";

export type BtwEvent = {
  threadId: string;
  sideSessionId?: string;
  items: ConversationItem[];
  tokenUsage: TokenUsageStats;
  status: BtwStatus;
  error?: string;
};

export type BtwAskResult = {
  ok: boolean;
  message?: string;
};

export type SessionExitEvent = {
  id: string;
  exitCode?: number;
  signal?: number;
};

// Evidence/screenshot artifacts produced by a repo's `pnpm evidence` runs
// (they land under `<repo>/.review-artifacts/evidence/<ts>/<app>/<scenario>/`).
// A section surfaces the ones generated inside its own working tree since it
// was created, so an operator can jump straight to the captured PNGs/video.
export type ArtifactRun = {
  // Absolute path to the leaf run directory (the folder holding the PNGs).
  dir: string;
  createdAt: string;
  app: string | null;
  scenario: string | null;
  description: string | null;
  screenshots: number;
  hasVideo: boolean;
};

export type ArtifactsListRequest = {
  cwd: string;
  // Only runs created at/after this ISO timestamp are returned (the section's
  // creation time), so unrelated older captures in the same repo are excluded.
  sinceIso?: string;
};

export type UsageWindow = {
  key: string;
  label: string;
  utilization: number;
  resetsAt?: string;
};

export type UsageProvider = AgentRuntime;

export type UsageSnapshot = {
  provider: UsageProvider;
  windows: UsageWindow[];
  fetchedAt: string;
  unavailableReason?: string;
  // Windows come from an earlier successful fetch because the latest one failed;
  // `fetchedAt` is when those numbers were read and `unavailableReason` says why
  // the refresh failed.
  stale?: boolean;
};

// Both providers' snapshots, bundled into one encrypted payload on the heartbeat
// so the phone can toggle between Claude and Codex plan usage. Either side may be
// null when that provider isn't configured or its fetch failed.
export type UsageBundle = {
  claude: UsageSnapshot | null;
  codex: UsageSnapshot | null;
};

export type AppLogEvent = {
  source: "main" | "renderer";
  event: string;
  details?: Record<string, unknown>;
};

export type SessionStartResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
    };

// A prompt can arrive after the section's process is gone (a launch-setting
// restart, a crash, a stop that raced the send). Reporting that back instead of
// dropping the write keeps the UI from waiting forever on an agent that will
// never answer.
export type SessionInputResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
    };

export type WorkspaceGitRequest = {
  cwd: string;
};

export type WorkspaceGitChange = {
  code: string;
  path: string;
};

export type WorkspaceGitWorktree = {
  path: string;
  branch?: string;
  head?: string;
};

export type WorkspaceGitBranch = {
  name: string;
  current: boolean;
};

export type WorkspaceGitStatus = {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  changes: WorkspaceGitChange[];
  stashes: string[];
  worktrees: WorkspaceGitWorktree[];
  branches: WorkspaceGitBranch[];
  folders: string[];
  error?: string;
};

export type DesktopApi = {
  getPathForFile: (file: File) => string;
  savePastedImage: (request: SavePastedImageRequest) => Promise<SavePastedImageResult>;
  /** `/export`: copy a rendered transcript to the clipboard or write it to disk. */
  exportConversation: (request: ConversationExportRequest) => Promise<ConversationExportResult>;
  logEvent: (event: AppLogEvent) => Promise<void>;
  setBadgeCount: (count: number) => Promise<void>;
  focusWindow: () => Promise<void>;
  selectDirectory: () => Promise<string | null>;
  /** Create (if missing) and return the shared workspace used by project-less sections. */
  ensureScratchWorkspace: () => Promise<string>;
  loadThreads: () => Promise<PersistedThread[]>;
  saveThreads: (threads: PersistedThread[]) => Promise<void>;
  setSessionStarred: (event: SessionStarredEvent) => Promise<void>;
  /** Publish a hand-typed section title so paired phones show the same name. */
  setSessionTitle: (event: SessionTitleEvent) => Promise<void>;
  listSessions: () => Promise<string[]>;
  claudeSessionExists: (request: ClaudeSessionExistsRequest) => Promise<boolean>;
  latestClaudeSession: (cwd: string) => Promise<string | null>;
  loadConversation: (request: ConversationLoadRequest) => Promise<ClaudeConversationResult>;
  // Throttled in the main process to one network call per provider per minute;
  // calling more often just returns the cached snapshot.
  loadUsage: (provider?: UsageProvider) => Promise<UsageSnapshot | null>;
  /** Token → dollar report from the persisted usage ledger. */
  loadUsageCost: (query?: UsageCostQuery) => Promise<UsageCostReport>;
  startSession: (request: SessionStartRequest) => Promise<SessionStartResult>;
  sendInput: (request: SessionInputRequest) => Promise<SessionInputResult>;
  /** Answer the section's pending Codex approval / question. */
  answerApproval: (answer: SessionApprovalAnswer) => Promise<SessionApprovalResult>;
  resizeSession: (request: SessionResizeRequest) => Promise<void>;
  stopSession: (request: SessionStopRequest) => Promise<void>;
  startTerminal: (request: TerminalStartRequest) => Promise<TerminalStartResult>;
  terminalInput: (request: SessionInputRequest) => Promise<void>;
  resizeTerminal: (request: SessionResizeRequest) => Promise<void>;
  stopTerminal: (request: SessionStopRequest) => Promise<void>;
  listTerminals: () => Promise<string[]>;
  onTerminalData: (callback: (event: TerminalDataEvent) => void) => () => void;
  onTerminalExit: (callback: (event: TerminalExitEvent) => void) => () => void;
  searchConversations: (request: ConversationSearchRequest) => Promise<ConversationSearchResult[]>;
  loadPreferences: () => Promise<AppPreferences>;
  savePreferences: (preferences: Partial<AppPreferences>) => Promise<AppPreferences>;
  getRemotePairing: () => Promise<RemotePairingInfo>;
  refreshRemotePairing: () => Promise<RemotePairingInfo>;
  listRemotePairedDevices: () => Promise<RemotePairedDevice[]>;
  revokeRemotePairedDevice: (mobileId: string) => Promise<RemotePairedDevice[]>;
  onRemotePairingChanged: (callback: (info: RemotePairingInfo) => void) => () => void;
  onPreferencesChanged: (callback: (preferences: AppPreferences) => void) => () => void;
  onQuickStart: (callback: () => void) => () => void;
  onSessionData: (callback: (event: SessionDataEvent) => void) => () => void;
  onClaudeSession: (callback: (event: ClaudeSessionEvent) => void) => () => void;
  onSessionTitle: (callback: (event: SessionTitleEvent) => void) => () => void;
  onConversation: (callback: (event: ConversationEvent) => void) => () => void;
  onSessionRuntime: (callback: (event: SessionRuntimeEvent) => void) => () => void;
  onPromptSubmitted: (callback: (event: PromptSubmittedEvent) => void) => () => void;
  onSessionStarted: (callback: (event: SessionStartedEvent) => void) => () => void;
  onSessionStarred: (callback: (event: SessionStarredEvent) => void) => () => void;
  onSessionExit: (callback: (event: SessionExitEvent) => void) => () => void;
  btwAsk: (request: BtwAskRequest) => Promise<BtwAskResult>;
  btwClear: (request: BtwClearRequest) => Promise<void>;
  onBtwData: (callback: (event: BtwEvent) => void) => () => void;
  listArtifacts: (request: ArtifactsListRequest) => Promise<ArtifactRun[]>;
  revealPath: (targetPath: string) => Promise<boolean>;
  loadWorkspaceGit: (request: WorkspaceGitRequest) => Promise<WorkspaceGitStatus>;
};
