import type {
  AgentActivity,
  AgentRuntime,
  AgentState,
  ConversationItem,
  PendingApproval,
  SessionRuntimeEvent,
  TokenUsageStats,
} from "./ipc";
import { stripDeveloperInstructions } from "./agent-prompts";

export type StreamJsonParseResult =
  | {
      ok: true;
      event: StreamJsonEvent;
    }
  | {
      ok: false;
      error: string;
      line: string;
    };

export type StreamJsonEvent = Record<string, unknown>;

export type StreamJsonState = {
  items: ConversationItem[];
  tokenUsage: TokenUsageStats;
  agentState: AgentState;
  currentEventType: string;
  lastEventAt?: string;
  latestTool?: string;
  latestCommand?: string;
  latestModel?: string;
  latestAssistantText?: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  activeAssistantMessageId?: string;
  sequence: number;
  // Turn accounting for the end-of-turn stats footer: when the current turn
  // began (wall clock, ms) and the cumulative token count at that moment, so a
  // `result`/`turn.completed` event can report how long the turn took and how
  // many tokens it consumed. Cleared once the summary item is emitted.
  turnStartedAt?: number;
  turnStartTokens?: number;
  // Subagent (Task/Agent tool) accounting. `activeParentAgentId` is a transient
  // carrier set from the current event's `parent_tool_use_id` so pushItem can
  // stamp every item a subagent produces with its owning agent. `agentToolUseIds`
  // remembers which tool_use ids belong to spawned agents so their echoed
  // tool_use/tool_result items (redundant with the agent card + nested feed) are
  // suppressed.
  activeParentAgentId?: string;
  agentToolUseIds?: string[];
  // Codex (app-server) is blocked on an approval or a question and the section
  // sits at `needs_action` until it is answered. Owned by
  // CodexAppServerSessionManager, mirrored here so it rides the normal snapshot
  // to the renderer and the relay.
  pendingApproval?: PendingApproval;
};

const emptyTokenUsage = (): TokenUsageStats => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
});

export function createStreamJsonState(): StreamJsonState {
  return {
    items: [],
    tokenUsage: emptyTokenUsage(),
    agentState: "waiting",
    currentEventType: "init",
    sequence: 0,
  };
}

export function parseStreamJsonLine(line: string): StreamJsonParseResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty stream-json line.", line };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Stream-json line is not an object.", line };
    }

    return { ok: true, event: parsed as StreamJsonEvent };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid stream-json line.",
      line,
    };
  }
}

// Conversation item ids are shared between the live stream and the JSONL
// transcript reader (main/index.ts). Claude Code emits the same uuid/message
// id/tool-use id on stdout and in the persisted transcript, so building ids
// from those keys lets mergeConversationItems dedupe across both sources
// instead of wholesale-replacing the feed.
export function messageItemId(messageId: string): string {
  return `stream:${messageId}`;
}

export function thinkingItemId(messageId: string, index: number): string {
  return `stream:${messageId}:thinking:${index}`;
}

export function toolUseItemId(toolUseId: string): string {
  return `stream:${toolUseId}:tool`;
}

export function toolResultItemId(toolUseId: string): string {
  return `stream:${toolUseId}:result`;
}

// A subagent card is keyed by the spawning tool_use id — the same id every
// child item carries as `parentAgentId`, so the renderer can join them.
export function agentCardItemId(toolUseId: string): string {
  return `agent:${toolUseId}`;
}

// The end-of-turn stats footer ("Worked for 12s · 3.4k tokens"). It rides the
// normal conversation stream as a `system` item so it flows to the relay/mobile
// and sorts right after the turn's final assistant message. Both renderers
// detect it by its id suffix and title and style it as a subtle footer.
export const TURN_SUMMARY_TITLE = "Turn summary";

export function turnSummaryItemId(anchor: string): string {
  return `stream:${anchor}:summary`;
}

export function isTurnSummaryItem(item: Pick<ConversationItem, "id" | "kind">): boolean {
  return item.kind === "system" && item.id.startsWith("stream:") && item.id.endsWith(":summary");
}

export function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "";
  }
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

export function formatTurnTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return String(value);
}

const BODY_CAP = 25_000;

function compactBody(value: string, maxLength = BODY_CAP): string {
  // Strip trailing *horizontal* whitespace only. `\s+\n` looks equivalent but
  // `\s` matches `\n` too, so it ate the blank line between every paragraph and
  // the whole reply rendered as one squeezed block.
  const normalized = value.replace(/[^\S\n]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function stringifyRecord(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventType(event: StreamJsonEvent): string {
  const nested = asRecord(event.event);
  const nestedType = nested ? [asString(nested.type), asString(nested.subtype)].filter(Boolean).join(":") : undefined;
  return [asString(event.type), nestedType ?? asString(event.subtype)].filter(Boolean).join(":") || "event";
}

function sessionIdFromEvent(event: StreamJsonEvent): string | undefined {
  const message = asRecord(event.message);
  return (
    asString(event.session_id) ??
    asString(event.sessionId) ??
    asString(message?.session_id) ??
    asString(message?.sessionId)
  );
}

function codexThreadIdFromEvent(event: StreamJsonEvent): string | undefined {
  return asString(event.thread_id) ?? asString(event.threadId);
}

function contentParts(content: unknown): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return Array.isArray(content) ? content : [];
}

function textFromContent(content: unknown): string {
  return contentParts(content)
    .flatMap((part) => {
      const record = asRecord(part);
      if (!record) {
        return [];
      }

      if (record.type === "tool_result") {
        return [];
      }

      return [asString(record.text) ?? asString(record.content) ?? ""];
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

// Long base64 payloads (image attachments, embedded files) make tool JSON
// unreadable and blow past the body length cap before anything useful appears.
const EMBEDDED_DATA_MIN_LENGTH = 1_000;

function approximateBase64Kb(value: string): number {
  return Math.max(1, Math.round((value.length * 3) / 4 / 1024));
}

function sanitizeEmbeddedData(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > EMBEDDED_DATA_MIN_LENGTH && /^[A-Za-z0-9+/=_-]+$/.test(value)
      ? `<base64 data omitted — ~${approximateBase64Kb(value)} KB>`
      : value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeEmbeddedData);
  }

  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, sanitizeEmbeddedData(entry)]));
  }

  return value;
}

