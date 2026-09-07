import { useEffect, useState } from "react";
import { startRendererPerf } from "./perf-client";
import { BrowserPanel } from "./BrowserPanel";
import type { DesktopApi } from "../../shared/ipc";

/**
 * The detached browser window.
 *
 * The same renderer bundle, entered with `?view=browser`, rendering the browser
 * panel and nothing else. Two things make it worth being its own window rather
 * than a mode of the dock:
 *
 *  - it can be moved to a second screen and kept beside the conversation, and
 *  - it shows EVERY section's tabs at once, grouped by section, which no
 *    section-scoped view can. That is also where you find out which thread a
 *    page belongs to, and click through to it.
 *
 * While it is open it HOSTS the pages — a guest can only live in one window, so
 * the docked panel shows a placeholder until this closes.
 */

/**
 * The preload bridge, under the name it is actually exposed as.
 *
 * `contextBridge.exposeInMainWorld("claudeSections", api)` — not `desktopApi`,
 * which is what this file guessed at first. The window came up permanently
 * blank because the guess never resolved and this sat on its fallback.
 */
declare global {
  interface Window {
    claudeSections?: DesktopApi;
  }
}

export function BrowserWindowApp(): React.ReactElement {
  const [api, setApi] = useState<DesktopApi | undefined>(window.claudeSections);

  // The preload bridge is normally there before React runs; this covers the
  // window opening fast enough that it is not.
  useEffect(() => {
    if (api) return;
    const timer = window.setInterval(() => {
      if (window.claudeSections) {
        setApi(window.claudeSections);
        window.clearInterval(timer);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [api]);

  useEffect(() => api ? startRendererPerf(api) : undefined, [api]);

  if (!api) {
    // Visible rather than blank: a window that shows nothing at all gives no
    // clue whether it is starting up or broken.
    return (
      <div className="browser-window-shell">
        <div className="browser-panel">
          <div className="browser-empty">
            <strong>Connecting to Panda Code…</strong>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="browser-window-shell">
      <BrowserPanel desktopApi={api} presentation="window" />
    </div>
  );
}
