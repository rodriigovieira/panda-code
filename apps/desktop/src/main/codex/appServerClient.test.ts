import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  CodexAppServerError,
  type AppServerProcess,
  type CodexAppServerClientOptions,
} from "./appServerClient";

/** A fake `codex app-server`: records what the client writes, lets tests push lines back. */
class FakeProcess extends EventEmitter implements AppServerProcess {
  readonly writes: string[] = [];
  killed = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: (data: string) => {
      this.writes.push(data);
    },
  };

  kill(): void {
    this.killed = true;
    this.emit("exit", null);
  }

  /** The JSON-RPC messages the client has sent, parsed. */
  sent(): Array<Record<string, unknown>> {
    return this.writes.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  /** Simulate the server writing a line (may be chunked arbitrarily). */
  push(message: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
  }
}

function makeClient(overrides: Partial<CodexAppServerClientOptions> = {}) {
  const proc = new FakeProcess();
  const client = new CodexAppServerClient({
    spawn: () => proc,
    clientInfo: { name: "panda_code", title: "Panda Code", version: "9.9.9" },
    ...overrides,
  });
  return { proc, client };
}

describe("CodexAppServerClient", () => {
  it("completes the initialize/initialized handshake", async () => {
    const { proc, client } = makeClient();
    const started = client.start();

    const init = proc.sent()[0]!;
    expect(init.method).toBe("initialize");
    expect(init.id).toBeDefined();
    expect((init.params as Record<string, unknown>).clientInfo).toMatchObject({ name: "panda_code" });

    proc.push({ id: init.id, result: { userAgent: "codex/test" } });
    await expect(started).resolves.toMatchObject({ userAgent: "codex/test" });

    const initialized = proc.sent().find((m) => m.method === "initialized");
    expect(initialized).toBeDefined();
    expect(initialized).not.toHaveProperty("id");
  });

  it("is idempotent across repeated start() calls", async () => {
    const spawn = vi.fn(() => new FakeProcess());
    const client = new CodexAppServerClient({ spawn, clientInfo: { name: "p", title: "P", version: "1" } });
    void client.start();
    void client.start();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("correlates responses to the right request", async () => {
    const { proc, client } = makeClient();
    void client.start();
    proc.push({ id: 1, result: {} }); // settle initialize

    const a = client.request("account/rateLimits/read");
    const b = client.request("model/list");
    const [idA, idB] = proc.sent().filter((m) => m.method !== "initialized" && m.method !== "initialize").map((m) => m.id);

    // Answer out of order — each promise must still get its own result.
    proc.push({ id: idB, result: { models: ["gpt-5"] } });
    proc.push({ id: idA, result: { primary: { used_percent: 12 } } });

    await expect(a).resolves.toMatchObject({ primary: { used_percent: 12 } });
    await expect(b).resolves.toMatchObject({ models: ["gpt-5"] });
  });

  it("rejects a request when the server returns an error", async () => {
    const { proc, client } = makeClient();
    void client.start();
    proc.push({ id: 1, result: {} });

    const pending = client.request("thread/start", { cwd: "/nope" });
    const id = proc.sent().find((m) => m.method === "thread/start")?.id;
    proc.push({ id, error: { code: -32602, message: "bad cwd" } });

    await expect(pending).rejects.toBeInstanceOf(CodexAppServerError);
    await expect(pending).rejects.toMatchObject({ message: "bad cwd", code: -32602 });
  });

  it("routes notifications to onNotification", async () => {
    const onNotification = vi.fn();
    const { proc, client } = makeClient({ onNotification });
    void client.start();
    proc.push({ id: 1, result: {} });

    proc.push({ method: "item/agentMessage/delta", params: { delta: "hello" } });
    expect(onNotification).toHaveBeenCalledWith({ method: "item/agentMessage/delta", params: { delta: "hello" } });
  });

  it("routes server→client requests and can answer them", async () => {
    const onServerRequest = vi.fn();
    const { proc, client } = makeClient({ onServerRequest });
    void client.start();
    proc.push({ id: 1, result: {} });

    proc.push({ id: 7, method: "item/commandExecution/requestApproval", params: { command: "rm -rf" } });
    expect(onServerRequest).toHaveBeenCalledWith({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "rm -rf" },
    });

    client.respond(7, { decision: "approved" });
    const answer = proc.sent().find((m) => m.id === 7 && "result" in m);
    expect(answer).toMatchObject({ id: 7, result: { decision: "approved" } });
  });

  it("reassembles messages split across chunks", async () => {
    const onNotification = vi.fn();
    const { proc, client } = makeClient({ onNotification });
    void client.start();
    proc.push({ id: 1, result: {} });

    proc.stdout.emit("data", Buffer.from('{"method":"error","par'));
    proc.stdout.emit("data", Buffer.from('ams":{"message":"boom"}}\n'));
    expect(onNotification).toHaveBeenCalledWith({ method: "error", params: { message: "boom" } });
  });

  it("rejects in-flight requests when the process exits", async () => {
    const { proc, client } = makeClient();
    void client.start();
    proc.push({ id: 1, result: {} });

    const pending = client.request("turn/start", {});
    proc.stderr.emit("data", Buffer.from("fatal: no auth"));
    proc.emit("exit", 1);

    await expect(pending).rejects.toMatchObject({ name: "CodexAppServerError" });
    await expect(pending).rejects.toThrow(/exited \(code 1\).*no auth/);
  });

  it("honors a per-request timeout", async () => {
    vi.useFakeTimers();
    try {
      const { proc, client } = makeClient();
      void client.start();
      proc.push({ id: 1, result: {} });

      const pending = client.request("account/rateLimits/read", undefined, { timeoutMs: 1_000 });
      const rejection = expect(pending).rejects.toThrow(/Timed out waiting for account\/rateLimits\/read/);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects requests made after dispose()", async () => {
    const { proc, client } = makeClient();
    void client.start();
    proc.push({ id: 1, result: {} });

    client.dispose();
    expect(proc.killed).toBe(true);
    await expect(client.request("model/list")).rejects.toBeInstanceOf(CodexAppServerError);
  });
});
