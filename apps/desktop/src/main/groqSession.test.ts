import { describe, expect, it, vi } from "vitest";
import { GroqSessionManager } from "./groqSession";

function request() {
  return {
    id: "groq-1",
    cwd: "/tmp",
    command: "groq",
    runtime: "groq" as const,
    executionMode: "stream-json" as const,
    cols: 80,
    rows: 24,
  };
}

describe("GroqSessionManager", () => {
  it("refuses prompts until an API key is configured", async () => {
    const manager = new GroqSessionManager({
      getApiKey: () => null,
      sendSnapshot: vi.fn(),
      logMain: vi.fn(),
    });
    manager.start(request());

    await expect(manager.sendInput("groq-1", "hello")).resolves.toEqual({
      ok: false,
      message: "Configure a Groq API key in Settings first.",
    });
  });

  it("folds streamed SSE deltas into the normal session state", async () => {
    const snapshots: Array<{ state: { latestAssistantText?: string; agentState: string } }> = [];
    const manager = new GroqSessionManager({
      getApiKey: () => "gsk_test",
      sendSnapshot: (_id, session) => snapshots.push(session),
      logMain: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "data: {\"model\":\"llama-3.3-70b-versatile\",\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n" +
        "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n" +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    manager.start(request());

    await expect(manager.sendInput("groq-1", "hello")).resolves.toEqual({ ok: true });
    expect(snapshots.at(-1)?.state.latestAssistantText).toBe("Hello world");
    expect(snapshots.at(-1)?.state.agentState).toBe("waiting");
    vi.unstubAllGlobals();
  });

  it("returns a read-only tool result to Groq before emitting the final text", async () => {
    const snapshots: Array<{ state: { latestAssistantText?: string } }> = [];
    const requests: Array<{ messages: Array<{ role: string; content?: string | null }> }> = [];
    const manager = new GroqSessionManager({
      getApiKey: () => "gsk_test",
      sendSnapshot: (_id, session) => snapshots.push(session),
      logMain: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content?: string | null }> };
      requests.push(body);
      if (requests.length === 1) {
        return new Response(
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"list_files\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n" +
          "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Found it.\"}}]}\n\n" +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));
    manager.start(request());

    await expect(manager.sendInput("groq-1", "inspect the workspace")).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    const followup = requests[1]!;
    expect(followup.messages.at(-2)).toMatchObject({ role: "assistant", content: null });
    expect(followup.messages.at(-1)).toMatchObject({ role: "tool" });
    expect(followup.messages.at(-1)?.content).toBeTruthy();
    expect(snapshots.at(-1)?.state.latestAssistantText).toBe("Found it.");
    vi.unstubAllGlobals();
  });

  it("recovers a stale persisted model with the fallback model", async () => {
    const models: string[] = [];
    const manager = new GroqSessionManager({
      getApiKey: () => "gsk_test",
      sendSnapshot: vi.fn(),
      updateRequest: (_id, next) => models.push(next.model ?? ""),
      logMain: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      models.push(body.model);
      if (body.model === "llama-3.3-70b-versatile") {
        return new Response('{"error":{"code":"model_not_found"}}', { status: 404 });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", { status: 200 });
    }));
    manager.start({ ...request(), model: "llama-3.3-70b-versatile" });

    await expect(manager.sendInput("groq-1", "hello")).resolves.toEqual({ ok: true });
    expect(models).toEqual(["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
    vi.unstubAllGlobals();
  });
});
