import type { NotificationChannelConfig, NotificationChannels } from "./notification-channels";
import type { PerfSample, PerfSnapshot } from "./perf";
import type { BacklogColumn, VerificationOutcome, WorkspaceBacklog } from "./backlog";
import type { BrowserActivity, BrowserState } from "./browser";
import type { DictationRendererEvent } from "./dictation";
import type { MachineStats } from "./machine-stats";
import type { ScheduleFrequency, WorkspaceSchedule } from "./schedule";

export type SessionStatus = "idle" | "running" | "exited" | "error";
export type AgentState = "working" | "waiting" | "needs_action" | "exited";
export type ExecutionMode = "terminal" | "stream-json";
export type AgentRuntime = "claude" | "codex" | "groq";

/** A model advertised by the local Codex app-server. */
export type CodexModel = {
  id: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{
    value: string;
    description: string;
  }>;
  defaultReasoningEffort?: string;
  isDefault?: boolean;
};

export type GroqModel = {
  id: string;
  displayName: string;
  description: string;
};

/** A model selection made after a section was created. Kept with the section
 * so the transcript can show where its capabilities changed. */
export type SessionModelChange = {
  at: string;
  runtime: AgentRuntime;
  fromModel?: string;
  toModel?: string;
};

/** Durable prompt index, independent from the prunable conversation transcript. */
export type SessionPromptHistoryEntry = {
  id: string;
  text: string;
  attachments: number;
  timestamp: string;
  /** The matching transcript item when it is still available locally. */
  conversationItemId?: string;
};

