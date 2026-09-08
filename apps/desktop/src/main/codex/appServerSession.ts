// Codex sessions running on the persistent `codex app-server` transport.
//
// All Codex sessions multiplex over a SINGLE long-lived client: each Panda
// "section" maps to one app-server *thread*, and a prompt maps to one *turn*
// (or a *steer* when a turn is already in flight).
//
// The manager owns:
//   - a lazily-started shared CodexAppServerClient,
//   - a per-section record ({ threadId, StreamJsonState, queue, approval }),
// and folds server notifications into StreamJsonState via
// applyAppServerNotification so the renderer/relay path is unchanged. See
// docs/codex-app-server-migration.md.

import type {
  ApprovalOption,
  PendingApproval,
  SessionApprovalAnswer,
  SessionApprovalResult,
  SessionInputResult,
  SessionStartRequest,
  SessionStartResult,
} from "../../shared/ipc";
import { codexPromptPayload } from "../../shared/agent-prompts";
import { applyAppServerNotification, createStreamJsonState, type StreamJsonState } from "../../shared/stream-json";
import { CodexAppServerClient, type AppServerServerRequest, type JsonRpcId } from "./appServerClient";

/** A prompt waiting for its thread to be live. Text plus any staged images. */
export type QueuedPrompt = {
  text: string;
  imagePaths?: string[];
};

/**
 * A server→client request we are holding open until the operator answers.
 * `questions`/`answers` only apply to `item/tool/requestUserInput`, which can ask
 * several things in one request; we surface them one at a time and answer the
 * JSON-RPC request once the last one is in.
 */
type HeldServerRequest = {
  requestId: JsonRpcId;
  method: string;
  promptId: string;
  params: Record<string, unknown>;
  questions: UserInputQuestion[];
  answers: Record<string, { answers: string[] }>;
  /** Typed values collected for an MCP form elicitation. */
  elicitationContent: Record<string, unknown>;
  /** Exact permission subset requested by Codex; never broadened by Panda. */
  requestedPermissions?: Record<string, unknown>;
  questionIndex: number;
};

type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description?: string; value?: unknown }> | null;
  valueType?: "string" | "number" | "integer" | "boolean" | "stringArray";
};

export type CodexAppServerSession = {
  request: SessionStartRequest;
  state: StreamJsonState;
  cwd: string;
  /** app-server thread id (resolved from thread/start or supplied on resume). */
  threadId?: string;
  /**
   * True only once thread/start or thread/resume has completed on the CURRENT
   * live client. `threadId` alone is not enough: on resume it is pre-populated
   * from request.codexThreadId before the freshly-spawned app-server has loaded
   * that thread, so a raced turn/start would hit "thread not found". Turns wait
   * on this flag; a dead client resets it (see handleClientExit).
   */
  threadReady?: boolean;
  /** Active turn id, tracked so we can steer/interrupt it. */
  turnId?: string;
  /**
   * True between `turn/started` and `turn/completed`. `turnId` alone cannot say
   * this: it lingers after a turn ends (kept so a late interrupt still has an id
   * to name), and steering a finished turn fails its `expectedTurnId` check.
   */
  turnActive?: boolean;
  /**
   * Prompts that arrived before the thread finished opening. The renderer sends
   * the first prompt as a separate input ~ms after start(), which races the async
   * client handshake + thread/start; a resume after the client died queues too.
   * Drained by flushQueue() once the thread is live — a QUEUE, not a slot, so a
   * second prompt in that window can never overwrite the first.
   */
  queue: QueuedPrompt[];
  /** Approval/question currently blocking the turn, if any. */
  held?: HeldServerRequest;
  /** Title bookkeeping mirrors ManagedStreamSession so index.ts stays uniform. */
  emittedTitle?: string;
  titleLocked?: boolean;
  /**
   * Epoch ms of the last prompt, for the hibernation reaper (see
   * sessionReaper.ts, which evicts least-recently-prompted first).
   *
   * Stamped in `markWorking`, i.e. when a prompt is actually sent — NOT on every
   * event. An agent's own output must not refresh it: a section that spent an
   * hour on an autonomous run would otherwise look freshly used, and would
   * outrank the section the user was really reading. The mirror of this on the
   * Claude side lives in ManagedStreamSession.
   *
   * Required rather than optional so a new call site cannot forget it and leave
   * a section permanently looking like the coldest thing on the box.
   */
  lastPromptAt: number;
};

export type CodexAppServerManagerDeps = {
  /** Spawns a fresh `codex app-server` client (transport injected for tests). */
  createClient: (handlers: {
    onNotification: (note: { method: string; params: unknown }) => void;
    onServerRequest: (request: AppServerServerRequest) => void;
    onExit: (code: number | null) => void;
  }) => CodexAppServerClient;
  logMain: (event: string, details?: Record<string, unknown>) => void;
  /**
   * Codex feature flags to turn on for our app-server process (process-wide, NOT
   * written to the user's config). `default_mode_request_user_input` is the one
   * that lets Codex ask the operator a question in default mode; it ships
   * under-development and off, so it stays opt-in here even though we can now
   * answer it — see docs/codex-app-server-migration.md.
   */
  experimentalFeatures?: Record<string, boolean>;
  /** Push the current StreamJsonState of a section to renderer + relay. */
  sendSnapshot: (id: string, session: CodexAppServerSession) => void;
  /** Sync the section title (prompt-derived) once a thread id is known. */
  syncTitle?: (id: string, session: CodexAppServerSession) => void;
  /** Publish a native Codex thread name when the app-server provides one. */
  setTitle?: (id: string, title: string) => void;
};

