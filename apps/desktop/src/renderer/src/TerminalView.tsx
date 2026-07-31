import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { DesktopApi } from "../../shared/ipc";
import { editingSequenceForKey } from "./terminal-keys";

const TERMINAL_THEME = {
  background: "#0b0f14",
  foreground: "#dbe1ea",
  cursor: "#d0a85d",
  cursorAccent: "#0b0f14",
  selectionBackground: "rgba(122, 183, 255, 0.32)",
  // "Bright black" (SGR 90) is what zsh-autosuggestions paints its inline ghost
  // suggestion in. xterm's default (#666666) sits too close to the foreground,
  // so a suggested word reads like real input — which makes an edit look like a
  // no-op (you delete a char, the plugin re-suggests it, the word looks
  // unchanged). Pin it to a clearly-recessed gray so ghost text is obvious.
  brightBlack: "#3c4657",
};

// One xterm instance bound to one main-process pty. The pty outlives this
// component (main owns it), so unmounting on section switches is fine: on
// remount, startTerminal re-attaches and replays the scrollback buffer.
export function TerminalView({
  terminalId,
  cwd,
  visible,
  desktopApi,
}: {
  terminalId: string;
  cwd: string;
  visible: boolean;
  desktopApi: DesktopApi;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const terminal = new Terminal({
      fontFamily: '"SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      cursorBlink: true,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;

    let disposed = false;
    // Subscribe before starting so a fresh shell's first output is never missed.
    const removeData = desktopApi.onTerminalData(({ id, data }) => {
      if (id === terminalId) {
        terminal.write(data);
      }
    });
    const inputDisposable = terminal.onData((data) => {
      void desktopApi.terminalInput({ id: terminalId, data });
    });

    // xterm.js ships no word/line editing bindings, so Option/Ctrl+Arrow,
    // Option/Ctrl+Backspace and Cmd+Backspace all did nothing in the shell. Map
    // those keys to the bytes zsh's line editor understands and write them
    // straight to the pty. Returning false stops xterm from also processing the
    // key (which would otherwise just edit its invisible helper textarea).
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      const sequence = editingSequenceForKey(event);
      if (sequence === null) {
        return true;
      }
      void desktopApi.terminalInput({ id: terminalId, data: sequence });
      return false;
    });

    void desktopApi
      .startTerminal({ id: terminalId, cwd, cols: terminal.cols, rows: terminal.rows })
      .then((result) => {
        if (disposed) {
          return;
        }

        if (!result.ok) {
          terminal.writeln(result.message ?? "Could not start the shell.");
          return;
        }

        if (result.buffer) {
          terminal.write(result.buffer);
        }
      });

    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed || element.clientWidth === 0 || element.clientHeight === 0) {
          return;
        }

        fit.fit();
        void desktopApi.resizeTerminal({ id: terminalId, cols: terminal.cols, rows: terminal.rows });
      });
    });
    resizeObserver.observe(element);

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      removeData();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, cwd, desktopApi]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) {
      return;
    }

    fit.fit();
    void desktopApi.resizeTerminal({ id: terminalId, cols: terminal.cols, rows: terminal.rows });
    terminal.focus();
  }, [desktopApi, terminalId, visible]);

  return <div className={`terminal-view ${visible ? "" : "hidden"}`} ref={containerRef} />;
}
