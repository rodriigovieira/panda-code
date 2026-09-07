# Browser performance diagnostics

After launching a build containing these collectors, Panda Code writes
`browser-perf.json` in Electron's user-data directory (on macOS, normally
`~/Library/Application Support/Panda Code`). It updates every five seconds,
retaining the last 60 intervals. Copy this file soon after a slowdown to preserve
it. The existing `perf-snapshot.json` remains the cumulative timing readout.

The rolling report includes:

- CPU, resident memory in KB, and wakeups for Electron processes, including GPU;
  join `processes.pid` to `contents.pid` to identify guest tab IDs and host windows.
  A process can serve multiple contents; its CPU must not be counted twice.
- Window visibility/focus/bounds, tab sleep/loading/recording state and selected
  tabs, guest host IDs, and background-throttling settings.
- Main event-loop utilization and delay mean/p99/max, and Node memory usage.
- IPC elapsed durations and outgoing send counts/times by channel and host role.
  Send time measures synchronous enqueue cost, not the receiver's processing time.
  IPC elapsed time includes asynchronous waits; it is not CPU time.
- Broadcast counts, total conversation items transmitted, and one sampled JSON
  byte size per channel per interval. JSON size is an approximation of Electron's
  structured-clone payload size. Multiplying by count estimates traffic; payloads
  may vary. Per-window send counts show the fan-out separately.
- Browser navigation/loading/title/unresponsive/crash event counts; renderer
  long tasks, report round trips, guest mount/unmount counts, and capture staging.
- Release-build browser render-to-layout elapsed durations (including children
  and scheduler delays), plus one-second frame-gap samples every five seconds
  while the host document is visible. These measure the host UI, not guest FPS.
  A hidden dock inside a visible host can still be sampled. Frame intervals depend
  on display refresh rate, so a 16ms sample alone is not proof of a dropped frame.

Renderer samples arrive in batches every ten seconds, so their containing main
interval is the delivery interval. Buffers are capped; `renderer:telemetry-dropped`
indicates overflow. Counters and slow samples are bounded per interval. The JSON
file is replaced atomically with asynchronous writes and overlapping writes are
skipped. `diagnostics:*` timings expose collection overhead; sample-and-write is
wall time including disk waits. `writeFailures` reports unsuccessful samples/writes.
Routine diagnostics contain identifiers and numeric summaries, not page URLs,
titles, message bodies, or IPC arguments.

## Capture a detailed trace during the slowdown

With the updated app running, request one capture:

```sh
touch "$HOME/Library/Application Support/Panda Code/browser-profile.request"
```

Within five seconds, the request is consumed and Chromium traces all its processes
for 15 seconds, with a 32 MB circular trace buffer. `browser-perf.json` reports
`trace.status` (`starting`, `recording`, `stopping`, `complete`, or `failed`).
The result is `browser-trace.json` beside it, replacing the previous capture.
Open that file in a Chromium/Perfetto trace viewer to inspect JavaScript sampling,
layout, paint, GPU and compositor work. Category availability and symbol detail
depend on the Chromium build. A severely stalled process can delay trace flushing.
Detailed traces can contain page/script URLs and event arguments; they remain
local and are not automatically uploaded. Run this separately from DevTools or
another Chromium tracing session, since Electron has one process-wide recorder.

For comparison, capture roughly 30 seconds with the panel closed, 30 with it
open, and 30 with the detached window open, keeping the same pages and workload.
Copy the rolling report, then request a trace in the slow configuration. These
measurements distinguish background page CPU, event/broadcast storms, host UI
work, main-process stalls, and compositor load; they do not by themselves establish
which code change will fix the slowdown.