/**
 * Maps a Panda permission/sandbox string onto app-server thread params.
 *
 * `permissionMode` is Codex's *sandbox* mode; the approval policy is separate.
 * Now that approvals are answerable (handleServerRequest), ask on request —
 * except under `danger-full-access`, where the operator has already said "no
 * restrictions" and prompting them would be noise.
 */
function threadParamsFromRequest(request: SessionStartRequest): Record<string, unknown> {
  const params: Record<string, unknown> = { cwd: request.cwd };
  if (request.model?.trim()) {
    params.model = request.model.trim();
  }
  const sandbox = request.permissionMode?.trim();
  if (sandbox) {
    params.sandbox = sandbox;
  }
  params.approvalPolicy = sandbox === "danger-full-access" ? "never" : "on-request";
  return params;
}

// Per-turn overrides for `turn/start`. Codex applies these "for this turn and
// subsequent turns", which is how mid-session model/effort switches take effect:
// `ThreadStartParams`/`ThreadResumeParams` carry `model` but have NO `effort`
// field, so effort can ONLY be set here. We re-assert both on every turn so a
// switch made between turns is honored without dropping the thread.
function turnOverridesFromRequest(request: SessionStartRequest): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (request.model?.trim()) {
    overrides.model = request.model.trim();
  }
  if (request.effort?.trim()) {
    overrides.effort = request.effort.trim();
  }
  return overrides;
}

/**
 * Builds the `UserInput[]` for a turn. Images ride as first-class `localImage`
 * inputs so the model actually sees them; the prompt text keeps its human-readable
 * "Attached image files:" list, which is what both renderers key their thumbnails
 * off and what the transcript dedupe matches on.
 *
 * `sectionId` is the Panda section this turn belongs to. It rides the prompt
 * because the turn is the only per-section channel Codex has: one app-server
 * process serves every section, so the environment its shell commands inherit
 * cannot name the caller. See `codexSectionIdentityPrompt`.
 */
function userInputs(prompts: QueuedPrompt[], sectionId: string): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = [];
  for (const prompt of prompts) {
    const text = codexPromptPayload(prompt.text, sectionId);
    if (text) {
      inputs.push({ type: "text", text, text_elements: [] });
    }
    for (const path of prompt.imagePaths ?? []) {
      inputs.push({ type: "localImage", path });
    }
  }
  return inputs;
}

const APPROVE_OPTIONS: ApprovalOption[] = [
  { id: "accept", label: "Approve", hint: "Allow this once", tone: "approve" },
  { id: "acceptForSession", label: "Approve for session", hint: "Stop asking for this", tone: "approve" },
  { id: "decline", label: "Deny", hint: "Refuse and let Codex continue", tone: "deny" },
];

const ELICITATION_OPTIONS: ApprovalOption[] = [
  { id: "accept", label: "Continue", hint: "Confirm this request", tone: "approve" },
  { id: "decline", label: "Decline", hint: "Decline this request", tone: "deny" },
];

function commandApprovalPrompt(promptId: string, params: Record<string, unknown>, at: string): PendingApproval {
  const command = asString(params.command);
  const actions = Array.isArray(params.commandActions) ? params.commandActions.length : 0;
  const network = asRecord(params.networkApprovalContext);
  const networkHost = asString(network?.host);
  const networkProtocol = asString(network?.protocol);
  const kind = asString(params.kind);
  return {
    promptId,
    kind: "command",
    title: networkHost ? "Allow network access?" : kind === "stdin" ? "Write to a running command?" : "Run a command?",
    body: networkHost
      ? `${networkProtocol ? `${networkProtocol} ` : ""}${networkHost}`
      : command ?? (actions > 0 ? `${actions} command action(s)` : "Codex wants to run a command."),
    reason: asString(params.reason),
    cwd: asString(params.cwd),
    options: APPROVE_OPTIONS,
    requestedAt: at,
  };
}

function fileChangeApprovalPrompt(promptId: string, params: Record<string, unknown>, at: string): PendingApproval {
  const grantRoot = asString(params.grantRoot);
  return {
    promptId,
    kind: "fileChange",
    title: "Apply file changes?",
    body: grantRoot ? `Codex wants write access under ${grantRoot}.` : "Codex wants to write outside its sandbox.",
    reason: asString(params.reason),
    options: APPROVE_OPTIONS,
    requestedAt: at,
  };
}

function permissionSummary(permissions: Record<string, unknown>): string {
  const lines: string[] = [];
  const network = asRecord(permissions.network);
  if (network?.enabled === true) {
    lines.push("Network access");
  }
  const fileSystem = asRecord(permissions.fileSystem);
  const read = Array.isArray(fileSystem?.read) ? fileSystem.read.filter((path): path is string => typeof path === "string") : [];
  const write = Array.isArray(fileSystem?.write) ? fileSystem.write.filter((path): path is string => typeof path === "string") : [];
  if (read.length > 0) lines.push(`Read: ${read.join(", ")}`);
  if (write.length > 0) lines.push(`Write: ${write.join(", ")}`);
  const entries = Array.isArray(fileSystem?.entries) ? fileSystem.entries : [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const path = asString(asRecord(record?.path)?.path) ?? asString(record?.path);
    const access = asString(record?.access);
    if (path) lines.push(`${access ? `${access}: ` : "Filesystem: "}${path}`);
  }
  return lines.join("\n") || "Codex requested additional sandbox permissions.";
}