export function jsonCodeBlock(value: unknown): string {
  try {
    return `\`\`\`json\n${JSON.stringify(sanitizeEmbeddedData(value), null, 2)}\n\`\`\``;
  } catch {
    return stringifyRecord(value);
  }
}

function formatJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return text;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? jsonCodeBlock(parsed) : text;
  } catch {
    return text;
  }
}

function imagePartPlaceholder(record: Record<string, unknown>): string {
  const source = asRecord(record.source);
  const data = asString(source?.data);
  const mediaType = asString(source?.media_type);
  return `[Image${mediaType ? ` ${mediaType}` : ""}${data ? ` — ~${approximateBase64Kb(data)} KB` : ""}]`;
}

export function toolInputBody(input: unknown): string {
  const record = asRecord(input);
  if (!record) {
    return stringifyRecord(input);
  }

  const description = asString(record.description);
  const command = asString(record.command);
  const filePath = asString(record.file_path);
  return [description, command, filePath].filter(Boolean).join("\n") || jsonCodeBlock(record);
}

export function toolResultBody(content: unknown): string {
  if (typeof content === "string") {
    return formatJsonText(content);
  }

  const parts = Array.isArray(content) ? content : [content];
  const rendered = parts
    .map((part) => {
      const record = asRecord(part);
      if (!record) {
        return typeof part === "string" ? formatJsonText(part) : stringifyRecord(part);
      }

      if (record.type === "text" && typeof record.text === "string") {
        return formatJsonText(record.text);
      }

      if (record.type === "image") {
        return imagePartPlaceholder(record);
      }

      return jsonCodeBlock(record);
    })
    .filter(Boolean);

  return rendered.join("\n\n") || stringifyRecord(content);
}

function commandFromToolInput(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }

  return asString(record.command) ?? asString(record.file_path) ?? asString(record.description);
}

const DELTA_BODY_CAP = 40_000;

// Streaming deltas and the final full message deliver the same text twice, and
// only whitespace can differ between the copies (delta accumulation used to
// normalize/trim chunk boundaries). Comparing with all whitespace stripped is
// what lets the full message reliably supersede the accumulation.
export function strippedBodyForComparison(value: string): string {
  return value.replace(/\s+/g, "");
}

function addOrCoalesceAssistant(state: StreamJsonState, item: ConversationItem, delta: boolean): void {
  const existingIndex = state.items.findIndex((candidate) => candidate.id === item.id && candidate.kind === "assistant");
  if (existingIndex === -1) {
    state.items.push(item);
    return;
  }

  const existing = state.items[existingIndex];
  if (!existing) {
    state.items.push(item);
    return;
  }

  let nextBody: string;
  if (delta) {
    // Deltas are raw continuations of the previous chunk. Never trim or
    // normalize the partial body here: trimming used to eat the newline at a
    // chunk boundary, the corrupted accumulation then failed the comparison
    // with the final full message, and the whole reply rendered twice.
    const appended = `${existing.body}${item.body}`;
    nextBody = appended.length > DELTA_BODY_CAP ? appended.slice(0, DELTA_BODY_CAP) : appended;
  } else {
    const existingStripped = strippedBodyForComparison(existing.body);
    const incomingStripped = strippedBodyForComparison(item.body);
    if (incomingStripped.startsWith(existingStripped)) {
      // The canonical full message covers everything streamed so far; its
      // normalized body replaces the raw delta accumulation.
      nextBody = item.body;
    } else if (existingStripped.includes(incomingStripped)) {
      // Re-delivery of text we already have (e.g. a per-content-block event
      // arriving after later deltas, or a resume replay).
      nextBody = existing.body;
    } else {
      nextBody = compactBody(`${existing.body}${item.body}`);
    }
  }

  state.items[existingIndex] = {
    ...existing,
    ...item,
    body: nextBody,
    sequence: existing.sequence,
  };
}

function pushItem(state: StreamJsonState, item: Omit<ConversationItem, "sequence">, delta = false): void {
  // Any item emitted while a subagent event is being applied inherits that
  // agent as its parent, unless the item already declares its own (the agent
  // card itself is top-level and passes parentAgentId: undefined explicitly).
  const parentAgentId = "parentAgentId" in item ? item.parentAgentId : state.activeParentAgentId;
  const itemWithSequence = { ...item, parentAgentId, sequence: state.sequence++ };
  if (itemWithSequence.kind === "assistant") {
    addOrCoalesceAssistant(state, itemWithSequence, delta);
    return;
  }

  if (!state.items.some((existing) => existing.id === itemWithSequence.id)) {
    state.items.push(itemWithSequence);
  }
}

