import { confinedPath, readBoundedFile } from "./confinedFiles";
import { providerVisibleFiles } from "./providerFiles";
import type { SessionInputResult, SessionStartRequest, SessionStartResult } from "../shared/ipc";
import { createStreamJsonState, applyStreamJsonEvent, type StreamJsonState } from "../shared/stream-json";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export type GroqSession = {
  request: SessionStartRequest;
  state: StreamJsonState;
  cwd: string;
  lastPromptAt: number;
  controller: AbortController;
  messages: GroqMessage[];
};

type GroqMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: GroqToolCall[];
};

type GroqToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type GroqDeps = {
  getApiKey: () => string | null;
  sendSnapshot: (id: string, session: GroqSession) => void;
  updateRequest?: (id: string, request: SessionStartRequest) => void;
  logMain: (event: string, details?: Record<string, unknown>) => void;
};

function workspaceContext(cwd: string): string {
  const root = resolve(cwd);
  const entries: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 3 || entries.length >= 300) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["node_modules", "build", "dist", "release"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      entries.push(relative(root, path));
      if (entry.isDirectory()) walk(path, depth + 1);
    }
  };
  try { walk(root, 0); } catch { return `Workspace: ${root}`; }
  const metadata = ["README.md", "package.json", "AGENTS.md"].flatMap((name) => {
    const path = resolve(root, name);
    if (!providerVisibleFiles(root, [name]).length) return [];
    try { return [`\n--- ${name} ---\n${readBoundedFile(confinedPath(root, path), 12_000, root).bytes.toString("utf8")}`]; } catch { return []; }
  });
  return `Workspace: ${root}\nFiles:\n${providerVisibleFiles(root, entries).join("\n")}${metadata.join("\n")}`;
}

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

const GROQ_TOOLS = [{
  type: "function",
  function: {
    name: "list_files",
    description: "List non-hidden files and directories in a workspace path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path inside the workspace." } },
      additionalProperties: false,
    },
  },
}, {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a text file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path inside the workspace." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
}];

const IGNORED_DIRECTORIES = new Set(["node_modules", "build", "dist", "release"]);
const MAX_TOOL_OUTPUT = 16_000;
const MAX_LIST_ENTRIES = 200;
const MAX_LIST_DEPTH = 3;

function toolPath(cwd: string, requestedPath: string | undefined): string | null {
  const root = resolve(cwd);
  const target = resolve(root, requestedPath?.trim() || ".");
  const pathParts = relative(root, target).split(sep).filter(Boolean);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
  if (pathParts.some((part) => part.startsWith(".") || IGNORED_DIRECTORIES.has(part))) return null;
  return target;
}