export type PersistedThread = {
  id: string;
  title: string;
  titleSource?: "auto" | "manual";
  cwd: string;
  command: string;
  runtime?: AgentRuntime;
  model?: string;
  /** Model transitions made within this section, in chronological order. */
  modelChanges?: SessionModelChange[];
  effort?: string;
  permissionMode?: string;
  executionMode?: ExecutionMode;
  claudeSessionId?: string;
  codexThreadId?: string;
  handoffFromRuntime?: AgentRuntime;
  handoffCreatedAt?: string;
  handoffContext?: string;
  /**
   * The section this one hangs off: its SUB-THREAD parent.
   *
   * A section opened by another section used to be a sibling of it — the
   * relationship existed only in the spawner's head and in an in-memory watch,
   * so the sidebar showed a flat list in which "the section I asked for" and
   * "the four it opened to do it" were indistinguishable. Recording the parent
   * makes the tree the user can see, collapse and re-arrange, and it outlives a
   * restart the way an in-memory watch never did.
   *
   * Sibling creation is still a first-class choice (`create_session` takes a
   * `mode`), so an absent `parentId` means top-level and nothing more.
   *
   * Never a cycle and never deeper than {@link MAX_SUBTHREAD_DEPTH}: both are
   * enforced where the link is set, so readers can walk it without a visited set.
   */
  parentId?: string;
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
  /** Sent prompts survive transcript pruning, clearing, and hibernation. */
  promptHistory?: SessionPromptHistoryEntry[];
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
  /**
   * Sub-thread parent, for a section started by something other than the
   * sidebar — an agent's `create_session`, or the phone's "new sub-thread".
   *
   * It rides the START request because that is the one message every such path
   * already sends and every listener already sees: the renderer materializes an
   * unknown session from it (so the tree is right on first paint) and the relay
   * bridge mirrors it from the same event. A section the user created in the
   * sidebar carries its parent in the thread record instead, and leaves this
   * unset.
   */
  parentId?: string;
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
export type PendingApprovalKind = "command" | "fileChange" | "permissions" | "userInput" | "mcpElicitation";

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
  codexThreadId?: string;
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

/**
 * Ceilings Conserve mode puts on the three "session hygiene" preferences.
 *
 * Measured justification: 97% of tokens consumed are cache reads — re-sending
 * context — while model output is ~0.1%. So the quota is driven by how much
 * context is alive and how often it is re-sent, not by what agents print.
 * Fewer live sections, faster hibernation and a shorter transcript window are
 * the levers that actually touch that 97%.
 */
export const CONSERVE_HYGIENE = {
  maxLiveSessions: 3,
  idleSessionTimeoutMinutes: 10,
  transcriptWindowSize: 600,
} as const;

/**
 * The hygiene numbers actually in force. Conserve mode tightens them; it never
 * loosens them, so a user who already set something stricter keeps it. A value
 * of 0 means "no limit" for these prefs, which is exactly what Conserve must
 * override rather than preserve.
 */
export function effectiveHygiene(preferences: AppPreferences): {
  maxLiveSessions: number;
  idleSessionTimeoutMinutes: number;
  transcriptWindowSize: number;
} {
  const tighten = (value: number, ceiling: number): number =>
    value <= 0 ? ceiling : Math.min(value, ceiling);
  if (!preferences.conserveMode) {
    return {
      maxLiveSessions: preferences.maxLiveSessions,
      idleSessionTimeoutMinutes: preferences.idleSessionTimeoutMinutes,
      transcriptWindowSize: preferences.transcriptWindowSize,
    };
  }
  return {
    maxLiveSessions: tighten(preferences.maxLiveSessions, CONSERVE_HYGIENE.maxLiveSessions),
    idleSessionTimeoutMinutes: tighten(
      preferences.idleSessionTimeoutMinutes,
      CONSERVE_HYGIENE.idleSessionTimeoutMinutes,
    ),
    transcriptWindowSize: tighten(preferences.transcriptWindowSize, CONSERVE_HYGIENE.transcriptWindowSize),
  };
}

export type AppPreferences = {
  // System-wide accelerator that pops the quick-start input. Empty = disabled.
  quickStartShortcut: string;
  hideDockIcon: boolean;
  notificationsPaused: boolean;
  /** Main-process source of truth; absent only until legacy renderer migration. */
  notificationChannels?: NotificationChannelConfig;
  remoteKeepAwake: "off" | "while-plugged-in" | "always";
  /**
   * Quota-saver mode. Appends `conserveSystemPrompt` to new Claude sections:
   * the expensive model plans and reviews, cheap subagents do the implementing.
   * Baked into the process at spawn, so it takes effect on the next section (or
   * the next resume), not mid-turn.
   */
  conserveMode: boolean;
  /** Editor the changed-files drawer opens by default. */
  preferredEditor: EditorId;
  /**
   * Convex deployment the phone pairs through. Empty = phone pairing is off and
   * nothing leaves this Mac, which is the default for a downloaded build.
   *
   * A setting rather than a build-time constant: a baked URL made every
   * repackage able to silently drop the relay, and the only symptom was the
   * phone saying "Mac offline" hours later. Seeded from PANDA_CODE_RELAY_URL on
   * first run so a build can still ship with a default, but authoritative
   * afterwards — clearing it here really does turn pairing off.
   */
  relayUrl: string;
  /** Desktop-only opt-in: phones may control unrestricted agents and grant approvals. */
  remoteAllowFullAccess?: boolean;
  /**
   * Language dictation decodes speech as. See `DICTATION_LOCALES`.
   *
   * Its own setting rather than a read of the system language: the recogniser
   * picks its acoustic model from this, and English spoken into a Mac set to
   * Portuguese comes back as unrelated words for whole clauses, not as a few
   * mangled nouns.
   */
  dictationLocale: string;
  /**
   * How many sections may hold a live agent process at once. Reaching it
   * hibernates the least recently prompted idle section — its process is killed
   * and the next prompt resumes the same conversation.
   *
   * A setting rather than a constant because the right number is a property of
   * the machine: a live Claude section costs ~215 MB of physical footprint
   * before its conversation is counted and ~390 MB with a long one, so 8 GB
   * wants a handful and 64 GB can hold every section you open. 0 = no cap.
   */
  maxLiveSessions: number;
  /**
   * Minutes a section may sit idle before it hibernates, releasing its process
   * even when the cap is nowhere near. 0 = never hibernate on time alone.
   */
  idleSessionTimeoutMinutes: number;
  /**
   * Transcript items kept mounted in a section's feed. Older ones stay in memory
   * and load on demand from the "Show earlier" control above the feed.
   *
   * The renderer builds the whole feed's element tree in one memo, so a section
   * with thousands of items re-reconciles all of them whenever a turn starts or
   * ends. The default is deliberately high — this is a backstop against the
   * pathological section, not a budget you should notice in normal use, and a
   * phone-sized window here would be worse than the problem. 0 = no limit.
   */
  transcriptWindowSize: number;
  /**
   * How many sections keep their transcript in the window's memory.
   *
   * Separate from the live-section cap, because they bound different things: a
   * section you only ever read never had a process to reap, but opening it
   * loaded its full history — 16 MB of JSONL for a long one — and until now
   * nothing ever released it. Dropped transcripts reload from disk on open.
   * 0 = keep every transcript ever opened.
   */
  retainedTranscripts: number;
};

export type RemotePairingInfo =
  | { status: "disabled" | "loading" | "error"; message: string }
  | { status: "ready"; qrDataUrl: string; code: string; expiresAt: string };

export type RemotePairedDevice = {
  mobileId: string;
  name?: string;
  createdAt: number;
  notificationsEnabled: boolean;
  commandAuthVersion?: number;
  commandKeyId?: string;
  commandKeyProtection?: string;
};

export type SessionMobileNotificationStatus = {
  available: boolean;
  phoneCount: number;
  subscribedPhones: number;
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

/**
 * "Clear the machine": stop work the sections spawned, not the sections.
 *
 * `pids` are rows from the snapshot's `sectionCommands`; main re-reads the
 * process table and drops anything that is no longer a live section's child, so
 * a stale pid is ignored rather than signalled blind. Omit it to stop all.
 */
export type KillSectionCommandsRequest = {
  pids?: number[];
};

export type KillSectionCommandsResult = {
  /** Processes actually signalled, subtrees included. */
  killed: number;
  /** Their names, newest-first, for the toast: "stopped tsc, vite, esbuild". */
  names: string[];
};

// The built-in browser. Main owns the tab list and both drivers — the panel and
// an agent's `browser_*` tools — go through it, so these are the panel's half of
// a conversation the agent is also in.
export type BrowserOpenRequest = { threadId: string; url: string };
export type BrowserNavigateRequest = { threadId: string; tabId?: string; url: string };
export type BrowserTabRequest = { threadId: string; tabId: string };

/** Renderer handshake: this tab's `<webview>` exists and hosts this WebContents. */
export type BrowserAttachRequest = { tabId: string; webContentsId: number };

/** Main temporarily stages one live webview so Chromium will raster it. */
export type BrowserCaptureStageEvent = { requestId: string; tabId: string };

/** The hosting renderer has applied the stage and crossed two paint frames. */
export type BrowserCaptureStageReadyRequest = { requestId: string };

/** What the guest page did, as the renderer's webview listeners saw it. */
export type BrowserReportRequest = {
  tabId: string;
  url?: string;
  title?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
};

/** The user clearing an agent's note, optionally with something to say back. */
export type BrowserResolveNoteRequest = { tabId: string; reply?: string };

/** Temporarily hide or restore a note without resolving the agent's hand-off. */
export type BrowserSetNoteHiddenRequest = { tabId: string; hidden: boolean };

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
  /** Opaque per-runtime byte positions returned by the preceding page. */
  beforeCursor?: ConversationPageCursor;
};

export type ConversationPageCursor = {
  claude?: number;
  codex?: number;
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
  /** The shell command this card runs, for a shell task. Kept because the two
   * fields below are parsed out of it. */
  command?: string;
  /** A file the command itself writes its output to (`> log`, `| tee log`).
   * `outputFile` only ever holds what actually reached the CLI's stdout, so a
   * command that redirects or pipes elsewhere leaves it empty for the whole run;
   * this is the fallback the main process tails instead. */
  commandOutputFile?: string;
  /** Trailing pipeline stage that emits nothing until the command exits
   * (`| tail -20`), so an empty card can say why it is empty. */
  outputBufferedBy?: string;
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
  /** Cursor for the next older page; absent when the indexed beginning was reached. */
  beforeCursor?: ConversationPageCursor;
  hasEarlier?: boolean;
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

/**
 * A prompt a mobile client asked to hold until the current turn finishes,
 * rather than steer it immediately. Owned by the desktop's relay bridge (see
 * `relayBridge.ts`'s `MirrorState.queuedPrompts`) so it survives the phone
 * being killed/reopened; this is the lightweight display copy (no image
 * bytes) mirrored down to every client watching the session's runtime.
 */
export type QueuedPromptSync = {
  id: string;
  text: string;
  imageCount: number;
  queuedAt: number;
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
  /** Prompts a mobile client queued behind this session's active turn. */
  queuedPrompts?: QueuedPromptSync[];
};

export type PromptSubmittedEvent = {
  id: string;
  submittedAt: string;
};

export type AgentAttentionChoice = {
  label: string;
  /** Ordinary prompt text sent to the requesting section when selected. */
  response: string;
};

/** An explicit, time-sensitive hand-off from an agent to the user. */
export type AgentAttentionEvent = {
  id: string;
  threadId: string;
  threadTitle: string;
  summary: string;
  /** Final response recap for automatic completion alerts. */
  tldr?: string;
  /** Exceptional must-read note from the final response. */
  important?: string;
  detail?: string;
  severity: "important" | "urgent";
  choices: AgentAttentionChoice[];
  createdAt: string;
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

/**
 * A prompt that reached a session from the PHONE rather than this window.
 *
 * The renderer draws the user's own bubble optimistically when it submits a
 * prompt (it owns the text at that moment), so a prompt delivered straight to
 * the session by the relay bridge — which never passes through the renderer —
 * left the section visibly working with nothing above it to explain why, until
 * the transcript was re-read from disk. This carries the same three fields the
 * local path builds its optimistic item from.
 */
export type SessionRemotePromptEvent = {
  id: string;
  body: string;
  timestamp: number;
};

export type SessionArchivedEvent = {
  id: string;
  archived: boolean;
};

/**
 * A section moved in the sub-thread tree — nested under a parent, detached to
 * the top level (`parentId: undefined`), or re-homed when its parent was
 * deleted.
 *
 * Published like a rename rather than folded into the session upsert: the tree
 * is edited from the sidebar for sections that may not be running at all, and a
 * dormant section must not be resurrected on the phone's list just because it
 * was dragged somewhere.
 */
export type SessionParentEvent = {
  id: string;
  parentId?: string;
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

/**
 * A section's agent process was released to reclaim memory, but the section is
 * intact and resumes on its next prompt. Explicitly not a `SessionExitEvent` —
 * an exit means something ended, and the UI is entitled to react to it loudly.
 */
export type SessionHibernatedEvent = {
  id: string;
  reason: "cap" | "idle";
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

/**
 * How the current branch stands against one remote. `ahead`/`behind` are only
 * set when `<name>/<branch>` actually exists — a remote that has never seen this
 * branch reports neither, which the UI shows as "not published".
 */
export type WorkspaceGitRemote = {
  name: string;
  url?: string;
  /** The remote-tracking ref the counts are measured against, e.g. "origin/main". */
  ref?: string;
  ahead?: number;
  behind?: number;
  /** True when this remote is the current branch's configured upstream. */
  upstream: boolean;
};

export type WorkspaceGitStatus = {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  /** Configured upstream of the current branch, e.g. "origin/main". */
  upstream?: string;
  remotes: WorkspaceGitRemote[];
  /**
   * When the repo last heard from a remote (mtime of FETCH_HEAD), ISO. Every
   * ahead/behind count is only as fresh as this — hence it is shown next to them.
   */
  lastFetchAt?: string;
  changes: WorkspaceGitChange[];
  stashes: string[];
  worktrees: WorkspaceGitWorktree[];
  branches: WorkspaceGitBranch[];
  folders: string[];
  error?: string;
};

export type WorkspaceGitFetchRequest = {
  cwd: string;
};

/** One commit in the workspace's history, as read by `git log`. */
export type WorkspaceGitCommit = {
  /** Full SHA — the stable key, and what a `git show` would need. */
  hash: string;
  /** Abbreviated SHA, for display. */
  shortHash: string;
  subject: string;
  author: string;
  /** Author date, ISO. */
  date: string;
  /** Decorations git prints for this commit ("HEAD -> main", "origin/main", tags). */
  refs: string[];
};

/**
 * A page of history. Paging is `skip`/`limit` over `git log` rather than a
 * cursor: the log only grows at the head, and the drawer reads from the head
 * forward, so a plain offset is stable enough for a page you re-read on demand.
 */
export type WorkspaceGitLogRequest = {
  cwd: string;
  /** Commits to skip from HEAD. Defaults to 0. */
  skip?: number;
  /** Page size. Defaults to 50, capped at 200. */
  limit?: number;
};

export type WorkspaceGitLog = {
  isRepo: boolean;
  branch?: string;
  commits: WorkspaceGitCommit[];
  skip: number;
  /** True when there is at least one more commit past this page. */
  hasMore: boolean;
  error?: string;
};

/** One GitHub Actions workflow run, as reported by the user's local `gh` session. */
export type WorkspaceWorkflowRun = {
  databaseId: number;
  name: string;
  displayTitle: string;
  status: string;
  conclusion?: string;
  headBranch: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  url: string;
};

export type WorkspaceWorkflowRunsRequest = {
  cwd: string;
  /** Total newest runs to return. Defaults to 10 and is capped at 50. */
  limit?: number;
};

export type WorkspaceWorkflowRuns = {
  runs: WorkspaceWorkflowRun[];
  limit: number;
  hasMore: boolean;
  error?: string;
};

export type WorkspaceGitTreeEntry = {
  name: string;
  /** Path relative to the workspace root, POSIX-separated. "" for the root itself. */
  path: string;
  absolutePath: string;
  kind: "directory" | "file";
  /** Bytes, files only. */
  size?: number;
  /** Git ignores this path (or it is `.git`) — shown dimmed rather than hidden. */
  ignored?: boolean;
};

/**
 * One directory's children. The tree is read a level at a time as folders are
 * expanded: a repo the size of a monorepo has hundreds of thousands of files,
 * and none of them are worth walking for a sidebar nobody has expanded yet.
 */
export type WorkspaceGitTreeRequest = {
  cwd: string;
  /** Workspace-relative directory to list. Omitted or "" means the root. */
  path?: string;
};

export type WorkspaceGitTree = {
  path: string;
  entries: WorkspaceGitTreeEntry[];
  error?: string;
};

/**
 * A text file read for the in-app reader — a Markdown document the user picked
 * out of the file tree, or one an agent just wrote.
 *
 * Read whole rather than streamed: the reader shows documents, and a document
 * that does not fit in `maxBytes` is one this viewer is the wrong tool for.
 */
export type TextFileRequest = {
  path: string;
  /** Refuse anything larger, rather than pulling a 200 MB log through IPC. Defaults to 2 MB, capped at 8 MB. */
  maxBytes?: number;
};

export type TextFileContents = {
  /** Absolute path, as resolved. */
  path: string;
  name: string;
  content: string;
  /** Size on disk, bytes. */
  size: number;
  /** The file was longer than the cap and `content` stops early. */
  truncated: boolean;
  /** Unreadable, a directory, binary, or past the cap — `content` is empty. */
  error?: string;
};

/**
 * Writing one back, from the reader's edit mode.
 *
 * Only ever an overwrite of a file the reader already opened — there is no
 * "create" here — so the write refuses a path that is not already a readable
 * text file. That keeps an autosave from turning a stray path into a new file.
 */
export type TextFileWriteRequest = {
  path: string;
  content: string;
};

export type TextFileWriteResult = {
  path: string;
  /** Size on disk after the write, bytes. */
  size: number;
  /** When the write landed, epoch ms. Drives the reader's "Saved at" line. */
  savedAt: number;
  /** Set when nothing was written, and says why. */
  error?: string;
};

// "What did this section touch?" — the file list comes from the section's own
// transcript (so a repo shared by several sections still attributes correctly)
// and the line counts come from git.
export type SessionFileChangesRequest = {
  /** Panda section id. Used for the desktop's durable per-section file snapshot. */
  sessionId?: string;
  cwd: string;
  claudeSessionId?: string;
  codexThreadId?: string;
};

export type SessionFileChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  /** The section wrote here, but the working tree matches HEAD — committed, reverted, or rewritten back. */
  | "clean"
  /** Written during the run, gone now, and git has no record of it (a temp file, or a path outside the repo). */
  | "missing";

export type SessionFileChange = {
  /** Repo-relative when the file lives under the git root, absolute otherwise. */
  path: string;
  absolutePath: string;
  status: SessionFileChangeStatus;
  added: number;
  removed: number;
  /** Git reports a binary diff, so the line counts are meaningless and left at 0. */
  binary?: boolean;
  /** Present on disk right now — an editor can open it. */
  exists: boolean;
};

export type SessionFileChanges = {
  isRepo: boolean;
  /** Absolute path of the git root the counts are measured against. */
  root?: string;
  branch?: string;
  files: SessionFileChange[];
  added: number;
  removed: number;
  error?: string;
};

export type EditorId = "cursor" | "vscode" | "finder";

export type EditorTarget = {
  id: EditorId;
  name: string;
  available: boolean;
};

export type OpenInEditorRequest = {
  editor: EditorId;
  path: string;
};

/**
 * One edit to a workspace's kanban board. A single union rather than four IPC
 * channels: the renderer never mutates the board itself — every change is a
 * round trip that comes back as the whole board — so the shapes are only ever
 * used together.
 */
export type BacklogMutation =
  | {
      op: "add";
      cwd: string;
      title: string;
      summary?: string;
      description?: string;
      metadata?: string;
      column?: BacklogColumn;
    }
  | {
      op: "update";
      cwd: string;
      id: string;
      title?: string;
      summary?: string;
      description?: string;
      metadata?: string;
      column?: BacklogColumn;
      /** Park it, or bring it back. The card keeps its column either way. */
      onHold?: boolean;
      verificationNotes?: string;
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
      /** The renderer never attaches a file itself — only agents do, through the MCP tool. It can drop one, though. */
      removeAttachmentIds?: string[];
    }
  | {
      op: "move";
      cwd: string;
      id: string;
      column: BacklogColumn;
      /** Position among the items already in the target column. */
      index: number;
    }
  /**
   * Attach or detach a section from a card. Its own ops rather than a `sections`
   * array on `update`: the renderer only ever knows about one section at a time
   * (the one the user is looking at), and a whole-array write from a board that
   * loaded a second ago would silently drop a link an agent made since.
   */
  | { op: "link"; cwd: string; id: string; sectionId: string }
  | { op: "unlink"; cwd: string; id: string; sectionId: string }
  | { op: "delete"; cwd: string; id: string }
  | {
      op: "epic-add";
      cwd: string;
      title: string;
      summary?: string;
      scope?: string;
      acceptanceCriteria?: string;
      acceptanceScenario?: string;
    }
  | {
      op: "epic-update";
      cwd: string;
      id: string;
      title?: string;
      summary?: string;
      scope?: string;
      acceptanceCriteria?: string;
      acceptanceScenario?: string;
    }
  | { op: "epic-delete"; cwd: string; id: string };

export type BacklogMutationResult =
  | { ok: true; backlog: WorkspaceBacklog }
  | { ok: false; message: string };

/** Emitted whenever a board changes — including from an agent's own process. */
export type BacklogChangedEvent = {
  cwd: string;
  backlog: WorkspaceBacklog;
};

/**
 * One edit to a workspace's schedule. Same reasoning as `BacklogMutation`: the
 * renderer never mutates the file itself, every change round-trips as the
 * whole schedule.
 */
export type ScheduleMutation =
  | { op: "add"; cwd: string; title: string; prompt: string; frequency: ScheduleFrequency }
  | { op: "update"; cwd: string; id: string; title?: string; prompt?: string; frequency?: ScheduleFrequency; enabled?: boolean }
  | { op: "delete"; cwd: string; id: string };

export type ScheduleMutationResult =
  | { ok: true; schedule: WorkspaceSchedule }
  | { ok: false; message: string };

/** Emitted whenever a schedule changes — including from an agent's own process, or the ticker firing a job. */
export type ScheduleChangedEvent = {
  cwd: string;
  schedule: WorkspaceSchedule;
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
  /** Main-process + forwarded renderer timings, for the machine panel. */
  perfSnapshot: () => Promise<PerfSnapshot>;
  perfReset: () => Promise<void>;
  reportPerf: (samples: PerfSample[]) => Promise<void>;
  loadThreads: () => Promise<PersistedThread[]>;
  saveThreads: (threads: PersistedThread[]) => Promise<void>;
  setSessionStarred: (event: SessionStarredEvent) => Promise<void>;
  setSessionArchived: (event: SessionArchivedEvent) => Promise<void>;
  /** Push the device-local archive set once at startup, in case the relay has never seen it. */
  syncLocalArchivedThreads: (archivedIds: string[]) => Promise<void>;
  /** Publish a sub-thread link (or its removal) so paired phones nest the same way. */
  setSessionParent: (event: SessionParentEvent) => Promise<void>;
  /** Publish a hand-typed section title so paired phones show the same name. */
  setSessionTitle: (event: SessionTitleEvent) => Promise<void>;
  /**
   * The sections whose composer holds unsent text or attachments. Only the
   * renderer knows this, and the hibernation reaper wants it: a section the user
   * is mid-sentence in should not be the one whose process gets reclaimed.
   * Sent as the whole set so a missed update can never strand a stale id.
   */
  setUnsentDraftSessions: (ids: string[]) => Promise<void>;
  listSessions: () => Promise<string[]>;
  claudeSessionExists: (request: ClaudeSessionExistsRequest) => Promise<boolean>;
  latestClaudeSession: (cwd: string) => Promise<string | null>;
  loadConversation: (request: ConversationLoadRequest) => Promise<ClaudeConversationResult>;
  // Throttled in the main process to one network call per provider per minute;
  // calling more often just returns the cached snapshot.
  // `force` is a refresh the user asked for: it may cut ahead of the background
  // poll interval, but never past a rate-limit cooldown.
  loadUsage: (provider?: UsageProvider, force?: boolean) => Promise<UsageSnapshot | null>;
  /** Models and supported reasoning levels from the installed Codex CLI. */
  listCodexModels: () => Promise<CodexModel[]>;
  getGroqApiKeyConfigured: () => Promise<boolean>;
  setGroqApiKey: (apiKey: string) => Promise<boolean>;
  listGroqModels: () => Promise<GroqModel[]>;
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
  // The built-in browser. Every one of these is the same service call an agent's
  // `browser_*` tool makes — the panel is a second driver, not a second owner.
  // The model (who owns tabs, how sections scope them) is in `shared/browser.ts`.
  browserState: () => Promise<BrowserState>;
  /** Tell main which section the user is looking at, for callers that have none. */
  browserSetActiveThread: (threadId: string) => Promise<void>;
  /** Open or close the detached browser window. */
  browserSetFloating: (on: boolean) => Promise<void>;
  /** Report whether a section's browser panel is actually on screen. */
  browserSetPanelVisible: (request: { threadId: string; visible: boolean }) => Promise<void>;
  /** Bring the main window to the section a tab belongs to. */
  browserFocusThread: (threadId: string) => Promise<void>;
  /** Main asking the app to switch sections, from the floating window. */
  onBrowserFocusThread: (callback: (event: { threadId: string }) => void) => () => void;
  browserOpen: (request: BrowserOpenRequest) => Promise<{ ok: boolean; message: string }>;
  browserNavigate: (request: BrowserNavigateRequest) => Promise<{ ok: boolean; message: string }>;
  browserCloseTab: (request: BrowserTabRequest) => Promise<{ ok: boolean; message: string }>;
  browserSelectTab: (request: BrowserTabRequest) => Promise<void>;
  browserBack: (request: BrowserTabRequest) => Promise<{ ok: boolean; message: string }>;
  browserForward: (request: BrowserTabRequest) => Promise<{ ok: boolean; message: string }>;
  browserReload: (request: BrowserTabRequest) => Promise<{ ok: boolean; message: string }>;
  browserAttach: (request: BrowserAttachRequest) => Promise<void>;
  browserReport: (request: BrowserReportRequest) => Promise<void>;
  /** Renderer acknowledgement for main's temporary capture surface. */
  browserCaptureStageReady: (request: BrowserCaptureStageReadyRequest) => Promise<void>;
  browserSetNoteHidden: (request: BrowserSetNoteHiddenRequest) => Promise<boolean>;
  browserResolveNote: (request: BrowserResolveNoteRequest) => Promise<{ ok: boolean; message?: string }>;
  browserActivity: (limit?: number) => Promise<BrowserActivity[]>;
  onBrowserState: (callback: (state: BrowserState) => void) => () => void;
  onBrowserActivity: (callback: (record: BrowserActivity) => void) => () => void;
  /** Main asking the panel to show itself, for the section that acted. */
  onBrowserReveal: (callback: (event: { threadId: string }) => void) => () => void;
  /** Main asking the live webview host to make one tab paintable for capture. */
  onBrowserCaptureStage: (callback: (event: BrowserCaptureStageEvent) => void) => () => void;
  /** Main releasing the temporary capture surface. */
  onBrowserCaptureRelease: (callback: (event: { requestId: string }) => void) => () => void;
  searchConversations: (request: ConversationSearchRequest) => Promise<ConversationSearchResult[]>;
  loadPreferences: () => Promise<AppPreferences>;
  savePreferences: (preferences: Partial<AppPreferences>) => Promise<AppPreferences>;
  getRemotePairing: () => Promise<RemotePairingInfo>;
  refreshRemotePairing: () => Promise<RemotePairingInfo>;
  listRemotePairedDevices: () => Promise<RemotePairedDevice[]>;
  /** Enable or mute APNs delivery for every phone paired to this desktop. */
  setRemoteMobileNotifications: (enabled: boolean) => Promise<RemotePairedDevice[]>;
  setNotificationChannels: (sessionId: string | null, patch: Partial<NotificationChannels>) => Promise<AppPreferences>;
  getSessionMobileNotifications: (sessionId: string) => Promise<SessionMobileNotificationStatus>;
  setSessionMobileNotifications: (sessionId: string, subscribed: boolean) => Promise<SessionMobileNotificationStatus>;
  revokeRemotePairedDevice: (mobileId: string) => Promise<RemotePairedDevice[]>;
  onRemotePairingChanged: (callback: (info: RemotePairingInfo) => void) => () => void;
  onPreferencesChanged: (callback: (preferences: AppPreferences) => void) => () => void;
  onQuickStart: (callback: () => void) => () => void;
  onAgentAttention: (callback: (event: AgentAttentionEvent) => void) => () => void;
  onSessionData: (callback: (event: SessionDataEvent) => void) => () => void;
  onClaudeSession: (callback: (event: ClaudeSessionEvent) => void) => () => void;
  onSessionTitle: (callback: (event: SessionTitleEvent) => void) => () => void;
  onConversation: (callback: (event: ConversationEvent) => void) => () => void;
  onSessionRuntime: (callback: (event: SessionRuntimeEvent) => void) => () => void;
  onPromptSubmitted: (callback: (event: PromptSubmittedEvent) => void) => () => void;
  onSessionStarted: (callback: (event: SessionStartedEvent) => void) => () => void;
  onSessionStarred: (callback: (event: SessionStarredEvent) => void) => () => void;
  onSessionArchived: (callback: (event: SessionArchivedEvent) => void) => () => void;
  onSessionRemotePrompt: (callback: (event: SessionRemotePromptEvent) => void) => () => void;
  onSessionExit: (callback: (event: SessionExitEvent) => void) => () => void;
  onSessionHibernated: (callback: (event: SessionHibernatedEvent) => void) => () => void;
  btwAsk: (request: BtwAskRequest) => Promise<BtwAskResult>;
  btwClear: (request: BtwClearRequest) => Promise<void>;
  onBtwData: (callback: (event: BtwEvent) => void) => () => void;
  listArtifacts: (request: ArtifactsListRequest) => Promise<ArtifactRun[]>;
  revealPath: (targetPath: string) => Promise<boolean>;
  loadWorkspaceGit: (request: WorkspaceGitRequest) => Promise<WorkspaceGitStatus>;
  /** `git fetch --all --prune`, then the refreshed status. Read-only against the remote. */
  fetchWorkspaceGitRemotes: (request: WorkspaceGitFetchRequest) => Promise<WorkspaceGitStatus>;
  /** One page of `git log`, newest first. */
  loadWorkspaceGitLog: (request: WorkspaceGitLogRequest) => Promise<WorkspaceGitLog>;
  /** Latest GitHub Actions runs, using the user's existing authenticated `gh` CLI. */
  loadWorkspaceWorkflowRuns: (request: WorkspaceWorkflowRunsRequest) => Promise<WorkspaceWorkflowRuns>;
  /** One directory's children, for the drawer's lazily-expanded file tree. */
  loadWorkspaceTree: (request: WorkspaceGitTreeRequest) => Promise<WorkspaceGitTree>;
  /** A text file's contents, for the in-app Markdown reader. */
  readTextFile: (request: TextFileRequest) => Promise<TextFileContents>;
  /** Overwrite a text file the reader has open, for its edit mode's autosave. */
  writeTextFile: (request: TextFileWriteRequest) => Promise<TextFileWriteResult>;
  /** Files this section wrote to, with git's line counts for each. */
  loadSessionFileChanges: (request: SessionFileChangesRequest) => Promise<SessionFileChanges>;
  /** This workspace's kanban board, as it stands on disk. */
  loadBacklog: (cwd: string) => Promise<WorkspaceBacklog>;
  mutateBacklog: (mutation: BacklogMutation) => Promise<BacklogMutationResult>;
  /** Fires when any writer — this window or an agent — changes a board. */
  onBacklogChanged: (callback: (event: BacklogChangedEvent) => void) => () => void;
  /** This workspace's scheduled tasks, as they stand on disk. */
  loadSchedule: (cwd: string) => Promise<WorkspaceSchedule>;
  mutateSchedule: (mutation: ScheduleMutation) => Promise<ScheduleMutationResult>;
  /** Fires when any writer — this window, an agent, or the ticker firing a job — changes a schedule. */
  onScheduleChanged: (callback: (event: ScheduleChangedEvent) => void) => () => void;
  /**
   * This Mac's current state — load, memory, swap, disk and the heaviest
   * processes, with the Panda section each one belongs to where we can tell.
   * `force` skips the probe's short cache (the drawer's Refresh button).
   */
  loadMachineStats: (force?: boolean) => Promise<MachineStats>;
  /**
   * Kill the commands the sections started — the builds and test runs in
   * `sectionCommands`, with their whole subtrees, and never the agents
   * themselves. Omit `pids` to clear every one of them.
   */
  killSectionCommands: (request: KillSectionCommandsRequest) => Promise<KillSectionCommandsResult>;
  /** Which external editors are installed, so the UI only offers real ones. */
  listEditors: () => Promise<EditorTarget[]>;
  openInEditor: (request: OpenInEditorRequest) => Promise<boolean>;
  /** Copies the file at `path` to the clipboard — an image copies as pixels, anything else as a file reference. */
  copyFileToClipboard: (path: string) => Promise<boolean>;
  /** Opens the native attachment menu at the pointer, outside transcript clipping. */
  showAttachmentContextMenu: (path: string) => Promise<boolean>;
  /** False on a build with no compiled speech helper, which hides the microphone entirely. */
  dictationAvailable: () => Promise<boolean>;
  /** Warm the recogniser and train the custom language model, so the first word is not clipped. */
  prepareDictation: () => Promise<void>;
  startDictation: (request: DictationStartRequest) => Promise<boolean>;
  /** Stop listening and let the recogniser flush its last words. */
  stopDictation: () => Promise<void>;
  /** Abandon the utterance without transcribing it. */
  cancelDictation: () => Promise<void>;
  /** Drop the in-flight recognition task after a manual edit, keeping the session alive. */
  restartDictation: () => Promise<void>;
  onDictation: (callback: (event: DictationRendererEvent) => void) => () => void;
};

export type DictationStartRequest = {
  /** The input the transcript types into — see `DictationTarget`. */
  targetId: string;
};