function addUsage(total: TokenUsageStats, usage: unknown, replace = false): void {
  const record = asRecord(usage);
  if (!record) {
    return;
  }

  const next = {
    inputTokens: Number(record.input_tokens ?? record.inputTokens ?? 0),
    outputTokens: Number(record.output_tokens ?? record.outputTokens ?? 0) + Number(record.reasoning_output_tokens ?? 0),
    cacheCreationInputTokens: Number(record.cache_creation_input_tokens ?? record.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: Number(record.cache_read_input_tokens ?? record.cacheReadInputTokens ?? record.cached_input_tokens ?? 0),
  };
  const nextTotal = Number(record.total_tokens ?? 0) || next.inputTokens + next.outputTokens + next.cacheCreationInputTokens + next.cacheReadInputTokens;

  if (replace && nextTotal >= total.totalTokens) {
    total.inputTokens = next.inputTokens;
    total.outputTokens = next.outputTokens;
    total.cacheCreationInputTokens = next.cacheCreationInputTokens;
    total.cacheReadInputTokens = next.cacheReadInputTokens;
    total.totalTokens = nextTotal;
    return;
  }

  if (replace) {
    return;
  }

  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cacheCreationInputTokens += next.cacheCreationInputTokens;
  total.cacheReadInputTokens += next.cacheReadInputTokens;
  total.totalTokens =
    total.inputTokens + total.outputTokens + total.cacheCreationInputTokens + total.cacheReadInputTokens;
}

function applyContentParts(
  state: StreamJsonState,
  event: StreamJsonEvent,
  role: "assistant" | "user",
  content: unknown,
  timestamp: string,
): void {
  const message = asRecord(event.message);
  const messageId = asString(message?.id) ?? asString(event.uuid) ?? `${role}:${state.sequence}`;
  const model = asString(message?.model);
  const text = textFromContent(content);

  if (text) {
    if (role === "assistant") {
      if (model) state.latestModel = model;
      // Short snippet for the mobile session-list preview.
      state.latestAssistantText = compactBody(text).slice(0, 160);
    }
    pushItem(state, {
      id: messageItemId(messageId),
      kind: role,
      title: role === "assistant" ? "Claude" : undefined,
      body: compactBody(text),
      timestamp,
      // Only set when known: addOrCoalesceAssistant spreads the incoming item
      // over the existing one, and an explicit undefined would erase it.
      ...(role === "assistant" && model ? { model } : {}),
    });
  }

  for (const [index, part] of contentParts(content).entries()) {
    const record = asRecord(part);
    if (!record) {
      continue;
    }

    if (record.type === "thinking" || record.type === "redacted_thinking") {
      pushItem(state, {
        id: thinkingItemId(messageId, index),
        kind: "system",
        title: "Thinking",
        body:
          asString(record.thinking) ??
          asString(record.text) ??
          "Private reasoning step. Claude Code records that thinking happened, but does not expose readable thinking text.",
        timestamp,
      });
    }

    if (record.type === "tool_use") {
      const name = asString(record.name) ?? "Tool call";
      // The Task/Agent tool spawns a subagent that gets its own `agent` card
      // (from task_started) plus its nested transcript, so the raw tool_use row
      // would just duplicate it. Skip it.
      if (name === "Agent" || name === "Task") {
        continue;
      }
      const command = commandFromToolInput(record.input);
      state.latestTool = name;
      state.latestCommand = command ?? state.latestCommand;
      const toolUseId = asString(record.id);
      pushItem(state, {
        id: toolUseId ? toolUseItemId(toolUseId) : `stream:${messageId}:tool:${index}`,
        kind: "tool",
        title: name,
        body: compactBody(toolInputBody(record.input)),
        timestamp,
      });
    }

    if (record.type === "tool_result") {
      const toolUseId = asString(record.tool_use_id);
      // The subagent's final output is already rendered inside its card via the
      // child's own assistant message; the tool_result echo is redundant.
      if (toolUseId && state.agentToolUseIds?.includes(toolUseId)) {
        // Except for a background shell, whose result is only the launch
        // acknowledgement — it names the file Claude streams the real output
        // to, and that file is the sole source of the task's output. Keep the
        // path so the main process can tail it into the card.
        captureTaskOutputFile(state, toolUseId, toolResultBody(record.content));
        continue;
      }
      pushItem(state, {
        id: toolUseId ? toolResultItemId(toolUseId) : `stream:${messageId}:result:${index}`,
        kind: "tool",
        title: "Tool result",
        body: compactBody(toolResultBody(record.content)),
        timestamp,
      });
    }
  }
}

function applyDeltaText(state: StreamJsonState, event: StreamJsonEvent, timestamp: string): void {
  const delta = asRecord(event.delta);
  // Not asString(): it rejects whitespace-only values, and a chunk that is
  // just "\n" is a real part of the reply — dropping it corrupts the
  // accumulated body.
  const rawDelta = delta?.text ?? event.text;
  const text = typeof rawDelta === "string" && rawDelta ? rawDelta : undefined;
  if (!text) {
    return;
  }

  pushItem(
    state,
    {
      id: `stream:${asString(event.message_id) ?? asString(event.messageId) ?? state.activeAssistantMessageId ?? "assistant-delta"}`,
      kind: "assistant",
      title: "Claude",
      body: text,
      timestamp,
    },
    true,
  );
}

function updateStateFromEventType(state: StreamJsonState, event: StreamJsonEvent): void {
  const type = asString(event.type) ?? "";
  const subtype = asString(event.subtype) ?? "";
  const lowered = `${type}:${subtype}`.toLowerCase();

  if (lowered.includes("permission") || lowered.includes("approval") || lowered.includes("needs_action")) {
    state.agentState = "needs_action";
    return;
  }

  if (type === "result") {
    state.agentState = "waiting";
    return;
  }

  if (type === "turn.completed") {
    // `codex exec --json` is a one-shot process. The authoritative idle signal
    // comes from the process close handler, which can also restart a deferred
    // follow-up prompt. Reporting waiting here creates a false ready window.
    state.agentState = "working";
    return;
  }

  if (type === "error" || type === "turn.failed" || subtype === "error" || event.is_error === true) {
    state.agentState = "needs_action";
    return;
  }

  if (type === "system" && subtype === "init") {
    state.agentState = "waiting";
    return;
  }

  state.agentState = "working";
}

function agentCardBody(agent: AgentActivity): string {
  const parts: string[] = [];
  if (agent.subagentType) parts.push(agent.subagentType);
  parts.push(agent.status);
  // A running card reports live progress (`task_progress`); a finished one
  // reports the final accounting from `task_notification`.
  if (agent.status === "running") {
    if (agent.lastTool) parts.push(agent.lastTool);
  }
  if (typeof agent.totalTokens === "number" && agent.totalTokens > 0) parts.push(`${formatTurnTokens(agent.totalTokens)} tok`);
  if (agent.status !== "running" && typeof agent.durationMs === "number" && agent.durationMs > 0) {
    parts.push(formatTurnDuration(agent.durationMs));
  }
  return parts.filter(Boolean).join(" · ");
}

// A background shell's launch acknowledgement reads:
//   "Command running in background with ID: <id>. Output is being written to:
//    <path>"
// That path is where the shell's stdout/stderr actually lands — none of it ever
// reaches the event stream — so record it on the card.
const TASK_OUTPUT_FILE_PATTERN = /Output is being written to:\s*(\S+?)\.?(?:\s|$)/;

function captureTaskOutputFile(state: StreamJsonState, toolUseId: string, body: string): void {
  const path = TASK_OUTPUT_FILE_PATTERN.exec(body)?.[1];
  if (!path) {
    return;
  }
  updateAgentCard(state, { toolUseId }, (agent) => {
    agent.outputFile = path;
  });
}

// Find the `agent` card for a lifecycle event and mutate its state in place.
// `task_started` carries both ids; `task_updated` carries only the task id, so
// we match on either. Refreshes the card body from the updated agent.
function updateAgentCard(
  state: StreamJsonState,
  keys: { taskId?: string; toolUseId?: string },
  mutate: (agent: AgentActivity) => void,
): void {
  const card = state.items.find(
    (item) =>
      item.kind === "agent" &&
      item.agent !== undefined &&
      ((keys.toolUseId !== undefined && item.agent.toolUseId === keys.toolUseId) ||
        (keys.taskId !== undefined && item.agent.taskId === keys.taskId)),
  );
  if (!card?.agent) {
    return;
  }
  mutate(card.agent);
  card.body = agentCardBody(card.agent);
}

// Claude reuses the `task_*` lifecycle for two different things: real Task/Agent
// subagents (which carry a `subagent_type` and run their own nested turns) and
// fire-and-forget background Bash shells (which don't). Only a genuine subagent
// still awaited by this turn should hold the section at "working" — neither a
// background shell nor a `run_in_background` agent (which outlives the turn by
// design) may pin the spinner open.
function hasRunningAgent(state: StreamJsonState): boolean {
  return state.items.some(
    (item) =>
      item.kind === "agent" &&
      item.agent?.status === "running" &&
      item.agent.subagentType !== undefined &&
      item.agent.background !== true,
  );
}

// A card still "running" when the main agent's turn ends belongs to work that
// outlives the turn: a `run_in_background` agent or a background Bash shell.
// Flag it rather than force it to "completed" — the card keeps telling the
// truth ("running…", still accruing task_progress) while `hasRunningAgent`
// stops counting it, so the section settles and the spinner can't wedge. Its
// real terminal `task_updated`/`task_notification` lands in a later turn.
function markBackgroundAgents(state: StreamJsonState): void {
  for (const item of state.items) {
    if (item.kind === "agent" && item.agent?.status === "running" && item.agent.background !== true) {
      item.agent.background = true;
      item.body = agentCardBody(item.agent);
    }
  }
}

// Claude Code delegates work to subagents via the Task/Agent tool, emitting
// explicit lifecycle events (all `type: "system"`) alongside the tool_use:
//   task_started      { task_id, tool_use_id, description, subagent_type, prompt }
//   task_progress     { task_id, tool_use_id, description, usage, last_tool_name }
//   task_updated      { task_id, patch: { status, end_time } }
//   task_notification { task_id, tool_use_id, status, summary, usage }
// `task_started` opens an `agent`-kind card keyed by tool_use_id — the same id
// every child item carries as `parentAgentId` — and the later events update its
// status and attach the token/duration summary.
function applyClaudeTask(state: StreamJsonState, event: StreamJsonEvent, timestamp: string): void {
  if (asString(event.type) !== "system") {
    return;
  }
  const subtype = asString(event.subtype);

  if (subtype === "task_started") {
    const toolUseId = asString(event.tool_use_id);
    if (!toolUseId) {
      return;
    }
    if (!state.agentToolUseIds) {
      state.agentToolUseIds = [];
    }
    if (!state.agentToolUseIds.includes(toolUseId)) {
      state.agentToolUseIds.push(toolUseId);
    }
    const agent: AgentActivity = {
      toolUseId,
      taskId: asString(event.task_id),
      subagentType: asString(event.subagent_type),
      status: "running",
    };
    pushItem(state, {
      id: agentCardItemId(toolUseId),
      kind: "agent",
      title: asString(event.description) ?? "Agent",
      body: agentCardBody(agent),
      timestamp,
      // Top-level card even if it opens while another agent's event is active.
      parentAgentId: undefined,
      agent,
    });
    return;
  }

  // Heartbeat for a live subagent: refreshes the card's running tally and the
  // tool it is on. A background agent keeps emitting these after the spawning
  // turn ended, which is what makes its card readable instead of frozen.
  if (subtype === "task_progress") {
    const usage = asRecord(event.usage);
    const lastTool = asString(event.last_tool_name);
    updateAgentCard(state, { taskId: asString(event.task_id), toolUseId: asString(event.tool_use_id) }, (agent) => {
      const totalTokens = numberOrUndefined(usage?.total_tokens);
      if (totalTokens !== undefined) agent.totalTokens = totalTokens;
      if (lastTool) agent.lastTool = lastTool;
    });
    return;
  }

  if (subtype === "task_updated") {
    const status = asString(asRecord(event.patch)?.status);
    updateAgentCard(state, { taskId: asString(event.task_id) }, (agent) => {
      if (status === "completed") agent.status = "completed";
      else if (status === "failed" || status === "error") agent.status = "failed";
    });
    return;
  }

  if (subtype === "task_notification") {
    const status = asString(event.status);
    const usage = asRecord(event.usage);
    const summary = asString(event.summary);
    const outputFile = asString(event.output_file);
    updateAgentCard(state, { taskId: asString(event.task_id), toolUseId: asString(event.tool_use_id) }, (agent) => {
      if (status === "completed") agent.status = "completed";
      else if (status === "failed" || status === "error") agent.status = "failed";
      // A real subagent's output_file is its full JSONL transcript (already
      // rendered as nested children); only a shell task's is readable output.
      if (outputFile && agent.subagentType === undefined) agent.outputFile = outputFile;
      const totalTokens = numberOrUndefined(usage?.total_tokens);
      const durationMs = numberOrUndefined(usage?.duration_ms);
      if (totalTokens !== undefined) agent.totalTokens = totalTokens;
      if (durationMs !== undefined) agent.durationMs = durationMs;
      if (summary) agent.summary = summary;
    });
  }
}

function readableCodexErrorMessage(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown };
    const nested = parsed.error?.message ?? parsed.message;
    return typeof nested === "string" && nested.trim() ? nested : message;
  } catch {
    return message;
  }
}

