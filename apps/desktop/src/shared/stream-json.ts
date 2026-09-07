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
  // Shell commands seen on a `tool_use`, kept until the `task_started` that
  // opens their card arrives (the two events race). See rememberShellCommand.
  shellCommands?: Array<{ toolUseId: string; command: string }>;
  // Codex (app-server) is blocked on an approval or a question and the section
  // sits at `needs_action` until it is answered. Owned by
  // CodexAppServerSessionManager, mirrored here so it rides the normal snapshot
  // to the renderer and the relay.
  pendingApproval?: PendingApproval;
  // The most recent turn-ending Claude `result` event, if it carried
  // `is_error: true`. Cleared on the next (non-error) result. Read by the
  // auto-retry scheduler in main/index.ts to tell a transient failure
  // (`error_during_execution` — a dropped connection or a 5xx mid-response,
  // worth retrying) from a terminal one (`error_max_turns`, `error_max_budget_usd`
  // — retrying changes nothing, a human has to act).
  lastResultError?: { subtype: string };
  // A `<synthetic>` assistant message the CLI emits in place of the model's
  // answer when the API call itself failed ("API Error: Connection closed
  // mid-response…"). It does NOT make the turn's `result` an error — that still
  // arrives as `subtype: "success"`, `is_error: false` — so the result handler
  // has to carry this flag forward to tell a real answer from a dropped one.
  // Set on the assistant event, consumed by the next `result`.
  pendingApiError?: { text: string; retryable: boolean };
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

// Codex is the exception to the shared-id rule above: its rollout file records
// no app-server item ids for messages, so the transcript reader keys them by
// line number. A transcript copy and a live copy of the same message therefore
// never collide on id — mergeConversationItems matches them by content instead,
// which is what this predicate is for.
export function codexTranscriptMessageId(threadId: string, role: "user" | "assistant", lineIndex: number): string {
  return messageItemId(`codex:${threadId}:${role}:${lineIndex}`);
}

export function isCodexTranscriptMessageId(id: string): boolean {
  return /^stream:codex:.+:(?:user|assistant):\d+$/.test(id);
}

// Claude Code injects tooling text back into the conversation as "user" turns:
// a skill body, a system reminder, a slash-command wrapper, hook output. None of
// them were typed by the user, so they must not render as a prompt bubble. The
// live stream tags them `isSynthetic`, the JSONL transcript tags them `isMeta`.
export function isSyntheticUserEvent(event: StreamJsonEvent): boolean {
  return event.isSynthetic === true || event.isMeta === true;
}

const SYNTHETIC_USER_TITLES: Array<{ match: RegExp; title: string }> = [
  { match: /^Base directory for this skill:/i, title: "Skill" },
  { match: /^<system-reminder>/i, title: "System reminder" },
  { match: /^<task-notification>/i, title: "Task update" },
  { match: /^<command-(?:name|message|args)>/i, title: "Command" },
  { match: /^<local-command-(?:stdout|stderr)>/i, title: "Command output" },
  { match: /^<user-prompt-submit-hook>/i, title: "Hook" },
];

export function syntheticUserTitle(text: string): string {
  const trimmed = text.trimStart();
  return SYNTHETIC_USER_TITLES.find((rule) => rule.match.test(trimmed))?.title ?? "System";
}

// Not every injected turn carries a flag: a background-task notification is
// written into the transcript as a plain "user" entry with no `isMeta` and no
// `isSynthetic`, so the flags alone would render it as a prompt bubble. Fall
// back to the wrapper the text opens with — every one of these markers is
// machine-authored, so no real prompt can be mistaken for one.
export function looksLikeSyntheticUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return SYNTHETIC_USER_TITLES.some((rule) => rule.match.test(trimmed));
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

