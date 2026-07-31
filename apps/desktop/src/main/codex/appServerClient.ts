// A persistent JSON-RPC client for `codex app-server`.
//
// The app-server speaks newline-delimited JSON over stdio and multiplexes three
// message kinds on the one socket:
//   - {id, method, params} → a server→client REQUEST we must answer (approvals)
//   - {id, result|error}   → a RESPONSE to one of our requests
//   - {method, params}     → a NOTIFICATION (fire-and-forget event stream)
//
// This module owns framing + correlation + lifecycle only. It is deliberately
// ignorant of the session/turn semantics layered on top (see the migration doc
// at docs/codex-app-server-migration.md), so it can back both the rate-limit
// read and, later, live Codex sessions.

/** Structural subset of a spawned child process this client actually uses. */
export interface AppServerProcess {
  stdin: { write(data: string): void };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): void;
  kill(): void;
  readonly killed: boolean;
}

export type JsonRpcId = number | string;

export type AppServerNotification = { method: string; params: unknown };
export type AppServerServerRequest = { id: JsonRpcId; method: string; params: unknown };

export type CodexAppServerClientOptions = {
  /** Spawns a fresh `codex app-server` process. Called once per start(). */
  spawn: () => AppServerProcess;
  /** Identifies this client in the initialize handshake. */
  clientInfo: { name: string; title: string; version: string };
  /** Capabilities sent in initialize. Defaults to `{ experimentalApi: true }`. */
  capabilities?: Record<string, unknown>;
  logMain?: (event: string, details?: Record<string, unknown>) => void;
  /** Server→client notifications (the event stream). */
  onNotification?: (note: AppServerNotification) => void;
  /** Server→client requests (approvals). Answer with respond()/respondError(). */
  onServerRequest?: (request: AppServerServerRequest) => void;
  /** Fired once when the underlying process exits. */
  onExit?: (code: number | null) => void;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export class CodexAppServerError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
    this.data = data;
  }
}

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private child: AppServerProcess | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private startPromise: Promise<unknown> | null = null;
  private disposed = false;
  private exitCode: number | null = null;
  private exited = false;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
  }

  /**
   * Spawn the process and complete the `initialize` → `initialized` handshake.
   * Idempotent: repeated calls return the same in-flight/settled handshake.
   */
  start(): Promise<unknown> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.disposed) {
      return Promise.reject(new CodexAppServerError("Client has been disposed."));
    }

    const child = this.options.spawn();
    this.child = child;

    child.stdout.on("data", (chunk) => this.ingest(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2_000);
    });
    child.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      // code === null means the process was terminated by a signal; capturing
      // it is the only way to tell a crash (SIGSEGV/SIGABRT) from an OS kill
      // (SIGKILL/SIGTERM) when stderr is empty.
      this.log("app-server:exit", { code, signal: signal ?? undefined, tail: this.stderrTail.trim().slice(-400) || undefined });
      this.fail(new CodexAppServerError(this.exitMessage(code, signal)));
      this.options.onExit?.(code);
    });

    this.startPromise = (async () => {
      const result = await this.request("initialize", {
        clientInfo: this.options.clientInfo,
        capabilities: this.options.capabilities ?? { experimentalApi: true },
      });
      this.notify("initialized", {});
      return result;
    })();

    return this.startPromise;
  }

  /** Send a JSON-RPC request and await its response. */
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
    if (this.disposed || this.exited) {
      return Promise.reject(new CodexAppServerError(this.exited ? this.exitMessage(this.exitCode) : "Client has been disposed."));
    }
    const child = this.child;
    if (!child) {
      return Promise.reject(new CodexAppServerError("Client has not been started."));
    }

    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = { method, resolve, reject };
      if (options?.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            const detail = this.stderrTail.trim().slice(-400);
            reject(new CodexAppServerError(`Timed out waiting for ${method}${detail ? `: ${detail}` : ""}`));
          }
        }, options.timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(error instanceof Error ? error : new CodexAppServerError(String(error)));
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child || this.disposed || this.exited) {
      return;
    }
    const message = params === undefined ? { method } : { method, params };
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.log("app-server:notify-failed", { method, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Answer a server→client request with a successful result. */
  respond(id: JsonRpcId, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  /** Answer a server→client request with an error. */
  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    const error = data === undefined ? { code, message } : { code, message, data };
    this.child?.stdin.write(`${JSON.stringify({ id, error })}\n`);
  }

  /** Kill the process and reject anything still in flight. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.fail(new CodexAppServerError("Client has been disposed."));
    const child = this.child;
    if (child && !child.killed) {
      child.kill();
    }
  }

  private ingest(chunk: Buffer | string): void {
    this.stdoutBuffer += chunk.toString();
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.log("app-server:parse-error", { line: trimmed.slice(0, 200) });
      return;
    }

    const hasId = message.id !== undefined && message.id !== null;
    const method = typeof message.method === "string" ? message.method : undefined;

    // {id, method} → server→client request (must be answered by the client).
    if (hasId && method) {
      this.options.onServerRequest?.({ id: message.id as JsonRpcId, method, params: message.params });
      return;
    }

    // {id, result|error} → response to one of our requests.
    if (hasId) {
      this.resolveResponse(message);
      return;
    }

    // {method, params} → notification.
    if (method) {
      this.options.onNotification?.({ method, params: message.params });
    }
  }

  private resolveResponse(message: Record<string, unknown>): void {
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    const error = message.error;
    if (error && typeof error === "object") {
      const err = error as { code?: unknown; message?: unknown; data?: unknown };
      entry.reject(
        new CodexAppServerError(
          typeof err.message === "string" ? err.message : `${entry.method} failed: ${JSON.stringify(error)}`,
          typeof err.code === "number" ? err.code : undefined,
          err.data,
        ),
      );
      return;
    }
    entry.resolve(message.result);
  }

  /** Reject every in-flight request with `error` and clear the queue. */
  private fail(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(error);
    }
    this.pending.clear();
  }

  private exitMessage(code: number | null, signal?: NodeJS.Signals | null): string {
    const detail = this.stderrTail.trim().slice(-400);
    const how = code === null ? (signal ? ` (signal ${signal})` : "") : ` (code ${code})`;
    return `codex app-server exited${how}${detail ? `: ${detail}` : ""}`;
  }

  private log(event: string, details?: Record<string, unknown>): void {
    this.options.logMain?.(event, details);
  }
}