function codexErrorBody(event: StreamJsonEvent): string | undefined {
  const error = asRecord(event.error);
  return readableCodexErrorMessage(
    asString(event.message) ?? asString(error?.message) ?? asString(asRecord(event.item)?.message),
  );
}

function applyCodexItem(state: StreamJsonState, event: StreamJsonEvent, timestamp: string): void {
  const item = asRecord(event.item);
  if (!item) {
    return;
  }

  const itemId = asString(item.id) ?? `codex:${state.sequence}`;
  const itemType = asString(item.type) ?? "item";
  if (itemType === "agent_message") {
    const text = asString(item.text);
    if (text) {
      pushItem(state, {
        id: messageItemId(itemId),
        kind: "assistant",
        title: "Codex",
        body: compactBody(text),
        timestamp,
      });
    }
    return;
  }

  if (itemType === "error") {
    const body = codexErrorBody(event);
    if (body) {
      pushItem(state, {
        id: `codex:error:${itemId}`,
        kind: "system",
        title: "Codex error",
        body: compactBody(body),
        timestamp,
      });
    }
    return;
  }

  if (itemType === "command_execution") {
    const command = asString(item.command);
    state.latestTool = "command_execution";
    state.latestCommand = command ?? state.latestCommand;
    pushItem(state, {
      id: toolUseItemId(itemId),
      kind: "tool",
      title: "Command",
      body: compactBody(command ?? stringifyRecord(item)),
      timestamp,
    });
    return;
  }

  if (itemType === "reasoning") {
    pushItem(state, {
      id: thinkingItemId(itemId, 0),
      kind: "system",
      title: "Thinking",
      body: "Private reasoning step. Codex records that reasoning happened, but does not expose readable reasoning text.",
      timestamp,
    });
  }
}

