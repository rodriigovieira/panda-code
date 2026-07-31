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
  questions: UserInputQuestion[];
  answers: Record<string, { answers: string[] }>;
  questionIndex: number;
};

type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description?: string }> | null;
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
 */
function userInputs(prompts: QueuedPrompt[]): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = [];
  for (const prompt of prompts) {
    const text = codexPromptPayload(prompt.text);
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

function commandApprovalPrompt(promptId: string, params: Record<string, unknown>, at: string): PendingApproval {
  const command = asString(params.command);
  const actions = Array.isArray(params.commandActions) ? params.commandActions.length : 0;
  return {
    promptId,
    kind: "command",
    title: "Run a command?",
    body: command ?? (actions > 0 ? `${actions} command action(s)` : "Codex wants to run a command."),
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
      onExit: (code) => this.handleClientExit(code),
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
        this.client = null;
        this.clientReady = null;
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

  /** Route a notification to the owning section by threadId. */
  private handleNotification(note: { method: string; params: unknown }): void {
    const params = (note.params ?? {}) as Record<string, unknown>;
    // Account-scoped notifications carry no threadId and belong to no section.
    if (note.method === "account/rateLimits/updated") {
      this.rateLimits = { payload: note.params, at: Date.now() };
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : threadIdFromNotification(note);
    const entry = threadId ? this.findByThreadId(threadId) : undefined;
    if (!entry) {
      return;
    }
    const [id, session] = entry;
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
      questions,
      answers: {},
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
    const cancel = held.method === "item/tool/requestUserInput" ? { answers: {} } : { decision: "cancel" };
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

  private handleClientExit(code: number | null): void {
    this.deps.logMain("app-server:client-exit", { code, sessions: this.sessions.size });
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
      state: createStreamJsonState(),
      cwd: request.cwd,
      threadId: request.codexThreadId,
      queue: prompt ? [{ text: prompt }] : [],
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
          ...threadParamsFromRequest(request),
        })) as { thread?: { id?: string } };
        session.threadId = resumed?.thread?.id ?? request.codexThreadId;
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
        input: userInputs(prompts),
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
        input: userInputs([prompt]),
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

  /** Interrupt the active turn, if any, then drop the section. */
  stop(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      this.cancelHeld(session);
    }
    if (session?.threadId && session.turnId && session.turnActive && this.client) {
      this.client.request("turn/interrupt", { threadId: session.threadId, turnId: session.turnId }).catch(() => undefined);
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
