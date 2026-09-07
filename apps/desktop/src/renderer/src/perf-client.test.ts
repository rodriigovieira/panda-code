import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("delivers the bounded buffer in accepted IPC batches, reports overflow, and tears down", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("window", { setInterval, clearInterval });
  vi.stubGlobal("PerformanceObserver", undefined);
  const { recordRendererPerf, startRendererPerf } = await import("./perf-client");
  const reportPerf = vi.fn().mockResolvedValue(undefined);
  const stop = startRendererPerf({ reportPerf });
  for (let i = 0; i < 600; i++) recordRendererPerf("renderer:browser:frame-gap", 20);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reportPerf.mock.calls.map(([batch]) => batch.length)).toEqual([200, 200, 101]);
  expect(reportPerf.mock.calls.flatMap(([batch]) => batch).at(-1)).toMatchObject({
    name: "renderer:telemetry-dropped", detail: 100,
  });
  recordRendererPerf("renderer:browser:guest-unmount", 0);
  stop();
  expect(reportPerf).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(reportPerf).toHaveBeenCalledTimes(4);
});