function applyCodexError(state: StreamJsonState, event: StreamJsonEvent, timestamp: string): void {
  const type = asString(event.type);
  if (type !== "error" && type !== "turn.failed") {
    return;
  }

  const body = codexErrorBody(event);
  if (!body) {
    return;
  }

  pushItem(state, {
    id: `codex:error:${body.slice(0, 96)}`,
    kind: "system",
    title: "Codex error",
    body: compactBody(body),
    timestamp,
  });
}

// On a turn-completing event, push the end-of-turn stats footer. Called after
// usage has been applied for this event so the token delta includes it.
function maybeEmitTurnSummary(state: StreamJsonState, event: StreamJsonEvent, receivedAt: string): void {
  const type = asString(event.type);
  if (type !== "result" && type !== "turn.completed") {
    return;
  }
  const reportedMs = Number(event.duration_ms ?? (event as { durationMs?: unknown }).durationMs ?? 0);
  pushTurnSummary(state, receivedAt, reportedMs);
}

// Emit the end-of-turn stats footer ("Worked for 12s · 3.4k tokens"). Shared by
// the exec/Claude event path (via maybeEmitTurnSummary) and the app-server
// `turn/completed` handler. `reportedMs` is the runtime's own duration when it
// supplied one, else 0 to fall back to wall-clock.
function pushTurnSummary(state: StreamJsonState, receivedAt: string, reportedMs: number): void {
  // Tokens consumed during this turn: the delta of the cumulative counter since
  // the turn began (robust across Claude/Codex). Fall back to the whole total
  // when we never captured a start (e.g. the process resumed mid-turn).
  const endTokens = state.tokenUsage.totalTokens;
  const startTokens = state.turnStartTokens ?? 0;
  const turnTokens = endTokens > startTokens ? endTokens - startTokens : endTokens;

  // Duration: the runtime's own measurement when present, else wall clock from
  // when this turn first started working.
  const endedAt = Date.parse(receivedAt);
  const wallMs = state.turnStartedAt && Number.isFinite(endedAt) ? endedAt - state.turnStartedAt : 0;
  const durationMs = reportedMs > 0 ? reportedMs : wallMs;

  const parts: string[] = [];
  const duration = formatTurnDuration(durationMs);
  if (duration) {
    parts.push(`Worked for ${duration}`);
  }
  if (turnTokens > 0) {
    parts.push(`${formatTurnTokens(turnTokens)} tokens`);
  }

  // Reset accounting for the next turn regardless of whether we render.
  state.turnStartedAt = undefined;
  state.turnStartTokens = undefined;

  if (parts.length === 0) {
    return;
  }

  const anchor =
    state.activeAssistantMessageId ?? state.claudeSessionId ?? state.codexThreadId ?? `turn:${state.sequence}`;
  pushItem(state, {
    id: turnSummaryItemId(anchor),
    kind: "system",
    title: TURN_SUMMARY_TITLE,
    body: parts.join(" · "),
    timestamp: receivedAt,
  });
}

