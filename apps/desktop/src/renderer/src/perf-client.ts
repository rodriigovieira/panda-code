import type { PerfSample } from "../../shared/perf";

/**
 * Renderer-side perf collection.
 *
 * Main cannot see the renderer's own work — a synchronous `JSON.stringify` or a
 * long React commit never crosses the IPC boundary — yet that is exactly where
 * "typing feels slow" comes from. This buffers samples locally and ships them to
 * main on an interval so the two processes share one view.
 *
 * Batched deliberately: reporting each sample over IPC would add an IPC hop per
 * slow frame, which is the failure mode where the telemetry becomes the problem.
 */

const FLUSH_INTERVAL_MS = 10_000;
/** Beyond this the buffer drops oldest: a stall must not become a memory leak. */
const MAX_BUFFERED = 500;
/** A task holding the main thread longer than this is a dropped frame or worse. */
const LONG_TASK_MS = 50;

let buffer: PerfSample[] = [];
let dropped = 0;

export function recordRendererPerf(name: string, ms: number, detail?: number): void {
  if (buffer.length >= MAX_BUFFERED) { dropped += 1; return; }
  buffer.push({ name, ms, at: Date.now(), ...(detail === undefined ? {} : { detail }) });
}

type PerfReporter = { reportPerf: (samples: PerfSample[]) => Promise<void> };

/**
 * Starts long-task observation and periodic delivery. Returns a teardown that
 * flushes what is buffered, so a reload does not discard the evidence from the
 * session that was slow.
 */
export function startRendererPerf(api: PerfReporter): () => void {
  let observer: PerformanceObserver | undefined;

  // `longtask` is the browser's own measure of main-thread blocking: any task
  // over 50ms. It is the closest thing to a direct reading of "the UI froze",
  // and it attributes nothing itself — pairing it with our named measurements
  // is what turns "something blocked" into "this blocked".
  if (typeof PerformanceObserver !== "undefined") {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_MS) recordRendererPerf("renderer:long-task", entry.duration);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Not every Chromium build exposes longtask; the named measurements below
      // still work, so this is a degradation rather than a failure.
      observer = undefined;
    }
  }

  const flush = (): void => {
    if (dropped) {
      buffer.push({ name: "renderer:telemetry-dropped", ms: 0, at: Date.now(), detail: dropped });
      dropped = 0;
    }
    if (buffer.length === 0) return;
    const pending = buffer;
    buffer = [];
    // Fire and forget: a failed report must never surface as an unhandled
    // rejection in a window whose only problem is that it is busy.
    // Main accepts at most 200 samples per call; deliver the whole bounded buffer.
    for (let offset = 0; offset < pending.length; offset += 200) {
      void api.reportPerf(pending.slice(offset, offset + 200)).catch(() => undefined);
    }
  };

  const timer = window.setInterval(flush, FLUSH_INTERVAL_MS);

  return () => {
    window.clearInterval(timer);
    observer?.disconnect();
    flush();
  };
}
