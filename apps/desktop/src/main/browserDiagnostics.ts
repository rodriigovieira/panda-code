import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { EventEmitter } from "node:events";
import { writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, contentTracing, webContents, type WebContents } from "electron";
import { PerfRecorder } from "../shared/perf";

/** Five minutes of interval evidence; no URLs, titles, page contents or IPC arguments. */
const INTERVAL_MS = 5_000;
const HISTORY_SIZE = 60;
const intervalPerf = new PerfRecorder(() => performance.now());
const guests = new Map<number, string>();
let history: unknown[] = [];
const payloads = new Map<string, { count: number; items: number; sampledJsonBytes?: number }>();
const roles = new WeakMap<WebContents, string>();

/** One JSON size sample per channel per interval, before fan-out, never retain content. */
export function browserDiagnosticPayload(channel: string, payload: unknown): void {
  let stats = payloads.get(channel);
  if (!stats) {
    if (payloads.size >= 100) return;
    stats = { count: 0, items: 0 };
    payloads.set(channel, stats);
    const started = performance.now();
    try { stats.sampledJsonBytes = Buffer.byteLength(JSON.stringify(payload) ?? ""); } catch { /* cyclic payload */ }
    browserDiagnosticRecord("diagnostics:payload-size-sample", performance.now() - started);
  }
  stats.count += 1;
  if (payload && typeof payload === "object" && "items" in payload && Array.isArray(payload.items)) {
    stats.items += payload.items.length;
  }
}
let writing = false;
let writeFailures = 0;
let started = false;
let trace: { status: string; requestedAt?: string; path?: string; error?: string } = { status: "idle" };
let traceBusy = false;

/** A local one-shot request, consumed before recording; never trace continuously. */
async function checkTraceRequest(): Promise<void> {
  if (traceBusy) return;
  const directory = app.getPath("userData");
  try { await unlink(join(directory, "browser-profile.request")); } catch { return; }
  traceBusy = true;
  trace = { status: "starting", requestedAt: new Date().toISOString() };
  // Arm before awaiting child-process acknowledgements, which can themselves stall.
  const stopTimer = setTimeout(() => {
    trace.status = "stopping";
    void contentTracing.stopRecording(join(directory, "browser-trace.json")).then((path) => {
      trace = { ...trace, status: "complete", path };
    }, (error: unknown) => {
      trace = { ...trace, status: "failed", error: String(error) };
    }).finally(() => { traceBusy = false; });
  }, 15_000);
  stopTimer.unref();
  try {
    await contentTracing.startRecording({
      recording_mode: "record-continuously", trace_buffer_size_in_kb: 32_768,
      included_categories: ["toplevel", "blink", "cc", "gpu", "v8", "electron", "devtools.timeline",
        "disabled-by-default-devtools.timeline", "disabled-by-default-v8.cpu_profiler"],
    });
    if (trace.status === "starting") trace.status = "recording";
  } catch (error) {
    clearTimeout(stopTimer);
    trace = { ...trace, status: "failed", error: String(error) };
    traceBusy = false;
  }
}

export function browserDiagnosticRecord(name: string, ms = 0, detail?: number): void {
  intervalPerf.record(name, ms, detail);
}

export function browserDiagnosticAttach(tabId: string, id: number): void {
  if (webContents.fromId(id)?.getType() === "webview") guests.set(id, tabId);
}

export function browserDiagnosticContents(contents: WebContents): void {
  // Only fixed event names: no URLs or per-page strings in counter keys.
  for (const event of ["dom-ready", "did-start-loading", "did-stop-loading", "did-navigate",
    "did-navigate-in-page", "page-title-updated", "unresponsive", "responsive", "render-process-gone"] as const) {
    (contents as EventEmitter).on(event, () => browserDiagnosticRecord(`event:${contents.getType()}:${event}`));
  }
  contents.on("did-finish-load", () => roles.delete(contents));
  const id = contents.id;
  contents.once("destroyed", () => guests.delete(id));
}

export function diagnosticRole(contents: WebContents): string {
  const cached = roles.get(contents);
  if (cached) return cached;
  let role = "other";
  try {
    role = contents.getType() === "webview" ? "guest" :
      new URL(contents.getURL()).searchParams.get("view") === "browser" ? "browser-window" : "main-window";
    roles.set(contents, role);
  } catch { /* contents may be closing */ }
  return role;
}

export function startBrowserDiagnostics(browserState: () => unknown): void {
  if (started) return;
  started = true;
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let previousUtilization = performance.eventLoopUtilization();
  let previousAt = performance.now();
  const sample = async (): Promise<void> => {
    // Never queue writes on a busy disk. The next interval includes skipped time.
    if (writing) return;
    writing = true;
    void checkTraceRequest();
    const begin = performance.now();
    try {
      const elapsedMs = begin - previousAt;
      previousAt = begin;
      const utilization = performance.eventLoopUtilization();
      const loop = performance.eventLoopUtilization(utilization, previousUtilization);
      previousUtilization = utilization;
      const contents = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed()).map((wc) => ({
        id: wc.id, pid: wc.getOSProcessId(), type: wc.getType(), role: diagnosticRole(wc),
        tabId: guests.get(wc.id), hostId: wc.hostWebContents?.id,
        loading: wc.isLoading(), backgroundThrottling: wc.getBackgroundThrottling(),
      }));
      const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => ({
        id: w.id, contentsId: w.webContents.id, visible: w.isVisible(), focused: w.isFocused(),
        minimized: w.isMinimized(), bounds: w.getBounds(),
      }));
      const entry = {
        at: new Date().toISOString(), elapsedMs,
        mainLoop: { utilization: loop.utilization, activeMs: loop.active, idleMs: loop.idle,
          delayMeanMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : 0,
          delayP99Ms: delay.percentile(99) / 1e6, delayMaxMs: delay.max / 1e6 },
        processes: app.getAppMetrics().map((p) => ({ pid: p.pid, createdAt: p.creationTime,
          type: p.type, name: p.name, cpuPercent: p.cpu.percentCPUUsage,
          idleWakeupsPerSecond: p.cpu.idleWakeupsPerSecond, workingSetKB: p.memory.workingSetSize })),
        contents, windows, browser: browserState(), activity: intervalPerf.snapshot(),
        payloads: Object.fromEntries(payloads),
        mainMemoryBytes: process.memoryUsage(),
      };
      delay.reset();
      intervalPerf.reset();
      payloads.clear();
      history.push(entry);
      if (history.length > HISTORY_SIZE) history.shift();
      const path = join(app.getPath("userData"), "browser-perf.json");
      await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, pid: process.pid,
        intervalMs: INTERVAL_MS, writeFailures, trace, history }, null, 2));
      await rename(`${path}.tmp`, path);
    } catch {
      writeFailures += 1;
    } finally {
      browserDiagnosticRecord("diagnostics:sample-and-write", performance.now() - begin);
      writing = false;
    }
  };
  const timer = setInterval(() => void sample(), INTERVAL_MS);
  timer.unref();
  app.once("before-quit", () => { clearInterval(timer); delay.disable(); });
}
