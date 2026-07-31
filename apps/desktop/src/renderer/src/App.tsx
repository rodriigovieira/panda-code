import {
  AlertTriangle,
  ArrowDown,
  Bell,
  Bot,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  CornerUpLeft,
  Cpu,
  Folder,
  FolderPlus,
  Gauge,
  GitBranch,
  GripVertical,
  Image,
  Info,
  LayoutPanelLeft,
  LineChart,
  ListPlus,
  MessageSquare,
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
  User,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import type {
  AgentState,
  AgentRuntime,
  AppPreferences,
  ArtifactRun,
  ConversationItem,
  ConversationSearchResult,
  DesktopApi,
  ExecutionMode,
  PendingApproval,
  PersistedThread,
  RemotePairedDevice,
  RemotePairingInfo,
  SessionRuntimeEvent,
  SessionStatus,
  TokenUsageStats,
  UsageCostReport,
  UsageProvider,
  UsageSnapshot,
  WorkspaceGitStatus,
} from "../../shared/ipc";
import { formatTurnDuration, formatTurnTokens, isTurnSummaryItem } from "../../shared/stream-json";
import { EMPTY_BTW, mergeBtwItems, serializeBtwContext, type BtwState } from "./btw";
import { mergeConversationItems } from "./conversation";
import { exportFilename, parseExportCommand, serializeConversation } from "./export";
import { DRAFT_THREAD_ID, isDraftThread, isSectionWorthKeeping, persistableThreads } from "./draft";
import { parseBodyBlocks } from "./formatting";
import { renderInline } from "./inline";
import { buildPromptWithImageAttachments } from "./prompt";
import { TerminalView } from "./TerminalView";
import { SessionCostCard, UsageReportPanel } from "./usage";

type Thread = PersistedThread;

type WorkspaceGroup = {
  cwd: string;
  threads: Thread[];
  lastActiveAt: string;
};

type ContextMenuState = {
  threadId: string;
  x: number;
  y: number;
} | null;

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

type LaunchSettings = {
  runtime: AgentRuntime;
  model: string;
  effort: string;
  permissionMode: string;
};

type ImagePreview = {
  path: string;
  url: string;
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
const DEFAULT_COMMAND_KEY = "panda-code.default-command.v1";
const DEFAULT_RUNTIME_KEY = "panda-code.default-runtime.v1";
const DEFAULT_MODEL_KEY = "panda-code.default-model.v1";
const DEFAULT_EFFORT_KEY = "panda-code.default-effort.v1";
const DEFAULT_PERMISSION_MODE_KEY = "panda-code.default-permission-mode.v1";
const DEFAULT_CODEX_MODEL_KEY = "panda-code.default-codex-model.v1";
const DEFAULT_CODEX_EFFORT_KEY = "panda-code.default-codex-effort.v1";
const DEFAULT_CODEX_SANDBOX_KEY = "panda-code.default-codex-sandbox.v1";
const USAGE_PROVIDER_KEY = "panda-code.usage-provider.v1";
const EXPANDED_WORKSPACES_KEY = "panda-code.expanded-workspaces.v1";
const WORKSPACE_ORDER_KEY = "panda-code.workspace-order.v1";
const NOTIFICATIONS_KEY = "panda-code.notifications.v1";
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
  { value: "claude", label: "Claude", hint: "Claude Code stream-json sessions" },
  { value: "codex", label: "Codex", hint: "OpenAI Codex sessions" },
];
const CLAUDE_MODEL_OPTIONS: SelectorOption[] = [
  { value: "", label: "Default", hint: "Use the Claude Code default for this account", badge: "Default" },
  { value: "sonnet", label: "Sonnet", hint: "Daily coding, reviews, and scoped feature work", badge: "Balanced" },
  { value: "claude-opus-5", label: "Opus 5.0", hint: "Latest Opus — hard reasoning, migrations, and larger refactors", badge: "Opus 5.0" },
  { value: "claude-opus-4-8", label: "Opus 4.8", hint: "Previous-generation Opus — pin when you want 4.8 specifically", badge: "Opus 4.8" },
  { value: "best", label: "Best available", hint: "Fable where available, otherwise latest Opus", badge: "Auto" },
  { value: "fable", label: "Fable", hint: "Long-running, ambiguous, highly autonomous work", badge: "Max" },
  { value: "opusplan", label: "Opus plan", hint: "Opus for planning, Sonnet for execution", badge: "Plan" },
  { value: "sonnet[1m]", label: "Sonnet 1M", hint: "Long-context Sonnet sessions where available", badge: "1M" },
  { value: "opus[1m]", label: "Opus 1M", hint: "Long-context Opus sessions where available", badge: "1M" },
  { value: "haiku", label: "Haiku", hint: "Quick, simple prompts and low-latency checks", badge: "Fast" },
];
const CODEX_MODEL_OPTIONS: SelectorOption[] = [
  { value: "", label: "Default", hint: "Uses your Codex default model", badge: "Default" },
  { value: "codex-auto-review", label: "Auto Review", hint: "Codex CLI managed model for review-style coding" },
];

// The Claude models surfaced as always-visible pills (in this display order);
// everything else lives behind the "More" disclosure. Codex has few enough
// models that all of them stay visible.
const CLAUDE_PRIMARY_MODEL_VALUES = ["claude-opus-5", "claude-opus-4-8", "sonnet", "fable", ""];

function modelOptions(runtime: AgentRuntime): SelectorOption[] {
  return runtime === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
}

function modelLabel(runtime: AgentRuntime, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return modelOptions(runtime).find((option) => option.value === trimmed)?.label ?? (trimmed || "Default");
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

function effortOptions(runtime: AgentRuntime): Array<{ value: string; label: string; hint: string }> {
  return runtime === "codex" ? CODEX_EFFORT_OPTIONS : CLAUDE_EFFORT_OPTIONS;
}

function effortLabel(runtime: AgentRuntime, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return effortOptions(runtime).find((option) => option.value === trimmed)?.label ?? (trimmed || "Default");
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
    hint: "Useful for reviewing what was asked",
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
  { keys: "Cmd/Ctrl F", description: "Search conversations" },
  { keys: "Cmd/Ctrl 1-9", description: "Switch sections from the sidebar order" },
];

function agentDisplayName(runtime: AgentRuntime | undefined): string {
  return runtime === "codex" ? "Codex" : "Claude";
}

// ---------------------------------------------------------------------------
// Model selector — a single rounded card that replaces the old row of four
// dropdown buttons (runtime / model / effort / permissions). Every dimension is
// a discrete "slider": a track with evenly-spaced stops and a draggable thumb
// that snaps to the nearest option. Provider comes first; a fifth speed slider
// appears only for Codex. Dragging is committed on release so a session only
// restarts once per change.
// ---------------------------------------------------------------------------

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

// The model dimension of the selector: pills for the common models, a "More"
// disclosure for the rest, and a free-text escape hatch for anything off-list.
// Shared by the per-session selector popover and the per-provider defaults in
// Settings, so both offer the same choices.
function ModelPicker(props: {
  runtime: AgentRuntime;
  model: string;
  onSelect: (value: string) => void;
}): ReactElement {
  const { runtime, model, onSelect } = props;
  const isCodex = runtime === "codex";
  const [showCustom, setShowCustom] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [customDraft, setCustomDraft] = useState("");

  // Represent an off-list model as a synthetic "Custom" entry so it still shows
  // as selected. Split into always-visible "primary" pills and the rest, which
  // live behind the "More" disclosure.
  const baseModels = modelOptions(runtime);
  const allModels: SelectorSliderOption[] =
    model && !baseModels.some((option) => option.value === model)
      ? [...baseModels, { value: model, label: model, hint: "Custom model", badge: "Custom" }]
      : baseModels;
  const primaryModels: SelectorSliderOption[] = isCodex
    ? allModels
    : CLAUDE_PRIMARY_MODEL_VALUES.map((value) =>
        allModels.find((option) => option.value === value),
      ).filter((option): option is SelectorSliderOption => Boolean(option));
  const secondaryModels = allModels.filter((option) => !primaryModels.includes(option));
  const activeModel = allModels.find((option) => option.value === model) ?? allModels[0];
  const activeIsSecondary = secondaryModels.some((option) => option.value === model);
  // Keep the selected model visible: force the disclosure open when the active
  // model lives in the secondary set (the user can't hide their own selection).
  const moreOpen = showMore || activeIsSecondary;

  const submitCustom = (): void => {
    const next = customDraft.trim();
    if (!next) return;
    onSelect(next);
    setCustomDraft("");
    setShowCustom(false);
  };

  return (
    <div className="selector-group" style={{ "--slider-accent": "#c9a24a" } as CSSProperties}>
      <div className="selector-slider-head">
        <span className="selector-slider-label">
          <span className="selector-slider-icon">
            <Cpu size={13} aria-hidden="true" />
          </span>
          Model
        </span>
        {activeModel?.badge ? (
          <span className="selector-slider-value">
            <em>{activeModel.badge}</em>
          </span>
        ) : null}
      </div>
      <div className="selector-pills" role="radiogroup" aria-label="Model">
        {primaryModels.map((option) => (
          <button
            key={option.value || "default"}
            type="button"
            role="radio"
            aria-checked={option.value === model}
            className={`selector-pill ${option.value === model ? "selected" : ""}`}
            title={option.hint}
            onClick={() => onSelect(option.value)}
          >
            {option.label}
          </button>
        ))}
        {secondaryModels.length > 0 ? (
          <button
            type="button"
            className={`selector-pill selector-pill-more ${moreOpen ? "active" : ""}`}
            aria-expanded={moreOpen}
            onClick={() => setShowMore((open) => !open)}
          >
            More
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className={`selector-pill selector-pill-icon ${showCustom ? "active" : ""}`}
          onClick={() => {
            setCustomDraft(model);
            setShowCustom((open) => !open);
          }}
          title="Enter a custom model"
          aria-label="Enter a custom model"
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
      </div>
      {moreOpen && secondaryModels.length > 0 ? (
        <div className="selector-pills selector-pills-secondary" role="radiogroup" aria-label="More models">
          {secondaryModels.map((option) => (
            <button
              key={option.value || "default"}
              type="button"
              role="radio"
              aria-checked={option.value === model}
              className={`selector-pill ${option.value === model ? "selected" : ""}`}
              title={option.hint}
              onClick={() => onSelect(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {showCustom ? (
        <div className="selector-custom">
          <input
            value={customDraft}
            autoFocus
            spellCheck={false}
            placeholder={isCodex ? "gpt-..." : "claude-... or alias"}
            onChange={(event) => setCustomDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitCustom();
              }
            }}
          />
          <button type="button" className="selector-custom-apply" onClick={submitCustom}>
            Apply
          </button>
        </div>
      ) : null}
      <p className="selector-slider-hint">{activeModel?.hint}</p>
    </div>
  );
}

function ModelSelector(props: {
  runtime: AgentRuntime;
  model: string;
  effort: string;
  permissionMode: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  onSelectRuntime: (value: AgentRuntime) => void;
  onSelectModel: (value: string) => void;
  onSelectEffort: (value: string) => void;
  onSelectPermission: (value: string) => void;
}): ReactElement {
  const { runtime, model, effort, permissionMode, open, onToggle } = props;
  const isCodex = runtime === "codex";
  const anchorRef = useRef<HTMLDivElement>(null);

  // Capture-phase so the selector still dismisses inside containers (e.g. the
  // quick-start dialog) that stopPropagation before clicks reach window.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) {
        onToggle(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open, onToggle]);

  const summary = `${modelLabel(runtime, model)} · ${effortLabel(runtime, effort)}`;

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
        <div className="selector-card" role="dialog" aria-label="Session model" onClick={(event) => event.stopPropagation()}>
          <PillGroup
            icon={<Bot size={13} aria-hidden="true" />}
            label="Provider"
            accent="#7ab7ff"
            options={RUNTIME_OPTIONS.map((option) => ({ value: option.value, label: option.label, hint: option.hint }))}
            value={runtime}
            onSelect={(value) => props.onSelectRuntime(value as AgentRuntime)}
          />
          <ModelPicker runtime={runtime} model={model} onSelect={props.onSelectModel} />
          <SelectorSlider
            icon={<Zap size={13} aria-hidden="true" />}
            label={isCodex ? "Reasoning" : "Effort"}
            accent="#66c98b"
            options={effortOptions(runtime)}
            value={effort}
            onSelect={props.onSelectEffort}
          />
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
      <ModelPicker runtime={props.runtime} model={props.model} onSelect={props.onSelectModel} />
      <SelectorSlider
        icon={<Zap size={13} aria-hidden="true" />}
        label={isCodex ? "Reasoning" : "Effort"}
        accent="#66c98b"
        options={effortOptions(props.runtime)}
        value={props.effort}
        onSelect={props.onSelectEffort}
      />
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
const VISIBLE_SESSIONS_STEP = 10;
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
const EMPTY_ARTIFACTS: ArtifactRun[] = [];

const fallbackApi: DesktopApi = {
  selectDirectory: () => Promise.resolve(null),
  ensureScratchWorkspace: () => Promise.resolve(""),
  logEvent: () => Promise.resolve(),
  setBadgeCount: () => Promise.resolve(),
  focusWindow: () => Promise.resolve(),
  loadThreads: () => Promise.resolve([]),
  saveThreads: () => Promise.resolve(),
  setSessionStarred: () => Promise.resolve(),
  setSessionTitle: () => Promise.resolve(),
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
  loadUsageCost: () => Promise.resolve(EMPTY_USAGE_COST_REPORT),
  startSession: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  sendInput: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  answerApproval: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  getPathForFile: () => "",
  resizeSession: () => Promise.resolve(),
  stopSession: () => Promise.resolve(),
  startTerminal: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  terminalInput: () => Promise.resolve(),
  resizeTerminal: () => Promise.resolve(),
  stopTerminal: () => Promise.resolve(),
  listTerminals: () => Promise.resolve([]),
  onTerminalData: () => () => undefined,
  onTerminalExit: () => () => undefined,
  searchConversations: () => Promise.resolve([]),
  loadPreferences: () => Promise.resolve({ quickStartShortcut: "", hideDockIcon: false, notificationsPaused: false, remoteKeepAwake: "off" }),
  savePreferences: () => Promise.resolve({ quickStartShortcut: "", hideDockIcon: false, notificationsPaused: false, remoteKeepAwake: "off" }),
  getRemotePairing: () => Promise.resolve({ status: "disabled", message: "Remote relay is unavailable." }),
  refreshRemotePairing: () => Promise.resolve({ status: "disabled", message: "Remote relay is unavailable." }),
  listRemotePairedDevices: () => Promise.resolve([]),
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
  onSessionExit: () => () => undefined,
  btwAsk: () => Promise.resolve({ ok: false, message: "Desktop bridge is unavailable. Open this inside Electron." }),
  btwClear: () => Promise.resolve(),
  onBtwData: () => () => undefined,
  listArtifacts: () => Promise.resolve([]),
  revealPath: () => Promise.resolve(false),
  loadWorkspaceGit: () =>
    Promise.resolve({ isRepo: false, changes: [], stashes: [], worktrees: [], branches: [], folders: [] }),
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
  return readStorageItem(DEFAULT_RUNTIME_KEY) === "codex" ? "codex" : "claude";
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
  return readStorageItem(DEFAULT_CODEX_MODEL_KEY)?.trim() ?? "";
}

function storedDefaultCodexEffort(): string {
  return readStorageItem(DEFAULT_CODEX_EFFORT_KEY)?.trim() ?? "";
}

function storedDefaultCodexSandbox(): string {
  return readStorageItem(DEFAULT_CODEX_SANDBOX_KEY)?.trim() || "read-only";
}

// Codex sessions default to the persistent app-server transport; "exec" keeps
// the legacy one-shot `codex exec --json` path. See docs/codex-app-server-migration.md.
function storedNotificationsEnabled(): boolean {
  return readStorageItem(NOTIFICATIONS_KEY) !== "off";
}

function storedScratchWorkspace(): string {
  return readStorageItem(SCRATCH_WORKSPACE_KEY)?.trim() ?? "";
}

function storedSidebarWidth(): number {
  const raw = Number(readStorageItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_DEFAULT_WIDTH;
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
            model: thread.model,
            titleSource: thread.titleSource ?? "auto",
            executionMode: "stream-json" as const,
            status: thread.status === "running" ? "exited" : thread.status,
            agentState: thread.status === "running" ? "exited" : thread.agentState ?? "exited",
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
    return normalizeThreads(parsed);
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

// Turns an API model id ("claude-opus-4-8-20250915") into a short display
// name ("Opus 4.8"). Unknown formats fall back to the raw id.
function modelDisplayName(modelId: string): string {
  const match = modelId.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d+)?$/);
  if (!match) {
    return modelId;
  }

  const family = match[1] ?? "";
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
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

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i.test(file.name);
}

function imageAttachmentNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "image";
}

function localImageUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
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

function compactPreview(value: string, maxLength = 100): string {
  const normalized = value
    .replace(/```([\w-]+)?\n[\s\S]*?```/g, (_match, language: string | undefined) => (language ? `${language} block` : "code block"))
    .replace(/```([\w-]+)?\n[\s\S]*$/g, (_match, language: string | undefined) => (language ? `${language} block` : "code block"))
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

// renderInline lives in ./inline — it walks marked's CommonMark inline lexer
// into React nodes. See that module for why the old regex approach was replaced.

function FormattedBody({ value }: { value: string }): React.ReactElement {
  const blocks = useMemo(() => parseBodyBlocks(value), [value]);
  return (
    <div className="formatted-body">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre className="formatted-code" key={`code:${index}`}>
              {block.language ? <span className="formatted-code-language">{block.language}</span> : null}
              <code>{block.code}</code>
            </pre>
          );
        }

        if (block.type === "task-notification") {
          return (
            <section className="task-notification-card" key={`task-notification:${index}`}>
              <div className="task-notification-kicker">
                <span className="task-notification-icon">
                  <Bell size={13} aria-hidden="true" />
                </span>
                <strong>Task notification</strong>
                {block.taskId ? <code>{block.taskId}</code> : null}
              </div>
              {block.summary ? <p className="task-notification-summary">{renderInline(block.summary)}</p> : null}
              {block.event ? <p className="task-notification-event">{renderInline(block.event)}</p> : null}
            </section>
          );
        }

        if (block.type === "table") {
          return (
            <div className="formatted-table-shell" key={`table:${index}`}>
              <table className="formatted-table">
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`${header}:${headerIndex}`}>{renderInline(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`row:${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`${cell}:${cellIndex}`}>{renderInline(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === "quote") {
          return (
            <blockquote key={`quote:${index}`}>
              <FormattedBody value={block.text} />
            </blockquote>
          );
        }

        if (block.type === "rule") {
          return <hr key={`rule:${index}`} />;
        }

        if (block.type === "heading") {
          return <h3 key={`heading:${index}`}>{renderInline(block.text)}</h3>;
        }

        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={`list:${index}`}>
              {block.items.map((item, itemIndex) => (
                <li className={item.checked === undefined ? undefined : "task-list-item"} key={`${item.text}:${itemIndex}`}>
                  {item.checked === undefined ? null : (
                    <input checked={item.checked} disabled readOnly type="checkbox" aria-label={item.checked ? "Completed" : "Incomplete"} />
                  )}
                  <span>{renderInline(item.text)}</span>
                </li>
              ))}
            </ListTag>
          );
        }

        return <p key={`paragraph:${index}`}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}

function AgentBadge({ state, compact = false }: { state: AgentState; compact?: boolean }): React.ReactElement {
  return (
    <span className={`agent-badge ${state} ${compact ? "compact" : ""}`}>
      {state === "working" ? <span className="agent-spinner" aria-hidden="true" /> : null}
      {state === "needs_action" ? <AlertTriangle size={13} aria-hidden="true" /> : null}
      {state === "waiting" ? <span className="agent-badge-dot" aria-hidden="true" /> : null}
      {state === "exited" ? <span className="agent-badge-square" aria-hidden="true" /> : null}
      <span>{agentStateLabel(state)}</span>
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
}: {
  state: AgentState;
  detail?: string;
}): React.ReactElement | null {
  if (state === "exited") {
    return null;
  }

  if (state === "working") {
    return (
      <div className={`working-status working`} role="status" aria-live="polite">
        <span className="agent-spinner" aria-hidden="true" />
        <CyclingWord />
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
        <div className="conversation-line system system-notice runtime-handoff-line">
          <button className="conversation-line-header" type="button" onClick={() => onToggle(item.id)} aria-expanded={expanded}>
            <span className="conversation-line-icon">
              <ShieldCheck size={15} aria-hidden="true" />
            </span>
            <strong>System handoff</strong>
            <span className="system-origin-badge">Panda Code</span>
            <span className="conversation-preview">{handoffSummary}</span>
            {item.timestamp ? <time>{formatTime(item.timestamp)}</time> : null}
            <span className="collapse-chevron" aria-hidden="true">
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </button>
          <div className={`conversation-collapse-region ${expanded ? "expanded" : "collapsed"}`}>
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
  const attachedImages = item.kind === "user" ? attachedImagePathsFromBody(item.body) : [];
  const displayBody = attachedImages.length > 0 ? bodyWithoutAttachedImageList(item.body) : item.body;
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
        </div>
        {item.timestamp ? <time>{formatTime(item.timestamp)}</time> : null}
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

  if (item.kind === "assistant" && midTurn) {
    return (
      <div className="conversation-passage">
        <span className="conversation-passage-icon">
          <Bot size={13} aria-hidden="true" />
        </span>
        <div className="conversation-passage-body">
          <FormattedBody value={displayBody} />
        </div>
      </div>
    );
  }

  return (
    <article className={`conversation-card ${item.kind}`}>
      <div className="conversation-card-header">
        <span className="conversation-icon">{icon}</span>
        <strong>{item.title ?? (item.kind === "user" ? "You" : "Claude")}</strong>
        {item.kind === "assistant" && item.model ? (
          <span className="conversation-model" title={item.model}>
            {modelDisplayName(item.model)}
          </span>
        ) : null}
        {item.timestamp ? <time>{formatTime(item.timestamp)}</time> : null}
      </div>
      <div className="conversation-body">
        <FormattedBody value={displayBody} />
        {attachedImages.length > 0 ? <MessageImageAttachments paths={attachedImages} onPreviewImage={onPreviewImage} /> : null}
      </div>
    </article>
  );
});

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
}: {
  item: ConversationItem;
  expanded: boolean;
  onToggle: (itemId: string) => void;
  childItems: ConversationItem[];
  expandedChildIds: Set<string>;
  onToggleChild: (itemId: string) => void;
  onPreviewImage: (path: string) => void;
}): React.ReactElement {
  const agent = item.agent;
  const status = agent?.status ?? "running";
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
    <div className={`agent-card ${status}`}>
      <button
        className="agent-card-header"
        type="button"
        onClick={() => onToggle(item.id)}
        aria-expanded={expanded}
      >
        <span className="agent-card-icon">
          <Sparkles size={15} aria-hidden="true" />
        </span>
        <strong className="agent-card-title">{item.title ?? "Agent"}</strong>
        {agent?.subagentType ? <span className="agent-card-badge">{agent.subagentType}</span> : null}
        <span className={`agent-card-status ${status}`}>
          {statusIcon}
          <span>{status === "running" ? (agent?.background ? "running in background…" : "running…") : status}</span>
        </span>
        {meta.length > 0 ? <span className="agent-card-meta">{meta.join(" · ")}</span> : null}
        <span className="collapse-chevron" aria-hidden="true">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      <div className={`conversation-collapse-region ${expanded ? "expanded" : "collapsed"}`}>
        <div className="agent-card-body">
          {agent?.outputTail ? (
            // A background shell streams no nested transcript; its real output
            // is the file the main process tailed for us.
            <pre className="agent-card-output">{agent.outputTail}</pre>
          ) : childItems.length === 0 ? (
            // No nested items and no output file: history rebuilt from the
            // transcript, or a task that has not written anything yet.
            <div className="agent-card-empty">
              {agent?.summary ?? (status === "running" ? "No output yet…" : "No transcript for this agent.")}
            </div>
          ) : (
            childItems.map((child) => {
              const thinking = isThinkingItem(child);
              const collapsedByDefault = child.kind === "tool" || child.kind === "system" || thinking;
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
        const name = imageAttachmentNameFromPath(path);
        return (
          <button className="message-image-thumb" key={path} type="button" onClick={() => onPreviewImage(path)} title={path}>
            <img alt={name} src={localImageUrl(path)} />
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
  shortcutHints: ComposerShortcutHint[];
  // Live text is mirrored into this ref so App can read it (on submit/queue/btw)
  // without re-rendering on every keystroke.
  textRef: React.MutableRefObject<string>;
  onHasTextChange: (hasText: boolean) => void;
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
      shortcutHints,
      textRef,
      onHasTextChange,
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
    }, [slashQuery]);

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
        <textarea
          ref={areaRef}
          value={value}
          onFocus={() => setFocused(true)}
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

            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onEnter({ meta: event.metaKey || event.ctrlKey });
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="Prompt"
          aria-controls={showSlashPalette ? "composer-slash-commands" : undefined}
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
};

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
}: {
  record: PromptHistoryRecord;
  badge: string;
  latest: boolean;
  query: string;
  onReuse: (text: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const { tag, headline } = useMemo(() => classifyPrompt(record.text), [record.text]);
  const body = record.text.trim();
  // Hand-typed prompts show verbatim; only genuinely long ones (or machine
  // blobs, which are summarised) need the disclosure.
  const long = body.length > 420 || body.split("\n").length > 9;
  const collapsible = Boolean(tag) || long;
  const showRaw = !collapsible || expanded;

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
      {showRaw ? (
        <div className={`prompt-history-text${tag ? " raw" : ""}`}>
          <PromptHistoryHighlight text={displayText} query={query} />
        </div>
      ) : (
        <div className="prompt-history-summary">
          <PromptHistoryHighlight text={headline || displayText} query={query} />
        </div>
      )}
      {collapsible ? (
        <button className="prompt-history-more" type="button" onClick={() => setExpanded((open) => !open)}>
          {expanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          {expanded ? "Show less" : tag ? "Show raw prompt" : "Show full prompt"}
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
}: {
  sent: PromptHistoryRecord[];
  queued: PromptHistoryRecord[];
  onClose: () => void;
  onReuse: (text: string) => void;
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
        <button className="ghost-icon-button" type="button" onClick={onClose} aria-label="Close">
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
  const [tokenUsageByThread, setTokenUsageByThread] = useState<Record<string, TokenUsageStats>>({});
  const [runtimeActivityByThread, setRuntimeActivityByThread] = useState<Record<string, RuntimeActivity>>({});
  const [runtimeStatusByThread, setRuntimeStatusByThread] = useState<Record<string, RuntimeStatus>>({});
  const [promptDraftsByThread, setPromptDraftsByThread] = useState<Record<string, string>>({});
  const [imageAttachmentsByThread, setImageAttachmentsByThread] = useState<Record<string, ImageAttachment[]>>({});
  const [draggingImage, setDraggingImage] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "defaults" | "usage" | "notifications" | "phone">("general");
  const [showTokenInfo, setShowTokenInfo] = useState(false);
  // Cost for the section whose info card is open. Fetched from the persisted
  // ledger rather than derived from the live token snapshot, so it survives a
  // resumed process and a Claude ↔ Codex handoff.
  const [sessionCostReport, setSessionCostReport] = useState<UsageCostReport | null>(null);
  const [gitWorkspace, setGitWorkspace] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [showSelector, setShowSelector] = useState(false);
  const [usageProvider, setUsageProvider] = useState<UsageProvider>(storedUsageProvider);
  // Kept per provider so toggling Claude/Codex shows the other side's last numbers
  // instead of blanking to "unavailable" while its fetch is in flight.
  const [usageByProvider, setUsageByProvider] = useState<Partial<Record<UsageProvider, UsageSnapshot | null>>>({});
  const [usageLoadingProvider, setUsageLoadingProvider] = useState<UsageProvider | null>(null);
  const refreshUsageRef = useRef<() => void>(() => {});
  const usageRefreshTimerRef = useRef<number | undefined>(undefined);
  const [notificationsEnabled, setNotificationsEnabled] = useState(storedNotificationsEnabled);
  const [attentionThreadIds, setAttentionThreadIds] = useState<Set<string>>(() => new Set());
  const [visibleSessionCounts, setVisibleSessionCounts] = useState<Record<string, number>>({});
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
  const [expandedWorkspaces, setExpandedWorkspaces] = useState(loadExpandedWorkspaces);
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
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<string | null>(null);
  const [terminalTabsByThread, setTerminalTabsByThread] = useState<Record<string, TerminalTab[]>>(loadStoredTerminalTabs);
  const [activeTerminalTabByThread, setActiveTerminalTabByThread] = useState<Record<string, string>>({});
  const [openTerminalThreadIds, setOpenTerminalThreadIds] = useState<Set<string>>(() => new Set());
  const [preferences, setPreferences] = useState<AppPreferences>({
    quickStartShortcut: "",
    hideDockIcon: false,
    notificationsPaused: false,
    remoteKeepAwake: "off",
  });
  // Starts disabled, not "loading": a build with no relay configured would
  // otherwise flash "Connecting to the relay…" forever, since the main process
  // never sends a `remote:pairing` update for a bridge that never starts.
  const [remotePairing, setRemotePairing] = useState<RemotePairingInfo>({
    status: "disabled",
    message: "Checking relay configuration…",
  });
  const [remoteDevices, setRemoteDevices] = useState<RemotePairedDevice[]>([]);
  const [quickStartOpen, setQuickStartOpen] = useState(false);
  const [quickStartDraft, setQuickStartDraft] = useState("");
  const [quickStartCwd, setQuickStartCwd] = useState(DEFAULT_WORKSPACE);
  const [quickStartAttachments, setQuickStartAttachments] = useState<ImageAttachment[]>([]);
  const [quickStartRuntime, setQuickStartRuntime] = useState<AgentRuntime>(defaultRuntime);
  const [quickStartModel, setQuickStartModel] = useState(defaultRuntime === "codex" ? defaultCodexModel : defaultModel);
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
  const btwFeedRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowBtwRef = useRef(true);
  const lastBtwThreadIdRef = useRef(activeThreadId);
  const lastPromptAtRef = useRef(new Map<string, string>());
  const idleTimersRef = useRef(new Map<string, number>());
  const pendingLaunchRestartRef = useRef(new Set<string>());
  const hasLoadedStoredThreadsRef = useRef(false);
  const initialThreadsRef = useRef(threads);
  const lastComposerFocusThreadIdRef = useRef(activeThreadId);
  const prevAgentStateRef = useRef(new Map<string, AgentState>());
  const hasSeededAgentStatesRef = useRef(false);
  const finishTimersRef = useRef(new Map<string, number>());
  const settleHandlerRef = useRef<(threadId: string) => void>(() => undefined);
  const streamRuntimeThreadIdsRef = useRef(new Set<string>());
  const dragDepthRef = useRef(0);
  // Latest default cwd for a new section, read by the global quick-start handler
  // (which can't depend on activeThread without re-subscribing the shortcut).
  const activeCwdRef = useRef(DEFAULT_WORKSPACE);
  const defaultLaunchSettingsRef = useRef<LaunchSettings>({
    runtime: defaultRuntime,
    model: defaultRuntime === "codex" ? defaultCodexModel : defaultModel,
    effort: defaultRuntime === "codex" ? defaultCodexEffort : defaultEffort,
    permissionMode: defaultRuntime === "codex" ? defaultCodexSandbox : defaultPermissionMode,
  });
  const pendingQuickSubmitRef = useRef<string | null>(null);
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
  useEffect(() => {
    const thread = activeThread;
    if (!thread) return;
    let cancelled = false;
    const refresh = () => {
      void desktopApi
        .listArtifacts({ cwd: thread.cwd, sinceIso: thread.createdAt })
        .then((runs) => {
          if (!cancelled) {
            setArtifactsByThread((current) => ({ ...current, [thread.id]: runs }));
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
  }, [activeThread, desktopApi]);

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
  const contextThread = useMemo(
    () => threads.find((thread) => thread.id === contextMenu?.threadId),
    [contextMenu?.threadId, threads],
  );
  const pendingDeleteThread = useMemo(
    () => threads.find((thread) => thread.id === pendingDeleteThreadId),
    [pendingDeleteThreadId, threads],
  );
  const activeConversation = useMemo(
    () => (activeThread ? (conversationItems[activeThread.id] ?? []) : []),
    [activeThread, conversationItems],
  );
  const activeBtw = activeThread ? (btwByThread[activeThread.id] ?? EMPTY_BTW) : EMPTY_BTW;
  const btwDraft = btwDraftByThread[activeDraftKey] ?? "";
  activeCwdRef.current = activeThread?.cwd ?? DEFAULT_WORKSPACE;
  defaultLaunchSettingsRef.current = {
    runtime: defaultRuntime,
    model: defaultRuntime === "codex" ? defaultCodexModel : defaultModel,
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
      pendingDeleteThreadId ||
      previewImage ||
      quickStartOpen ||
      newSectionChooserOpen ||
      promptHistoryOpen ||
      searchOpen ||
      gitWorkspace
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
    pendingDeleteThreadId,
    previewImage,
    quickStartOpen,
    newSectionChooserOpen,
    promptHistoryOpen,
    searchOpen,
    gitWorkspace,
    focusComposerSoon,
  ]);

  const logRenderer = useCallback(
    (event: string, details?: Record<string, unknown>) => {
      void desktopApi.logEvent({ source: "renderer", event, details });
    },
    [desktopApi],
  );

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
        setShowSettings(false);
        setQuickStartOpen(false);
        setSearchOpen(false);
        setPromptHistoryOpen(false);
        setActiveThreadId(thread.id);
        setExpandedWorkspaces((current) => new Set(current).add(thread.cwd));
        setAttentionThreadIds((current) => {
          if (!current.has(thread.id)) return current;
          const next = new Set(current);
          next.delete(thread.id);
          return next;
        });
        void desktopApi.focusWindow().then(focusComposerSoon);
      };
    },
    [desktopApi, focusComposerSoon, preferences.notificationsPaused],
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

    const built = Array.from(groups, ([cwd, groupThreads]) => ({
      cwd,
      threads: groupThreads.sort((first, second) =>
        threadOrderKey(second).localeCompare(threadOrderKey(first)),
      ),
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
    }));

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

  // Flat list of threads in the exact order they appear in the sidebar
  // (starred first, then each workspace group). Drives the Cmd+1-9 shortcuts
  // so pressing a number jumps to the Nth session as it reads top to bottom.
  const sidebarOrderedThreads = useMemo<Thread[]>(
    () => [...starredThreads, ...workspaceGroups.flatMap((group) => group.threads)],
    [starredThreads, workspaceGroups],
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

  const updateThread = useCallback((id: string, patch: Partial<Thread>) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === id ? { ...thread, ...patch, lastActiveAt: new Date().toISOString() } : thread,
      ),
    );
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    if (hasLoadedStoredThreadsRef.current) {
      void desktopApi.saveThreads(persisted);
    }
  }, [desktopApi, threads]);

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
    localStorage.setItem(EXPANDED_WORKSPACES_KEY, JSON.stringify(Array.from(expandedWorkspaces)));
  }, [expandedWorkspaces]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_ORDER_KEY, JSON.stringify(workspaceOrder));
  }, [workspaceOrder]);

  useEffect(() => {
    localStorage.setItem(NOTIFICATIONS_KEY, notificationsEnabled ? "on" : "off");
  }, [notificationsEnabled]);

  useEffect(() => {
    localStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify(terminalTabsByThread));
  }, [terminalTabsByThread]);

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

  useEffect(() => {
    void desktopApi.loadPreferences().then(setPreferences);
    return desktopApi.onPreferencesChanged(setPreferences);
  }, [desktopApi]);

  const refreshRemoteDevices = useCallback(() => {
    void desktopApi.listRemotePairedDevices().then(setRemoteDevices).catch(() => setRemoteDevices([]));
  }, [desktopApi]);

  useEffect(() => {
    if (showSettings) {
      refreshRemoteDevices();
    }
  }, [refreshRemoteDevices, showSettings]);

  useEffect(() => {
    return desktopApi.onQuickStart(() => {
      const defaults = defaultLaunchSettingsRef.current;
      setQuickStartDraft("");
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
    if (!notificationsEnabled || typeof Notification === "undefined") {
      return;
    }
    if (Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, [notificationsEnabled]);

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
    if (notificationsEnabled) {
      notifyThreadDone(thread);
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

  useEffect(() => {
    const closeFloatingUi = () => {
      setContextMenu(null);
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
    const refreshUsage = () => {
      setUsageLoadingProvider(usageProvider);
      void desktopApi
        .loadUsage(usageProvider)
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
      logRenderer("session:title", { id, title });
      setThreads((current) =>
        current.map((thread) =>
          thread.id === id && thread.titleSource !== "manual"
            ? { ...thread, title, titleSource: "auto", lastActiveAt: new Date().toISOString() }
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
      if (claudeSessionId) {
        setThreads((current) =>
          dedupeThreadsByClaudeSession(
            current.map((thread) => (thread.id === id ? { ...thread, claudeSessionId, lastActiveAt: new Date().toISOString() } : thread)),
          ),
        );
      }
      if (codexThreadId) {
        setThreads((current) =>
          dedupeThreadsByClaudeSession(
            current.map((thread) => (thread.id === id ? { ...thread, codexThreadId, lastActiveAt: new Date().toISOString() } : thread)),
          ),
        );
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
      };
      setThreads((current) =>
        current.some((thread) => thread.id === request.id) ? current : [remoteThread, ...current],
      );
      setExpandedWorkspaces((current) => new Set(current).add(remoteThread.cwd));
    });

    const removeStarredListener = desktopApi.onSessionStarred(({ id, starred }) => {
      updateThread(id, { starred });
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
      removeClaudeSessionListener();
      removeSessionTitleListener();
      removeConversationListener();
      removeRuntimeListener();
      removePromptSubmittedListener();
      removeStartedListener();
      removeStarredListener();
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
    if (!activeThread || activeThread.status === "running") {
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
    void desktopApi.loadConversation({ cwd, claudeSessionId, codexThreadId }).then(({ items, tokenUsage }) => {
      if (!isMounted) {
        return;
      }
      setConversationItems((current) => ({ ...current, [id]: mergeConversationItems(current[id] ?? [], items) }));
      setTokenUsageByThread((current) => ({ ...current, [id]: tokenUsage }));
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

  useEffect(() => {
    const handleAppShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "j" && !event.shiftKey) {
        event.preventDefault();
        toggleTerminalPanel();
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
  }, [openSearch, toggleTerminalPanel]);

  const addThread = (cwd = activeThread?.cwd, launchSettings?: LaunchSettings): Thread => {
    const runtime = launchSettings?.runtime ?? defaultRuntime;
    const model = launchSettings?.model ?? (runtime === "codex" ? defaultCodexModel : defaultModel);
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
    };
    setThreads((current) => [nextThread, ...current]);
    setActiveThreadId(nextThread.id);
    setExpandedWorkspaces((current) => new Set(current).add(nextThread.cwd));
    setNotice(null);
    return nextThread;
  };

  /**
   * Go to the New Session route, optionally re-pointing it at a workspace or a
   * set of launch settings. This is what "+" and Cmd+N do now: they navigate,
   * they don't create. Nothing is started, persisted or mirrored until the first
   * prompt is sent from there.
   */
  const goToNewSession = (cwd?: string, launchSettings?: LaunchSettings): void => {
    const runtime = launchSettings?.runtime ?? defaultRuntime;
    const model = launchSettings?.model ?? (runtime === "codex" ? defaultCodexModel : defaultModel);
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

  const submitQuickStart = (): void => {
    const prompt = quickStartDraft.trim();
    const attachments = quickStartAttachments;
    const launchSettings: LaunchSettings = {
      runtime: quickStartRuntime,
      model: quickStartModel,
      effort: quickStartEffort,
      permissionMode: quickStartPermissionMode,
    };
    setQuickStartOpen(false);
    setQuickStartSelectorOpen(false);
    setQuickStartDraft("");
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
    setThreads((current) => current.filter((thread) => thread.id !== threadId));
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

    const nextTitle = renameDraft.trim();
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
      updateThread(thread.id, { agentState: "waiting", command, executionMode, status: "running" });
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

    const model = runtime === "codex" ? defaultCodexModel : defaultModel;
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
        claudeSessionId: runtime === "codex" ? undefined : activeThread?.claudeSessionId,
        codexThreadId: runtime === "claude" ? undefined : activeThread?.codexThreadId,
        handoffFromRuntime: activeRuntime,
        handoffCreatedAt: new Date().toISOString(),
        handoffContext: handoffContext ?? undefined,
      },
      `Runtime set to ${runtime === "codex" ? "Codex" : "Claude"}`,
    );
  };

  const selectModel = async (model: string): Promise<void> => {
    if ((activeThread?.model ?? "") === model) {
      return;
    }

    await applyLaunchSetting({ model: model || undefined }, `Model set to ${modelLabel(activeThread?.runtime ?? "claude", model)}`);
  };

  const selectEffort = async (effort: string): Promise<void> => {
    if ((activeThread?.effort ?? "") === effort) {
      return;
    }

    await applyLaunchSetting({ effort: effort || undefined }, `Reasoning set to ${effortLabel(activeThread?.runtime ?? "claude", effort)}`);
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
    setQuickStartModel(runtime === "codex" ? defaultCodexModel : defaultModel);
    setQuickStartEffort(runtime === "codex" ? defaultCodexEffort : defaultEffort);
    setQuickStartPermissionMode(runtime === "codex" ? defaultCodexSandbox : defaultPermissionMode);
  };

  const stopSession = async (): Promise<void> => {
    if (!activeThread) {
      return;
    }

    logRenderer("session:stop-request", { id: activeThread.id });
    await desktopApi.stopSession({ id: activeThread.id });
    clearIdleTimer(activeThread.id);
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
          name: file.name || imageAttachmentNameFromPath(directPath),
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
        name: file.name || imageAttachmentNameFromPath(result.path),
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
  const setBtwDraft = useCallback(
    (value: string) => {
      setBtwDraftByThread((current) => ({ ...current, [activeDraftKey]: value }));
    },
    [activeDraftKey],
  );

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

  const submitBtw = useCallback((): void => {
    if (!activeThread || activeBtw.running) {
      return;
    }
    const question = (btwDraftByThread[activeDraftKey] ?? "").trim();
    if (!question) {
      return;
    }
    setBtwDraftByThread((current) => ({ ...current, [activeDraftKey]: "" }));
    void askBtw(activeThread.id, question);
  }, [activeThread, activeBtw.running, btwDraftByThread, activeDraftKey, askBtw]);

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

  // Prompt history rows. Only assembled while the dialog is open — the source
  // conversation grows on every streamed item, and this list has no business
  // re-deriving itself behind a closed dialog.
  const promptHistorySent = useMemo<PromptHistoryRecord[]>(() => {
    if (!promptHistoryOpen || !activeThread) {
      return [];
    }
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    // Newest first so the last prompt sits on top.
    const newestFirst = (conversationItems[activeThread.id] ?? [])
      .filter((item) => item.kind === "user" && item.body.trim().length > 0)
      .reverse();
    // Collapse the optimistic local echo against its server copy.
    return newestFirst
      .filter((item, index) => {
        const prev = newestFirst[index - 1];
        return !prev || normalize(prev.body) !== normalize(item.body);
      })
      .map((item) => {
        const images = attachedImagePathsFromBody(item.body);
        return {
          id: item.id,
          // The trailing "Attached image files:" list is plumbing, not prompt.
          text: images.length > 0 ? bodyWithoutAttachedImageList(item.body) : item.body,
          attachments: images.length,
          timestamp: item.timestamp,
          queued: false,
        };
      });
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
    const isReady = wasRunning || (await startThreadSession(launchThread));
    if (!isReady) {
      logRenderer("prompt:start-before-send-failed", { threadId: thread.id });
      sendingPromptRef.current = false;
      setIsSendingPrompt(false);
      return false;
    }

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
          id: `local:${thread.id}:${submittedAt}`,
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
  const queuePrompt = (): void => {
    const thread = activeThread;
    if (!thread) {
      return;
    }
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
      queuePrompt();
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
    setPreviewImage({ path, url: localImageUrl(path) });
  }, []);

  const handlePreviewStagedAttachment = useCallback((attachment: ImageAttachment): void => {
    setPreviewImage({ path: attachment.path, url: attachment.previewUrl });
  }, []);

  const threadWorking = Boolean(activeThread && activeThread.status === "running" && activeThread.agentState === "working");

  // Memoized so typing in the composer (which re-renders App on every
  // keystroke) does not rebuild the whole feed or re-parse every message's
  // markdown. Mid-turn flags are computed in one backward pass instead of the
  // O(n²) per-item scan.
  const conversationFeed = useMemo(() => {
    // Items a subagent produced are nested under their agent card, not shown at
    // the top level. Collect them by the owning agent's tool_use id (their
    // parentAgentId); an orphan whose agent card never arrived falls back to the
    // top level so nothing silently disappears.
    const agentToolUseIds = new Set<string>();
    for (const item of activeConversation) {
      if (item.kind === "agent" && item.agent) {
        agentToolUseIds.add(item.agent.toolUseId);
      }
    }
    const childrenByAgent = new Map<string, ConversationItem[]>();
    const topLevel: ConversationItem[] = [];
    for (const item of activeConversation) {
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
    let laterMeaningfulKind: ConversationItem["kind"] | null = null;
    for (let index = topLevel.length - 1; index >= 0; index--) {
      const item = topLevel[index];
      if (!item) {
        continue;
      }
      const thinking = isThinkingItem(item);
      if (item.kind === "assistant" && !thinking) {
        midTurnById.set(item.id, laterMeaningfulKind === null ? threadWorking : laterMeaningfulKind !== "user");
      }
      // The turn-summary footer is a caption, not turn activity: it must not
      // flip the assistant reply it trails into a mid-turn passage.
      if (item.kind !== "marker" && !thinking && !isTurnSummaryItem(item)) {
        laterMeaningfulKind = item.kind;
      }
    }

    return topLevel.map((item) => {
      if (item.kind === "agent" && item.agent) {
        // Agent cards default to expanded so the subagent's transcript stays
        // visible instead of collapsing to a one-line header once its card
        // arrives; for these ids presence in the set means the user collapsed
        // it (the inverse of every other item, whose default is collapsed).
        return (
          <AgentCard
            childItems={childrenByAgent.get(item.agent.toolUseId) ?? []}
            expanded={!expandedConversationItems.has(item.id)}
            expandedChildIds={expandedConversationItems}
            item={item}
            key={item.id}
            onPreviewImage={handlePreviewImage}
            onToggle={toggleConversationItem}
            onToggleChild={toggleConversationItem}
          />
        );
      }
      const thinking = isThinkingItem(item);
      const collapsedByDefault = item.kind === "tool" || item.kind === "system" || thinking;
      return (
        <ConversationCard
          expanded={!collapsedByDefault || expandedConversationItems.has(item.id)}
          item={item}
          key={item.id}
          midTurn={midTurnById.get(item.id) ?? false}
          onPreviewImage={handlePreviewImage}
          onToggle={toggleConversationItem}
        />
      );
    });
  }, [activeConversation, expandedConversationItems, threadWorking, handlePreviewImage, toggleConversationItem]);

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

  const openWorkspaceGit = useCallback(
    (cwd: string): void => {
      setGitWorkspace(cwd);
      setGitStatus(null);
      void fetchWorkspaceGit(cwd);
    },
    [fetchWorkspaceGit],
  );

  const closeWorkspaceGit = useCallback((): void => {
    setGitWorkspace(null);
    setGitStatus(null);
  }, []);

  useEffect(() => {
    if (!gitWorkspace) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeWorkspaceGit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gitWorkspace, closeWorkspaceGit]);

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
  const renderThreadItem = (thread: Thread): React.ReactElement => {
    const terminalCount = terminalTabsByThread[thread.id]?.length ?? 0;

    return (
      <button
        className={`thread-item ${thread.id === activeId ? "active" : ""} ${
          attentionThreadIds.has(thread.id) ? "needs-attention" : ""
        }`}
        key={thread.id}
        type="button"
        onClick={() => setActiveThreadId(thread.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          setActiveThreadId(thread.id);
          setContextMenu({ threadId: thread.id, x: event.clientX, y: event.clientY });
        }}
      >
        <AgentBadge compact state={thread.agentState} />
        <span className="thread-copy">
          <strong>
            {thread.starred ? <Star size={11} className="thread-star" aria-hidden="true" /> : null}
            <span className="thread-title-text">{thread.title}</span>
            {terminalCount > 0 ? (
              <span
                className="thread-terminal-count"
                title={`${terminalCount} active terminal${terminalCount === 1 ? "" : "s"}`}
                aria-label={`${terminalCount} active terminal${terminalCount === 1 ? "" : "s"}`}
              >
                <TerminalSquare size={11} aria-hidden="true" />
                <span>{terminalCount}</span>
              </span>
            ) : null}
          </strong>
        </span>
        <time title={thread.lastPromptAt ? `Last prompt ${formatTime(thread.lastPromptAt)}` : "No prompt submitted"}>
          {relativeAge(thread.lastPromptAt)}
        </time>
      </button>
    );
  };

  return (
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
                {(terminalTabsByThread[DRAFT_THREAD_ID]?.length ?? 0) > 0 ? (
                  <span
                    className="thread-terminal-count"
                    title={`${terminalTabsByThread[DRAFT_THREAD_ID]?.length} active terminal${
                      terminalTabsByThread[DRAFT_THREAD_ID]?.length === 1 ? "" : "s"
                    }`}
                  >
                    <TerminalSquare size={11} aria-hidden="true" />
                    <span>{terminalTabsByThread[DRAFT_THREAD_ID]?.length}</span>
                  </span>
                ) : null}
              </strong>
            </span>
            {draftHasContent ? <span className="draft-dot" title="Unsent draft" aria-label="Unsent draft" /> : null}
          </button>
          {starredThreads.length > 0 ? (
            <section className="starred-group" aria-label="Starred sections">
              <div className="starred-group-header">
                <Star size={13} className="thread-star" aria-hidden="true" />
                <span>Starred</span>
              </div>
              <div className="thread-list starred-thread-list">
                {starredThreads.map((thread) => renderThreadItem(thread))}
              </div>
            </section>
          ) : null}
          {previewWorkspaceGroups.map((group) => {
            const expanded = expandedWorkspaces.has(group.cwd);
            const hasActiveThread = group.threads.some((thread) => thread.id === activeThread.id);
            const visibleCount = Math.min(
              visibleSessionCounts[group.cwd] ?? INITIAL_VISIBLE_SESSIONS,
              group.threads.length,
            );
            const canShowMore = visibleCount < group.threads.length;
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
              <div className="workspace-group-header">
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
                    title="Workspace git status"
                  >
                    <GitBranch size={14} aria-hidden="true" />
                  </button>
                )}
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
                  {group.threads.slice(0, visibleCount).map((thread) => renderThreadItem(thread))}
                </div>
                {scratchGroup && group.threads.length === 0 ? (
                  <button className="workspace-empty-hint" type="button" onClick={() => void addScratchThread()}>
                    <Plus size={13} aria-hidden="true" />
                    Start a section with no project
                  </button>
                ) : null}
                {group.threads.length > INITIAL_VISIBLE_SESSIONS ? (
                  <div className="thread-list-more">
                    {canShowMore ? (
                      <button
                        className="thread-more-button"
                        type="button"
                        onClick={() => showMoreSessions(group.cwd, group.threads.length)}
                      >
                        <ChevronDown size={13} aria-hidden="true" />
                        Show {Math.min(VISIBLE_SESSIONS_STEP, group.threads.length - visibleCount)} more
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

        <div className="usage-card" aria-label={`${agentDisplayName(usageProvider)} plan usage`}>
          <div className="usage-card-header">
            <span className="usage-card-title">
              <Gauge size={13} aria-hidden="true" />
              <span>Plan usage</span>
            </span>
            <span className="usage-card-actions">
              <span className="usage-provider-toggle" role="group" aria-label="Usage provider">
                {RUNTIME_OPTIONS.map((option) => (
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
                onClick={() => refreshUsageRef.current()}
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

      <section className="workspace">
        <div className="workspace-top">
        <header className="topbar">
          <div className="title-row">
            <button
              className="icon-button"
              type="button"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label="Toggle sidebar"
              title="Toggle sidebar"
            >
              <LayoutPanelLeft size={18} aria-hidden="true" />
            </button>
            {isRenaming ? (
              <div className="rename-row">
                <input
                  autoFocus
                  className="title-input"
                  value={renameDraft}
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
                <h1>{activeThread.title}</h1>
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
            {activeConversation.length > 0 ? (
              conversationFeed
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

          {activeBtw.open ? (
            <div className="btw-panel" role="dialog" aria-label="By the way — session side chat">
              <div className="btw-panel-header">
                <span className="btw-panel-title">
                  <Sparkles size={14} aria-hidden="true" />
                  By the way
                  {activeBtw.running ? <span className="btw-live-dot" aria-hidden="true" /> : null}
                </span>
                <span className="btw-panel-sub">Asks about this session — never interrupts it</span>
                <div className="btw-panel-actions">
                  <button
                    type="button"
                    className="btw-panel-action"
                    onClick={() => clearBtwThread(activeThread.id)}
                    disabled={activeBtw.items.length === 0 && !activeBtw.running}
                    title="Clear this side-chat and start fresh"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    Clear
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
                    const thinking = isThinkingItem(item);
                    const collapsedByDefault = item.kind === "tool" || item.kind === "system" || thinking;
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
              <div className="btw-composer">
                <textarea
                  value={btwDraft}
                  onChange={(event) => setBtwDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submitBtw();
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
                <button
                  type="button"
                  className="btw-send"
                  onClick={submitBtw}
                  disabled={activeBtw.running || !btwDraft.trim()}
                >
                  <Send size={14} aria-hidden="true" />
                  Ask
                </button>
              </div>
            </div>
          ) : null}

          <WorkingStatusBar
            state={activeThread.agentState}
            detail={activeThread.agentState === "working" ? compactLine(activeRuntimeStatus?.latestCommand ?? activeRuntimeStatus?.latestTool ?? "") || undefined : undefined}
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
              shortcutHints={COMPOSER_SHORTCUT_HINTS}
              textRef={composerTextRef}
              onHasTextChange={setComposerHasText}
              onEnter={onComposerEnter}
              onPaste={onComposerPaste}
              onCommit={commitComposerDraft}
            />
            {/* Stop is offered while the agent is actually WORKING. Keying it off
                `status === "running"` (the process being alive) put a stop button
                next to a "Ready" badge, with nothing to stop and no send button. */}
            {threadWorking && !composerHasText && imageAttachments.length === 0 ? (
              <button
                className="composer-fab composer-fab--stop"
                type="button"
                onClick={() => void stopSession()}
                aria-label={`Stop this section's ${agentDisplayName(activeThread.runtime)} process`}
                title={`Stop this section's ${agentDisplayName(activeThread.runtime)} process`}
              >
                <span className="stop-glyph" aria-hidden="true" />
              </button>
            ) : threadWorking && (composerHasText || imageAttachments.length > 0) ? (
              <button
                className="composer-fab composer-fab--queue"
                type="button"
                onClick={queuePrompt}
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
      </section>

      {contextMenu && contextThread ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
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
            aria-label={imageAttachmentNameFromPath(previewImage.path)}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="image-preview-toolbar">
              <div>
                <strong>{imageAttachmentNameFromPath(previewImage.path)}</strong>
                <span>{previewImage.path}</span>
              </div>
              <button className="ghost-icon-button" type="button" onClick={() => setPreviewImage(null)} aria-label="Close image preview">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <img alt={imageAttachmentNameFromPath(previewImage.path)} src={previewImage.url} />
          </div>
        </div>
      ) : null}

      {promptHistoryOpen ? (
        <div className="quick-start-backdrop" role="presentation" onClick={() => setPromptHistoryOpen(false)}>
          <PromptHistoryDialog
            sent={promptHistorySent}
            queued={promptHistoryQueued}
            onClose={() => setPromptHistoryOpen(false)}
            onReuse={reuseComposerText}
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
                open={quickStartSelectorOpen}
                onToggle={setQuickStartSelectorOpen}
                onSelectRuntime={selectQuickStartRuntime}
                onSelectModel={setQuickStartModel}
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
            <textarea
              autoFocus
              className="quick-start-input"
              value={quickStartDraft}
              onChange={(event) => setQuickStartDraft(event.target.value)}
              onPaste={handleQuickStartPaste}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitQuickStart();
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
              <button
                className="primary-action"
                type="button"
                onClick={submitQuickStart}
                disabled={!quickStartDraft.trim() && quickStartAttachments.length === 0}
              >
                <Send size={14} aria-hidden="true" />
                Start
              </button>
            </div>
          </div>
        </div>
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

            <div className="git-drawer-body">
              {gitLoading && !gitStatus ? <div className="git-empty">Reading git status…</div> : null}

              {gitStatus && !gitStatus.isRepo ? (
                <>
                  <div className="git-empty">{gitStatus.error ?? "Not a git repository."}</div>
                  {gitStatus.folders.length > 0 ? (
                    <section className="git-section">
                      <div className="git-section-head">
                        <span>Folders</span>
                        <em>{gitStatus.folders.length}</em>
                      </div>
                      <ul className="git-list">
                        {gitStatus.folders.map((folder) => (
                          <li key={folder} className="git-row">
                            <Folder size={13} aria-hidden="true" />
                            <span>{folder}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </>
              ) : null}

              {gitStatus && gitStatus.isRepo ? (
                <>
                  <section className="git-section">
                    <div className="git-branch-current">
                      <GitBranch size={14} aria-hidden="true" />
                      <strong>{gitStatus.branch ?? "(detached)"}</strong>
                      {gitStatus.ahead ? <span className="git-badge">↑{gitStatus.ahead}</span> : null}
                      {gitStatus.behind ? <span className="git-badge">↓{gitStatus.behind}</span> : null}
                    </div>
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

                  <section className="git-section">
                    <div className="git-section-head">
                      <span>Folders</span>
                      <em>{gitStatus.folders.length}</em>
                    </div>
                    <ul className="git-list">
                      {gitStatus.folders.map((folder) => (
                        <li key={folder} className="git-row">
                          <Folder size={13} aria-hidden="true" />
                          <span>{folder}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
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
              <div className="remote-device-list">
                {remoteDevices.length === 0 ? (
                  <p>No paired phones yet.</p>
                ) : (
                  remoteDevices.map((device) => (
                    <div className="remote-device-row" key={device.mobileId}>
                      <div>
                        <strong>{device.name?.trim() || "Panda Code Mobile"}</strong>
                        <span>{new Date(device.createdAt).toLocaleDateString()}</span>
                      </div>
                      <button
                        className="ghost-icon-button"
                        type="button"
                        onClick={() => void desktopApi.revokeRemotePairedDevice(device.mobileId).then(setRemoteDevices)}
                        aria-label="Revoke phone"
                        title="Revoke phone"
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
                onSelect={(value) => setDefaultRuntime(value === "codex" ? "codex" : "claude")}
              />
              <p>New sections launch with this coding agent. Existing sections keep their own provider.</p>
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

            <p className="settings-section-note">
              Each provider keeps its own model, effort, and permission defaults — switching the default provider
              above never rewrites the other one&apos;s settings.
            </p>

            <RuntimeDefaults
              runtime="claude"
              isDefault={defaultRuntime === "claude"}
              model={defaultModel}
              effort={defaultEffort}
              permissionMode={defaultPermissionMode}
              onSelectModel={setDefaultModel}
              onSelectEffort={setDefaultEffort}
              onSelectPermission={setDefaultPermissionMode}
            />

            <RuntimeDefaults
              runtime="codex"
              isDefault={defaultRuntime === "codex"}
              model={defaultCodexModel}
              effort={defaultCodexEffort}
              permissionMode={defaultCodexSandbox}
              onSelectModel={setDefaultCodexModel}
              onSelectEffort={setDefaultCodexEffort}
              onSelectPermission={setDefaultCodexSandbox}
            />
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

            <div className="settings-panel" role="tabpanel" hidden={settingsTab !== "notifications"}>
            <div className="settings-field">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={notificationsEnabled}
                  onChange={(event) => setNotificationsEnabled(event.target.checked)}
                />
                <span>Notify when a section finishes</span>
              </label>
              <p>Shows a macOS notification and a dock badge when Claude finishes a turn while you are away from that section.</p>
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
  );
}