export function pushItem(state: StreamJsonState, item: Omit<ConversationItem, "sequence">, delta = false): void {
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

// Transport-level failures the API is expected to recover from on a resend: a
// dropped stream, a 5xx, an overloaded upstream. Anything else the CLI reports
// as "API Error:" (a 400 from an oversized prompt, an auth failure, a credit
// limit) comes back identically no matter how many times we retry, so it has to
// reach a human instead.
const RETRYABLE_API_ERROR_PATTERN =
  /connection closed|connection error|network error|timed? ?out|overloaded|internal server error|\b(500|502|503|504|529)\b/i;

/**
 * Recognises the CLI's synthetic API-error message. The transcript marks it with
 * `isApiErrorMessage`, but the stream-json envelope does not always carry that
 * flag, so the message payload itself (`model: "<synthetic>"` plus the
 * "API Error:" prefix) is the reliable signal.
 */
function apiErrorFromAssistantMessage(
  event: StreamJsonEvent,
  model: string | undefined,
  text: string,
): { text: string; retryable: boolean } | undefined {
  const flagged = event.isApiErrorMessage === true || asString(event.error) === "server_error";
  const looksSynthetic = model === "<synthetic>" && /^\s*API Error\b/i.test(text);
  if (!flagged && !looksSynthetic) {
    return undefined;
  }
  return { text, retryable: RETRYABLE_API_ERROR_PATTERN.test(text) };
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

  const synthetic = role === "user" && (isSyntheticUserEvent(event) || looksLikeSyntheticUserText(text));

  if (role === "user" && text) {
    applyAsyncAgentNotification(state, text);
    if (INTERRUPT_MARKER.test(text.trim())) {
      resolveInterruptedAgentCards(state);
    }
  }

  if (text) {
    if (role === "assistant") {
      const apiError = apiErrorFromAssistantMessage(event, model, text);
      if (apiError) {
        state.pendingApiError = apiError;
      }
      // `<synthetic>` is the CLI's placeholder for "no model answered this", not
      // a model the section is running on — recording it would relabel the
      // section's model in the UI off the back of a failure.
      if (model && model !== "<synthetic>") state.latestModel = model;
      // Short snippet for the mobile session-list preview.
      state.latestAssistantText = compactBody(text).slice(0, 160);
    }
    pushItem(state, {
      id: messageItemId(messageId),
      kind: synthetic ? "system" : role,
      title: role === "assistant" ? "Claude" : synthetic ? syntheticUserTitle(text) : undefined,
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
      // The Task/Agent tool spawns a subagent that gets its own `agent` card,
      // so the raw tool_use row would just duplicate it. Some runs report the
      // subagent's lifecycle via `task_started`/`task_updated` system events
      // (applyClaudeTask opens the card itself, below); others — the async
      // "launched in the background, notified later" style — never emit those
      // events at all, so the card has to be opened right here or it never
      // appears. `pushItem` no-ops if `task_started` already created the same
      // id, so doing both is safe.
      if (name === "Agent" || name === "Task") {
        const toolUseId = asString(record.id);
        if (toolUseId) {
          if (!state.agentToolUseIds) {
            state.agentToolUseIds = [];
          }
          if (!state.agentToolUseIds.includes(toolUseId)) {
            state.agentToolUseIds.push(toolUseId);
          }
          const input = asRecord(record.input);
          const agent: AgentActivity = {
            toolUseId,
            subagentType: asString(input?.subagent_type),
            status: "running",
          };
          pushItem(state, {
            id: agentCardItemId(toolUseId),
            kind: "agent",
            title: asString(input?.description) ?? "Agent",
            body: agentCardBody(agent),
            timestamp,
            parentAgentId: undefined,
            agent,
          });
        }
        continue;
      }
      const command = commandFromToolInput(record.input);
      state.latestTool = name;
      state.latestCommand = command ?? state.latestCommand;
      const toolUseId = asString(record.id);
      // Where this shell sends its output decides what its card can show.
      const shellCommand = asString(asRecord(record.input)?.command);
      if (toolUseId && shellCommand) {
        rememberShellCommand(state, toolUseId, shellCommand);
        // No-ops when task_started has not opened the card yet; that path reads
        // the command back out of `state.shellCommands`.
        applyShellCommandToCard(state, toolUseId, shellCommand);
      }
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
        const resultBody = toolResultBody(record.content);
        captureTaskOutputFile(state, toolUseId, resultBody);
        // An async Agent/Task launch acknowledgement instead of shell output:
        // "agentId: <id>" is the same id its later <task-notification> reports
        // itself by, and "output_file: <path>" is its full nested transcript.
        captureAsyncAgentLaunch(state, toolUseId, resultBody);
        // And except for a *foreground* shell task, which has neither: this
        // result is the only copy of the command's output.
        captureShellTaskOutput(state, toolUseId, resultBody);
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
    const isError = event.is_error === true;
    const apiError = state.pendingApiError;
    state.pendingApiError = undefined;

    // The turn produced a synthetic "API Error:" message instead of an answer.
    // The CLI still closes it as `success`, so without this the section reads
    // as cleanly finished and nothing retries it — the case that left a turn
    // parked for an hour until a human typed "Continue". Map a transport
    // failure onto the same transient bucket the auto-retry scheduler already
    // watches; anything else is terminal and needs a human.
    if (!isError && apiError) {
      state.lastResultError = { subtype: apiError.retryable ? "error_during_execution" : "error_api" };
      state.agentState = apiError.retryable ? "waiting" : "needs_action";
      return;
    }

    // `error_during_execution` is the CLI's own transient bucket — a dropped
    // connection or a server error mid-stream — so it stays "waiting" and lets
    // the auto-retry scheduler (main/index.ts, keyed off `lastResultError`)
    // quietly resend the turn instead of parking on a spinner nothing clears.
    // Anything else `is_error` (max turns, max budget, …) is terminal: surface
    // it as `needs_action` instead of masking it as a clean finish.
    state.lastResultError = isError ? { subtype } : undefined;
    state.agentState = isError && subtype !== "error_during_execution" ? "needs_action" : "waiting";
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

  if (type === "command_lifecycle") {
    // The CLI's background-shell notice, emitted when a `run_in_background`
    // command is launched, adopted, or exits. It is not a turn boundary and it
    // routinely arrives on an idle section: the launch acknowledgement lands
    // *2ms after* the turn's own `result`, and the exit notice can land hours
    // later. Falling through to "working" therefore pinned a finished section
    // to a spinner nothing would clear — no further `result` is coming.
    return;
  }

  if (type === "system") {
    // `init` is the CLI announcing it booted, not a turn boundary. A section
    // started *by* a prompt sends the prompt first and gets the boot echo a
    // beat later, so reporting "waiting" here dropped the spinner (sidebar and
    // status bar both) for the whole cold start — 5s on a warm machine, far
    // longer with MCP servers to load — while the transcript already showed
    // "Thinking…". A section that really is idle is already "waiting" from the
    // initial state, so leaving it untouched still reads "Ready".
    //
    // System notices never *start* a turn. Some of them (`commands_changed`,
    // fired whenever the CLI rescans skills/commands on disk) arrive on idle
    // sessions long after their `result`, and falling through to "working"
    // pinned every finished section to a spinner that nothing would clear —
    // no further `result` is coming. In-turn notices (`status`,
    // `thinking_tokens`, `task_*`) land while the state is already "working",
    // so leaving it untouched loses nothing.
    return;
  }

  state.agentState = "working";
}

export function agentCardBody(agent: AgentActivity): string {
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

// `outputFile` only receives what the command actually wrote to the CLI's
// stdout/stderr, and two shell habits leave it empty for a whole run: sending
// the output to a log of the agent's own choosing (`> build.log`), and ending
// the pipeline in a stage that holds everything until stdin closes
// (`… | tee log | tail -20` — the case that made a 20-minute push render as
// "No output yet…" while tee's log grew to 71KB). Both are recoverable from the
// command text, which beats asking agents not to do it: the instruction already
// exists and this pipeline still shipped.

/**
 * Stages that cannot emit their first byte until stdin closes, because their
 * output is a function of the whole input: `tail` must know where the end is,
 * `sort` and `tac` must see every line before the first one is placed, `wc`
 * counts to the end, `sponge` soaks by definition. That property — not
 * "filters output" — is the membership rule, which is why the streaming
 * filters an agent reaches for just as often (`grep`, `sed`, `awk`, `head`,
 * `cut`) are deliberately absent: they print as they go and a card behind one
 * of them fills normally.
 */
const BUFFERING_PIPELINE_STAGES = new Set(["tail", "sort", "wc", "tac", "sponge"]);

/**
 * `| tee [-a] <path>`. Only after a pipe: bare `tee` is not a thing an agent
 * writes, and anchoring on the pipe keeps the word "tee" inside some other
 * argument from matching. Group 1 soaks up flags (`-a`, `--append`) so group 2
 * is the path. tee's target is the interesting one precisely because it holds
 * the full output even when the stage after it swallows everything.
 */
const TEE_TARGET_PATTERN = /\|\s*tee\s+((?:-\S+\s+)*)("[^"]*"|'[^']*'|[^\s|;&<>]+)/g;

/**
 * `> <path>`, `>> <path>`, `2> <path>`, `&> <path>`, `&>> <path>`.
 * The leading boundary stops a `>` that is part of a longer token from
 * matching; the unquoted path class excludes the metacharacters that would end
 * the word (`|;&<>`) so `cmd > log | tail` yields `log`, not `log | tail`.
 */
const REDIRECT_TARGET_PATTERN = /(?:^|[\s;&|])(?:\d?>>?|&>>?)\s*("[^"]*"|'[^']*'|[^\s|;&<>]+)/g;

/**
 * Targets that discard the stream or re-point it at an existing one rather than
 * naming a file worth tailing. `/dev/null` is the common half of
 * `| tee log > /dev/null`, where tee's target is the readable copy and this one
 * would be an empty tail forever.
 */
const NON_FILE_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

function unquoteShellWord(word: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(word);
  return quoted?.[2] ?? word;
}

/**
 * The *last* usable target, not the first: when a command redirects the same
 * stream twice the shell applies them in order and only the final one still has
 * the output, so scanning to the end matches what actually happens on disk.
 * Skipped targets do not end the scan — `> log 2>&1` has to keep `log` after
 * rejecting `&1`, which a first-match-wins loop would get backwards.
 */
function lastMatch(pattern: RegExp, command: string, group: number): string | undefined {
  pattern.lastIndex = 0;
  let found: string | undefined;
  for (let match = pattern.exec(command); match !== null; match = pattern.exec(command)) {
    const captured = match[group];
    if (captured === undefined) {
      continue;
    }
    const target = unquoteShellWord(captured);
    // `2>&1` reaches here as the target "&1": a stream dup, not a file.
    if (target.startsWith("&") || NON_FILE_REDIRECT_TARGETS.has(target)) {
      continue;
    }
    found = target;
  }
  return found;
}

/**
 * Split into pipeline stages. `||` is a boolean operator rather than a pipe,
 * but splitting on it too is harmless here: it still lands on a real command
 * boundary, and the only question asked of each stage is what its first word
 * is. Deliberately naive about quoting — a `|` inside a quoted string yields
 * one bogus stage, which at worst costs an unrecognised stage name.
 */
function pipelineStages(command: string): string[] {
  return command.split(/\|\|?/).map((stage) => stage.trim());
}

/**
 * What a shell command does with its own output. Returns the file it writes to
 * (so the card can tail that instead of the CLI's empty one) and the pipeline
 * stage that withholds it (so an empty card can say why it is empty).
 *
 * Both results are a best-effort read of shell syntax, never a guarantee: this
 * is a regex over a string, not a parser, and it can be defeated by quoting,
 * `$VARS`, or a heredoc. That is affordable because of how the results are
 * used — a `file` that does not exist just fails the tail and the card falls
 * back to what it showed before, and a missed `bufferedBy` costs one sentence
 * of explanation. Nothing downstream depends on either being right, so the bias
 * is toward recognising the plain forms agents actually write rather than
 * covering the whole grammar.
 */
export function parseCommandOutputPlan(command: string): { file?: string; bufferedBy?: string } {
  // A redirect wins over tee: `cmd | tee log > out` puts everything in `out`,
  // and tee's copy is the lesser of the two. The order only matters when a
  // command uses both, which is rare enough that either answer would do.
  const file = lastMatch(REDIRECT_TARGET_PATTERN, command, 1) ?? lastMatch(TEE_TARGET_PATTERN, command, 2);

  // Stage 0 is the command itself — it is the stages *downstream* of it that
  // can withhold its output, so start at 1. The first one found wins: once
  // anything in the pipeline waits for EOF, everything after it is waiting too,
  // and the earliest waiting stage is the one that explains the silence.
  let bufferedBy: string | undefined;
  for (const stage of pipelineStages(command).slice(1)) {
    const [name = "", ...args] = stage.split(/\s+/);
    // `tail -f`/`-F` is the one form that streams rather than waits.
    if (BUFFERING_PIPELINE_STAGES.has(name) && !args.some((arg) => /^-[fF]$|^--follow/.test(arg))) {
      bufferedBy = name;
      break;
    }
  }

  return { file, bufferedBy };
}

/** Cap on remembered commands: enough to cover a turn's shells, bounded so a
 *  long session's state stays small. */
const SHELL_COMMAND_MEMORY = 40;

/**
 * The command arrives on the Bash `tool_use`, but the card that needs it is
 * opened by `task_started` — and either can land first. Remember the command by
 * tool_use id and apply it from both sides.
 */
function rememberShellCommand(state: StreamJsonState, toolUseId: string, command: string): void {
  const remembered = (state.shellCommands ?? []).filter((entry) => entry.toolUseId !== toolUseId);
  remembered.push({ toolUseId, command });
  state.shellCommands = remembered.slice(-SHELL_COMMAND_MEMORY);
}

function applyShellCommandToCard(state: StreamJsonState, toolUseId: string, command: string): void {
  updateAgentCard(state, { toolUseId }, (agent) => {
    // A real subagent's card shows its nested transcript; it runs no shell.
    if (agent.subagentType !== undefined) {
      return;
    }
    const plan = parseCommandOutputPlan(command);
    agent.command = command;
    if (plan.file) agent.commandOutputFile = plan.file;
    if (plan.bufferedBy) agent.outputBufferedBy = plan.bufferedBy;
  });
}

function captureTaskOutputFile(state: StreamJsonState, toolUseId: string, body: string): void {
  const path = TASK_OUTPUT_FILE_PATTERN.exec(body)?.[1];
  if (!path) {
    return;
  }
  updateAgentCard(state, { toolUseId }, (agent) => {
    agent.outputFile = path;
  });
}

// Claude Code reuses the task_* lifecycle for plain Bash calls, so a foreground
// shell gets an agent card carrying the Bash `description` ("Push to origin
// main"). Unlike a subagent it renders no nested children, and unlike a
// background shell it names no output file — so once its tool_result was
// suppressed as a "redundant echo" the card had nothing left to show and read
// "No output yet…" forever, swallowing the output of commit and push gates.
// Put the result on the card instead of dropping it.
function captureShellTaskOutput(state: StreamJsonState, toolUseId: string, body: string): void {
  // A subagent names its type and/or has already streamed children by now; a
  // background shell has an output file the main process tails in. Anything
  // still empty at this point is a foreground shell.
  if (state.items.some((item) => item.parentAgentId === toolUseId)) {
    return;
  }
  updateAgentCard(state, { toolUseId }, (agent) => {
    if (agent.subagentType !== undefined || agent.outputFile !== undefined) {
      return;
    }
    agent.outputTail = compactBody(body);
  });
}

// An async Agent/Task launch acknowledgement reads:
//   "Async agent launched successfully. ... agentId: <id> ...
//    output_file: <path> ... "
// `agentId` is the id its later <task-notification> reports itself by (see
// applyAsyncAgentNotification); `output_file` is its full nested transcript,
// same role as a background shell's output file above.
const ASYNC_AGENT_ID_PATTERN = /agentId:\s*(\S+)/;
const ASYNC_AGENT_OUTPUT_FILE_PATTERN = /output_file:\s*(\S+)/;

// Exported so the transcript reader (which rebuilds a reloaded session from the
// JSONL, not from live events) resolves async agents exactly the same way.
export function parseAsyncAgentLaunch(body: string): { agentId?: string; outputFile?: string } | null {
  const agentId = ASYNC_AGENT_ID_PATTERN.exec(body)?.[1];
  const outputFile = ASYNC_AGENT_OUTPUT_FILE_PATTERN.exec(body)?.[1];
  if (!agentId && !outputFile) {
    return null;
  }
  return { agentId, outputFile };
}

function captureAsyncAgentLaunch(state: StreamJsonState, toolUseId: string, body: string): void {
  const launch = parseAsyncAgentLaunch(body);
  if (!launch) {
    return;
  }
  updateAgentCard(state, { toolUseId }, (agent) => {
    if (launch.agentId) agent.taskId = launch.agentId;
    if (launch.outputFile) agent.outputFile = launch.outputFile;
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

// The async Agent/Task lifecycle has no `task_updated`/`task_notification`
// system events — its only terminal signal is a `<task-notification>` block
// injected into the transcript as a plain user turn (already recognized by
// looksLikeSyntheticUserText and rendered as a "Task update" system row). It
// carries the same ids the launch ack and card were keyed by, so the matching
// card can be resolved out of "running" the same way applyClaudeTask does for
// the native lifecycle.
const TASK_NOTIFICATION_FIELD = (tag: string): RegExp => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");

export type TaskNotification = {
  toolUseId?: string;
  taskId?: string;
  status?: string;
  summary?: string;
};

// Exported for the transcript reader, same reason as parseAsyncAgentLaunch.
export function parseTaskNotification(text: string): TaskNotification | null {
  if (!/^<task-notification>/i.test(text.trimStart())) {
    return null;
  }
  const toolUseId = TASK_NOTIFICATION_FIELD("tool-use-id").exec(text)?.[1]?.trim();
  const taskId = TASK_NOTIFICATION_FIELD("task-id").exec(text)?.[1]?.trim();
  if (!toolUseId && !taskId) {
    return null;
  }
  return {
    toolUseId,
    taskId,
    status: TASK_NOTIFICATION_FIELD("status").exec(text)?.[1]?.trim(),
    summary: TASK_NOTIFICATION_FIELD("summary").exec(text)?.[1]?.trim(),
  };
}

// Resolve a card out of "running" from a notification's status/summary. Shared
// by the live stream and the transcript reader.
export function applyTaskNotificationToAgent(agent: AgentActivity, notification: TaskNotification): void {
  if (notification.status === "completed") agent.status = "completed";
  else if (notification.status === "failed" || notification.status === "error") agent.status = "failed";
  if (notification.summary) agent.summary = notification.summary;
}

function applyAsyncAgentNotification(state: StreamJsonState, text: string): void {
  const notification = parseTaskNotification(text);
  if (!notification) {
    return;
  }
  updateAgentCard(state, { toolUseId: notification.toolUseId, taskId: notification.taskId }, (agent) => {
    applyTaskNotificationToAgent(agent, notification);
  });
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

/**
 * Whether anything this section spawned is still running — a subagent mid-turn,
 * a `run_in_background` agent, or a background shell.
 *
 * The complement of `hasRunningAgent`, and deliberately so: that one answers
 * "should the spinner stay open", where a background card must NOT count, and
 * this one answers "would killing this process destroy work", where it is the
 * only thing that does. A section whose turn ended while `git push` runs is
 * `waiting` with a running background card, and the reaper reads this to leave
 * it alone.
 *
 * A card only leaves "running" on its terminal `task_updated`/`task_notification`,
 * so a child that dies without one keeps its section unhibernatable until the
 * next turn rebuilds the transcript. That is the safe direction to be wrong in:
 * the cost is one process held, not a lost push.
 */
export function hasBackgroundWork(state: StreamJsonState): boolean {
  return state.items.some((item) => item.kind === "agent" && item.agent?.status === "running");
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

// The CLI injects this synthetic user message when a turn is killed mid-tool-use.
// Nothing else resolves a card at that point — no task_updated/task_notification
// is coming for a process the interrupt just tore down — so any card still
// "running" at this instant is stuck there forever unless we resolve it here.
const INTERRUPT_MARKER = /^\[Request interrupted by user/;

function resolveInterruptedAgentCards(state: StreamJsonState): void {
  for (const item of state.items) {
    if (item.kind === "agent" && item.agent?.status === "running") {
      item.agent.status = "failed";
      if (!item.agent.summary) item.agent.summary = "Interrupted";
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
    // The Bash tool_use usually lands first and carries the command this card
    // is running; if it did, resolve the card's output sink now.
    const command = state.shellCommands?.find((entry) => entry.toolUseId === toolUseId)?.command;
    if (command) {
      applyShellCommandToCard(state, toolUseId, command);
    }
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
        model: state.latestModel,
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
  // A subagent ends its own turn with a `result` carrying `parent_tool_use_id`.
  // That is not the main agent's turn ending: emitting here would both bury a
  // footer inside the agent card and — worse — reset `turnStartedAt` /
  // `turnStartTokens`, so the parent's real footer would report only the sliver
  // of time since the last child finished ("Worked for 0.1s", no token count).
  if (state.activeParentAgentId !== undefined) {
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
  // the turn began (robust across Claude/Codex). Falling back to the whole total
  // is only right when we never captured a start (the process resumed mid-turn);
  // a turn that genuinely burned nothing must report 0. Reporting the session
  // total for a zero delta is what let the bookkeeping turn after an interrupt
  // slip past the "no tokens, under a second" guard below and render as
  // "Worked for 0.1s · 6.2M tokens".
  const endTokens = state.tokenUsage.totalTokens;
  const turnTokens =
    state.turnStartTokens === undefined ? endTokens : Math.max(0, endTokens - state.turnStartTokens);

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

  // A turn that burned no tokens in under a second did no work: it is the
  // bookkeeping `result` the CLI emits after an interrupt (the echoed user
  // message flips the state back to "working", so a fresh turn clock starts a
  // heartbeat before the result lands). "Worked for 0.1s" under an interrupt
  // notice says nothing and reads like a broken turn — say nothing instead.
  if (turnTokens === 0 && durationMs < 1000) {
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
        pushItem(state, {
          id: messageItemId(itemId),
          kind: "assistant",
          title: "Codex",
          body: compactBody(text),
          timestamp,
          model: state.latestModel,
        });
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
    case "functionCallOutput": {
      if (completed) {
        const name = asString(item.name) ?? "Tool output";
        state.latestTool = name;
        pushItem(state, {
          id: toolResultItemId(itemId),
          kind: "tool",
          title: name,
          body: compactBody(stringifyRecord(item.output)),
          timestamp,
        });
      }
      return;
    }
    case "contextCompaction": {
      state.latestTool = completed ? undefined : "Compacting context";
      if (completed) {
        pushItem(state, {
          id: `codex:compaction:${itemId}`,
          kind: "system",
          title: "Context compacted",
          body: "Codex compacted the conversation context and continued.",
          timestamp,
        });
      }
      return;
    }
    case "imageView": {
      const path = asString(item.path);
      state.latestTool = "view_image";
      if (completed && path) {
        pushItem(state, { id: toolUseItemId(itemId), kind: "tool", title: "Viewed image", body: path, timestamp });
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
      const thread = asRecord(p.thread);
      const id = asString(thread?.id);
      if (id) {
        state.codexThreadId = id;
      }
      state.latestModel = asString(p.model) ?? asString(thread?.model) ?? state.latestModel;
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
        pushItem(
          state,
          {
            id: messageItemId(itemId),
            kind: "assistant",
            title: "Codex",
            body: delta,
            timestamp: receivedAt,
            model: state.latestModel,
          },
          true,
        );
      }
      return state;
    }
    case "item/started": {
      state.agentState = "working";
      const item = asRecord(p.item);
      applyAppServerItem(state, item, asString(item?.timestamp) ?? receivedAt, false);
      // Preserve the subtype for the live status bar. A generic item/started
      // makes a long compaction indistinguishable from a frozen turn.
      if (asString(item?.type) === "contextCompaction") {
        state.currentEventType = "contextCompaction:started";
      }
      return state;
    }
    case "item/completed": {
      const item = asRecord(p.item);
      applyAppServerItem(state, item, receivedAt, true);
      if (asString(item?.type) === "contextCompaction") {
        state.currentEventType = "contextCompaction:completed";
      }
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
      const misalignment = asRecord(turnError?.misalignment);
      const failure = readableCodexErrorMessage(
        asString(misalignment?.detailedExplanation) ?? asString(turnError?.message),
      );
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
    case "warning":
    case "guardianWarning":
    case "modelProvider/authRecoveryStarted":
    case "modelProvider/authRecoveryCompleted": {
      const body = asString(p.message);
      if (body) {
        pushItem(state, {
          id: `codex:notice:${method}:${body.slice(0, 80)}`,
          kind: "system",
          title: method === "guardianWarning" ? "Codex safety warning" : "Codex notice",
          body: compactBody(body),
          timestamp: receivedAt,
        });
      }
      return state;
    }
    case "deprecationNotice":
    case "configWarning": {
      const summary = asString(p.summary) ?? "Codex configuration notice";
      const details = asString(p.details);
      const path = asString(p.path);
      pushItem(state, {
        id: `codex:notice:${method}:${summary.slice(0, 80)}`,
        kind: "system",
        title: method === "deprecationNotice" ? "Codex deprecation" : "Codex configuration warning",
        body: compactBody([summary, details, path].filter(Boolean).join("\n")),
        timestamp: receivedAt,
      });
      return state;
    }
    case "autoApprovalReview/strictReviewRequired": {
      pushItem(state, {
        id: `codex:strict-review:${asString(p.turnId) ?? state.sequence}`,
        kind: "system",
        title: "Strict review required",
        body: "Codex requires manual review before this action can continue.",
        timestamp: receivedAt,
      });
      state.agentState = "needs_action";
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
  if (role === "user") {
    // Anything from the user's side — a new prompt, or a tool result because the
    // CLI recovered on its own and kept going — means the API error we were
    // holding did not end the turn after all. Drop it, so it can't make a later
    // clean `result` look like a dropped connection and trigger a resend.
    state.pendingApiError = undefined;
  }
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