// --- codex app-server (JSON-RPC v2) event mapping -------------------------
//
// The app-server delivers session activity as JSON-RPC *notifications* whose
// shapes differ from `codex exec --json` (camelCase `ThreadItem.type`, params
// nested under `params`, deltas + lifecycle split across methods). Rather than
// forcing them through applyStreamJsonEvent, we map them onto the same
// StreamJsonState here so the renderer/relay stay identical. See
// docs/codex-app-server-migration.md.

function firstUserInputText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      const record = asRecord(part);
      return record?.type === "text" ? [asString(record.text) ?? ""] : [];
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function fileChangeBody(changes: unknown): string {
  if (!Array.isArray(changes)) {
    return "";
  }
  return changes
    .map((change) => {
      const record = asRecord(change);
      const path = asString(record?.path);
      const diff = asString(record?.diff);
      return [path, diff].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

// Render a completed ThreadItem into the conversation feed. `item/started`
// arrives first for long-running items (command/file/tool) but carries no
// output yet, so we render on completion and use `started` only to update the
// "currently doing" indicators (latestTool/latestCommand).
function applyAppServerItem(state: StreamJsonState, item: Record<string, unknown> | null, timestamp: string, completed: boolean): void {
  if (!item) {
    return;
  }
  const type = asString(item.type) ?? "item";
  const itemId = asString(item.id) ?? `codex:${state.sequence}`;

  switch (type) {
    case "userMessage": {
      const text = stripDeveloperInstructions(firstUserInputText(item.content));
      if (text && completed) {
        pushItem(state, { id: messageItemId(itemId), kind: "user", body: compactBody(text), timestamp });
      }
      return;
    }
    case "agentMessage": {
      // Deltas already streamed the body live; the completed item carries the
      // canonical full text, which addOrCoalesceAssistant folds in.
      const text = asString(item.text);
      if (text) {
        state.latestAssistantText = compactBody(text).slice(0, 160);
        pushItem(state, { id: messageItemId(itemId), kind: "assistant", title: "Codex", body: compactBody(text), timestamp });
      }
      return;
    }
    case "reasoning": {
      // Unlike exec, app-server can expose readable reasoning text.
      const summary = Array.isArray(item.summary) ? item.summary.map((entry) => asString(entry)).filter(Boolean).join("\n") : "";
      const content = Array.isArray(item.content) ? item.content.map((entry) => asString(entry)).filter(Boolean).join("\n") : "";
      const body = (summary || content).trim();
      if (completed) {
        pushItem(state, {
          id: thinkingItemId(itemId, 0),
          kind: "system",
          title: "Thinking",
          body: body || "Private reasoning step. Codex records that reasoning happened, but does not expose readable reasoning text.",
          timestamp,
        });
      }
      return;
    }
    case "plan": {
      const text = asString(item.text);
      if (text && completed) {
        pushItem(state, { id: `stream:${itemId}:plan`, kind: "system", title: "Plan", body: compactBody(text), timestamp });
      }
      return;
    }
    case "commandExecution": {
      const command = asString(item.command);
      state.latestTool = "command_execution";
      state.latestCommand = command ?? state.latestCommand;
      if (completed) {
        const output = asString(item.aggregatedOutput);
        const exitCode = numberOrUndefined(item.exitCode);
        const body = [command, output, exitCode !== undefined ? `exit ${exitCode}` : undefined].filter(Boolean).join("\n\n");
        pushItem(state, { id: toolUseItemId(itemId), kind: "tool", title: "Command", body: compactBody(body || stringifyRecord(item)), timestamp });
      }
      return;
    }
    case "fileChange": {
      state.latestTool = "file_change";
      if (completed) {
        pushItem(state, { id: toolUseItemId(itemId), kind: "tool", title: "File change", body: compactBody(fileChangeBody(item.changes)), timestamp });
      }
      return;
    }
    case "mcpToolCall": {
      const tool = asString(item.tool) ?? "MCP tool";
      state.latestTool = tool;
      if (completed) {
        const result = item.result ?? item.error ?? item.arguments;
        pushItem(state, { id: toolUseItemId(itemId), kind: "tool", title: tool, body: compactBody(stringifyRecord(result)), timestamp });
      }
      return;
    }
    case "webSearch": {
      const query = asString(item.query);
      state.latestTool = "web_search";
      state.latestCommand = query ?? state.latestCommand;
      if (completed) {
        pushItem(state, { id: toolUseItemId(itemId), kind: "tool", title: "Web search", body: compactBody(query ?? stringifyRecord(item)), timestamp });
      }
      return;
    }
    case "error": {
      const body = readableCodexErrorMessage(asString(item.message));
      if (body && completed) {
        pushItem(state, { id: `codex:error:${itemId}`, kind: "system", title: "Codex error", body: compactBody(body), timestamp });
      }
      return;
    }
    default:
      return;
  }
}

function applyAppServerTokenUsage(state: StreamJsonState, tokenUsage: Record<string, unknown> | null): void {
  const total = asRecord(tokenUsage?.total);
  if (!total) {
    return;
  }
  const inputTokens = Number(total.inputTokens ?? 0);
  const outputTokens = Number(total.outputTokens ?? 0) + Number(total.reasoningOutputTokens ?? 0);
  const cacheReadInputTokens = Number(total.cachedInputTokens ?? 0);
  const totalTokens = Number(total.totalTokens ?? 0) || inputTokens + outputTokens + cacheReadInputTokens;
  // app-server reports the thread's cumulative usage, so replace rather than add.
  if (totalTokens >= state.tokenUsage.totalTokens) {
    state.tokenUsage = {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens,
      totalTokens,
    };
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Fold a single `codex app-server` JSON-RPC notification into `state`. The
 * notification's `method` selects the handler; `params` is its payload.
 */
export function applyAppServerNotification(
  state: StreamJsonState,
  method: string,
  params: unknown,
  receivedAt = new Date().toISOString(),
): StreamJsonState {
  state.currentEventType = method;
  state.lastEventAt = receivedAt;
  const p = asRecord(params) ?? {};

  const threadId = asString(p.threadId);
  if (threadId && !state.codexThreadId) {
    state.codexThreadId = threadId;
  }

  switch (method) {
    case "thread/started": {
      const id = asString(asRecord(p.thread)?.id);
      if (id) {
        state.codexThreadId = id;
      }
      return state;
    }
    case "turn/started": {
      state.agentState = "working";
      if (state.turnStartedAt === undefined) {
        const startedAt = Date.parse(receivedAt);
        state.turnStartedAt = Number.isFinite(startedAt) ? startedAt : undefined;
        state.turnStartTokens = state.tokenUsage.totalTokens;
      }
      return state;
    }
    case "item/agentMessage/delta": {
      const delta = typeof p.delta === "string" ? p.delta : undefined;
      if (delta) {
        const itemId = asString(p.itemId) ?? state.activeAssistantMessageId ?? "assistant-delta";
        state.activeAssistantMessageId = itemId;
        pushItem(state, { id: messageItemId(itemId), kind: "assistant", title: "Codex", body: delta, timestamp: receivedAt }, true);
      }
      return state;
    }
    case "item/started": {
      state.agentState = "working";
      applyAppServerItem(state, asRecord(p.item), asString(asRecord(p.item)?.timestamp) ?? receivedAt, false);
      return state;
    }
    case "item/completed": {
      applyAppServerItem(state, asRecord(p.item), receivedAt, true);
      return state;
    }
    case "thread/tokenUsage/updated": {
      applyAppServerTokenUsage(state, asRecord(p.tokenUsage));
      return state;
    }
    case "turn/completed": {
      const turn = asRecord(p.turn);
      // `turn/completed` is the ONLY turn-ending notification: a failed or
      // interrupted turn arrives here too, carrying its status (there is no
      // `turn/failed` notification in the protocol). Surface the failure instead
      // of reporting a clean finish.
      const status = asString(turn?.status);
      const turnError = asRecord(turn?.error);
      const failure = readableCodexErrorMessage(asString(turnError?.message));
      if (status === "failed" && failure) {
        pushItem(state, {
          id: `codex:error:${asString(turn?.id) ?? state.sequence}`,
          kind: "system",
          title: "Codex error",
          body: compactBody(failure),
          timestamp: receivedAt,
        });
      }
      state.agentState = status === "failed" ? "needs_action" : "waiting";
      // A turn that never started (interrupted before its first token) has no
      // duration worth a footer, and a failed turn already got an error item.
      const durationMs = Number(turn?.durationMs ?? 0);
      if (status !== "failed") {
        pushTurnSummary(state, receivedAt, Number.isFinite(durationMs) ? durationMs : 0);
      }
      return state;
    }
    // Codex answered a server→client request without us (auto-approval, a
    // timeout, or another client), so any prompt we were holding is moot.
    case "serverRequest/resolved": {
      state.pendingApproval = undefined;
      return state;
    }
    case "error": {
      const err = asRecord(p.error);
      const body = readableCodexErrorMessage(asString(err?.message) ?? asString(p.message));
      if (body) {
        pushItem(state, { id: `codex:error:${body.slice(0, 96)}`, kind: "system", title: "Codex error", body: compactBody(body), timestamp: receivedAt });
      }
      // A retrying error keeps the turn alive; a terminal one needs the operator.
      state.agentState = p.willRetry === true ? "working" : "needs_action";
      return state;
    }
    default:
      return state;
  }
}

export function applyStreamJsonEvent(
  state: StreamJsonState,
  event: StreamJsonEvent,
  receivedAt = new Date().toISOString(),
): StreamJsonState {
  state.currentEventType = eventType(event);
  state.lastEventAt = receivedAt;
  state.claudeSessionId = sessionIdFromEvent(event) ?? state.claudeSessionId;
  state.codexThreadId = codexThreadIdFromEvent(event) ?? state.codexThreadId;
  // Every event a subagent produces carries `parent_tool_use_id` pointing at the
  // Task/Agent tool_use that spawned it. Carry it on state so pushItem stamps
  // each resulting item; cleared to undefined for top-level (main-agent) events.
  state.activeParentAgentId = asString(event.parent_tool_use_id) ?? undefined;
  // Replayed events (e.g. user messages echoed back by --replay-user-messages)
  // carry their true transcript timestamp; prefer it over the arrival time so
  // items keep their real position in the feed.
  const itemTimestamp = asString(event.timestamp) ?? receivedAt;

  const nestedEvent = asRecord(event.event);
  if (event.type === "stream_event" && nestedEvent) {
    applyStreamJsonEvent(
      state,
      {
        ...nestedEvent,
        session_id: asString(nestedEvent.session_id) ?? asString(event.session_id),
        uuid: asString(nestedEvent.uuid) ?? asString(event.uuid),
        timestamp: asString(nestedEvent.timestamp) ?? asString(event.timestamp),
        // Preserve subagent attribution across the partial-message wrapper.
        parent_tool_use_id: asString(nestedEvent.parent_tool_use_id) ?? asString(event.parent_tool_use_id),
      },
      receivedAt,
    );
    state.currentEventType = eventType(event);
    state.lastEventAt = receivedAt;
    return state;
  }

  applyClaudeTask(state, event, itemTimestamp);

  updateStateFromEventType(state, event);

  // The main agent's turn ends with a top-level `result` (a subagent's own
  // turn-ending result carries a `parent_tool_use_id`). Anything still running
  // then was launched to outlive the turn, so flag it as background — otherwise
  // its card keeps `hasRunningAgent` true and pins the section to "working"
  // forever, even across follow-up prompts.
  if (asString(event.type) === "result" && state.activeParentAgentId === undefined) {
    markBackgroundAgents(state);
  }

  // A subagent runs its own turns, whose intermediate `result`/`init` events
  // read as "waiting". Hold the section at "working" until every spawned agent
  // has reported completion, so a mid-flight child never flips the section to
  // finished (fires a notification, drops the dock badge). Precise task-state
  // gating, not the blanket time-based settle the renderer used to need.
  if (state.agentState === "waiting" && hasRunningAgent(state)) {
    state.agentState = "working";
  }

  // Stamp the start of a turn the first time it enters "working", so a later
  // `result`/`turn.completed` can report its wall-clock duration and the tokens
  // it consumed. Kept until the summary is emitted so an intervening approval
  // (working → needs_action → working) doesn't reset the clock mid-turn.
  if (state.agentState === "working" && state.turnStartedAt === undefined) {
    const startedAt = Date.parse(receivedAt);
    state.turnStartedAt = Number.isFinite(startedAt) ? startedAt : undefined;
    state.turnStartTokens = state.tokenUsage.totalTokens;
  }

  const message = asRecord(event.message);
  if (message?.role === "assistant" && asString(message.id)) {
    state.activeAssistantMessageId = asString(message.id);
  }
  const role = message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : undefined;
  if (role) {
    applyContentParts(state, event, role, message?.content, itemTimestamp);
    addUsage(state.tokenUsage, message?.usage);
  }

  applyCodexItem(state, event, itemTimestamp);
  applyCodexError(state, event, itemTimestamp);
  applyDeltaText(state, event, itemTimestamp);
  addUsage(state.tokenUsage, event.usage, event.type === "result" || event.type === "message_delta" || event.type === "turn.completed");

  const toolName = asString(event.tool_name) ?? asString(event.toolName) ?? asString(event.name);
  if (toolName) {
    state.latestTool = toolName;
  }

  const command =
    asString(event.command) ??
    commandFromToolInput(event.input) ??
    commandFromToolInput(asRecord(event.tool)?.input);
  if (command) {
    state.latestCommand = command;
  }

  // After usage is applied, close out the turn with a stats footer if this was
  // the turn-completing event.
  maybeEmitTurnSummary(state, event, receivedAt);

  return state;
}

export function streamRuntimeEvent(
  id: string,
  state: StreamJsonState,
  runtime?: AgentRuntime,
): SessionRuntimeEvent {
  return {
    id,
    executionMode: "stream-json",
    ...(runtime ? { runtime } : {}),
    agentState: state.agentState,
    currentEventType: state.currentEventType,
    lastEventAt: state.lastEventAt ?? new Date().toISOString(),
    latestTool: state.latestTool,
    latestCommand: state.latestCommand,
    latestModel: state.latestModel,
    latestAssistantText: state.latestAssistantText,
    tokenUsage: state.tokenUsage,
    claudeSessionId: state.claudeSessionId,
    codexThreadId: state.codexThreadId,
    ...(state.pendingApproval
      ? { pendingApproval: state.pendingApproval, pendingPromptId: state.pendingApproval.promptId }
      : {}),
  };
}
