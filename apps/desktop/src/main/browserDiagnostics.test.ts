import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  write: vi.fn(), rename: vi.fn(), unlink: vi.fn(), start: vi.fn(), stop: vi.fn(),
  all: vi.fn(), metrics: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ writeFile: mock.write, rename: mock.rename, unlink: mock.unlink }));
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), { getPath: () => "/diagnostics", getAppMetrics: mock.metrics }),
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: mock.all, fromId: () => ({ getType: () => "webview" }) },
  contentTracing: { startRecording: mock.start, stopRecording: mock.stop },
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.write.mockResolvedValue(undefined);
  mock.rename.mockResolvedValue(undefined);
  mock.unlink.mockRejectedValue(new Error("ENOENT"));
  mock.start.mockResolvedValue(undefined);
  mock.stop.mockResolvedValue("/diagnostics/browser-trace.json");
  mock.all.mockReturnValue([]);
  mock.metrics.mockReturnValue([]);
});
afterEach(async () => {
  const { app } = await import("electron");
  app.emit("before-quit");
  app.removeAllListeners();
  vi.useRealTimers();
});
const latest = () => JSON.parse(mock.write.mock.calls.at(-1)![1]);

it("retains only 60 intervals and resets event counts between samples", async () => {
  const d = await import("./browserDiagnostics");
  d.startBrowserDiagnostics(() => ({ tabs: [] }));
  d.browserDiagnosticRecord("send:browser-window:browser:state", 30);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(latest().history[0].activity.operations[0]).toMatchObject({ count: 1, maxMs: 30 });
  await vi.advanceTimersByTimeAsync(305_000);
  expect(latest().history).toHaveLength(60);
  expect(latest().history.at(-1).activity.operations.some((o: { name: string }) => o.name.startsWith("send:"))).toBe(false);
});

it("maps guest processes to tab IDs without collecting page addresses or titles", async () => {
  const d = await import("./browserDiagnostics");
  const guest = Object.assign(new EventEmitter(), {
    id: 7, getType: () => "webview", isDestroyed: () => false, getOSProcessId: () => 123,
    getURL: () => "https://secret.example/private?token=secret", getTitle: () => "Private title",
    isLoading: () => false, getBackgroundThrottling: () => true,
  });
  mock.all.mockReturnValue([guest]);
  d.browserDiagnosticAttach("tab-1", 7);
  d.browserDiagnosticContents(guest as never);
  d.startBrowserDiagnostics(() => ({ tabs: [] }));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(latest().history[0].contents[0]).toMatchObject({ pid: 123, tabId: "tab-1", role: "guest" });
  expect(mock.write.mock.calls[0]![1]).not.toContain("secret");
  expect(mock.write.mock.calls[0]![1]).not.toContain("Private title");
  guest.emit("destroyed");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(latest().history.at(-1).contents[0].tabId).toBeUndefined();
});

it("does not queue concurrent writes and recovers after a failed write", async () => {
  const d = await import("./browserDiagnostics");
  let reject!: (error: Error) => void;
  mock.write.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
  d.startBrowserDiagnostics(() => ({}));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(mock.write).toHaveBeenCalledTimes(1);
  reject(new Error("disk busy"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(latest().writeFailures).toBe(1);
  expect(mock.rename).toHaveBeenCalledTimes(1);
});

it("traces only on request and stops after 15 seconds with bounded buffers", async () => {
  const d = await import("./browserDiagnostics");
  d.startBrowserDiagnostics(() => ({}));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mock.start).not.toHaveBeenCalled();
  mock.unlink.mockResolvedValueOnce(undefined);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mock.start).toHaveBeenCalledWith(expect.objectContaining({ trace_buffer_size_in_kb: 32_768 }));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mock.stop).toHaveBeenCalledWith("/diagnostics/browser-trace.json");
  expect(mock.start).toHaveBeenCalledTimes(1);
});

it("counts broadcast payload rates but serializes just one size sample per interval", async () => {
  const d = await import("./browserDiagnostics");
  const toJSON = vi.fn(() => ({ items: ["private message"] }));
  d.startBrowserDiagnostics(() => ({}));
  for (let i = 0; i < 500; i++) d.browserDiagnosticPayload("session:conversation", { items: [1, 2], toJSON });
  expect(toJSON).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(latest().history[0].payloads["session:conversation"]).toMatchObject({ count: 500, items: 1000 });
  expect(mock.write.mock.calls[0]![1]).not.toContain("private message");
  d.browserDiagnosticPayload("session:conversation", { toJSON });
  expect(toJSON).toHaveBeenCalledTimes(2);
});
