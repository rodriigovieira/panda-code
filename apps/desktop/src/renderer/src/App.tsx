import { agentAttentionAllowed, normalizeNotificationChannels, resolveNotificationChannels } from "../../shared/notification-channels";
import { codexModelCatalog, codexDisplayName } from "../../shared/model-catalog";
import {
  Activity,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  Bell,
  BookOpen,
  Bot,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  CloudDownload,
  Copy,
  CornerDownRight,
  CornerUpLeft,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  FileDiff,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  GripVertical,
  Image,
  Info,
  Kanban,
  LayoutPanelLeft,
  LineChart,
  ListPlus,
  LocateFixed,
  MessageSquare,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Star,
  StarOff,
  TerminalSquare,
  Trash2,
  Unlink,
  User,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Fragment, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import type {
  AgentActivity,
  AgentAttentionEvent,
  AgentState,
  AgentRuntime,
  AppPreferences,
  ArtifactRun,
  ConversationItem,
  ConversationPageCursor,
  ConversationSearchResult,
  CodexModel,
  GroqModel,
  DesktopApi,
  ExecutionMode,
  PendingApproval,
  PersistedThread,
  RemotePairedDevice,
  RemotePairingInfo,
  EditorId,
  EditorTarget,
  SessionFileChange,
  SessionFileChanges,
  SessionModelChange,
  SessionMobileNotificationStatus,
  SessionPromptHistoryEntry,
  SessionRuntimeEvent,
  SessionStatus,
  TokenUsageStats,
  UsageCostReport,
  UsageProvider,
  UsageSnapshot,
  WorkspaceGitCommit,
  WorkspaceGitRemote,
  WorkspaceGitStatus,
  WorkspaceGitTreeEntry,
  WorkspaceWorkflowRun,
} from "../../shared/ipc";
import { CONSERVE_HYGIENE, effectiveHygiene } from "../../shared/ipc";
import { formatTurnDuration, formatTurnTokens, isTurnSummaryItem } from "../../shared/stream-json";
import { canAdopt, topLevelThreads } from "../../shared/workspace-peers";
import { SECTION_TITLE_CAP, compactSectionTitle } from "../../shared/section-title";
import { EMPTY_BTW, mergeBtwItems, serializeBtwContext, type BtwState } from "./btw";
import {
  assistantMessagePresentation,
  groupQuietWork,
  hiddenTranscriptCount as computeHiddenTranscriptCount,
  latestTurnImportant,
  latestTurnTldr,
  mergeConversationItems,
  parsePeerPrompt,
  selectTranscriptsToDrop,
  shouldCollapsePrompt,
  shouldReloadTranscript,
  type FocusedFeedEntry,
} from "./conversation";
import { exportFilename, parseExportCommand, serializeConversation } from "./export";
import { DRAFT_THREAD_ID, isDraftThread, isSectionWorthKeeping, persistableThreads } from "./draft";
import { recordRendererPerf, startRendererPerf } from "./perf-client";
import { FormattedBody } from "./FormattedBody";
import { BacklogCardsContext, OPEN_BACKLOG_ITEM_EVENT, OPEN_EPIC_EVENT, type BacklogCardIndex } from "./inline";
import { buildPromptWithImageAttachments } from "./prompt";
import { promptHistoryPreview } from "./prompt-history";
import {
  localFileUrl,
  mediaFileName,
  OPEN_MEDIA_PREVIEW_EVENT,
  type MediaKind,
  type MediaPreviewRequest,
} from "./media";
import { VideoPlayer } from "./videoPlayer";
import { DocumentReader } from "./DocumentReader";
import {
  documentWordCount,
  isReadableDocPath,
  isTextDocumentRequest,
  OPEN_DOCUMENT_EVENT,
  openDocument,
  type DocumentRequest,
} from "./documents";
import { backlogSessionPrompt, COLUMN_LABELS } from "../../shared/backlog";
import { BacklogBoard } from "./Backlog";
import { SectionTasks, TaskOverlay, useWorkspaceBacklog, type LinkedSection } from "./Task";
import { DICTATION_FALLBACK_LOCALE, DICTATION_LOCALES } from "../../shared/dictation";
import { DictationBar, DictationMicButton } from "./DictationBar";
import { useDictation, useDictationTarget } from "./dictation";
import { ScheduledTasksPanel } from "./ScheduledTasks";
import { emptyBrowserState, type BrowserState } from "../../shared/browser";
import { BrowserPanel, type BrowserPresentation } from "./BrowserPanel";
import { TerminalView } from "./TerminalView";
import { SessionCostCard, UsageReportPanel } from "./usage";
import { MachineDrawer, useMachineStats } from "./machine";

type Thread = PersistedThread;

type WorkspaceGroup = {
  cwd: string;
  /**
   * The group's TOP-LEVEL rows only. A sub-thread is not one of these: it is
   * reached through `childrenById` under the section that opened it, so paging
   * ("show 5 more") counts pieces of work rather than counting a busy
   * orchestrator's children against the sections next to it.
   */
  threads: Thread[];
  lastActiveAt: string;
};

type ContextMenuState = {
  threadId: string;
  x: number;
  y: number;
} | null;

/** Right-click on a project header: the actions belong to the folder, not a section. */
type WorkspaceMenuState = {
  cwd: string;
  x: number;
  y: number;
} | null;

/** Roughly how tall a popover menu is, so it can be flipped away from an edge. */
const MENU_ITEM_HEIGHT = 30;
const MENU_PADDING = 12;

/**
 * Keep a right-click menu inside the window. The click point is a hint, not a
 * contract: a menu opened near the bottom edge would otherwise render half
 * off-screen with no way to scroll it.
 */
function menuPosition(x: number, y: number, itemCount: number): { left: number; top: number } {
  const height = itemCount * MENU_ITEM_HEIGHT + MENU_PADDING;
  const width = 200;
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
}

type ImageAttachment = {
  id: string;
  name: string;
  path: string;
  previewUrl: string;
};

type QueuedPrompt = {
  id: string;
  text: string;
  attachments: ImageAttachment[];
};

type ComposerSlashCommand = {
  id: string;
  label: string;
  insertText: string;
  description: string;
  hint: string;
  keywords: string[];
  runImmediately?: boolean;
};

type ComposerShortcutHint = {
  keys: string;
  description: string;
};

/**
 * A backlog card as the composer's `#` menu shows it.
 *
 * Flattened out of the board on purpose: the composer needs a number, a title
 * and enough context to pick between two cards with similar names, and giving
 * it the whole `BacklogItem` would re-render the field on every edit an agent
 * makes to a description nobody is looking at.
 */
type ComposerCard = {
  number: number;
  title: string;
  summary: string;
  column: string;
};

type LaunchSettings = {
  runtime: AgentRuntime;
  model: string;
  effort: string;
  permissionMode: string;
};

type ImagePreview = {
  path: string;
  url: string;
  /**
   * Images came first; a recording reaches the same viewer now that an agent
   * can put an mp4 in its reply, so the dialog has to know which tag to use.
   */
  kind: MediaKind;
};

type TerminalTab = {
  id: string;
  title: string;
};

type PendingPromptSend = {
  threadId: string;
  prompt: string;
  timeoutId: number;
};

type RuntimeActivity = {
  source: "prompt" | "pty" | "history" | "tokens" | "stream" | "exit";
  at: string;
  detail: string;
};

type RuntimeStatus = Omit<SessionRuntimeEvent, "id">;

type RunInspectorInfo = {
  process: string;
  lastSignal: string;
  latestWork: string;
  staleNotice?: string;
  live: boolean;
};

const STORAGE_KEY = "panda-code.threads.v1";
/**
 * Persisting the section store costs a full re-serialization of every section —
 * measured at ~62 ms in the renderer plus the same again in main, for a store
 * that had reached 7.8 MB. Unbatched, that ran on every `threads` change, and
 * `localStorage.setItem` is synchronous, so the UI thread ate all of it. A short
 * trailing debounce collapses a burst of updates into one write; the pending
 * write is flushed on teardown so nothing is lost if the window closes first.
 */
const THREADS_PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_COMMAND_KEY = "panda-code.default-command.v1";
const DEFAULT_RUNTIME_KEY = "panda-code.default-runtime.v1";
const DEFAULT_MODEL_KEY = "panda-code.default-model.v1";
const DEFAULT_EFFORT_KEY = "panda-code.default-effort.v1";
const DEFAULT_PERMISSION_MODE_KEY = "panda-code.default-permission-mode.v1";
const DEFAULT_CODEX_MODEL_KEY = "panda-code.default-codex-model.v1";
const DEFAULT_CODEX_EFFORT_KEY = "panda-code.default-codex-effort.v1";
const DEFAULT_CODEX_SANDBOX_KEY = "panda-code.default-codex-sandbox.v1";
const DEFAULT_GROQ_MODEL_KEY = "panda-code.default-groq-model.v1";
const LEGACY_CODEX_REVIEW_MODEL = "codex-auto-review";
const USAGE_PROVIDER_KEY = "panda-code.usage-provider.v1";
const EXPANDED_WORKSPACES_KEY = "panda-code.expanded-workspaces.v1";
// View preference, mirrored to the relay so a paired phone's list agrees:
// hides a section from its workspace group without stopping or deleting it.
// The localStorage copy is the offline-first cache; setSessionArchived/
// onSessionArchived keep it in sync with mobile's own archive set.
const ARCHIVED_THREADS_KEY = "panda-code.archived-threads.v1";
// The starred list folds like a workspace group does. Stores the COLLAPSED
// state, so the default — and anything unparseable — is the list showing.
const STARRED_COLLAPSED_KEY = "panda-code.starred-collapsed.v1";
const WORKSPACE_ORDER_KEY = "panda-code.workspace-order.v1";
// Parents whose sub-threads are folded away. Stores the COLLAPSED ones, so the
// default for a section that has just delegated is to show what it delegated.
const COLLAPSED_SUBTHREADS_KEY = "panda-code.collapsed-subthreads.v1";
const NOTIFICATIONS_KEY = "panda-code.notifications.v1";
const AGENT_NOTIFICATIONS_KEY = "panda-code.agent-notifications.v1";
const SESSION_NOTIFICATION_CHANNELS_KEY = "panda-code.session-notification-channels.v1";
// Opt-in quiet transcript: only your prompts, the agent's replies, and the
// final answer stay in the feed; everything else folds into one work group.
const FOCUS_MODE_KEY = "panda-code.focus-mode.v1";
const TERMINAL_TABS_KEY = "panda-code.terminal-tabs.v1";
const SIDEBAR_WIDTH_KEY = "panda-code.sidebar-width.v1";
// Cached so the sidebar can label the scratch group correctly on first paint,
// before the main process answers with the real path.
const SCRATCH_WORKSPACE_KEY = "panda-code.scratch-workspace.v1";
const LEGACY_KEY_PREFIX = "claude-sections.";
const SCRATCH_WORKSPACE_LABEL = "No project";

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 300;

function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

// The /btw side chat lives in its own column to the right of the conversation,
// so it needs its own resizable width the way the section sidebar does.
const BTW_WIDTH_KEY = "panda-code.btw-width.v1";
const BTW_MIN_WIDTH = 280;
const BTW_MAX_WIDTH = 720;
const BTW_DEFAULT_WIDTH = 380;

function clampBtwWidth(value: number): number {
  return Math.min(BTW_MAX_WIDTH, Math.max(BTW_MIN_WIDTH, Math.round(value)));
}

// The browser is the same shape of thing as /btw — a column beside the
// conversation rather than a band under it — so it gets the same treatment.
// Wider by default, because it holds real web pages rather than chat.
const BROWSER_WIDTH_KEY = "panda-code.browser-width.v1";
const BROWSER_MIN_WIDTH = 360;
const BROWSER_DEFAULT_WIDTH = 560;

/**
 * The conversation never gets squeezed out of its own window.
 *
 * A flat maximum is not enough: on a small window a "reasonable" browser width
 * can still leave nothing to talk to the agent in, and then the only way back is
 * a resizer the user can no longer reach. The ceiling is whatever the window can
 * spare after the conversation keeps this much.
 */
const CONVERSATION_MIN_WIDTH = 420;

function clampBrowserWidth(value: number): number {
  const available = (typeof window === "undefined" ? 1440 : window.innerWidth) - CONVERSATION_MIN_WIDTH;
  const max = Math.max(BROWSER_MIN_WIDTH, available);
  return Math.min(max, Math.max(BROWSER_MIN_WIDTH, Math.round(value)));
}

function readStorageItem(key: string): string | null {
  const value = localStorage.getItem(key);
  if (value !== null) {
    return value;
  }
  return localStorage.getItem(key.replace("panda-code.", LEGACY_KEY_PREFIX));
}
const DEFAULT_COMMAND = "claude";
const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_WORKSPACE = "/tmp";
const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
type SelectorOption = { value: string; label: string; hint: string; badge?: string };

const RUNTIME_OPTIONS: Array<{ value: AgentRuntime; label: string; hint: string }> = [
  { value: "claude", label: "Claude", hint: "Run locally with Claude Code" },
  { value: "codex", label: "Codex", hint: "Run locally with Codex" },
  { value: "groq", label: "Groq", hint: "Direct Groq API sessions" },
];
const GROQ_MODEL_OPTIONS: SelectorOption[] = [
  { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", hint: "General coding and reasoning" },
  { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B", hint: "Fast, lightweight responses", badge: "Fast" },
  { value: "openai/gpt-oss-120b", label: "GPT OSS 120B", hint: "Large open-weight model", badge: "Recommended" },
];
const CLAUDE_MODEL_OPTIONS: SelectorOption[] = [
  { value: "", label: "Default", hint: "Use the Claude Code default for this account", badge: "Default" },
  { value: "sonnet", label: "Sonnet", hint: "Latest Sonnet for daily coding, reviews, and features", badge: "Balanced" },
  { value: "opus", label: "Opus", hint: "Latest Opus for complex reasoning and larger refactors", badge: "Advanced" },
  { value: "best", label: "Best available", hint: "Fable where available, otherwise latest Opus", badge: "Auto" },
  { value: "fable", label: "Fable", hint: "Latest Fable (5.1 on current Claude Code), where available", badge: "Deep work" },
  { value: "opusplan", label: "Opus plan", hint: "Opus for planning, Sonnet for execution", badge: "Plan" },
  { value: "sonnet[1m]", label: "Sonnet 1M", hint: "Long-context Sonnet sessions where available", badge: "1M" },
  { value: "opus[1m]", label: "Opus 1M", hint: "Long-context Opus sessions where available", badge: "1M" },
  { value: "haiku", label: "Haiku", hint: "Quick, simple prompts and low-latency checks", badge: "Fast" },
  { value: "claude-opus-5", label: "Opus 5", hint: "Latest Opus — hard reasoning, migrations, and larger refactors", badge: "Pinned" },
  { value: "claude-opus-4-8", label: "Opus 4.8", hint: "Previous-generation Opus — pin when you want 4.8 specifically", badge: "Opus 4.8" },
];
const CODEX_DEFAULT_MODEL_OPTION: SelectorOption = {
  value: "",
  label: "Default",
  hint: "Uses your Codex default model",
  badge: "Default",
};

function codexModelOptions(models: CodexModel[]): SelectorOption[] {
  return [
    CODEX_DEFAULT_MODEL_OPTION,
    ...codexModelCatalog(models).map((model) => ({
      value: model.id,
      label: codexDisplayName(model),
      hint: model.description || `Use ${model.displayName}`,
      badge: model.isDefault ? "Recommended" : model.id === "gpt-6-astra" && !models.some((entry) => entry.id === model.id) ? "Check access" : undefined,
    })),
  ];
}

function modelOptions(runtime: AgentRuntime, codexModels: CodexModel[] = [], groqModels: GroqModel[] = []): SelectorOption[] {
  if (runtime === "codex") return codexModelOptions(codexModels);
  if (runtime === "groq") {
    return groqModels.length > 0
      ? groqModels.map((model) => ({ value: model.id, label: model.displayName, hint: model.description }))
      : GROQ_MODEL_OPTIONS;
  }
  return CLAUDE_MODEL_OPTIONS;
}

function modelLabel(runtime: AgentRuntime, value: string | undefined, codexModels: CodexModel[] = []): string {
  const trimmed = value?.trim() ?? "";
  return modelOptions(runtime, codexModels).find((option) => option.value === trimmed)?.label ?? (trimmed || "Default");
}

const CLAUDE_EFFORT_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "", label: "Default", hint: "Uses your Claude Code default effort" },
  { value: "low", label: "Low", hint: "Fastest, minimal reasoning" },
  { value: "medium", label: "Medium", hint: "Light reasoning" },
  { value: "high", label: "High", hint: "Standard reasoning" },
  { value: "xhigh", label: "X-High", hint: "Deep reasoning" },
  { value: "max", label: "Max", hint: "Deepest reasoning — slowest" },
];
const CODEX_EFFORT_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "", label: "Default", hint: "Uses your Codex default reasoning" },
  { value: "minimal", label: "Minimal", hint: "Small, mechanical tasks" },
  { value: "low", label: "Low", hint: "Quick scoped work" },
  { value: "medium", label: "Medium", hint: "Balanced planning" },
  { value: "high", label: "High", hint: "Deeper reasoning" },
  { value: "xhigh", label: "X-High", hint: "Hard multi-step work" },
];

function effortOptions(
  runtime: AgentRuntime,
  model = "",
  codexModels: CodexModel[] = [],
): Array<{ value: string; label: string; hint: string }> {
  if (runtime !== "codex") return CLAUDE_EFFORT_OPTIONS;
  const selected = model ? codexModelCatalog(codexModels).find((entry) => entry.id === model) : codexModels.find((entry) => entry.isDefault);
  if (!selected || selected.supportedReasoningEfforts.length === 0) return CODEX_EFFORT_OPTIONS;
  const defaultEffort = selected.supportedReasoningEfforts.find(
    (effort) => effort.value === selected.defaultReasoningEffort,
  );
  return [
    {
      value: "",
      label: "Default",
      hint: defaultEffort
        ? `Uses ${selected.displayName}'s ${defaultEffort.value === "xhigh" ? "X-High" : defaultEffort.value} reasoning — ${defaultEffort.description}`
        : `Uses ${selected.displayName}'s default reasoning`,
    },
    ...selected.supportedReasoningEfforts.map((effort) => ({
      value: effort.value,
      label: effort.value === "xhigh" ? "X-High" : effort.value.charAt(0).toUpperCase() + effort.value.slice(1),
      hint: effort.description,
    })),
  ];
}

function effortLabel(runtime: AgentRuntime, value: string | undefined, model = "", codexModels: CodexModel[] = []): string {
  const trimmed = value?.trim() ?? "";
  return effortOptions(runtime, model, codexModels).find((option) => option.value === trimmed)?.label ?? (trimmed || "Default");
}

const CLAUDE_PERMISSION_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "", label: "Ask", hint: "Follows your Claude Code permission settings" },
  { value: "acceptEdits", label: "Accept edits", hint: "Auto-approves file edits in the workspace" },
  { value: "plan", label: "Plan", hint: "Read-only: plans without changing anything" },
  { value: "bypassPermissions", label: "Bypass", hint: "Skips all permission checks — use with care" },
];
const CODEX_SANDBOX_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "read-only", label: "Read-only", hint: "Inspect files without edits" },
  { value: "workspace-write", label: "Workspace write", hint: "Allow edits inside the workspace" },
  { value: "danger-full-access", label: "Full access", hint: "No sandbox restrictions" },
];

function permissionOptions(runtime: AgentRuntime): Array<{ value: string; label: string; hint: string }> {
  return runtime === "codex" ? CODEX_SANDBOX_OPTIONS : CLAUDE_PERMISSION_OPTIONS;
}

function permissionLabel(runtime: AgentRuntime, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return permissionOptions(runtime).find((option) => option.value === trimmed)?.label ?? (trimmed || (runtime === "codex" ? "Read-only" : "Ask"));
}

const COMPOSER_SLASH_COMMANDS: ComposerSlashCommand[] = [
  {
    id: "btw",
    label: "/btw",
    insertText: "/btw ",
    description: "Ask a side question about this session",
    hint: "Runs separately from the main agent",
    keywords: ["btw", "by", "way", "side", "ask"],
  },
  {
    id: "btw-close",
    label: "/btw close",
    insertText: "/btw close",
    description: "Close the side chat",
    hint: "Returns focus to the main prompt",
    keywords: ["btw", "close", "hide"],
    runImmediately: true,
  },
  {
    id: "btw-clear",
    label: "/btw clear",
    insertText: "/btw clear",
    description: "Clear the side chat",
    hint: "Keeps the side chat open",
    keywords: ["btw", "clear", "reset"],
    runImmediately: true,
  },
  {
    id: "export",
    label: "/export",
    insertText: "/export",
    description: "Copy this conversation to the clipboard",
    hint: "Add a filename to write it, or `file` for the save dialog",
    keywords: ["export", "save", "download", "transcript", "markdown", "copy"],
    runImmediately: true,
  },
  {
    id: "prompts",
    label: "/prompts",
    insertText: "/prompts",
    description: "Show prompts sent and queued in this session",
    hint: "Also on ⌘⇧P",
    keywords: ["prompt", "prompts", "history", "queue"],
    runImmediately: true,
  },
];

// ---------------------------------------------------------------------------
// Prompt history classification. A fair share of what lands in the prompt lane
// isn't typed by hand — task notifications, system reminders and slash-command
// wrappers arrive as raw XML blobs. Listing those verbatim turns the /prompts
// dialog into a wall of markup, so each one gets a tag plus a one-line headline
// and keeps its raw body behind a disclosure.

const ANSI_PATTERN = /\u001B?\[[0-9;]*[A-Za-z]/g;

function cleanPromptText(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(/\s+/g, " ").trim();
}

function captureTag(value: string, tag: string): string | null {
  const match = value.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  const inner = match?.[1] ? cleanPromptText(match[1]) : "";
  return inner.length > 0 ? inner : null;
}

type AutomatedPromptRule = {
  tag: string;
  match: RegExp;
  summarize: (body: string) => string | null;
};

const AUTOMATED_PROMPT_RULES: AutomatedPromptRule[] = [
  {
    tag: "Task update",
    match: /^<task-notification>/i,
    summarize: (body) =>
      [captureTag(body, "summary"), captureTag(body, "event")].filter(Boolean).join(" — ") || null,
  },
  {
    tag: "System reminder",
    match: /^<system-reminder>/i,
    summarize: (body) => captureTag(body, "system-reminder"),
  },
  {
    tag: "Command",
    match: /^<command-(name|message|args)>/i,
    summarize: (body) =>
      [captureTag(body, "command-name"), captureTag(body, "command-args")].filter(Boolean).join(" ") || null,
  },
  {
    tag: "Command output",
    match: /^<local-command-(stdout|stderr)>/i,
    summarize: (body) =>
      captureTag(body, "local-command-stdout") ?? captureTag(body, "local-command-stderr"),
  },
];

type PromptClassification = {
  // Non-null when the prompt was machine-authored; used as the chip label.
  tag: string | null;
  headline: string;
};

function classifyPrompt(body: string): PromptClassification {
  const trimmed = body.trim();
  for (const rule of AUTOMATED_PROMPT_RULES) {
    if (rule.match.test(trimmed)) {
      const summary = rule.summarize(trimmed);
      const fallback = cleanPromptText(trimmed.replace(/<[^>]+>/g, " "));
      return { tag: rule.tag, headline: summary ?? (fallback || rule.tag) };
    }
  }
  return { tag: null, headline: cleanPromptText(trimmed) };
}

const COMPOSER_SHORTCUT_HINTS: ComposerShortcutHint[] = [
  { keys: "Enter", description: "Send now, or queue while the agent is working" },
  { keys: "Cmd/Ctrl Enter", description: "Send immediately into the active turn" },
  { keys: "Cmd/Ctrl J", description: "Toggle the terminal" },
  { keys: "Cmd/Ctrl Shift J", description: "Toggle the browser" },
  { keys: "Cmd/Ctrl F", description: "Search conversations" },
  { keys: "Cmd/Ctrl B", description: "Show or hide the sidebar" },
  { keys: "Cmd/Ctrl Shift B", description: "Open this workspace's backlog" },
  { keys: "Cmd/Ctrl Shift G", description: "Git status for this workspace" },
  { keys: "Cmd/Ctrl Shift D", description: "Dictate hands-free — press again to stop" },
  { keys: "Hold Option Space", description: "Dictate while held (push to talk)" },
  { keys: "Cmd/Ctrl 1-9", description: "Switch sections from the sidebar order" },
  { keys: "Cmd/Ctrl [", description: "Back to the previously visited section" },
  { keys: "Cmd/Ctrl ]", description: "Forward again through visited sections" },
  { keys: "Cmd/Ctrl ,", description: "Open Settings" },
];

function agentDisplayName(runtime: AgentRuntime | undefined): string {
  return runtime === "codex" ? "Codex" : runtime === "groq" ? "Groq" : "Claude";
}

// Shared session configuration controls. Only reasoning is ordinal.

type SelectorSliderOption = { value: string; label: string; hint: string; badge?: string };

function SelectorSlider(props: {
  icon: ReactNode;
  label: string;
  accent: string;
  options: SelectorSliderOption[];
  value: string;
  onSelect: (value: string) => void;
}): ReactElement {
  const { icon, label, accent, options, value, onSelect } = props;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const count = options.length;
  const denom = Math.max(1, count - 1);
  const committedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const activeIndex = dragIndex ?? committedIndex;
  const active = options[activeIndex] ?? options[0];
  const pos = (activeIndex / denom) * 100;

  const indexFromClientX = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return committedIndex;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * denom);
  };

  const commit = (index: number): void => {
    const next = options[index];
    if (next && next.value !== value) {
      onSelect(next.value);
    }
  };

  return (
    <div className="selector-slider" style={{ "--slider-accent": accent } as CSSProperties}>
      <div className="selector-slider-head">
        <span className="selector-slider-label">
          <span className="selector-slider-icon">{icon}</span>
          {label}
        </span>
        <span className="selector-slider-value">
          {active?.label}
          {active?.badge ? <em>{active.badge}</em> : null}
        </span>
      </div>
      <div
        ref={trackRef}
        className={`selector-slider-track ${dragIndex !== null ? "dragging" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={denom}
        aria-valuenow={activeIndex}
        aria-valuetext={active?.label}
        onPointerDown={(event) => {
          event.preventDefault();
          (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
          setDragIndex(indexFromClientX(event.clientX));
        }}
        onPointerMove={(event) => {
          if (dragIndex === null) return;
          setDragIndex(indexFromClientX(event.clientX));
        }}
        onPointerUp={(event) => {
          if (dragIndex === null) return;
          const final = indexFromClientX(event.clientX);
          setDragIndex(null);
          commit(final);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            commit(Math.max(0, committedIndex - 1));
          } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            commit(Math.min(count - 1, committedIndex + 1));
          } else if (event.key === "Home") {
            event.preventDefault();
            commit(0);
          } else if (event.key === "End") {
            event.preventDefault();
            commit(count - 1);
          }
        }}
      >
        <span className="selector-slider-rail" />
        <span className="selector-slider-fill" style={{ width: `${pos}%` }} />
        {options.map((option, index) => (
          <button
            key={option.value || "default"}
            type="button"
            className={`selector-slider-tick ${index === committedIndex ? "selected" : ""}`}
            style={{ left: `${(index / denom) * 100}%` }}
            aria-label={option.label}
            title={option.label}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              commit(index);
            }}
          />
        ))}
        <span className="selector-slider-thumb" style={{ left: `${pos}%` }} />
      </div>
      <p className="selector-slider-hint">{active?.hint}</p>
    </div>
  );
}

// A discrete, non-ordinal choice rendered as a row of pills. Used for the
// dimensions where a slider's "continuum" metaphor is misleading — provider,
// permissions, Codex speed. Effort keeps the slider because it IS ordinal.
function PillGroup(props: {
  icon: ReactNode;
  label: string;
  accent: string;
  options: SelectorSliderOption[];
  value: string;
  onSelect: (value: string) => void;
}): ReactElement {
  const { icon, label, accent, options, value, onSelect } = props;
  const active = options.find((option) => option.value === value) ?? options[0];
  return (
    <div className="selector-group" style={{ "--slider-accent": accent } as CSSProperties}>
      <div className="selector-slider-head">
        <span className="selector-slider-label">
          <span className="selector-slider-icon">{icon}</span>
          {label}
        </span>
        {active?.badge ? (
          <span className="selector-slider-value">
            <em>{active.badge}</em>
          </span>
        ) : null}
      </div>
      <div className="selector-pills" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value || "default"}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={`selector-pill ${option.value === value ? "selected" : ""}`}
            title={option.hint}
            onClick={() => onSelect(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="selector-slider-hint">{active?.hint}</p>
    </div>
  );
}

// Shared model browser for session details, quick start, and provider defaults.
function ModelPicker(props: {
  runtime: AgentRuntime;
  model: string;
  codexModels: CodexModel[];
  groqModels?: GroqModel[];
  onSelect: (value: string) => void;
}): ReactElement {
  const { runtime, model, codexModels, groqModels = [], onSelect } = props;
  const [query, setQuery] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setQuery(""); setShowCustom(false); }, [runtime]);
  const options = [...modelOptions(runtime, codexModels, groqModels)];
  if (model && !options.some((option) => option.value === model)) {
    options.push({ value: model, label: model, hint: "Saved custom model", badge: "Custom" });
  }
  const filtered = options.filter((option) =>
    `${option.label} ${option.value} ${option.hint}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const applyCustom = (): void => {
    if (!customDraft.trim()) return;
    onSelect(customDraft.trim());
    setShowCustom(false);
    setQuery("");
  };
  return (
    <div className="selector-group model-browser">
      <div className="selector-slider-head">
        <span className="selector-slider-label"><Cpu size={13} aria-hidden="true" />Model</span>
        <span className="model-browser-count">{options.length} options</span>
      </div>
      <label className="model-browser-search">
        <Search size={14} aria-hidden="true" />
        <input aria-label={`Search ${agentDisplayName(runtime)} models`} placeholder="Find a model…"
          value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              listRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
            }
          }} />
        {query ? <button type="button" aria-label="Clear model search" onClick={() => setQuery("")}><X size={12} /></button> : null}
      </label>
      <div ref={listRef} className="codex-model-options" role="radiogroup" aria-label={`${agentDisplayName(runtime)} model`}
        onKeyDown={(event) => {
          const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0 || !buttons.length) return;
          let next = index;
          if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % buttons.length;
          else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + buttons.length) % buttons.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = buttons.length - 1;
          else return;
          event.preventDefault();
          buttons[next]?.focus();
        }}>
        {filtered.map((option) => (
          <button key={option.value || "default"} type="button" role="radio" aria-checked={option.value === model}
            className={`codex-model-option ${option.value === model ? "selected" : ""}`}
            onClick={() => onSelect(option.value)}>
            <span className="codex-model-copy">
              <span className="codex-model-title"><strong>{option.label}</strong>{option.badge ? <em>{option.badge}</em> : null}</span>
              <span className="codex-model-description">{option.hint}</span>
            </span>
            <span className="codex-model-check" aria-hidden="true">{option.value === model ? <Check size={13} /> : null}</span>
          </button>
        ))}
        {!filtered.length ? <p className="model-browser-empty">No matching models. Try another name or enter a custom ID.</p> : null}
      </div>
      {runtime === "codex" && !codexModels.length ? <p className="selector-slider-hint">No catalog received from Codex yet. Use its default or enter a model ID available to your account.</p> : null}
      <button type="button" className="codex-model-custom" aria-expanded={showCustom}
        onClick={() => { setCustomDraft(query.trim() || model); setShowCustom(!showCustom); }}>
        <Plus size={12} aria-hidden="true" />Use a custom model
      </button>
      {showCustom ? <div className="selector-custom">
        <input aria-label="Custom model ID" value={customDraft} autoFocus spellCheck={false} placeholder="Model ID or alias"
          onChange={(event) => setCustomDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyCustom(); } }} />
        <button type="button" className="selector-custom-apply" disabled={!customDraft.trim()} onClick={applyCustom}>Apply</button>
      </div> : null}
    </div>
  );
}

function ModelSelector(props: {
  runtime: AgentRuntime;
  model: string;
  effort: string;
  codexModels: CodexModel[];
  groqModels?: GroqModel[];
  permissionMode: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  onSelectRuntime: (value: AgentRuntime) => void;
  onSelectModel: (value: string) => void;
  onSelectEffort: (value: string) => void;
  onSelectPermission: (value: string) => void;
}): ReactElement {
  const { runtime, model, effort, permissionMode, codexModels, open, onToggle } = props;
  const isCodex = runtime === "codex";
  const anchorRef = useRef<HTMLDivElement>(null);
  const [availableHeight, setAvailableHeight] = useState(620);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = (): void => {
      const bottom = anchorRef.current?.getBoundingClientRect().bottom ?? 0;
      setAvailableHeight(Math.max(120, window.innerHeight - bottom - 24));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // Capture-phase so the selector still dismisses inside containers (e.g. the
  // quick-start dialog) that stopPropagation before clicks reach window.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) {
        onToggle(false);
      }
    };
    anchorRef.current?.querySelector<HTMLInputElement>(".model-browser-search input")?.focus();
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open, onToggle]);

  const summary = modelLabel(runtime, model, codexModels) + (runtime === "groq" ? "" : ` · ${effortLabel(runtime, effort, model, codexModels)}`);

  return (
    <div className="model-select-anchor" ref={anchorRef}>
      <button
        className={`quiet-action model-select-button ${open ? "active" : ""}`}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggle(!open);
        }}
        aria-label="Configure model, effort, and permissions for this section"
        title="Session model & permissions"
        aria-expanded={open}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
        <span className="model-select-provider">{agentDisplayName(runtime)}</span>
        <span className="model-select-summary">{summary}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="selector-card" style={{ maxHeight: availableHeight }} role="dialog" aria-label="Session model" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onToggle(false); anchorRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); } }}>
          <div className="model-panel-heading"><div><strong>Session configuration</strong><span>Changes apply to this section</span></div><button type="button" className="ghost-icon-button" aria-label="Close model selector" onClick={() => onToggle(false)}><X size={15} /></button></div>
          <PillGroup
            icon={<Bot size={13} aria-hidden="true" />}
            label="Provider"
            accent="#7ab7ff"
            options={RUNTIME_OPTIONS.map((option) => ({ value: option.value, label: option.label, hint: option.hint }))}
            value={runtime}
            onSelect={(value) => props.onSelectRuntime(value as AgentRuntime)}
          />
          <ModelPicker runtime={runtime} model={model} codexModels={codexModels} groqModels={props.groqModels} onSelect={props.onSelectModel} />
          {runtime !== "groq" ? <SelectorSlider
            icon={<Zap size={13} aria-hidden="true" />}
            label={isCodex ? "Reasoning" : "Effort"}
            accent="#66c98b"
            options={effortOptions(runtime, model, codexModels)}
            value={effort}
            onSelect={props.onSelectEffort}
          /> : null}
          <PillGroup
            icon={<ShieldCheck size={13} aria-hidden="true" />}
            label={isCodex ? "Sandbox" : "Permissions"}
            accent="#ef8f6a"
            options={permissionOptions(runtime)}
            value={permissionMode}
            onSelect={props.onSelectPermission}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One provider's launch defaults, built from the same pickers the per-session
 * selector uses. Both providers get their own card so switching the default
 * provider doesn't hide (or silently retarget) the other one's settings.
 */
function RuntimeDefaults(props: {
  runtime: AgentRuntime;
  isDefault: boolean;
  model: string;
  effort: string;
  codexModels: CodexModel[];
  groqModels?: GroqModel[];
  permissionMode: string;
  onSelectModel: (value: string) => void;
  onSelectEffort: (value: string) => void;
  onSelectPermission: (value: string) => void;
}): ReactElement {
  const isCodex = props.runtime === "codex";
  return (
    <section className={`runtime-defaults ${props.isDefault ? "is-default" : ""}`}>
      <header className="runtime-defaults-head">
        <h3>{agentDisplayName(props.runtime)} defaults</h3>
        {props.isDefault ? <span className="runtime-defaults-badge">Default provider</span> : null}
      </header>
      <ModelPicker runtime={props.runtime} model={props.model} codexModels={props.codexModels} groqModels={props.groqModels} onSelect={props.onSelectModel} />
      {props.runtime !== "groq" ? <SelectorSlider
        icon={<Zap size={13} aria-hidden="true" />}
        label={isCodex ? "Reasoning" : "Effort"}
        accent="#66c98b"
        options={effortOptions(props.runtime, props.model, props.codexModels)}
        value={props.effort}
        onSelect={props.onSelectEffort}
      /> : null}
      <PillGroup
        icon={<ShieldCheck size={13} aria-hidden="true" />}
        label={isCodex ? "Sandbox" : "Permissions"}
        accent="#ef8f6a"
        options={permissionOptions(props.runtime)}
        value={props.permissionMode}
        onSelect={props.onSelectPermission}
      />
    </section>
  );
}
// A single stream event can't tell a finished turn from a subagent boundary:
// subagents emit their own result/init events, which flip the section to
// "waiting" for a moment before the main agent resumes. Only treat a section
// as finished once it has stayed settled this long, so those blips never fire
// a notification or dock badge.
const FINISH_SETTLE_MS = 4_000;
const INITIAL_VISIBLE_SESSIONS = 5;
const VISIBLE_SESSIONS_STEP = 5;
const EMPTY_TOKEN_USAGE: TokenUsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
};
const EMPTY_USAGE_COST_REPORT: UsageCostReport = {
  tokens: EMPTY_TOKEN_USAGE,
  cost: { inputUsd: 0, outputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, totalUsd: 0, priced: true },
  groups: [],
  unpricedModels: [],
  sessionCount: 0,
  generatedAt: new Date(0).toISOString(),
};
const EMPTY_ATTACHMENTS: ImageAttachment[] = [];
const EMPTY_QUEUED: QueuedPrompt[] = [];
const EMPTY_CONVERSATION: ConversationItem[] = [];
const EMPTY_ARTIFACTS: ArtifactRun[] = [];

const fallbackApi: DesktopApi = {
  selectDirectory: () => Promise.resolve(null),
  ensureScratchWorkspace: () => Promise.resolve(""),
  logEvent: () => Promise.resolve(),
  setBadgeCount: () => Promise.resolve(),
  focusWindow: () => Promise.resolve(),
  perfSnapshot: () => Promise.resolve({ since: Date.now(), operations: [], slowest: [] }),
  perfReset: () => Promise.resolve(),
  reportPerf: () => Promise.resolve(),
  loadThreads: () => Promise.resolve([]),
  saveThreads: () => Promise.resolve(),
  setSessionStarred: () => Promise.resolve(),
  setSessionArchived: () => Promise.resolve(),
  syncLocalArchivedThreads: () => Promise.resolve(),
  setSessionParent: () => Promise.resolve(),
  setSessionTitle: () => Promise.resolve(),
  setUnsentDraftSessions: () => Promise.resolve(),
  listSessions: () => Promise.resolve([]),
  savePastedImage: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  exportConversation: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  claudeSessionExists: () => Promise.resolve(false),
  latestClaudeSession: () => Promise.resolve(null),
  loadConversation: () => Promise.resolve({ items: [], tokenUsage: EMPTY_TOKEN_USAGE }),
  loadUsage: (provider = "claude") =>
    Promise.resolve({
      provider,
      windows: [],
      fetchedAt: new Date().toISOString(),
      unavailableReason: "Usage unavailable.",
    }),
  listCodexModels: () => Promise.resolve([]),
  getGroqApiKeyConfigured: () => Promise.resolve(false),
  setGroqApiKey: () => Promise.resolve(false),
  listGroqModels: () => Promise.resolve([]),
  loadUsageCost: () => Promise.resolve(EMPTY_USAGE_COST_REPORT),
  startSession: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  sendInput: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  answerApproval: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  getPathForFile: () => "",
  resizeSession: () => Promise.resolve(),
  stopSession: () => Promise.resolve(),
  killSectionCommands: () => Promise.resolve({ killed: 0, names: [] }),
  startTerminal: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  terminalInput: () => Promise.resolve(),
  resizeTerminal: () => Promise.resolve(),
  stopTerminal: () => Promise.resolve(),
  listTerminals: () => Promise.resolve([]),
  onTerminalData: () => () => undefined,
  onTerminalExit: () => () => undefined,
  onAgentAttention: () => () => undefined,
  browserState: () => Promise.resolve(emptyBrowserState()),
  browserOpen: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  browserNavigate: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  browserCloseTab: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  browserSelectTab: () => Promise.resolve(),
  browserSetActiveThread: () => Promise.resolve(),
  browserSetFloating: () => Promise.resolve(),
  browserSetPanelVisible: () => Promise.resolve(),
  browserFocusThread: () => Promise.resolve(),
  onBrowserFocusThread: () => () => undefined,
  browserBack: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  browserForward: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  browserReload: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  browserAttach: () => Promise.resolve(),
  browserReport: () => Promise.resolve(),
  browserSetNoteHidden: () => Promise.resolve(false),
  browserResolveNote: () => Promise.resolve({ ok: false }),
  browserActivity: () => Promise.resolve([]),
  onBrowserState: () => () => undefined,
  onBrowserActivity: () => () => undefined,
  onBrowserReveal: () => () => undefined,
  browserCaptureStageReady: () => Promise.resolve(),
  onBrowserCaptureStage: () => () => undefined,
  onBrowserCaptureRelease: () => () => undefined,
  searchConversations: () => Promise.resolve([]),
  loadPreferences: () =>
    Promise.resolve({
      quickStartShortcut: "",
      hideDockIcon: false,
      notificationsPaused: false,
      remoteKeepAwake: "off",
      conserveMode: false,
      preferredEditor: "cursor",
      relayUrl: "",
      dictationLocale: DICTATION_FALLBACK_LOCALE,
      maxLiveSessions: 6,
      idleSessionTimeoutMinutes: 30,
      transcriptWindowSize: 2000,
      retainedTranscripts: 12,
    }),
  savePreferences: () =>
    Promise.resolve({
      quickStartShortcut: "",
      hideDockIcon: false,
      notificationsPaused: false,
      remoteKeepAwake: "off",
      conserveMode: false,
      preferredEditor: "cursor",
      relayUrl: "",
      dictationLocale: DICTATION_FALLBACK_LOCALE,
      maxLiveSessions: 6,
      idleSessionTimeoutMinutes: 30,
      transcriptWindowSize: 2000,
      retainedTranscripts: 12,
    }),
  getRemotePairing: () => Promise.resolve({ status: "disabled", message: "Remote relay is unavailable." }),
  refreshRemotePairing: () => Promise.resolve({ status: "disabled", message: "Remote relay is unavailable." }),
  listRemotePairedDevices: () => Promise.resolve([]),
  setRemoteMobileNotifications: () => Promise.resolve([]),
  setNotificationChannels: () => fallbackApi.loadPreferences(),
  getSessionMobileNotifications: () => Promise.resolve({ available: false, phoneCount: 0, subscribedPhones: 0 }),
  setSessionMobileNotifications: () => Promise.resolve({ available: false, phoneCount: 0, subscribedPhones: 0 }),
  revokeRemotePairedDevice: () => Promise.resolve([]),
  onRemotePairingChanged: () => () => undefined,
  onPreferencesChanged: () => () => undefined,
  onQuickStart: () => () => undefined,
  onSessionData: () => () => undefined,
  onClaudeSession: () => () => undefined,
  onSessionTitle: () => () => undefined,
  onConversation: () => () => undefined,
  onSessionRuntime: () => () => undefined,
  onPromptSubmitted: () => () => undefined,
  onSessionStarted: () => () => undefined,
  onSessionStarred: () => () => undefined,
  onSessionArchived: () => () => undefined,
  onSessionRemotePrompt: () => () => undefined,
  onSessionExit: () => () => undefined,
  onSessionHibernated: () => () => undefined,
  btwAsk: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  btwClear: () => Promise.resolve(),
  onBtwData: () => () => undefined,
  listArtifacts: () => Promise.resolve([]),
  revealPath: () => Promise.resolve(false),
  loadWorkspaceGit: () =>
    Promise.resolve({ isRepo: false, remotes: [], changes: [], stashes: [], worktrees: [], branches: [], folders: [] }),
  fetchWorkspaceGitRemotes: () =>
    Promise.resolve({ isRepo: false, remotes: [], changes: [], stashes: [], worktrees: [], branches: [], folders: [] }),
  loadWorkspaceGitLog: () => Promise.resolve({ isRepo: false, commits: [], skip: 0, hasMore: false }),
  loadWorkspaceWorkflowRuns: () => Promise.resolve({ runs: [], limit: 10, hasMore: false }),
  loadWorkspaceTree: () => Promise.resolve({ path: "", entries: [] }),
  readTextFile: (request) =>
    Promise.resolve({ path: request.path, name: "", content: "", size: 0, truncated: false, error: "Desktop bridge is unavailable." }),
  writeTextFile: (request) =>
    Promise.resolve({ path: request.path, size: 0, savedAt: 0, error: "Desktop bridge is unavailable." }),
  loadSessionFileChanges: () => Promise.resolve({ isRepo: false, files: [], added: 0, removed: 0 }),
  loadBacklog: (cwd: string) => Promise.resolve({ version: 1 as const, cwd, items: [], nextNumber: 1, updatedAt: new Date(0).toISOString() }),
  mutateBacklog: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  onBacklogChanged: () => () => {},
  loadSchedule: (cwd: string) => Promise.resolve({ version: 1 as const, cwd, items: [], updatedAt: new Date(0).toISOString() }),
  mutateSchedule: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  onScheduleChanged: () => () => {},
  loadMachineStats: () =>
    Promise.resolve({
      capturedAt: new Date(0).toISOString(),
      hostname: "unavailable",
      platform: "unknown",
      uptimeSec: 0,
      cpuCount: 1,
      loadAvg: [0, 0, 0] as [number, number, number],
      cpuPct: null,
      memTotalBytes: 0,
      memAvailableBytes: null,
      memUsedPct: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
      diskUsedPct: null,
      diskFreeBytes: null,
      topByCpu: [],
      topByMemory: [],
      sectionCommands: [],
      error: "Desktop bridge is unavailable. Open this inside Electron.",
    }),
  listEditors: () => Promise.resolve([]),
  openInEditor: () => Promise.resolve(false),
  copyFileToClipboard: () => Promise.resolve(false),
  showAttachmentContextMenu: () => Promise.resolve(false),
  dictationAvailable: () => Promise.resolve(false),
  prepareDictation: () => Promise.resolve(),
  startDictation: () => Promise.resolve(false),
  stopDictation: () => Promise.resolve(),
  cancelDictation: () => Promise.resolve(),
  restartDictation: () => Promise.resolve(),
  onDictation: () => () => undefined,
};

// The /btw side-chat defaults to a fast model — it is a quick aside about the
// session, not the main working turn.
const BTW_MODEL = "haiku";

function commandForRuntime(runtime: AgentRuntime, command?: string): string {
  const trimmed = command?.trim();
  if (trimmed) {
    return trimmed;
  }
  return runtime === "codex" ? DEFAULT_CODEX_COMMAND : DEFAULT_COMMAND;
}

function createThread(cwd = DEFAULT_WORKSPACE, runtime: AgentRuntime = storedDefaultRuntime(), command?: string): Thread {
  const createdAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "Untitled",
    titleSource: "auto",
    cwd,
    command: commandForRuntime(runtime, command),
    runtime,
    executionMode: "stream-json",
    status: "idle",
    agentState: "exited",
    createdAt,
    lastActiveAt: createdAt,
  };
}

/**
 * The uncommitted section behind the New Session route. Nothing about it is
 * real: no process, no relay row, no threads.json entry. Sending promotes a copy
 * to a real thread (see promoteDraftThread) and resets this one, so abandoning a
 * draft costs exactly nothing — which is the point. Sections used to be created
 * at "+" time, which left behind a trail of never-prompted "Untitled" rows.
 */
function createDraftThread(
  cwd = DEFAULT_WORKSPACE,
  runtime: AgentRuntime = storedDefaultRuntime(),
  command?: string,
): Thread {
  const createdAt = new Date().toISOString();
  return {
    id: DRAFT_THREAD_ID,
    title: "New session",
    titleSource: "auto",
    cwd,
    command: commandForRuntime(runtime, command),
    runtime,
    executionMode: "stream-json",
    status: "idle",
    agentState: "exited",
    draft: true,
    createdAt,
    lastActiveAt: createdAt,
  };
}

function storedDefaultCommand(): string {
  return readStorageItem(DEFAULT_COMMAND_KEY)?.trim() || DEFAULT_COMMAND;
}

function storedDefaultRuntime(): AgentRuntime {
  const stored = readStorageItem(DEFAULT_RUNTIME_KEY);
  return stored === "codex" || stored === "groq" ? stored : "claude";
}

function storedDefaultModel(): string {
  return readStorageItem(DEFAULT_MODEL_KEY)?.trim() ?? "";
}

function storedDefaultEffort(): string {
  return readStorageItem(DEFAULT_EFFORT_KEY)?.trim() ?? "";
}

function storedDefaultPermissionMode(): string {
  return readStorageItem(DEFAULT_PERMISSION_MODE_KEY)?.trim() ?? "";
}

function storedDefaultCodexModel(): string {
  const stored = readStorageItem(DEFAULT_CODEX_MODEL_KEY)?.trim() ?? "";
  return stored === LEGACY_CODEX_REVIEW_MODEL ? "" : stored;
}

function storedDefaultCodexEffort(): string {
  return readStorageItem(DEFAULT_CODEX_EFFORT_KEY)?.trim() ?? "";
}

function storedDefaultCodexSandbox(): string {
  return readStorageItem(DEFAULT_CODEX_SANDBOX_KEY)?.trim() || "read-only";
}

function storedDefaultGroqModel(): string {
  const stored = readStorageItem(DEFAULT_GROQ_MODEL_KEY)?.trim();
  return stored === "llama-3.3-70b-versatile" || !stored ? "openai/gpt-oss-120b" : stored;
}

// Codex sessions default to the persistent app-server transport; "exec" keeps
// the legacy one-shot `codex exec --json` path. See docs/codex-app-server-migration.md.
function storedNotificationsEnabled(): boolean {
  return readStorageItem(NOTIFICATIONS_KEY) !== "off";
}

function storedAgentNotificationsEnabled(): boolean {
  return readStorageItem(AGENT_NOTIFICATIONS_KEY) === "on";
}

type SessionNotificationOverrides = Record<string, { desktop?: boolean; agent?: boolean }>;

function storedSessionNotificationOverrides(): SessionNotificationOverrides {
  try {
    const parsed = JSON.parse(readStorageItem(SESSION_NOTIFICATION_CHANNELS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SessionNotificationOverrides : {};
  } catch {
    return {};
  }
}

/** A quiet five-second two-note chime for the full-screen agent notificator. */
function playAgentNotificationSound(): () => void {
  const context = new AudioContext();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.035, context.currentTime);
  gain.connect(context.destination);
  const oscillators: OscillatorNode[] = [];
  for (let offset = 0; offset < 5; offset += 0.8) {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = Math.round(offset) % 2 === 0 ? 523.25 : 659.25;
    oscillator.connect(gain);
    oscillator.start(context.currentTime + offset);
    oscillator.stop(context.currentTime + Math.min(offset + 0.24, 5));
    oscillators.push(oscillator);
  }
  const timer = window.setTimeout(() => void context.close(), 5_000);
  return () => {
    window.clearTimeout(timer);
    for (const oscillator of oscillators) {
      try { oscillator.stop(); } catch { /* already stopped */ }
    }
    void context.close();
  };
}

function storedFocusMode(): boolean {
  return readStorageItem(FOCUS_MODE_KEY) === "on";
}

function storedScratchWorkspace(): string {
  return readStorageItem(SCRATCH_WORKSPACE_KEY)?.trim() ?? "";
}

function storedCollapsedSubthreads(): Set<string> {
  const stored = readStorageItem(COLLAPSED_SUBTHREADS_KEY);
  if (!stored) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function storedSidebarWidth(): number {
  const raw = Number(readStorageItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_DEFAULT_WIDTH;
}

function storedBtwWidth(): number {
  const raw = Number(readStorageItem(BTW_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampBtwWidth(raw) : BTW_DEFAULT_WIDTH;
}

function storedBrowserWidth(): number {
  const raw = Number(readStorageItem(BROWSER_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampBrowserWidth(raw) : BROWSER_DEFAULT_WIDTH;
}

function storedUsageProvider(): UsageProvider {
  return readStorageItem(USAGE_PROVIDER_KEY) === "codex" ? "codex" : "claude";
}

function loadStoredTerminalTabs(): Record<string, TerminalTab[]> {
  const stored = readStorageItem(TERMINAL_TABS_KEY);
  if (!stored) {
    return {};
  }

  try {
    const parsed = JSON.parse(stored) as Record<string, TerminalTab[]>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadExpandedWorkspaces(): Set<string> {
  const stored = readStorageItem(EXPANDED_WORKSPACES_KEY);
  if (!stored) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(stored) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function loadStarredCollapsed(): boolean {
  return readStorageItem(STARRED_COLLAPSED_KEY) === "true";
}

function loadArchivedThreads(): Set<string> {
  const stored = readStorageItem(ARCHIVED_THREADS_KEY);
  if (!stored) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(stored) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

// Manual, drag-and-drop workspace order (list of cwds). Kept separate from
// thread activity so workspaces hold their place instead of reshuffling to the
// top on every new event.
function loadWorkspaceOrder(): string[] {
  const stored = readStorageItem(WORKSPACE_ORDER_KEY);
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter((cwd): cwd is string => typeof cwd === "string") : [];
  } catch {
    return [];
  }
}

// Move one keyed item to an absolute position in the list. Shared by the drag
// preview and the committed drop so what the sidebar shows mid-drag is exactly
// what releasing produces.
function moveItemToIndex<T>(items: T[], keyOf: (item: T) => string, key: string, index: number): T[] {
  const from = items.findIndex((item) => keyOf(item) === key);
  if (from === -1) {
    return items;
  }
  const target = Math.max(0, Math.min(index, items.length - 1));
  if (from === target) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return items;
  }
  next.splice(target, 0, moved);
  return next;
}

// Stable key for ORDERING the session list. Deliberately NOT `lastActiveAt`:
// that field is restamped to `now` on non-prompt events (session-id resolution,
// title, snapshot replay) — and `listSessions()` replays a batch of them on
// every renderer reload, which vaulted old, never-prompted sessions to the top
// of the sidebar. `lastPromptAt` (real user activity) with a `createdAt`
// fallback keeps ordering stable across reloads. Dedup "which duplicate wins"
// still uses `lastActiveAt` on purpose — there it picks the freshest copy of
// the SAME session, not the list position.
function threadOrderKey(thread: Thread): string {
  return thread.lastPromptAt ?? thread.createdAt;
}

/**
 * A section's rows in the order the sidebar paints them: itself, then each
 * visible sub-thread's own subtree.
 *
 * Drives Cmd+1-9, which counts what is ON SCREEN — a numbering that skipped the
 * nested rows would point at the wrong section for every row below the first
 * parent that has any. Depth is capped where the links are written
 * (`MAX_SUBTHREAD_DEPTH`), and the recursion follows a tree that cannot contain
 * a cycle for the same reason.
 */
function flattenThreadTree(
  thread: Thread,
  childrenByParent: Map<string, Thread[]>,
  collapsed: ReadonlySet<string>,
  visibleSubthreadCounts: Readonly<Record<string, number>>,
): Thread[] {
  const rows = [thread];
  if (collapsed.has(thread.id)) {
    return rows;
  }
  const children = childrenByParent.get(thread.id) ?? [];
  const visible = Math.min(visibleSubthreadCounts[thread.id] ?? INITIAL_VISIBLE_SESSIONS, children.length);
  for (const child of children.slice(0, visible)) {
    rows.push(...flattenThreadTree(child, childrenByParent, collapsed, visibleSubthreadCounts));
  }
  return rows;
}

function dedupeThreadsByClaudeSession(threads: Thread[]): Thread[] {
  const byClaudeSession = new Map<string, Thread>();
  const byCodexThread = new Map<string, Thread>();
  const withoutClaudeSession: Thread[] = [];

  for (const thread of threads) {
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
    (second.lastPromptAt ?? second.lastActiveAt).localeCompare(first.lastPromptAt ?? first.lastActiveAt),
  );
}

/**
 * Settle sections this renderer has no evidence are alive.
 *
 * Only for threads read out of localStorage, where "running" is a leftover from
 * however the last window went away. It is NOT applied to what main returns
 * from `threads:load`: main checks the actual processes, so a second window
 * opening while the first has live sections must take main's word rather than
 * declaring them all dead and persisting that.
 */
function settleStoredThreads(threads: Thread[]): Thread[] {
  return threads.map((thread) =>
    thread.status === "running" ? { ...thread, status: "exited" as const, agentState: "exited" as const } : thread,
  );
}

function normalizeThreads(threads: Thread[]): Thread[] {
  const normalizedThreads =
    threads.length > 0
      ? threads.map((thread) => {
          const runtime = thread.runtime ?? "claude";
          return {
            ...thread,
            runtime,
            command:
              runtime === "codex" && (!thread.command.trim() || thread.command.trim() === DEFAULT_COMMAND)
                ? DEFAULT_CODEX_COMMAND
                : thread.command,
            // Older builds exposed a synthetic review mode as a model. It is
            // not advertised by Codex's model catalog, so migrate it back to
            // the provider default instead of surfacing it as a fake custom model.
            model: runtime === "codex" && thread.model === LEGACY_CODEX_REVIEW_MODEL ? undefined : thread.model,
            titleSource: thread.titleSource ?? "auto",
            executionMode: "stream-json" as const,
            agentState: thread.agentState ?? "exited",
          };
        })
      : // Nothing stored means a first run (or a cleared list), which lands on the
        // New Session route. Creating a placeholder section here is what used to
        // make the app open on an "Untitled" thread that had never run anything.
        [];

  // A `draft` flag has no business surviving a reload; an older build that
  // persisted one would otherwise resurrect it as a real section.
  return dedupeThreadsByClaudeSession(persistableThreads(normalizedThreads).filter(isSectionWorthKeeping));
}

function loadLocalThreads(): Thread[] {
  const stored = readStorageItem(STORAGE_KEY);
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as Thread[];
    return settleStoredThreads(normalizeThreads(parsed));
  } catch {
    return [];
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function runtimeActivityLabel(activity: RuntimeActivity | undefined, status: SessionStatus): string {
  if (activity) {
    const age = relativeAge(activity.at);
    return age === "now" ? `${activity.detail} just now` : `${activity.detail} ${age} ago`;
  }

  if (status === "running") {
    return "Process alive";
  }

  return "No live process";
}

function compactLine(value: string, maxLength = 130): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function activityAgeMs(activity: RuntimeActivity | undefined): number | null {
  return activity ? Date.now() - new Date(activity.at).getTime() : null;
}

function latestConversationWork(items: ConversationItem[], lastPromptAt?: string): ConversationItem | undefined {
  const promptTime = lastPromptAt ? new Date(lastPromptAt).getTime() : 0;
  return items
    .filter((item) => {
      if (item.kind !== "tool" && item.kind !== "assistant" && item.kind !== "system") {
        return false;
      }

      // The end-of-turn stats caption isn't "work" — skip it so the inspector
      // keeps showing the last real tool/assistant activity.
      if (isTurnSummaryItem(item)) {
        return false;
      }

      if (!item.timestamp) {
        return true;
      }

      return new Date(item.timestamp).getTime() >= promptTime - 1_000;
    })
    .at(-1);
}

function latestToolWork(items: ConversationItem[], lastPromptAt?: string): ConversationItem | undefined {
  const promptTime = lastPromptAt ? new Date(lastPromptAt).getTime() : 0;
  return items
    .filter((item) => {
      if (item.kind !== "tool") {
        return false;
      }

      if (!item.timestamp) {
        return true;
      }

      return new Date(item.timestamp).getTime() >= promptTime - 1_000;
    })
    .at(-1);
}

function runInspectorInfo(
  thread: Thread,
  items: ConversationItem[],
  activity: RuntimeActivity | undefined,
  runtimeStatus: RuntimeStatus | undefined,
): RunInspectorInfo {
  if (thread.executionMode === "stream-json" && runtimeStatus) {
    const age = Date.now() - new Date(runtimeStatus.lastEventAt).getTime();
    const latestWork = runtimeStatus.latestTool
      ? `${runtimeStatus.latestTool}: ${compactLine(runtimeStatus.latestCommand ?? "tool activity")}`
      : latestConversationWork(items, thread.lastPromptAt)
        ? `${latestConversationWork(items, thread.lastPromptAt)?.title ?? "Activity"}: ${compactLine(
            latestConversationWork(items, thread.lastPromptAt)?.body ?? "",
          )}`
        : "Waiting for the next stream event.";

    return {
      process:
        thread.status === "running"
          ? "Process alive"
          : thread.status === "error"
            ? "Stream process errored"
            : "Stream process exited",
      lastSignal: `Stream ${runtimeStatus.currentEventType} ${relativeAge(runtimeStatus.lastEventAt)} ago`,
      latestWork,
      live: thread.status === "running",
      staleNotice:
        thread.status === "running" && age > 90_000
          ? `No stream update for ${relativeAge(runtimeStatus.lastEventAt)}. The process is still alive — ${agentDisplayName(thread.runtime)} is likely running a long tool or background work.`
          : undefined,
    };
  }

  const latestWork = latestConversationWork(items, thread.lastPromptAt);
  const latestTool = latestToolWork(items, thread.lastPromptAt);
  const age = activityAgeMs(activity);
  const staleNotice =
    thread.status === "running" && age !== null && age > 120_000
      ? `No new local signal for ${relativeAge(activity?.at)}. ${agentDisplayName(thread.runtime)} may still be computing, or waiting silently.`
      : undefined;

  const latestWorkLabel = latestTool
    ? `${latestTool.title ?? "Tool"}: ${compactLine(latestTool.body)}`
    : latestWork
      ? `${latestWork.title ?? (latestWork.kind === "assistant" ? agentDisplayName(thread.runtime) : "Activity")}: ${compactLine(latestWork.body)}`
      : thread.lastPromptAt
        ? "No tool call or assistant update recorded after the last prompt yet."
        : "No work recorded yet.";

  return {
    process: thread.status === "running" ? "Process alive" : thread.status === "error" ? "Process errored" : "No live process",
    lastSignal: runtimeActivityLabel(activity, thread.status),
    latestWork: latestWorkLabel,
    live: thread.status === "running",
    staleNotice,
  };
}

const HANDOFF_ITEM_LIMIT = 80;
const HANDOFF_BODY_LIMIT = 1_200;
const HANDOFF_TOTAL_LIMIT = 24_000;

function handoffItemLabel(item: ConversationItem): string {
  if (item.kind === "user") {
    return "User";
  }
  if (item.kind === "assistant") {
    return item.title ?? "Assistant";
  }
  if (item.kind === "tool") {
    return `Tool${item.title ? ` (${item.title})` : ""}`;
  }
  if (item.kind === "marker") {
    return item.title ?? "Marker";
  }
  return item.title ?? "System";
}

function compactHandoffBody(value: string, maxLength = HANDOFF_BODY_LIMIT): string {
  // `[^\S\n]+` (not `\s+`) so trailing spaces go but paragraph breaks survive.
  const normalized = value.replace(/[^\S\n]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function runtimeHandoffPrompt(thread: Thread, items: ConversationItem[]): string | null {
  if (!thread.handoffFromRuntime || thread.handoffFromRuntime === (thread.runtime ?? "claude")) {
    return null;
  }

  const transcript = items
    .filter((item) => item.body.trim() && !item.id.startsWith("local-thinking:"))
    .slice(-HANDOFF_ITEM_LIMIT)
    .map((item) => {
      const at = item.timestamp ? ` @ ${new Date(item.timestamp).toISOString()}` : "";
      return `### ${handoffItemLabel(item)}${at}\n${compactHandoffBody(item.body)}`;
    })
    .join("\n\n")
    .slice(-HANDOFF_TOTAL_LIMIT)
    .trim();

  if (!transcript) {
    return null;
  }

  const from = agentDisplayName(thread.handoffFromRuntime);
  const to = agentDisplayName(thread.runtime);
  return [
    `<runtime-handoff from="${from}" to="${to}">`,
    `You are continuing a Panda Code section that was previously handled by ${from}. You do not have that agent's hidden session state, so use this transcript excerpt as continuity context.`,
    "Preserve decisions, completed work, open tasks, file paths, commands, and constraints from the transcript. Continue with the user's new request after this handoff; do not redo completed work unless necessary.",
    "",
    transcript,
    "</runtime-handoff>",
  ].join("\n");
}

function relativeAge(value?: string): string {
  if (!value) {
    return "--";
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000));
  const minute = 60;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;

  if (elapsedSeconds < minute) {
    return "now";
  }

  if (elapsedSeconds < hour) {
    return `${Math.floor(elapsedSeconds / minute)}m`;
  }

  if (elapsedSeconds < day) {
    return `${Math.floor(elapsedSeconds / hour)}h`;
  }

  if (elapsedSeconds < week) {
    return `${Math.floor(elapsedSeconds / day)}d`;
  }

  return `${Math.floor(elapsedSeconds / week)}w`;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  const trimmed = query.trim();
  if (!trimmed) {
    return text;
  }

  const lower = text.toLowerCase();
  const needle = trimmed.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let matchIndex = lower.indexOf(needle, cursor);
  let key = 0;
  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      nodes.push(text.slice(cursor, matchIndex));
    }
    nodes.push(<mark key={key++}>{text.slice(matchIndex, matchIndex + needle.length)}</mark>);
    cursor = matchIndex + needle.length;
    matchIndex = lower.indexOf(needle, cursor);
  }
  nodes.push(text.slice(cursor));
  return nodes;
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);

// Builds an Electron accelerator string from a keydown event, or null if the
// combo lacks a modifier or is a bare modifier (both unusable as a global
// shortcut). Requires ≥1 modifier so it can't clash with plain typing.
function acceleratorFromEvent(event: React.KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }

  const parts: string[] = [];
  if (event.metaKey) parts.push("Command");
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (parts.length === 0) {
    return null;
  }

  let key = event.key;
  if (key === " ") {
    key = "Space";
  } else if (key.length === 1) {
    key = key.toUpperCase();
  } else if (key.startsWith("Arrow")) {
    key = key.slice(5);
  }

  parts.push(key);
  return parts.join("+");
}

function shortcutDisplay(accelerator: string): string {
  if (!accelerator) {
    return "";
  }

  return accelerator
    .split("+")
    .map((part) => {
      switch (part) {
        case "Command":
          return "⌘";
        case "Control":
          return "⌃";
        case "Alt":
          return "⌥";
        case "Shift":
          return "⇧";
        default:
          return part;
      }
    })
    .join(" ");
}

// Turns provider model ids into compact labels for message headers. Unknown
// formats fall back to the raw id so a newly released model is still visible.
function modelDisplayName(modelId: string): string {
  const claude = modelId.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d+)?$/);
  if (claude) {
    const family = claude[1] ?? "";
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  }

  return modelId.replace(/^gpt-/i, "GPT-").replace(/-(astra|sol|terra|luna)$/i, (_, name: string) =>
    ` ${name.charAt(0).toUpperCase()}${name.slice(1)}`,
  );
}

function modelChangeMarkers(thread: Thread, codexModels: CodexModel[]): ConversationItem[] {
  return (thread.modelChanges ?? []).map((change, index) => {
    const from = modelLabel(change.runtime, change.fromModel, codexModels);
    const to = modelLabel(change.runtime, change.toModel, codexModels);
    return {
      id: `model-change:${thread.id}:${change.at}:${index}`,
      kind: "marker",
      title: "Model changed",
      body: `${from} → ${to}`,
      timestamp: change.at,
    };
  });
}

/**
 * Drops each marker in at the point in the transcript where it happened rather
 * than pinning them all to the end — a model switch made ten turns ago belongs
 * next to the turn it changed, not below the latest reply. The base item order
 * is left untouched; only the markers get placed.
 */
function mergeMarkersByTime(items: ConversationItem[], markers: ConversationItem[]): ConversationItem[] {
  if (markers.length === 0) {
    return items;
  }

  const ordered = [...markers].sort(
    (a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime(),
  );
  const merged: ConversationItem[] = [];
  let next = 0;

  for (const item of items) {
    const at = item.timestamp ? new Date(item.timestamp).getTime() : Number.NaN;
    while (Number.isFinite(at)) {
      const marker = ordered[next];
      if (!marker || new Date(marker.timestamp ?? 0).getTime() > at) {
        break;
      }
      merged.push(marker);
      next += 1;
    }
    merged.push(item);
  }

  return [...merged, ...ordered.slice(next)];
}

function resetsLabel(value: string): string {
  const date = new Date(value);
  const time = formatTime(value);
  if (date.toDateString() === new Date().toDateString()) {
    return time;
  }

  const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  return `${day} ${time}`;
}

function workspaceName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

function gitStatusLabel(code: string): string {
  const map: Record<string, string> = {
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
    C: "copied",
    U: "unmerged",
    "?": "untracked",
    "!": "ignored",
  };
  const parts = code
    .split("")
    .map((char) => (char === " " ? null : map[char] ?? char))
    .filter(Boolean);
  return parts.length > 0 ? Array.from(new Set(parts)).join(" / ") : "unchanged";
}

type GitSyncTone = "synced" | "ahead" | "behind" | "diverged" | "unknown";

/**
 * The one-line answer to "am I in sync?" for a single remote. Tone drives the
 * colour, so "behind" and "diverged" read differently from a clean "up to date".
 */
function gitSyncSummary(remote: WorkspaceGitRemote): { tone: GitSyncTone; label: string } {
  if (!remote.ref) {
    return { tone: "unknown", label: "branch not on this remote" };
  }

  const ahead = remote.ahead ?? 0;
  const behind = remote.behind ?? 0;
  if (ahead === 0 && behind === 0) {
    return { tone: "synced", label: "up to date" };
  }

  if (ahead > 0 && behind > 0) {
    return { tone: "diverged", label: `diverged — ${ahead} ahead, ${behind} behind` };
  }

  return ahead > 0
    ? { tone: "ahead", label: `${ahead} to push` }
    : { tone: "behind", label: `${behind} to pull` };
}

/** Overall drawer headline: the upstream's state if there is one, else the first remote's. */
function gitOverallSync(status: WorkspaceGitStatus): { tone: GitSyncTone; label: string } {
  if (status.remotes.length === 0) {
    return { tone: "unknown", label: "no remotes" };
  }

  const primary = status.remotes.find((remote) => remote.upstream) ?? status.remotes[0];
  if (!primary) {
    return { tone: "unknown", label: "no remotes" };
  }

  const summary = gitSyncSummary(primary);
  return { tone: summary.tone, label: `${primary.ref ?? primary.name} · ${summary.label}` };
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i.test(file.name);
}

function attachedImagePathsFromBody(value: string): string[] {
  const paths = new Set<string>();
  const imagePathPattern = /^\s*-\s+(\/.*?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))\s*$/gim;

  for (const match of value.matchAll(imagePathPattern)) {
    const imagePath = match[1];
    if (imagePath) {
      paths.add(imagePath.trim());
    }
  }

  return Array.from(paths);
}

function bodyWithoutAttachedImageList(value: string): string {
  return value
    .replace(/\n*Attached image files?:\s*\n+(?:\s*-\s+\/[^\n]+\n?)+/gi, "")
    .trim();
}

function agentStateLabel(state: AgentState): string {
  switch (state) {
    case "working":
      return "Working";
    case "waiting":
      return "Ready";
    case "needs_action":
      return "Needs action";
    case "exited":
      return "Exited";
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isNearScrollEnd(element: HTMLElement, threshold = 96): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function needsAction(data: string): boolean {
  const text = stripAnsi(data).toLowerCase();
  const strongSignals = [
    "needs your permission",
    "permission required",
    "permission request",
    "allow this command",
    "allow command?",
    "allow tool?",
    "press enter to continue",
    "no conversation found",
    "monthly spend limit",
    "usage limit",
    "raise it at claude.ai/settings/usage",
  ];

  return strongSignals.some((needle) => text.includes(needle)) || /\b(y\/n|yes\/no)\b/.test(text);
}

function isTerminalNeedsAction(data: string): boolean {
  const text = stripAnsi(data).toLowerCase();
  return [
    "monthly spend limit",
    "usage limit",
    "raise it at claude.ai/settings/usage",
    "no conversation found",
  ].some((needle) => text.includes(needle));
}

function isWaitingForInput(data: string): boolean {
  const text = stripAnsi(data).toLowerCase();
  return [
    "baked for",
    "what can i help you with today?",
    "type / for commands",
  ].some((needle) => text.includes(needle));
}

function hasManualSessionFlag(command: string): boolean {
  return /(^|\s)(--session-id|--resume|-r|--continue|-c)(\s|$)/.test(command);
}

function isThinkingItem(item: ConversationItem): boolean {
  return item.kind === "assistant" && item.id.startsWith("local-thinking:");
}

/**
 * Focus mode hides everything that is not the conversation: tool calls, system
 * activity, thinking, and subagent cards fold into a work group. A runtime
 * handoff is the exception — it carries the user's own prompt inside it.
 */
function isQuietFeedItem(item: ConversationItem): boolean {
  // A subagent is delegated conversation, not background noise: folding its
  // card into an "Agent work" line hides the only place its work is reported.
  if (item.kind === "user" || item.kind === "marker" || item.kind === "agent" || isTurnSummaryItem(item)) {
    return false;
  }

  if (item.kind === "assistant") {
    return isThinkingItem(item);
  }

  if (item.kind === "system") {
    return !runtimeHandoffParts(item.body)?.userPrompt;
  }

  return true;
}

function isPrivateThinkingItem(item: ConversationItem): boolean {
  return item.kind === "system" && item.title === "Thinking" && item.body.startsWith("Private reasoning step.");
}

function hasPostPromptActivity(items: ConversationItem[], lastPromptAt?: string): boolean {
  if (!lastPromptAt) {
    return false;
  }

  const lastPromptTime = new Date(lastPromptAt).getTime();
  return items.some((item) => {
    if (item.kind === "user" || !item.timestamp || isThinkingItem(item)) {
      return false;
    }

    return new Date(item.timestamp).getTime() >= lastPromptTime - 1_000;
  });
}

function thinkingTimestamp(submittedAt: string): string {
  return new Date(new Date(submittedAt).getTime() + 1).toISOString();
}

function hasNearbyThinkingItem(items: ConversationItem[], submittedAt: string): boolean {
  const submittedTime = new Date(submittedAt).getTime();
  return items.some((item) => {
    if (!isThinkingItem(item) || !item.timestamp) {
      return false;
    }

    return Math.abs(new Date(item.timestamp).getTime() - submittedTime) < 10_000;
  });
}

function withoutLocalThinking(items: ConversationItem[]): ConversationItem[] {
  return items.filter((item) => !isThinkingItem(item));
}

type RuntimeHandoffParts = {
  from?: string;
  to?: string;
  context: string;
  userPrompt: string;
};

function runtimeHandoffParts(value: string): RuntimeHandoffParts | null {
  const match = value.match(/^\s*<runtime-handoff\b([^>]*)>([\s\S]*?)<\/runtime-handoff>\s*([\s\S]*)$/i);
  if (!match) {
    return null;
  }

  const attrs = match[1] ?? "";
  const attrValue = (name: string): string | undefined => {
    const attrMatch = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
    return attrMatch?.[1]?.trim() || undefined;
  };

  return {
    from: attrValue("from"),
    to: attrValue("to"),
    context: (match[2] ?? "").trim(),
    userPrompt: (match[3] ?? "").trim(),
  };
}

function isCollapsedByDefaultConversationItem(item: ConversationItem): boolean {
  return item.kind === "tool" || item.kind === "system" || isThinkingItem(item) || Boolean(runtimeHandoffParts(item.body));
}

function compactPreview(value: string, maxLength = 100): string {
  const normalized = value
    .replace(/```([\w-]+)?\n[\s\S]*?```/g, (_match, language: string | undefined) => (language ? `${language} block` : "code block"))
    .replace(/```([\w-]+)?\n[\s\S]*$/g, (_match, language: string | undefined) => (language ? `${language} block` : "code block"))
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

/** Long enough that a mid-turn passage is worth reading at document width. */
const READER_WORD_THRESHOLD = 100;

// FormattedBody lives in ./FormattedBody, and the inline renderer it uses in
// ./inline — the backlog renders Markdown out of the same pair.

function AgentBadge({
  state,
  compact = false,
  onStopClick,
  stopArmed = false,
}: {
  state: AgentState;
  compact?: boolean;
  /** When set, the badge doubles as a stop control (sidebar rows only). */
  onStopClick?: (event: React.SyntheticEvent) => void;
  stopArmed?: boolean;
}): React.ReactElement {
  const stoppable = Boolean(onStopClick);
  // Not a <button>: the badge sits inside the row's own button, and nesting
  // one would be invalid HTML. role/tabIndex/keydown give it the same
  // affordance without the nesting.
  return (
    <span
      className={`agent-badge ${state} ${compact ? "compact" : ""} ${stoppable ? "stoppable" : ""} ${
        stopArmed ? "stop-armed" : ""
      }`}
      {...(stoppable
        ? {
            role: "button" as const,
            tabIndex: 0,
            title: stopArmed ? "Click again to stop this section" : "Stop this section",
            "aria-label": stopArmed ? "Click again to stop this section" : "Stop this section",
            onClick: onStopClick,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                onStopClick?.(event);
              }
            },
          }
        : {})}
    >
      {stopArmed ? (
        <>
          <span className="agent-badge-square" aria-hidden="true" />
          <span>Stop?</span>
        </>
      ) : (
        <>
          {state === "working" ? <span className="agent-spinner" aria-hidden="true" /> : null}
          {state === "needs_action" ? <AlertTriangle size={13} aria-hidden="true" /> : null}
          {state === "waiting" ? <span className="agent-badge-dot" aria-hidden="true" /> : null}
          {state === "exited" ? <span className="agent-badge-square" aria-hidden="true" /> : null}
          <span>{agentStateLabel(state)}</span>
        </>
      )}
    </span>
  );
}

/** One mark on a sidebar row: an icon, optionally a number, and what it means. */
type ThreadMark = {
  key: string;
  className: string;
  icon: React.ReactElement;
  count?: number;
  label: string;
};

/**
 * The marks on a sidebar row — sub-threads, terminals, browser pages, an unsent
 * draft.
 *
 * One of them beside a title is fine. Four is not: the sidebar is narrow and
 * resizable, and pills win that fight against the title every time. So past one
 * they fold into a cluster of bare icons, slightly overlapped, and hovering the
 * cluster spreads them back out with their counts. Nothing is dropped and
 * nothing has to be clicked — the row still says *what* is going on at rest, and
 * says *how much* when you look at it.
 *
 * The counts stay in the DOM while folded (hidden with width, not `display`) so
 * the tooltip and the screen-reader label are the full sentence either way.
 */
function ThreadMarks({ marks }: { marks: (ThreadMark | null)[] }): React.ReactElement | null {
  const present = marks.filter((mark): mark is ThreadMark => mark !== null);
  if (present.length === 0) {
    return null;
  }
  return (
    <span className={`thread-marks ${present.length > 1 ? "grouped" : ""}`}>
      {present.map((mark) => (
        <span key={mark.key} className={`thread-mark ${mark.className}`} title={mark.label} aria-label={mark.label}>
          {mark.icon}
          {mark.count === undefined ? null : <span className="thread-mark-count">{mark.count}</span>}
        </span>
      ))}
    </span>
  );
}

// Whimsical present-participles cycled while the agent works, the way Claude
// Code's CLI teases a live spinner. Purely cosmetic — the spinner already
// signals "busy"; the changing word just makes the wait feel alive.
const WORKING_WORDS = [
  "Thinking",
  "Working",
  "Cooking",
  "Crunching",
  "Pondering",
  "Noodling",
  "Brewing",
  "Churning",
  "Percolating",
  "Conjuring",
  "Computing",
  "Reasoning",
  "Tinkering",
  "Wrangling",
  "Synthesizing",
  "Deliberating",
  "Simmering",
  "Puzzling",
  "Scheming",
  "Whirring",
];

function CyclingWord(): React.ReactElement {
  // Start on a per-mount random word so two sessions don't march in lockstep.
  const [index, setIndex] = useState(() => Math.floor(Math.random() * WORKING_WORDS.length));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % WORKING_WORDS.length);
    }, 2600);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className="working-word" key={index}>
      {WORKING_WORDS[index]}…
    </span>
  );
}

// The live agent status, docked just above the composer (moved down from the
// header) so the "what's it doing" signal sits next to where the user acts.
function WorkingStatusBar({
  state,
  detail,
  workingLabel,
}: {
  state: AgentState;
  detail?: string;
  workingLabel?: string;
}): React.ReactElement | null {
  if (state === "exited") {
    return null;
  }

  if (state === "working") {
    return (
      <div className={`working-status working`} role="status" aria-live="polite">
        <span className="agent-spinner" aria-hidden="true" />
        {workingLabel ? <span className="working-word">{workingLabel}</span> : <CyclingWord />}
        {detail ? <span className="working-status-detail">{detail}</span> : null}
      </div>
    );
  }

  if (state === "needs_action") {
    return (
      <div className="working-status needs_action" role="status" aria-live="polite">
        <AlertTriangle size={13} aria-hidden="true" />
        <span>Needs action</span>
        {detail ? <span className="working-status-detail">{detail}</span> : null}
      </div>
    );
  }

  // waiting
  return (
    <div className="working-status waiting" role="status">
      <span className="agent-badge-dot" aria-hidden="true" />
      <span>Ready</span>
    </div>
  );
}

const FILE_STATUS_META: Record<SessionFileChange["status"], { code: string; label: string; tone: string }> = {
  modified: { code: "M", label: "Modified", tone: "warn" },
  added: { code: "A", label: "Added", tone: "run" },
  untracked: { code: "U", label: "New file — not tracked by git", tone: "run" },
  deleted: { code: "D", label: "Deleted", tone: "danger" },
  clean: { code: "·", label: "Written to, but the working tree matches HEAD", tone: "muted" },
  missing: { code: "?", label: "Not on disk and unknown to git", tone: "muted" },
};

function splitFilePath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/**
 * Five squares split green/red by the file's add:remove ratio — the shape of
 * the change, next to the exact counts that give its size.
 */
function DiffBlips({ added, removed }: { added: number; removed: number }): ReactElement {
  const total = added + removed;
  let addCount = total === 0 ? 0 : Math.round((added / total) * 5);
  if (added > 0 && addCount === 0) addCount = 1;
  if (removed > 0 && addCount === 5) addCount = 4;

  return (
    <span className="files-blips" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => {
        const tone = total === 0 ? "none" : index < addCount ? "add" : "del";
        return <i key={index} className={`files-blip ${tone}`} />;
      })}
    </span>
  );
}

function SessionFilesSummary({ changes }: { changes: SessionFileChanges }): ReactElement {
  const total = changes.added + changes.removed;
  // Nothing changed is not "all removals": leave the track empty rather than
  // letting the deletion half default to the full width.
  const addedShare = total === 0 ? 0 : (changes.added / total) * 100;
  const removedShare = total === 0 ? 0 : 100 - addedShare;

  return (
    <div className={`files-summary${total === 0 ? " is-empty" : ""}`}>
      <div className="files-summary-counts">
        <strong>{changes.files.length}</strong>
        <span>{changes.files.length === 1 ? "file" : "files"}</span>
        <span className="files-add">+{changes.added.toLocaleString()}</span>
        <span className="files-del">−{changes.removed.toLocaleString()}</span>
      </div>
      <div className="files-summary-bar" aria-hidden="true">
        <i className="files-summary-add" style={{ width: `${addedShare}%` }} />
        <i className="files-summary-del" style={{ width: `${removedShare}%` }} />
      </div>
    </div>
  );
}

function SessionFileRow({
  file,
  editorName,
  onOpen,
  onReveal,
}: {
  file: SessionFileChange;
  editorName?: string;
  onOpen: () => void;
  onReveal: () => void;
}): ReactElement {
  const meta = FILE_STATUS_META[file.status];
  const { dir, name } = splitFilePath(file.path);

  return (
    <li className={`git-row files-row ${file.exists ? "" : "gone"}`}>
      <code className={`git-code tone-${meta.tone}`} title={meta.label}>
        {meta.code}
      </code>
      <span className="files-name" title={file.absolutePath}>
        <span className="files-file">{name}</span>
        {dir ? (
          <span className="files-dir">
            <span className="files-dir-inner">{dir.replace(/\/$/, "")}</span>
          </span>
        ) : null}
      </span>
      {file.binary ? (
        <span className="files-binary">binary</span>
      ) : (
        <span className={`files-counts${file.added + file.removed === 0 ? " is-zero" : ""}`}>
          <span className="files-add">+{file.added}</span>
          <span className="files-del">−{file.removed}</span>
        </span>
      )}
      <DiffBlips added={file.added} removed={file.removed} />
      <span className="files-row-actions">
        {isReadableDocPath(file.path) ? (
          // The common case this exists for: an agent was asked for a document
          // and wrote one. Read it here rather than in an editor.
          <button
            className="ghost-icon-button"
            type="button"
            onClick={() => openDocument({ path: file.absolutePath })}
            disabled={!file.exists}
            aria-label="Read in Panda Code"
            title="Read in Panda Code"
          >
            <BookOpen size={13} aria-hidden="true" />
          </button>
        ) : null}
        <button
          className="ghost-icon-button"
          type="button"
          onClick={onOpen}
          disabled={!file.exists}
          aria-label={editorName ? `Open in ${editorName}` : "Open in editor"}
          title={editorName ? `Open in ${editorName}` : "Open in editor"}
        >
          <ExternalLink size={13} aria-hidden="true" />
        </button>
        <button
          className="ghost-icon-button"
          type="button"
          onClick={onReveal}
          disabled={!file.exists}
          aria-label="Reveal in file manager"
          title="Reveal in file manager"
        >
          <Folder size={13} aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}

/** Commits per page in the history tab. */
const GIT_LOG_PAGE_SIZE = 50;

/**
 * A workspace's commit history, one page at a time.
 *
 * Paged rather than infinite-scrolled: the question this answers is "what has
 * been going on here lately", which is a handful of pages at most, and a page
 * you can step back from is easier to hold onto than a list that grows under
 * the scrollbar. Its own state, keyed by `cwd`, so switching workspaces starts
 * over at the head instead of showing page 4 of a different repo.
 */
function GitHistoryPanel({ cwd, desktopApi }: { cwd: string; desktopApi: DesktopApi }): ReactElement {
  const [commits, setCommits] = useState<WorkspaceGitCommit[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void desktopApi
      .loadWorkspaceGitLog({ cwd, skip: page * GIT_LOG_PAGE_SIZE, limit: GIT_LOG_PAGE_SIZE })
      .then((log) => {
        if (cancelled) return;
        setCommits(log.commits);
        setHasMore(log.hasMore);
        setError(log.error ?? null);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to read the commit history");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, desktopApi, page]);

  if (loading && commits.length === 0) {
    return <div className="git-empty">Reading commit history…</div>;
  }

  if (commits.length === 0) {
    return <div className="git-empty">{error ?? "No commits yet."}</div>;
  }

  const first = page * GIT_LOG_PAGE_SIZE + 1;
  const last = page * GIT_LOG_PAGE_SIZE + commits.length;

  return (
    <section className="git-section">
      <div className="git-section-head">
        <span>Commits</span>
        <em>
          {first}–{last}
        </em>
      </div>
      <ul className="git-list git-log-list">
        {commits.map((commit) => (
          <GitCommitRow key={commit.hash} commit={commit} />
        ))}
      </ul>
      <div className="git-log-pager">
        <button
          className="quiet-action"
          type="button"
          onClick={() => setPage((current) => Math.max(0, current - 1))}
          disabled={page === 0 || loading}
        >
          <ChevronUp size={13} aria-hidden="true" />
          Newer
        </button>
        <span className="git-sub">page {page + 1}</span>
        <button
          className="quiet-action"
          type="button"
          onClick={() => setPage((current) => current + 1)}
          disabled={!hasMore || loading}
        >
          <ChevronDown size={13} aria-hidden="true" />
          Older
        </button>
      </div>
      {error ? <p className="git-note">{error}</p> : null}
    </section>
  );
}

function GitCommitRow({ commit }: { commit: WorkspaceGitCommit }): ReactElement {
  const [copied, setCopied] = useState(false);
  const when = commit.date ? relativeAge(commit.date) : "";

  return (
    <li className="git-row git-row-stack git-log-row">
      <span className="git-log-subject" title={commit.subject}>
        {commit.subject || "(no message)"}
      </span>
      <span className="git-log-meta">
        <button
          className="git-log-hash"
          type="button"
          title="Copy the full SHA"
          onClick={() => {
            void navigator.clipboard.writeText(commit.hash).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          <GitCommitHorizontal size={12} aria-hidden="true" />
          {copied ? "copied" : commit.shortHash}
        </button>
        <span className="git-sub">{commit.author}</span>
        {when ? <span className="git-sub">{when === "now" ? "just now" : `${when} ago`}</span> : null}
        {commit.refs.map((ref) => (
          <span key={ref} className="git-badge">
            {ref}
          </span>
        ))}
      </span>
    </li>
  );
}

const WORKFLOW_RUN_BATCH = 10;

function workflowTone(run: WorkspaceWorkflowRun): "success" | "failure" | "active" | "neutral" {
  if (run.status !== "completed") return "active";
  if (run.conclusion === "success") return "success";
  if (["failure", "timed_out", "cancelled", "action_required"].includes(run.conclusion ?? "")) return "failure";
  return "neutral";
}

function workflowStatusLabel(run: WorkspaceWorkflowRun): string {
  if (run.status !== "completed") return run.status.replaceAll("_", " ");
  return (run.conclusion || "completed").replaceAll("_", " ");
}

function GitHubActionsPanel({ cwd, desktopApi }: { cwd: string; desktopApi: DesktopApi }): ReactElement {
  const [runs, setRuns] = useState<WorkspaceWorkflowRun[]>([]);
  const [limit, setLimit] = useState(WORKFLOW_RUN_BATCH);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void desktopApi.loadWorkspaceWorkflowRuns({ cwd, limit }).then((result) => {
      if (cancelled) return;
      setRuns(result.runs);
      setHasMore(result.hasMore);
      setError(result.error ?? null);
    }).catch(() => {
      if (!cancelled) setError("Could not load GitHub Actions runs.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cwd, desktopApi, limit, reload]);

  if (loading && runs.length === 0) return <div className="git-empty">Reading GitHub Actions…</div>;
  if (runs.length === 0) {
    return (
      <div className="git-empty git-actions-empty">
        <span>{error ?? "No workflow runs yet."}</span>
        <button className="quiet-action" type="button" onClick={() => setReload((value) => value + 1)}>Retry</button>
      </div>
    );
  }

  return (
    <section className="git-section">
      <div className="git-section-head git-actions-head">
        <span>Recent workflow runs</span>
        <em>{runs.length}</em>
        <button className="ghost-icon-button" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading} title="Refresh workflow runs" aria-label="Refresh workflow runs">
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      <ul className="git-list git-actions-list">
        {runs.map((run) => {
          const tone = workflowTone(run);
          return (
            <li key={run.databaseId} className="git-row git-row-stack git-action-row">
              <a href={run.url} target="_blank" rel="noreferrer" className="git-action-link">
                <span className={`git-action-status git-action-status-${tone}`} aria-hidden="true">
                  {tone === "success" ? <Check size={12} /> : tone === "failure" ? <X size={12} /> : <Activity size={12} />}
                </span>
                <span className="git-action-copy">
                  <strong title={run.displayTitle}>{run.displayTitle || run.name}</strong>
                  <span className="git-log-meta">
                    <span>{run.name}</span>
                    {run.headBranch ? <span className="git-badge">{run.headBranch}</span> : null}
                    {run.createdAt ? <span>{relativeAge(run.createdAt) === "now" ? "just now" : `${relativeAge(run.createdAt)} ago`}</span> : null}
                  </span>
                </span>
                <span className={`git-action-result git-action-result-${tone}`}>{workflowStatusLabel(run)}</span>
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <button className="quiet-action git-actions-more" type="button" onClick={() => setLimit((value) => value + WORKFLOW_RUN_BATCH)} disabled={loading}>
          {loading ? "Loading…" : "See 10 more"}
        </button>
      ) : null}
      {error ? <p className="git-note">{error}</p> : null}
    </section>
  );
}

/**
 * The workspace as a file tree, read one level at a time.
 *
 * Folders are collapsed until clicked and their children fetched on first
 * expand — a monorepo has hundreds of thousands of files, and none of them are
 * worth walking for a panel nobody has opened. Loaded levels stay cached for
 * as long as the drawer is open, so collapsing and re-expanding is free.
 */
function WorkspaceTreePanel({
  cwd,
  desktopApi,
  editorName,
  onOpen,
  onReveal,
}: {
  cwd: string;
  desktopApi: DesktopApi;
  editorName?: string;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}): ReactElement {
  const [levels, setLevels] = useState<Map<string, WorkspaceGitTreeEntry[]>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

  const load = useCallback(
    (path: string): void => {
      setLoadingPaths((current) => new Set(current).add(path));
      void desktopApi
        .loadWorkspaceTree({ cwd, path })
        .then((tree) => {
          setLevels((current) => new Map(current).set(path, tree.entries));
          setErrors((current) => {
            const next = new Map(current);
            if (tree.error) next.set(path, tree.error);
            else next.delete(path);
            return next;
          });
        })
        .catch(() => {
          setErrors((current) => new Map(current).set(path, "Could not read this folder"));
        })
        .finally(() => {
          setLoadingPaths((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        });
    },
    [cwd, desktopApi],
  );

  // Root only; everything below it waits to be asked for.
  useEffect(() => {
    setLevels(new Map());
    setErrors(new Map());
    setExpanded(new Set());
    load("");
  }, [cwd, load]);

  const toggle = useCallback(
    (path: string): void => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      if (!levels.has(path)) load(path);
    },
    [levels, load],
  );

  const renderLevel = (path: string, depth: number): ReactNode => {
    const entries = levels.get(path);
    const error = errors.get(path);
    if (!entries) {
      return loadingPaths.has(path) ? (
        <li className="git-row git-tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="git-sub">Reading…</span>
        </li>
      ) : error ? (
        <li className="git-row git-tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="git-sub">{error}</span>
        </li>
      ) : null;
    }

    return (
      <>
        {entries.map((entry) => {
          const open = expanded.has(entry.path);
          return (
            <Fragment key={entry.path}>
              <li className={`git-row git-tree-row ${entry.ignored ? "is-ignored" : ""}`} style={{ paddingLeft: 8 + depth * 14 }}>
                {entry.kind === "directory" ? (
                  <button
                    className="git-tree-toggle"
                    type="button"
                    onClick={() => toggle(entry.path)}
                    aria-expanded={open}
                    aria-label={open ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
                  >
                    <ChevronRight size={12} className={open ? "rotated" : ""} aria-hidden="true" />
                    {open ? <FolderOpen size={13} aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />}
                    <span className="git-tree-name">{entry.name}</span>
                  </button>
                ) : isReadableDocPath(entry.name) ? (
                  // A document the app can show itself: the row opens the
                  // reader, the way a folder row expands.
                  <button className="git-tree-leaf git-tree-doc" type="button" onClick={() => openDocument({ path: entry.absolutePath })}>
                    <span className="git-tree-toggle-gap" />
                    <BookOpen size={13} aria-hidden="true" />
                    <span className="git-tree-name">{entry.name}</span>
                    {typeof entry.size === "number" ? <span className="git-sub">{formatBytes(entry.size)}</span> : null}
                  </button>
                ) : (
                  <span className="git-tree-leaf">
                    <span className="git-tree-toggle-gap" />
                    <FileText size={13} aria-hidden="true" />
                    <span className="git-tree-name">{entry.name}</span>
                    {typeof entry.size === "number" ? <span className="git-sub">{formatBytes(entry.size)}</span> : null}
                  </span>
                )}
                <span className="files-row-actions">
                  <button
                    className="ghost-icon-button"
                    type="button"
                    onClick={() => onOpen(entry.absolutePath)}
                    aria-label={editorName ? `Open in ${editorName}` : "Open in editor"}
                    title={editorName ? `Open in ${editorName}` : "Open in editor"}
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                  </button>
                  <button
                    className="ghost-icon-button"
                    type="button"
                    onClick={() => onReveal(entry.absolutePath)}
                    aria-label="Reveal in Finder"
                    title="Reveal in Finder"
                  >
                    <Folder size={13} aria-hidden="true" />
                  </button>
                </span>
              </li>
              {entry.kind === "directory" && open ? renderLevel(entry.path, depth + 1) : null}
            </Fragment>
          );
        })}
        {error ? (
          <li className="git-row git-tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
            <span className="git-sub">{error}</span>
          </li>
        ) : null}
      </>
    );
  };

  const rootEntries = levels.get("");
  if (!rootEntries && loadingPaths.has("")) {
    return <div className="git-empty">Reading the workspace…</div>;
  }

  if (rootEntries && rootEntries.length === 0) {
    return <div className="git-empty">{errors.get("") ?? "This folder is empty."}</div>;
  }

  return (
    <section className="git-section">
      <div className="git-section-head">
        <span>Files</span>
        <em>{rootEntries?.length ?? 0}</em>
      </div>
      <ul className="git-list git-tree">{renderLevel("", 0)}</ul>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Codex is blocked on an approval or a question. Docked above the composer,
 * where the status bar and the prompt already are, because answering it IS the
 * next action — a card buried in the transcript would scroll out of reach.
 */
function ApprovalPanel({
  approval,
  runtime,
  onAnswer,
}: {
  approval: PendingApproval;
  runtime: AgentRuntime | undefined;
  onAnswer: (optionId: string | undefined, text: string | undefined) => void;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // A fresh prompt must never inherit the previous one's half-typed answer.
  useEffect(() => {
    setText("");
    setBusy(false);
  }, [approval.promptId, approval.questionIndex]);

  const answer = (optionId: string | undefined, freeText?: string): void => {
    if (busy) return;
    setBusy(true);
    onAnswer(optionId, freeText);
  };

  const multi = (approval.questionCount ?? 1) > 1;
  return (
    <div className="approval-panel" role="group" aria-label={approval.title}>
      <div className="approval-head">
        <ShieldCheck size={14} aria-hidden="true" />
        <strong>{approval.title}</strong>
        {multi ? (
          <span className="approval-progress">
            {(approval.questionIndex ?? 0) + 1} of {approval.questionCount}
          </span>
        ) : null}
        <span className="approval-runtime">{agentDisplayName(runtime)}</span>
      </div>
      {approval.body ? <pre className="approval-body">{approval.body}</pre> : null}
      {approval.reason ? <p className="approval-reason">{approval.reason}</p> : null}
      {approval.cwd ? <p className="approval-cwd">{approval.cwd}</p> : null}
      <div className="approval-actions">
        {approval.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`approval-option ${option.tone === "deny" ? "is-deny" : "is-approve"}`}
            title={option.hint}
            disabled={busy}
            onClick={() => answer(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {approval.allowsFreeText ? (
        <div className="approval-freetext">
          <input
            type="text"
            value={text}
            placeholder="Type an answer…"
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && text.trim()) {
                event.preventDefault();
                answer(undefined, text.trim());
              }
            }}
          />
          <button type="button" disabled={busy || !text.trim()} onClick={() => answer(undefined, text.trim())}>
            <Send size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

const ConversationCard = memo(function ConversationCard({
  item,
  expanded,
  midTurn = false,
  onToggle,
  onPreviewImage,
}: {
  item: ConversationItem;
  expanded: boolean;
  midTurn?: boolean;
  onToggle: (itemId: string) => void;
  onPreviewImage: (path: string) => void;
}): React.ReactElement {
  const thinking = isThinkingItem(item);
  const privateThinking = isPrivateThinkingItem(item);
  const runtimeHandoff = item.kind === "user" || item.kind === "system" ? runtimeHandoffParts(item.body) : null;
  const peerPrompt = item.kind === "user" ? parsePeerPrompt(item.body) : null;
  const [handoffExpanded, setHandoffExpanded] = useState(expanded);
  const [promptExpanded, setPromptExpanded] = useState(false);

  useEffect(() => {
    setHandoffExpanded(expanded);
  }, [expanded, item.id]);

  useEffect(() => {
    setPromptExpanded(false);
  }, [item.id]);

  // End-of-turn stats footer: a subtle line that reads as a caption on the
  // assistant reply it follows, not a collapsible activity row.
  if (isTurnSummaryItem(item)) {
    return (
      <div className="turn-summary" role="note">
        <Gauge size={12} aria-hidden="true" />
        <span>{item.body}</span>
      </div>
    );
  }

  if (runtimeHandoff) {
    const handoffSummary = [
      runtimeHandoff.from && runtimeHandoff.to
        ? `${runtimeHandoff.from} to ${runtimeHandoff.to}`
        : "Runtime context transfer",
      runtimeHandoff.userPrompt ? "user prompt follows" : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    const attachedImages = runtimeHandoff.userPrompt ? attachedImagePathsFromBody(runtimeHandoff.userPrompt) : [];
    const displayPrompt = attachedImages.length > 0 ? bodyWithoutAttachedImageList(runtimeHandoff.userPrompt) : runtimeHandoff.userPrompt;

    return (
      <>
        <div className="conversation-line system system-notice runtime-handoff-line" data-conversation-item-id={item.id}>
          <button className="conversation-line-header" type="button" onClick={() => setHandoffExpanded((open) => !open)} aria-expanded={handoffExpanded}>
            <span className="conversation-line-icon">
              <ShieldCheck size={15} aria-hidden="true" />
            </span>
            <strong>System handoff</strong>
            <span className="system-origin-badge">Panda Code</span>
            <span className="conversation-preview">{handoffSummary}</span>
            {item.timestamp ? <time>{formatTime(item.timestamp)}</time> : null}
            <span className="collapse-chevron" aria-hidden="true">
              {handoffExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </button>
          <div className={`conversation-collapse-region ${handoffExpanded ? "expanded" : "collapsed"}`}>
            <div className="conversation-line-body runtime-handoff-body">
              <div className="runtime-handoff-summary">{handoffSummary}</div>
              <FormattedBody value={runtimeHandoff.context} />
            </div>
          </div>
        </div>
        {runtimeHandoff.userPrompt ? (
          <article className="conversation-card user">
            <div className="conversation-card-header">
              <span className="conversation-icon">
                <User size={15} aria-hidden="true" />
              </span>
              <strong>You</strong>
              {item.timestamp ? <time>{formatTime(item.timestamp)}</time> : null}
            </div>
            <div className="conversation-body">
              <FormattedBody value={displayPrompt} />
              {attachedImages.length > 0 ? <MessageImageAttachments paths={attachedImages} onPreviewImage={onPreviewImage} /> : null}
            </div>
          </article>
        ) : null}
      </>
    );
  }

  const collapsible = (item.kind === "tool" || item.kind === "system" || thinking) && !privateThinking;
  const promptBody = peerPrompt?.body ?? item.body;
  const attachedImages = item.kind === "user" ? attachedImagePathsFromBody(promptBody) : [];
  const displayBody = attachedImages.length > 0 ? bodyWithoutAttachedImageList(promptBody) : promptBody;
  const assistantPresentation = item.kind === "assistant" ? assistantMessagePresentation(displayBody) : null;
  const renderedBody = assistantPresentation?.body ?? displayBody;
  const preview = compactPreview(item.body);
  const icon =
    item.kind === "user" ? (
      <User size={15} aria-hidden="true" />
    ) : item.kind === "assistant" ? (
      <Bot size={15} aria-hidden="true" />
    ) : item.kind === "tool" ? (
      <Wrench size={15} aria-hidden="true" />
    ) : item.kind === "system" ? (
      <Info size={15} aria-hidden="true" />
    ) : (
      <TerminalSquare size={15} aria-hidden="true" />
    );

  if (item.kind === "marker") {
    return (
      <div className="conversation-marker">
        <span />
        <div className="conversation-marker-pill">
          <strong>{item.title ?? item.body}</strong>
          {item.body && item.body !== item.title ? <small>{item.body}</small> : null}
          {item.timestamp ? <time>{formatTime(item.timestamp)}</time> : null}
        </div>
        <span />
      </div>
    );
  }

  // Tool calls, system activity, and thinking render as flat log lines;
  // only user prompts and Claude replies keep the card treatment.
  if (item.kind === "tool" || item.kind === "system" || thinking) {
    return (
      <div className={`conversation-line ${item.kind} ${item.kind === "system" && !thinking ? "system-notice" : ""} ${thinking || privateThinking ? "thinking" : ""}`}>
        <button
          className="conversation-line-header"
          type="button"
          onClick={collapsible ? () => onToggle(item.id) : undefined}
          disabled={!collapsible}
          aria-expanded={collapsible ? expanded : undefined}
        >
          <span className="conversation-line-icon">
            {thinking ? <span className="thinking-dot header-thinking-dot" aria-hidden="true" /> : icon}
          </span>
          <strong>{item.title ?? (thinking ? "Thinking" : "Activity")}</strong>
          {item.kind === "system" && !thinking ? <span className="system-origin-badge">System</span> : null}
          <span className="conversation-preview">{preview}</span>
          {item.timestamp ? <time>{formatTime(item.timestamp)}</time> : null}
          {collapsible ? (
            <span className="collapse-chevron" aria-hidden="true">
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          ) : null}
        </button>
        {collapsible ? (
          <div className={`conversation-collapse-region ${expanded ? "expanded" : "collapsed"}`}>
            <div className="conversation-line-body">
              <FormattedBody value={displayBody} />
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // A mid-turn passage earns the reader only once it is long enough that
  // reading it in the transcript's column is the wrong shape for it; the final
  // reply — the card below — always gets the button.
  const readerTitle = "Read in Markdown editor";
  const openInReader = (): void => openDocument({
    text: renderedBody,
    title: assistantPresentation?.title ?? item.title ?? "Reply",
  });

  if (item.kind === "assistant" && midTurn) {
    return (
      <div className="conversation-passage">
        <span className="conversation-passage-icon">
          <Bot size={13} aria-hidden="true" />
        </span>
        <div className="conversation-passage-body">
          <FormattedBody value={renderedBody} />
        </div>
        {documentWordCount(displayBody) >= READER_WORD_THRESHOLD ? (
          <button className="conversation-read-button" type="button" onClick={openInReader} aria-label={readerTitle} title={readerTitle}>
            <BookOpen size={13} aria-hidden="true" />
          </button>
        ) : null}
        {item.timestamp ? <time>{formatTime(item.timestamp)}</time> : null}
      </div>
    );
  }

  return (
    <article className={`conversation-card ${item.kind}${peerPrompt ? " peer-message" : ""}`} data-conversation-item-id={item.id}>
      <div className="conversation-card-header">
        <span className="conversation-icon">{peerPrompt ? <GitBranch size={15} aria-hidden="true" /> : icon}</span>
        <strong>{peerPrompt?.senderTitle ?? item.title ?? (item.kind === "user" ? "You" : "Claude")}</strong>
        {peerPrompt ? (
          <>
            <span className="peer-origin-badge">Panda Peers</span>
            <span className="peer-relation">
              {peerPrompt.relation === "subthread"
                ? "Sub-thread report"
                : peerPrompt.relation === "parent"
                  ? "Parent section"
                  : peerPrompt.relation === "delegated"
                    ? "Delegated task"
                    : "Peer section"}
            </span>
          </>
        ) : null}
        {item.kind === "assistant" && item.model ? (
          <span className="conversation-model" title={item.model}>
            {modelDisplayName(item.model)}
          </span>
        ) : null}
        {assistantPresentation?.title ? (
          <span className="conversation-turn-title" title={assistantPresentation.title}>
            {assistantPresentation.title}
          </span>
        ) : null}
        {item.timestamp ? <time>{formatTime(item.timestamp)}</time> : null}
        {item.kind === "assistant" && renderedBody.trim().length > 0 ? (
          <button className="conversation-read-button" type="button" onClick={openInReader} aria-label={readerTitle} title={readerTitle}>
            <BookOpen size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div
        className={`conversation-body-wrap ${
          item.kind === "user" && shouldCollapsePrompt(displayBody) && !promptExpanded ? "prompt-collapsed" : ""
        }`}
      >
        <div className="conversation-body">
          <FormattedBody value={renderedBody} />
          {attachedImages.length > 0 ? <MessageImageAttachments paths={attachedImages} onPreviewImage={onPreviewImage} /> : null}
        </div>
        {item.kind === "user" && shouldCollapsePrompt(displayBody) ? (
          <div className="prompt-expander">
            <button type="button" onClick={() => setPromptExpanded((open) => !open)} aria-expanded={promptExpanded}>
              {promptExpanded ? "View less" : "View more"}
              {promptExpanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
});

/**
 * What a card with nothing in it should say. A running shell whose pipeline
 * ends in `| tail` really will show nothing until it exits — naming the stage
 * turns a card that looks stuck into one that is merely quiet.
 */
function emptyAgentCardText(agent: AgentActivity | undefined, status: string): string {
  if (status !== "running") {
    return "No transcript for this agent.";
  }
  if (agent?.outputBufferedBy) {
    return `No output yet — this command pipes its output into \`${agent.outputBufferedBy}\`, which prints nothing until the command exits.`;
  }
  return "No output yet…";
}

// A subagent the main turn delegated to (Task/Agent tool). Renders as a
// collapsible card, its child transcript nested inside — the same shape the
// Codex app uses for delegated work. Collapsed by default so the main narrative
// stays readable; expand to watch/replay the child's messages and tools.
const AgentCard = memo(function AgentCard({
  item,
  expanded,
  onToggle,
  childItems,
  expandedChildIds,
  onToggleChild,
  onPreviewImage,
  onKill,
  killDisabled,
}: {
  item: ConversationItem;
  expanded: boolean;
  onToggle: (itemId: string) => void;
  childItems: ConversationItem[];
  expandedChildIds: Set<string>;
  onToggleChild: (itemId: string) => void;
  onPreviewImage: (path: string) => void;
  onKill?: (item: ConversationItem) => void;
  killDisabled?: boolean;
}): React.ReactElement {
  const agent = item.agent;
  const status = agent?.status ?? "running";
  // Real Task/Agent subagent delegation always carries a subagent_type; a
  // plain or background Bash command never does. Only the latter gets the
  // terminal styling and the kill button below.
  const isCommand = !agent?.subagentType;
  const statusIcon =
    status === "completed" ? (
      <Check size={13} aria-hidden="true" />
    ) : status === "failed" ? (
      <X size={13} aria-hidden="true" />
    ) : (
      <span className="thinking-dot" aria-hidden="true" />
    );

  const meta: string[] = [];
  // A running card reports live progress from `task_progress` (the tool it is
  // on, tokens so far); a finished one reports the final accounting.
  if (status === "running" && agent?.lastTool) {
    meta.push(agent.lastTool);
  }
  if (typeof agent?.totalTokens === "number" && agent.totalTokens > 0) {
    meta.push(`${formatTurnTokens(agent.totalTokens)} tok`);
  }
  if (status !== "running" && typeof agent?.durationMs === "number" && agent.durationMs > 0) {
    meta.push(formatTurnDuration(agent.durationMs));
  }

  return (
    <div className={`agent-card ${status} ${isCommand ? "command" : ""}`}>
      <button
        className="agent-card-header"
        type="button"
        onClick={() => onToggle(item.id)}
        aria-expanded={expanded}
      >
        <span className="agent-card-icon">
          {isCommand ? <TerminalSquare size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
        </span>
        <strong className={`agent-card-title ${isCommand ? "command-text" : ""}`}>{item.title ?? "Agent"}</strong>
        {agent?.subagentType ? <span className="agent-card-badge">{agent.subagentType}</span> : null}
        <span className={`agent-card-status ${status}`}>
          {statusIcon}
          <span>{status === "running" ? (agent?.background ? "running in background…" : "running…") : status}</span>
        </span>
        {meta.length > 0 ? <span className="agent-card-meta">{meta.join(" · ")}</span> : null}
        {isCommand && status === "running" && onKill ? (
          <button
            className="ghost-icon-button agent-card-kill"
            type="button"
            disabled={killDisabled}
            title={killDisabled ? "Process not found — it may have already finished" : "Kill this command"}
            aria-label="Kill command"
            onClick={(event) => {
              event.stopPropagation();
              onKill(item);
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        ) : null}
        <span className="collapse-chevron" aria-hidden="true">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      <div className={`conversation-collapse-region ${expanded ? "expanded" : "collapsed"}`}>
        <div className="agent-card-body">
          <div className="agent-card-summary">
            {item.timestamp ? <span>started {formatTime(item.timestamp)}</span> : null}
            {status === "running" && item.timestamp ? <span>working for {relativeAge(item.timestamp)}</span> : null}
            {agent?.summary && childItems.length > 0 ? <span>{agent.summary}</span> : null}
          </div>
          {expanded && isCommand && item.title ? <pre className="agent-card-command-full">{item.title}</pre> : null}
          {!expanded ? null : agent?.outputTail ? (
            // A background shell streams no nested transcript; its real output
            // is the file the main process tailed for us.
            <pre className="agent-card-output">{agent.outputTail}</pre>
          ) : childItems.length === 0 ? (
            // No nested items and no output file: history rebuilt from the
            // transcript, or a task that has not written anything yet.
            <div className="agent-card-empty">
              {agent?.summary ?? emptyAgentCardText(agent, status)}
            </div>
          ) : (
            childItems.map((child) => {
              const collapsedByDefault = isCollapsedByDefaultConversationItem(child);
              return (
                <ConversationCard
                  expanded={!collapsedByDefault || expandedChildIds.has(child.id)}
                  item={child}
                  key={child.id}
                  onPreviewImage={onPreviewImage}
                  onToggle={onToggleChild}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
});

/**
 * Focus mode: a run of tool calls, system activity, and thinking folded into
 * one line. The conversation itself — your prompts, the agent's replies, the
 * final answer, and any subagent card — stays unbroken; click to unfold the work.
 */
function workGroupSummary(items: ConversationItem[]): string {
  const labels: string[] = [];
  for (const item of items) {
    const label = (item.title ?? (isThinkingItem(item) ? "Thinking" : "Activity")).trim();
    if (label && !labels.includes(label)) {
      labels.push(label);
    }
  }

  const parts = [`${items.length} step${items.length === 1 ? "" : "s"}`];
  if (labels.length > 0) {
    parts.push(labels.length > 4 ? `${labels.slice(0, 4).join(", ")}…` : labels.join(", "));
  }
  return parts.join(" · ");
}

function WorkGroup({
  id,
  items,
  expanded,
  running,
  onToggle,
  children,
}: {
  id: string;
  items: ConversationItem[];
  expanded: boolean;
  running: boolean;
  onToggle: (itemId: string) => void;
  children: ReactNode;
}): React.ReactElement {
  const lastItem = items[items.length - 1];
  const runningLabel = lastItem ? (lastItem.title ?? (isThinkingItem(lastItem) ? "Thinking" : "Working")) : "Working";

  return (
    <div className={`work-group ${running ? "running" : ""}`}>
      <button className="work-group-header" type="button" onClick={() => onToggle(id)} aria-expanded={expanded}>
        <span className="work-group-icon">
          {running ? <span className="thinking-dot" aria-hidden="true" /> : <Wrench size={13} aria-hidden="true" />}
        </span>
        <strong>Agent work</strong>
        <span className="conversation-preview">{running ? `${runningLabel}…` : workGroupSummary(items)}</span>
        <span className="work-group-action">{expanded ? "Hide details" : "See details"}</span>
        <span className="collapse-chevron" aria-hidden="true">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      <div className={`conversation-collapse-region ${expanded ? "expanded" : "collapsed"}`}>
        <div className="work-group-body">{children}</div>
      </div>
    </div>
  );
}

function MessageImageAttachments({
  paths,
  onPreviewImage,
}: {
  paths: string[];
  onPreviewImage: (path: string) => void;
}): React.ReactElement {
  return (
    <div className="message-image-grid" aria-label="Attached images">
      {paths.map((path) => {
        const name = mediaFileName(path);
        return (
          <button
            className="message-image-thumb"
            key={path}
            type="button"
            onClick={() => onPreviewImage(path)}
            onContextMenu={(event) => {
              event.preventDefault();
              void window.claudeSections?.showAttachmentContextMenu(path);
            }}
            title={path}
          >
            <img alt={name} src={localFileUrl(path)} />
            <span>{name}</span>
          </button>
        );
      })}
    </div>
  );
}

type ComposerFieldHandle = { clear: () => void; focus: () => void; setText: (next: string) => void };

type ComposerFieldProps = {
  threadId: string;
  initialValue: string;
  disabled: boolean;
  placeholder: string;
  slashCommands: ComposerSlashCommand[];
  /** This workspace's board, for `#` mentions. Empty when the board is empty. */
  cards: ComposerCard[];
  shortcutHints: ComposerShortcutHint[];
  // Live text is mirrored into this ref so App can read it (on submit/queue/btw)
  // without re-rendering on every keystroke.
  textRef: React.MutableRefObject<string>;
  onHasTextChange: (hasText: boolean) => void;
  /** Points dictation at this field, so speaking types into whatever has focus. */
  onFieldFocus: () => void;
  onEnter: (modifiers: { meta: boolean }) => void;
  onPaste: (event: React.ClipboardEvent) => void;
  onCommit: (threadId: string, text: string) => void;
};

// The composer input owns its own text state so typing never re-renders the
// (very large) App tree — that re-render, especially while a turn is streaming,
// was what made keystrokes lag. The field is keyed by thread id, so switching
// sections remounts it; unmount commits the unsent text back to App for
// persistence, and mount seeds from it.
const ComposerField = memo(
  forwardRef<ComposerFieldHandle, ComposerFieldProps>(function ComposerField(
    {
      threadId,
      initialValue,
      disabled,
      placeholder,
      slashCommands,
      cards,
      shortcutHints,
      textRef,
      onHasTextChange,
      onFieldFocus,
      onEnter,
      onPaste,
      onCommit,
    },
    ref,
  ) {
    const [value, setValue] = useState(initialValue);
    const [focused, setFocused] = useState(false);
    const [slashIndex, setSlashIndex] = useState(0);
    const [dismissedSlashValue, setDismissedSlashValue] = useState<string | null>(null);
    const valueRef = useRef(initialValue);
    const areaRef = useRef<HTMLTextAreaElement | null>(null);
    const slashMatch = value.match(/^\/([a-z-]*)$/i);
    const slashQuery = slashMatch ? (slashMatch[1] ?? "").toLowerCase() : null;
    const filteredSlashCommands = useMemo(() => {
      if (slashQuery === null) {
        return [];
      }
      if (!slashQuery) {
        return slashCommands;
      }
      return slashCommands.filter((command) =>
        [command.label.replace(/^\//, ""), ...command.keywords].some((keyword) => keyword.toLowerCase().includes(slashQuery)),
      );
    }, [slashCommands, slashQuery]);
    const showSlashPalette =
      focused && slashQuery !== null && dismissedSlashValue !== value && filteredSlashCommands.length > 0;
    const selectedSlashIndex = Math.min(slashIndex, Math.max(0, filteredSlashCommands.length - 1));

    /**
     * `#` mentions: the same palette, pointed at the workspace's board.
     *
     * Matched at the end of the text rather than at the caret because that is
     * where typing happens; a `#` edited into the middle of a finished sentence
     * is a rare enough case to leave to typing the number by hand. A slash
     * command owns the whole value, so the two can never both be up.
     */
    const cardMatch = value.match(/(?:^|\s)#([^\s#]{0,40})$/);
    const cardQuery = cardMatch ? (cardMatch[1] ?? "").toLowerCase() : null;
    const filteredCards = useMemo(() => {
      if (cardQuery === null || cards.length === 0) {
        return [];
      }
      const matching = cardQuery
        ? cards.filter((card) => String(card.number) === cardQuery || `${card.title} ${card.summary}`.toLowerCase().includes(cardQuery))
        : cards;
      // The board is up to 500 cards and the menu is a popover; the first
      // handful of a board that is already in "most recently filed first" order
      // is the useful end of it.
      return matching.slice(0, 8);
    }, [cardQuery, cards]);
    const showCardPalette = focused && !showSlashPalette && cardQuery !== null && dismissedSlashValue !== value && filteredCards.length > 0;
    const selectedCardIndex = Math.min(slashIndex, Math.max(0, filteredCards.length - 1));

    const commitValue = useCallback((next: string): void => {
      const hadText = valueRef.current.trim().length > 0;
      if (next !== valueRef.current) {
        setDismissedSlashValue(null);
      }
      setValue(next);
      valueRef.current = next;
      textRef.current = next;
      const hasText = next.trim().length > 0;
      if (hasText !== hadText) {
        onHasTextChange(hasText);
      }
    }, [textRef, onHasTextChange]);

    const focusFieldSoon = (): void => {
      window.requestAnimationFrame(() => areaRef.current?.focus());
    };

    /**
     * Replace the `#query` being typed with the card's number.
     *
     * Just `#12` goes into the prompt — not the title, not a link. It is what
     * the user typed, it is what the agent is told to resolve through
     * `backlog_list`, and it is what the transcript turns back into a link to
     * the card. A trailing space so the sentence carries on.
     */
    const applyCard = (card: ComposerCard): void => {
      const head = value.slice(0, value.length - (cardMatch?.[0].length ?? 0));
      const separator = cardMatch?.[0].startsWith("#") ? "" : " ";
      commitValue(`${head}${head ? separator : ""}#${card.number} `);
      setSlashIndex(0);
      setDismissedSlashValue(null);
      focusFieldSoon();
    };

    const applySlashCommand = (command: ComposerSlashCommand): void => {
      commitValue(command.insertText);
      setSlashIndex(0);
      setDismissedSlashValue(null);
      if (command.runImmediately) {
        window.requestAnimationFrame(() => onEnter({ meta: false }));
      } else {
        focusFieldSoon();
      }
    };

    useEffect(() => {
      textRef.current = initialValue;
      valueRef.current = initialValue;
      onHasTextChange(initialValue.trim().length > 0);
      return () => {
        onCommit(threadId, valueRef.current);
        textRef.current = "";
      };
      // Seed/commit strictly on thread change; initialValue is only the seed.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [threadId]);

    useEffect(() => {
      setSlashIndex(0);
    }, [slashQuery, cardQuery]);

    useImperativeHandle(
      ref,
      () => ({
        clear: () => {
          commitValue("");
        },
        focus: () => areaRef.current?.focus(),
        setText: (next: string) => {
          commitValue(next);
          window.requestAnimationFrame(() => {
            const area = areaRef.current;
            if (!area) return;
            area.focus();
            area.setSelectionRange(next.length, next.length);
          });
        },
      }),
      [commitValue],
    );

    return (
      <>
        {showSlashPalette ? (
          <div id="composer-slash-commands" className="slash-command-palette" role="listbox" aria-label="Composer commands">
            <div className="slash-command-list">
              {filteredSlashCommands.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  className={`slash-command-option ${index === selectedSlashIndex ? "selected" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applySlashCommand(command);
                  }}
                  role="option"
                  aria-selected={index === selectedSlashIndex}
                >
                  <span className="slash-command-main">
                    <strong>{command.label}</strong>
                    <span>{command.description}</span>
                  </span>
                  <em>{command.hint}</em>
                </button>
              ))}
            </div>
            <div className="slash-shortcut-list" aria-label="Keyboard shortcuts">
              {shortcutHints.map((shortcut) => (
                <div className="slash-shortcut-row" key={shortcut.keys}>
                  <kbd>{shortcut.keys}</kbd>
                  <span>{shortcut.description}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {showCardPalette ? (
          <div id="composer-card-mentions" className="slash-command-palette" role="listbox" aria-label="Backlog cards">
            <div className="slash-command-list">
              {filteredCards.map((card, index) => (
                <button
                  key={card.number}
                  type="button"
                  className={`slash-command-option ${index === selectedCardIndex ? "selected" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyCard(card);
                  }}
                  role="option"
                  aria-selected={index === selectedCardIndex}
                >
                  <span className="slash-command-main">
                    <strong>
                      #{card.number} {card.title}
                    </strong>
                    <span>{card.summary}</span>
                  </span>
                  <em>{card.column}</em>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <textarea
          ref={areaRef}
          value={value}
          onFocus={() => {
            setFocused(true);
            onFieldFocus();
          }}
          onBlur={() => setFocused(false)}
          onChange={(event) => commitValue(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (showSlashPalette) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashIndex((current) => (current + 1) % filteredSlashCommands.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashIndex((current) => (current - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
                return;
              }
              if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                event.preventDefault();
                const command = filteredSlashCommands[selectedSlashIndex];
                if (command) {
                  applySlashCommand(command);
                }
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedSlashValue(value);
                return;
              }
            }

            if (showCardPalette) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashIndex((current) => (current + 1) % filteredCards.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashIndex((current) => (current - 1 + filteredCards.length) % filteredCards.length);
                return;
              }
              // Tab takes the highlighted card; Enter is left alone once the
              // number is unambiguous, so "#12<enter>" sends rather than
              // re-picking a card the user has already named.
              if (event.key === "Tab") {
                event.preventDefault();
                const card = filteredCards[selectedCardIndex];
                if (card) {
                  applyCard(card);
                }
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && filteredCards.length > 0 && cardQuery !== String(filteredCards[0]?.number)) {
                event.preventDefault();
                const card = filteredCards[selectedCardIndex];
                if (card) {
                  applyCard(card);
                }
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedSlashValue(value);
                return;
              }
            }

            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onEnter({ meta: event.metaKey || event.ctrlKey });
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="Prompt"
          aria-controls={showSlashPalette ? "composer-slash-commands" : showCardPalette ? "composer-card-mentions" : undefined}
        />
      </>
    );
  }),
);

// ---------------------------------------------------------------------------
// /prompts — the session's prompt history.

type PromptHistoryRecord = {
  id: string;
  text: string;
  attachments: number;
  timestamp?: string;
  queued: boolean;
  conversationItemId?: string;
};

function promptHistoryText(body: string): string {
  const images = attachedImagePathsFromBody(body);
  return images.length > 0 ? bodyWithoutAttachedImageList(body) : body;
}

function promptHistorySignature(text: string, timestamp?: string): string {
  return `${timestamp ?? ""}\u0000${text.replace(/\s+/g, " ").trim()}`;
}

function promptTimeLabel(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function PromptHistoryRow({
  record,
  badge,
  latest,
  query,
  onReuse,
  onGoTo,
}: {
  record: PromptHistoryRecord;
  badge: string;
  latest: boolean;
  query: string;
  onReuse: (text: string) => void;
  onGoTo: (record: PromptHistoryRecord) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const { tag } = useMemo(() => classifyPrompt(record.text), [record.text]);

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  const copy = (): void => {
    void navigator.clipboard?.writeText(record.text);
    setCopied(true);
    window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
  };

  const time = promptTimeLabel(record.timestamp);
  const attachmentLabel = record.attachments > 0 ? `${record.attachments}` : null;
  const displayText = record.text.trim().length > 0
    ? record.text
    : `${record.attachments} image${record.attachments === 1 ? "" : "s"}`;
  const { text: visibleText, collapsible } = promptHistoryPreview(displayText, expanded);

  return (
    <div className={`prompt-history-item${record.queued ? " queued" : ""}${latest ? " latest" : ""}`}>
      <div className="prompt-history-item-head">
        <span
          className={`prompt-history-badge${latest ? " latest" : ""}${record.queued ? " queued" : ""}`}
        >
          {badge}
        </span>
        {tag ? (
          <span className="prompt-history-tag">
            <Bot size={10} aria-hidden="true" />
            {tag}
          </span>
        ) : null}
        {attachmentLabel ? (
          <span className="prompt-history-meta">
            <Image size={11} aria-hidden="true" />
            {attachmentLabel}
          </span>
        ) : null}
        <div className="prompt-history-actions">
          {time ? <span className="prompt-history-time">{time}</span> : null}
          {!record.queued ? (
            <button
              className="prompt-history-action"
              type="button"
              onClick={() => onGoTo(record)}
              aria-label="Go to this prompt in the conversation"
              title="Go to prompt in conversation"
            >
              <LocateFixed size={12} aria-hidden="true" />
            </button>
          ) : null}
          <button
            className="prompt-history-action"
            type="button"
            onClick={() => onReuse(record.text)}
            aria-label="Put this prompt back in the composer"
            title="Reuse in composer"
          >
            <CornerUpLeft size={12} aria-hidden="true" />
          </button>
          <button
            className={`prompt-history-action${copied ? " done" : ""}`}
            type="button"
            onClick={copy}
            aria-label="Copy prompt"
            title={copied ? "Copied" : "Copy"}
          >
            {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <div className={`prompt-history-text${tag ? " raw" : ""}`}>
        <PromptHistoryHighlight text={visibleText} query={query} />
      </div>
      {collapsible ? (
        <button
          className="prompt-history-more"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          {expanded ? "View less" : "View more"}
        </button>
      ) : null}
    </div>
  );
}

// Highlight the active filter inside the prompt text so a match is findable in
// a long body without scanning it by eye.
function PromptHistoryHighlight({ text, query }: { text: string; query: string }): ReactElement {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return <>{text}</>;
  }
  const parts: ReactNode[] = [];
  const haystack = text.toLowerCase();
  let cursor = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(<mark key={`${at}`}>{text.slice(at, at + needle.length)}</mark>);
    cursor = at + needle.length;
    at = haystack.indexOf(needle, cursor);
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function PromptHistoryDialog({
  sent,
  queued,
  onClose,
  onReuse,
  onGoTo,
}: {
  sent: PromptHistoryRecord[];
  queued: PromptHistoryRecord[];
  onClose: () => void;
  onReuse: (text: string) => void;
  onGoTo: (record: PromptHistoryRecord) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = useCallback(
    (record: PromptHistoryRecord): boolean => {
      if (!needle) return true;
      const { tag, headline } = classifyPrompt(record.text);
      return `${record.text} ${headline} ${tag ?? ""}`.toLowerCase().includes(needle);
    },
    [needle],
  );
  const visibleSent = useMemo(() => sent.filter(matches), [sent, matches]);
  const visibleQueued = useMemo(() => queued.filter(matches), [queued, matches]);
  const total = sent.length + queued.length;
  const visibleTotal = visibleSent.length + visibleQueued.length;
  const subtitle = total === 0
    ? "Nothing sent yet"
    : needle
      ? `${visibleTotal} of ${total} matching`
      : `${sent.length} sent · ${queued.length} queued`;

  return (
    <div
      className="prompt-history-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Prompts sent this session"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="prompt-history-head">
        <MessageSquare size={16} aria-hidden="true" />
        <div className="prompt-history-title">
          <strong>Prompts</strong>
          <span>{subtitle}</span>
        </div>
        <button className="ghost-icon-button" type="button" onClick={onClose} aria-label="Close" title="Close (⌘⇧P)">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {total > 0 ? (
        <div className="prompt-history-search">
          <Search size={13} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                // First Escape clears the filter, second closes the dialog —
                // so stop the window-level handler from doing both at once.
                event.stopPropagation();
                if (query) {
                  setQuery("");
                } else {
                  onClose();
                }
              }
            }}
            placeholder="Filter prompts…"
            aria-label="Filter prompts"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear filter">
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="prompt-history-body">
        {total === 0 ? (
          <div className="prompt-history-empty">
            <MessageSquare size={22} aria-hidden="true" />
            <strong>No prompts yet</strong>
            <p>Everything you send in this section lands here — newest first, plus anything still queued.</p>
          </div>
        ) : visibleTotal === 0 ? (
          <div className="prompt-history-empty">
            <Search size={22} aria-hidden="true" />
            <strong>No matches</strong>
            <p>Nothing in this session's prompts matches “{query.trim()}”.</p>
          </div>
        ) : (
          <>
            {visibleQueued.length > 0 ? (
              <div className="prompt-history-section">
                <div className="prompt-history-section-label">Queued</div>
                {visibleQueued.map((record) => (
                  <PromptHistoryRow
                    key={record.id}
                    record={record}
                    badge={`Queued #${queued.indexOf(record) + 1}`}
                    latest={false}
                    query={query}
                    onReuse={onReuse}
                    onGoTo={onGoTo}
                  />
                ))}
              </div>
            ) : null}
            {visibleSent.length > 0 ? (
              <div className="prompt-history-section">
                <div className="prompt-history-section-label">Sent</div>
                {visibleSent.map((record) => {
                  const index = sent.indexOf(record);
                  return (
                    <PromptHistoryRow
                      key={record.id}
                      record={record}
                      badge={index === 0 ? "Latest" : `#${sent.length - index}`}
                      latest={index === 0}
                      query={query}
                      onReuse={onReuse}
                      onGoTo={onGoTo}
                    />
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

type ThreadRowProps = {
  thread: Thread;
  depth: number;
  activeId: string;
  attentionThreadIds: Set<string>;
  collapsedSubthreads: Set<string>;
  subthreadsByParent: Map<string, Thread[]>;
  visibleSubthreadCounts: Record<string, number>;
  archivedThreadIds: Set<string>;
  terminalTabsByThread: Record<string, TerminalTab[]>;
  browserMarksByThread: Record<string, { tabs: number; note: boolean }>;
  unsentDraftThreadIds: Set<string>;
  registerThreadRow: (id: string, el: HTMLElement | null) => void;
  toggleSubthreads: (parentId: string) => void;
  setActiveThreadId: (id: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
  showMoreSubthreads: (parentId: string, total: number) => void;
  showLessSubthreads: (parentId: string) => void;
  stopThreadSession: (threadId: string) => void;
  toggleArchiveThread: (threadId: string) => void;
};

/** How long an armed stop badge waits for the second click before disarming. */
const STOP_ARM_TIMEOUT_MS = 4000;

// A row in the sidebar's thread tree, one per section (recursing into
// sub-threads). Split out from App's render body and memoized because a
// running section's stream ticks (one IPC message per token, from EVERY
// running section, see onSessionRuntime) touch App state dozens of times a
// second — without this boundary every tick re-executed this ~180-line
// tree-construction for all 40+ sections in the sidebar, not just the one
// that changed. Correctness depends on the props actually staying
// referentially stable across unrelated ticks: `thread` only gets a new
// identity when updateThread's dirty-check finds a real change (see its
// comment), and the Set/Map/Record props below are only replaced by their
// own setters, none of which fire on the streaming hot path.
const ThreadRow = memo(function ThreadRow({
  thread,
  depth,
  activeId,
  attentionThreadIds,
  collapsedSubthreads,
  subthreadsByParent,
  visibleSubthreadCounts,
  archivedThreadIds,
  terminalTabsByThread,
  browserMarksByThread,
  unsentDraftThreadIds,
  registerThreadRow,
  toggleSubthreads,
  setActiveThreadId,
  setContextMenu,
  showMoreSubthreads,
  showLessSubthreads,
  stopThreadSession,
  toggleArchiveThread,
}: ThreadRowProps): React.ReactElement {
  const terminalCount = terminalTabsByThread[thread.id]?.length ?? 0;
  const browserMark = browserMarksByThread[thread.id];
  const children = subthreadsByParent.get(thread.id) ?? [];
  const collapsed = collapsedSubthreads.has(thread.id);
  const archived = archivedThreadIds.has(thread.id);
  // A running sub-thread is the one thing worth surfacing on a collapsed
  // parent: it is the state where "something is happening that you cannot
  // see" would otherwise be true.
  const busyChildren = children.filter((child) => child.agentState === "working").length;
  const blockedChildren = children.filter((child) => child.agentState === "needs_action").length;
  const completedChildren = children.filter((child) => attentionThreadIds.has(child.id)).length;
  const visibleChildren = Math.min(
    visibleSubthreadCounts[thread.id] ?? INITIAL_VISIBLE_SESSIONS,
    children.length,
  );
  const canShowMoreChildren = visibleChildren < children.length;
  const canShowLessChildren = visibleChildren > INITIAL_VISIBLE_SESSIONS;

  // Stopping a section from the sidebar is a shortcut for something the row
  // otherwise can't do, so it asks twice: the first click arms the badge
  // ("Stop?"), the second one within STOP_ARM_TIMEOUT_MS actually stops. An
  // accidental click just leaves a badge that quietly disarms itself.
  const [stopArmed, setStopArmed] = useState(false);
  const stopArmTimerRef = useRef<number | undefined>(undefined);
  const stoppable = thread.agentState === "working" || thread.agentState === "needs_action";

  useEffect(() => {
    return () => {
      if (stopArmTimerRef.current !== undefined) {
        window.clearTimeout(stopArmTimerRef.current);
      }
    };
  }, []);

  // A section that stopped on its own (or was stopped elsewhere) must not keep
  // a live "Stop?" badge sitting on it.
  useEffect(() => {
    if (!stoppable && stopArmed) {
      setStopArmed(false);
    }
  }, [stoppable, stopArmed]);

  const handleStopClick = (event: React.SyntheticEvent): void => {
    // The badge lives inside the row button; without this the click also
    // selects the section.
    event.preventDefault();
    event.stopPropagation();
    if (stopArmTimerRef.current !== undefined) {
      window.clearTimeout(stopArmTimerRef.current);
      stopArmTimerRef.current = undefined;
    }
    if (stopArmed) {
      setStopArmed(false);
      stopThreadSession(thread.id);
      return;
    }
    setStopArmed(true);
    stopArmTimerRef.current = window.setTimeout(() => {
      stopArmTimerRef.current = undefined;
      setStopArmed(false);
    }, STOP_ARM_TIMEOUT_MS);
  };

  return (
    <div
      className="thread-branch"
      data-depth={depth}
      data-thread-id={thread.id}
      ref={(el) => registerThreadRow(thread.id, el)}
    >
      <div className={`thread-row ${children.length > 0 ? "has-subthreads" : ""}`} style={{ "--thread-depth": depth } as React.CSSProperties}>
        {children.length > 0 ? (
          <button
            className="subthread-toggle"
            type="button"
            onClick={() => toggleSubthreads(thread.id)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Show ${children.length} sub-threads` : `Hide ${children.length} sub-threads`}
            title={collapsed ? `Show ${children.length} sub-thread${children.length === 1 ? "" : "s"}` : "Hide sub-threads"}
          >
            {collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          </button>
        ) : depth > 0 ? (
          <span className="subthread-branch-mark" aria-hidden="true" />
        ) : (
          /* The chevron gutter is unconditional, so a childless top-level row
             still has to fill it — otherwise the row's own button slides into
             the 16px column and the title collapses to nothing. */
          <span className="subthread-gutter-spacer" aria-hidden="true" />
        )}
        <button
          className={`thread-item ${thread.id === activeId ? "active" : ""} ${
            attentionThreadIds.has(thread.id) ? "needs-attention" : ""
          } ${depth > 0 ? "subthread-item" : ""} ${archived ? "archived-thread" : ""}`}
          type="button"
          onClick={() => setActiveThreadId(thread.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            setActiveThreadId(thread.id);
            setContextMenu({ threadId: thread.id, x: event.clientX, y: event.clientY });
          }}
        >
          <AgentBadge
            compact
            state={thread.agentState}
            stopArmed={stopArmed}
            onStopClick={stoppable ? handleStopClick : undefined}
          />
          <span className="thread-copy">
            <strong>
              {thread.starred ? <Star size={11} className="thread-star" aria-hidden="true" /> : null}
              {archived ? <Archive size={11} className="thread-archive-mark" aria-hidden="true" /> : null}
              <span className="thread-title-text">{thread.title}</span>
              {/* The marks: what this section has going that the row cannot
                  otherwise say — hidden sub-threads, live terminals, open
                  pages, an unsent draft. Grouped rather than listed, because
                  on a narrow sidebar four pills eat the title; see
                  `.thread-marks` in the stylesheet, which folds them to icons
                  and reopens them on hover. */}
              <ThreadMarks
                marks={[
                  collapsed && children.length > 0
                    ? {
                        key: "subthreads",
                        className: `thread-subthread-count ${busyChildren > 0 ? "busy" : ""}`,
                        icon: <GitBranch size={11} aria-hidden="true" />,
                        count: children.length,
                        label:
                          busyChildren > 0
                            ? `${children.length} sub-thread${children.length === 1 ? "" : "s"}, ${busyChildren} running`
                            : `${children.length} sub-thread${children.length === 1 ? "" : "s"}`,
                      }
                    : null,
                  collapsed && blockedChildren > 0
                    ? {
                        key: "subthreads-blocked",
                        className: "thread-subthread-count needs-action",
                        icon: <AlertTriangle size={11} aria-hidden="true" />,
                        count: blockedChildren,
                        label: `${blockedChildren} sub-thread${blockedChildren === 1 ? "" : "s"} blocked waiting for input`,
                      }
                    : null,
                  collapsed && completedChildren > 0
                    ? {
                        key: "subthreads-complete",
                        className: "thread-subthread-count complete",
                        icon: <Check size={11} aria-hidden="true" />,
                        count: completedChildren,
                        label: `${completedChildren} sub-thread${completedChildren === 1 ? "" : "s"} completed since you last opened them`,
                      }
                    : null,
                  terminalCount > 0
                    ? {
                        key: "terminals",
                        className: "thread-terminal-count",
                        icon: <TerminalSquare size={11} aria-hidden="true" />,
                        count: terminalCount,
                        label: `${terminalCount} active terminal${terminalCount === 1 ? "" : "s"}`,
                      }
                    : null,
                  // A page open is a page the section (or the user) can still be
                  // acting in, and it is invisible from any other row. A note on
                  // one is the browser waiting on the user, so it is coloured
                  // like the other things that want them.
                  browserMark
                    ? {
                        key: "browser",
                        className: `thread-browser-count ${browserMark.note ? "has-note" : ""}`,
                        icon: <Globe size={11} aria-hidden="true" />,
                        count: browserMark.tabs,
                        label: browserMark.note
                          ? `${browserMark.tabs} page${browserMark.tabs === 1 ? "" : "s"} open — one is waiting on you`
                          : `${browserMark.tabs} page${browserMark.tabs === 1 ? "" : "s"} open`,
                      }
                    : null,
                  // A prompt typed here and never sent: invisible from anywhere
                  // but this section, and the one thing in the row the user
                  // still owes an action on.
                  unsentDraftThreadIds.has(thread.id)
                    ? {
                        key: "draft",
                        className: "draft-mark",
                        icon: <Pencil size={9} aria-hidden="true" />,
                        label: "Unsent draft",
                      }
                    : null,
                ]}
              />
            </strong>
          </span>
          {/* One grid cell, two layers: the timestamp normally, the archive
              toggle crossfaded in over it on hover — instead of a permanent
              extra column, which pushed the time away from the title and
              widened the empty middle gap on every row, hovered or not. */}
          <span className="thread-trailing">
            <time title={thread.lastPromptAt ? `Last prompt ${formatTime(thread.lastPromptAt)}` : "No prompt submitted"}>
              {relativeAge(thread.lastPromptAt)}
            </time>
            {thread.draft ? null : (
              // Not a <button>: sits inside the row's own button, same
              // reasoning as AgentBadge's stop control above — nesting would
              // be invalid HTML. The right-click menu still has Archive too.
              <span
                className="thread-archive-toggle"
                role="button"
                tabIndex={0}
                title={archived ? "Unarchive" : "Archive"}
                aria-label={archived ? "Unarchive this section" : "Archive this section"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleArchiveThread(thread.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleArchiveThread(thread.id);
                  }
                }}
              >
                {archived ? <ArchiveRestore size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
              </span>
            )}
          </span>
        </button>
      </div>
      {collapsed
        ? null
        : children.slice(0, visibleChildren).map((child) => (
            <ThreadRow
              key={child.id}
              thread={child}
              depth={depth + 1}
              activeId={activeId}
              attentionThreadIds={attentionThreadIds}
              collapsedSubthreads={collapsedSubthreads}
              subthreadsByParent={subthreadsByParent}
              visibleSubthreadCounts={visibleSubthreadCounts}
              archivedThreadIds={archivedThreadIds}
              terminalTabsByThread={terminalTabsByThread}
              browserMarksByThread={browserMarksByThread}
              unsentDraftThreadIds={unsentDraftThreadIds}
              registerThreadRow={registerThreadRow}
              toggleSubthreads={toggleSubthreads}
              setActiveThreadId={setActiveThreadId}
              setContextMenu={setContextMenu}
              showMoreSubthreads={showMoreSubthreads}
              showLessSubthreads={showLessSubthreads}
              stopThreadSession={stopThreadSession}
              toggleArchiveThread={toggleArchiveThread}
            />
          ))}
      {!collapsed && children.length > INITIAL_VISIBLE_SESSIONS ? (
        <div
          className="thread-list-more subthread-list-more"
          style={{ "--thread-depth": depth + 1 } as React.CSSProperties}
        >
          {canShowMoreChildren ? (
            <button
              className="thread-more-button"
              type="button"
              onClick={() => showMoreSubthreads(thread.id, children.length)}
            >
              <ChevronDown size={13} aria-hidden="true" />
              Show {Math.min(VISIBLE_SESSIONS_STEP, children.length - visibleChildren)} more
            </button>
          ) : null}
          {canShowLessChildren ? (
            <button className="thread-more-button" type="button" onClick={() => showLessSubthreads(thread.id)}>
              <ChevronUp size={13} aria-hidden="true" />
              Show less
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export default function App(): React.ReactElement {
  const desktopApi = window.claudeSections ?? fallbackApi;
  // The draft always leads the list: the New Session route is a fixed place, not
  // something you create. Everything downstream (composer, terminals, per-thread
  // state) is keyed by thread id and therefore works on it unchanged.
  const [threads, setThreads] = useState<Thread[]>(() => [createDraftThread(), ...loadLocalThreads()]);
  // Open on the most recent real section, or the New Session route when there
  // isn't one — a fresh install starts by composing, not staring at an empty
  // section that was created for it.
  const [activeThreadId, setActiveThreadId] = useState(
    () => threads.find((thread) => !thread.draft)?.id ?? DRAFT_THREAD_ID,
  );
  const [conversationItems, setConversationItems] = useState<Record<string, ConversationItem[]>>({});
  const [conversationPages, setConversationPages] = useState<
    Record<string, { beforeCursor?: ConversationPageCursor; hasEarlier: boolean; loading?: boolean }>
  >({});
  const [conversationLoadState, setConversationLoadState] = useState<
    Record<string, "loading" | "loaded" | "error">
  >({});
  const [tokenUsageByThread, setTokenUsageByThread] = useState<Record<string, TokenUsageStats>>({});
  const [runtimeActivityByThread, setRuntimeActivityByThread] = useState<Record<string, RuntimeActivity>>({});
  const [runtimeStatusByThread, setRuntimeStatusByThread] = useState<Record<string, RuntimeStatus>>({});
  const [promptDraftsByThread, setPromptDraftsByThread] = useState<Record<string, string>>({});
  const [imageAttachmentsByThread, setImageAttachmentsByThread] = useState<Record<string, ImageAttachment[]>>({});
  const [draggingImage, setDraggingImage] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [btwWidth, setBtwWidth] = useState(storedBtwWidth);
  const [resizingBtw, setResizingBtw] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    "general" | "defaults" | "performance" | "usage" | "notifications" | "phone"
  >("general");
  const [showTokenInfo, setShowTokenInfo] = useState(false);
  // Cost for the section whose info card is open. Fetched from the persisted
  // ledger rather than derived from the live token snapshot, so it survives a
  // resumed process and a Claude ↔ Codex handoff.
  const [sessionCostReport, setSessionCostReport] = useState<UsageCostReport | null>(null);
  // The kanban board, opened from a workspace's right-click menu. Only the cwd
  // is held here — the board owns its own loading, its own live updates, and its
  // own writes, since agents change the same file from outside this window.
  const [backlogWorkspace, setBacklogWorkspace] = useState<string | null>(null);
  // Card the board should scroll to and highlight, when the board was opened
  // from that card's own view.
  const [backlogFocusId, setBacklogFocusId] = useState<string | null>(null);
  const [backlogEpicFocusId, setBacklogEpicFocusId] = useState<string | null>(null);
  /**
   * One backlog card, open on its own over whatever is on screen.
   *
   * This is where a `panda://backlog/<id>` link lands, and where a section's
   * task list opens a task. It is deliberately not the board: a link that says
   * "this card" used to open a kanban board with the card's editor stacked on
   * top of it, which is two rooms too many for one destination.
   */
  const [taskView, setTaskView] = useState<{ cwd: string; itemId: string } | null>(null);
  // Same shape as the backlog above, for the workspace's scheduled tasks panel.
  const [scheduleWorkspace, setScheduleWorkspace] = useState<string | null>(null);
  // "What is this Mac doing?" — one drawer for the whole box, not per workspace:
  // every section shares the same CPU and the same 8 GB.
  const [machineOpen, setMachineOpen] = useState(false);
  const machine = useMachineStats(desktopApi, machineOpen);
  const [gitWorkspace, setGitWorkspace] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitFetching, setGitFetching] = useState(false);
  const [gitTab, setGitTab] = useState<"status" | "history" | "actions" | "files">("status");
  // Changed-files drawer: which section it is reporting on, and that section's
  // file list. Held by thread id rather than by cwd because the whole point is
  // per-section attribution inside a shared working tree.
  const [filesThreadId, setFilesThreadId] = useState<string | null>(null);
  const [fileChanges, setFileChanges] = useState<SessionFileChanges | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [editors, setEditors] = useState<EditorTarget[]>([]);
  const [editorPickerOpen, setEditorPickerOpen] = useState(false);
  const [showSelector, setShowSelector] = useState(false);
  const [settingsModelRuntime, setSettingsModelRuntime] = useState<AgentRuntime>("claude");
  const [usageProvider, setUsageProvider] = useState<UsageProvider>(storedUsageProvider);
  // Kept per provider so toggling Claude/Codex shows the other side's last numbers
  // instead of blanking to "unavailable" while its fetch is in flight.
  const [usageByProvider, setUsageByProvider] = useState<Partial<Record<UsageProvider, UsageSnapshot | null>>>({});
  const [usageLoadingProvider, setUsageLoadingProvider] = useState<UsageProvider | null>(null);
  const refreshUsageRef = useRef<(force?: boolean) => void>(() => {});
  const usageRefreshTimerRef = useRef<number | undefined>(undefined);
  const [contextMobileNotifications, setContextMobileNotifications] = useState<SessionMobileNotificationStatus | null>(null);
  const [focusMode, setFocusMode] = useState(storedFocusMode);
  const [attentionThreadIds, setAttentionThreadIds] = useState<Set<string>>(() => new Set());
  // Attention threads whose row is nowhere on screen right now — its workspace
  // group is collapsed, it is folded under a collapsed parent, it is paged
  // behind "show more", or it is simply scrolled past the fold. Those are the
  // ones an OS notification is the only signal for, so the sidebar gets its
  // own callout for them too. Tracked by IntersectionObserver against the
  // scrollable section list; see the effect near the sidebar footer below.
  const [offscreenAttentionIds, setOffscreenAttentionIds] = useState<Set<string>>(() => new Set());
  const threadRowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const workspaceListRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollThreadIdRef = useRef<string | null>(null);
  const registerThreadRow = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      threadRowRefs.current.set(id, el);
    } else {
      threadRowRefs.current.delete(id);
    }
  }, []);
  const [visibleSessionCounts, setVisibleSessionCounts] = useState<Record<string, number>>({});
  // Same paging as a workspace group, one page per parent row: a section that
  // spawned twenty sub-threads shows five and a "show 5 more" under them,
  // keyed by the parent's id.
  const [visibleSubthreadCounts, setVisibleSubthreadCounts] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [defaultCommand, setDefaultCommand] = useState(storedDefaultCommand);
  const [defaultRuntime, setDefaultRuntime] = useState<AgentRuntime>(storedDefaultRuntime);
  const [defaultModel, setDefaultModel] = useState(storedDefaultModel);
  const [defaultEffort, setDefaultEffort] = useState(storedDefaultEffort);
  const [defaultPermissionMode, setDefaultPermissionMode] = useState(storedDefaultPermissionMode);
  const [defaultCodexModel, setDefaultCodexModel] = useState(storedDefaultCodexModel);
  const [defaultCodexEffort, setDefaultCodexEffort] = useState(storedDefaultCodexEffort);
  const [defaultCodexSandbox, setDefaultCodexSandbox] = useState(storedDefaultCodexSandbox);
  const [defaultGroqModel, setDefaultGroqModel] = useState(storedDefaultGroqModel);
  const [groqKeyConfigured, setGroqKeyConfigured] = useState(false);
  const [groqKeyDraft, setGroqKeyDraft] = useState("");
  const [groqModels, setGroqModels] = useState<GroqModel[]>([]);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState(loadExpandedWorkspaces);
  const [starredCollapsed, setStarredCollapsed] = useState(loadStarredCollapsed);
  // Non-destructive view filter, mirrored to the relay: hides a section from
  // its workspace group's default view. Never stops or deletes anything — see
  // ARCHIVED_THREADS_KEY.
  const [archivedThreadIds, setArchivedThreadIds] = useState(loadArchivedThreads);
  // One-time push of whatever this Mac already had archived before the relay
  // knew about archiving (or before it connected this run), so a phone that
  // pairs later sees the same set without the user re-archiving anything.
  useEffect(() => {
    const ids = Array.from(archivedThreadIds);
    if (ids.length > 0) void desktopApi.syncLocalArchivedThreads(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onOpenEpic = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      setBacklogWorkspace(activeCwdRef.current);
      setBacklogEpicFocusId(id);
    };
    window.addEventListener(OPEN_EPIC_EVENT, onOpenEpic);
    return () => window.removeEventListener(OPEN_EPIC_EVENT, onOpenEpic);
  }, []);
  // Per-workspace "show archived" reveal, keyed by cwd like visibleSessionCounts.
  const [showArchivedByCwd, setShowArchivedByCwd] = useState<Record<string, boolean>>({});
  const [workspaceOrder, setWorkspaceOrder] = useState(loadWorkspaceOrder);
  const [draggingWorkspace, setDraggingWorkspace] = useState<string | null>(null);
  // Where the dragged workspace would land if released now. Drives the live
  // reorder preview in the sidebar (the groups slide out of the way) instead of
  // only highlighting a drop target.
  const [workspaceDropIndex, setWorkspaceDropIndex] = useState<number | null>(null);
  const workspaceNodesRef = useRef(new Map<string, HTMLElement>());
  // Group midpoints captured once at drag start. Measuring live would feed the
  // preview's own movement back into the hit test and make the list oscillate.
  const workspaceDragMidsRef = useRef<{ mids: number[] } | null>(null);
  const workspaceOffsetsRef = useRef(new Map<string, number>());
  const workspaceFlipRef = useRef(false);
  // Shared working directory behind every project-less section. Empty until the
  // main process answers (or a cached value is present from a previous run).
  const [scratchCwd, setScratchCwd] = useState(storedScratchWorkspace);
  const [newSectionChooserOpen, setNewSectionChooserOpen] = useState(false);
  const [expandedConversationItems, setExpandedConversationItems] = useState<Set<string>>(() => new Set());
  const [isSendingPrompt, setIsSendingPrompt] = useState(false);
  const [previewImage, setPreviewImage] = useState<ImagePreview | null>(null);
  /**
   * What the in-app reader is showing — as a browser-style stack, not a single
   * document: following a link out of one document, or opening a reply while
   * the reader is up, should leave a way back rather than losing where you were.
   * `readerIndex` is the position in it; opening drops whatever was ahead.
   */
  const [reader, setReader] = useState<{ stack: DocumentRequest[]; index: number }>({ stack: [], index: 0 });
  const readerDoc = reader.stack[reader.index] ?? null;
  const readerOpen = reader.stack.length > 0;
  const canReaderGoBack = reader.index > 0;
  const canReaderGoForward = reader.index < reader.stack.length - 1;

  const pushReaderDoc = useCallback((request: DocumentRequest): void => {
    setReader(({ stack, index }) => {
      // Same rule as a browser's: opening from partway back forgets the forward
      // entries, so the stack is always the path actually taken to get here.
      const kept = stack.length === 0 ? [] : stack.slice(0, index + 1);
      return { stack: [...kept, request], index: kept.length };
    });
  }, []);

  const stepReader = useCallback((delta: number): void => {
    setReader(({ stack, index }) => ({ stack, index: Math.min(stack.length - 1, Math.max(0, index + delta)) }));
  }, []);

  const closeReader = useCallback((): void => setReader({ stack: [], index: 0 }), []);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuState>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<string | null>(null);
  const [terminalTabsByThread, setTerminalTabsByThread] = useState<Record<string, TerminalTab[]>>(loadStoredTerminalTabs);
  const [activeTerminalTabByThread, setActiveTerminalTabByThread] = useState<Record<string, string>>({});
  const [openTerminalThreadIds, setOpenTerminalThreadIds] = useState<Set<string>>(() => new Set());
  /**
   * The browser panel is one per window, not one per section — unlike terminals.
   * The tabs belong to the workspace and any section can be driving them, so a
   * page an agent left open has to still be there when the user switches
   * sections to go look at it.
   */
  /**
   * Browser dock state.
   *
   * All of it is view state — which sections have the panel open, how each is
   * presented, how wide the column is. No tab state lives here: main owns that,
   * and `BrowserPanel` reads it from the `browser:state` broadcast. See
   * `shared/browser.ts` for the model and `BrowserPanel.tsx` for the three
   * presentations.
   *
   * Which sections have the browser panel open. Per section, like terminals: a
   * section's tabs are its own, so whether its browser is showing is too.
   */
  const [openBrowserThreadIds, setOpenBrowserThreadIds] = useState<Set<string>>(() => new Set());
  /** Docked column or full width, per section. The detached window is main's. */
  const [browserPresentationByThread, setBrowserPresentationByThread] = useState<Record<string, BrowserPresentation>>({});
  const [browserWidth, setBrowserWidth] = useState(storedBrowserWidth);
  const [resizingBrowser, setResizingBrowser] = useState(false);
  /**
   * How many pages each section has open, for the sidebar's mark — the one thing
   * about the browser this component needs from main.
   *
   * Deliberately a count and a flag rather than the state itself: `browser:state`
   * fires on every title change and every loading toggle of every tab, and
   * holding the tabs here would re-render the whole app on each. Collapsing to a
   * digest and returning the previous object when nothing a row shows has moved
   * makes React bail out of the render instead.
   */
  const [browserMarksByThread, setBrowserMarksByThread] = useState<Record<string, { tabs: number; note: boolean }>>({});
  const [preferences, setPreferences] = useState<AppPreferences>({
    quickStartShortcut: "",
    hideDockIcon: false,
    notificationsPaused: false,
    remoteKeepAwake: "off",
    conserveMode: false,
    preferredEditor: "cursor",
    relayUrl: "",
    dictationLocale: DICTATION_FALLBACK_LOCALE,
    maxLiveSessions: 6,
    idleSessionTimeoutMinutes: 30,
    transcriptWindowSize: 2000,
    retainedTranscripts: 12,
  });
  const notificationChannels = normalizeNotificationChannels(preferences.notificationChannels ?? {
    desktop: storedNotificationsEnabled(), agent: storedAgentNotificationsEnabled(), sessions: storedSessionNotificationOverrides(),
  });
  const notificationsEnabled = notificationChannels.desktop;
  const agentNotificationsEnabled = notificationChannels.agent;
  const sessionNotificationOverrides = notificationChannels.sessions;
  const anyDesktopNotificationsEnabled = notificationsEnabled || Object.values(sessionNotificationOverrides).some((entry) => entry.desktop === true);
  const setNotificationsEnabled = (desktop: boolean): void => { void desktopApi.setNotificationChannels(null, { desktop }).then(setPreferences); };
  const setAgentNotificationsEnabled = (agent: boolean): void => { void desktopApi.setNotificationChannels(null, { agent }).then(setPreferences); };
  const [relayUrlDraft, setRelayUrlDraft] = useState("");
  /**
   * The model a NEW Claude section launches on. Conserve mode forces Sonnet:
   * the usage ledger showed Opus at 88-90% of all tokens, which is the single
   * biggest lever the mode has, and output is only ~0.1% of consumption so
   * delegation guidance alone barely moved it.
   *
   * Only the *default* — an explicit per-section pick (`launchSettings.model`)
   * still wins, and the Settings model picker keeps showing your own stored
   * default rather than this, so turning Conserve off restores it untouched.
   */
  const launchDefaultModel = preferences.conserveMode ? "sonnet" : defaultModel;
  // Starts disabled, not "loading": a build with no relay configured would
  // otherwise flash "Connecting to the relay…" forever, since the main process
  // never sends a `remote:pairing` update for a bridge that never starts.
  const [remotePairing, setRemotePairing] = useState<RemotePairingInfo>({
    status: "disabled",
    message: "Checking relay configuration…",
  });
  const [remoteDevices, setRemoteDevices] = useState<RemotePairedDevice[]>([]);
  const mobileNotificationsEnabled = remoteDevices.length > 0 && remoteDevices.every((device) => device.notificationsEnabled);
  const [quickStartOpen, setQuickStartOpen] = useState(false);
  const [attentionQueue, setAttentionQueue] = useState<AgentAttentionEvent[]>([]);
  const [minimizedAttentionIds, setMinimizedAttentionIds] = useState<Set<string>>(new Set());
  const activeAttention = attentionQueue.find((event) => !minimizedAttentionIds.has(event.id));
  const [quickStartDraft, setQuickStartDraft] = useState("");
  // What the overlay's box holds *right now*, ahead of the next render.
  //
  // Dictation re-reads its target between results to spot manual edits, and the
  // analyzer delivers several results per tick. A `useState` value still reads
  // pre-write inside that tick, so every burst looked like the user had retyped
  // the box: the transcript rebased onto stale text and restarted the recogniser,
  // four times in eleven milliseconds. The section composer never had this because
  // it reads `composerTextRef`; this is the same synchronous truth for the
  // overlay. Write through `applyQuickStartDraft` so the two cannot drift.
  const quickStartDraftRef = useRef("");
  const applyQuickStartDraft = useCallback((value: string): void => {
    quickStartDraftRef.current = value;
    setQuickStartDraft(value);
  }, []);
  const [quickStartCwd, setQuickStartCwd] = useState(DEFAULT_WORKSPACE);
  const [quickStartAttachments, setQuickStartAttachments] = useState<ImageAttachment[]>([]);
  const [quickStartRuntime, setQuickStartRuntime] = useState<AgentRuntime>(defaultRuntime);
  const [quickStartModel, setQuickStartModel] = useState(defaultRuntime === "codex" ? defaultCodexModel : defaultRuntime === "groq" ? defaultGroqModel : launchDefaultModel);
  const [quickStartEffort, setQuickStartEffort] = useState(defaultRuntime === "codex" ? defaultCodexEffort : defaultEffort);
  const [quickStartPermissionMode, setQuickStartPermissionMode] = useState(
    defaultRuntime === "codex" ? defaultCodexSandbox : defaultPermissionMode,
  );
  const [quickStartSelectorOpen, setQuickStartSelectorOpen] = useState(false);
  const [queuedByThread, setQueuedByThread] = useState<Record<string, QueuedPrompt[]>>({});
  const [btwByThread, setBtwByThread] = useState<Record<string, BtwState>>({});
  const [btwDraftByThread, setBtwDraftByThread] = useState<Record<string, string>>({});
  const [artifactsByThread, setArtifactsByThread] = useState<Record<string, ArtifactRun[]>>({});
  const [shortcutCapturing, setShortcutCapturing] = useState(false);
  const [promptHistoryOpen, setPromptHistoryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [, setClockTick] = useState(0);

  const conversationFeedRef = useRef<HTMLDivElement | null>(null);
  const pendingPromptScrollItemIdRef = useRef<string | null>(null);
  const threadsRef = useRef(threads);
  const conversationItemsRef = useRef(conversationItems);
  // Read by the session-started listener: a runtime status can land BEFORE the
  // thread it belongs to exists (remote starts materialize the thread on the
  // `session:started` event, which the first `session:runtime` tick can beat), so
  // materialization needs the latest reported state rather than a guess.
  const runtimeStatusByThreadRef = useRef(runtimeStatusByThread);
  runtimeStatusByThreadRef.current = runtimeStatusByThread;
  const imageAttachmentsRef = useRef(imageAttachmentsByThread);
  const sendingPromptRef = useRef(false);
  const pendingPromptRef = useRef<PendingPromptSend | null>(null);
  const shouldFollowConversationRef = useRef(true);
  const lastConversationThreadIdRef = useRef(activeThreadId);
  // Read from the mount-once IPC listeners, which would otherwise close over the
  // active id as it was at mount.
  const activeThreadIdRef = useRef(activeThreadId);
  // When each section's transcript was last on screen. A ref, not state: it
  // feeds an eviction decision and must never itself trigger a render.
  const transcriptViewedAtRef = useRef<Record<string, number>>({});
  const btwFeedRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowBtwRef = useRef(true);
  const lastBtwThreadIdRef = useRef(activeThreadId);
  const lastPromptAtRef = useRef(new Map<string, string>());
  const idleTimersRef = useRef(new Map<string, number>());
  const pendingLaunchRestartRef = useRef(new Set<string>());
  const hasLoadedStoredThreadsRef = useRef(false);
  const initialThreadsRef = useRef(threads);
  /** Debounced section-store write awaiting its timer, or null if already written. */
  const pendingThreadsWriteRef = useRef<(() => void) | null>(null);
  const lastComposerFocusThreadIdRef = useRef(activeThreadId);
  const prevAgentStateRef = useRef(new Map<string, AgentState>());
  const hasSeededAgentStatesRef = useRef(false);
  const finishTimersRef = useRef(new Map<string, number>());
  const settleHandlerRef = useRef<(threadId: string) => void>(() => undefined);
  const streamRuntimeThreadIdsRef = useRef(new Set<string>());
  // Sections whose transcript was dropped when the reaper parked them, and has
  // not been read back yet. Hibernation keeps a section's status at "running" on
  // purpose (it did not crash, and the next prompt resumes it), so this is the
  // only way the reload-on-activate effect can tell "live stream, transcript
  // already in memory" from "process gone, transcript dropped, read it back from
  // disk".
  //
  // Cleared by that reload, NOT by the section streaming again: a resume can be
  // triggered by something other than you opening the section — your prompt to a
  // parked section, or a sub-thread reporting back — and clearing on the first
  // runtime tick left the flag off while the transcript was still missing. The
  // section then read as plain "running", the reload was skipped, and opening it
  // showed only the items streamed since the resume with its whole history gone
  // from the window (it was never gone from disk).
  const droppedTranscriptThreadIdsRef = useRef(new Set<string>());
  const dragDepthRef = useRef(0);
  // Latest default cwd for a new section, read by the global quick-start handler
  // (which can't depend on activeThread without re-subscribing the shortcut).
  const activeCwdRef = useRef(DEFAULT_WORKSPACE);
  const defaultLaunchSettingsRef = useRef<LaunchSettings>({
    runtime: defaultRuntime,
    model: defaultRuntime === "codex" ? defaultCodexModel : defaultRuntime === "groq" ? defaultGroqModel : launchDefaultModel,
    effort: defaultRuntime === "codex" ? defaultCodexEffort : defaultEffort,
    permissionMode: defaultRuntime === "codex" ? defaultCodexSandbox : defaultPermissionMode,
  });
  const pendingQuickSubmitRef = useRef<string | null>(null);
  /**
   * Backlog cards the New Session route was seeded from, waiting for the
   * section that will answer them. A card can only be linked to a section that
   * exists, and the draft has no id until its first prompt promotes it.
   */
  const pendingTaskLinksRef = useRef<{ cwd: string; ids: string[] } | null>(null);
  // Reassigned every render with the latest closures so the stable (memo-safe)
  // callbacks handed to ComposerField always run current logic.
  const composerEnterRef = useRef<(modifiers: { meta: boolean }) => void>(() => undefined);
  const composerPasteRef = useRef<(event: React.ClipboardEvent) => void>(() => undefined);
  const submitPromptRef = useRef<() => void>(() => undefined);
  const addThreadRef = useRef<() => void>(() => undefined);
  const sendPromptRef = useRef<(thread: Thread, prompt: string, paths: string[]) => Promise<boolean>>(() =>
    Promise.resolve(false),
  );

  useEffect(() => {
    let cancelled = false;
    void desktopApi.getRemotePairing().then((info) => {
      if (!cancelled && info) setRemotePairing(info);
    });
    const unsubscribe = desktopApi.onRemotePairingChanged((info) => {
      if (!cancelled) setRemotePairing(info);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [desktopApi]);

  useEffect(() => {
    let cancelled = false;
    const refreshModels = (): void => {
      void desktopApi.listCodexModels().then((models) => {
        if (!cancelled && models.length > 0) setCodexModels(models);
      }).catch(() => { /* Keep the last catalog when the CLI is unavailable. */ });
    };
    refreshModels();
    window.addEventListener("focus", refreshModels);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshModels);
    };
  }, [desktopApi]);

  useEffect(() => {
    void desktopApi.getGroqApiKeyConfigured().then(setGroqKeyConfigured);
  }, [desktopApi]);

  useEffect(() => {
    if (!groqKeyConfigured) {
      setGroqModels([]);
      return;
    }
    void desktopApi.listGroqModels().then(setGroqModels);
  }, [desktopApi, groqKeyConfigured]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? threads[0],
    [activeThreadId, threads],
  );
  // On the New Session route the shell renders a draft rather than a section:
  // no transcript, no runtime, and a composer whose send creates the section.
  const onDraftRoute = isDraftThread(activeThread);
  const draftHasContent = Boolean(
    (promptDraftsByThread[DRAFT_THREAD_ID] ?? "").trim() ||
      (imageAttachmentsByThread[DRAFT_THREAD_ID] ?? []).length > 0,
  );

  // Poll the active section's working tree for evidence/screenshot captures
  // generated since it was created. Cheap dir scan; refreshed on switch + on a
  // slow interval so the button shows up shortly after a `pnpm evidence` run.
  const activeArtifacts = artifactsByThread[activeThread?.id ?? ""] ?? EMPTY_ARTIFACTS;
  const activeArtifactThreadId = activeThread?.id;
  const activeArtifactCwd = activeThread?.cwd;
  const activeArtifactSince = activeThread?.createdAt;
  useEffect(() => {
    if (!activeArtifactThreadId || !activeArtifactCwd || !activeArtifactSince) return;
    let cancelled = false;
    const refresh = () => {
      void desktopApi
        .listArtifacts({ cwd: activeArtifactCwd, sinceIso: activeArtifactSince })
        .then((runs) => {
          if (!cancelled) {
            setArtifactsByThread((current) => ({ ...current, [activeArtifactThreadId]: runs }));
          }
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeArtifactCwd, activeArtifactSince, activeArtifactThreadId, desktopApi]);

  const openArtifacts = useCallback(() => {
    const runs = artifactsByThread[activeThread?.id ?? ""];
    const newest = runs?.[0];
    if (!newest) return;
    // Reveal the newest capture's folder in Finder (v1: just open the folder).
    void desktopApi.revealPath(newest.dir);
  }, [artifactsByThread, activeThread, desktopApi]);

  const activeDraftKey = activeThread?.id ?? "";
  const promptDraft = promptDraftsByThread[activeDraftKey] ?? "";
  const imageAttachments = imageAttachmentsByThread[activeDraftKey] ?? EMPTY_ATTACHMENTS;
  const setImageAttachments = useCallback(
    (updater: ImageAttachment[] | ((previous: ImageAttachment[]) => ImageAttachment[])) => {
      setImageAttachmentsByThread((current) => {
        const previous = current[activeDraftKey] ?? [];
        const next = typeof updater === "function" ? updater(previous) : updater;
        return { ...current, [activeDraftKey]: next };
      });
    },
    [activeDraftKey],
  );
  // Live composer text lives in ComposerField (local state); App only tracks
  // whether there's text (for button states) and reads the current value via a
  // ref on submit/queue. This keeps keystrokes off App's render path.
  const composerTextRef = useRef("");
  const composerFieldRef = useRef<ComposerFieldHandle | null>(null);
  const [composerHasText, setComposerHasText] = useState(false);
  const commitComposerDraft = useCallback((threadId: string, text: string) => {
    setPromptDraftsByThread((current) => {
      if ((current[threadId] ?? "") === text) {
        return current;
      }
      return { ...current, [threadId]: text };
    });
  }, []);
  const clearComposer = useCallback((threadId?: string) => {
    composerFieldRef.current?.clear();
    composerTextRef.current = "";
    setComposerHasText(false);
    if (threadId) {
      commitComposerDraft(threadId, "");
    }
  }, [commitComposerDraft]);
  const focusComposerSoon = useCallback(() => {
    window.requestAnimationFrame(() => composerFieldRef.current?.focus());
  }, []);

  /**
   * Sections holding a prompt that was written but never sent.
   *
   * The committed drafts only cover the *inactive* sections — the live field
   * commits on unmount, so the section you are typing in right now is missing
   * from that map and has to come from `composerHasText`. Attachments count too:
   * a pasted screenshot with no text is still an unsent prompt.
   *
   * The New Session route is excluded — it has its own dot, and it is not a
   * section the reaper can hibernate.
   */
  const unsentDraftThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, text] of Object.entries(promptDraftsByThread)) {
      if (id !== DRAFT_THREAD_ID && text.trim()) ids.add(id);
    }
    for (const [id, attachments] of Object.entries(imageAttachmentsByThread)) {
      if (id !== DRAFT_THREAD_ID && attachments.length > 0) ids.add(id);
    }
    const activeId = activeThread?.id;
    if (activeId && activeId !== DRAFT_THREAD_ID) {
      if (composerHasText) ids.add(activeId);
      else if (!(imageAttachmentsByThread[activeId] ?? []).length) ids.delete(activeId);
    }
    return ids;
  }, [promptDraftsByThread, imageAttachmentsByThread, activeThread?.id, composerHasText]);

  // Hand the set to main so the hibernation reaper can spare those processes.
  // Keyed on the sorted join so a re-render that doesn't change the set is free.
  const unsentDraftKey = useMemo(() => [...unsentDraftThreadIds].sort().join("\u0000"), [unsentDraftThreadIds]);
  useEffect(() => {
    void desktopApi.setUnsentDraftSessions(unsentDraftKey ? unsentDraftKey.split("\u0000") : []);
  }, [desktopApi, unsentDraftKey]);
  // One microphone for the window; which input receives the words is decided by
  // focus. Each composer registers itself below through `useDictationTarget`.
  const dictation = useDictation(desktopApi);
  // The section composer. Dictation types into it the same way the user does —
  // through the field's own handle — so a spoken sentence and a typed
  // correction can be mixed freely, and it reads the live value rather than
  // App's render-time copy because the transcript has to notice edits the
  // moment they happen.
  const mainDictation = useDictationTarget(
    dictation,
    activeThread?.id ?? "composer",
    useCallback(() => composerTextRef.current, []),
    useCallback((text: string) => composerFieldRef.current?.setText(text), []),
    focusComposerSoon,
    true,
  );
  // The global-shortcut overlay. Same microphone, same shortcuts — the only
  // difference is which box the words land in.
  const quickStartInputRef = useRef<HTMLTextAreaElement | null>(null);
  const quickStartDictation = useDictationTarget(
    dictation,
    "quick-start",
    () => quickStartDraftRef.current,
    applyQuickStartDraft,
    () => quickStartInputRef.current?.focus(),
  );
  const contextThread = useMemo(
    () => threads.find((thread) => thread.id === contextMenu?.threadId),
    [contextMenu?.threadId, threads],
  );
  const pendingDeleteThread = useMemo(
    () => threads.find((thread) => thread.id === pendingDeleteThreadId),
    [pendingDeleteThreadId, threads],
  );
  const filesThread = useMemo(
    () => threads.find((thread) => thread.id === filesThreadId),
    [filesThreadId, threads],
  );
  const activeConversation = useMemo(
    () =>
      activeThread
        ? mergeMarkersByTime(
            conversationItems[activeThread.id] ?? [],
            modelChangeMarkers(activeThread, codexModels),
          )
        : [],
    [activeThread, codexModels, conversationItems],
  );
  const activeStoredConversation = activeThread
    ? (conversationItems[activeThread.id] ?? EMPTY_CONVERSATION)
    : EMPTY_CONVERSATION;
  const activeConversationRuntime = activeThread?.runtime ?? "claude";
  const activeConversationCanLoad = Boolean(
    activeThread &&
      !onDraftRoute &&
      shouldReloadTranscript({
        status: activeThread.status,
        transcriptDropped: droppedTranscriptThreadIdsRef.current.has(activeThread.id),
      }) &&
      ((activeConversationRuntime === "claude" && activeThread.claudeSessionId) ||
        (activeConversationRuntime === "codex" && activeThread.codexThreadId)),
  );
  // Do not flash the misleading empty state while an idle section's history is
  // on its way from disk. Cached messages remain visible during later refreshes.
  const conversationHydrating = Boolean(
    activeThread &&
      activeStoredConversation.length === 0 &&
      activeConversationCanLoad &&
      conversationLoadState[activeThread.id] !== "loaded" &&
      conversationLoadState[activeThread.id] !== "error",
  );
  // Items revealed beyond the configured window by "Show earlier", per section.
  // Kept per section rather than reset on switch: having expanded a long history
  // once, coming back to it and finding it re-collapsed reads as data loss.
  const [revealedTranscriptItems, setRevealedTranscriptItems] = useState<Record<string, number>>({});

  /**
   * How much of the active section's transcript is mounted.
   *
   * Windowing only the *render*: every item stays in `conversationItems`, so
   * search, export, /btw seeding and the turn-state derivations above keep
   * seeing the whole conversation. The only thing bounded is how much of it
   * becomes a React tree — which is the part that gets rebuilt on every turn
   * boundary and is what makes a long section slow to type into.
   */
  const transcriptWindowSize = effectiveHygiene(preferences).transcriptWindowSize;
  const hiddenTranscriptCount = useMemo(() => {
    if (!activeThread) return 0;
    const revealed = revealedTranscriptItems[activeThread.id] ?? 0;
    return computeHiddenTranscriptCount(activeConversation.length, transcriptWindowSize, revealed);
  }, [activeConversation.length, activeThread, revealedTranscriptItems, transcriptWindowSize]);
  const windowedConversation = useMemo(
    () => (hiddenTranscriptCount > 0 ? activeConversation.slice(hiddenTranscriptCount) : activeConversation),
    [activeConversation, hiddenTranscriptCount],
  );
  const showEarlierTranscript = (): void => {
    if (!activeThread) return;
    const page = conversationPages[activeThread.id];
    if (hiddenTranscriptCount === 0 && page?.hasEarlier && page.beforeCursor && !page.loading) {
      const { id, cwd, claudeSessionId, codexThreadId } = activeThread;
      setConversationPages((current) => ({ ...current, [id]: { ...current[id], hasEarlier: true, loading: true } }));
      void desktopApi
        .loadConversation({ cwd, claudeSessionId, codexThreadId, beforeCursor: page.beforeCursor })
        .then(({ items, tokenUsage, beforeCursor, hasEarlier }) => {
          setConversationItems((current) => ({ ...current, [id]: mergeConversationItems(current[id] ?? [], items) }));
          setTokenUsageByThread((current) => ({ ...current, [id]: tokenUsage }));
          setConversationPages((current) => ({
            ...current,
            [id]: { beforeCursor, hasEarlier: hasEarlier === true, loading: false },
          }));
        })
        .catch(() => {
          setConversationPages((current) => ({
            ...current,
            [id]: { ...current[id], hasEarlier: current[id]?.hasEarlier ?? true, loading: false },
          }));
        });
      return;
    }
    const step = transcriptWindowSize > 0 ? transcriptWindowSize : hiddenTranscriptCount;
    setRevealedTranscriptItems((current) => ({
      ...current,
      [activeThread.id]: (current[activeThread.id] ?? 0) + step,
    }));
  };

  const activeBtw = activeThread ? (btwByThread[activeThread.id] ?? EMPTY_BTW) : EMPTY_BTW;
  // The board of the workspace on screen, for the two places a card is named by
  // number rather than opened from the board: `#` in the composer, and `#12` in
  // a rendered message. Both want the same live list, so it is loaded once here
  // rather than by each of them.
  const { backlog: activeBacklog } = useWorkspaceBacklog(activeThread?.cwd ?? null, desktopApi);
  const backlogCards = useMemo<BacklogCardIndex>(
    () => new Map(activeBacklog.items.map((item) => [item.number, { id: item.id, title: item.title }])),
    [activeBacklog],
  );
  const composerCards = useMemo<ComposerCard[]>(
    () =>
      activeBacklog.items.map((item) => ({
        number: item.number,
        title: item.title,
        summary: item.summary,
        column: COLUMN_LABELS[item.column],
      })),
    [activeBacklog],
  );
  const btwDraft = btwDraftByThread[activeDraftKey] ?? "";
  activeCwdRef.current = activeThread?.cwd ?? DEFAULT_WORKSPACE;
  defaultLaunchSettingsRef.current = {
    runtime: defaultRuntime,
    model: defaultRuntime === "codex" ? defaultCodexModel : defaultRuntime === "groq" ? defaultGroqModel : launchDefaultModel,
    effort: defaultRuntime === "codex" ? defaultCodexEffort : defaultEffort,
    permissionMode: defaultRuntime === "codex" ? defaultCodexSandbox : defaultPermissionMode,
  };
  const usage = usageByProvider[usageProvider] ?? null;
  const usageLoading = usageLoadingProvider === usageProvider;
  // clockTick re-renders every minute, so this stays honest without its own timer.
  const usageAge = usage ? relativeAge(usage.fetchedAt) : "--";
  const usageAgeLabel = usageAge === "now" ? "just now" : `${usageAge} ago`;
  const activeTokenUsage = activeThread ? (tokenUsageByThread[activeThread.id] ?? EMPTY_TOKEN_USAGE) : EMPTY_TOKEN_USAGE;
  const terminalTabs = activeThread ? (terminalTabsByThread[activeThread.id] ?? []) : [];
  const terminalPanelOpen = Boolean(activeThread && openTerminalThreadIds.has(activeThread.id) && terminalTabs.length > 0);
  const activeTerminalTabId = activeThread ? activeTerminalTabByThread[activeThread.id] || terminalTabs[0]?.id : undefined;
  const activeRuntimeActivity = activeThread ? runtimeActivityByThread[activeThread.id] : undefined;
  const activeRuntimeStatus = activeThread ? runtimeStatusByThread[activeThread.id] : undefined;
  // Only trust a pending approval while the section still says it needs one; a
  // stale snapshot must not leave an unanswerable card on screen.
  const activePendingApproval =
    activeThread?.agentState === "needs_action" ? activeRuntimeStatus?.pendingApproval : undefined;
  const activeRunInspector = activeThread ? runInspectorInfo(activeThread, activeConversation, activeRuntimeActivity, activeRuntimeStatus) : null;

  // Re-read the section's recorded cost whenever the info card is open and the
  // live counter moves, so an in-flight turn's spend climbs on screen.
  const costThreadId = activeThread?.id;
  useEffect(() => {
    if (!showTokenInfo || !costThreadId) {
      setSessionCostReport(null);
      return;
    }
    let cancelled = false;
    void desktopApi
      .loadUsageCost({ sessionId: costThreadId })
      .then((report) => {
        if (!cancelled) {
          setSessionCostReport(report);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessionCostReport(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [desktopApi, showTokenInfo, costThreadId, activeTokenUsage.totalTokens]);

  // Stable identity so the usage report's fetch effect isn't re-triggered by
  // every App re-render.
  const loadUsageCostRange = useCallback(
    (fromIso: string, toIso: string) => desktopApi.loadUsageCost({ fromIso, toIso }),
    [desktopApi],
  );

  useEffect(() => {
    if (!activeThread) {
      return;
    }

    const threadChanged = activeThread.id !== lastComposerFocusThreadIdRef.current;
    lastComposerFocusThreadIdRef.current = activeThread.id;

    if (
      activeBtw.open ||
      (terminalPanelOpen && !threadChanged) ||
      isRenaming ||
      showSettings ||
      showSelector ||
      showTokenInfo ||
      contextMenu ||
      workspaceMenu ||
      pendingDeleteThreadId ||
      previewImage ||
      readerOpen ||
      quickStartOpen ||
      newSectionChooserOpen ||
      promptHistoryOpen ||
      searchOpen ||
      backlogWorkspace ||
      taskView ||
      scheduleWorkspace ||
      gitWorkspace ||
      filesThreadId
    ) {
      return;
    }

    focusComposerSoon();
  }, [
    activeThread?.id,
    activeBtw.open,
    terminalPanelOpen,
    isRenaming,
    showSettings,
    showSelector,
    showTokenInfo,
    contextMenu,
    workspaceMenu,
    pendingDeleteThreadId,
    previewImage,
    readerOpen,
    quickStartOpen,
    newSectionChooserOpen,
    promptHistoryOpen,
    searchOpen,
    backlogWorkspace,
    taskView,
    scheduleWorkspace,
    gitWorkspace,
    filesThreadId,
    focusComposerSoon,
  ]);

  // A `panda://backlog/<id>` link in a transcript. The board is per workspace
  // and the link has no cwd in it, so it opens on the workspace of the section
  // whose transcript is on screen — the one whose agent wrote the link. Just
  // the card: the board is a button away on it, for when that is what was meant.
  useEffect(() => {
    const onOpenBacklogItem = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) {
        return;
      }
      setTaskView({ cwd: activeCwdRef.current, itemId: id });
    };
    window.addEventListener(OPEN_BACKLOG_ITEM_EVENT, onOpenBacklogItem);
    return () => window.removeEventListener(OPEN_BACKLOG_ITEM_EVENT, onOpenBacklogItem);
  }, []);

  const logRenderer = useCallback(
    (event: string, details?: Record<string, unknown>) => {
      void desktopApi.logEvent({ source: "renderer", event, details });
    },
    [desktopApi],
  );

  // A section is project-less when it carries the flag or simply lives in the
  // scratch workspace (older sections, and ones recovered from disk, only have
  // the path to go on).
  const isScratchCwd = useCallback(
    (cwd: string | undefined): boolean => Boolean(cwd) && Boolean(scratchCwd) && cwd === scratchCwd,
    [scratchCwd],
  );

  const workspaceLabel = useCallback(
    (cwd: string): string => (isScratchCwd(cwd) ? SCRATCH_WORKSPACE_LABEL : workspaceName(cwd)),
    [isScratchCwd],
  );

  /**
   * Sub-threads by parent id, for every workspace at once.
   *
   * One map rather than one per group because a sub-thread renders wherever its
   * parent does — including in the starred list, which is not a workspace group
   * at all. Starred sections are excluded as CHILDREN (they are lifted to the
   * top of the sidebar, and a row that renders twice is a row whose selected
   * state can disagree with itself) but not as PARENTS.
   */
  const subthreadsByParent = useMemo<Map<string, Thread[]>>(() => {
    const byParent = new Map<string, Thread[]>();
    const ordered = [...threads].sort((first, second) => threadOrderKey(second).localeCompare(threadOrderKey(first)));
    // Whatever renders at the top must NOT also render as somebody's child:
    // that is one section on screen twice, with two selection states.
    const roots = new Set(topLevelThreads(ordered.filter((thread) => !thread.draft)).map((thread) => thread.id));
    for (const thread of ordered) {
      if (thread.draft || thread.starred || !thread.parentId || roots.has(thread.id)) continue;
      byParent.set(thread.parentId, [...(byParent.get(thread.parentId) ?? []), thread]);
    }
    return byParent;
  }, [threads]);

  /**
   * Parents whose sub-threads are folded away. Collapsed rather than expanded is
   * what is stored, so a section that gains sub-threads shows them: the whole
   * point of the tree is that delegated work is visible without being looked
   * for, and a default of "hidden until you expand" is the flat list again.
   */
  const [collapsedSubthreads, setCollapsedSubthreads] = useState<Set<string>>(storedCollapsedSubthreads);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_SUBTHREADS_KEY, JSON.stringify([...collapsedSubthreads]));
  }, [collapsedSubthreads]);

  /**
   * Selects a section and unfolds whatever is hiding its row — its workspace
   * group, a collapsed parent — then scrolls that row into view once it has
   * mounted. Shared by the notification click and the sidebar's own
   * off-screen-finish callout, so both land the same way.
   */
  const jumpToThread = useCallback((thread: Thread) => {
    setShowSettings(false);
    setQuickStartOpen(false);
    setSearchOpen(false);
    setPromptHistoryOpen(false);
    setExpandedWorkspaces((current) => (current.has(thread.cwd) ? current : new Set(current).add(thread.cwd)));
    // A starred section lives only in the starred list, so folding that list
    // away hides its row entirely — unfold it too, or the jump scrolls to
    // nothing.
    if (thread.starred) {
      setStarredCollapsed(false);
    }
    if (thread.parentId) {
      const parentId = thread.parentId;
      setCollapsedSubthreads((current) => {
        if (!current.has(parentId)) return current;
        const next = new Set(current);
        next.delete(parentId);
        return next;
      });
    }
    setActiveThreadId(thread.id);
    setAttentionThreadIds((current) => {
      if (!current.has(thread.id)) return current;
      const next = new Set(current);
      next.delete(thread.id);
      return next;
    });
    pendingScrollThreadIdRef.current = thread.id;
  }, []);

  const markAttentionThreadsRead = useCallback((ids: Iterable<string>): void => {
    const readIds = new Set(ids);
    if (readIds.size === 0) return;
    setAttentionThreadIds((current) => {
      if (!Array.from(readIds).some((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of readIds) next.delete(id);
      return next;
    });
  }, []);

  const dismissAttention = useCallback((id: string): void => {
    setAttentionQueue((current) => current.filter((event) => event.id !== id));
    setMinimizedAttentionIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const openAttentionThread = useCallback((event: AgentAttentionEvent): void => {
    const thread = threadsRef.current.find((candidate) => candidate.id === event.threadId);
    if (thread) jumpToThread(thread);
    dismissAttention(event.id);
    focusComposerSoon();
  }, [dismissAttention, focusComposerSoon, jumpToThread]);

  const answerAttention = useCallback((event: AgentAttentionEvent, response: string): void => {
    void desktopApi.sendInput({ id: event.threadId, data: response }).then((result) => {
      if (!result.ok) return;
      dismissAttention(event.id);
      const thread = threadsRef.current.find((candidate) => candidate.id === event.threadId);
      if (thread) jumpToThread(thread);
    });
  }, [desktopApi, dismissAttention, jumpToThread]);

  const notifyThreadDone = useCallback(
    (thread: Thread) => {
      if (preferences.notificationsPaused || typeof Notification === "undefined" || Notification.permission !== "granted") {
        return;
      }

      const needsAction = thread.agentState === "needs_action";
      const notification = new Notification(thread.title?.trim() || "Panda Code", {
        body: needsAction ? "Needs your input" : "Finished — ready for your next prompt",
        tag: `panda-code:${thread.id}`,
      });
      notification.onclick = () => {
        notification.close();
        jumpToThread(thread);
        void desktopApi.focusWindow().then(focusComposerSoon);
      };
    },
    [desktopApi, focusComposerSoon, jumpToThread, preferences.notificationsPaused],
  );

  const toggleSubthreads = useCallback((parentId: string): void => {
    setCollapsedSubthreads((current) => {
      const next = new Set(current);
      if (!next.delete(parentId)) next.add(parentId);
      return next;
    });
  }, []);

  const activeParentThread = useMemo<Thread | undefined>(
    () => threads.find((thread) => thread.id === activeThread?.parentId),
    [threads, activeThread?.parentId],
  );
  const activeSubthreads = subthreadsByParent.get(activeThread?.id ?? "") ?? [];

  const starredThreads = useMemo<Thread[]>(
    () =>
      threads
        .filter((thread) => thread.starred)
        .sort((first, second) =>
          threadOrderKey(second).localeCompare(threadOrderKey(first)),
        ),
    [threads],
  );

  const workspaceGroups = useMemo<WorkspaceGroup[]>(() => {
    const groups = new Map<string, Thread[]>();

    for (const thread of threads) {
      // The draft has its own fixed entry above the groups — it is a route, not
      // a section, and listing it under a workspace would make the New Session
      // row look like one more never-run "Untitled".
      if (thread.draft) {
        continue;
      }
      // Starred sections are lifted into their own top-of-sidebar list, so
      // they must not also appear inside their workspace group.
      if (thread.starred) {
        continue;
      }
      groups.set(thread.cwd, [...(groups.get(thread.cwd) ?? []), thread]);
    }

    // The project-less group is a permanent fixture: it stays in the sidebar
    // with an empty state so starting a session without a folder is always one
    // click away, exactly like the quick-start and "+" entry points.
    if (scratchCwd && !groups.has(scratchCwd)) {
      groups.set(scratchCwd, []);
    }

    // Which sections exist in each workspace at all — starred ones included.
    // A sub-thread follows its parent WHEREVER that parent renders, so a child
    // of a starred section is not a root here: it appears under it in the
    // starred list. Rendering it in both places is the one outcome to avoid,
    // since the two copies then disagree about which is selected.
    const byCwd = new Map<string, Thread[]>();
    for (const thread of threads) {
      if (thread.draft) continue;
      byCwd.set(thread.cwd, [...(byCwd.get(thread.cwd) ?? []), thread]);
    }
    // Resolved against every section in the workspace — starred ones included —
    // so a child of a starred parent is not counted as a root here, and a
    // broken or looping link still renders somewhere rather than nowhere.
    const rootIdsByCwd = new Map(
      Array.from(byCwd, ([cwd, all]) => [cwd, new Set(topLevelThreads(all).map((thread) => thread.id))] as const),
    );

    const built = Array.from(groups, ([cwd, groupThreads]) => {
      const byRecency = groupThreads.sort((first, second) =>
        threadOrderKey(second).localeCompare(threadOrderKey(first)),
      );
      const roots = rootIdsByCwd.get(cwd) ?? new Set<string>();
      return {
      cwd,
      threads: byRecency.filter((thread) => roots.has(thread.id)),
      // Group's representative sort value: the newest stable order key across
      // its threads (prompt time, createdAt fallback — never the churny
      // lastActiveAt), so a reload's replay can't reshuffle workspace order.
      lastActiveAt: groupThreads.reduce(
        (latest, thread) => {
          const threadActivity = threadOrderKey(thread);
          return threadActivity > latest ? threadActivity : latest;
        },
        groupThreads[0] ? threadOrderKey(groupThreads[0]) : "",
      ),
      };
    });

    // Order by the persisted manual order so workspaces stay put across new
    // events. Freshly created workspaces (not yet tracked) sort to the front,
    // newest first, until the reconciliation effect commits them into the order.
    const rankByCwd = new Map(workspaceOrder.map((cwd, index) => [cwd, index]));
    return built.sort((first, second) => {
      const firstRank = rankByCwd.get(first.cwd);
      const secondRank = rankByCwd.get(second.cwd);
      if (firstRank === undefined && secondRank === undefined) {
        return second.lastActiveAt.localeCompare(first.lastActiveAt);
      }
      if (firstRank === undefined) {
        return -1;
      }
      if (secondRank === undefined) {
        return 1;
      }
      return firstRank - secondRank;
    });
  }, [threads, workspaceOrder, scratchCwd]);

  // Reconcile the persisted order with the workspaces that actually exist:
  // prepend newly discovered workspaces (position 1) and drop ones with no
  // threads left. Converges in one extra pass, so it never loops.
  useEffect(() => {
    const present = workspaceGroups.map((group) => group.cwd);
    const presentSet = new Set(present);
    const tracked = new Set(workspaceOrder);
    const additions = present.filter((cwd) => !tracked.has(cwd));
    const retained = workspaceOrder.filter((cwd) => presentSet.has(cwd));
    const next = [...additions, ...retained];
    const changed = next.length !== workspaceOrder.length || next.some((cwd, index) => cwd !== workspaceOrder[index]);
    if (changed) {
      setWorkspaceOrder(next);
    }
  }, [workspaceGroups, workspaceOrder]);

  // The order the sidebar RENDERS: the committed order, plus the in-flight drag
  // applied on top. Releasing simply commits this, so the preview can never
  // disagree with the result.
  const previewWorkspaceGroups = useMemo(() => {
    if (!draggingWorkspace || workspaceDropIndex === null) {
      return workspaceGroups;
    }
    return moveItemToIndex(workspaceGroups, (group) => group.cwd, draggingWorkspace, workspaceDropIndex);
  }, [workspaceGroups, draggingWorkspace, workspaceDropIndex]);

  // FLIP: after the preview reorders the DOM, animate every group from where it
  // used to be to where it now is, so the list visibly shuffles instead of
  // snapping. Offsets are refreshed on every render (also when not dragging) so
  // the next drag starts from an accurate baseline.
  useLayoutEffect(() => {
    const previous = new Map(workspaceOffsetsRef.current);
    workspaceOffsetsRef.current.clear();
    // One extra animated pass after the drag ends, so a cancelled drag glides
    // back instead of snapping. Outside that window nothing animates — group
    // expand/collapse and arriving sessions relayout the list too.
    const animating =
      (draggingWorkspace !== null || workspaceFlipRef.current) &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const group of previewWorkspaceGroups) {
      const node = workspaceNodesRef.current.get(group.cwd);
      if (!node) {
        continue;
      }
      const top = node.offsetTop;
      workspaceOffsetsRef.current.set(group.cwd, top);
      const before = previous.get(group.cwd);
      if (!animating || before === undefined || before === top) {
        continue;
      }
      node.animate(
        [{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0px)" }],
        { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    }
    if (!draggingWorkspace) {
      workspaceFlipRef.current = false;
    }
  }, [previewWorkspaceGroups, draggingWorkspace]);

  const beginWorkspaceDrag = useCallback(
    (cwd: string) => {
      const measured = workspaceGroups.flatMap((group) => {
        const node = workspaceNodesRef.current.get(group.cwd);
        if (!node) {
          return [];
        }
        const rect = node.getBoundingClientRect();
        return [{ cwd: group.cwd, top: rect.top, height: rect.height, node }];
      });
      const dragged = measured.find((entry) => entry.cwd === cwd);
      const gap = dragged?.node.parentElement
        ? Number.parseFloat(window.getComputedStyle(dragged.node.parentElement).rowGap) || 0
        : 0;
      // Midpoints of the OTHER groups in the layout the dragged group leaves
      // behind: each one below it closes up by its height. Then "how many
      // midpoints are above the cursor" IS the landing index.
      const mids = measured
        .filter((entry) => entry.cwd !== cwd)
        .map((entry) =>
          dragged && entry.top > dragged.top
            ? entry.top + entry.height / 2 - (dragged.height + gap)
            : entry.top + entry.height / 2,
        );
      workspaceDragMidsRef.current = { mids };
      workspaceFlipRef.current = true;
      setDraggingWorkspace(cwd);
      setWorkspaceDropIndex(workspaceGroups.findIndex((group) => group.cwd === cwd));
    },
    [workspaceGroups],
  );

  // Hit-test the pointer against the frozen midpoints. Frozen, because the
  // preview moves the groups under the cursor — re-measuring would let that
  // movement re-trigger itself and the list would flip back and forth.
  const updateWorkspaceDropIndex = useCallback((clientY: number) => {
    const geometry = workspaceDragMidsRef.current;
    if (!geometry) {
      return;
    }
    setWorkspaceDropIndex(geometry.mids.filter((mid) => mid < clientY).length);
  }, []);

  const endWorkspaceDrag = useCallback(() => {
    workspaceDragMidsRef.current = null;
    setDraggingWorkspace(null);
    setWorkspaceDropIndex(null);
  }, []);

  const commitWorkspaceDrag = useCallback(() => {
    if (draggingWorkspace && workspaceDropIndex !== null) {
      setWorkspaceOrder(previewWorkspaceGroups.map((group) => group.cwd));
    }
    endWorkspaceDrag();
  }, [draggingWorkspace, workspaceDropIndex, previewWorkspaceGroups, endWorkspaceDrag]);

  // Session archiving is a device-local view toggle (see ARCHIVED_THREADS_KEY):
  // it hides a workspace group's row from the default view without touching
  // the session itself. Shared by the Cmd+1-9 jump list below and the sidebar
  // render further down so both agree on what is actually on screen.
  const getDisplayedGroupThreads = (group: WorkspaceGroup): Thread[] => {
    if (showArchivedByCwd[group.cwd]) {
      return group.threads;
    }
    return group.threads.filter((thread) => !archivedThreadIds.has(thread.id));
  };

  // Flat list of threads in the exact order they appear in the sidebar
  // (starred first, then each workspace group). Drives the Cmd+1-9 shortcuts
  // so pressing a number jumps to the Nth session as it reads top to bottom.
  // Only rows actually on screen count: a collapsed workspace contributes
  // nothing, and a group truncated by "Show more" contributes just its visible
  // slice — otherwise the numbers drift off what the user is looking at.
  const sidebarOrderedThreads = useMemo<Thread[]>(
    () => [
      ...(starredCollapsed
        ? []
        : starredThreads.flatMap((thread) =>
            flattenThreadTree(thread, subthreadsByParent, collapsedSubthreads, visibleSubthreadCounts),
          )),
      ...workspaceGroups.flatMap((group) => {
        if (!expandedWorkspaces.has(group.cwd)) return [];
        const displayedThreads = getDisplayedGroupThreads(group);
        const visibleCount = Math.min(
          visibleSessionCounts[group.cwd] ?? INITIAL_VISIBLE_SESSIONS,
          displayedThreads.length,
        );
        return displayedThreads
          .slice(0, visibleCount)
          .flatMap((thread) =>
            flattenThreadTree(thread, subthreadsByParent, collapsedSubthreads, visibleSubthreadCounts),
          );
      }),
    ],
    [
      starredThreads,
      starredCollapsed,
      workspaceGroups,
      expandedWorkspaces,
      visibleSessionCounts,
      subthreadsByParent,
      collapsedSubthreads,
      visibleSubthreadCounts,
      archivedThreadIds,
      showArchivedByCwd,
    ],
  );
  const sidebarOrderedThreadsRef = useRef(sidebarOrderedThreads);
  sidebarOrderedThreadsRef.current = sidebarOrderedThreads;

  // Distinct project folders offered in the quick-start picker: the current
  // default first, then workspaces by recency, then the built-in default, plus
  // any freshly-browsed folder so it stays selectable.
  const quickStartProjects = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    const push = (cwd?: string): void => {
      if (cwd && !seen.has(cwd)) {
        seen.add(cwd);
        list.push(cwd);
      }
    };
    push(activeThread?.cwd);
    for (const group of workspaceGroups) {
      push(group.cwd);
    }
    for (const thread of threads) {
      push(thread.cwd);
    }
    push(DEFAULT_WORKSPACE);
    push(quickStartCwd);
    // "No project" is always offered, even on a fresh install with no sections
    // in the scratch workspace yet.
    push(scratchCwd || undefined);
    return list;
  }, [activeThread?.cwd, workspaceGroups, threads, quickStartCwd, scratchCwd]);

  // Runtime ticks (onSessionRuntime) call this on every streamed token from
  // every running section, almost always with a patch identical to what's
  // already there (agentState stays "working" for the whole turn). Without a
  // dirty-check this stamped a fresh array + a fresh lastActiveAt on every
  // tick, which — since the sidebar has no per-row memoization boundary —
  // forced the whole thread list to re-render dozens of times a second per
  // running section. Skip the update (same array reference) when nothing in
  // the patch actually differs, so setState is a true no-op.
  const updateThread = useCallback((id: string, patch: Partial<Thread>) => {
    setThreads((current) => {
      let changed = false;
      const next = current.map((thread) => {
        if (thread.id !== id) return thread;
        const dirty = (Object.keys(patch) as (keyof Thread)[]).some((key) => thread[key] !== patch[key]);
        if (!dirty) return thread;
        changed = true;
        return { ...thread, ...patch, lastActiveAt: new Date().toISOString() };
      });
      return changed ? next : current;
    });
  }, []);

  const rememberPrompt = useCallback((threadId: string, entry: SessionPromptHistoryEntry): void => {
    setThreads((current) => {
      let changed = false;
      const next = current.map((thread) => {
        if (thread.id !== threadId || thread.promptHistory?.some((saved) => saved.id === entry.id)) return thread;
        changed = true;
        return { ...thread, promptHistory: [...(thread.promptHistory ?? []), entry] };
      });
      return changed ? next : current;
    });
  }, []);

  const markRuntimeActivity = useCallback((id: string, source: RuntimeActivity["source"], detail: string) => {
    setRuntimeActivityByThread((current) => ({
      ...current,
      [id]: {
        source,
        detail,
        at: new Date().toISOString(),
      },
    }));
  }, []);

  const clearThinkingItems = useCallback((id: string) => {
    setConversationItems((current) => {
      const items = current[id];
      if (!items?.some(isThinkingItem)) {
        return current;
      }

      return { ...current, [id]: withoutLocalThinking(items) };
    });
  }, []);

  // Several sessions can settle at once; coalesce into one refresh a bit later,
  // by which time the API has caught up with the finished turns. The main process
  // throttles to one network call a minute on top of this, so a busy fleet can't
  // rate-limit us however often this fires.
  const scheduleUsageRefresh = useCallback(() => {
    if (usageRefreshTimerRef.current !== undefined) {
      return;
    }

    usageRefreshTimerRef.current = window.setTimeout(() => {
      usageRefreshTimerRef.current = undefined;
      refreshUsageRef.current();
    }, 15_000);
  }, []);

  const clearIdleTimer = useCallback((id: string) => {
    const timer = idleTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      idleTimersRef.current.delete(id);
    }
  }, []);

  const finishSendingPrompt = useCallback(() => {
    logRenderer("prompt:send-finished", { pendingThreadId: pendingPromptRef.current?.threadId });
    sendingPromptRef.current = false;
    setIsSendingPrompt(false);
  }, [logRenderer]);

  const applyPendingLaunchRestart = useCallback(
    (id: string, notice = "Launch setting applied. The next prompt resumes this section with the selected provider."): boolean => {
      if (!pendingLaunchRestartRef.current.has(id)) {
        return false;
      }

      pendingLaunchRestartRef.current.delete(id);
      logRenderer("launch-setting:restart-after-run", { threadId: id });
      void desktopApi.stopSession({ id });
      clearThinkingItems(id);
      updateThread(id, { agentState: "exited", status: "exited" });
      if (id === activeThreadId) {
        setNotice(notice);
      }
      return true;
    },
    [activeThreadId, clearThinkingItems, desktopApi, logRenderer, updateThread],
  );

  // The main process could not hand this prompt to any live transport, so no
  // turn will ever start. Without this the section keeps its optimistic
  // "Thinking..." card and looks like a hung agent forever.
  const handleDroppedInput = useCallback(
    (id: string, message: string): void => {
      logRenderer("prompt:input-dropped", { threadId: id, message });
      clearIdleTimer(id);
      setConversationItems((current) => {
        const items = current[id];
        if (!items) {
          return current;
        }

        return {
          ...current,
          [id]: items.filter((item) => !isThinkingItem(item) && !item.id.startsWith("local-steer:")),
        };
      });
      updateThread(id, { agentState: "exited", status: "exited" });
      if (id === activeThreadId) {
        setNotice(message);
      }
    },
    [activeThreadId, clearIdleTimer, logRenderer, updateThread],
  );

  const flushPendingPrompt = useCallback(
    (threadId: string): boolean => {
      const pending = pendingPromptRef.current;
      if (!pending || pending.threadId !== threadId) {
        logRenderer("prompt:flush-skipped", {
          threadId,
          pendingThreadId: pending?.threadId,
        });
        return false;
      }

      window.clearTimeout(pending.timeoutId);
      pendingPromptRef.current = null;
      logRenderer("prompt:flush", { threadId, promptLength: pending.prompt.length });
      void desktopApi.sendInput({ id: threadId, data: `${pending.prompt}\r` }).then((result) => {
        if (!result.ok) {
          handleDroppedInput(threadId, result.message);
        }
      });
      finishSendingPrompt();
      return true;
    },
    [desktopApi, finishSendingPrompt, handleDroppedInput, logRenderer],
  );


  useEffect(() => {
    let isMounted = true;

    void desktopApi.loadThreads().then((storedThreads) => {
      if (!isMounted) {
        return;
      }

      if (storedThreads.length > 0) {
        const normalizedThreads = normalizeThreads(storedThreads);
        // Carry the live draft across the swap — it holds whatever the user has
        // already typed on the New Session route, which the stored list by
        // definition knows nothing about.
        setThreads((current) => [
          current.find((thread) => thread.draft) ?? createDraftThread(),
          ...normalizedThreads,
        ]);
        setActiveThreadId((current) =>
          current === DRAFT_THREAD_ID || normalizedThreads.some((thread) => thread.id === current)
            ? current
            : normalizedThreads[0]?.id ?? DRAFT_THREAD_ID,
        );
      } else if (initialThreadsRef.current.length > 0) {
        void desktopApi.saveThreads(persistableThreads(initialThreadsRef.current));
      }

      hasLoadedStoredThreadsRef.current = true;
    });

    return () => {
      isMounted = false;
    };
  }, [desktopApi]);

  useEffect(() => {
    // The draft is renderer-only state: it must never reach localStorage or
    // threads.json, or an abandoned composer would come back as a real section.
    const persisted = persistableThreads(threads);
    const flush = (): void => {
      // Clear first: whoever calls this has taken responsibility for the write,
      // and the teardown flush must not repeat one the timer already did.
      pendingThreadsWriteRef.current = null;
      const started = performance.now();
      const serialized = JSON.stringify(persisted);
      localStorage.setItem(STORAGE_KEY, serialized);
      // Recorded with its size: this write is synchronous and grew with the
      // store, so knowing the bytes is what makes a regression here legible.
      recordRendererPerf("renderer:persist-threads", performance.now() - started, serialized.length);
      if (hasLoadedStoredThreadsRef.current) {
        void desktopApi.saveThreads(persisted);
      }
    };

    pendingThreadsWriteRef.current = flush;
    const timer = window.setTimeout(flush, THREADS_PERSIST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [desktopApi, threads]);

  // The debounce above is only safe because of this: a section renamed or
  // started in the last half-second would otherwise be lost when the window
  // goes away. Cleanups run in declaration order, so the timer is already
  // cancelled by the time this flushes the value it was going to write.
  useEffect(() => {
    const flushPending = (): void => pendingThreadsWriteRef.current?.();
    window.addEventListener("pagehide", flushPending);
    return () => {
      window.removeEventListener("pagehide", flushPending);
      flushPending();
    };
  }, []);

  useEffect(() => startRendererPerf(desktopApi), [desktopApi]);

  // Import prompts from transcripts created before the durable index existed.
  // This is deliberately incremental: once imported, clearing or windowing the
  // transcript can no longer make them disappear from /prompts.
  useEffect(() => {
    setThreads((current) => {
      let changed = false;
      const next = current.map((thread) => {
        const saved = thread.promptHistory ?? [];
        const known = new Set(saved.map((entry) => promptHistorySignature(entry.text, entry.timestamp)));
        const additions = (conversationItems[thread.id] ?? [])
          .filter((item) => item.kind === "user" && item.body.trim().length > 0)
          .map((item) => ({
            id: item.id,
            text: promptHistoryText(item.body),
            attachments: attachedImagePathsFromBody(item.body).length,
            timestamp: item.timestamp ?? "",
            conversationItemId: item.id,
          }))
          .filter((entry) => {
            const signature = promptHistorySignature(entry.text, entry.timestamp);
            if (known.has(signature)) return false;
            known.add(signature);
            return true;
          });
        if (additions.length === 0) return thread;
        changed = true;
        return { ...thread, promptHistory: [...saved, ...additions] };
      });
      return changed ? next : current;
    });
  }, [conversationItems]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_COMMAND_KEY, defaultCommand.trim() || DEFAULT_COMMAND);
  }, [defaultCommand]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_RUNTIME_KEY, defaultRuntime);
  }, [defaultRuntime]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_MODEL_KEY, defaultModel.trim());
  }, [defaultModel]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_EFFORT_KEY, defaultEffort.trim());
  }, [defaultEffort]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_PERMISSION_MODE_KEY, defaultPermissionMode.trim());
  }, [defaultPermissionMode]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_CODEX_MODEL_KEY, defaultCodexModel.trim());
  }, [defaultCodexModel]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_CODEX_EFFORT_KEY, defaultCodexEffort.trim());
  }, [defaultCodexEffort]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_CODEX_SANDBOX_KEY, defaultCodexSandbox.trim() || "read-only");
  }, [defaultCodexSandbox]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_GROQ_MODEL_KEY, defaultGroqModel.trim());
  }, [defaultGroqModel]);

  useEffect(() => {
    localStorage.setItem(EXPANDED_WORKSPACES_KEY, JSON.stringify(Array.from(expandedWorkspaces)));
  }, [expandedWorkspaces]);

  useEffect(() => {
    localStorage.setItem(STARRED_COLLAPSED_KEY, starredCollapsed ? "true" : "false");
  }, [starredCollapsed]);

  useEffect(() => {
    localStorage.setItem(ARCHIVED_THREADS_KEY, JSON.stringify(Array.from(archivedThreadIds)));
  }, [archivedThreadIds]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_ORDER_KEY, JSON.stringify(workspaceOrder));
  }, [workspaceOrder]);

  useEffect(() => {
    if (!contextMenu) {
      setContextMobileNotifications(null);
      return;
    }
    let cancelled = false;
    setContextMobileNotifications(null);
    const timeout = window.setTimeout(() => {
      if (!cancelled) setContextMobileNotifications({ available: false, phoneCount: 0, subscribedPhones: 0 });
    }, 3_500);
    void desktopApi.getSessionMobileNotifications(contextMenu.threadId).then((status) => {
      if (!cancelled) {
        window.clearTimeout(timeout);
        setContextMobileNotifications(status);
      }
    }).catch(() => {
      if (!cancelled) setContextMobileNotifications({ available: false, phoneCount: 0, subscribedPhones: 0 });
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [contextMenu?.threadId, desktopApi]);

  useEffect(() => {
    localStorage.setItem(FOCUS_MODE_KEY, focusMode ? "on" : "off");
  }, [focusMode]);

  useEffect(() => {
    localStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify(terminalTabsByThread));
  }, [terminalTabsByThread]);

  // The sidebar's browser mark. See `browserMarksByThread`: this reduces the
  // firehose to one small object per section and keeps the old one when nothing
  // visible changed, so a page loading somewhere does not re-render the app.
  useEffect(() => {
    const apply = (state: BrowserState): void => {
      const next: Record<string, { tabs: number; note: boolean }> = {};
      for (const tab of state.tabs) {
        const current = next[tab.threadId] ?? { tabs: 0, note: false };
        next[tab.threadId] = { tabs: current.tabs + 1, note: current.note || Boolean(tab.note) };
      }
      setBrowserMarksByThread((previous) => {
        const keys = Object.keys(next);
        const same =
          keys.length === Object.keys(previous).length &&
          keys.every((key) => previous[key]?.tabs === next[key]?.tabs && previous[key]?.note === next[key]?.note);
        return same ? previous : next;
      });
    };
    void desktopApi.browserState().then(apply);
    return desktopApi.onBrowserState(apply);
  }, [desktopApi]);

  // Reconcile persisted terminal tabs against the ptys main actually holds.
  // Tabs survive a renderer reload (main owns the ptys), but an app restart
  // kills every pty while localStorage keeps the tab metadata — which would
  // leave threads showing a terminal badge for a shell that no longer exists.
  // Prune those phantom tabs on startup so the badge reflects live terminals.
  useEffect(() => {
    let cancelled = false;
    void desktopApi.listTerminals().then((liveIds) => {
      if (cancelled) {
        return;
      }
      const live = new Set(liveIds);
      setTerminalTabsByThread((prev) => {
        let changed = false;
        const next: Record<string, TerminalTab[]> = {};
        for (const [threadId, tabs] of Object.entries(prev)) {
          const kept = tabs.filter((tab) => live.has(tab.id));
          if (kept.length !== tabs.length) {
            changed = true;
          }
          if (kept.length > 0) {
            next[threadId] = kept;
          }
        }
        return changed ? next : prev;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(BTW_WIDTH_KEY, String(btwWidth));
  }, [btwWidth]);

  // Resolve (and create) the scratch workspace once per launch. The path is
  // stable, so it is cached to keep the sidebar from flashing the raw folder
  // name before the answer lands.
  useEffect(() => {
    let cancelled = false;
    void desktopApi.ensureScratchWorkspace().then((path) => {
      if (cancelled || !path) {
        return;
      }
      const firstRun = storedScratchWorkspace() !== path;
      setScratchCwd(path);
      localStorage.setItem(SCRATCH_WORKSPACE_KEY, path);
      // Open the group the first time it appears so its empty state (and the
      // way to start a project-less section) is visible without hunting.
      if (firstRun) {
        setExpandedWorkspaces((current) => new Set(current).add(path));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  const startSidebarResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      setResizingSidebar(true);
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const onMove = (moveEvent: MouseEvent) => {
        setSidebarWidth(clampSidebarWidth(startWidth + (moveEvent.clientX - startX)));
      };
      const onUp = () => {
        setResizingSidebar(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  // The /btw grip lives on the panel's left edge, so dragging right shrinks it.
  const startBtwResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      setResizingBtw(true);
      const startX = event.clientX;
      const startWidth = btwWidth;
      const onMove = (moveEvent: MouseEvent) => {
        setBtwWidth(clampBtwWidth(startWidth - (moveEvent.clientX - startX)));
      };
      const onUp = () => {
        setResizingBtw(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [btwWidth],
  );

  const browserPanelOpen = Boolean(activeThread && openBrowserThreadIds.has(activeThread.id));
  const browserPresentation: BrowserPresentation =
    (activeThread && browserPresentationByThread[activeThread.id]) || "docked";

  const toggleBrowserPanel = useCallback((): void => {
    const threadId = activeThread?.id;
    if (!threadId) return;
    setOpenBrowserThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, [activeThread?.id]);

  // The shortcut handler is registered once, so it reads the latest toggle
  // through a ref rather than re-binding on every section switch.
  const toggleBrowserPanelRef = useRef(toggleBrowserPanel);
  toggleBrowserPanelRef.current = toggleBrowserPanel;

  // The floating window asking the app to come to a section — the way back from
  // a page to the conversation that opened it.
  useEffect(() => {
    return desktopApi.onBrowserFocusThread(({ threadId }) => {
      if (threadId) setActiveThreadId(threadId);
    });
  }, [desktopApi]);

  /**
   * Tell main whether this section's browser is really on screen.
   *
   * Agents ask "can the user see this page", and the only honest answer comes
   * from here: the panel has to be open, this has to be the section in view, and
   * the window has to not be minimised or behind something.
   */
  useEffect(() => {
    const threadId = activeThread?.id;
    if (!threadId) return;

    const report = (): void => {
      void desktopApi.browserSetPanelVisible({
        threadId,
        visible: browserPanelOpen && !document.hidden && document.hasFocus(),
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      // Leaving a section, or closing the panel, means it is no longer showing.
      void desktopApi.browserSetPanelVisible({ threadId, visible: false });
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      document.removeEventListener("visibilitychange", report);
    };
  }, [activeThread?.id, browserPanelOpen, desktopApi]);

  // A shell caller (`panda-peers browser …`) has no section of its own, so main
  // acts on the one in front of the user. It only knows that if we say so.
  useEffect(() => {
    void desktopApi.browserSetActiveThread(activeThread?.id ?? "");
  }, [activeThread?.id, desktopApi]);

  /**
   * The grip on the browser dock's left edge.
   *
   * Two things this needs that /btw's does not, both because the thing being
   * resized is a live web page rather than DOM:
   *
   * 1. Pointer capture. A `<webview>` is its own compositing layer and eats
   *    mouse events, so the moment the pointer crossed the page the drag died
   *    mid-gesture. `setPointerCapture` keeps every move coming here — and the
   *    CSS turns off hit-testing on the guests for the duration as a belt to
   *    that brace.
   * 2. Frame coalescing. A mousemove can arrive several times per frame, and
   *    each one relaid out a full page; on a heavy page that stutters badly.
   *    One width change per frame is all a screen can show anyway.
   */
  const startBrowserResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const grip = event.currentTarget;
      grip.setPointerCapture(event.pointerId);
      setResizingBrowser(true);

      const startX = event.clientX;
      const startWidth = browserWidth;
      let frame = 0;
      let pending = startWidth;

      const onMove = (moveEvent: Event) => {
        const point = moveEvent as PointerEvent;
        pending = clampBrowserWidth(startWidth - (point.clientX - startX));
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          setBrowserWidth(pending);
        });
      };
      const onUp = () => {
        cancelAnimationFrame(frame);
        setBrowserWidth(pending);
        setResizingBrowser(false);
        grip.releasePointerCapture(event.pointerId);
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    },
    [browserWidth],
  );

  // A window that shrinks must not leave the browser wider than it can afford.
  useEffect(() => {
    const onResize = (): void => setBrowserWidth((current) => clampBrowserWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    localStorage.setItem(BROWSER_WIDTH_KEY, String(browserWidth));
  }, [browserWidth]);

  useEffect(() => {
    void desktopApi.loadPreferences().then(async (loaded) => {
      if (!loaded.notificationChannels) {
        loaded = await desktopApi.savePreferences({ notificationChannels: normalizeNotificationChannels({
          desktop: storedNotificationsEnabled(), agent: storedAgentNotificationsEnabled(), sessions: storedSessionNotificationOverrides(),
        }) });
      }
      setPreferences(loaded);
    });
    return desktopApi.onPreferencesChanged(setPreferences);
  }, [desktopApi]);

  useEffect(() => {
    setRelayUrlDraft(preferences.relayUrl);
  }, [preferences.relayUrl]);

  const refreshRemoteDevices = useCallback(() => {
    void desktopApi.listRemotePairedDevices().then(setRemoteDevices).catch(() => setRemoteDevices([]));
  }, [desktopApi]);

  useEffect(() => {
    if (!preferences.relayUrl) {
      setRemoteDevices([]);
    } else if (showSettings && (settingsTab === "phone" || settingsTab === "notifications")) {
      refreshRemoteDevices();
    }
  }, [preferences.relayUrl, refreshRemoteDevices, settingsTab, showSettings]);

  useEffect(() => {
    if (showSettings) {
      refreshRemoteDevices();
    }
  }, [refreshRemoteDevices, showSettings]);

  useEffect(() => {
    return desktopApi.onQuickStart(() => {
      const defaults = defaultLaunchSettingsRef.current;
      applyQuickStartDraft("");
      // Default the target project to whatever a new section would use now.
      setQuickStartCwd(activeCwdRef.current);
      setQuickStartRuntime(defaults.runtime);
      setQuickStartModel(defaults.model);
      setQuickStartEffort(defaults.effort);
      setQuickStartPermissionMode(defaults.permissionMode);
      setQuickStartSelectorOpen(false);
      setQuickStartAttachments((current) => {
        for (const attachment of current) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        return [];
      });
      setQuickStartOpen(true);
    });
  }, [desktopApi]);

  useEffect(() => {
    return desktopApi.onAgentAttention((event) => {
      setAttentionQueue((current) =>
        current.some((candidate) => candidate.id === event.id)
          ? current
          : [...current.filter((candidate) => candidate.threadId !== event.threadId), event],
      );
    });
  }, [desktopApi]);

  useEffect(() => {
    if (!activeAttention) return;
    void desktopApi.focusWindow();
    return playAgentNotificationSound();
  }, [activeAttention?.id]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }

    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const sessions = threadsRef.current.map((thread) => ({
        id: thread.id,
        cwd: thread.cwd,
        claudeSessionId: thread.claudeSessionId,
        codexThreadId: thread.codexThreadId,
        title: thread.title,
        workspaceName: workspaceLabel(thread.cwd),
      }));
      void desktopApi.searchConversations({ query, sessions }).then((results) => {
        if (!cancelled) {
          setSearchResults(results);
          setSearchLoading(false);
        }
      });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [desktopApi, searchOpen, searchQuery, workspaceLabel]);

  useEffect(() => {
    // An agent opening a tab or leaving a note asks for the panel. It is the
    // one thing in the browser main pushes at the UI rather than answering:
    // a note the user never sees is not a hand-off.
    return desktopApi.onBrowserReveal(({ threadId }) => {
      if (!threadId) return;
      setOpenBrowserThreadIds((current) => new Set(current).add(threadId));
    });
  }, [desktopApi]);

  useEffect(() => {
    // A shell that exits (user typed `exit`, or it crashed) closes its tab.
    return desktopApi.onTerminalExit(({ id }) => {
      setTerminalTabsByThread((current) => {
        if (!Object.values(current).some((tabs) => tabs.some((tab) => tab.id === id))) {
          return current;
        }

        return Object.fromEntries(
          Object.entries(current).map(([threadId, tabs]) => [threadId, tabs.filter((tab) => tab.id !== id)]),
        );
      });
      setActiveTerminalTabByThread((current) => {
        const entry = Object.entries(current).find(([, tabId]) => tabId === id);
        return entry ? { ...current, [entry[0]]: "" } : current;
      });
    });
  }, [desktopApi]);

  useEffect(() => {
    if (!anyDesktopNotificationsEnabled || typeof Notification === "undefined") {
      return;
    }
    if (Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, [anyDesktopNotificationsEnabled]);

  // Fires once a section has been settled long enough to be a real finish
  // (see FINISH_SETTLE_MS). Reads live state via refs since it runs from a
  // timer, not a render.
  settleHandlerRef.current = (threadId: string) => {
    const thread = threadsRef.current.find((candidate) => candidate.id === threadId);
    if (!thread || thread.agentState === "working" || thread.agentState === "exited") {
      return;
    }

    // A genuinely finished (ready) turn flushes the next queued message and
    // keeps going — no notification, since it is not really idle.
    if (thread.agentState === "waiting") {
      const queue = queuedByThread[threadId];
      const next = queue?.[0];
      if (next) {
        void sendPromptRef.current(thread, next.text, next.attachments.map((attachment) => attachment.path)).then((ok) => {
          if (ok) {
            setQueuedByThread((current) => ({
              ...current,
              [threadId]: (current[threadId] ?? []).filter((entry) => entry.id !== next.id),
            }));
            for (const attachment of next.attachments) {
              URL.revokeObjectURL(attachment.previewUrl);
            }
          }
        });
        return;
      }
    }

    const focused = typeof document === "undefined" ? true : document.hasFocus();
    if (thread.id === activeThreadId && focused) {
      return;
    }

    setAttentionThreadIds((current) => (current.has(threadId) ? current : new Set(current).add(threadId)));
    const channels = resolveNotificationChannels(notificationChannels, thread.id);
    if (channels.desktop) {
      notifyThreadDone(thread);
    }
    if (agentAttentionAllowed(notificationChannels, thread.id, preferences.notificationsPaused, false)) {
      const now = Date.now();
      const needsAction = thread.agentState === "needs_action";
      const important = needsAction ? undefined : latestTurnImportant(conversationItemsRef.current[thread.id] ?? []);
      setAttentionQueue((current) => [
        ...current.filter((event) => event.threadId !== thread.id),
        {
          id: `completion:${thread.id}:${now}`,
          threadId: thread.id,
          threadTitle: thread.title?.trim() || "Untitled section",
          summary: needsAction ? "Needs your input" : important ? "Important — please review" : "Finished — ready for your next prompt",
          tldr: needsAction ? undefined : latestTurnTldr(conversationItemsRef.current[thread.id] ?? []),
          important,
          severity: needsAction || important ? "urgent" : "important",
          choices: [],
          createdAt: new Date(now).toISOString(),
        },
      ]);
    }
  };

  useEffect(() => {
    const previous = prevAgentStateRef.current;
    const timers = finishTimersRef.current;
    const resumedIds: string[] = [];

    const cancelFinishTimer = (id: string) => {
      const timer = timers.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.delete(id);
      }
    };

    for (const thread of threads) {
      const prior = previous.get(thread.id);
      previous.set(thread.id, thread.agentState);

      if (thread.agentState === "working" || thread.agentState === "exited") {
        // Back to work (or gone) — any pending "finished" is a subagent blip.
        cancelFinishTimer(thread.id);
        if (thread.agentState === "working") {
          resumedIds.push(thread.id);
        }
        continue;
      }

      if (
        hasSeededAgentStatesRef.current &&
        prior === "working" &&
        (thread.agentState === "waiting" || thread.agentState === "needs_action") &&
        !timers.has(thread.id)
      ) {
        const id = thread.id;
        timers.set(
          id,
          window.setTimeout(() => {
            timers.delete(id);
            settleHandlerRef.current(id);
          }, FINISH_SETTLE_MS),
        );
      }
    }

    for (const id of Array.from(previous.keys())) {
      if (!threads.some((thread) => thread.id === id)) {
        previous.delete(id);
        cancelFinishTimer(id);
      }
    }

    if (!hasSeededAgentStatesRef.current) {
      hasSeededAgentStatesRef.current = true;
      return;
    }

    const liveIds = new Set(threads.map((thread) => thread.id));
    setAttentionThreadIds((current) => {
      let next = current;
      const clone = () => {
        if (next === current) {
          next = new Set(current);
        }
        return next;
      };

      for (const id of Array.from(current)) {
        if (!liveIds.has(id)) {
          clone().delete(id);
        }
      }
      for (const id of resumedIds) {
        if (next.has(id)) {
          clone().delete(id);
        }
      }
      return next;
    });
  }, [threads, activeThreadId]);

  useEffect(() => {
    const clearActiveAttention = () => {
      setAttentionThreadIds((current) => {
        if (!current.has(activeThreadId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(activeThreadId);
        return next;
      });
    };

    clearActiveAttention();
    window.addEventListener("focus", clearActiveAttention);
    return () => window.removeEventListener("focus", clearActiveAttention);
  }, [activeThreadId]);

  useEffect(() => {
    void desktopApi.setBadgeCount(attentionThreadIds.size);
  }, [attentionThreadIds, desktopApi]);

  /**
   * Which attention threads have no row visible anywhere in the sidebar right
   * now. A row with no DOM element at all (its workspace is collapsed, its
   * parent is folded, it's paged behind "show more") is off screen by
   * definition — no observer entry for it will ever arrive. A row that does
   * exist gets watched against the scrollable list so scrolling it past the
   * fold, or back into view, updates this live.
   */
  useEffect(() => {
    // Sub-threads are deliberately left out: they finish constantly while their
    // parent works, and a callout for each one is noise rather than a section
    // the user lost track of. The parent's own row carries their busy count.
    const parentIds = new Set(threads.map((thread) => thread.id));
    const isSubthread = (id: string): boolean => {
      const thread = threads.find((candidate) => candidate.id === id);
      return Boolean(thread?.parentId && parentIds.has(thread.parentId));
    };
    const ids = Array.from(attentionThreadIds).filter((id) => id !== activeThreadId && !isSubthread(id));
    const root = workspaceListRef.current;
    if (!root || ids.length === 0) {
      setOffscreenAttentionIds((current) => (current.size === 0 ? current : new Set()));
      return;
    }

    // Reconcile rather than reset. This effect re-runs on every `threads`
    // change — which is every streamed token from any running section — and
    // dropping the observer's verdict here made the callout blink off and back
    // on as the observer re-reported a moment later. A mounted row keeps
    // whatever the observer last said about it until the observer says
    // otherwise; only ids that left the attention set are forgotten.
    setOffscreenAttentionIds((current) => {
      const next = new Set<string>();
      for (const id of ids) {
        if (!threadRowRefs.current.has(id) || current.has(id)) {
          next.add(id);
        }
      }
      const unchanged = next.size === current.size && Array.from(current).every((id) => next.has(id));
      return unchanged ? current : next;
    });

    const observed = ids.filter((id) => threadRowRefs.current.has(id));
    if (observed.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setOffscreenAttentionIds((current) => {
          const next = new Set(current);
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.threadId;
            if (!id) continue;
            if (entry.isIntersecting) {
              next.delete(id);
            } else {
              next.add(id);
            }
          }
          return next;
        });
      },
      { root, threshold: 0.6 },
    );
    for (const id of observed) {
      observer.observe(threadRowRefs.current.get(id)!);
    }
    return () => observer.disconnect();
  }, [attentionThreadIds, activeThreadId, expandedWorkspaces, starredCollapsed, collapsedSubthreads, visibleSessionCounts, visibleSubthreadCounts, threads]);

  // A jump from the notification click or the sidebar's off-screen callout
  // asks for a thread whose row may not exist yet (its group was just
  // expanded). Retries on every render this effect's deps touch, until the
  // row mounts and can actually be scrolled to.
  useEffect(() => {
    const id = pendingScrollThreadIdRef.current;
    if (!id || id !== activeThreadId) {
      return;
    }
    const el = threadRowRefs.current.get(id);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      pendingScrollThreadIdRef.current = null;
    }
  }, [activeThreadId, expandedWorkspaces, starredCollapsed, collapsedSubthreads, threads]);

  useEffect(() => {
    const closeFloatingUi = () => {
      setContextMenu(null);
      setWorkspaceMenu(null);
      setShowTokenInfo(false);
      setShowSelector(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeFloatingUi();
        setPendingDeleteThreadId(null);
        setPreviewImage(null);
        setShowSettings(false);
        setQuickStartOpen(false);
        setSearchOpen(false);
        setPromptHistoryOpen(false);
      }
    };

    window.addEventListener("click", closeFloatingUi);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeFloatingUi);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setClockTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(
    () => () => {
      if (usageRefreshTimerRef.current !== undefined) {
        window.clearTimeout(usageRefreshTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    let isMounted = true;
    const refreshUsage = (force = false) => {
      setUsageLoadingProvider(usageProvider);
      void desktopApi
        .loadUsage(usageProvider, force)
        .then((snapshot) => {
          if (isMounted) {
            setUsageByProvider((current) => ({ ...current, [usageProvider]: snapshot }));
          }
        })
        .catch(() => {
          if (isMounted) {
            setUsageByProvider((current) => ({ ...current, [usageProvider]: null }));
          }
        })
        .finally(() => {
          if (isMounted) {
            setUsageLoadingProvider((current) => (current === usageProvider ? null : current));
          }
        });
    };

    refreshUsageRef.current = refreshUsage;
    const onFocus = () => refreshUsage();
    localStorage.setItem(USAGE_PROVIDER_KEY, usageProvider);
    refreshUsage();
    const interval = window.setInterval(onFocus, USAGE_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", onFocus);
    return () => {
      isMounted = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [desktopApi, usageProvider]);

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachmentsByThread;
  }, [imageAttachmentsByThread]);

  useEffect(() => {
    return () => {
      for (const timer of idleTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      idleTimersRef.current.clear();
      for (const timer of finishTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      finishTimersRef.current.clear();
      if (pendingPromptRef.current) {
        window.clearTimeout(pendingPromptRef.current.timeoutId);
        pendingPromptRef.current = null;
      }
      for (const attachments of Object.values(imageAttachmentsRef.current)) {
        for (const attachment of attachments) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
    };
  }, []);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    conversationItemsRef.current = conversationItems;
  }, [conversationItems]);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    if (activeThreadId) {
      transcriptViewedAtRef.current = { ...transcriptViewedAtRef.current, [activeThreadId]: Date.now() };
    }
  }, [activeThreadId]);

  /**
   * Release the transcripts of sections nobody is looking at.
   *
   * Hibernation already drops the transcript of a section whose process was
   * reaped, but that only covers sections that HAD a process. A section you
   * opened to read, or one whose agent exited on its own, kept its full history
   * in this window for as long as the app ran. With hundreds of sections on
   * disk and long ones costing tens of MB of heap apiece, browsing was its own
   * slow leak. Dropped items come back from disk via the reload-on-activate
   * effect above, which merges rather than blanks.
   */
  useEffect(() => {
    const keep = preferences.retainedTranscripts;
    const loadedIds = Object.keys(conversationItems);
    if (keep <= 0 || loadedIds.length <= keep) {
      return;
    }
    const drop = selectTranscriptsToDrop({
      loaded: loadedIds.map((id) => ({
        id,
        viewedAt: transcriptViewedAtRef.current[id] ?? 0,
        running: threadsRef.current.find((thread) => thread.id === id)?.status === "running",
      })),
      activeId: activeThreadId,
      keep,
    });
    if (drop.length === 0) {
      return;
    }
    logRenderer("transcripts:released", { count: drop.length, keep, loaded: loadedIds.length });
    const dropped = new Set(drop);
    setConversationItems((current) => {
      const next: Record<string, ConversationItem[]> = {};
      for (const [id, items] of Object.entries(current)) {
        if (!dropped.has(id)) next[id] = items;
      }
      return next;
    });
    setRevealedTranscriptItems((current) => {
      const next: Record<string, number> = {};
      for (const [id, count] of Object.entries(current)) {
        if (!dropped.has(id)) next[id] = count;
      }
      return next;
    });
    // A released transcript owes the loading surface again the next time it is
    // opened. Without clearing this marker, a previously-loaded empty page can
    // briefly masquerade as the final empty state while its reload starts.
    setConversationLoadState((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
  }, [conversationItems, activeThreadId, preferences.retainedTranscripts]);

  useEffect(() => {
    let isMounted = true;

    void desktopApi.listSessions().then((sessionIds) => {
      if (!isMounted) {
        return;
      }

      const liveSessionIds = new Set(sessionIds);
      setThreads((current) =>
        current.map((thread) => {
          if (liveSessionIds.has(thread.id)) {
            return { ...thread, status: "running", agentState: thread.agentState === "working" ? "working" : "waiting" };
          }

          return thread.status === "running" ? { ...thread, status: "exited", agentState: "exited" } : thread;
        }),
      );
    });

    return () => {
      isMounted = false;
    };
  }, [desktopApi]);

  useEffect(() => {
    setIsRenaming(false);
    setRenameDraft(activeThread?.title ?? "");
  }, [activeThread?.id, activeThread?.title]);

  useLayoutEffect(() => {
    const feed = conversationFeedRef.current;
    if (!feed) {
      return;
    }

    if (lastConversationThreadIdRef.current !== activeThread?.id) {
      lastConversationThreadIdRef.current = activeThread?.id ?? "";
      shouldFollowConversationRef.current = true;
      setShowScrollToBottom(false);
      feed.scrollTo({ top: feed.scrollHeight });
      return;
    }

    if (shouldFollowConversationRef.current) {
      setShowScrollToBottom(false);
      feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
    }
  }, [activeConversation.length, activeThread?.agentState, activeThread?.id]);

  // /prompts can target an item outside the normal render window. Once its
  // window has expanded and React has mounted the card, put it in reading
  // position; keeping the pending id in a ref avoids a transient scroll to the
  // tail between those two renders.
  useLayoutEffect(() => {
    const id = pendingPromptScrollItemIdRef.current;
    const feed = conversationFeedRef.current;
    if (!id || !feed) return;
    const target = feed.querySelector<HTMLElement>(`[data-conversation-item-id="${id}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    pendingPromptScrollItemIdRef.current = null;
  }, [activeThread?.id, windowedConversation]);

  // The /btw panel follows its own tail the same way the main feed does: snap on
  // open or a section switch, then stay pinned while the aside streams unless the
  // user has scrolled up to read something.
  useLayoutEffect(() => {
    const feed = btwFeedRef.current;
    if (!feed) {
      return;
    }

    if (lastBtwThreadIdRef.current !== activeThread?.id) {
      lastBtwThreadIdRef.current = activeThread?.id ?? "";
      shouldFollowBtwRef.current = true;
      feed.scrollTo({ top: feed.scrollHeight });
      return;
    }

    if (shouldFollowBtwRef.current) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
    }
  }, [activeBtw.items, activeBtw.open, activeBtw.running, activeBtw.error, activeThread?.id]);

  useEffect(() => {
    const removeDataListener = desktopApi.onSessionData(({ id, data }) => {
      if (stripAnsi(data).trim()) {
        markRuntimeActivity(id, "pty", "PTY output");
      }
      if (needsAction(data)) {
        logRenderer("session:data-needs-action", { id, hasPendingPrompt: pendingPromptRef.current?.threadId === id });
        clearIdleTimer(id);
        if (isTerminalNeedsAction(data) && applyPendingLaunchRestart(id)) {
          return;
        }
        updateThread(id, { agentState: "needs_action" });
      } else if (isWaitingForInput(data)) {
        logRenderer("session:data-ready", { id, hasPendingPrompt: pendingPromptRef.current?.threadId === id });
        clearIdleTimer(id);
        if (flushPendingPrompt(id)) {
          updateThread(id, { agentState: "working", status: "running" });
        } else {
          clearThinkingItems(id);
          updateThread(id, { agentState: "waiting" });
        }
      } else {
        setThreads((current) =>
          current.map((thread) =>
            thread.id === id && thread.status === "running" && thread.agentState === "working"
              ? { ...thread, lastActiveAt: new Date().toISOString() }
              : thread,
          ),
        );
      }
    });

    const removeExitListener = desktopApi.onSessionExit(({ id, exitCode }) => {
      logRenderer("session:exit", { id, exitCode, hadPendingPrompt: pendingPromptRef.current?.threadId === id });
      markRuntimeActivity(id, "exit", exitCode === 0 ? "Process exited" : "Process errored");
      clearIdleTimer(id);
      clearThinkingItems(id);
      if (pendingPromptRef.current?.threadId === id) {
        window.clearTimeout(pendingPromptRef.current.timeoutId);
        pendingPromptRef.current = null;
        finishSendingPrompt();
      }
      pendingLaunchRestartRef.current.delete(id);
      updateThread(id, { status: exitCode === 0 ? "exited" : "error", agentState: "exited" });
    });

    const removeHibernatedListener = desktopApi.onSessionHibernated(({ id, reason }) => {
      logRenderer("session:hibernated", { id, reason });
      // The section did not end, but its PROCESS did — and `status: "running"`
      // is a claim about the process, not about the section. Hibernation
      // suppresses `session:exit` on purpose, so that a reap never reads as a
      // crash, which leaves this as the ONLY place that claim gets retracted.
      // Without it a reaped section keeps its live dot for the rest of the app's
      // life: ten green dots in the sidebar over four real processes, and no way
      // for the user to tell the reaper is working.
      //
      // "idle" rather than "exited": nothing failed and nothing ended, there is
      // simply no process behind this section until its next prompt resumes one.
      // That is also what makes it safe — an idle section takes the same restart
      // path as one whose agent exited on its own, which already works.
      //
      // Above the active-section guard below, because the reaper does not exempt
      // the section you happen to be looking at: only the transcript drop has to
      // skip it, never the status correction.
      updateThread(id, { status: "idle", agentState: "waiting" });
      if (activeThreadIdRef.current === id) {
        return;
      }
      // Marked before the transcript goes, so opening the section can never see
      // "dropped but not flagged" and render the empty state over a real history.
      droppedTranscriptThreadIdsRef.current.add(id);
      setConversationItems((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
      setRevealedTranscriptItems((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    });

    const removeClaudeSessionListener = desktopApi.onClaudeSession(({ id, claudeSessionId }) => {
      logRenderer("session:claude-session", { id, claudeSessionId });
      setThreads((current) =>
        dedupeThreadsByClaudeSession(
          current.map((thread) => {
            if (thread.id !== id) {
              return thread;
            }

            if (thread.claudeSessionId && thread.claudeSessionId !== claudeSessionId) {
              return thread;
            }

            return { ...thread, claudeSessionId, lastActiveAt: new Date().toISOString() };
          }),
        ),
      );
    });

    const removeSessionTitleListener = desktopApi.onSessionTitle(({ id, title }) => {
      const nextTitle = compactSectionTitle(title);
      if (!nextTitle) return;
      logRenderer("session:title", { id, title: nextTitle });
      setThreads((current) =>
        current.map((thread) =>
          thread.id === id && thread.titleSource !== "manual"
            ? { ...thread, title: nextTitle, titleSource: "auto", lastActiveAt: new Date().toISOString() }
            : thread,
        ),
      );
    });

    const removeConversationListener = desktopApi.onConversation(({ id, claudeSessionId, codexThreadId, items, tokenUsage }) => {
      const thread = threadsRef.current.find((candidate) => candidate.id === id);
      if (thread?.claudeSessionId && claudeSessionId && thread.claudeSessionId !== claudeSessionId) {
        logRenderer("conversation:ignored-wrong-session", {
          id,
          currentClaudeSessionId: thread.claudeSessionId,
          incomingClaudeSessionId: claudeSessionId,
          itemCount: items.length,
        });
        return;
      }
      if (thread?.codexThreadId && codexThreadId && thread.codexThreadId !== codexThreadId) {
        logRenderer("conversation:ignored-wrong-codex-thread", {
          id,
          currentCodexThreadId: thread.codexThreadId,
          incomingCodexThreadId: codexThreadId,
          itemCount: items.length,
        });
        return;
      }

      logRenderer("conversation:received", { id, claudeSessionId, codexThreadId, itemCount: items.length });
      markRuntimeActivity(id, "history", items.length > 0 ? "History updated" : "History checked");
      setConversationItems((current) => ({ ...current, [id]: mergeConversationItems(current[id] ?? [], items) }));
      if (tokenUsage) {
        setTokenUsageByThread((current) => ({ ...current, [id]: tokenUsage }));
        if (tokenUsage.totalTokens > 0) {
          markRuntimeActivity(id, "tokens", "Usage updated");
        }
      }
      const currentThread = threadsRef.current.find((candidate) => candidate.id === id);
      // The stream runtime owns agentState once it has reported: its `result`
      // event is the only reliable end-of-turn signal, and transcript updates
      // keep arriving after it (the assistant reply always counts as
      // post-prompt activity), which used to flip finished sessions back to
      // "working" forever.
      if (
        !streamRuntimeThreadIdsRef.current.has(id) &&
        hasPostPromptActivity(items, lastPromptAtRef.current.get(id) ?? currentThread?.lastPromptAt)
      ) {
        clearIdleTimer(id);
        updateThread(id, { agentState: "working", status: "running" });
      }
    });

    const removeRuntimeListener = desktopApi.onSessionRuntime(({ id, tokenUsage, claudeSessionId, codexThreadId, ...runtimeStatus }) => {
      streamRuntimeThreadIdsRef.current.add(id);
      // A snapshot means a live process again — but NOT that the dropped
      // transcript is back. The stream only carries what happens from here on,
      // so the flag stays set until the reload-on-activate effect has actually
      // merged the history from disk.
      logRenderer("session:runtime", {
        id,
        agentState: runtimeStatus.agentState,
        currentEventType: runtimeStatus.currentEventType,
        latestTool: runtimeStatus.latestTool,
        latestCommand: runtimeStatus.latestCommand,
        claudeSessionId,
        codexThreadId,
      });
      markRuntimeActivity(id, "stream", `Stream ${runtimeStatus.currentEventType}`);
      setRuntimeStatusByThread((current) => ({
        ...current,
        [id]: {
          ...runtimeStatus,
          tokenUsage,
          claudeSessionId,
          codexThreadId,
        },
      }));
      if (tokenUsage) {
        setTokenUsageByThread((current) => ({ ...current, [id]: tokenUsage }));
      }
      // Once resolved, the runtime includes claudeSessionId/codexThreadId in
      // EVERY subsequent snapshot (every streamed token), not just the tick it
      // first appeared on — so without the `thread.claudeSessionId !== ...`
      // guard this re-ran a full-array map + dedupe scan on every token of
      // every running section for the rest of its life.
      if (claudeSessionId) {
        setThreads((current) => {
          const thread = current.find((candidate) => candidate.id === id);
          if (!thread || thread.claudeSessionId === claudeSessionId) return current;
          return dedupeThreadsByClaudeSession(
            current.map((candidate) =>
              candidate.id === id ? { ...candidate, claudeSessionId, lastActiveAt: new Date().toISOString() } : candidate,
            ),
          );
        });
      }
      if (codexThreadId) {
        setThreads((current) => {
          const thread = current.find((candidate) => candidate.id === id);
          if (!thread || thread.codexThreadId === codexThreadId) return current;
          return dedupeThreadsByClaudeSession(
            current.map((candidate) =>
              candidate.id === id ? { ...candidate, codexThreadId, lastActiveAt: new Date().toISOString() } : candidate,
            ),
          );
        });
      }
      clearIdleTimer(id);
      updateThread(id, { agentState: runtimeStatus.agentState, status: runtimeStatus.agentState === "exited" ? "exited" : "running" });
      // Plan usage only moves when a turn runs, so refreshing as sessions go idle
      // keeps the card current without polling the API harder.
      if (runtimeStatus.agentState === "waiting") {
        scheduleUsageRefresh();
      }
      if (
        runtimeStatus.agentState === "waiting" ||
        runtimeStatus.agentState === "exited" ||
        (runtimeStatus.agentState === "needs_action" && /error|failed/i.test(runtimeStatus.currentEventType ?? ""))
      ) {
        applyPendingLaunchRestart(id);
      }
    });

    const removePromptSubmittedListener = desktopApi.onPromptSubmitted(({ id, submittedAt }) => {
      logRenderer("prompt:jsonl-submitted", { id, submittedAt });
      markRuntimeActivity(id, "history", "Prompt accepted");
      lastPromptAtRef.current.set(id, submittedAt);
      updateThread(id, { agentState: "working", lastPromptAt: submittedAt });
      setConversationItems((current) => {
        const thinkingId = `local-thinking:${id}:${submittedAt}`;
        const items = current[id] ?? [];
        if (items.some((item) => item.id === thinkingId) || hasNearbyThinkingItem(items, submittedAt)) {
          return current;
        }

        return {
          ...current,
          [id]: [
            ...items,
            {
              id: thinkingId,
              kind: "assistant",
              title: agentDisplayName(threadsRef.current.find((thread) => thread.id === id)?.runtime),
              body: "Thinking...",
              timestamp: thinkingTimestamp(submittedAt),
            },
          ],
        };
      });
    });

    const removeStartedListener = desktopApi.onSessionStarted(({ request }) => {
      logRenderer("session:started", { id: request.id, cwd: request.cwd, executionMode: request.executionMode });
      // Sessions started from the desktop already have a thread (created before
      // the start call); just make sure it reads as running. A session we've
      // never seen was kicked off remotely (from the phone) — materialize a
      // thread so it appears in the list and receives the live stream events.
      if (threadsRef.current.some((thread) => thread.id === request.id)) {
        updateThread(request.id, { status: "running" });
        return;
      }

      const now = new Date().toISOString();
      const remoteThread: Thread = {
        id: request.id,
        title: "Untitled",
        titleSource: "auto",
        cwd: request.cwd,
        command: request.command,
        runtime: request.runtime ?? "claude",
        model: request.model,
        effort: request.effort,
        permissionMode: request.permissionMode,
        executionMode: request.executionMode,
        claudeSessionId: request.claudeSessionId,
        codexThreadId: request.codexThreadId,
        status: "running",
        // A started process is not a running turn. Hardcoding "working" here
        // claimed a section was busy the moment it spawned, before any prompt
        // existed — and because the runtime's real state (`waiting`) can arrive a
        // few ms BEFORE this thread exists, that update was dropped and the lie
        // stuck: a permanent "Thinking…" over an empty transcript, which the
        // phone then read as busy. Prefer whatever the runtime has already
        // reported; fall back to waiting, never to working.
        agentState: runtimeStatusByThreadRef.current[request.id]?.agentState ?? "waiting",
        createdAt: now,
        lastActiveAt: now,
        // Set when another section (or the phone) opened this one as a
        // sub-thread; the sidebar nests it under that parent from first paint.
        parentId: request.parentId,
      };
      setThreads((current) =>
        current.some((thread) => thread.id === request.id) ? current : [remoteThread, ...current],
      );
      setExpandedWorkspaces((current) => new Set(current).add(remoteThread.cwd));
    });

    const removeStarredListener = desktopApi.onSessionStarred(({ id, starred }) => {
      updateThread(id, { starred });
    });

    // Mirrors a phone's archive/unarchive back into the local view-filter set,
    // the same way removeStarredListener mirrors a star flip into the thread.
    const removeArchivedListener = desktopApi.onSessionArchived(({ id, archived }) => {
      setArchivedThreadIds((current) => {
        const has = current.has(id);
        if (archived === has) return current;
        const next = new Set(current);
        if (archived) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
    });

    // A prompt sent from the phone reaches the session inside the main process,
    // so this window never had the text to draw. Without this the section simply
    // starts working with nothing above it explaining why, until the transcript
    // is re-read from disk. Same optimistic item the local submit path builds.
    const removeRemotePromptListener = desktopApi.onSessionRemotePrompt(({ id, body, timestamp }) => {
      const submittedAt = new Date(timestamp).toISOString();
      const promptItemId = `remote-prompt:${id}:${timestamp}`;
      logRenderer("prompt:remote-received", { threadId: id, promptLength: body.length });
      setConversationItems((current) => {
        const items = current[id] ?? [];
        // The transcript reader will produce its own copy of this turn. Match on
        // the text rather than the id — theirs is derived from the agent's own
        // record — so a reload does not leave the prompt on screen twice.
        if (items.some((item) => item.kind === "user" && item.body === body)) return current;
        return {
          ...current,
          [id]: [
            ...items,
            { id: promptItemId, kind: "user" as const, body, timestamp: submittedAt },
            ...(hasNearbyThinkingItem(items, submittedAt)
              ? []
              : [
                  {
                    id: `remote-thinking:${id}:${timestamp}`,
                    kind: "assistant" as const,
                    title: agentDisplayName(threadsRef.current.find((t) => t.id === id)?.runtime),
                    body: "Thinking...",
                    timestamp: thinkingTimestamp(submittedAt),
                  },
                ]),
          ],
        };
      });
      // /prompts is fed by this index, not by the transcript, so a phone-sent
      // prompt has to be recorded here too or it is missing from the history.
      rememberPrompt(id, {
        id: promptItemId,
        text: promptHistoryText(body),
        attachments: 0,
        timestamp: submittedAt,
        conversationItemId: promptItemId,
      });
      updateThread(id, { agentState: "working", lastPromptAt: submittedAt, status: "running" });
    });

    const removeBtwListener = desktopApi.onBtwData((event) => {
      logRenderer("btw:data", { threadId: event.threadId, status: event.status, itemCount: event.items.length });
      setBtwByThread((current) => {
        const previous = current[event.threadId] ?? EMPTY_BTW;
        return {
          ...current,
          [event.threadId]: {
            open: true,
            items: mergeBtwItems(previous.items, event.items),
            running: event.status === "running",
            error: event.status === "error" ? (event.error ?? "The /btw query failed.") : undefined,
          },
        };
      });
    });

    return () => {
      removeDataListener();
      removeExitListener();
      removeHibernatedListener();
      removeClaudeSessionListener();
      removeSessionTitleListener();
      removeConversationListener();
      removeRuntimeListener();
      removePromptSubmittedListener();
      removeStartedListener();
      removeStarredListener();
      removeArchivedListener();
      removeRemotePromptListener();
      removeBtwListener();
    };
  }, [
    activeThreadId,
    clearIdleTimer,
    clearThinkingItems,
    desktopApi,
    finishSendingPrompt,
    flushPendingPrompt,
    logRenderer,
    markRuntimeActivity,
    applyPendingLaunchRestart,
    scheduleUsageRefresh,
    updateThread,
  ]);

  useEffect(() => {
    // Reload canonical history when an idle section becomes active. The
    // transcript and the live stream share one id scheme, so this MERGES into
    // whatever is already on screen — it must never blank the feed, or
    // just-sent prompts and streamed items would disappear.
    //
    // A hibernated section still reads as "running" (see the reaper: it parks
    // the process without ending the section), but its transcript was dropped
    // on the way out — so it is exactly the case that must re-read from disk,
    // not the case to skip.
    if (
      !activeThread ||
      !shouldReloadTranscript({
        status: activeThread.status,
        transcriptDropped: droppedTranscriptThreadIdsRef.current.has(activeThread.id),
      })
    ) {
      return;
    }

    const runtime = activeThread.runtime ?? "claude";
    if (runtime === "claude" && !activeThread.claudeSessionId) {
      return;
    }
    if (runtime === "codex" && !activeThread.codexThreadId) {
      return;
    }

    let isMounted = true;
    const { id, cwd, claudeSessionId, codexThreadId } = activeThread;
    setConversationLoadState((current) =>
      current[id] === "loading" ? current : { ...current, [id]: "loading" },
    );
    void desktopApi
      .loadConversation({ cwd, claudeSessionId, codexThreadId })
      .then(({ items, tokenUsage, beforeCursor, hasEarlier }) => {
        if (!isMounted) {
          return;
        }
        // Commit the page and loaded flag together. Collapsed work groups do
        // not build their hidden Markdown trees, so this bounded render can be
        // synchronous without leaving a transition vulnerable to starvation.
        droppedTranscriptThreadIdsRef.current.delete(id);
        setConversationItems((current) => ({
          ...current,
          [id]: mergeConversationItems(current[id] ?? [], items),
        }));
        setTokenUsageByThread((current) => ({ ...current, [id]: tokenUsage }));
        setConversationPages((current) => ({
          ...current,
          [id]: { beforeCursor, hasEarlier: hasEarlier === true },
        }));
        setConversationLoadState((current) => ({ ...current, [id]: "loaded" }));
      })
      .catch(() => {
        if (isMounted) {
          setConversationLoadState((current) => ({ ...current, [id]: "error" }));
        }
      });

    return () => {
      isMounted = false;
    };
  }, [
    activeThread?.claudeSessionId,
    activeThread?.codexThreadId,
    activeThread?.cwd,
    activeThread?.id,
    activeThread?.runtime,
    activeThread?.status,
    desktopApi,
  ]);

  const openNewTerminalTab = useCallback(
    (threadId: string): void => {
      const tabs = terminalTabsByThread[threadId] ?? [];
      const tab: TerminalTab = { id: crypto.randomUUID(), title: `Terminal ${tabs.length + 1}` };
      setTerminalTabsByThread((current) => ({ ...current, [threadId]: [...(current[threadId] ?? []), tab] }));
      setActiveTerminalTabByThread((current) => ({ ...current, [threadId]: tab.id }));
      setOpenTerminalThreadIds((current) => new Set(current).add(threadId));
    },
    [terminalTabsByThread],
  );

  const closeTerminalTab = useCallback(
    (threadId: string, tabId: string): void => {
      void desktopApi.stopTerminal({ id: tabId });
      const remaining = (terminalTabsByThread[threadId] ?? []).filter((tab) => tab.id !== tabId);
      setTerminalTabsByThread((current) => ({
        ...current,
        [threadId]: (current[threadId] ?? []).filter((tab) => tab.id !== tabId),
      }));
      setActiveTerminalTabByThread((current) =>
        current[threadId] === tabId ? { ...current, [threadId]: remaining[0]?.id ?? "" } : current,
      );
    },
    [desktopApi, terminalTabsByThread],
  );

  const toggleTerminalPanel = useCallback((): void => {
    const threadId = activeThread?.id;
    if (!threadId) {
      return;
    }

    if ((terminalTabsByThread[threadId] ?? []).length === 0) {
      openNewTerminalTab(threadId);
      return;
    }

    setOpenTerminalThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, [activeThread?.id, openNewTerminalTab, terminalTabsByThread]);

  const openSearch = useCallback((): void => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchOpen(true);
  }, []);

  /**
   * A card's linked section ids, as rows the task view can name and open.
   *
   * Cards outlive sections — a section is deleted, a card that mentions it is
   * not — so a link that no longer resolves comes back marked rather than
   * dropped: "the section that did this is gone" is worth seeing, and the row
   * carries the unlink button that clears it.
   */
  const resolveSections = useCallback(
    (ids: readonly string[]): LinkedSection[] =>
      ids.map((id) => {
        const thread = threadsRef.current.find((candidate) => candidate.id === id);
        return { id, title: thread?.title ?? "Deleted section", present: Boolean(thread) };
      }),
    [],
  );

  /** Jump to a section from a card, closing whatever the card was open over. */
  const openSectionFromTask = useCallback((sectionId: string): void => {
    const thread = threadsRef.current.find((candidate) => candidate.id === sectionId);
    if (!thread) {
      return;
    }
    setTaskView(null);
    setBacklogWorkspace(null);
    setBacklogFocusId(null);
    setBacklogEpicFocusId(null);
    setExpandedWorkspaces((current) => new Set(current).add(thread.cwd));
    setActiveThreadId(sectionId);
  }, []);

  /**
   * Where Cmd+[ and Cmd+] walk: the sections visited, in the order they were
   * visited, the way a browser remembers pages.
   *
   * Jumping somewhere new truncates whatever was ahead — the same rule a
   * browser uses — and the stack is capped so a long day of hopping between
   * sections doesn't grow it without bound.
   */
  const navHistoryRef = useRef<{ stack: string[]; index: number }>({ stack: [activeThreadId], index: 0 });
  // Set while back/forward is what moved the selection, so the effect below
  // records the jump as travel through history rather than a new entry.
  const navigatingRef = useRef(false);

  useEffect(() => {
    const nav = navHistoryRef.current;
    if (navigatingRef.current) {
      navigatingRef.current = false;
      return;
    }
    if (nav.stack[nav.index] === activeThreadId) {
      return;
    }
    const stack = [...nav.stack.slice(0, nav.index + 1), activeThreadId].slice(-50);
    nav.stack = stack;
    nav.index = stack.length - 1;
  }, [activeThreadId]);

  /**
   * Step through the visit history, skipping entries whose section has since
   * been deleted — a closed section shouldn't leave a dead stop in the walk.
   */
  const navigateHistory = useCallback((direction: -1 | 1): void => {
    const nav = navHistoryRef.current;
    for (let index = nav.index + direction; index >= 0 && index < nav.stack.length; index += direction) {
      const id = nav.stack[index];
      if (!id) {
        continue;
      }
      if (id !== DRAFT_THREAD_ID && !threadsRef.current.some((thread) => thread.id === id)) {
        continue;
      }
      nav.index = index;
      navigatingRef.current = true;
      setActiveThreadId(id);
      return;
    }
  }, []);

  const openBacklogForActiveSession = useCallback((): void => {
    // The board is per workspace, and the workspace is whichever one the
    // section on screen runs in — the same board the agent in it writes to.
    setBacklogWorkspace(activeCwdRef.current);
    setBacklogFocusId(null);
    setBacklogEpicFocusId(null);
  }, []);

  /**
   * Push to talk.
   *
   * Held rather than tapped, so a quick aside never leaves the microphone open.
   * Option+Space is deliberately not a Command chord: the app shortcut handler
   * below bails on `altKey`, and macOS has nothing bound to it. It does insert a
   * non-breaking space in a text field, hence the `preventDefault`.
   *
   * `repeat` is the load-bearing guard — holding a key fires keydown at the
   * system repeat rate, and each one would restart the recogniser mid-word.
   */
  /**
   * Is something on screen that Escape means "close" for?
   *
   * Filled in further down, once the side chat's dictation target exists; read
   * through a ref so the shortcut handler below never re-registers.
   */
  const escapeSurfaceOpenRef = useRef(false);

  useEffect(() => {
    if (!dictation.available) return;

    const isPushKey = (event: KeyboardEvent): boolean =>
      event.code === "Space" && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;

    const onKeyDown = (event: KeyboardEvent): void => {
      // Escape throws the recording away. Captured before anything else can act
      // on it so it does not also close a panel behind the composer — while the
      // microphone is open, Escape means "not that".
      //
      // Unless something is open that Escape is obviously for. Opening an image
      // preview mid-sentence and pressing Escape to close it used to leave the
      // preview up and silently wipe the whole dictated message: this handler
      // saw the key first and swallowed it. With a surface up, Escape belongs to
      // the surface and the microphone keeps listening.
      if (event.key === "Escape" && dictation.listening && !escapeSurfaceOpenRef.current) {
        event.preventDefault();
        // Immediate, because the other Escape handlers are on this same target
        // and plain `stopPropagation` would not reach them.
        event.stopImmediatePropagation();
        dictation.discard();
        return;
      }
      if (!isPushKey(event)) return;
      // Suppress the key BEFORE the repeat check, not after. Holding a key
      // fires keydown at the system repeat rate, and letting those through
      // typed a non-breaking space into the composer many times a second —
      // each one an edit that rebased the transcript and restarted the
      // recogniser, so it never lived long enough to return a word. The
      // symptom was "spaces pile up and no text ever appears"; the cause was
      // this one early return.
      event.preventDefault();
      if (event.repeat) return;
      dictation.press();
    };

    // Keyed off the code, not the modifier: releasing Option before Space (the
    // usual way a chord is let go) would otherwise never stop the recording.
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== "Space") return;
      dictation.release();
    };

    // A window that loses focus stops delivering keyup, so the key can be
    // "held" forever with the microphone open.
    const onBlur = (): void => dictation.release();

    // Capture phase: this has to run before the composer's own key handling and
    // before the other Escape listeners further down the file.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [dictation]);

  useEffect(() => {
    const handleAppShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "d" && event.shiftKey) {
        // Hands-free: press once to start, again to stop. The counterpart to
        // holding Option+Space, for dictating something longer than a breath.
        event.preventDefault();
        dictation.toggle();
      } else if (key === "m" && event.shiftKey) {
        // Read the section's last reply at document width. Shifted like the
        // other surfaces, and unshifted Cmd+M stays macOS's minimise.
        event.preventDefault();
        const items = conversationItemsRef.current[activeThreadIdRef.current ?? ""] ?? [];
        const last = [...items]
          .reverse()
          .find((entry) => entry.kind === "assistant" && !isThinkingItem(entry) && entry.body.trim().length > 0);
        if (last) openDocument({ text: last.body, title: last.title ?? "Reply" });
      } else if (key === "b" && !event.shiftKey) {
        // Cmd+B is the sidebar toggle everywhere else (VS Code, Notion, Slack),
        // so it is the sidebar's here too — the backlog moved to the shifted
        // twin, the way the browser sits on Cmd+Shift+J beside the terminal.
        event.preventDefault();
        setSidebarOpen((open) => !open);
      } else if (key === "b" && event.shiftKey) {
        event.preventDefault();
        openBacklogForActiveSession();
      } else if (key === "p" && event.shiftKey) {
        // The keyboard twin of typing `/prompts`: the section's prompt history,
        // shifted like the other surfaces (⌘P stays macOS's print).
        event.preventDefault();
        setPromptHistoryOpen((open) => !open);
      } else if (key === "j" && !event.shiftKey) {
        event.preventDefault();
        toggleTerminalPanel();
      } else if (key === "j" && event.shiftKey) {
        // The browser sits beside the terminal, on the shifted twin of its key:
        // both are "the other thing this section can be working in".
        event.preventDefault();
        toggleBrowserPanelRef.current();
      } else if (key === "g" && event.shiftKey) {
        // Git status for the workspace on screen. Shifted like the other
        // drawers, and unshifted ⌘G stays free for find-next.
        event.preventDefault();
        toggleWorkspaceGitRef.current();
      } else if (key === "," && !event.shiftKey) {
        event.preventDefault();
        setShowSettings(true);
      } else if (key === "[" && !event.shiftKey) {
        event.preventDefault();
        navigateHistory(-1);
      } else if (key === "]" && !event.shiftKey) {
        event.preventDefault();
        navigateHistory(1);
      } else if (key === "f" && !event.shiftKey) {
        event.preventDefault();
        openSearch();
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        addThreadRef.current();
      } else if (!event.shiftKey && key >= "1" && key <= "9") {
        // Cmd/Ctrl+1-9 jumps to the Nth session in sidebar order.
        const target = sidebarOrderedThreadsRef.current[Number(key) - 1];
        if (target) {
          event.preventDefault();
          setActiveThreadId(target.id);
        }
      }
    };

    window.addEventListener("keydown", handleAppShortcut);
    return () => window.removeEventListener("keydown", handleAppShortcut);
  }, [dictation, navigateHistory, openBacklogForActiveSession, openSearch, toggleTerminalPanel]);

  const addThread = (cwd = activeThread?.cwd, launchSettings?: LaunchSettings, parentId?: string): Thread => {
    const runtime = launchSettings?.runtime ?? defaultRuntime;
    const model = launchSettings?.model ?? (runtime === "codex" ? defaultCodexModel : runtime === "groq" ? defaultGroqModel : launchDefaultModel);
    const effort = launchSettings?.effort ?? (runtime === "codex" ? defaultCodexEffort : defaultEffort);
    const permissionMode =
      launchSettings?.permissionMode ?? (runtime === "codex" ? defaultCodexSandbox : defaultPermissionMode);
    const base = createThread(cwd, runtime, commandForRuntime(runtime, defaultCommand));
    const nextThread = {
      ...base,
      model: model.trim() || undefined,
      effort: effort.trim() || undefined,
      permissionMode: permissionMode.trim() || undefined,
      scratch: isScratchCwd(base.cwd) || undefined,
      parentId,
    };
    setThreads((current) => [nextThread, ...current]);
    setActiveThreadId(nextThread.id);
    setExpandedWorkspaces((current) => new Set(current).add(nextThread.cwd));
    setNotice(null);
    return nextThread;
  };

  /**
   * Open a sub-thread of `parent` and select it.
   *
   * The human half of what `create_session` does for an agent: the same
   * relationship, made from the sidebar, inheriting the parent's workspace and
   * launch settings because a sub-thread that runs a different model in a
   * different folder is a sibling wearing the wrong badge.
   */
  const addSubthread = (parent: Thread): void => {
    const check = canAdopt(threads, parent.id, "new-subthread");
    if (!check.ok) {
      setNotice(check.reason);
      return;
    }

    addThread(
      parent.cwd,
      {
        runtime: parent.runtime ?? defaultRuntime,
        model: parent.model ?? "",
        effort: parent.effort ?? "",
        permissionMode: parent.permissionMode ?? "",
      },
      parent.id,
    );
    // A parent whose sub-threads are folded away must not swallow the row that
    // was just created — the selection would move to something invisible.
    setCollapsedSubthreads((current) => {
      if (!current.has(parent.id)) return current;
      const next = new Set(current);
      next.delete(parent.id);
      return next;
    });
  };

  /**
   * Move a section in or out of a parent, and tell the relay so the phone's tree
   * agrees with this one. `parentId: undefined` promotes it to top level.
   */
  const setThreadParent = (id: string, parentId: string | undefined): void => {
    if (parentId) {
      const check = canAdopt(threads, parentId, id);
      if (!check.ok) {
        setNotice(check.reason);
        return;
      }
    }
    setThreads((current) => current.map((thread) => (thread.id === id ? { ...thread, parentId } : thread)));
    void desktopApi.setSessionParent({ id, parentId });
    logRenderer("thread:parent-changed", { id, parentId });
  };

  /**
   * Go to the New Session route, optionally re-pointing it at a workspace or a
   * set of launch settings. This is what "+" and Cmd+N do now: they navigate,
   * they don't create. Nothing is started, persisted or mirrored until the first
   * prompt is sent from there.
   */
  const goToNewSession = (cwd?: string, launchSettings?: LaunchSettings): void => {
    pendingTaskLinksRef.current = null;
    const runtime = launchSettings?.runtime ?? defaultRuntime;
    const model = launchSettings?.model ?? (runtime === "codex" ? defaultCodexModel : runtime === "groq" ? defaultGroqModel : launchDefaultModel);
    const effort = launchSettings?.effort ?? (runtime === "codex" ? defaultCodexEffort : defaultEffort);
    const permissionMode =
      launchSettings?.permissionMode ?? (runtime === "codex" ? defaultCodexSandbox : defaultPermissionMode);
    const targetCwd = cwd ?? activeThread?.cwd ?? DEFAULT_WORKSPACE;
    setThreads((current) =>
      current.map((thread) =>
        thread.draft
          ? {
              ...thread,
              cwd: targetCwd,
              runtime,
              command: commandForRuntime(runtime, defaultCommand),
              model: model.trim() || undefined,
              effort: effort.trim() || undefined,
              permissionMode: permissionMode.trim() || undefined,
              scratch: isScratchCwd(targetCwd) || undefined,
            }
          : thread,
      ),
    );
    setActiveThreadId(DRAFT_THREAD_ID);
    setNotice(null);
  };

  /**
   * The backlog board's "Start session" action: close the board, go to the New
   * Session route for that workspace, and seed the composer with the cards'
   * titles and descriptions — ready to edit and send, nothing sent
   * automatically. Takes a list because the board can hand over a multi-select.
   */
  const createSessionFromBacklogItems = (
    cwd: string,
    items: ReadonlyArray<{ id?: string; title: string; description: string }>,
  ): void => {
    if (items.length === 0) {
      return;
    }
    setBacklogWorkspace(null);
    setBacklogFocusId(null);
    setTaskView(null);
    goToNewSession(cwd);
    // Held until the draft becomes a real section, which is the first moment
    // there is an id to link the cards to. Set after the navigation, which
    // clears it — going to the New Session route any other way means these
    // cards are not what the next section is about.
    pendingTaskLinksRef.current = { cwd, ids: items.map((item) => item.id).filter((id): id is string => Boolean(id)) };
    commitComposerDraft(DRAFT_THREAD_ID, backlogSessionPrompt(items));
    focusComposerSoon();
  };

  /**
   * Turn the draft into a real section: a fresh id, a persisted thread, and the
   * composer state moved across so the send that triggered this lands on the new
   * section. The draft itself stays put with its launch settings (sticky, so the
   * next new session starts from the same choices) and an empty composer.
   *
   * Terminals deliberately do NOT move. They are keyed by thread id, and the
   * draft's id is fixed, so a shell opened on the New Session route stays there
   * across every session created from it — which is what makes that route a
   * usable home for scratch terminals rather than a thing that keeps evaporating.
   */
  const promoteDraftThread = (draft: Thread): Thread => {
    const promoted: Thread = {
      ...draft,
      id: crypto.randomUUID(),
      title: "Untitled",
      titleSource: "auto",
      draft: undefined,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    setThreads((current) => [
      // The draft is reset in place rather than removed: the route must not blink
      // out of existence at the moment you use it. Its launch settings carry over
      // so the next new session starts from the same choices.
      {
        ...createDraftThread(draft.cwd, draft.runtime, draft.command),
        model: draft.model,
        effort: draft.effort,
        permissionMode: draft.permissionMode,
        scratch: draft.scratch,
      },
      promoted,
      ...current.filter((thread) => !thread.draft),
    ]);
    // The composer text and attachments deliberately stay on the draft until the
    // send is known to have landed: they are the only copy, and moving them here
    // would both flash the already-sent text into the new section's composer and
    // lose it outright if the send fails. `clearDraftComposer` /
    // `rollbackDraftPromotion` settle it either way.
    setActiveThreadId(promoted.id);
    setExpandedWorkspaces((current) => new Set(current).add(promoted.cwd));
    // The cards this section was started from now have a section to point at.
    const pendingLinks = pendingTaskLinksRef.current;
    pendingTaskLinksRef.current = null;
    if (pendingLinks && pendingLinks.cwd === promoted.cwd) {
      for (const id of pendingLinks.ids) {
        void desktopApi.mutateBacklog({ op: "link", cwd: promoted.cwd, id, sectionId: promoted.id });
      }
    }
    logRenderer("draft:promoted", { id: promoted.id, cwd: promoted.cwd, runtime: promoted.runtime });
    return promoted;
  };

  /**
   * Undo a promotion whose first prompt never made it out. The half-born section
   * is removed rather than left in the sidebar as another never-run "Untitled",
   * and the route takes the composer (still holding the text) back.
   */
  const rollbackDraftPromotion = (promotedId: string): void => {
    setThreads((current) => current.filter((thread) => thread.id !== promotedId));
    setActiveThreadId(DRAFT_THREAD_ID);
    logRenderer("draft:promotion-rolled-back", { id: promotedId });
  };

  /** Drop the draft's sent text and release its attachment preview URLs. */
  const clearDraftComposer = (): void => {
    commitComposerDraft(DRAFT_THREAD_ID, "");
    setImageAttachmentsByThread((current) => {
      for (const attachment of current[DRAFT_THREAD_ID] ?? []) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      return { ...current, [DRAFT_THREAD_ID]: [] };
    });
  };

  addThreadRef.current = () => goToNewSession();

  const submitQuickStart = async (): Promise<void> => {
    // Close the microphone before the overlay is cleared — see `submitPrompt`.
    await dictation.settle();
    // Read through the ref, not the render-time copy: `settle()` above is where
    // dictation's last words land, and a value captured before that await would
    // send the prompt as it read a moment before the user stopped speaking.
    const prompt = quickStartDraftRef.current.trim();
    const attachments = quickStartAttachments;
    const launchSettings: LaunchSettings = {
      runtime: quickStartRuntime,
      model: quickStartModel,
      effort: quickStartEffort,
      permissionMode: quickStartPermissionMode,
    };
    setQuickStartOpen(false);
    setQuickStartSelectorOpen(false);
    applyQuickStartDraft("");
    setQuickStartAttachments([]);
    // Start in the project chosen in the picker (defaults to the current one).
    const created = addThread(quickStartCwd || DEFAULT_WORKSPACE, launchSettings);
    if (!prompt && attachments.length === 0) {
      return;
    }

    setPromptDraftsByThread((current) => ({ ...current, [created.id]: prompt }));
    if (attachments.length > 0) {
      // Ownership of the preview URLs transfers to the new thread; do not
      // revoke here.
      setImageAttachmentsByThread((current) => ({ ...current, [created.id]: attachments }));
    }
    // The new thread must be active with its draft/images committed before
    // submit; an effect flushes this once the conditions hold.
    pendingQuickSubmitRef.current = created.id;
  };

  // Arrow up/down in the quick-start overlay cycle through the offered
  // projects so a workspace can be picked without reaching for the mouse.
  const cycleQuickStartProject = (direction: 1 | -1): void => {
    if (quickStartProjects.length < 2) {
      return;
    }
    const current = quickStartProjects.indexOf(quickStartCwd);
    const from = current === -1 ? 0 : current;
    const next = (from + direction + quickStartProjects.length) % quickStartProjects.length;
    const target = quickStartProjects[next];
    if (target) {
      setQuickStartCwd(target);
    }
  };

  // Arrow left/right in the quick-start overlay toggle the runtime so the new
  // session can be pointed at the other provider without opening the selector.
  const cycleQuickStartRuntime = (): void => {
    selectQuickStartRuntime(quickStartRuntime === "claude" ? "codex" : "claude");
  };

  const openWorkspaceFolder = async (): Promise<void> => {
    const directory = await desktopApi.selectDirectory();
    if (!directory) {
      return;
    }

    setShowSettings(false);
    setNewSectionChooserOpen(false);
    // Picking a folder chooses where the next session runs; it does not create
    // one. The New Session route takes it from here.
    goToNewSession(directory);
  };

  // Section with no project attached: it runs in the shared scratch workspace,
  // which the main process creates on demand (and at launch).
  const addScratchThread = async (): Promise<void> => {
    const directory = scratchCwd || (await desktopApi.ensureScratchWorkspace());
    if (!directory) {
      setNotice("Could not create the workspace for project-less sections.");
      return;
    }

    if (directory !== scratchCwd) {
      setScratchCwd(directory);
      localStorage.setItem(SCRATCH_WORKSPACE_KEY, directory);
    }

    setShowSettings(false);
    setNewSectionChooserOpen(false);
    // Point the New Session route at the scratch workspace instead of creating a
    // section: like the project choice, this picks *where* the next session will
    // run, and the section itself is created by the first prompt.
    goToNewSession(directory);
    // `isScratchCwd` may still be reading a stale path on the very first run, so
    // the flag is stamped here rather than inferred.
    updateThread(DRAFT_THREAD_ID, { scratch: true });
  };

  const chooseQuickStartFolder = async (): Promise<void> => {
    const directory = await desktopApi.selectDirectory();
    if (directory) {
      setQuickStartCwd(directory);
    }
  };

  const showMoreSessions = (cwd: string, total: number): void => {
    setVisibleSessionCounts((current) => ({
      ...current,
      [cwd]: Math.min((current[cwd] ?? INITIAL_VISIBLE_SESSIONS) + VISIBLE_SESSIONS_STEP, total),
    }));
  };

  const showLessSessions = (cwd: string): void => {
    setVisibleSessionCounts((current) => ({ ...current, [cwd]: INITIAL_VISIBLE_SESSIONS }));
  };

  const toggleArchivedVisible = (cwd: string): void => {
    setShowArchivedByCwd((current) => ({ ...current, [cwd]: !current[cwd] }));
  };

  // useCallback (rather than a plain closure, like their sibling
  // showMore/LessSessions) because these are passed down into the memoized
  // ThreadRow tree — a fresh function identity every App render would defeat
  // that memoization for every row.
  const showMoreSubthreads = useCallback((parentId: string, total: number): void => {
    setVisibleSubthreadCounts((current) => ({
      ...current,
      [parentId]: Math.min((current[parentId] ?? INITIAL_VISIBLE_SESSIONS) + VISIBLE_SESSIONS_STEP, total),
    }));
  }, []);

  const showLessSubthreads = useCallback((parentId: string): void => {
    setVisibleSubthreadCounts((current) => ({ ...current, [parentId]: INITIAL_VISIBLE_SESSIONS }));
  }, []);

  // The sidebar's stop shortcut: same effect as the composer's Stop button, but
  // for any row, not just the active one. The double-click confirmation lives in
  // ThreadRow. Must stay referentially stable — it is a memoized ThreadRow prop.
  const stopThreadSession = useCallback(
    (threadId: string): void => {
      logRenderer("session:stop-request", { id: threadId, from: "sidebar" });
      void desktopApi.stopSession({ id: threadId });
      clearIdleTimer(threadId);
      // A stopped section gets no exit event and no further snapshots, so
      // nothing else would ever retire the optimistic "Thinking..." card.
      clearThinkingItems(threadId);
      if (pendingPromptRef.current?.threadId === threadId) {
        window.clearTimeout(pendingPromptRef.current.timeoutId);
        pendingPromptRef.current = null;
        finishSendingPrompt();
      }
      updateThread(threadId, { agentState: "exited", status: "exited" });
    },
    [clearIdleTimer, clearThinkingItems, finishSendingPrompt, updateThread],
  );

  const requestDeleteThread = (threadId = activeThread?.id): void => {
    // Nothing to delete on the New Session route — walking away from a draft is
    // the delete. Real sections are always deletable now that the permanent draft
    // keeps the list from emptying.
    if (!threadId || threadId === DRAFT_THREAD_ID) {
      return;
    }

    setPendingDeleteThreadId(threadId);
    setContextMenu(null);
  };

  const confirmDeleteThread = (): void => {
    const threadId = pendingDeleteThreadId;
    // The draft is a route, not a section: it can't be deleted, only abandoned
    // (which costs nothing). The old `threads.length === 1` guard existed to stop
    // the list emptying out; the permanent draft now guarantees it never does, so
    // deleting the last real section is allowed and lands on the New route.
    if (!threadId || threadId === DRAFT_THREAD_ID) {
      return;
    }

    void desktopApi.stopSession({ id: threadId });
    clearIdleTimer(threadId);
    for (const tab of terminalTabsByThread[threadId] ?? []) {
      void desktopApi.stopTerminal({ id: tab.id });
    }
    setTerminalTabsByThread((current) => {
      const { [threadId]: removed, ...rest } = current;
      return removed ? rest : current;
    });
    setOpenTerminalThreadIds((current) => {
      if (!current.has(threadId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
    for (const entry of queuedByThread[threadId] ?? []) {
      for (const attachment of entry.attachments) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
    setQueuedByThread((current) => {
      const { [threadId]: removed, ...rest } = current;
      return removed ? rest : current;
    });
    setThreads((current) => {
      // Deleting a parent must not strand its sub-threads. They are promoted to
      // wherever the deleted section sat (its own parent, or the top level)
      // rather than deleted with it: they are separate agent processes with
      // separate transcripts, and taking three of those away silently because
      // one row was removed is not something a delete dialog can honestly imply.
      const removed = current.find((thread) => thread.id === threadId);
      return current
        .filter((thread) => thread.id !== threadId)
        .map((thread) => (thread.parentId === threadId ? { ...thread, parentId: removed?.parentId } : thread));
    });
    for (const child of subthreadsByParent.get(threadId) ?? []) {
      void desktopApi.setSessionParent({ id: child.id, parentId: pendingDeleteThread?.parentId });
    }
    if (activeThreadId === threadId) {
      // Prefer another real section; the New Session route is the floor.
      const fallback = threads.find((thread) => thread.id !== threadId && !thread.draft);
      setActiveThreadId(fallback?.id ?? DRAFT_THREAD_ID);
    }
    setPendingDeleteThreadId(null);
  };

  const beginRename = (threadId = activeThread?.id): void => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      return;
    }

    setActiveThreadId(thread.id);
    setRenameDraft(thread.title);
    setIsRenaming(true);
    setContextMenu(null);
  };

  // View toggle that never touches the session itself (no stop, no delete) —
  // it only hides the row from its workspace group's default view. Mirrored to
  // the relay (see setSessionArchived) so a paired phone's list agrees, the
  // same contract mobile's own ArchiveStore now has.
  const toggleArchiveThread = (threadId = activeThread?.id): void => {
    if (!threadId) {
      return;
    }
    let nextArchived = false;
    setArchivedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
        nextArchived = true;
      }
      return next;
    });
    void desktopApi.setSessionArchived({ id: threadId, archived: nextArchived });
    setContextMenu(null);
  };

  // Bulk version, from the workspace's right-click menu: every non-draft
  // section in this cwd, including sub-threads (so a fully-cleared project
  // stays fully cleared even if a subthread outlives its parent's view).
  // Same relay-mirrored, non-destructive contract as the single-section toggle.
  const archiveAllInWorkspace = (cwd: string): void => {
    const newlyArchivedIds: string[] = [];
    setArchivedThreadIds((current) => {
      const next = new Set(current);
      for (const thread of threads) {
        if (!thread.draft && thread.cwd === cwd && !next.has(thread.id)) {
          next.add(thread.id);
          newlyArchivedIds.push(thread.id);
        }
      }
      return next;
    });
    for (const id of newlyArchivedIds) {
      void desktopApi.setSessionArchived({ id, archived: true });
    }
    setWorkspaceMenu(null);
  };

  const toggleStar = (threadId = activeThread?.id): void => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      return;
    }

    const starred = !thread.starred;
    updateThread(thread.id, { starred });
    void desktopApi.setSessionStarred({ id: thread.id, starred });
    setContextMenu(null);
  };

  const commitRename = (): void => {
    if (!activeThread) {
      return;
    }

    const nextTitle = compactSectionTitle(renameDraft);
    if (nextTitle && nextTitle !== activeThread.title) {
      updateThread(activeThread.id, { title: nextTitle, titleSource: "manual" });
      // The relay row carries the title the phone renders, and nothing else in
      // the rename path talks to the main process.
      void desktopApi.setSessionTitle({ id: activeThread.id, title: nextTitle });
    }
    setIsRenaming(false);
  };

  const cancelRename = (): void => {
    if (!activeThread) {
      return;
    }

    setRenameDraft(activeThread.title);
    setIsRenaming(false);
  };

  const startThreadSession = async (thread: Thread): Promise<boolean> => {
    setNotice(null);
    // A restart queued while the PREVIOUS process was working is obsolete the
    // moment we launch a new one with the current launch flags. Drop it before
    // the spawn, not after: the new process's first `init`/`waiting` snapshot
    // can land before startSession() resolves, and would otherwise trip the
    // pending restart and kill the section milliseconds after it started.
    pendingLaunchRestartRef.current.delete(thread.id);
    const runtime = thread.runtime ?? "claude";
    const command = commandForRuntime(runtime, thread.command);
    let claudeSessionId = thread.claudeSessionId;
    logRenderer("session:start-request", {
      id: thread.id,
      runtime,
      status: thread.status,
      command,
      cwd: thread.cwd,
      claudeSessionId,
      codexThreadId: thread.codexThreadId,
      model: thread.model,
      effort: thread.effort,
      permissionMode: thread.permissionMode,
      executionMode: "stream-json",
    });

    if (runtime === "claude" && claudeSessionId && !hasManualSessionFlag(command)) {
      const sessionExists = await desktopApi.claudeSessionExists({ cwd: thread.cwd, claudeSessionId });
      if (!sessionExists) {
        logRenderer("session:stored-session-missing", { id: thread.id, claudeSessionId });
        claudeSessionId = undefined;
        updateThread(thread.id, { claudeSessionId: undefined });
      }
    }

    const executionMode: ExecutionMode = "stream-json";
    const launchCommand = command;
    const result = await desktopApi.startSession({
      id: thread.id,
      cwd: thread.cwd,
      command: launchCommand,
      runtime,
      model: thread.model,
      effort: thread.effort,
      permissionMode: thread.permissionMode,
      executionMode,
      claudeSessionId,
      codexThreadId: thread.codexThreadId,
      cols: 100,
      rows: 30,
    });

    if (result.ok) {
      logRenderer("session:start-ok", { id: thread.id, launchCommand });
      // A launch only ever happens to carry a prompt (see the sole caller), which
      // already marked the section "working". Reporting "waiting" here dropped the
      // spinner again for the rest of the cold start, so leave the state alone.
      updateThread(thread.id, { command, executionMode, status: "running" });
      return true;
    }

    logRenderer("session:start-failed", { id: thread.id, message: result.message });
    updateThread(thread.id, { agentState: "exited", status: "error" });
    setNotice(result.message);
    return false;
  };

  const applyLaunchSetting = async (patch: Partial<Thread>, description: string): Promise<void> => {
    const thread = activeThread;
    if (!thread) {
      return;
    }

    logRenderer("launch-setting:select", { threadId: thread.id, patch, status: thread.status, agentState: thread.agentState });
    updateThread(thread.id, patch);

    if (thread.status !== "running") {
      return;
    }

    if (thread.agentState === "working") {
      pendingLaunchRestartRef.current.add(thread.id);
      setNotice(`${description}. Panda Code will restart this section when the current run finishes.`);
      return;
    }

    // Restart quietly so the next prompt resumes this session with the new launch flags.
    await desktopApi.stopSession({ id: thread.id });
    clearIdleTimer(thread.id);
    updateThread(thread.id, { ...patch, agentState: "exited", status: "exited" });
    setNotice(`${description}. The next prompt resumes this section with it.`);
  };

  const selectRuntime = async (runtime: AgentRuntime): Promise<void> => {
    const activeRuntime = activeThread?.runtime ?? "claude";
    if (activeRuntime === runtime) {
      return;
    }

    const model = runtime === "codex" ? defaultCodexModel : runtime === "groq" ? defaultGroqModel : launchDefaultModel;
    const effort = runtime === "codex" ? defaultCodexEffort : defaultEffort;
    const permissionMode = runtime === "codex" ? defaultCodexSandbox : defaultPermissionMode;
    const nextCommand = commandForRuntime(runtime);
    const handoffContext = activeThread
      ? runtimeHandoffPrompt(
          { ...activeThread, runtime, handoffFromRuntime: activeRuntime },
          conversationItems[activeThread.id] ?? [],
        )
      : undefined;
    await applyLaunchSetting(
      {
        runtime,
        command: nextCommand,
        model: model.trim() || undefined,
        effort: effort.trim() || undefined,
        permissionMode: permissionMode.trim() || undefined,
        // Keep the previous provider's transcript id for history restore. The
        // main process still starts a fresh thread for the new runtime.
        claudeSessionId: activeThread?.claudeSessionId,
        codexThreadId: activeThread?.codexThreadId,
        handoffFromRuntime: activeRuntime,
        handoffCreatedAt: new Date().toISOString(),
        handoffContext: handoffContext ?? undefined,
      },
      `Runtime set to ${agentDisplayName(runtime)}`,
    );
  };

  const selectModel = async (model: string): Promise<void> => {
    if ((activeThread?.model ?? "") === model) {
      return;
    }

    const runtime = activeThread?.runtime ?? "claude";
    const currentEffort = activeThread?.effort ?? "";
    const nextEffort = effortOptions(runtime, model, codexModels).some((option) => option.value === currentEffort)
      ? currentEffort
      : "";
    const modelChange: SessionModelChange = {
      at: new Date().toISOString(),
      runtime,
      fromModel: activeThread?.model,
      toModel: model || undefined,
    };
    await applyLaunchSetting(
      {
        model: model || undefined,
        effort: nextEffort || undefined,
        modelChanges: [...(activeThread?.modelChanges ?? []), modelChange],
      },
      `Model set to ${modelLabel(runtime, model, codexModels)}`,
    );
  };

  const selectEffort = async (effort: string): Promise<void> => {
    if ((activeThread?.effort ?? "") === effort) {
      return;
    }

    await applyLaunchSetting(
      { effort: effort || undefined },
      `Reasoning set to ${effortLabel(activeThread?.runtime ?? "claude", effort, activeThread?.model ?? "", codexModels)}`,
    );
  };

  const selectPermissionMode = async (permissionMode: string): Promise<void> => {
    if ((activeThread?.permissionMode ?? "") === permissionMode) {
      return;
    }

    await applyLaunchSetting(
      { permissionMode: permissionMode || undefined },
      `${activeThread?.runtime === "codex" ? "Sandbox" : "Permissions"} set to ${permissionLabel(activeThread?.runtime ?? "claude", permissionMode)}`,
    );
  };

  const selectQuickStartRuntime = (runtime: AgentRuntime): void => {
    if (quickStartRuntime === runtime) {
      return;
    }

    setQuickStartRuntime(runtime);
    setQuickStartModel(runtime === "codex" ? defaultCodexModel : runtime === "groq" ? defaultGroqModel : launchDefaultModel);
    setQuickStartEffort(runtime === "codex" ? defaultCodexEffort : defaultEffort);
    setQuickStartPermissionMode(runtime === "codex" ? defaultCodexSandbox : defaultPermissionMode);
  };

  const selectQuickStartModel = (model: string): void => {
    setQuickStartModel(model);
    if (!effortOptions(quickStartRuntime, model, codexModels).some((option) => option.value === quickStartEffort)) {
      setQuickStartEffort("");
    }
  };

  const selectDefaultCodexModel = (model: string): void => {
    setDefaultCodexModel(model);
    if (!effortOptions("codex", model, codexModels).some((option) => option.value === defaultCodexEffort)) {
      setDefaultCodexEffort("");
    }
  };

  const stopSession = async (): Promise<void> => {
    if (!activeThread) {
      return;
    }

    logRenderer("session:stop-request", { id: activeThread.id });
    await desktopApi.stopSession({ id: activeThread.id });
    clearIdleTimer(activeThread.id);
    // A stopped section gets no exit event (Codex app-server sections are simply
    // dropped) and no further snapshots, so nothing else would ever retire the
    // optimistic "Thinking..." card — it sat there under a stopped agent forever.
    clearThinkingItems(activeThread.id);
    if (pendingPromptRef.current?.threadId === activeThread.id) {
      window.clearTimeout(pendingPromptRef.current.timeoutId);
      pendingPromptRef.current = null;
      finishSendingPrompt();
    }
    updateThread(activeThread.id, { agentState: "exited", status: "exited" });
  };

  /**
   * Answer a Codex approval / question. The section goes straight to "working"
   * so the operator isn't left looking at a spent card while the snapshot that
   * confirms it makes its way back.
   */
  const answerApproval = async (
    threadId: string,
    approval: PendingApproval,
    optionId: string | undefined,
    text: string | undefined,
  ): Promise<void> => {
    logRenderer("approval:answer", { threadId, promptId: approval.promptId, optionId, hasText: Boolean(text) });
    updateThread(threadId, { agentState: "working" });
    const result = await desktopApi.answerApproval({ id: threadId, promptId: approval.promptId, optionId, text });
    if (!result.ok) {
      logRenderer("approval:answer-failed", { threadId, promptId: approval.promptId, message: result.message });
      // Put the section back where it was so the card returns with the failure.
      updateThread(threadId, { agentState: "needs_action" });
      setNotice(result.message);
    }
  };

  // Shared builders so the composer and the quick-start overlay attach images
  // the same way.
  const buildFileAttachments = (files: FileList | File[]): ImageAttachment[] =>
    Array.from(files)
      .filter(isImageFile)
      .map<ImageAttachment | null>((file) => {
        const path = desktopApi.getPathForFile(file);
        if (!path) {
          return null;
        }

        return {
          id: String(crypto.randomUUID()),
          name: file.name,
          path,
          previewUrl: URL.createObjectURL(file),
        };
      })
      .filter((attachment): attachment is ImageAttachment => attachment !== null);

  const buildPastedAttachments = async (files: File[]): Promise<ImageAttachment[]> => {
    const attachments: ImageAttachment[] = [];
    for (const file of files.filter(isImageFile)) {
      const directPath = desktopApi.getPathForFile(file);
      if (directPath) {
        attachments.push({
          id: String(crypto.randomUUID()),
          name: file.name || mediaFileName(directPath),
          path: directPath,
          previewUrl: URL.createObjectURL(file),
        });
        continue;
      }

      const result = await desktopApi.savePastedImage({
        name: file.name || "pasted-image.png",
        mimeType: file.type || "image/png",
        data: await file.arrayBuffer(),
      });
      if (!result.ok) {
        setNotice(result.message);
        continue;
      }

      attachments.push({
        id: String(crypto.randomUUID()),
        name: file.name || mediaFileName(result.path),
        path: result.path,
        previewUrl: URL.createObjectURL(file),
      });
    }

    return attachments;
  };

  const mergeAttachments = (current: ImageAttachment[], incoming: ImageAttachment[]): ImageAttachment[] => {
    const existingPaths = new Set(current.map((attachment) => attachment.path));
    const nextAttachments = incoming.filter((attachment) => !existingPaths.has(attachment.path));
    for (const duplicate of incoming.filter((attachment) => existingPaths.has(attachment.path))) {
      URL.revokeObjectURL(duplicate.previewUrl);
    }
    return [...current, ...nextAttachments];
  };

  const addImageAttachments = (attachments: ImageAttachment[]): void => {
    if (attachments.length === 0) {
      setNotice("Drop or paste image files to attach them.");
      return;
    }

    setNotice(null);
    setImageAttachments((current) => mergeAttachments(current, attachments));
    // Dropping a file (or pasting one while the sidebar has focus) leaves the
    // caret nowhere, so put it back in the composer to keep typing.
    focusComposerSoon();
  };

  const addImageFiles = (files: FileList | File[]): void => {
    addImageAttachments(buildFileAttachments(files));
  };

  const addPastedImages = async (files: File[]): Promise<void> => {
    addImageAttachments(await buildPastedAttachments(files));
  };

  const handlePaste = (event: React.ClipboardEvent): void => {
    const files = Array.from(event.clipboardData.files).filter(isImageFile);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void addPastedImages(files);
  };

  const removeImageAttachment = (id: string): void => {
    setImageAttachments((current) => {
      const attachment = current.find((candidate) => candidate.id === id);
      if (attachment) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      return current.filter((candidate) => candidate.id !== id);
    });
  };

  const clearImageAttachments = (): void => {
    setImageAttachments((current) => {
      for (const attachment of current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
  };

  const addQuickStartAttachments = (attachments: ImageAttachment[]): void => {
    if (attachments.length === 0) {
      return;
    }
    setQuickStartAttachments((current) => mergeAttachments(current, attachments));
  };

  const handleQuickStartPaste = (event: React.ClipboardEvent): void => {
    const files = Array.from(event.clipboardData.files).filter(isImageFile);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    void buildPastedAttachments(files).then(addQuickStartAttachments);
  };

  const handleQuickStartDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    addQuickStartAttachments(buildFileAttachments(event.dataTransfer.files));
  };

  const removeQuickStartAttachment = (id: string): void => {
    setQuickStartAttachments((current) => {
      const attachment = current.find((candidate) => candidate.id === id);
      if (attachment) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      return current.filter((candidate) => candidate.id !== id);
    });
  };

  // Core send used by the composer, the quick-start flow, and the queue
  // flush. Independent of which thread is active — it targets `thread`.
  // Mirrors `btwDraftByThread` synchronously, for the same reason
  // `quickStartDraftRef` mirrors the overlay's draft: dictation reads its target
  // back between results within a single tick, and a `useState` map still reads
  // pre-write there — which reads as a manual edit and restarts the recogniser.
  const btwDraftByThreadRef = useRef<Record<string, string>>({});
  const setBtwDraft = useCallback(
    (value: string) => {
      btwDraftByThreadRef.current = { ...btwDraftByThreadRef.current, [activeDraftKey]: value };
      setBtwDraftByThread((current) => ({ ...current, [activeDraftKey]: value }));
    },
    [activeDraftKey],
  );

  // The side chat. Keyed by the section it belongs to, so closing the panel or
  // switching sections releases the target and abandons any live utterance
  // rather than typing it into whatever opens next.
  const btwInputRef = useRef<HTMLTextAreaElement | null>(null);
  const btwDictation = useDictationTarget(
    dictation,
    `btw:${activeDraftKey}`,
    () => btwDraftByThreadRef.current[activeDraftKey] ?? "",
    setBtwDraft,
    () => btwInputRef.current?.focus(),
  );

  // The surfaces that own Escape while they are up, for the dictation shortcut
  // handler declared above. The two that are themselves dictated into are
  // excluded while they hold the microphone: speaking into the quick-start box
  // or the side chat, Escape still means "throw this utterance away".
  escapeSurfaceOpenRef.current =
    Boolean(contextMenu) ||
    Boolean(workspaceMenu) ||
    Boolean(pendingDeleteThreadId) ||
    Boolean(previewImage) ||
    readerOpen ||
    Boolean(backlogWorkspace) ||
    Boolean(taskView) ||
    Boolean(scheduleWorkspace) ||
    Boolean(gitWorkspace) ||
    Boolean(filesThreadId) ||
    showSettings ||
    showSelector ||
    showTokenInfo ||
    searchOpen ||
    promptHistoryOpen ||
    newSectionChooserOpen ||
    machineOpen ||
    isRenaming ||
    (quickStartOpen && !quickStartDictation.recording) ||
    (activeBtw.open && !btwDictation.recording);

  const openBtwPanel = useCallback((threadId: string) => {
    // Reopening always lands at the tail, even if the last visit was scrolled up.
    shouldFollowBtwRef.current = true;
    setBtwByThread((current) => {
      const previous = current[threadId] ?? EMPTY_BTW;
      return { ...current, [threadId]: { ...previous, open: true } };
    });
  }, []);

  const closeBtwPanel = useCallback((threadId: string) => {
    setBtwByThread((current) => {
      const previous = current[threadId] ?? EMPTY_BTW;
      return { ...current, [threadId]: { ...previous, open: false } };
    });
  }, []);

  const clearBtwThread = useCallback(
    (threadId: string) => {
      // Keep the panel open but wipe the aside; the main process drops the forked
      // side-session so the next question re-forks from the latest session state.
      setBtwByThread((current) => ({ ...current, [threadId]: { open: true, items: [], running: false } }));
      void desktopApi.btwClear({ threadId });
      logRenderer("btw:clear", { threadId });
    },
    [desktopApi, logRenderer],
  );

  const askBtw = useCallback(
    async (threadId: string, question: string): Promise<void> => {
      const trimmed = question.trim();
      if (!trimmed) {
        return;
      }
      const thread = threadsRef.current.find((candidate) => candidate.id === threadId);
      if (!thread) {
        return;
      }

      // Asking re-pins the panel to the tail, like sending in the main composer.
      shouldFollowBtwRef.current = true;
      const submittedAt = new Date().toISOString();
      setBtwByThread((current) => {
        const previous = current[threadId] ?? EMPTY_BTW;
        return {
          ...current,
          [threadId]: {
            open: true,
            running: true,
            error: undefined,
            items: [
              ...previous.items,
              { id: `btw-local:${threadId}:${submittedAt}`, kind: "user", body: trimmed, timestamp: submittedAt },
              {
                // `local-thinking:` so ConversationCard renders the spinner line.
                id: `local-thinking:${threadId}:${submittedAt}`,
                kind: "assistant",
                title: agentDisplayName(thread.runtime),
                body: "Thinking...",
                timestamp: thinkingTimestamp(submittedAt),
              },
            ],
          },
        };
      });

      // Seed the aside with the section's live transcript (runtime-agnostic — it
      // spans Claude, Codex, tool calls, and code) rather than forking the Claude
      // session, which went stale after a handoff and tripped auto-compaction.
      const transcript = serializeBtwContext(conversationItemsRef.current[threadId] ?? []);
      const runtime = thread.runtime ?? "claude";
      logRenderer("btw:ask", {
        threadId,
        runtime,
        hasParent: Boolean(thread.claudeSessionId),
        hasCodexThread: Boolean(thread.codexThreadId),
        transcriptChars: transcript.length,
        length: trimmed.length,
      });
      const result = await desktopApi.btwAsk({
        threadId,
        cwd: thread.cwd,
        runtime,
        parentClaudeSessionId: thread.claudeSessionId,
        codexThreadId: thread.codexThreadId,
        transcript,
        question: trimmed,
        model: runtime === "claude" ? BTW_MODEL : thread.model,
        effort: runtime === "codex" ? thread.effort : undefined,
      });
      if (!result.ok) {
        setBtwByThread((current) => {
          const previous = current[threadId] ?? EMPTY_BTW;
          return {
            ...current,
            [threadId]: { ...previous, running: false, error: result.message ?? "Could not run /btw." },
          };
        });
      }
    },
    [desktopApi, logRenderer],
  );

  const submitBtw = useCallback(async (): Promise<void> => {
    if (!activeThread || activeBtw.running) {
      return;
    }
    // Close the microphone before the box is cleared — see `submitPrompt`.
    await dictation.settle();
    // Through the ref: `settle()` above is where dictation's last words land, and
    // the render-time map was captured before that await.
    const question = (btwDraftByThreadRef.current[activeDraftKey] ?? "").trim();
    if (!question) {
      return;
    }
    setBtwDraft("");
    void askBtw(activeThread.id, question);
  }, [activeThread, activeBtw.running, setBtwDraft, activeDraftKey, askBtw, dictation]);

  // Intercepts a `/btw ...` line typed in the main composer so it opens the side
  // chat instead of ever reaching (and steering) the live session. Returns true
  // when it consumed the input.
  const handleBtwCommand = useCallback((): boolean => {
    const trimmed = composerTextRef.current.trim();
    if (!/^\/btw(\s|$)/i.test(trimmed)) {
      return false;
    }

    const thread = activeThread;
    // Consume the command: clear the composer so it never reaches the session.
    clearComposer(thread?.id);
    if (!thread) {
      return true;
    }

    const rest = trimmed.replace(/^\/btw\s*/i, "").trim();
    const keyword = rest.toLowerCase();
    if (keyword === "clear" || keyword === "reset") {
      clearBtwThread(thread.id);
      return true;
    }
    if (keyword === "close" || keyword === "hide") {
      closeBtwPanel(thread.id);
      return true;
    }

    openBtwPanel(thread.id);
    if (rest) {
      void askBtw(thread.id, rest);
    }
    return true;
  }, [activeThread, clearComposer, clearBtwThread, closeBtwPanel, openBtwPanel, askBtw]);

  // Intercept `/prompt` (or `/prompts`) before it reaches the session: open a
  // read-only dialog listing every prompt sent this session plus anything still
  // queued, so the command never lands as a real prompt.
  const handlePromptCommand = useCallback((): boolean => {
    const trimmed = composerTextRef.current.trim();
    if (!/^\/prompts?(\s|$)/i.test(trimmed)) {
      return false;
    }
    clearComposer(activeThread?.id);
    setPromptHistoryOpen(true);
    return true;
  }, [activeThread, clearComposer]);

  // Intercept `/export` before it reaches the session: serialize the section's
  // transcript to Markdown and hand it to the main process to save or copy. The
  // command never lands as a prompt, so exporting mid-turn is safe.
  const handleExportCommand = useCallback((): boolean => {
    const command = parseExportCommand(composerTextRef.current);
    if (!command) {
      return false;
    }

    const thread = activeThread;
    clearComposer(thread?.id);
    if (!thread) {
      return true;
    }

    const items = conversationItemsRef.current[thread.id] ?? [];
    if (items.length === 0) {
      setNotice("Nothing to export yet — this section has no conversation.");
      return true;
    }

    const content = serializeConversation(items, {
      header: {
        title: thread.title,
        cwd: thread.cwd,
        runtime: thread.runtime,
        model: thread.model,
      },
    });

    logRenderer("export:start", { threadId: thread.id, target: command.target, items: items.length });
    void desktopApi
      .exportConversation({
        content,
        target: command.target,
        filename: command.filename,
        defaultFilename: exportFilename(items),
        cwd: thread.cwd,
      })
      .then((result) => {
        if (result.ok) {
          setNotice(
            result.target === "clipboard"
              ? "Conversation copied to clipboard."
              : `Conversation exported to ${result.path}`,
          );
          return;
        }
        if (result.canceled) {
          return;
        }
        setNotice(`Could not export the conversation: ${result.message}`);
      });

    return true;
  }, [activeThread, clearComposer, desktopApi, logRenderer]);

  // Prompt history rows come from the durable per-section index, not just the
  // visible transcript. A short fallback keeps the dialog useful while an
  // older transcript is being imported for the first time.
  const promptHistorySent = useMemo<PromptHistoryRecord[]>(() => {
    if (!promptHistoryOpen || !activeThread) {
      return [];
    }
    const saved = activeThread.promptHistory ?? [];
    const known = new Set(saved.map((entry) => promptHistorySignature(entry.text, entry.timestamp)));
    const legacy = (conversationItems[activeThread.id] ?? [])
      .filter((item) => item.kind === "user" && item.body.trim().length > 0)
      .map((item) => {
        const images = attachedImagePathsFromBody(item.body);
        return {
          id: item.id,
          text: promptHistoryText(item.body),
          attachments: images.length,
          timestamp: item.timestamp,
          queued: false,
          conversationItemId: item.id,
        };
      })
      .filter((record) => {
        const signature = promptHistorySignature(record.text, record.timestamp);
        if (known.has(signature)) return false;
        known.add(signature);
        return true;
      });
    return [...saved.map((entry) => ({ ...entry, queued: false })), ...legacy]
      .sort((first, second) => (second.timestamp ?? "").localeCompare(first.timestamp ?? ""));
  }, [promptHistoryOpen, activeThread, conversationItems]);

  const promptHistoryQueued = useMemo<PromptHistoryRecord[]>(() => {
    if (!promptHistoryOpen || !activeThread) {
      return [];
    }
    return (queuedByThread[activeThread.id] ?? []).map((entry) => ({
      id: entry.id,
      text: entry.text,
      attachments: entry.attachments.length,
      queued: true,
    }));
  }, [promptHistoryOpen, activeThread, queuedByThread]);

  // "Reuse" drops a past prompt back into the composer, ready to edit and send.
  const reuseComposerText = useCallback((text: string) => {
    setPromptHistoryOpen(false);
    composerFieldRef.current?.setText(text);
    if (activeThread) {
      commitComposerDraft(activeThread.id, text);
    }
  }, [activeThread, commitComposerDraft]);

  const goToPrompt = useCallback((record: PromptHistoryRecord): void => {
    if (!activeThread) return;
    const items = conversationItems[activeThread.id] ?? [];
    const target = items.find((item) =>
      item.kind === "user" &&
      (item.id === record.conversationItemId || promptHistorySignature(promptHistoryText(item.body), item.timestamp) === promptHistorySignature(record.text, record.timestamp)),
    );
    setPromptHistoryOpen(false);
    if (!target) {
      setNotice("This prompt is safely saved, but its transcript message is no longer available to jump to.");
      return;
    }
    const targetIndex = items.indexOf(target);
    const effectiveWindow = transcriptWindowSize > 0 ? transcriptWindowSize : items.length;
    const requiredReveal = Math.max(0, items.length - effectiveWindow - targetIndex);
    setRevealedTranscriptItems((current) => ({
      ...current,
      [activeThread.id]: Math.max(current[activeThread.id] ?? 0, requiredReveal),
    }));
    pendingPromptScrollItemIdRef.current = target.id;
  }, [activeThread, conversationItems, transcriptWindowSize]);

  const sendPromptToThread = async (thread: Thread, prompt: string, attachedImagePaths: string[]): Promise<boolean> => {
    if (sendingPromptRef.current) {
      logRenderer("prompt:submit-blocked", { threadId: thread.id, sendingRef: sendingPromptRef.current });
      return false;
    }

    const trimmed = prompt.trim();
    if (!trimmed && attachedImagePaths.length === 0) {
      return false;
    }

    sendingPromptRef.current = true;
    setIsSendingPrompt(true);
    const submittedAt = new Date().toISOString();
    const promptItemId = `local:${thread.id}:${submittedAt}`;
    lastPromptAtRef.current.set(thread.id, submittedAt);
    markRuntimeActivity(thread.id, "prompt", "Prompt sent");
    const userPromptToDisplay = buildPromptWithImageAttachments(trimmed, attachedImagePaths);
    const selectedRuntime = thread.runtime ?? "claude";
    const hasPendingRuntimeHandoff =
      thread.status === "running" && Boolean(thread.handoffFromRuntime && thread.handoffFromRuntime !== selectedRuntime);
    let launchThread = thread;
    let wasRunning = thread.status === "running";
    if (hasPendingRuntimeHandoff) {
      logRenderer("prompt:forcing-runtime-handoff", {
        threadId: thread.id,
        from: thread.handoffFromRuntime,
        to: selectedRuntime,
      });
      pendingLaunchRestartRef.current.delete(thread.id);
      await desktopApi.stopSession({ id: thread.id });
      clearIdleTimer(thread.id);
      clearThinkingItems(thread.id);
      launchThread = { ...thread, status: "exited", agentState: "exited" };
      updateThread(thread.id, { status: "exited", agentState: "exited" });
      wasRunning = false;
    }
    const runtimeHandoff = !wasRunning ? thread.handoffContext : undefined;
    const promptToSend = runtimeHandoff ? `${runtimeHandoff}\n\n${userPromptToDisplay}` : userPromptToDisplay;
    const isSteering = wasRunning && thread.agentState === "working";
    logRenderer("prompt:submit", {
      threadId: thread.id,
      wasRunning,
      status: thread.status,
      promptLength: promptToSend.length,
      handoffLength: runtimeHandoff?.length ?? 0,
      imageCount: attachedImagePaths.length,
    });
    // Show the spinner before the launch, not after it: spawning the CLI (and
    // probing for a resumable session first) takes seconds on a cold section,
    // and the user has already pressed enter. `startThreadSession` reports its
    // own failure as "exited", so an optimistic "working" can't get stuck.
    updateThread(thread.id, { agentState: "working", lastPromptAt: submittedAt });
    const isReady = wasRunning || (await startThreadSession(launchThread));
    if (!isReady) {
      logRenderer("prompt:start-before-send-failed", { threadId: thread.id });
      sendingPromptRef.current = false;
      setIsSendingPrompt(false);
      return false;
    }

    // Keep the user's exact prompt in the section metadata before the
    // transcript changes. The transcript is intentionally disposable; this
    // compact index is what makes /prompts reliable after it is cleared.
    rememberPrompt(thread.id, {
      id: promptItemId,
      text: promptHistoryText(userPromptToDisplay),
      attachments: attachedImagePaths.length,
      timestamp: submittedAt,
      conversationItemId: promptItemId,
    });

    setConversationItems((current) => ({
      ...current,
      [thread.id]: [
        ...(current[thread.id] ?? []),
        ...(isSteering
          ? [
              {
                id: `local-steer:${thread.id}:${submittedAt}`,
                kind: "marker" as const,
                title: "Steering sent",
                body: `Waiting for ${agentDisplayName(selectedRuntime)} to receive the follow-up.`,
                timestamp: submittedAt,
              },
            ]
          : []),
        {
          id: promptItemId,
          kind: "user",
          body: promptToSend,
          timestamp: submittedAt,
        },
        {
          id: `local-thinking:${thread.id}:${submittedAt}`,
          kind: "assistant",
          title: agentDisplayName(selectedRuntime),
          body: "Thinking...",
          timestamp: thinkingTimestamp(submittedAt),
        },
      ],
    }));
    updateThread(thread.id, {
      agentState: "working",
      handoffContext: undefined,
      handoffCreatedAt: undefined,
      handoffFromRuntime: undefined,
      lastPromptAt: submittedAt,
      status: "running",
    });
    logRenderer("prompt:send-immediate", { threadId: thread.id, promptLength: promptToSend.length });
    // `data` keeps the readable "Attached image files:" list (thumbnails and the
    // transcript dedupe both key off it); `imagePaths` is what the app-server
    // turns into real `localImage` inputs so the model actually sees the picture.
    void desktopApi.sendInput({ id: thread.id, data: promptToSend, imagePaths: attachedImagePaths }).then((result) => {
      if (!result.ok) {
        handleDroppedInput(thread.id, result.message);
      }
    });
    finishSendingPrompt();
    return true;
  };

  sendPromptRef.current = sendPromptToThread;

  const submitPrompt = async (): Promise<void> => {
    const thread = activeThread;
    if (!thread) {
      return;
    }

    // Close the microphone before the composer is read, and wait for the last
    // words. Sending out from under a live recogniser clears the field while a
    // task is still running, and its next partial — which carries the whole
    // utterance, not just the new words — writes all of it straight back in.
    await dictation.settle();

    if (handleBtwCommand()) {
      return;
    }
    if (handlePromptCommand()) {
      return;
    }
    if (handleExportCommand()) {
      return;
    }

    const prompt = composerTextRef.current.trim();
    const attachments = imageAttachments;
    if (!prompt && attachments.length === 0) {
      return;
    }

    // Sending from the New Session route is the moment the section becomes real:
    // promote the draft, then send to the section that came out of it. A send that
    // fails takes the promotion back with it, so a failed first prompt leaves no
    // orphan section behind — just the draft, text intact, ready to retry.
    const fromDraft = Boolean(thread.draft);
    const target = fromDraft ? promoteDraftThread(thread) : thread;
    const ok = await sendPromptToThread(
      target,
      prompt,
      attachments.map((attachment) => attachment.path),
    );
    if (!ok) {
      if (fromDraft) {
        rollbackDraftPromotion(target.id);
      }
      return;
    }

    clearComposer(target.id);
    clearImageAttachments();
    if (fromDraft) {
      clearDraftComposer();
    }
  };

  // Hold a message until the section's current turn genuinely finishes, then
  // it is flushed by the settle handler. Ownership of the attachment preview
  // URLs transfers to the queue item.
  const queuePrompt = async (): Promise<void> => {
    const thread = activeThread;
    if (!thread) {
      return;
    }
    // Same reason as `submitPrompt`: queueing clears the composer, and doing
    // that under a live recogniser lets its next partial — which carries the
    // whole utterance — write everything straight back in.
    await dictation.settle();
    // There is nothing to queue behind on the New Session route — no turn is in
    // flight because no session exists yet. Send instead of stashing a message
    // that would wait for a settle event that can never arrive.
    if (thread.draft) {
      void submitPrompt();
      return;
    }
    // A /btw line must open the side chat even via the Queue button, never get
    // queued as a real prompt for the live session.
    if (handleBtwCommand()) {
      return;
    }
    if (handlePromptCommand()) {
      return;
    }
    if (handleExportCommand()) {
      return;
    }
    const text = composerTextRef.current.trim();
    const attachments = imageAttachments;
    if (!text && attachments.length === 0) {
      return;
    }

    setQueuedByThread((current) => ({
      ...current,
      [thread.id]: [...(current[thread.id] ?? []), { id: crypto.randomUUID(), text, attachments }],
    }));
    clearComposer(thread.id);
    setImageAttachmentsByThread((current) => ({ ...current, [thread.id]: [] }));
  };

  // Send a specific queued message immediately instead of waiting for the turn
  // to settle — this steers the live turn (sendPromptToThread marks it as
  // steering when the thread is still working). Mirror the settle flush: only
  // drop it from the queue once the send actually goes through.
  const sendQueuedNow = (threadId: string, queuedId: string): void => {
    const thread = threadsRef.current.find((candidate) => candidate.id === threadId);
    const entry = (queuedByThread[threadId] ?? []).find((item) => item.id === queuedId);
    if (!thread || !entry) {
      return;
    }
    logRenderer("queue:send-now", { threadId, queuedId, working: thread.agentState === "working" });
    void sendPromptToThread(
      thread,
      entry.text,
      entry.attachments.map((attachment) => attachment.path),
    ).then((ok) => {
      if (!ok) {
        return;
      }
      setQueuedByThread((current) => ({
        ...current,
        [threadId]: (current[threadId] ?? []).filter((item) => item.id !== queuedId),
      }));
      for (const attachment of entry.attachments) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    });
  };

  const removeQueuedPrompt = (threadId: string, queuedId: string): void => {
    setQueuedByThread((current) => {
      const queue = current[threadId] ?? [];
      const removed = queue.find((entry) => entry.id === queuedId);
      if (removed) {
        for (const attachment of removed.attachments) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
      return { ...current, [threadId]: queue.filter((entry) => entry.id !== queuedId) };
    });
  };

  submitPromptRef.current = () => void submitPrompt();
  composerPasteRef.current = handlePaste;
  composerEnterRef.current = (modifiers) => {
    const thread = activeThread;
    if (!thread) {
      return;
    }
    if (handleBtwCommand()) {
      // A /btw line opens the side chat instead of touching the live session.
      return;
    }
    if (handlePromptCommand()) {
      // A /prompt line opens the prompt-history dialog, never the session.
      return;
    }
    if (handleExportCommand()) {
      // An /export line saves or copies the transcript, never the session.
      return;
    }
    const text = composerTextRef.current;
    if (modifiers.meta) {
      // Cmd/Ctrl+Enter sends now (steers). With nothing typed, fire off the
      // last queued message instead — quick steer without retyping.
      const queue = queuedByThread[thread.id] ?? EMPTY_QUEUED;
      if (!text.trim() && imageAttachments.length === 0 && queue.length > 0) {
        const last = queue[queue.length - 1];
        if (last) {
          sendQueuedNow(thread.id, last.id);
        }
      } else {
        void submitPrompt();
      }
    } else if (threadWorking && (text.trim() || imageAttachments.length > 0)) {
      // Plain Enter queues while Claude is working.
      void queuePrompt();
    } else {
      void submitPrompt();
    }
  };

  const onComposerEnter = useCallback((modifiers: { meta: boolean }) => composerEnterRef.current(modifiers), []);
  const onComposerPaste = useCallback((event: React.ClipboardEvent) => composerPasteRef.current(event), []);

  useEffect(() => {
    // Flush a quick-start prompt once its freshly-created thread is active and
    // its draft has committed to state.
    const pendingId = pendingQuickSubmitRef.current;
    if (!pendingId || pendingId !== activeThread?.id) {
      return;
    }
    const hasDraft = (promptDraftsByThread[pendingId] ?? "").trim().length > 0;
    const hasImages = (imageAttachmentsByThread[pendingId] ?? []).length > 0;
    if (hasDraft || hasImages) {
      pendingQuickSubmitRef.current = null;
      submitPromptRef.current();
    }
  }, [activeThread?.id, promptDraftsByThread, imageAttachmentsByThread]);

  const toggleConversationItem = useCallback((itemId: string): void => {
    setExpandedConversationItems((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const handlePreviewImage = useCallback((path: string): void => {
    setPreviewImage({ path, url: localFileUrl(path), kind: "image" });
  }, []);

  const handlePreviewStagedAttachment = useCallback((attachment: ImageAttachment): void => {
    setPreviewImage({ path: attachment.path, url: attachment.previewUrl, kind: "image" });
  }, []);

  // A thumbnail an agent wrote into its own message (`inline.tsx`) is too deep
  // in the render tree to be handed a callback, so it asks for the viewer the
  // same way a `panda://backlog/` link asks for a card: a window event.
  useEffect(() => {
    const onPreviewRequest = (event: Event): void => {
      const request = (event as CustomEvent<MediaPreviewRequest>).detail;
      if (!request?.path) {
        return;
      }
      setPreviewImage({ path: request.path, url: localFileUrl(request.path), kind: request.kind });
    };
    window.addEventListener(OPEN_MEDIA_PREVIEW_EVENT, onPreviewRequest);
    return () => window.removeEventListener(OPEN_MEDIA_PREVIEW_EVENT, onPreviewRequest);
  }, []);

  // Same mechanism for the document reader: a Markdown link an agent wrote into
  // its own message is as far from the root as a thumbnail is.
  useEffect(() => {
    const onDocumentRequest = (event: Event): void => {
      const request = (event as CustomEvent<DocumentRequest>).detail;
      if (request && (("path" in request && request.path) || ("text" in request && typeof request.text === "string"))) {
        pushReaderDoc(request);
      }
    };
    window.addEventListener(OPEN_DOCUMENT_EVENT, onDocumentRequest);
    return () => window.removeEventListener(OPEN_DOCUMENT_EVENT, onDocumentRequest);
  }, [pushReaderDoc]);

  const threadWorking = Boolean(activeThread && activeThread.status === "running" && activeThread.agentState === "working");
  // Nothing to send — which is what decides whether the composer's button is a
  // microphone or a send arrow.
  const composerEmpty = !composerHasText && imageAttachments.length === 0;

  // Memoized so typing in the composer (which re-renders App on every
  // keystroke) does not rebuild the whole feed or re-parse every message's
  // markdown. Mid-turn flags are computed in one backward pass instead of the
  // O(n²) per-item scan.
  /**
   * The feed's structure: what nests under which agent card, how quiet work
   * groups in focus mode, and which assistant replies read as mid-turn.
   *
   * Deliberately independent of `threadWorking`. That flag flips at both ends of
   * every turn, and it used to sit in the dependency list of the single memo
   * that built the entire element tree — so a section with thousands of items
   * rebuilt and re-reconciled all of them twice per turn, which is most of why a
   * long section became slow to type into. It genuinely affects only the tail
   * (one assistant reply, and the running spinner on the last work group), so
   * the tail is rendered outside the memo and everything above it survives.
   */
  const conversationLayout = useMemo(() => {
    // Items a subagent produced are nested under their agent card, not shown at
    // the top level. Collect them by the owning agent's tool_use id (their
    // parentAgentId); an orphan whose agent card never arrived falls back to the
    // top level so nothing silently disappears.
    const agentToolUseIds = new Set<string>();
    for (const item of windowedConversation) {
      if (item.kind === "agent" && item.agent) {
        agentToolUseIds.add(item.agent.toolUseId);
      }
    }
    const childrenByAgent = new Map<string, ConversationItem[]>();
    const topLevel: ConversationItem[] = [];
    for (const item of windowedConversation) {
      const parent = item.parentAgentId;
      if (parent && agentToolUseIds.has(parent)) {
        const bucket = childrenByAgent.get(parent);
        if (bucket) bucket.push(item);
        else childrenByAgent.set(parent, [item]);
      } else {
        topLevel.push(item);
      }
    }

    const midTurnById = new Map<string, boolean>();
    // The one assistant reply whose mid-turn reading is "is the section working
    // right now". Held out of the map rather than baked into it, so the map and
    // every element built from it survive a turn starting or ending.
    let liveMidTurnItemId: string | null = null;
    let laterMeaningfulKind: ConversationItem["kind"] | null = null;
    for (let index = topLevel.length - 1; index >= 0; index--) {
      const item = topLevel[index];
      if (!item) {
        continue;
      }
      const thinking = isThinkingItem(item);
      if (item.kind === "assistant" && !thinking) {
        if (laterMeaningfulKind === null) liveMidTurnItemId = item.id;
        else midTurnById.set(item.id, laterMeaningfulKind !== "user");
      }
      // The turn-summary footer is a caption, not turn activity: it must not
      // flip the assistant reply it trails into a mid-turn passage.
      if (item.kind !== "marker" && !thinking && !isTurnSummaryItem(item)) {
        laterMeaningfulKind = item.kind;
      }
    }

    // Focus mode: keep the conversation itself — prompts, replies, the final
    // answer — and fold every run of work between them into one line.
    const entries = focusMode ? groupQuietWork(topLevel, isQuietFeedItem) : null;
    return { topLevel, childrenByAgent, midTurnById, liveMidTurnItemId, entries };
  }, [windowedConversation, focusMode]);

  /** First entry that has to re-render when the section starts or stops working. */
  const conversationTailStart = useMemo(() => {
    const { topLevel, entries, liveMidTurnItemId } = conversationLayout;
    if (!entries) {
      if (!liveMidTurnItemId) return topLevel.length;
      const index = topLevel.findIndex((item) => item.id === liveMidTurnItemId);
      return index === -1 ? topLevel.length : index;
    }
    // The final group carries the running spinner, so it is always in the tail.
    let start = Math.max(0, entries.length - 1);
    if (liveMidTurnItemId) {
      const index = entries.findIndex((entry) =>
        entry.type === "item"
          ? entry.item.id === liveMidTurnItemId
          : entry.items.some((item) => item.id === liveMidTurnItemId),
      );
      if (index !== -1) start = Math.min(start, index);
    }
    return start;
  }, [conversationLayout]);

  const renderConversationItem = (item: ConversationItem, working: boolean): React.ReactElement => {
    const { childrenByAgent, midTurnById, liveMidTurnItemId } = conversationLayout;
    if (item.kind === "agent" && item.agent) {
      // Agent cards default to collapsed, same as any other work item — a
      // long-running subagent's transcript would otherwise flood the main
      // narrative. The header shows a quick summary line so a collapsed card
      // still says what it's doing.
      return (
        <AgentCard
          childItems={childrenByAgent.get(item.agent.toolUseId) ?? []}
          expanded={expandedConversationItems.has(item.id)}
          expandedChildIds={expandedConversationItems}
          item={item}
          key={item.id}
          killDisabled={findCommandPid(item) === undefined}
          onKill={killAgentCommand}
          onPreviewImage={handlePreviewImage}
          onToggle={toggleConversationItem}
          onToggleChild={toggleConversationItem}
        />
      );
    }
    const collapsedByDefault = isCollapsedByDefaultConversationItem(item);
    return (
      <ConversationCard
        expanded={!collapsedByDefault || expandedConversationItems.has(item.id)}
        item={item}
        key={item.id}
        midTurn={item.id === liveMidTurnItemId ? working : (midTurnById.get(item.id) ?? false)}
        onPreviewImage={handlePreviewImage}
        onToggle={toggleConversationItem}
      />
    );
  };

  const renderConversationEntry = (
    entry: FocusedFeedEntry,
    working: boolean,
    isLast: boolean,
  ): React.ReactElement => {
    if (entry.type === "item") {
      return renderConversationItem(entry.item, working);
    }
    return (
      <WorkGroup
        expanded={expandedConversationItems.has(entry.id)}
        id={entry.id}
        items={entry.items}
        key={entry.id}
        onToggle={toggleConversationItem}
        running={working && isLast}
      >
        {expandedConversationItems.has(entry.id)
          ? entry.items.map((item) => renderConversationItem(item, working))
          : null}
      </WorkGroup>
    );
  };

  // Everything above the tail — the expensive part, and the part a turn boundary
  // no longer touches.
  const conversationHead = useMemo(() => {
    const { topLevel, entries } = conversationLayout;
    if (!entries) {
      return topLevel.slice(0, conversationTailStart).map((item) => renderConversationItem(item, false));
    }
    return entries.slice(0, conversationTailStart).map((entry) => renderConversationEntry(entry, false, false));
    // renderConversationItem/Entry close over exactly these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationLayout, conversationTailStart, expandedConversationItems, handlePreviewImage, toggleConversationItem]);

  const conversationTail = (() => {
    const { topLevel, entries } = conversationLayout;
    if (!entries) {
      return topLevel.slice(conversationTailStart).map((item) => renderConversationItem(item, threadWorking));
    }
    return entries
      .slice(conversationTailStart)
      .map((entry, offset) =>
        renderConversationEntry(entry, threadWorking, conversationTailStart + offset === entries.length - 1),
      );
  })();

  const conversationFeed = (
    <>
      {hiddenTranscriptCount > 0 || (activeThread && conversationPages[activeThread.id]?.hasEarlier) ? (
        <button className="quiet-action conversation-show-earlier" type="button" onClick={showEarlierTranscript}>
          {hiddenTranscriptCount > 0
            ? `Show ${Math.min(hiddenTranscriptCount, transcriptWindowSize || hiddenTranscriptCount).toLocaleString()} earlier${
                hiddenTranscriptCount > (transcriptWindowSize || hiddenTranscriptCount)
                  ? ` of ${hiddenTranscriptCount.toLocaleString()}`
                  : ""
              } items`
            : conversationPages[activeThread!.id]?.loading
              ? "Loading earlier history…"
              : "Load earlier history"}
        </button>
      ) : null}
      {conversationHead}
      {conversationTail}
    </>
  );

  const scrollConversationToBottom = (): void => {
    const feed = conversationFeedRef.current;
    if (!feed) {
      return;
    }

    shouldFollowConversationRef.current = true;
    setShowScrollToBottom(false);
    feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  };

  const toggleWorkspace = (cwd: string): void => {
    setExpandedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(cwd)) {
        next.delete(cwd);
      } else {
        next.add(cwd);
      }
      return next;
    });
  };

  const fetchWorkspaceGit = useCallback(
    async (cwd: string): Promise<void> => {
      setGitLoading(true);
      try {
        const status = await desktopApi.loadWorkspaceGit({ cwd });
        setGitStatus(status);
      } catch {
        setGitStatus({
          isRepo: false,
          remotes: [],
          changes: [],
          stashes: [],
          worktrees: [],
          branches: [],
          folders: [],
          error: "Failed to read git status",
        });
      } finally {
        setGitLoading(false);
      }
    },
    [desktopApi],
  );

  // A fetch is what makes "in sync?" trustworthy — the counts are all measured
  // against remote-tracking refs, which only move when we talk to the remote.
  const fetchGitRemotes = useCallback(
    async (cwd: string): Promise<void> => {
      setGitFetching(true);
      try {
        setGitStatus(await desktopApi.fetchWorkspaceGitRemotes({ cwd }));
      } catch {
        // Offline or auth-prompting remote: keep the last known status on screen.
      } finally {
        setGitFetching(false);
      }
    },
    [desktopApi],
  );

  const openWorkspaceGit = useCallback(
    (cwd: string): void => {
      setGitWorkspace(cwd);
      setGitStatus(null);
      setGitTab("status");
      void fetchWorkspaceGit(cwd);
    },
    [fetchWorkspaceGit],
  );

  const closeWorkspaceGit = useCallback((): void => {
    setGitWorkspace(null);
    setGitStatus(null);
  }, []);

  /**
   * ⌘⇧G: the git drawer for the workspace the section on screen runs in.
   *
   * Pressing it again closes the drawer, and pressing it while another
   * workspace's drawer is open re-points it at this one rather than closing —
   * the same key always means "git for what I am looking at". A scratch section
   * has no repo to report on, so the chord is a no-op there, matching the
   * sidebar, which hides the button for those groups.
   */
  const toggleWorkspaceGit = useCallback((): void => {
    const cwd = activeCwdRef.current;
    if (isScratchCwd(cwd)) return;
    if (gitWorkspace === cwd) {
      closeWorkspaceGit();
      return;
    }
    openWorkspaceGit(cwd);
  }, [closeWorkspaceGit, gitWorkspace, isScratchCwd, openWorkspaceGit]);

  // Declared after the shortcut handler that fires it, so it goes through a ref.
  const toggleWorkspaceGitRef = useRef(toggleWorkspaceGit);
  toggleWorkspaceGitRef.current = toggleWorkspaceGit;

  useEffect(() => {
    if (!gitWorkspace) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeWorkspaceGit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gitWorkspace, closeWorkspaceGit]);

  // A running plain-command card's kill button needs a live pid to act on,
  // so the probe must poll even with the drawer closed whenever one is
  // visible — otherwise `machine.stats` stays null forever and the button
  // is permanently (and misleadingly) disabled.
  const hasRunningCommandCard = useMemo(
    () =>
      windowedConversation.some(
        (item) => item.kind === "agent" && item.agent?.status === "running" && !item.agent.subagentType,
      ),
    [windowedConversation],
  );

  // Only polls while the drawer is open or a kill button needs fresh pids —
  // a process table every four seconds is exactly the kind of background
  // cost this drawer exists to warn about, so it stays off otherwise.

  // A pid the probe attributed to a section is only useful with the section's
  // name on it: "node — Fix the mobile sheet" is an answer, "node" is not.
  const sectionTitles = useMemo(
    () => Object.fromEntries(threads.map((thread) => [thread.id, thread.title])),
    [threads],
  );

  // "Pause all" is the per-section Stop, applied to everything mid-turn: the
  // conversations survive, so the next prompt to any of them carries on. Draft
  // threads have no process and are skipped.
  const workingThreadIds = useMemo(
    () => threads.filter((thread) => !thread.draft && thread.agentState === "working").map((thread) => thread.id),
    [threads],
  );

  const pauseAllSections = useCallback(() => {
    for (const id of workingThreadIds) void desktopApi.stopSession({ id });
    machine.refresh();
  }, [workingThreadIds, desktopApi, machine]);

  const killSectionCommands = useCallback(
    (pids?: number[]) => {
      void desktopApi.killSectionCommands({ ...(pids ? { pids } : {}) }).then(() => machine.refresh());
    },
    [desktopApi, machine],
  );

  // Resolves a command card to the single pid the machine probe attributes to
  // it, or undefined if there is no confident match (already exited, or the
  // probe just hasn't sampled it yet). Matched on section id + command text,
  // with a startsWith fallback since a stored card title can be a normalized
  // prefix of the full argv (e.g. shell redirection appended after capture).
  function findCommandPid(item: ConversationItem): number | undefined {
    const sectionId = activeThread?.id;
    const commandText = item.title?.trim();
    if (!sectionId || !commandText) return undefined;
    const rows = machine.stats?.sectionCommands ?? [];
    const match = rows.find((row) => {
      if (row.sessionId !== sectionId) return false;
      const rowCommand = row.command?.trim() ?? "";
      return rowCommand === commandText || rowCommand.startsWith(commandText) || commandText.startsWith(rowCommand);
    });
    return match?.pid;
  }

  // Kill button on a single command card. Deliberately narrow: it must only
  // ever resolve to the one pid the card represents and never fall back to
  // `killSectionCommands()` with no pids, which kills every running command
  // machine-wide, not just this section's. If the probe has no fresh match for
  // this command, the card's kill button stays disabled rather than reaching
  // for that bigger hammer.
  function killAgentCommand(item: ConversationItem): void {
    const pid = findCommandPid(item);
    if (pid === undefined) return;
    killSectionCommands([pid]);
  }

  useEffect(() => {
    if (!machineOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMachineOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [machineOpen]);

  const fetchSessionFiles = useCallback(
    async (thread: Thread): Promise<void> => {
      setFilesLoading(true);
      try {
        const changes = await desktopApi.loadSessionFileChanges({
          sessionId: thread.id,
          cwd: thread.cwd,
          claudeSessionId: thread.claudeSessionId,
          codexThreadId: thread.codexThreadId,
        });
        setFileChanges(changes);
      } catch {
        setFileChanges({ isRepo: false, files: [], added: 0, removed: 0, error: "Failed to read file changes" });
      } finally {
        setFilesLoading(false);
      }
    },
    [desktopApi],
  );

  // Only probed while an editor menu is in use — a bundle can be installed or
  // removed between openings, so a once-per-app-launch cache would go stale.
  const refreshEditors = useCallback((): void => {
    void desktopApi.listEditors().then(setEditors).catch(() => setEditors([]));
  }, [desktopApi]);

  const openSessionFiles = useCallback(
    (threadId: string): void => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) {
        return;
      }

      setFilesThreadId(threadId);
      setFileChanges(null);
      setEditorPickerOpen(false);
      void fetchSessionFiles(thread);
      refreshEditors();
    },
    [fetchSessionFiles, refreshEditors, threads],
  );

  /**
   * Right-click on a project header. The menu offers the folder-level actions —
   * a new section, git status, and handing the repo to an external editor — so
   * probe the installed editors first: a bundle can appear or vanish between
   * openings, which is why this is never cached for the life of the app.
   */
  const openWorkspaceMenu = useCallback(
    (cwd: string, x: number, y: number): void => {
      refreshEditors();
      setContextMenu(null);
      setWorkspaceMenu({ cwd, x, y });
    },
    [refreshEditors],
  );

  const closeSessionFiles = useCallback((): void => {
    setFilesThreadId(null);
    setFileChanges(null);
    setEditorPickerOpen(false);
  }, []);

  useEffect(() => {
    if (!filesThreadId) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (editorPickerOpen) {
        setEditorPickerOpen(false);
        return;
      }
      closeSessionFiles();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filesThreadId, editorPickerOpen, closeSessionFiles]);

  const preferredEditor = preferences.preferredEditor;
  const activeEditor = useMemo(
    () => editors.find((editor) => editor.id === preferredEditor && editor.available) ?? editors.find((editor) => editor.available),
    [editors, preferredEditor],
  );

  const chooseEditor = useCallback(
    (editor: EditorId): void => {
      setEditorPickerOpen(false);
      void desktopApi.savePreferences({ preferredEditor: editor }).then(setPreferences);
    },
    [desktopApi],
  );

  const openPathInEditor = useCallback(
    (path: string, editor?: EditorId): void => {
      const target = editor ?? activeEditor?.id;
      if (!target) {
        return;
      }

      void desktopApi.openInEditor({ editor: target, path }).then((ok) => {
        if (!ok) {
          setNotice(`Could not open ${path}`);
        }
      });
    },
    [activeEditor?.id, desktopApi],
  );

  const draggingFiles = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.items).some((item) => item.kind === "file");

  const clearDragState = useCallback((): void => {
    dragDepthRef.current = 0;
    setDraggingImage(false);
  }, []);

  const handleDragEnter = (event: React.DragEvent): void => {
    if (!draggingFiles(event)) {
      return;
    }
    event.preventDefault();
    // Count enters/leaves so moving across child elements doesn't drop the
    // overlay; only a matching number of leaves clears it.
    dragDepthRef.current += 1;
    setDraggingImage(true);
  };

  const handleDragOver = (event: React.DragEvent): void => {
    if (draggingFiles(event)) {
      event.preventDefault();
    }
  };

  const handleDragLeave = (event: React.DragEvent): void => {
    if (!draggingFiles(event)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDraggingImage(false);
    }
  };

  const handleDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    clearDragState();
    addImageFiles(event.dataTransfer.files);
  };

  useEffect(() => {
    if (!draggingImage) {
      return;
    }

    // Aborted drags (dropped outside the window, or cancelled with Esc) never
    // deliver a matching dragleave/drop, so the overlay would stick. An
    // in-flight HTML5 drag never dispatches mousemove — the first mousemove we
    // see means the drag is over, so use it (plus dragend/drop) to force-clear.
    window.addEventListener("mousemove", clearDragState);
    window.addEventListener("dragend", clearDragState);
    window.addEventListener("drop", clearDragState);
    return () => {
      window.removeEventListener("mousemove", clearDragState);
      window.removeEventListener("dragend", clearDragState);
      window.removeEventListener("drop", clearDragState);
    };
  }, [draggingImage, clearDragState]);

  if (!activeThread) {
    return <main className="empty-state">No section selected.</main>;
  }

  const activeId = activeThread.id;
  const offscreenAttentionThreads = threads
    .filter((thread) => offscreenAttentionIds.has(thread.id))
    .sort((a, b) => threadOrderKey(b).localeCompare(threadOrderKey(a)));
  /**
   * One sidebar row and, under it, the sub-threads it opened.
   *
   * The row and its children are siblings in the DOM rather than nested inside
   * it — a `<button>` cannot contain buttons, and the expand chevron has to be
   * clickable without selecting the parent. Indentation is a CSS custom property
   * on the row so the depth cap (`MAX_SUBTHREAD_DEPTH`) is the only thing
   * bounding how far right this can go.
   */
  // Thin wrapper so call sites are unchanged; the actual row tree lives in
  // the memoized ThreadRow component above (see its comment for why).
  const renderThreadItem = (thread: Thread, depth = 0): React.ReactElement => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      depth={depth}
      activeId={activeId}
      attentionThreadIds={attentionThreadIds}
      collapsedSubthreads={collapsedSubthreads}
      subthreadsByParent={subthreadsByParent}
      visibleSubthreadCounts={visibleSubthreadCounts}
      archivedThreadIds={archivedThreadIds}
      terminalTabsByThread={terminalTabsByThread}
      browserMarksByThread={browserMarksByThread}
      unsentDraftThreadIds={unsentDraftThreadIds}
      registerThreadRow={registerThreadRow}
      toggleSubthreads={toggleSubthreads}
      setActiveThreadId={setActiveThreadId}
      setContextMenu={setContextMenu}
      showMoreSubthreads={showMoreSubthreads}
      showLessSubthreads={showLessSubthreads}
      stopThreadSession={stopThreadSession}
      toggleArchiveThread={toggleArchiveThread}
    />
  );

  return (
    // Everything that renders a message is under here, so a `#12` written by
    // anyone — the agent, or the user who picked it out of the composer's menu —
    // resolves against the board of the workspace it was written in.
    <BacklogCardsContext.Provider value={backlogCards}>
    <main
      className={`app-shell ${sidebarOpen ? "with-sidebar" : "compact-sidebar"} ${resizingSidebar ? "resizing-sidebar" : ""}`}
      style={sidebarOpen ? { gridTemplateColumns: `${sidebarWidth}px 1fr` } : undefined}
    >
      <aside className="sidebar" aria-label="Panda Code sections">
        <div className="sidebar-header">
          <div className="sidebar-header-actions">
            <button
              className="sidebar-new-button"
              type="button"
              onClick={openSearch}
              aria-label="Search conversations"
              title="Search conversations (⌘F)"
            >
              <Search size={16} aria-hidden="true" />
            </button>
            <button
              className="sidebar-new-button"
              type="button"
              onClick={() => setMachineOpen(true)}
              aria-label="This machine"
              title="This machine — load, memory and the heaviest processes"
            >
              <Activity size={16} aria-hidden="true" />
            </button>
            <button
              className="sidebar-new-button"
              type="button"
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              title="Settings"
            >
              <Settings size={16} aria-hidden="true" />
            </button>
            <button
              className="sidebar-new-button"
              type="button"
              onClick={() => setNewSectionChooserOpen(true)}
              aria-label="New section"
              title="New section"
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div
          ref={workspaceListRef}
          className={`workspace-list ${draggingWorkspace ? "reordering" : ""}`}
          // Drop handling lives on the whole list, not on each group: the
          // pointer is hit-tested against frozen midpoints, so the gaps between
          // groups (and the space below the last one) are valid targets too.
          onDragOver={(event) => {
            if (!draggingWorkspace) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            updateWorkspaceDropIndex(event.clientY);
          }}
          onDrop={(event) => {
            if (!draggingWorkspace) {
              return;
            }
            event.preventDefault();
            commitWorkspaceDrag();
          }}
        >
          {/*
            The New Session route: a permanent entry, not a section. It always
            sits at the top so composing is one click from anywhere, and it never
            joins a workspace group because nothing about it has run yet. The
            terminal count is real — shells opened here outlive every session
            started from this route.
          */}
          <button
            className={`thread-item draft-thread-item ${activeThreadId === DRAFT_THREAD_ID ? "active" : ""}`}
            type="button"
            onClick={() => setActiveThreadId(DRAFT_THREAD_ID)}
            title="New session (⌘N)"
          >
            <Plus size={14} aria-hidden="true" className="draft-thread-icon" />
            <span className="thread-copy">
              <strong>
                <span className="thread-title-text">New session</span>
                <ThreadMarks
                  marks={[
                    (terminalTabsByThread[DRAFT_THREAD_ID]?.length ?? 0) > 0
                      ? {
                          key: "terminals",
                          className: "thread-terminal-count",
                          icon: <TerminalSquare size={11} aria-hidden="true" />,
                          count: terminalTabsByThread[DRAFT_THREAD_ID]?.length ?? 0,
                          label: `${terminalTabsByThread[DRAFT_THREAD_ID]?.length} active terminal${
                            terminalTabsByThread[DRAFT_THREAD_ID]?.length === 1 ? "" : "s"
                          }`,
                        }
                      : null,
                    browserMarksByThread[DRAFT_THREAD_ID]
                      ? {
                          key: "browser",
                          className: "thread-browser-count",
                          icon: <Globe size={11} aria-hidden="true" />,
                          count: browserMarksByThread[DRAFT_THREAD_ID]?.tabs ?? 0,
                          label: `${browserMarksByThread[DRAFT_THREAD_ID]?.tabs} page${
                            browserMarksByThread[DRAFT_THREAD_ID]?.tabs === 1 ? "" : "s"
                          } open`,
                        }
                      : null,
                  ]}
                />
              </strong>
            </span>
            {draftHasContent ? (
              <span className="draft-mark" title="Unsent draft" aria-label="Unsent draft">
                <Pencil size={9} aria-hidden="true" />
              </span>
            ) : null}
          </button>
          {starredThreads.length > 0 ? (
            <section
              className={`starred-group ${starredCollapsed ? "collapsed" : "expanded"}`}
              aria-label="Starred sections"
            >
              <button
                className="starred-group-header"
                type="button"
                onClick={() => setStarredCollapsed((current) => !current)}
                aria-expanded={!starredCollapsed}
                title={starredCollapsed ? "Show starred sections" : "Hide starred sections"}
              >
                <Star size={13} className="thread-star" aria-hidden="true" />
                <span>Starred</span>
                <span className="starred-group-count">{starredThreads.length}</span>
                <span className="workspace-chevron">
                  {starredCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                </span>
              </button>
              <div className={`thread-list-shell ${starredCollapsed ? "collapsed" : "expanded"}`}>
                <div className="thread-list starred-thread-list">
                  {starredThreads.map((thread) => renderThreadItem(thread))}
                </div>
              </div>
            </section>
          ) : null}
          {previewWorkspaceGroups.map((group) => {
            const expanded = expandedWorkspaces.has(group.cwd);
            const hasActiveThread = group.threads.some((thread) => thread.id === activeThread.id);
            const archivedInGroup = group.threads.filter((thread) => archivedThreadIds.has(thread.id));
            const showArchived = showArchivedByCwd[group.cwd] ?? false;
            const displayedThreads = getDisplayedGroupThreads(group);
            const visibleCount = Math.min(
              visibleSessionCounts[group.cwd] ?? INITIAL_VISIBLE_SESSIONS,
              displayedThreads.length,
            );
            const canShowMore = visibleCount < displayedThreads.length;
            const canShowLess = visibleCount > INITIAL_VISIBLE_SESSIONS;
            // The project-less group behaves like any other group (drag to
            // reorder, expand/collapse, "+" to start a section) minus the
            // project-only affordances: there is no repository to inspect.
            const scratchGroup = isScratchCwd(group.cwd);
            const groupLabel = workspaceLabel(group.cwd);
            return (
            <section
              className={`workspace-group ${expanded ? "expanded" : "collapsed"} ${hasActiveThread ? "active-workspace" : ""} ${draggingWorkspace === group.cwd ? "dragging" : ""} ${scratchGroup ? "scratch-workspace" : ""}`}
              key={group.cwd}
              aria-label={groupLabel}
              ref={(node) => {
                if (node) {
                  workspaceNodesRef.current.set(group.cwd, node);
                } else {
                  workspaceNodesRef.current.delete(group.cwd);
                }
              }}
            >
              <div
                className="workspace-group-header"
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openWorkspaceMenu(group.cwd, event.clientX, event.clientY);
                }}
              >
                <span
                  className="workspace-drag-handle"
                  draggable
                  onDragStart={(event) => {
                    beginWorkspaceDrag(group.cwd);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", group.cwd);
                  }}
                  // Fires on release anywhere and on Esc. A drop inside the list
                  // has already committed by then; anything else just resets.
                  onDragEnd={endWorkspaceDrag}
                  title="Drag to reorder workspace"
                  aria-label="Drag to reorder workspace"
                >
                  <GripVertical size={14} aria-hidden="true" />
                </span>
                <button
                  className="workspace-toggle"
                  type="button"
                  onClick={() => toggleWorkspace(group.cwd)}
                  aria-expanded={expanded}
                >
                  <span className="workspace-project-icon">
                    {scratchGroup ? <Sparkles size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />}
                  </span>
                  <span className="workspace-group-copy">
                    <strong title={scratchGroup ? `Sections with no project · ${group.cwd}` : group.cwd}>
                      {groupLabel}
                    </strong>
                  </span>
                  <span className="workspace-chevron">
                    {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                  </span>
                </button>
                {scratchGroup ? null : (
                  <button
                    className="group-git-button"
                    type="button"
                    onClick={() => openWorkspaceGit(group.cwd)}
                    aria-label={`Git status for ${groupLabel}`}
                    title="Workspace git status (⌘⇧G)"
                  >
                    <GitBranch size={14} aria-hidden="true" />
                  </button>
                )}
                {archivedInGroup.length > 0 ? (
                  <button
                    className={`group-archive-button ${showArchived ? "active" : ""}`}
                    type="button"
                    onClick={() => toggleArchivedVisible(group.cwd)}
                    aria-pressed={showArchived}
                    aria-label={
                      showArchived
                        ? `Hide archived sections in ${groupLabel}`
                        : `Show ${archivedInGroup.length} archived section${archivedInGroup.length === 1 ? "" : "s"} in ${groupLabel}`
                    }
                    title={showArchived ? "Hide archived" : `Show archived (${archivedInGroup.length})`}
                  >
                    {showArchived ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                  </button>
                ) : null}
                <button
                  className="group-new-button"
                  type="button"
                  onClick={() => (scratchGroup ? void addScratchThread() : addThread(group.cwd))}
                  aria-label={scratchGroup ? "New section with no project" : `New section in ${groupLabel}`}
                  title={scratchGroup ? "New section with no project" : "New section in this workspace"}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              </div>

              <div className={`thread-list-shell ${expanded ? "expanded" : "collapsed"}`}>
                <div className="thread-list">
                  {displayedThreads.slice(0, visibleCount).map((thread) => renderThreadItem(thread))}
                </div>
                {scratchGroup && group.threads.length === 0 ? (
                  <button className="workspace-empty-hint" type="button" onClick={() => void addScratchThread()}>
                    <Plus size={13} aria-hidden="true" />
                    Start a section with no project
                  </button>
                ) : null}
                {group.threads.length > 0 && displayedThreads.length === 0 ? (
                  <button
                    className="workspace-empty-hint"
                    type="button"
                    onClick={() => toggleArchivedVisible(group.cwd)}
                  >
                    <Archive size={13} aria-hidden="true" />
                    All {archivedInGroup.length} session{archivedInGroup.length === 1 ? "" : "s"} archived — show them
                  </button>
                ) : null}
                {displayedThreads.length > INITIAL_VISIBLE_SESSIONS ? (
                  <div className="thread-list-more">
                    {canShowMore ? (
                      <button
                        className="thread-more-button"
                        type="button"
                        onClick={() => showMoreSessions(group.cwd, displayedThreads.length)}
                      >
                        <ChevronDown size={13} aria-hidden="true" />
                        Show {Math.min(VISIBLE_SESSIONS_STEP, displayedThreads.length - visibleCount)} more
                      </button>
                    ) : null}
                    {canShowLess ? (
                      <button className="thread-more-button" type="button" onClick={() => showLessSessions(group.cwd)}>
                        <ChevronUp size={13} aria-hidden="true" />
                        Show less
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>
            );
          })}
        </div>

        {/* A section that finished while its row was off screen — group
            collapsed, folded under a parent, or just scrolled past — gets no
            visible sign of it beyond the OS notification. This is that sign,
            pinned below the scrollable list so it survives whatever is
            hidden. Clicking a row unfolds it and scrolls it into view. */}
        {offscreenAttentionThreads.length > 0 ? (
          <section className="sidebar-attention-footer" aria-label="Unread finished sections">
            <div className="sidebar-attention-footer-header">
              <span className="sidebar-attention-footer-heading">
                <Bell size={12} aria-hidden="true" />
                <span>
                  {offscreenAttentionThreads.length === 1
                    ? "1 section finished off screen"
                    : `${offscreenAttentionThreads.length} sections finished off screen`}
                </span>
              </span>
              <button
                type="button"
                className="sidebar-attention-mark-all"
                onClick={() => markAttentionThreadsRead(offscreenAttentionThreads.map((thread) => thread.id))}
              >
                Mark all read
              </button>
            </div>
            <div className="sidebar-attention-footer-list">
              {offscreenAttentionThreads.map((thread) => (
                <div key={thread.id} className="sidebar-attention-footer-item">
                  <button
                    type="button"
                    className="sidebar-attention-footer-open"
                    onClick={() => jumpToThread(thread)}
                    title={`Jump to ${thread.title?.trim() || "this section"}`}
                  >
                    <span className="sidebar-attention-footer-dot" aria-hidden="true" />
                    <span className="sidebar-attention-footer-title">{thread.title?.trim() || "Untitled section"}</span>
                    <span className="sidebar-attention-footer-workspace">{workspaceLabel(thread.cwd)}</span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-attention-mark-read"
                    onClick={() => markAttentionThreadsRead([thread.id])}
                    title={`Mark ${thread.title?.trim() || "this section"} as read`}
                    aria-label={`Mark ${thread.title?.trim() || "this section"} as read`}
                  >
                    <Check size={13} strokeWidth={2.4} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="usage-card" aria-label={`${agentDisplayName(usageProvider)} plan usage`}>
          <div className="usage-card-header">
            <span className="usage-card-title">
              <Gauge size={13} aria-hidden="true" />
              <span>Plan usage</span>
            </span>
            <span className="usage-card-actions">
              <span className="usage-provider-toggle" role="group" aria-label="Usage provider">
                {RUNTIME_OPTIONS.filter((option) => option.value !== "groq").map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`usage-provider-button ${usageProvider === option.value ? "active" : ""}`}
                    aria-pressed={usageProvider === option.value}
                    onClick={() => setUsageProvider(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </span>
              <button
                type="button"
                className={`usage-refresh-button ${usageLoading ? "spinning" : ""}`}
                onClick={() => refreshUsageRef.current(true)}
                disabled={usageLoading}
                aria-label="Refresh plan usage"
                title="Refresh plan usage"
              >
                <RefreshCw size={12} aria-hidden="true" />
              </button>
            </span>
          </div>
          {usage?.windows.length ? (
            usage.windows.map((window) => (
              <div className="usage-row" key={window.key}>
                <span className="usage-row-label">
                  <span>{window.label}</span>
                  {window.resetsAt ? <small>{resetsLabel(window.resetsAt)}</small> : null}
                </span>
                <span className="usage-bar" role="presentation">
                  <span
                    className={`usage-bar-fill ${window.utilization >= 90 ? "critical" : window.utilization >= 70 ? "warning" : ""}`}
                    style={{ width: `${Math.max(2, Math.round(window.utilization))}%` }}
                  />
                </span>
                <span
                  className="usage-row-value"
                  title={window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : undefined}
                >
                  {Math.round(window.utilization)}%
                </span>
              </div>
            ))
          ) : (
            <div className="usage-empty">
              {usageLoading ? "Loading usage..." : usage?.unavailableReason ?? `${agentDisplayName(usageProvider)} usage is unavailable.`}
            </div>
          )}
          {usage?.windows.length ? (
            <div className={`usage-footnote ${usage.stale ? "warning" : ""}`}>
              {usage.stale
                ? `${usage.unavailableReason ?? "Refresh failed."} Showing numbers from ${usageAgeLabel}.`
                : `Updated ${usageAgeLabel}`}
            </div>
          ) : null}
        </div>
      </aside>

      {sidebarOpen ? (
        <div
          className="sidebar-resizer"
          style={{ left: sidebarWidth }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={startSidebarResize}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
          title="Drag to resize · double-click to reset"
        />
      ) : null}

      <section
        className={`workspace ${activeBtw.open ? "with-btw" : ""} ${resizingBtw ? "resizing-btw" : ""} ${
          browserPanelOpen ? "with-browser" : ""
        } ${resizingBrowser ? "resizing-browser" : ""} ${
          browserPanelOpen && browserPresentation === "full" ? "browser-full" : ""
        }`}
        // Up to three columns: the conversation, then the browser, then /btw.
        // Spelled out rather than left to the stylesheet because each column's
        // width is a number the user dragged.
        style={
          browserPanelOpen && browserPresentation === "full"
            ? { gridTemplateColumns: "minmax(0, 1fr)" }
            : browserPanelOpen || activeBtw.open
              ? {
                  gridTemplateColumns: `minmax(0, 1fr)${browserPanelOpen ? ` ${browserWidth}px` : ""}${
                    activeBtw.open ? ` ${btwWidth}px` : ""
                  }`,
                }
              : undefined
        }
      >
        <div className="workspace-top">
        <header className="topbar">
          <div className="title-row">
            <button
              className="icon-button"
              type="button"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label="Toggle sidebar"
              title="Toggle sidebar (⌘B)"
            >
              <LayoutPanelLeft size={18} aria-hidden="true" />
            </button>
            {isRenaming ? (
              <div className="rename-row">
                <input
                  autoFocus
                  className="title-input"
                  value={renameDraft}
                  maxLength={SECTION_TITLE_CAP}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      commitRename();
                    }
                    if (event.key === "Escape") {
                      cancelRename();
                    }
                  }}
                  aria-label="Section title"
                />
                <button className="icon-button" type="button" onClick={commitRename} aria-label="Save section name" title="Save section name">
                  <Check size={17} aria-hidden="true" />
                </button>
                <button className="icon-button" type="button" onClick={cancelRename} aria-label="Cancel rename" title="Cancel rename">
                  <X size={17} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="title-display-row">
                {/* Where this section sits in the tree, above its name: opened
                    by another section is the single most useful thing to know
                    about a transcript whose first prompt you did not write. */}
                {activeParentThread ? (
                  <button
                    className="subthread-breadcrumb"
                    type="button"
                    onClick={() => setActiveThreadId(activeParentThread.id)}
                    title={`Sub-thread of "${activeParentThread.title}" — open it`}
                  >
                    <CornerUpLeft size={12} aria-hidden="true" />
                    <span>{activeParentThread.title}</span>
                  </button>
                ) : null}
                <h1>{activeThread.title}</h1>
                {activeSubthreads.length > 0 ? (
                  <span
                    className="subthread-header-count"
                    title={`${activeSubthreads.length} sub-thread${activeSubthreads.length === 1 ? "" : "s"} opened from this section`}
                  >
                    <GitBranch size={12} aria-hidden="true" />
                    <span>{activeSubthreads.length}</span>
                  </span>
                ) : null}
                {/* A draft has no name worth keeping — it gets titled from its
                    first prompt once it becomes a section. */}
                {onDraftRoute ? null : (
                  <button className="ghost-icon-button" type="button" onClick={() => beginRename()} aria-label="Rename section" title="Rename section">
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="actions">
            <ModelSelector
              runtime={activeThread.runtime ?? "claude"}
              model={activeThread.model ?? ""}
              effort={activeThread.effort ?? ""}
              permissionMode={activeThread.permissionMode ?? ""}
              codexModels={codexModels}
              groqModels={groqModels}
              open={showSelector}
              onToggle={(open) => {
                setShowTokenInfo(false);
                setShowSelector(open);
              }}
              onSelectRuntime={(value) => void selectRuntime(value)}
              onSelectModel={(value) => void selectModel(value)}
              onSelectEffort={(value) => void selectEffort(value)}
              onSelectPermission={(value) => void selectPermissionMode(value)}
            />
            {/* What this section is for, as the board sees it. Not on the New
                Session route (there is no section to link to yet) and not in
                the scratch workspace (which has no board). */}
            {onDraftRoute || activeThread.scratch || isScratchCwd(activeThread.cwd) ? null : (
              <SectionTasks
                cwd={activeThread.cwd}
                sectionId={activeThread.id}
                desktopApi={desktopApi}
                onOpenTask={(itemId) => setTaskView({ cwd: activeThread.cwd, itemId })}
              />
            )}
            {activeArtifacts.length > 0 ? (
              <button
                className="quiet-action artifacts-button"
                type="button"
                onClick={openArtifacts}
                aria-label="Open evidence captures for this section in Finder"
                title={`${activeArtifacts.length} evidence capture${activeArtifacts.length === 1 ? "" : "s"} — open newest in Finder`}
              >
                <Camera size={15} aria-hidden="true" />
                <span>{activeArtifacts.length}</span>
              </button>
            ) : null}
            <button
              className={`icon-button ${terminalPanelOpen ? "active" : ""}`}
              type="button"
              onClick={toggleTerminalPanel}
              aria-label="Toggle terminal"
              title="Terminal (⌘J)"
            >
              <TerminalSquare size={17} aria-hidden="true" />
            </button>
            <div className="token-info-anchor">
              <button
                className={`icon-button ${showTokenInfo ? "active" : ""}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowSelector(false);
                  setShowTokenInfo((open) => !open);
                }}
                aria-label="Session usage and cost"
                title="Session usage and cost"
                aria-expanded={showTokenInfo}
              >
                <Info size={18} aria-hidden="true" />
              </button>
              {showTokenInfo ? (
                <div className="token-info-popover wide" role="dialog" aria-label="Session info" onClick={(event) => event.stopPropagation()}>
                  {activeRunInspector ? (
                    <div className={`token-info-process ${activeRunInspector.live ? "live" : ""} ${activeRunInspector.staleNotice ? "stale" : ""}`}>
                      <div className="token-info-process-head">
                        <span className="token-info-process-dot" aria-hidden="true" />
                        <strong>{activeRunInspector.process}</strong>
                      </div>
                      <span className="token-info-process-signal">{activeRunInspector.lastSignal}</span>
                      <div className="token-info-latest">
                        <span className="token-info-latest-label">Latest work</span>
                        <span className="token-info-latest-body">{activeRunInspector.latestWork}</span>
                      </div>
                      {activeRunInspector.staleNotice ? <p className="token-info-stale">{activeRunInspector.staleNotice}</p> : null}
                    </div>
                  ) : null}
                  <SessionCostCard
                    report={sessionCostReport}
                    liveTokens={activeTokenUsage}
                    runtimeLabel={agentDisplayName(activeThread.runtime)}
                  />
                </div>
              ) : null}
            </div>
            {/* A draft has written nothing yet, so there is nothing to report. */}
            {onDraftRoute ? null : (
              <button
                className={`icon-button ${filesThreadId === activeThread.id ? "active" : ""}`}
                type="button"
                onClick={() => openSessionFiles(activeThread.id)}
                aria-label="Files changed by this section"
                title="Files changed by this section"
              >
                <FileDiff size={17} aria-hidden="true" />
              </button>
            )}
          </div>
        </header>

        {notice ? <div className="notice">{notice}</div> : null}
        </div>

        <div
          className={`conversation-shell ${draggingImage ? "dragging-image" : ""} ${terminalPanelOpen ? "with-terminal" : ""}`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div
            ref={conversationFeedRef}
            className="conversation-feed"
            aria-label={`${agentDisplayName(activeThread.runtime)} conversation`}
            onScroll={(event) => {
              const nearBottom = isNearScrollEnd(event.currentTarget);
              shouldFollowConversationRef.current = nearBottom;
              setShowScrollToBottom(!nearBottom);
            }}
          >
            {conversationHydrating ? (
              <div className="conversation-loading" role="status" aria-live="polite">
                <div className="conversation-loading-copy">
                  <span className="conversation-loading-spinner" aria-hidden="true" />
                  <div>
                    <strong>Loading conversation</strong>
                    <span>Preparing the latest messages…</span>
                  </div>
                </div>
                <div className="conversation-loading-card" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="conversation-loading-card short" aria-hidden="true">
                  <span />
                  <span />
                </div>
              </div>
            ) : activeConversation.length > 0 ? (
              <div className="conversation-feed-content" key={activeThread.id}>
                {conversationFeed}
              </div>
            ) : onDraftRoute ? (
              // The draft route's own empty state. Says what is actually true —
              // nothing has started — instead of the section empty state's
              // "start or resume", which on a draft would be describing a
              // process that does not exist.
              <div className="conversation-empty">
                <Plus size={22} aria-hidden="true" />
                <strong>New session in {workspaceLabel(activeThread.cwd)}</strong>
                <span>
                  Send the first message to create it. Nothing runs, and nothing is saved, until you do — leave and the
                  draft costs you nothing.
                </span>
                <div className="draft-workspace-picker">
                  <div className="quick-start-project">
                    {isScratchCwd(activeThread.cwd) ? <Sparkles size={13} aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />}
                    <select
                      className="quick-start-project-select"
                      value={activeThread.cwd}
                      onChange={(event) => goToNewSession(event.target.value)}
                      aria-label="Workspace for the new session"
                    >
                      {quickStartProjects.map((cwd) => (
                        <option key={cwd} value={cwd} title={cwd}>
                          {workspaceLabel(cwd)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="quick-start-project-browse"
                      onClick={() => void openWorkspaceFolder()}
                      aria-label="Choose another workspace"
                      title="Choose another workspace..."
                    >
                      <FolderPlus size={14} aria-hidden="true" />
                    </button>
                  </div>
                  {isScratchCwd(activeThread.cwd) ? null : (
                    <button className="draft-no-project-button" type="button" onClick={() => void addScratchThread()}>
                      <Sparkles size={13} aria-hidden="true" />
                      No project
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="conversation-empty">
                <Bot size={22} aria-hidden="true" />
                <strong>No structured messages yet</strong>
                <span>Start or resume this section, then prompts and tool activity will appear here.</span>
              </div>
            )}
          </div>
          {showScrollToBottom ? (
            <button
              className="scroll-to-bottom-button"
              type="button"
              onClick={scrollConversationToBottom}
              aria-label="Scroll to latest message"
              title="Scroll to latest message"
            >
              <ArrowDown size={17} aria-hidden="true" />
            </button>
          ) : null}

          {terminalPanelOpen ? (
            <div className="terminal-panel">
              <div className="terminal-tabbar" role="tablist" aria-label="Terminal tabs">
                {terminalTabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`terminal-tab ${tab.id === activeTerminalTabId ? "active" : ""}`}
                    role="tab"
                    aria-selected={tab.id === activeTerminalTabId}
                    tabIndex={0}
                    onClick={() => setActiveTerminalTabByThread((current) => ({ ...current, [activeThread.id]: tab.id }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        setActiveTerminalTabByThread((current) => ({ ...current, [activeThread.id]: tab.id }));
                      }
                    }}
                  >
                    <TerminalSquare size={12} aria-hidden="true" />
                    <span>{tab.title}</span>
                    <button
                      className="terminal-tab-close"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTerminalTab(activeThread.id, tab.id);
                      }}
                      aria-label={`Close ${tab.title}`}
                      title={`Close ${tab.title}`}
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </div>
                ))}
                <button
                  className="terminal-tabbar-button"
                  type="button"
                  onClick={() => openNewTerminalTab(activeThread.id)}
                  aria-label="New terminal tab"
                  title="New terminal tab"
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
                <span className="terminal-tabbar-spacer" />
                <button
                  className="terminal-tabbar-button"
                  type="button"
                  onClick={toggleTerminalPanel}
                  aria-label="Hide terminal"
                  title="Hide terminal (⌘J)"
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </div>
              <div className="terminal-views">
                {terminalTabs.map((tab) => (
                  <TerminalView
                    key={tab.id}
                    terminalId={tab.id}
                    cwd={activeThread.cwd}
                    visible={tab.id === activeTerminalTabId}
                    desktopApi={desktopApi}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <WorkingStatusBar
            state={activeThread.agentState}
            workingLabel={
              activeThread.agentState === "working" && activeRuntimeStatus?.currentEventType === "contextCompaction:started"
                ? "Compacting context…"
                : undefined
            }
            detail={
              activeThread.agentState === "working" && activeRuntimeStatus?.currentEventType === "contextCompaction:started"
                ? "Reducing conversation history so Codex can continue"
                : activeThread.agentState === "working"
                  ? compactLine(activeRuntimeStatus?.latestCommand ?? activeRuntimeStatus?.latestTool ?? "") || undefined
                  : undefined
            }
          />

          {activePendingApproval ? (
            <ApprovalPanel
              key={`${activePendingApproval.promptId}:${activePendingApproval.questionIndex ?? 0}`}
              approval={activePendingApproval}
              runtime={activeThread.runtime}
              onAnswer={(optionId, text) => void answerApproval(activeThread.id, activePendingApproval, optionId, text)}
            />
          ) : null}

          <form
            className="prompt-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPrompt();
            }}
          >
            {imageAttachments.length > 0 ? (
              <div className="attachment-strip" aria-label="Attached images">
                {imageAttachments.map((attachment) => (
                  <div className="attachment-chip" key={attachment.id} title={attachment.path}>
                    <button
                      className="attachment-thumb-button"
                      type="button"
                      onClick={() => handlePreviewStagedAttachment(attachment)}
                      aria-label={`Expand ${attachment.name}`}
                    >
                      <img alt="" src={attachment.previewUrl} />
                    </button>
                    <span>{attachment.name}</span>
                    <button type="button" onClick={() => removeImageAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {(queuedByThread[activeThread.id] ?? []).length > 0 ? (
              <div className="queued-list" aria-label="Queued messages">
                {(queuedByThread[activeThread.id] ?? []).map((entry, index) => (
                  <div className="queued-item" key={entry.id} title={entry.text}>
                    <span className="queued-index">{index + 1}</span>
                    <span className="queued-text">
                      {entry.text || `${entry.attachments.length} image${entry.attachments.length === 1 ? "" : "s"}`}
                    </span>
                    {entry.text && entry.attachments.length > 0 ? (
                      <span className="queued-meta">
                        <Image size={11} aria-hidden="true" />
                        {entry.attachments.length}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="queued-send-now"
                      onClick={() => sendQueuedNow(activeThread.id, entry.id)}
                      disabled={isSendingPrompt}
                      aria-label="Send now"
                      title="Send now — steer the current turn"
                    >
                      <Zap size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeQueuedPrompt(activeThread.id, entry.id)}
                      aria-label="Remove queued message"
                      title="Remove queued message"
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <DictationBar dictation={dictation} recording={mainDictation.recording} undoable={mainDictation.undoable} />
            {dictation.error ? (
              // Permission failures are the common case, and a dead microphone
              // with no explanation is the thing this avoids — the message names
              // the System Settings pane to open.
              <div className="composer-dictation-error" role="status">
                <Mic size={12} aria-hidden="true" />
                <span>{dictation.error}</span>
                <button type="button" onClick={dictation.dismissError} aria-label="Dismiss">
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            <div className="composer-input-row">
            <ComposerField
              key={activeThread.id}
              ref={composerFieldRef}
              threadId={activeThread.id}
              initialValue={promptDraft}
              disabled={isSendingPrompt}
              placeholder={
                onDraftRoute
                  ? `Describe the work — Enter creates the section and sends it to ${agentDisplayName(activeThread.runtime)}`
                  : threadWorking
                    ? "Enter to queue · ⌘Enter to send now"
                    : activeThread.status === "running"
                      ? `Send a prompt to ${agentDisplayName(activeThread.runtime)}`
                      : "Type to start this section and send"
              }
              slashCommands={COMPOSER_SLASH_COMMANDS}
              cards={composerCards}
              shortcutHints={COMPOSER_SHORTCUT_HINTS}
              textRef={composerTextRef}
              onHasTextChange={setComposerHasText}
              onFieldFocus={mainDictation.onFocus}
              onEnter={onComposerEnter}
              onPaste={onComposerPaste}
              onCommit={commitComposerDraft}
            />
            {/* The secondary slot, left of the main button.
                While recording it holds the microphone — so send keeps its
                usual place and stays reachable mid-sentence, the way it does on
                the phone. Otherwise it offers the microphone only when the main
                slot is taken by stop (agent working, nothing typed yet). */}
            {mainDictation.recording || (composerEmpty && threadWorking) ? (
              <DictationMicButton
                dictation={dictation}
                recording={mainDictation.recording}
                className="composer-fab--beside"
              />
            ) : null}
            {/* Stop is offered while the agent is actually WORKING. Keying it off
                `status === "running"` (the process being alive) put a stop button
                next to a "Ready" badge, with nothing to stop and no send button. */}
            {threadWorking && composerEmpty && !mainDictation.recording ? (
              <button
                className="composer-fab composer-fab--stop"
                type="button"
                onClick={() => void stopSession()}
                aria-label={`Stop this section's ${agentDisplayName(activeThread.runtime)} process`}
                title={`Stop this section's ${agentDisplayName(activeThread.runtime)} process`}
              >
                <span className="stop-glyph" aria-hidden="true" />
              </button>
            ) : dictation.available && composerEmpty && !mainDictation.recording ? (
              <DictationMicButton dictation={dictation} recording={false} />
            ) : threadWorking && !composerEmpty ? (
              <button
                className="composer-fab composer-fab--queue"
                type="button"
                onClick={() => void queuePrompt()}
                disabled={isSendingPrompt}
                aria-label="Queue this message"
                title="Queue this message (Enter) · ⌘Enter to send now"
              >
                <ListPlus size={16} aria-hidden="true" />
              </button>
            ) : (
              <button
                className="composer-fab composer-fab--send"
                type="button"
                onClick={() => void submitPrompt()}
                disabled={isSendingPrompt || (!composerHasText && imageAttachments.length === 0)}
                aria-label="Send"
                title="Send (Enter)"
              >
                <Send size={16} aria-hidden="true" />
              </button>
            )}
            </div>
          </form>
        </div>

        {/* Always mounted, and hidden by being moved off-screen rather than with
            `display: none`: a `<webview>` whose ancestor is display:none loses its
            compositing surface and comes back blank, which silently kills every
            tab an agent is working in. */}
        <aside
          className={`browser-dock ${browserPanelOpen ? "" : "hidden"} ${browserPresentation === "full" ? "full" : ""}`}
          aria-label="Browser"
          aria-hidden={!browserPanelOpen}
        >
          {browserPanelOpen && browserPresentation !== "full" ? (
            <div
              className="browser-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize browser"
              onPointerDown={startBrowserResize}
              onDoubleClick={() => setBrowserWidth(BROWSER_DEFAULT_WIDTH)}
              title="Drag to resize · double-click to reset"
            />
          ) : null}
          <BrowserPanel
            desktopApi={desktopApi}
            threadId={activeThread.id}
            presentation={browserPresentation}
            onHide={toggleBrowserPanel}
            onPresentationChange={(next) =>
              setBrowserPresentationByThread((current) => ({ ...current, [activeThread.id]: next }))
            }
          />
        </aside>

        {activeBtw.open ? (
          <aside className="btw-panel" role="complementary" aria-label="By the way — session side chat">
            <div
              className="btw-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize side chat"
              onMouseDown={startBtwResize}
              onDoubleClick={() => setBtwWidth(BTW_DEFAULT_WIDTH)}
              title="Drag to resize · double-click to reset"
            />
            <div className="btw-panel-header">
              <div className="btw-panel-heading">
                <span className="btw-panel-title">
                  <Sparkles size={14} aria-hidden="true" />
                  By the way
                  {activeBtw.running ? <span className="btw-live-dot" aria-hidden="true" /> : null}
                </span>
                <div className="btw-panel-actions">
                  <button
                    type="button"
                    className="btw-panel-action"
                    onClick={() => clearBtwThread(activeThread.id)}
                    disabled={activeBtw.items.length === 0 && !activeBtw.running}
                    aria-label="Clear side chat"
                    title="Clear this side-chat and start fresh"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btw-panel-action btw-panel-close"
                    onClick={() => closeBtwPanel(activeThread.id)}
                    aria-label="Close side chat"
                    title="Close (reopen by typing /btw)"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <span className="btw-panel-sub">Asks about this session — never interrupts it</span>
            </div>
            <div
              ref={btwFeedRef}
              className="btw-panel-feed"
              aria-label="Side-chat messages"
              onScroll={(event) => {
                shouldFollowBtwRef.current = isNearScrollEnd(event.currentTarget);
              }}
            >
              {activeBtw.items.length > 0 ? (
                activeBtw.items.map((item) => {
                  const collapsedByDefault = isCollapsedByDefaultConversationItem(item);
                  return (
                    <ConversationCard
                      key={item.id}
                      item={item}
                      expanded={!collapsedByDefault || expandedConversationItems.has(item.id)}
                      onToggle={toggleConversationItem}
                      onPreviewImage={handlePreviewImage}
                    />
                  );
                })
              ) : (
                <div className="btw-empty">
                  <Sparkles size={18} aria-hidden="true" />
                  <strong>Ask about this session</strong>
                  <span>Questions run in a forked side-session, so the main agent keeps working untouched.</span>
                </div>
              )}
              {activeBtw.error ? <div className="btw-error">{activeBtw.error}</div> : null}
            </div>
            <DictationBar
              dictation={dictation}
              recording={btwDictation.recording}
              undoable={btwDictation.undoable}
              sendHint="Enter asks"
            />
            <div className="btw-composer">
              <textarea
                ref={btwInputRef}
                value={btwDraft}
                onFocus={btwDictation.onFocus}
                onChange={(event) => setBtwDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitBtw();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    closeBtwPanel(activeThread.id);
                  }
                }}
                placeholder={activeBtw.running ? "Thinking… ask another when ready" : "Ask about this session…"}
                aria-label="Ask a side question about this session"
                rows={1}
                autoFocus
              />
              {btwDictation.recording || !btwDraft.trim() ? (
                <DictationMicButton dictation={dictation} recording={btwDictation.recording} className="btw-send" />
              ) : (
                <button
                  type="button"
                  className="composer-fab composer-fab--send btw-send"
                  onClick={() => void submitBtw()}
                  disabled={activeBtw.running || !btwDraft.trim()}
                  aria-label="Ask"
                  title="Ask (Enter)"
                >
                  <Send size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </aside>
        ) : null}
      </section>

      {contextMenu && contextThread ? (
        <div
          className="context-menu"
          style={menuPosition(contextMenu.x, contextMenu.y, 6)}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <button type="button" role="menuitem" onClick={() => toggleStar(contextThread.id)}>
            {contextThread.starred ? <StarOff size={14} aria-hidden="true" /> : <Star size={14} aria-hidden="true" />}
            {contextThread.starred ? "Unstar" : "Star"}
          </button>
          <button type="button" role="menuitem" onClick={() => beginRename(contextThread.id)}>
            <Pencil size={14} aria-hidden="true" />
            Rename
          </button>
          <div className={`notification-menu-item ${contextMenu.x < 430 ? "opens-right" : "opens-left"}`}>
            <button type="button" role="menuitem" aria-haspopup="menu">
              <Bell size={14} aria-hidden="true" />
              Notifications
              <ChevronRight className="context-menu-chevron" size={13} aria-hidden="true" />
            </button>
            <div className="notification-channel-card" role="menu" aria-label="Notifications for this section">
              <div className="notification-channel-title">Notify on</div>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={Boolean(contextMobileNotifications?.phoneCount) && contextMobileNotifications!.subscribedPhones === contextMobileNotifications!.phoneCount}
                disabled={contextMobileNotifications === null || !contextMobileNotifications.available || contextMobileNotifications.phoneCount === 0}
                onClick={() => {
                  if (!contextMobileNotifications?.available || !contextMobileNotifications.phoneCount) return;
                  const subscribed = contextMobileNotifications.subscribedPhones !== contextMobileNotifications.phoneCount;
                  void desktopApi.setSessionMobileNotifications(contextThread.id, subscribed).then(setContextMobileNotifications);
                }}
              >
                {contextMobileNotifications?.phoneCount && contextMobileNotifications.subscribedPhones === contextMobileNotifications.phoneCount
                  ? <Check size={14} aria-hidden="true" /> : <Smartphone size={14} aria-hidden="true" />}
                {contextMobileNotifications === null
                  ? "Loading mobile…"
                  : !contextMobileNotifications.available
                    ? "Mobile unavailable"
                    : contextMobileNotifications.phoneCount === 0
                      ? "Mobile (no paired phone)"
                      : "Mobile"}
              </button>
              {(() => {
                const desktopEnabled = sessionNotificationOverrides[contextThread.id]?.desktop ?? notificationsEnabled;
                const notificatorEnabled = sessionNotificationOverrides[contextThread.id]?.agent ?? agentNotificationsEnabled;
                return (
                  <>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={desktopEnabled}
                      onClick={() => { void desktopApi.setNotificationChannels(contextThread.id, { desktop: !desktopEnabled }).then(setPreferences); }}
                    >
                      {desktopEnabled ? <Check size={14} aria-hidden="true" /> : <Bell size={14} aria-hidden="true" />}
                      Desktop
                    </button>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={notificatorEnabled}
                      onClick={() => { void desktopApi.setNotificationChannels(contextThread.id, { agent: !notificatorEnabled }).then(setPreferences); }}
                    >
                      {notificatorEnabled ? <Check size={14} aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}
                      Agent attention
                    </button>
                  </>
                );
              })()}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => toggleArchiveThread(contextThread.id)}
            disabled={contextThread.id === DRAFT_THREAD_ID}
            title="Hides this section from its workspace's list — does not stop or delete it"
          >
            {archivedThreadIds.has(contextThread.id) ? (
              <ArchiveRestore size={14} aria-hidden="true" />
            ) : (
              <Archive size={14} aria-hidden="true" />
            )}
            {archivedThreadIds.has(contextThread.id) ? "Unarchive" : "Archive"}
          </button>
          <div className="context-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              addSubthread(contextThread);
            }}
            disabled={contextThread.id === DRAFT_THREAD_ID}
            title="Open a section nested under this one"
          >
            <GitBranch size={14} aria-hidden="true" />
            New sub-thread
          </button>
          {contextThread.parentId ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  if (contextThread.parentId) setActiveThreadId(contextThread.parentId);
                }}
              >
                <CornerUpLeft size={14} aria-hidden="true" />
                Go to parent
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setThreadParent(contextThread.id, undefined);
                }}
                title="Move this section out to the top level of its workspace"
              >
                <Unlink size={14} aria-hidden="true" />
                Detach from parent
              </button>
            </>
          ) : activeThread.id !== contextThread.id && activeThread.cwd === contextThread.cwd && !activeThread.draft ? (
            // Adopting is offered only from the section you are LOOKING at: the
            // menu has no room for a picker, and "make this a sub-thread of the
            // one I have open" is the move people actually make — tidying an
            // errand they started separately into the work it belongs to.
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                setThreadParent(contextThread.id, activeThread.id);
              }}
              title={`Nest this section under "${activeThread.title}"`}
            >
              <CornerDownRight size={14} aria-hidden="true" />
              Make sub-thread of “{activeThread.title}”
            </button>
          ) : null}
          <div className="context-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              openSessionFiles(contextThread.id);
            }}
            disabled={contextThread.id === DRAFT_THREAD_ID}
          >
            <FileDiff size={14} aria-hidden="true" />
            Changed files
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => requestDeleteThread(contextThread.id)}
            disabled={contextThread.id === DRAFT_THREAD_ID}
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </button>
        </div>
      ) : null}

      {workspaceMenu ? (
        <div
          className="context-menu"
          style={menuPosition(workspaceMenu.x, workspaceMenu.y, editors.length + 6)}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <div className="context-menu-label">
            {isScratchCwd(workspaceMenu.cwd) ? (
              <Sparkles size={12} aria-hidden="true" />
            ) : (
              <Folder size={12} aria-hidden="true" />
            )}
            <span title={workspaceMenu.cwd}>{workspaceLabel(workspaceMenu.cwd)}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const { cwd } = workspaceMenu;
              setWorkspaceMenu(null);
              if (isScratchCwd(cwd)) {
                void addScratchThread();
              } else {
                addThread(cwd);
              }
            }}
          >
            <Plus size={14} aria-hidden="true" />
            New section
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => archiveAllInWorkspace(workspaceMenu.cwd)}
            disabled={!threads.some(
              (thread) =>
                !thread.draft && thread.cwd === workspaceMenu.cwd && !archivedThreadIds.has(thread.id),
            )}
            title="Hides every section in this workspace from its default view — does not stop or delete any of them"
          >
            <Archive size={14} aria-hidden="true" />
            Archive all sessions
          </button>
          {isScratchCwd(workspaceMenu.cwd) ? null : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const { cwd } = workspaceMenu;
                  setWorkspaceMenu(null);
                  setBacklogWorkspace(cwd);
                  setBacklogEpicFocusId(null);
                }}
              >
                <Kanban size={14} aria-hidden="true" />
                Backlog
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const { cwd } = workspaceMenu;
                  setWorkspaceMenu(null);
                  setScheduleWorkspace(cwd);
                }}
              >
                <Clock size={14} aria-hidden="true" />
                Scheduled tasks
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const { cwd } = workspaceMenu;
                  setWorkspaceMenu(null);
                  openWorkspaceGit(cwd);
                }}
              >
                <GitBranch size={14} aria-hidden="true" />
                Git status
              </button>
              <div className="context-menu-separator" role="separator" />
              {/* Same targets as the changed-files drawer offers, so "open this
                  somewhere else" means the same thing everywhere in the app. */}
              {editors.map((editor) => (
                <button
                  key={editor.id}
                  type="button"
                  role="menuitem"
                  disabled={!editor.available}
                  title={editor.available ? `Open the project in ${editor.name}` : `${editor.name} is not installed`}
                  onClick={() => {
                    const { cwd } = workspaceMenu;
                    setWorkspaceMenu(null);
                    openPathInEditor(cwd, editor.id);
                  }}
                >
                  {editor.id === "finder" ? (
                    <FolderOpen size={14} aria-hidden="true" />
                  ) : (
                    <ExternalLink size={14} aria-hidden="true" />
                  )}
                  Open in {editor.name}
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}

      {pendingDeleteThread ? (
        <div className="dialog-backdrop" role="presentation" onClick={() => setPendingDeleteThreadId(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" onClick={(event) => event.stopPropagation()}>
            <div>
              <h2 id="delete-title">Delete section?</h2>
              <p>
                This removes <strong>{pendingDeleteThread.title}</strong> from Panda Code. The Claude history file is not deleted.
              </p>
            </div>
            <div className="dialog-actions">
              <button className="quiet-action" type="button" onClick={() => setPendingDeleteThreadId(null)}>
                Cancel
              </button>
              <button className="danger-action" type="button" onClick={confirmDeleteThread}>
                <Trash2 size={15} aria-hidden="true" />
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewImage ? (
        <div className="image-preview-backdrop" role="presentation" onClick={() => setPreviewImage(null)}>
          <div
            className="image-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={mediaFileName(previewImage.path)}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="image-preview-toolbar">
              <div>
                <strong>{mediaFileName(previewImage.path)}</strong>
                <span>{previewImage.path}</span>
              </div>
              <button className="ghost-icon-button" type="button" onClick={() => setPreviewImage(null)} aria-label="Close image preview">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            {previewImage.kind === "video" ? (
              <VideoPlayer src={previewImage.url} label={mediaFileName(previewImage.path)} />
            ) : (
              <img alt={mediaFileName(previewImage.path)} src={previewImage.url} />
            )}
          </div>
        </div>
      ) : null}

      {readerDoc ? (
        <DocumentReader
          path={isTextDocumentRequest(readerDoc) ? undefined : readerDoc.path}
          text={isTextDocumentRequest(readerDoc) ? readerDoc.text : undefined}
          title={isTextDocumentRequest(readerDoc) ? readerDoc.title : undefined}
          desktopApi={desktopApi}
          editorName={activeEditor?.name}
          onOpenInEditor={(path) => openPathInEditor(path)}
          onReveal={(path) => openPathInEditor(path, "finder")}
          onBack={() => stepReader(-1)}
          onForward={() => stepReader(1)}
          canGoBack={canReaderGoBack}
          canGoForward={canReaderGoForward}
          onClose={closeReader}
        />
      ) : null}

      {promptHistoryOpen ? (
        <div className="quick-start-backdrop" role="presentation" onClick={() => setPromptHistoryOpen(false)}>
          <PromptHistoryDialog
            sent={promptHistorySent}
            queued={promptHistoryQueued}
            onClose={() => setPromptHistoryOpen(false)}
            onReuse={reuseComposerText}
            onGoTo={goToPrompt}
          />
        </div>
      ) : null}

      {searchOpen ? (
        <div className="quick-start-backdrop" role="presentation" onClick={() => setSearchOpen(false)}>
          <div
            className="search-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Search conversations"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="search-input-row">
              <Search size={16} aria-hidden="true" />
              <input
                autoFocus
                className="search-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSearchOpen(false);
                  }
                  if (event.key === "Enter" && searchResults[0]) {
                    event.preventDefault();
                    setActiveThreadId(searchResults[0].id);
                    setSearchOpen(false);
                  }
                }}
                placeholder="Search titles and conversation content…"
                aria-label="Search query"
              />
              {searchQuery ? (
                <button className="ghost-icon-button" type="button" onClick={() => setSearchQuery("")} aria-label="Clear search">
                  <X size={15} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="search-results">
              {searchQuery.trim() === "" ? (
                <p className="search-hint">Type to search across every section's title and output.</p>
              ) : searchLoading && searchResults.length === 0 ? (
                <p className="search-hint">Searching…</p>
              ) : searchResults.length === 0 ? (
                <p className="search-hint">No sections match “{searchQuery.trim()}”.</p>
              ) : (
                searchResults.map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    className="search-result"
                    onClick={() => {
                      setActiveThreadId(result.id);
                      setSearchOpen(false);
                    }}
                  >
                    <div className="search-result-head">
                      <strong>{highlightMatch(result.title, searchQuery)}</strong>
                      <span className="search-result-workspace">
                        <Folder size={11} aria-hidden="true" />
                        {result.workspaceName}
                      </span>
                      <span className={`search-result-tag ${result.matchedInTitle ? "title" : "content"}`}>
                        {result.matchedInTitle ? "Title" : "Content"}
                      </span>
                    </div>
                    {result.snippet ? (
                      <span className="search-result-snippet">{highlightMatch(result.snippet, searchQuery)}</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      {newSectionChooserOpen ? (
        <div className="quick-start-backdrop" role="presentation" onClick={() => setNewSectionChooserOpen(false)}>
          <div
            className="new-section-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="New section"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setNewSectionChooserOpen(false);
              }
            }}
          >
            <div className="quick-start-head">
              <Plus size={15} aria-hidden="true" />
              <span>New section</span>
            </div>
            <div className="new-section-choices">
              <button
                autoFocus
                className="new-section-choice"
                type="button"
                onClick={() => void openWorkspaceFolder()}
              >
                <span className="new-section-choice-icon">
                  <FolderPlus size={18} aria-hidden="true" />
                </span>
                <span className="new-section-choice-copy">
                  <strong>Work in a project</strong>
                  <small>Pick a folder — the agent gets the repo, terminal, and git status.</small>
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
              <button className="new-section-choice" type="button" onClick={() => void addScratchThread()}>
                <span className="new-section-choice-icon">
                  <Sparkles size={18} aria-hidden="true" />
                </span>
                <span className="new-section-choice-copy">
                  <strong>No project</strong>
                  <small>Just a conversation — questions, drafts, research, no folder attached.</small>
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="quick-start-foot">
              <span>Esc to cancel</span>
            </div>
          </div>
        </div>
      ) : null}

      {attentionQueue.length > 0 && !activeAttention ? (
        <button className="agent-attention-minimized" type="button" onClick={() => setMinimizedAttentionIds(new Set())}>
          <AlertTriangle size={15} aria-hidden="true" />
          {attentionQueue.length === 1 ? "Agent needs attention" : `${attentionQueue.length} agent requests`}
        </button>
      ) : null}

      {activeAttention ? (() => {
        const attention = activeAttention;
        return (
          <div className="agent-attention-backdrop" role="presentation">
            <section
              className={`agent-attention-dialog ${attention.severity}`}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="agent-attention-title"
              aria-describedby="agent-attention-summary"
            >
              <div className="agent-attention-kicker">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>{attention.severity === "urgent" ? "Urgent agent request" : "Agent needs attention"}</span>
                {attentionQueue.length > 1 ? <small>{attentionQueue.length} waiting</small> : null}
              </div>
              <div className="agent-attention-source" id="agent-attention-title">{attention.threadTitle}</div>
              <p className="agent-attention-summary" id="agent-attention-summary">{attention.summary}</p>
              {attention.tldr ? (
                <p className="agent-attention-tldr"><strong>TL;DR:</strong> {attention.tldr}</p>
              ) : null}
              {attention.important ? (
                <p className="agent-attention-important"><strong>Important:</strong> {attention.important}</p>
              ) : null}
              {attention.detail ? <p className="agent-attention-detail">{attention.detail}</p> : null}
              <div className="agent-attention-actions">
                {attention.choices.map((choice) => (
                  <button key={`${choice.label}:${choice.response}`} type="button" className="primary" onClick={() => answerAttention(attention, choice.response)}>
                    {choice.label}
                  </button>
                ))}
                <button type="button" onClick={() => openAttentionThread(attention)}>Open section</button>
                <button
                  type="button"
                  className="quiet push-right"
                  onClick={() => setMinimizedAttentionIds((current) => new Set(current).add(attention.id))}
                >
                  Later
                </button>
                <button type="button" className="quiet" onClick={() => dismissAttention(attention.id)}>
                  Close
                </button>
              </div>
            </section>
          </div>
        );
      })() : null}

      {quickStartOpen ? (
        <div className="quick-start-backdrop" role="presentation" onClick={() => setQuickStartOpen(false)}>
          <div
            className="quick-start-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Start a new section"
            onClick={(event) => event.stopPropagation()}
            onDragOver={(event) => {
              if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) {
                event.preventDefault();
              }
            }}
            onDrop={handleQuickStartDrop}
          >
            <div className="quick-start-head">
              <Plus size={15} aria-hidden="true" />
              <span>New section</span>
            </div>
            <div className="quick-start-row">
            <div className="quick-start-project">
              {isScratchCwd(quickStartCwd) ? <Sparkles size={13} aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />}
              <select
                className="quick-start-project-select"
                value={quickStartCwd}
                onChange={(event) => setQuickStartCwd(event.target.value)}
                aria-label="Project for the new section"
              >
                {quickStartProjects.map((cwd) => (
                  <option key={cwd} value={cwd} title={cwd}>
                    {workspaceLabel(cwd)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="quick-start-project-browse"
                onClick={() => void chooseQuickStartFolder()}
                aria-label="Choose another folder"
                title="Choose another folder…"
              >
                <FolderPlus size={14} aria-hidden="true" />
              </button>
            </div>
            <div className="quick-start-settings">
              <ModelSelector
                runtime={quickStartRuntime}
                model={quickStartModel}
                effort={quickStartEffort}
                permissionMode={quickStartPermissionMode}
                codexModels={codexModels}
                groqModels={groqModels}
                open={quickStartSelectorOpen}
                onToggle={setQuickStartSelectorOpen}
                onSelectRuntime={selectQuickStartRuntime}
                onSelectModel={selectQuickStartModel}
                onSelectEffort={setQuickStartEffort}
                onSelectPermission={setQuickStartPermissionMode}
              />
            </div>
            </div>
            {quickStartAttachments.length > 0 ? (
              <div className="attachment-strip" aria-label="Attached images">
                {quickStartAttachments.map((attachment) => (
                  <div className="attachment-chip" key={attachment.id} title={attachment.path}>
                    <button
                      className="attachment-thumb-button"
                      type="button"
                      onClick={() => handlePreviewStagedAttachment(attachment)}
                      aria-label={`Expand ${attachment.name}`}
                    >
                      <img alt="" src={attachment.previewUrl} />
                    </button>
                    <span>{attachment.name}</span>
                    <button type="button" onClick={() => removeQuickStartAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <DictationBar
              dictation={dictation}
              recording={quickStartDictation.recording}
              undoable={quickStartDictation.undoable}
            />
            <textarea
              autoFocus
              ref={quickStartInputRef}
              className="quick-start-input"
              value={quickStartDraft}
              onFocus={quickStartDictation.onFocus}
              onChange={(event) => applyQuickStartDraft(event.target.value)}
              onPaste={handleQuickStartPaste}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitQuickStart();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setQuickStartOpen(false);
                }
                // Arrow up/down toggle between workspaces. Cycle only when the
                // caret is at the matching text boundary so plain arrows still
                // navigate a multi-line prompt.
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  const field = event.currentTarget;
                  const atStart = field.selectionStart === 0 && field.selectionEnd === 0;
                  const atEnd = field.selectionStart === field.value.length && field.selectionEnd === field.value.length;
                  if (event.key === "ArrowUp" && atStart) {
                    event.preventDefault();
                    cycleQuickStartProject(-1);
                  } else if (event.key === "ArrowDown" && atEnd) {
                    event.preventDefault();
                    cycleQuickStartProject(1);
                  }
                }
                // Arrow left/right toggle the provider, using the same caret
                // boundary rule so plain arrows still move through the prompt.
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  const field = event.currentTarget;
                  const collapsed = field.selectionStart === field.selectionEnd;
                  const atStart = collapsed && field.selectionStart === 0;
                  const atEnd = collapsed && field.selectionStart === field.value.length;
                  if ((event.key === "ArrowLeft" && atStart) || (event.key === "ArrowRight" && atEnd)) {
                    event.preventDefault();
                    cycleQuickStartRuntime();
                  }
                }
              }}
              placeholder="Type a prompt, or drag / paste an image…"
              rows={3}
            />
            <div className="quick-start-foot">
              <span>Enter to start · Shift+Enter for a new line · ↑/↓ workspace · ←/→ provider · Esc to cancel</span>
              {/* Inline rather than floating in the corner: this overlay's foot is a
                  row, not the composer's absolute-positioned button well. */}
              <DictationMicButton
                dictation={dictation}
                recording={quickStartDictation.recording}
                className="quick-start-mic"
              />
              <button
                className="primary-action"
                type="button"
                onClick={() => void submitQuickStart()}
                disabled={!quickStartDraft.trim() && quickStartAttachments.length === 0}
              >
                <Send size={14} aria-hidden="true" />
                Start
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {backlogWorkspace ? (
        <BacklogBoard
          cwd={backlogWorkspace}
          workspaceName={workspaceName(backlogWorkspace)}
          desktopApi={desktopApi}
          focusItemId={backlogFocusId}
          focusEpicId={backlogEpicFocusId}
          resolveSections={resolveSections}
          onOpenSection={openSectionFromTask}
          onClose={() => {
            setBacklogWorkspace(null);
            setBacklogFocusId(null);
            setBacklogEpicFocusId(null);
          }}
          onCreateSession={(items) => createSessionFromBacklogItems(backlogWorkspace, items)}
        />
      ) : null}

      {/* One card, opened from a transcript link or a section's task list. It
          offers a way through to the board, which the board's own copy of this
          view does not: the door is only worth showing to someone outside. */}
      {taskView ? (
        <TaskOverlay
          cwd={taskView.cwd}
          workspaceName={workspaceName(taskView.cwd)}
          itemId={taskView.itemId}
          desktopApi={desktopApi}
          resolveSections={resolveSections}
          onClose={() => setTaskView(null)}
          onOpenBoard={() => {
            setBacklogWorkspace(taskView.cwd);
            setBacklogFocusId(taskView.itemId);
            setBacklogEpicFocusId(null);
            setTaskView(null);
          }}
          onOpenSection={openSectionFromTask}
          onOpenEpic={(epicId) => {
            setBacklogWorkspace(taskView.cwd);
            setBacklogEpicFocusId(epicId);
            setTaskView(null);
          }}
          onCreateSession={(item) => createSessionFromBacklogItems(taskView.cwd, [item])}
        />
      ) : null}

      {scheduleWorkspace ? (
        <ScheduledTasksPanel
          cwd={scheduleWorkspace}
          workspaceName={workspaceName(scheduleWorkspace)}
          desktopApi={desktopApi}
          onClose={() => setScheduleWorkspace(null)}
        />
      ) : null}

      {machineOpen ? (
        <MachineDrawer
          stats={machine.stats}
          loading={machine.loading}
          error={machine.error}
          onRefresh={machine.refresh}
          onClose={() => setMachineOpen(false)}
          sectionTitles={sectionTitles}
          workingCount={workingThreadIds.length}
          onPauseAll={pauseAllSections}
          onKillCommands={killSectionCommands}
        />
      ) : null}

      {gitWorkspace ? (
        <div className="git-drawer-backdrop" role="presentation" onClick={closeWorkspaceGit}>
          <aside
            className="git-drawer"
            role="dialog"
            aria-label={`Git status for ${workspaceName(gitWorkspace)}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="git-drawer-head">
              <div className="git-drawer-title">
                <GitBranch size={15} aria-hidden="true" />
                <div className="git-drawer-title-copy">
                  <strong>{workspaceName(gitWorkspace)}</strong>
                  <span title={gitWorkspace}>{gitWorkspace}</span>
                </div>
              </div>
              <div className="git-drawer-head-actions">
                {gitStatus?.isRepo && gitStatus.remotes.length > 0 ? (
                  <button
                    className="ghost-icon-button"
                    type="button"
                    onClick={() => fetchGitRemotes(gitWorkspace)}
                    aria-label="Fetch from remotes"
                    title="git fetch --all --prune"
                    disabled={gitFetching || gitLoading}
                  >
                    <CloudDownload size={15} aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  className={`ghost-icon-button ${gitLoading ? "spinning" : ""}`}
                  type="button"
                  onClick={() => fetchWorkspaceGit(gitWorkspace)}
                  aria-label="Refresh git status"
                  title="Refresh"
                  disabled={gitLoading}
                >
                  <RefreshCw size={15} aria-hidden="true" />
                </button>
                <button className="ghost-icon-button" type="button" onClick={closeWorkspaceGit} aria-label="Close">
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            </header>

            {/* Status / History / Actions / Files. The status read is the one that is
                already loaded when the drawer opens; the other two fetch on
                first visit and are cheap to come back to. */}
            <div className="git-drawer-tabs" role="tablist" aria-label="Git views">
              <button
                type="button"
                role="tab"
                aria-selected={gitTab === "status"}
                className={`git-drawer-tab ${gitTab === "status" ? "active" : ""}`}
                onClick={() => setGitTab("status")}
              >
                <GitBranch size={13} aria-hidden="true" />
                Status
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={gitTab === "history"}
                className={`git-drawer-tab ${gitTab === "history" ? "active" : ""}`}
                onClick={() => setGitTab("history")}
              >
                <GitCommitHorizontal size={13} aria-hidden="true" />
                History
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={gitTab === "actions"}
                className={`git-drawer-tab ${gitTab === "actions" ? "active" : ""}`}
                onClick={() => setGitTab("actions")}
              >
                <Activity size={13} aria-hidden="true" />
                Actions
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={gitTab === "files"}
                className={`git-drawer-tab ${gitTab === "files" ? "active" : ""}`}
                onClick={() => setGitTab("files")}
              >
                <FolderOpen size={13} aria-hidden="true" />
                Files
              </button>
            </div>

            <div className="git-drawer-body" role="tabpanel">
              {/* Keyed by workspace: pointing the drawer at another repo starts
                  its history back at the head rather than at whatever page the
                  last one was on. */}
              {gitTab === "history" ? <GitHistoryPanel key={gitWorkspace} cwd={gitWorkspace} desktopApi={desktopApi} /> : null}

              {gitTab === "actions" ? <GitHubActionsPanel key={gitWorkspace} cwd={gitWorkspace} desktopApi={desktopApi} /> : null}

              {gitTab === "files" ? (
                <WorkspaceTreePanel
                  key={gitWorkspace}
                  cwd={gitWorkspace}
                  desktopApi={desktopApi}
                  editorName={activeEditor?.name}
                  onOpen={(path) => openPathInEditor(path)}
                  onReveal={(path) => openPathInEditor(path, "finder")}
                />
              ) : null}

              {gitTab === "status" && gitLoading && !gitStatus ? <div className="git-empty">Reading git status…</div> : null}

              {gitTab === "status" && gitStatus && !gitStatus.isRepo ? (
                <div className="git-empty">{gitStatus.error ?? "Not a git repository."}</div>
              ) : null}

              {gitTab === "status" && gitStatus && gitStatus.isRepo ? (
                <>
                  <section className="git-section">
                    <div className="git-branch-current">
                      <GitBranch size={14} aria-hidden="true" />
                      <strong>{gitStatus.branch ?? "(detached)"}</strong>
                      {gitStatus.ahead ? <span className="git-badge">↑{gitStatus.ahead}</span> : null}
                      {gitStatus.behind ? <span className="git-badge">↓{gitStatus.behind}</span> : null}
                    </div>
                    {(() => {
                      const sync = gitOverallSync(gitStatus);
                      return (
                        <div className={`git-sync git-sync-${sync.tone}`}>
                          <span className="git-sync-dot" aria-hidden="true" />
                          <span className="git-sync-label">{gitFetching ? "Fetching…" : sync.label}</span>
                          <span className="git-sync-age">
                            {gitStatus.lastFetchAt
                              ? `fetched ${relativeAge(gitStatus.lastFetchAt) === "now" ? "just now" : `${relativeAge(gitStatus.lastFetchAt)} ago`}`
                              : "never fetched"}
                          </span>
                        </div>
                      );
                    })()}
                  </section>

                  <section className="git-section">
                    <div className="git-section-head">
                      <span>Remotes</span>
                      <em>{gitStatus.remotes.length}</em>
                    </div>
                    {gitStatus.remotes.length === 0 ? (
                      <p className="git-note">No remotes — nothing to be in sync with.</p>
                    ) : (
                      <ul className="git-list">
                        {gitStatus.remotes.map((remote) => {
                          const sync = gitSyncSummary(remote);
                          return (
                            <li key={remote.name} className="git-row git-row-stack">
                              <span className="git-remote-head">
                                <span className="git-path">{remote.name}</span>
                                {remote.upstream ? <span className="git-badge">upstream</span> : null}
                                <span className={`git-sync-chip git-sync-${sync.tone}`}>{sync.label}</span>
                              </span>
                              <span className="git-sub" title={remote.url}>
                                {remote.url ?? ""}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  <section className="git-section">
                    <div className="git-section-head">
                      <span>Working tree</span>
                      <em>{gitStatus.changes.length === 0 ? "clean" : gitStatus.changes.length}</em>
                    </div>
                    {gitStatus.changes.length === 0 ? (
                      <p className="git-note">No uncommitted changes.</p>
                    ) : (
                      <ul className="git-list">
                        {gitStatus.changes.map((change) => (
                          <li key={change.path} className="git-row">
                            <code className="git-code" title={gitStatusLabel(change.code)}>
                              {change.code.replace(/ /g, "·")}
                            </code>
                            <span className="git-path">{change.path}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="git-section">
                    <div className="git-section-head">
                      <span>Local branches</span>
                      <em>{gitStatus.branches.length}</em>
                    </div>
                    <ul className="git-list">
                      {gitStatus.branches.map((b) => (
                        <li key={b.name} className={`git-row ${b.current ? "current" : ""}`}>
                          <GitBranch size={13} aria-hidden="true" />
                          <span>{b.name}</span>
                          {b.current ? <span className="git-badge">current</span> : null}
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section className="git-section">
                    <div className="git-section-head">
                      <span>Worktrees</span>
                      <em>{gitStatus.worktrees.length}</em>
                    </div>
                    <ul className="git-list">
                      {gitStatus.worktrees.map((w) => (
                        <li key={w.path} className="git-row git-row-stack">
                          <span className="git-path">{w.path}</span>
                          <span className="git-sub">
                            {w.branch ?? "(detached)"}
                            {w.head ? ` · ${w.head}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section className="git-section">
                    <div className="git-section-head">
                      <span>Stashes</span>
                      <em>{gitStatus.stashes.length}</em>
                    </div>
                    {gitStatus.stashes.length === 0 ? (
                      <p className="git-note">No stashes.</p>
                    ) : (
                      <ul className="git-list">
                        {gitStatus.stashes.map((stash, index) => (
                          <li key={index} className="git-row">
                            <span className="git-sub">{stash}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                </>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}

      {filesThread ? (
        <div className="git-drawer-backdrop from-right" role="presentation" onClick={closeSessionFiles}>
          <aside
            className="git-drawer from-right"
            role="dialog"
            aria-label={`Files changed by ${filesThread.title}`}
            onClick={(event) => {
              event.stopPropagation();
              setEditorPickerOpen(false);
            }}
          >
            <header className="git-drawer-head">
              <div className="git-drawer-title">
                <FileDiff size={15} aria-hidden="true" />
                <div className="git-drawer-title-copy">
                  <strong>{filesThread.title}</strong>
                  <span title={filesThread.cwd}>
                    {workspaceName(filesThread.cwd)}
                    {fileChanges?.branch ? ` · ${fileChanges.branch}` : ""}
                  </span>
                </div>
              </div>
              <div className="git-drawer-head-actions">
                <button
                  className={`ghost-icon-button ${filesLoading ? "spinning" : ""}`}
                  type="button"
                  onClick={() => void fetchSessionFiles(filesThread)}
                  aria-label="Refresh changed files"
                  title="Refresh"
                  disabled={filesLoading}
                >
                  <RefreshCw size={15} aria-hidden="true" />
                </button>
                <button className="ghost-icon-button" type="button" onClick={closeSessionFiles} aria-label="Close">
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className="files-toolbar">
              <button
                className="quiet-action"
                type="button"
                onClick={() => openPathInEditor(fileChanges?.root ?? filesThread.cwd)}
                disabled={!activeEditor}
                title={activeEditor ? `Open the project in ${activeEditor.name}` : "No editor found"}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>Open project{activeEditor ? ` in ${activeEditor.name}` : ""}</span>
              </button>
              <div className="files-editor-anchor">
                <button
                  className={`ghost-icon-button ${editorPickerOpen ? "active" : ""}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditorPickerOpen((open) => !open);
                  }}
                  aria-label="Choose editor"
                  title="Choose editor"
                  aria-expanded={editorPickerOpen}
                >
                  <ChevronDown size={15} aria-hidden="true" />
                </button>
                {editorPickerOpen ? (
                  <div className="files-editor-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                    {editors.map((editor) => (
                      <button
                        key={editor.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={editor.id === activeEditor?.id}
                        className={editor.id === activeEditor?.id ? "selected" : ""}
                        disabled={!editor.available}
                        onClick={() => chooseEditor(editor.id)}
                      >
                        {editor.id === activeEditor?.id ? <Check size={13} aria-hidden="true" /> : <span className="files-editor-gap" />}
                        <span>{editor.name}</span>
                        {editor.available ? null : <em>not installed</em>}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="git-drawer-body">
              {filesLoading && !fileChanges ? <div className="git-empty">Reading file changes…</div> : null}

              {fileChanges ? (
                <>
                  <SessionFilesSummary changes={fileChanges} />

                  {fileChanges.files.length === 0 ? (
                    <div className="git-empty">
                      {fileChanges.error ?? "This section has not written to any files yet."}
                    </div>
                  ) : (
                    <section className="git-section">
                      <div className="git-section-head">
                        <span>Files</span>
                        <em>{fileChanges.files.length}</em>
                      </div>
                      <ul className="git-list">
                        {fileChanges.files.map((file) => (
                          <SessionFileRow
                            key={file.absolutePath}
                            file={file}
                            editorName={activeEditor?.name}
                            onOpen={() => openPathInEditor(file.absolutePath)}
                            onReveal={() => openPathInEditor(file.absolutePath, "finder")}
                          />
                        ))}
                      </ul>
                    </section>
                  )}

                  {fileChanges.error && fileChanges.files.length > 0 ? (
                    <p className="git-note">{fileChanges.error} — line counts unavailable.</p>
                  ) : null}
                </>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}

      {showSettings ? (
        <div className="dialog-backdrop" role="presentation" onClick={() => setShowSettings(false)}>
          <div
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-header">
              <h2 id="settings-title">Settings</h2>
              <button className="ghost-icon-button" type="button" onClick={() => setShowSettings(false)} aria-label="Close settings">
                <X size={16} aria-hidden="true" />
              </button>
              <div className="settings-tabs" role="tablist" aria-label="Settings sections">
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === "general"}
                  className={`settings-tab ${settingsTab === "general" ? "active" : ""}`}
                  onClick={() => setSettingsTab("general")}
                >
                  <Settings size={14} aria-hidden="true" />
                  General
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === "defaults"}
                  className={`settings-tab ${settingsTab === "defaults" ? "active" : ""}`}
                  onClick={() => setSettingsTab("defaults")}
                >
                  <SlidersHorizontal size={14} aria-hidden="true" />
                  Session defaults
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === "performance"}
                  className={`settings-tab ${settingsTab === "performance" ? "active" : ""}`}
                  onClick={() => setSettingsTab("performance")}
                >
                  <Gauge size={14} aria-hidden="true" />
                  Performance
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === "usage"}
                  className={`settings-tab ${settingsTab === "usage" ? "active" : ""}`}
                  onClick={() => setSettingsTab("usage")}
                >
                  <LineChart size={14} aria-hidden="true" />
                  Usage &amp; cost
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === "notifications"}
                  className={`settings-tab ${settingsTab === "notifications" ? "active" : ""}`}
                  onClick={() => setSettingsTab("notifications")}
                >
                  <Bell size={14} aria-hidden="true" />
                  Notifications
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === "phone"}
                  className={`settings-tab ${settingsTab === "phone" ? "active" : ""}`}
                  onClick={() => setSettingsTab("phone")}
                >
                  <Smartphone size={14} aria-hidden="true" />
                  Phone
                </button>
              </div>
            </div>

            <div className="settings-panel" role="tabpanel" hidden={settingsTab !== "phone"}>
            <div className="settings-field">
              <label htmlFor="settings-relay-url">Relay URL</label>
              <div className="settings-inline-row">
                <input
                  id="settings-relay-url"
                  type="url"
                  value={relayUrlDraft}
                  onChange={(event) => setRelayUrlDraft(event.target.value)}
                  placeholder="https://your-deployment.convex.cloud"
                  spellCheck={false}
                  aria-label="Relay URL"
                />
                <button
                  className="quiet-action"
                  type="button"
                  disabled={relayUrlDraft.trim().replace(/\/+$/, "") === preferences.relayUrl}
                  onClick={() => void desktopApi.savePreferences({ relayUrl: relayUrlDraft }).then(setPreferences)}
                >
                  Apply
                </button>
                {preferences.relayUrl ? (
                  <button
                    className="ghost-icon-button"
                    type="button"
                    onClick={() => void desktopApi.savePreferences({ relayUrl: "" }).then(setPreferences)}
                    aria-label="Turn off phone pairing"
                    title="Turn off phone pairing"
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <p>Leave empty for local-only mode. Use the Convex deployment URL from a relay you own.</p>
            </div>

            <div className="settings-field remote-pairing-field">
              <span className="settings-field-label">Phone pairing</span>
              {remotePairing.status === "ready" ? (
                <>
                  <div className="remote-pairing-qr">
                    <img src={remotePairing.qrDataUrl} alt="Pair Panda Code mobile using this QR code" />
                  </div>
                  <p>Scan with Panda Code mobile. This one-time code expires at {new Date(remotePairing.expiresAt).toLocaleTimeString()}.</p>
                </>
              ) : (
                <p>{remotePairing.message}</p>
              )}
              <button
                className="quiet-action settings-folder-button"
                type="button"
                disabled={remotePairing.status === "disabled" || remotePairing.status === "loading"}
                onClick={() =>
                  void desktopApi.refreshRemotePairing().then((info) => {
                    setRemotePairing(info);
                    refreshRemoteDevices();
                  })
                }
              >
                {remotePairing.status === "ready" ? "Refresh pairing code" : "Retry pairing"}
              </button>
            </div>

            <div className="settings-field">
              <label htmlFor="settings-remote-keep-awake">Phone reachability</label>
              <select
                id="settings-remote-keep-awake"
                value={preferences.remoteKeepAwake}
                onChange={(event) =>
                  void desktopApi
                    .savePreferences({ remoteKeepAwake: event.target.value as AppPreferences["remoteKeepAwake"] })
                    .then(setPreferences)
                }
                aria-label="Phone reachability"
              >
                <option value="off">Off</option>
                <option value="while-plugged-in">While plugged in</option>
                <option value="always">Always</option>
              </select>
              <p>Keeps the relay heartbeat reachable while idle without keeping the display awake.</p>
            </div>

            <div className="settings-field">
              <span className="settings-field-label">Paired phones</span>
              <label className="settings-field">
                <span><input type="checkbox" checked={preferences.remoteAllowFullAccess === true}
                  onChange={(event) => void desktopApi.savePreferences({ remoteAllowFullAccess: event.target.checked }).then(setPreferences)} /> Allow unrestricted agent control and approvals from phones</span>
                <small>Off by default. Enabling this lets a paired phone authorize unrestricted work with Face ID. Each current phone signs commands with its own device-bound identity.</small>
              </label>
              <div className="remote-device-list">
                {remoteDevices.length === 0 ? (
                  <p>No paired phones yet.</p>
                ) : (
                  remoteDevices.map((device) => (
                    <div className="remote-device-row" key={device.mobileId}>
                      <div>
                        <strong>{device.name?.trim() || "Panda Code Mobile"}</strong>
                        <span>{new Date(device.createdAt).toLocaleDateString()}</span>
                        <span>{device.commandAuthVersion === 3
                          ? device.commandKeyProtection?.startsWith("secure-enclave") ? "Secure Enclave command identity" : "Device-bound command identity"
                          : "Legacy command authorization — open the phone app to upgrade"}</span>
                      </div>
                      <button
                        className="ghost-icon-button"
                        type="button"
                        onClick={() => void desktopApi.revokeRemotePairedDevice(device.mobileId).then(setRemoteDevices)}
                        aria-label="Revoke this phone"
                        title="Revoke this phone's command identity"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
            </div>

            <div className="settings-panel" role="tabpanel" hidden={settingsTab !== "defaults"}>
            <div className="settings-field">
              <span className="settings-field-label">Default provider for new sections</span>
              <PillGroup
                icon={<Bot size={13} aria-hidden="true" />}
                label="Provider"
                accent="#7ab7ff"
                options={RUNTIME_OPTIONS.map((option) => ({ value: option.value, label: option.label, hint: option.hint }))}
                value={defaultRuntime}
                onSelect={(value) => setDefaultRuntime(value === "codex" ? "codex" : value === "groq" ? "groq" : "claude")}
              />
              <p>New sections launch with this coding agent. Existing sections keep their own provider.</p>
            </div>

            <div className="model-settings-heading">
              <h3>Models & reasoning</h3>
              <p>Choose the starting configuration for new sections. Each provider keeps its own defaults.</p>
            </div>
            <div className="model-settings-tabs" role="tablist" aria-label="Provider defaults">
              {RUNTIME_OPTIONS.map((option) => (
                <button type="button" key={option.value} role="tab" id={`model-defaults-tab-${option.value}`}
                  aria-controls={`model-defaults-panel-${option.value}`} aria-selected={settingsModelRuntime === option.value}
                  tabIndex={settingsModelRuntime === option.value ? 0 : -1}
                  onKeyDown={(event) => {
                    const index = RUNTIME_OPTIONS.findIndex((entry) => entry.value === option.value);
                    const next = event.key === "ArrowRight" ? (index + 1) % RUNTIME_OPTIONS.length
                      : event.key === "ArrowLeft" ? (index - 1 + RUNTIME_OPTIONS.length) % RUNTIME_OPTIONS.length
                      : event.key === "Home" ? 0 : event.key === "End" ? RUNTIME_OPTIONS.length - 1 : -1;
                    const target = RUNTIME_OPTIONS[next];
                    if (target) { event.preventDefault(); setSettingsModelRuntime(target.value); document.getElementById(`model-defaults-tab-${target.value}`)?.focus(); }
                  }}
                  onClick={() => setSettingsModelRuntime(option.value)}>{option.label}</button>
              ))}
            </div>
            <div role="tabpanel" id="model-defaults-panel-claude" aria-labelledby="model-defaults-tab-claude" hidden={settingsModelRuntime !== "claude"}>
            <RuntimeDefaults
              runtime="claude"
              isDefault={defaultRuntime === "claude"}
              model={defaultModel}
              effort={defaultEffort}
              permissionMode={defaultPermissionMode}
              codexModels={codexModels}
              onSelectModel={setDefaultModel}
              onSelectEffort={setDefaultEffort}
              onSelectPermission={setDefaultPermissionMode}
            />
            </div>

            <div role="tabpanel" id="model-defaults-panel-codex" aria-labelledby="model-defaults-tab-codex" hidden={settingsModelRuntime !== "codex"}>
            <RuntimeDefaults
              runtime="codex"
              isDefault={defaultRuntime === "codex"}
              model={defaultCodexModel}
              effort={defaultCodexEffort}
              permissionMode={defaultCodexSandbox}
              codexModels={codexModels}
              onSelectModel={selectDefaultCodexModel}
              onSelectEffort={setDefaultCodexEffort}
              onSelectPermission={setDefaultCodexSandbox}
            />
            </div>

            <div role="tabpanel" id="model-defaults-panel-groq" aria-labelledby="model-defaults-tab-groq" hidden={settingsModelRuntime !== "groq"}>
            <RuntimeDefaults
              runtime="groq"
              isDefault={defaultRuntime === "groq"}
              model={defaultGroqModel}
              effort=""
              permissionMode=""
              codexModels={[]}
              groqModels={groqModels}
              onSelectModel={setDefaultGroqModel}
              onSelectEffort={() => undefined}
              onSelectPermission={() => undefined}
            />
            </div>

            <div className="settings-field">
              <label htmlFor="settings-default-command">Default command for new sections</label>
              <input
                id="settings-default-command"
                value={defaultCommand}
                onChange={(event) => setDefaultCommand(event.target.value)}
                placeholder={DEFAULT_COMMAND}
                spellCheck={false}
                aria-label="Default command"
              />
              <p>Leave this empty to launch each provider&apos;s own CLI. Existing sections keep their own command.</p>
            </div>

            <div className="settings-field">
              <label htmlFor="settings-dictation-locale">Dictation language</label>
              <select
                id="settings-dictation-locale"
                value={preferences.dictationLocale}
                onChange={(event) =>
                  void desktopApi.savePreferences({ dictationLocale: event.target.value }).then(setPreferences)
                }
              >
                {Object.entries(DICTATION_LOCALES).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              {/* Its own setting rather than a read of the system language: the
                  recogniser picks its acoustic model from this, so English
                  spoken into a Mac set to Portuguese comes back as unrelated
                  words for whole clauses, not as a few mangled nouns. */}
              <p>
                The language the microphone decodes speech as — independent of this Mac&apos;s language. Dictate with
                ⌘⇧D, or hold ⌥Space to talk.
              </p>
            </div>

            <div className="settings-field">
              <label htmlFor="settings-groq-api-key">Groq API key</label>
              <p>Using Groq sends prompts, workspace context, and requested file contents to Groq. Files excluded by .gitignore or .pandaignore and common credential files are blocked. Conversation history and search indexes are stored locally on this Mac.</p>
              <input
                id="settings-groq-api-key"
                type="password"
                value={groqKeyDraft}
                onChange={(event) => setGroqKeyDraft(event.target.value)}
                placeholder={groqKeyConfigured ? "Key configured" : "gsk_..."}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => void desktopApi.setGroqApiKey(groqKeyDraft).then((ok) => {
                  if (ok) {
                    setGroqKeyConfigured(Boolean(groqKeyDraft.trim()));
                    setGroqKeyDraft("");
                  }
                })}
              >
                Save Groq key
              </button>
              <p>{groqKeyConfigured ? "Stored securely on this Mac." : "Required before starting a Groq section."}</p>
            </div>
            </div>

            <div className="settings-panel" role="tabpanel" hidden={settingsTab !== "usage"}>
              <UsageReportPanel active={settingsTab === "usage"} loadReport={loadUsageCostRange} />
            </div>

            <div className="settings-panel" role="tabpanel" hidden={settingsTab !== "general"}>
            <div className="settings-field">
              <span className="settings-field-label">Quick-start global shortcut</span>
              <div className="shortcut-capture-row">
                <button
                  type="button"
                  className={`shortcut-capture ${shortcutCapturing ? "capturing" : ""}`}
                  onClick={() => setShortcutCapturing(true)}
                  onBlur={() => setShortcutCapturing(false)}
                  onKeyDown={(event) => {
                    if (!shortcutCapturing) {
                      return;
                    }
                    event.preventDefault();
                    if (event.key === "Escape") {
                      setShortcutCapturing(false);
                      return;
                    }
                    const accelerator = acceleratorFromEvent(event);
                    if (accelerator) {
                      void desktopApi.savePreferences({ quickStartShortcut: accelerator }).then(setPreferences);
                      setShortcutCapturing(false);
                    }
                  }}
                >
                  {shortcutCapturing
                    ? "Press keys…"
                    : preferences.quickStartShortcut
                      ? shortcutDisplay(preferences.quickStartShortcut)
                      : "Click to set a shortcut"}
                </button>
                {preferences.quickStartShortcut && !shortcutCapturing ? (
                  <button
                    type="button"
                    className="ghost-icon-button"
                    onClick={() => void desktopApi.savePreferences({ quickStartShortcut: "" }).then(setPreferences)}
                    aria-label="Clear shortcut"
                    title="Clear shortcut"
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <p>Press this from anywhere to open a prompt box and start a new section. Needs at least one modifier (⌘, ⌃, ⌥, or ⇧).</p>
            </div>

            <div className="settings-field">
              <span className="settings-field-label">Conversation</span>
              <label className="settings-toggle">
                <input type="checkbox" checked={focusMode} onChange={(event) => setFocusMode(event.target.checked)} />
                <span>Focus mode</span>
              </label>
              <p>
                Shows only your messages, the agent&apos;s replies, and the final answer. Tool calls, thinking, and
                subagents fold into a single &ldquo;Agent work&rdquo; line you can expand for the details.
              </p>
            </div>

            <div className="settings-field">
              <span className="settings-field-label">Quota</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={preferences.conserveMode}
                  onChange={(event) => void desktopApi.savePreferences({ conserveMode: event.target.checked }).then(setPreferences)}
                />
                <span>Conserve mode</span>
              </label>
              <p>
                Stretches a nearly-spent Claude quota. New Claude sections start on <strong>Sonnet</strong> and hand
                mechanical work to cheaper subagents, read narrowly, and answer briefly — you can still switch any
                single section to a bigger model. It also tightens session hygiene, which is where the quota actually
                goes: at most {CONSERVE_HYGIENE.maxLiveSessions} live sections, hibernation after{" "}
                {CONSERVE_HYGIENE.idleSessionTimeoutMinutes} idle minutes, and a{" "}
                {CONSERVE_HYGIENE.transcriptWindowSize}-message transcript window. Your own numbers below are kept, not
                overwritten — Conserve only ever tightens them, and turning it off restores them. Model and prompt
                changes apply to sections started after the toggle.
              </p>
            </div>

            <div className="settings-field">
              <span className="settings-field-label">Menu bar</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={preferences.hideDockIcon}
                  onChange={(event) => void desktopApi.savePreferences({ hideDockIcon: event.target.checked }).then(setPreferences)}
                />
                <span>Hide the Dock icon</span>
              </label>
              <p>Hiding the Dock icon keeps Panda Code running in the menu bar only.</p>
            </div>

            <div className="settings-field">
              <span className="settings-field-label">Workspace</span>
              <button className="quiet-action settings-folder-button" type="button" onClick={() => void openWorkspaceFolder()}>
                <FolderPlus size={15} aria-hidden="true" />
                Open another folder…
              </button>
              <p>Pick a project folder to start a new Panda Code section there.</p>
            </div>
            </div>

            <div className="settings-panel" role="tabpanel" hidden={settingsTab !== "performance"}>
            <div className="settings-field">
              <span className="settings-field-label">Live sections</span>
              <label htmlFor="settings-max-live-sessions">Live sections at once</label>
              <select
                id="settings-max-live-sessions"
                value={String(preferences.maxLiveSessions)}
                onChange={(event) =>
                  void desktopApi.savePreferences({ maxLiveSessions: Number(event.target.value) }).then(setPreferences)
                }
                aria-label="Live sections at once"
              >
                {[3, 4, 6, 8, 12, 16, 24].map((count) => (
                  <option key={count} value={String(count)}>
                    {count} sections
                  </option>
                ))}
                <option value="0">No limit</option>
              </select>
              <label htmlFor="settings-idle-session-timeout">Hibernate after</label>
              <select
                id="settings-idle-session-timeout"
                value={String(preferences.idleSessionTimeoutMinutes)}
                onChange={(event) =>
                  void desktopApi
                    .savePreferences({ idleSessionTimeoutMinutes: Number(event.target.value) })
                    .then(setPreferences)
                }
                aria-label="Hibernate idle sections after"
              >
                {[10, 20, 30, 60, 120, 240].map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`}
                  </option>
                ))}
                <option value="0">Never</option>
              </select>
              <p>
                Each live section holds an agent process costing roughly 215 MB, plus up to 175 MB more as its
                conversation grows — so a day&apos;s work can fill a small Mac.
                Passing the cap, or sitting idle this long, hibernates the section you prompted least recently — its
                process is released and your next message picks the conversation up where it left off. Sections that are
                working or waiting on you are never hibernated. Raise both on a machine with plenty of RAM.
              </p>
            </div>

            <div className="settings-field">
              <span className="settings-field-label">Transcript</span>
              <label htmlFor="settings-transcript-window">Items kept on screen</label>
              <select
                id="settings-transcript-window"
                value={String(preferences.transcriptWindowSize)}
                onChange={(event) =>
                  void desktopApi
                    .savePreferences({ transcriptWindowSize: Number(event.target.value) })
                    .then(setPreferences)
                }
                aria-label="Transcript items kept on screen"
              >
                {[500, 1000, 2000, 5000, 10000].map((count) => (
                  <option key={count} value={String(count)}>
                    {count.toLocaleString()} items
                  </option>
                ))}
                <option value="0">No limit</option>
              </select>
              <p>
                A very long section gets slow to scroll and to type into, because every item on screen is rebuilt when a
                turn starts or ends. Beyond this many, the oldest fold behind a &ldquo;Show earlier&rdquo; control at the
                top of the feed — nothing is deleted, and search, export and /btw still see the whole conversation. Most
                sections never reach the default, so this is a safety valve rather than a budget.
              </p>
              <label htmlFor="settings-retained-transcripts">Transcripts kept in memory</label>
              <select
                id="settings-retained-transcripts"
                value={String(preferences.retainedTranscripts)}
                onChange={(event) =>
                  void desktopApi
                    .savePreferences({ retainedTranscripts: Number(event.target.value) })
                    .then(setPreferences)
                }
                aria-label="Transcripts kept in memory"
              >
                {[5, 8, 12, 20, 40, 80].map((count) => (
                  <option key={count} value={String(count)}>
                    {count} sections
                  </option>
                ))}
                <option value="0">Every section opened</option>
              </select>
              <p>
                Reading a section loads its whole history into this window, and a long one is tens of megabytes. Past
                this many, the transcripts you looked at least recently are released and re-read from disk next time you
                open them. The section on screen and any section mid-turn are never released.
              </p>
            </div>
            </div>

            <div className="settings-panel" role="tabpanel" hidden={settingsTab !== "notifications"}>
            <div className="settings-field">
              <span className="settings-field-label">Delivery channels</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={mobileNotificationsEnabled}
                  disabled={remoteDevices.length === 0}
                  onChange={(event) => void desktopApi.setRemoteMobileNotifications(event.target.checked).then(setRemoteDevices)}
                />
                <span>Mobile push notifications</span>
              </label>
              <p>{remoteDevices.length === 0 ? "Pair a phone to enable mobile notifications." : "Subscribes or unsubscribes every paired phone. You can still choose which event types the phone receives in the mobile app."}</p>
            </div>

            <div className="settings-field">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={notificationsEnabled}
                  onChange={(event) => setNotificationsEnabled(event.target.checked)}
                />
                <span>Desktop notifications</span>
              </label>
              <p>Shows a macOS notification and a dock badge when an agent finishes a turn while you are away from that section.</p>
            </div>

            <div className="settings-field">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={agentNotificationsEnabled}
                  onChange={(event) => setAgentNotificationsEnabled(event.target.checked)}
                />
                <span>Agent attention</span>
              </label>
              <p>Brings Panda Code forward with an attention dialog and a five-second sound. Independent of desktop banners. Explicit user requests for agent attention are always allowed.</p>
            </div>

            <div className="settings-field">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={preferences.notificationsPaused}
                  onChange={(event) => void desktopApi.savePreferences({ notificationsPaused: event.target.checked }).then(setPreferences)}
                />
                <span>Pause notifications &amp; badges</span>
              </label>
              <p>Temporarily silences all notifications and clears dock badges. Also available from the Panda Code menu bar icon.</p>
            </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
    </BacklogCardsContext.Provider>
  );
}