function runGroqTool(cwd: string, name: string, rawArguments: string): string {
  let args: { path?: string } = {};
  try { args = JSON.parse(rawArguments || "{}"); } catch { return "Invalid tool arguments."; }
  let path = toolPath(cwd, args.path);
  if (!path) return "Path must remain inside the workspace and cannot access hidden or excluded directories.";
  try {
    if (existsSync(path)) {
      const realPath = realpathSync(path);
      if (!toolPath(cwd, relative(resolve(cwd), realPath))) return "Path must remain inside the workspace.";
      path = realPath;
    }
    const toolRoot = path;
    if (name === "read_file") {
      if (!existsSync(path) || !statSync(path).isFile()) return "Path is not a file.";
      if (!providerVisibleFiles(cwd, [relative(resolve(cwd), path)]).length) return "This file is excluded from provider access.";
      const bytes = readBoundedFile(path, MAX_TOOL_OUTPUT, cwd).bytes;
      if (bytes.includes(0)) return "Binary files are excluded from provider access.";
      return bytes.toString("utf8");
    }
    if (name === "list_files") {
      if (!existsSync(path) || !statSync(path).isDirectory()) return "Path is not a directory.";
      const entries: string[] = [];
      const walk = (directory: string, depth: number): void => {
        if (depth > MAX_LIST_DEPTH || entries.length >= MAX_LIST_ENTRIES) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) continue;
          const entryPath = resolve(directory, entry.name);
          entries.push(relative(toolRoot, entryPath) || entry.name);
          if (entry.isDirectory()) walk(entryPath, depth + 1);
          if (entries.length >= MAX_LIST_ENTRIES) return;
        }
      };
      walk(path, 0);
      return providerVisibleFiles(cwd, entries.map(entry => relative(resolve(cwd), resolve(toolRoot, entry)))).join("\n").slice(0, MAX_TOOL_OUTPUT);
    }
    return `Unknown tool: ${name}`;
  } catch (error) {
    return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function labelGroqItems(state: StreamJsonState): void {
  for (const item of state.items) {
    if (item.kind === "assistant" && item.title === "Claude") {
      item.title = "Groq";
    }
  }
}

export class GroqSessionManager {
  private readonly deps: GroqDeps;
  private readonly sessions = new Map<string, GroqSession>();

  constructor(deps: GroqDeps) {
    this.deps = deps;
  }

  has(id: string): boolean { return this.sessions.has(id); }
  ids(): string[] { return [...this.sessions.keys()]; }
  get(id: string): GroqSession | undefined { return this.sessions.get(id); }
  getRequest(id: string): SessionStartRequest | undefined { return this.sessions.get(id)?.request; }

  start(request: SessionStartRequest): SessionStartResult {
    if (this.sessions.has(request.id)) return { ok: true };
    const session: GroqSession = {
      request,
      state: { ...createStreamJsonState(), agentState: "waiting" },
      cwd: request.cwd,
      lastPromptAt: Date.now(),
      controller: new AbortController(),
      messages: [],
    };
    this.sessions.set(request.id, session);
    this.deps.logMain("groq:session-start", { id: request.id, cwd: request.cwd, model: request.model });
    this.deps.sendSnapshot(request.id, session);
    return { ok: true };
  }

  async sendInput(id: string, prompt: string): Promise<SessionInputResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, message: "The Groq section is not running." };
    const apiKey = this.deps.getApiKey();
    if (!apiKey) return { ok: false, message: "Configure a Groq API key in Settings first." };

    const text = prompt.replace(/\r+$/, "");
    session.lastPromptAt = Date.now();
    session.state.agentState = "working";
    session.state.currentEventType = "input:submitted";
    session.state.lastEventAt = new Date().toISOString();
    applyStreamJsonEvent(session.state, {
      type: "user",
      message: { role: "user", content: text, id: `groq-user-${session.state.sequence}` },
    });
    if (session.messages.length === 0) {
      session.messages.push({ role: "system", content: `You are working in a local coding workspace. Use the workspace context below when answering.\n\n${workspaceContext(session.cwd)}` });
    }
    session.messages.push({ role: "user", content: text });
    this.deps.logMain("groq:input", { id, bytes: text.length });
    this.deps.sendSnapshot(id, session);

    try {
      const requestedModel = session.request.model?.trim() || DEFAULT_GROQ_MODEL;
      const requestModel = async (model: string): Promise<Response> => fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: session.messages, tools: GROQ_TOOLS, stream: true, stream_options: { include_usage: true } }),
        signal: session.controller.signal,
      });
      let response = await requestModel(requestedModel);
      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 404 && requestedModel !== DEFAULT_GROQ_MODEL && errorBody.includes("model_not_found")) {
          response = await requestModel(DEFAULT_GROQ_MODEL);
          if (response.ok) {
            session.request = { ...session.request, model: DEFAULT_GROQ_MODEL };
            this.deps.updateRequest?.(id, session.request);
          } else {
            throw new Error(`Groq API returned ${response.status}: ${await response.text()}`);
          }
        } else {
          throw new Error(`Groq API returned ${response.status}: ${errorBody}`);
        }
      }
      let rounds = 0;
      let answer = "";
      const messageId = `groq-assistant-${Date.now()}`;
      while (rounds++ < 8) {
        if (!response.body) throw new Error("Groq API returned no response stream.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const toolCalls = new Map<number, GroqToolCall>();
        let finishReason: string | undefined;
        const consume = (chunk: string): void => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            let event: { model?: string; choices?: Array<{ finish_reason?: string; delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
            try {
              event = JSON.parse(payload);
            } catch (error) {
              this.deps.logMain("groq:sse-parse-error", {
                id,
                message: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
            const choice = event.choices?.[0];
            const delta = choice?.delta?.content;
            finishReason = choice?.finish_reason ?? finishReason;
            if (delta) {
              answer += delta;
              applyStreamJsonEvent(session.state, { type: "content_block_delta", message_id: messageId, delta: { text: delta } });
              labelGroqItems(session.state);
            }
            for (const part of choice?.delta?.tool_calls ?? []) {
              const index = part.index ?? 0;
              const existing = toolCalls.get(index) ?? { id: part.id ?? `groq-tool-${index}`, type: "function" as const, function: { name: "", arguments: "" } };
              existing.id = part.id ?? existing.id;
              existing.function.name += part.function?.name ?? "";
              existing.function.arguments += part.function?.arguments ?? "";
              toolCalls.set(index, existing);
            }
            if (event.usage) {
              session.state.tokenUsage.inputTokens = event.usage.prompt_tokens ?? session.state.tokenUsage.inputTokens;
              session.state.tokenUsage.outputTokens = event.usage.completion_tokens ?? session.state.tokenUsage.outputTokens;
              session.state.tokenUsage.totalTokens = event.usage.total_tokens ?? session.state.tokenUsage.totalTokens;
            }
            session.state.latestModel = event.model ?? session.request.model ?? DEFAULT_GROQ_MODEL;
            this.deps.sendSnapshot(id, session);
          }
        };
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          consume(decoder.decode(result.value, { stream: true }));
        }
        consume(decoder.decode());
        const calls = [...toolCalls.values()];
        if (finishReason !== "tool_calls" || calls.length === 0) break;
        session.messages.push({ role: "assistant", content: null, tool_calls: calls });
        for (const call of calls) {
          session.messages.push({ role: "tool", tool_call_id: call.id, content: runGroqTool(session.cwd, call.function.name, call.function.arguments) });
        }
        response = await requestModel(session.request.model?.trim() || requestedModel);
        if (!response.ok) throw new Error(`Groq API returned ${response.status}: ${await response.text()}`);
      }
      if (answer) {
        session.messages.push({ role: "assistant", content: answer });
        session.state.latestAssistantText = answer.slice(0, 160);
      }
      session.state.agentState = "waiting";
      session.state.currentEventType = "turn:completed";
      session.state.lastEventAt = new Date().toISOString();
      this.deps.sendSnapshot(id, session);
      return { ok: true };
    } catch (error) {
      if (session.controller.signal.aborted) {
        this.deps.logMain("groq:aborted", { id });
        return { ok: false, message: "Groq request stopped." };
      }
      const message = error instanceof Error ? error.message : "Groq request failed.";
      this.deps.logMain("groq:error", { id, message });
      session.state.agentState = "needs_action";
      session.state.currentEventType = "groq:error";
      session.state.lastEventAt = new Date().toISOString();
      this.deps.sendSnapshot(id, session);
      return { ok: false, message };
    }
  }

  stop(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.deps.logMain("groq:session-stop", { id });
    session.controller.abort();
    this.sessions.delete(id);
  }
}