function permissionApprovalPrompt(promptId: string, params: Record<string, unknown>, at: string): PendingApproval | undefined {
  const permissions = asRecord(params.permissions);
  if (!permissions) return undefined;
  return {
    promptId,
    kind: "permissions",
    title: "Grant additional permissions?",
    body: permissionSummary(permissions),
    reason: asString(params.reason),
    cwd: asString(params.cwd),
    options: APPROVE_OPTIONS,
    requestedAt: at,
  };
}

function userInputPrompt(
  promptId: string,
  question: UserInputQuestion,
  index: number,
  total: number,
  at: string,
): PendingApproval {
  return {
    promptId,
    kind: "userInput",
    title: question.header.trim() || "Codex has a question",
    body: question.question,
    options: (question.options ?? []).map((option, optionIndex) => ({
      id: `option:${optionIndex}`,
      label: option.label,
      hint: option.description,
    })),
    // A question with no options is free-text by definition; `isOther` means
    // "the options are not exhaustive, a typed answer is also fine".
    allowsFreeText: question.isOther || (question.options ?? []).length === 0,
    requestedAt: at,
    questionCount: total,
    questionIndex: index,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseQuestions(params: Record<string, unknown>): UserInputQuestion[] {
  const raw = Array.isArray(params.questions) ? params.questions : [];
  return raw.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          const optionRecord = option && typeof option === "object" ? (option as Record<string, unknown>) : null;
          const label = optionRecord ? asString(optionRecord.label) : undefined;
          return label ? [{ label, description: asString(optionRecord?.description) }] : [];
        })
      : null;
    return [
      {
        id: asString(record.id) ?? `q${index}`,
        header: asString(record.header) ?? "",
        question: asString(record.question) ?? "",
        isOther: record.isOther === true,
        isSecret: record.isSecret === true,
        options,
      },
    ];
  });
}

function schemaOptions(schema: Record<string, unknown>): UserInputQuestion["options"] {
  const direct = Array.isArray(schema.enum)
    ? schema.enum.map((value) => ({ label: String(value), value }))
    : [];
  if (direct.length > 0) return direct;
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  const titled = oneOf.flatMap((entry) => {
    const option = asRecord(entry);
    if (!option || option.const === undefined) return [];
    return [{ label: asString(option.title) ?? String(option.const), value: option.const }];
  });
  return titled.length > 0 ? titled : null;
}

function parseMcpFormQuestions(params: Record<string, unknown>): UserInputQuestion[] {
  const requestedSchema = asRecord(params.requestedSchema);
  const properties = asRecord(requestedSchema?.properties);
  if (!properties) return [];
  const required = new Set(Array.isArray(requestedSchema?.required) ? requestedSchema.required.filter((key): key is string => typeof key === "string") : []);
  return Object.entries(properties).flatMap(([id, rawSchema]) => {
    const schema = asRecord(rawSchema);
    if (!schema) return [];
    const type = asString(schema.type) ?? "string";
    const itemSchema = asRecord(schema.items);
    const valueType: UserInputQuestion["valueType"] =
      type === "number" || type === "integer" || type === "boolean"
        ? type
        : type === "array" && itemSchema
          ? "stringArray"
          : "string";
    let options = schemaOptions(schema);
    if (valueType === "boolean") {
      options = [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ];
    } else if (valueType === "stringArray" && itemSchema) {
      options = schemaOptions(itemSchema);
    }
    const description = asString(schema.description);
    const optional = !required.has(id);
    return [{
      id,
      header: asString(schema.title) ?? id,
      question: description ?? `${optional ? "Optionally enter" : "Enter"} ${id}.`,
      isOther: options === null || valueType === "stringArray",
      isSecret: asString(schema.format) === "password",
      options,
      valueType,
    }];
  });
}

function mcpElicitationPrompt(
  promptId: string,
  params: Record<string, unknown>,
  questions: UserInputQuestion[],
  questionIndex: number,
  at: string,
): PendingApproval {
  const mode = asString(params.mode);
  if (mode === "url") {
    const message = asString(params.message) ?? "The connected service needs you to continue in a browser.";
    const url = asString(params.url);
    return {
      promptId,
      kind: "mcpElicitation",
      title: `${asString(params.serverName) ?? "Connected service"} needs confirmation`,
      body: [message, url].filter(Boolean).join("\n"),
      options: ELICITATION_OPTIONS,
      requestedAt: at,
    };
  }
  const question = questions[questionIndex];
  if (!question) {
    return {
      promptId,
      kind: "mcpElicitation",
      title: `${asString(params.serverName) ?? "Connected service"} requests information`,
      body: asString(params.message) ?? "Continue with this request?",
      options: ELICITATION_OPTIONS,
      requestedAt: at,
    };
  }
  const prompt = userInputPrompt(promptId, question, questionIndex, questions.length, at);
  return {
    ...prompt,
    kind: "mcpElicitation",
    title: question.header.trim() || `${asString(params.serverName) ?? "Connected service"} asks`,
    options: [...prompt.options, { id: "decline", label: "Decline", hint: "Decline the whole request", tone: "deny" }],
  };
}

