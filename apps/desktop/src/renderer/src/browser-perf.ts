import { useEffect, useLayoutEffect } from "react";
import { recordRendererPerf } from "./perf-client";

/** Works in release React builds, where React.Profiler callbacks are disabled. */
export function useBrowserRenderPerf(presentation: string, tabCount: number): void {
  const started = performance.now();
  useLayoutEffect(() => {
    // Elapsed render-to-layout time includes scheduling/child work, not pure React CPU time.
    recordRendererPerf(`renderer:browser:${presentation}:render-to-layout`, performance.now() - started, tabCount);
  });
}

/** Sample one second of host frames every five seconds, only while visible. */
export function useBrowserFramePerf(presentation: string): void {
  useEffect(() => {
    let frame = 0;
    let previous = 0;
    let until = 0;
    const tick = (now: number): void => {
      if (document.hidden) { frame = 0; return; }
      if (previous) recordRendererPerf(`renderer:browser:${presentation}:frame-gap`, now - previous);
      previous = now;
      if (now < until) frame = requestAnimationFrame(tick);
      else frame = 0;
    };
    const sample = (): void => {
      if (document.hidden || frame) return;
      previous = 0;
      until = performance.now() + 1_000;
      frame = requestAnimationFrame(tick);
    };
    const visibility = (): void => {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
    };
    document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(sample, 5_000);
    return () => {
      window.clearInterval(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [presentation]);
}