function coerceElicitationValue(question: UserInputQuestion, value: unknown): unknown {
  if (typeof value !== "string") return value;
  switch (question.valueType) {
    case "number": {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "integer": {
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : value;
    }
    case "boolean":
      return value.toLowerCase() === "true" || value.toLowerCase() === "yes";
    case "stringArray":
      return value.split(",").map((part) => part.trim()).filter(Boolean);
    default:
      return value;
  }
}

export class CodexAppServerSessionManager {
  private readonly deps: CodexAppServerManagerDeps;
  private readonly sessions = new Map<string, CodexAppServerSession>();
  private client: CodexAppServerClient | null = null;
  private clientReady: Promise<void> | null = null;
  private approvalCounter = 0;
  /**
   * Last `account/rateLimits/updated` the server volunteered. Account-scoped, so
   * it belongs to the manager rather than any thread — and it means the usage card
   * gets fresh numbers for free while a Codex section is live, instead of the
   * poller spawning a throwaway app-server every minute to ask.
   */
  private rateLimits: { payload: unknown; at: number } | null = null;

  constructor(deps: CodexAppServerManagerDeps) {
    this.deps = deps;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  get(id: string): CodexAppServerSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Change the model/effort/sandbox of a live thread mid-session. We mutate the
   * stored request so the next `turn/start` carries the new overrides (Codex
   * applies model/effort "for this turn and subsequent turns"); no thread restart
   * is needed. An `undefined` field is left untouched; an empty string clears it.
   */
  updateOverrides(id: string, overrides: { model?: string; effort?: string; permissionMode?: string }): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const apply = (current: string | undefined, next: string | undefined): string | undefined => {
      if (next === undefined) return current;
      const trimmed = next.trim();
      return trimmed ? trimmed : undefined;
    };
    session.request = {
      ...session.request,
      model: apply(session.request.model, overrides.model),
      effort: apply(session.request.effort, overrides.effort),
      permissionMode: apply(session.request.permissionMode, overrides.permissionMode),
    };
    if (overrides.model !== undefined) {
      session.state.latestModel = session.request.model;
    }
    this.deps.logMain("app-server:switch", {
      id,
      model: session.request.model,
      effort: session.request.effort,
      permissionMode: session.request.permissionMode,
    });
  }

  /** Ensure the shared client exists and has completed its handshake. */
  private ensureClient(): Promise<void> {
    if (this.client && this.clientReady) {
      return this.clientReady;
    }
    const client = this.deps.createClient({
      onNotification: (note) => this.handleNotification(note),
      onServerRequest: (request) => this.handleServerRequest(request),
      // The process may report its exit after stop() has already installed a
      // replacement client. Carry the originating client into the callback so
      // a stale exit cannot tear down the new transport and its sessions.
      onExit: (code) => this.handleClientExit(client, code),
    });
    this.client = client;
    const features = this.deps.experimentalFeatures;
    this.clientReady = client
      .start()
      .then(async () => {
        if (features && Object.keys(features).length > 0) {
          try {
            await client.request("experimentalFeature/enablement/set", { enablement: features });
            this.deps.logMain("app-server:features-enabled", features);
          } catch (error) {
            // An unknown flag must not stop the session from starting.
            this.deps.logMain("app-server:features-failed", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })
      .catch((error) => {
        this.deps.logMain("app-server:client-start-failed", { message: error instanceof Error ? error.message : String(error) });
        // A failed/disposed client can settle after another start has already
        // replaced it. Only clear the generation that actually failed.
        if (this.client === client) {
          this.client = null;
          this.clientReady = null;
        }
        throw error;
      });
    return this.clientReady;
  }

  /**
   * Rate limits harvested from the live client, newest first: the pushed
   * notification if we have one, otherwise a read over the already-running
   * client. Returns null when no client is up — the caller decides whether a
   * throwaway process is worth spawning.
   */
  async readRateLimits(timeoutMs: number, maxAgeMs: number): Promise<unknown | null> {
    const client = this.client;
    if (client) {
      try {
        // A read over the running client is one round-trip and returns the full
        // multi-bucket view, so it beats the sparse rolling notification.
        return await client.request("account/rateLimits/read", undefined, { timeoutMs });
      } catch (error) {
        this.deps.logMain("app-server:rate-limits-failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.rateLimits && Date.now() - this.rateLimits.at <= maxAgeMs) {
      return this.rateLimits.payload;
    }
    return null;
  }

  /** Ask the already-running app-server for the models available to this account. */
  async listModels(timeoutMs: number): Promise<unknown | null> {
    const client = this.client;
    if (!client) {
      return null;
    }
    try {
      // Codex 0.147.0 requires an explicit params object for model/list.
      return await client.request("model/list", {}, { timeoutMs });
    } catch (error) {
      this.deps.logMain("app-server:model-list-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Make a semantic title authoritative before publishing it to the renderer.
   * A transcript-index refresh may already be in flight; its completion checks
   * this lock and must not replace the semantic name with raw prompt context.
   */
  lockTitle(id: string, title: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.emittedTitle = title;
    session.titleLocked = true;
    return true;
  }

  /** Route a notification to the owning section by threadId. */
  private handleNotification(note: { method: string; params: unknown }): void {
    const params = (note.params ?? {}) as Record<string, unknown>;
    // Account-scoped notifications carry no threadId and belong to no section.
    if (note.method === "account/rateLimits/updated") {
      this.rateLimits = { payload: note.params, at: Date.now() };
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : threadIdFromNotification(note);
    // Deprecation/config notices are connection-scoped and carry no thread id.
    // The shared app-server backs every Codex section, so surface the notice in
    // each live section instead of silently dropping it as an orphan event.
    if (!threadId && (note.method === "deprecationNotice" || note.method === "configWarning" || note.method === "warning")) {
      for (const [id, session] of this.sessions) {
        applyAppServerNotification(session.state, note.method, note.params);
        this.deps.sendSnapshot(id, session);
      }
      return;
    }
    const entry = threadId ? this.findByThreadId(threadId) : undefined;
    if (!entry) {
      return;
    }
    const [id, session] = entry;
    if (note.method === "thread/name/updated") {
      const threadName = asString(params.threadName);
      if (threadName) {
        this.lockTitle(id, threadName);
        this.deps.setTitle?.(id, threadName);
      }
    }
    if (typeof params.turnId === "string") {
      session.turnId = params.turnId;
    }
    if (note.method === "turn/started") {
      session.turnId = turnIdFromNotification(params) ?? session.turnId;
      session.turnActive = true;
      // A request still held when a new turn begins belongs to the old turn and
      // the operator never answered it. Cancel it rather than dropping it: an
      // unanswered JSON-RPC request leaves the server waiting forever.
      this.cancelHeld(session);
    }
    if (note.method === "turn/completed") {
      session.turnActive = false;
      this.cancelHeld(session);
    }
    if (note.method === "serverRequest/resolved") {
      // The server answered it itself (auto-approval, timeout, another client) —
      // it is NOT waiting on us, so just let go.
      session.held = undefined;
      session.state.pendingApproval = undefined;
    }

    applyAppServerNotification(session.state, note.method, note.params);
    if (note.method === "turn/started") {
      session.state.pendingApproval = undefined;
    }
    this.deps.sendSnapshot(id, session);
    if (session.threadId && (note.method === "thread/started" || note.method === "turn/completed")) {
      this.deps.syncTitle?.(id, session);
    }
    // A completed turn releases anything that queued behind it.
    if (note.method === "turn/completed" && session.queue.length > 0) {
      void this.flushQueue(id);
    }
  }

  /**
   * Server→client requests. Approvals and `requestUserInput` are held open and
   * surfaced to the operator; anything we cannot represent is refused
   * immediately (never left hanging) and recorded in the transcript.
   */
  private handleServerRequest(request: AppServerServerRequest): void {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const entry = threadId ? this.findByThreadId(threadId) : undefined;
    if (!entry) {
      this.deps.logMain("app-server:server-request-orphan", { method: request.method, threadId });
      this.client?.respondError(request.id, -32602, `No live Panda section owns thread ${threadId ?? "?"}`);
      return;
    }
    const [id, session] = entry;
    const at = new Date().toISOString();
    const promptId = `approval:${id}:${++this.approvalCounter}`;

    let prompt: PendingApproval | undefined;
    let questions: UserInputQuestion[] = [];
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        prompt = commandApprovalPrompt(promptId, params, at);
        break;
      case "item/fileChange/requestApproval":
        prompt = fileChangeApprovalPrompt(promptId, params, at);
        break;
      case "item/tool/requestUserInput": {
        questions = parseQuestions(params);
        if (questions.length === 0) {
          break;
        }
        prompt = userInputPrompt(promptId, questions[0]!, 0, questions.length, at);
        break;
      }
      case "item/permissions/requestApproval":
        prompt = permissionApprovalPrompt(promptId, params, at);
        break;
      case "mcpServer/elicitation/request": {
        const mode = asString(params.mode);
        if (mode !== "url") {
          questions = parseMcpFormQuestions(params);
        }
        prompt = mcpElicitationPrompt(promptId, params, questions, 0, at);
        break;
      }
      default:
        break;
    }

    if (!prompt) {
      // Unsupported (permissions profiles, MCP elicitation, dynamic tool calls).
      // Refusing keeps the turn moving instead of blocking it forever, and the
      // transcript says why rather than leaving the model's "I can't ask you"
      // reply unexplained.
      this.deps.logMain("app-server:server-request-declined", { method: request.method, id: request.id });
      this.client?.respondError(request.id, -32601, `Panda Code cannot answer ${request.method} yet.`);
      pushSystemItem(
        session.state,
        `codex:unsupported-request:${request.method}:${at}`,
        "Codex asked for something Panda can't answer",
        `Codex sent \`${request.method}\`, which Panda Code does not support yet, so it was declined. The turn continues without it.`,
        at,
      );
      this.deps.sendSnapshot(id, session);
      return;
    }

    session.held = {
      requestId: request.id,
      method: request.method,
      promptId,
      params,
      questions,
      answers: {},
      elicitationContent: {},
      requestedPermissions: asRecord(params.permissions) ?? undefined,
      questionIndex: 0,
    };
    session.state.pendingApproval = prompt;
    session.state.agentState = "needs_action";
    session.state.currentEventType = request.method;
    session.state.lastEventAt = at;
    pushSystemItem(
      session.state,
      `codex:approval:${promptId}`,
      prompt.kind === "userInput" ? "Codex asked a question" : "Approval requested",
      [prompt.title, prompt.body, prompt.reason ? `Reason: ${prompt.reason}` : ""].filter(Boolean).join("\n"),
      at,
    );
    this.deps.logMain("app-server:approval-requested", { id, method: request.method, promptId, kind: prompt.kind });
    this.deps.sendSnapshot(id, session);
  }

  /**
   * Answer the section's pending approval/question. Multi-question requests
   * advance to the next question instead of replying, so the JSON-RPC request is
   * answered exactly once, with every answer.
   */
  answerApproval(answer: SessionApprovalAnswer): SessionApprovalResult {
    const session = this.sessions.get(answer.id);
    if (!session?.held || !session.state.pendingApproval) {
      return { ok: false, message: "This section has no pending approval." };
    }
    const held = session.held;
    if (held.promptId !== answer.promptId) {
      return { ok: false, message: "That approval is no longer the pending one." };
    }
    const client = this.client;
    if (!client) {
      return { ok: false, message: "The Codex app-server is no longer running." };
    }
    const prompt = session.state.pendingApproval;
    const at = new Date().toISOString();

    if (held.method === "item/permissions/requestApproval") {
      const decision = answer.optionId;
      if (decision !== "accept" && decision !== "acceptForSession" && decision !== "decline") {
        return { ok: false, message: `Unknown decision "${decision ?? ""}".` };
      }
      client.respond(held.requestId, {
        permissions: decision === "decline" ? {} : (held.requestedPermissions ?? {}),
        scope: decision === "acceptForSession" ? "session" : "turn",
      });
      this.settleApproval(
        answer.id,
        session,
        decision === "decline" ? "Denied additional permissions" : decision === "acceptForSession" ? "Granted permissions for the session" : "Granted permissions for this turn",
        at,
      );
      return { ok: true };
    }

    if (held.method === "mcpServer/elicitation/request") {
      if (answer.optionId === "decline") {
        client.respond(held.requestId, { action: "decline", content: null, _meta: null });
        this.settleApproval(answer.id, session, "Declined connected-service request", at);
        return { ok: true };
      }
      const mode = asString(held.params.mode);
      if (mode === "url" || held.questions.length === 0) {
        if (answer.optionId !== "accept") {
          return { ok: false, message: "Continue or decline this request." };
        }
        client.respond(held.requestId, { action: "accept", content: null, _meta: null });
        this.settleApproval(answer.id, session, "Confirmed connected-service request", at);
        return { ok: true };
      }
      const question = held.questions[held.questionIndex];
      if (!question) return { ok: false, message: "That form field is no longer pending." };
      const sourceOption = answer.optionId?.startsWith("option:")
        ? question.options?.[Number(answer.optionId.slice("option:".length))]
        : undefined;
      const rawValue = sourceOption?.value ?? sourceOption?.label ?? answer.text?.trim();
      if (rawValue === undefined || rawValue === "") {
        return { ok: false, message: "Pick an option or type an answer." };
      }
      held.elicitationContent[question.id] = coerceElicitationValue(question, rawValue);
      held.questionIndex += 1;
      const next = held.questions[held.questionIndex];
      if (next) {
        session.state.pendingApproval = mcpElicitationPrompt(held.promptId, held.params, held.questions, held.questionIndex, at);
        this.deps.sendSnapshot(answer.id, session);
        return { ok: true };
      }
      client.respond(held.requestId, { action: "accept", content: held.elicitationContent, _meta: null });
      this.settleApproval(answer.id, session, "Answered connected-service request", at);
      return { ok: true };
    }

    if (held.method === "item/tool/requestUserInput") {
      const question = held.questions[held.questionIndex];
      if (!question) {
        return { ok: false, message: "That question is no longer pending." };
      }
      const chosen = optionLabel(prompt, answer.optionId);
      const text = answer.text?.trim();
      const value = chosen ?? text;
      if (!value) {
        return { ok: false, message: "Pick an option or type an answer." };
      }
      held.answers[question.id] = { answers: [value] };
      held.questionIndex += 1;
      const next = held.questions[held.questionIndex];
      if (next) {
        session.state.pendingApproval = userInputPrompt(
          held.promptId,
          next,
          held.questionIndex,
          held.questions.length,
          at,
        );
        this.deps.sendSnapshot(answer.id, session);
        return { ok: true };
      }
      client.respond(held.requestId, { answers: held.answers });
      this.settleApproval(answer.id, session, `Answered: ${question.isSecret ? "(hidden)" : value}`, at);
      return { ok: true };
    }

    const decision = answer.optionId;
    if (decision !== "accept" && decision !== "acceptForSession" && decision !== "decline") {
      return { ok: false, message: `Unknown decision "${decision ?? ""}".` };
    }
    client.respond(held.requestId, { decision });
    this.settleApproval(
      answer.id,
      session,
      decision === "decline" ? "Denied" : decision === "acceptForSession" ? "Approved for the session" : "Approved",
      at,
    );
    return { ok: true };
  }

  /**
   * Let go of a held request WITHOUT an operator answer, telling Codex we are
   * done with it. `cancel` (and an empty answer map) is the protocol's
   * "nobody answered" reply; skipping it wedges the thread.
   */
  private cancelHeld(session: CodexAppServerSession): void {
    const held = session.held;
    if (!held) {
      return;
    }
    session.held = undefined;
    session.state.pendingApproval = undefined;
    const cancel =
      held.method === "item/tool/requestUserInput"
        ? { answers: {} }
        : held.method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" }
          : held.method === "mcpServer/elicitation/request"
            ? { action: "cancel", content: null, _meta: null }
            : { decision: "cancel" };
    this.client?.respond(held.requestId, cancel);
    this.deps.logMain("app-server:approval-cancelled", { promptId: held.promptId, method: held.method });
  }

  /** Clear the hold, record the outcome, and hand the turn back to Codex. */
  private settleApproval(id: string, session: CodexAppServerSession, outcome: string, at: string): void {
    const promptId = session.held?.promptId ?? "";
    session.held = undefined;
    session.state.pendingApproval = undefined;
    session.state.agentState = "working";
    session.state.lastEventAt = at;
    pushSystemItem(session.state, `codex:approval-answer:${promptId}`, "Approval answered", outcome, at);
    this.deps.logMain("app-server:approval-answered", { id, promptId, outcome });
    this.deps.sendSnapshot(id, session);
  }

  private handleClientExit(client: CodexAppServerClient, code: number | null): void {
    const stale = this.client !== client;
    this.deps.logMain("app-server:client-exit", { code, sessions: this.sessions.size, stale });
    if (stale) {
      return;
    }
    for (const [id, session] of this.sessions) {
      // The thread is gone with the client; a future prompt must wait for a
      // fresh thread/resume rather than fire turn/start at a dead process.
      session.threadReady = false;
      session.turnActive = false;
      session.held = undefined;
      session.state.pendingApproval = undefined;
      session.state.agentState = "exited";
      session.state.currentEventType = "process:exit";
      session.state.lastEventAt = new Date().toISOString();
      this.deps.sendSnapshot(id, session);
    }
    this.client = null;
    this.clientReady = null;
  }

  private findByThreadId(threadId: string): [string, CodexAppServerSession] | undefined {
    for (const entry of this.sessions) {
      if (entry[1].threadId === threadId) {
        return entry;
      }
    }
    return undefined;
  }

  /** Start (or re-attach) a section and, if a prompt was given, run a turn. */
  async start(request: SessionStartRequest, prompt?: string): Promise<SessionStartResult> {
    const existing = this.sessions.get(request.id);
    if (existing) {
      if (prompt) {
        await this.sendInput(request.id, prompt);
      }
      return { ok: true };
    }

    // Register the section synchronously, BEFORE the async client handshake +
    // thread/start, so has()/sendInput() see it immediately. Otherwise the first
    // prompt (sent by the renderer ~ms after start) races ahead of registration,
    // misses every sendInput branch, and is silently dropped.
    const session: CodexAppServerSession = {
      request,
      // Same reason as the Claude launch path: a section is only ever started to
      // carry a prompt, and the handshake + thread/start below take seconds. A
      // "waiting" seed makes the snapshot on the next line report the section
      // idle before its first turn has even been sent.
      state: { ...createStreamJsonState(), agentState: "working", latestModel: request.model },
      cwd: request.cwd,
      threadId: request.codexThreadId,
      queue: prompt ? [{ text: prompt }] : [],
      lastPromptAt: Date.now(),
    };
    this.sessions.set(request.id, session);
    this.deps.sendSnapshot(request.id, session);

    try {
      await this.ensureClient();
    } catch (error) {
      this.sessions.delete(request.id);
      return { ok: false, message: error instanceof Error ? error.message : "Could not start codex app-server." };
    }
    const client = this.client;
    if (!client) {
      this.sessions.delete(request.id);
      return { ok: false, message: "codex app-server client unavailable." };
    }

    try {
      if (request.codexThreadId) {
        const resumed = (await client.request("thread/resume", {
          threadId: request.codexThreadId,
          // Panda pages transcript history separately. Hydrating every turn in
          // the resume response is wasted work and deprecated by app-server.
          excludeTurns: true,
          ...threadParamsFromRequest(request),
        })) as { thread?: { id?: string; model?: string }; model?: string };
        session.threadId = resumed?.thread?.id ?? request.codexThreadId;
        session.state.latestModel = resumed?.model ?? resumed?.thread?.model ?? session.state.latestModel;
      } else {
        const started = (await client.request("thread/start", threadParamsFromRequest(request))) as {
          thread?: { id?: string };
          model?: string;
        };
        session.threadId = started?.thread?.id;
        if (typeof started?.model === "string") {
          session.state.latestModel = started.model;
        }
      }
      if (session.threadId) {
        session.state.codexThreadId = session.threadId;
      }
      // The thread is now live on this client; prompts queued in sendInput may
      // safely flush as turns.
      session.threadReady = true;
      this.deps.logMain("app-server:thread-ready", { id: request.id, threadId: session.threadId });
      this.deps.sendSnapshot(request.id, session);
    } catch (error) {
      this.sessions.delete(request.id);
      return { ok: false, message: error instanceof Error ? error.message : "Could not open codex thread." };
    }

    await this.flushQueue(request.id);
    return { ok: true };
  }

  /**
   * Deliver a prompt: steer the live turn, start a new one, or queue it until the
   * thread is live. Reports failure honestly — the caller shows a "Thinking…"
   * bubble on the strength of this result, so an `ok: true` that never becomes a
   * turn strands the UI forever.
   */
  async sendInput(id: string, prompt: string, imagePaths?: string[]): Promise<SessionInputResult> {
    const session = this.sessions.get(id);
    if (!session) {
      this.deps.logMain("app-server:input-no-session", { id });
      return { ok: false, message: "This section's Codex thread is no longer running. Send the prompt again to restart it." };
    }
    const queued: QueuedPrompt = { text: prompt, imagePaths };

    if (!session.threadReady) {
      // A thread that is merely opening WILL flush (start() drains the queue).
      // A dead client will not: nothing is coming to flush it, so say so and let
      // the caller restart the section instead of waiting on a turn that never runs.
      if (!this.client) {
        this.deps.logMain("app-server:input-client-gone", { id });
        return { ok: false, message: "The Codex app-server stopped. Send the prompt again to restart this section." };
      }
      session.queue.push(queued);
      this.deps.logMain("app-server:input-queued", { id, depth: session.queue.length, hasThread: Boolean(session.threadId) });
      return { ok: true };
    }

    if (session.held) {
      return { ok: false, message: "Codex is waiting on an approval. Answer it first." };
    }

    return session.turnActive ? this.steerTurn(id, session, queued) : this.startTurn(id, session, [queued]);
  }

  /**
   * Drain queued prompts into ONE turn. They only ever pile up inside the brief
   * window where the thread is opening, so folding them into a single turn keeps
   * every word, in order, without firing turns Codex would reject as overlapping.
   */
  private async flushQueue(id: string): Promise<SessionInputResult> {
    const session = this.sessions.get(id);
    if (!session || session.queue.length === 0) {
      return { ok: true };
    }
    if (!session.threadReady || session.held) {
      return { ok: true };
    }
    const prompts = session.queue.splice(0, session.queue.length);
    if (session.turnActive) {
      let last: SessionInputResult = { ok: true };
      for (const prompt of prompts) {
        last = await this.steerTurn(id, session, prompt);
      }
      return last;
    }
    return this.startTurn(id, session, prompts);
  }

  private markWorking(id: string, session: CodexAppServerSession, eventType: string): void {
    session.lastPromptAt = Date.now();
    session.state.agentState = "working";
    session.state.currentEventType = eventType;
    session.state.lastEventAt = new Date().toISOString();
    this.deps.sendSnapshot(id, session);
  }

  private async startTurn(id: string, session: CodexAppServerSession, prompts: QueuedPrompt[]): Promise<SessionInputResult> {
    const client = this.client;
    if (!session.threadId || !client) {
      this.deps.logMain("app-server:turn-no-session", { id, hasThread: Boolean(session.threadId) });
      return { ok: false, message: "This section's Codex thread is gone. Send the prompt again to restart it." };
    }
    this.markWorking(id, session, "input:submitted");
    try {
      const result = (await client.request("turn/start", {
        threadId: session.threadId,
        input: userInputs(prompts, id),
        ...turnOverridesFromRequest(session.request),
      })) as { turn?: { id?: string; status?: string } };
      session.turnId = result?.turn?.id ?? session.turnId;
      // The response carries the turn's status; only claim the turn is steerable
      // while it really is still running. (`turn/started` sets this too — whichever
      // lands first wins, and a fast turn that already completed stays inactive.)
      if (result?.turn?.status === undefined || result.turn.status === "inProgress") {
        session.turnActive = true;
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logMain("app-server:turn-start-failed", { id, message });
      session.state.agentState = "needs_action";
      session.state.currentEventType = "process:error";
      session.state.lastEventAt = new Date().toISOString();
      this.deps.sendSnapshot(id, session);
      return { ok: false, message: `Codex refused the prompt: ${message}` };
    }
  }

  /**
   * Steer the in-flight turn. `expectedTurnId` is a server-side precondition, so
   * a turn that finished between our check and this call fails the request rather
   * than silently landing somewhere unexpected — in that case start a fresh turn.
   */
  private async steerTurn(id: string, session: CodexAppServerSession, prompt: QueuedPrompt): Promise<SessionInputResult> {
    const client = this.client;
    const turnId = session.turnId;
    if (!session.threadId || !client || !turnId) {
      return this.startTurn(id, session, [prompt]);
    }
    this.markWorking(id, session, "input:steered");
    try {
      const result = (await client.request("turn/steer", {
        threadId: session.threadId,
        input: userInputs([prompt], id),
        expectedTurnId: turnId,
      })) as { turnId?: string };
      session.turnId = result?.turnId ?? session.turnId;
      this.deps.logMain("app-server:turn-steered", { id, turnId });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logMain("app-server:turn-steer-failed", { id, turnId, message });
      session.turnActive = false;
      return this.startTurn(id, session, [prompt]);
    }
  }

  /**
   * Interrupt the active turn, if any, then drop the section.
   *
   * The client teardown at zero sessions below is what makes hibernating a Codex
   * section worth anything: one `codex app-server` process backs ALL of them, so
   * reaping one of five frees no memory at all — only the last one out closes
   * the process. Codex sections are cheap in a way Claude sections are not, and
   * the reaper's per-section accounting quietly over-credits them.
   */
  stop(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      this.cancelHeld(session);
    }
    if (session?.threadId && session.turnId && session.turnActive && this.client) {
      this.client.request("turn/interrupt", { threadId: session.threadId, turnId: session.turnId }).catch(() => undefined);
    }
    if (session?.threadId && this.client && this.sessions.size > 1) {
      // A shared app-server remains alive for the other Panda sections. Release
      // this connection's subscription so Codex can unload the stopped thread
      // after its inactivity grace period and no orphan events keep arriving.
      this.client.request("thread/unsubscribe", { threadId: session.threadId }).catch((error) => {
        this.deps.logMain("app-server:thread-unsubscribe-failed", {
          id,
          threadId: session.threadId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.sessions.delete(id);
    if (this.sessions.size === 0 && this.client) {
      this.client.dispose();
      this.client = null;
      this.clientReady = null;
    }
  }

  disposeAll(): void {
    this.sessions.clear();
    this.client?.dispose();
    this.client = null;
    this.clientReady = null;
  }
}

/** Resolve an answered option id back to the label Codex expects. */
function optionLabel(prompt: PendingApproval, optionId: string | undefined): string | undefined {
  if (!optionId) {
    return undefined;
  }
  return prompt.options.find((option) => option.id === optionId)?.label;
}

function pushSystemItem(state: StreamJsonState, itemId: string, title: string, body: string, timestamp: string): void {
  if (state.items.some((item) => item.id === itemId)) {
    return;
  }
  state.items.push({ id: itemId, kind: "system", title, body, timestamp, sequence: state.sequence++ });
}

/** Best-effort threadId extraction for notifications that nest it. */
function threadIdFromNotification(note: { method: string; params: unknown }): string | undefined {
  const params = note.params as Record<string, unknown> | null | undefined;
  if (!params) {
    return undefined;
  }
  const thread = params.thread as { id?: unknown } | undefined;
  return typeof thread?.id === "string" ? thread.id : undefined;
}

/** `turn/started` nests the id under `turn`; other notifications carry `turnId`. */
function turnIdFromNotification(params: Record<string, unknown>): string | undefined {
  const turn = params.turn as { id?: unknown } | undefined;
  return typeof turn?.id === "string" ? turn.id : undefined;
}
