# Codex app-server migration

Status doc for moving Panda Code's Codex runtime from the one-shot
`codex exec --json` model onto the persistent `codex app-server` JSON-RPC
protocol. Started 2026-07-16; **completed 2026-07-30** — every Codex session
runs on app-server and the exec path has been deleted. Kept as the record of
what the transport does and why.

## Why

Today Codex sessions run as a one-shot child per turn (`buildStreamCodexCommand`
in `apps/desktop/src/main/index.ts` → `codex exec --json`, resumed via
`codex exec resume <threadId>`). JSONL is parsed in `src/shared/stream-json.ts`
(`applyCodexItem` / `applyCodexError`); "idle" is inferred from process exit.
Approvals are hard-disabled (`--ask-for-approval never`).

`codex app-server` is a persistent JSON-RPC (newline-delimited JSON over stdio)
server that already backs one feature here: rate-limit reads
(`readCodexRateLimitsViaAppServer`). Moving sessions onto it gives us:

- a long-lived process instead of respawn-per-turn,
- real streaming deltas (`item/agentMessage/delta`),
- `turn/interrupt` / `turn/steer` instead of stdin tricks,
- **interactive approvals** (`item/*/requestApproval` server→client requests),
  which the exec path cannot do — this is what unblocks the `needs_action`
  remote-approval flow reserved in `docs/protocol.md`.

## Target protocol (codex-cli 0.142.3)

Regenerate the bindings anytime with:
`codex app-server generate-ts -o <dir>` (or `generate-json-schema`).

Session lifecycle:
- `thread/start` (`ThreadStartParams`) / `thread/resume` (`ThreadResumeParams`)
  → `Thread`
- `turn/start` (`TurnStartParams { threadId, input: UserInput[], ... }`)
- stream: `ServerNotification` (`item/started`, `item/agentMessage/delta`,
  `item/completed`, `turn/started`, `turn/completed`,
  `thread/tokenUsage/updated`, `error`, …)
- control: `turn/interrupt`, `turn/steer`
- approvals: server→client `ServerRequest`
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`),
  answered with a `ReviewDecision`.

JSON-RPC routing rule (one socket carries all three):
- `{id, method, params}` → server→client **request** (must be answered)
- `{id, result|error}`   → **response** to one of our requests
- `{method, params}`     → **notification** (fire-and-forget)

## Phases

1. **Transport foundation** — reusable persistent `CodexAppServerClient`
   (framing, request/notify/respond, server-request routing, lifecycle).
   Prove it by routing the rate-limit read through it. No session changes.
   → `src/main/codex/appServerClient.ts`
2. **Runtime plumbing** — `executionMode`/runtime path for app-server alongside
   exec, behind a flag. `thread/start` + `turn/start` in `startStreamSession`.
3. **Event mapping** — `ServerNotification` → existing `StreamJsonState` /
   `ConversationItem` so renderer + relay are untouched.
4. **Approvals** — `ServerRequest` → `needs_action` runtime state + relay event.
5. **Cutover + cleanup** — default Codex to app-server, retire exec builders.

## Progress

- [x] Phase 0: research current + target, write this plan.
- [x] Phase 1: `CodexAppServerClient` (`src/main/codex/appServerClient.ts`) +
      unit tests (`appServerClient.test.ts`, 10 cases). Rate-limit reader
      (`readCodexRateLimitsViaAppServer` in `index.ts`) now runs on it; ~135
      lines of duplicate inline JSON-RPC framing deleted. Typecheck + suite green.
- [x] Phase 2: session runtime on the client.
      - `applyAppServerNotification` in `src/shared/stream-json.ts` maps
        `ServerNotification`s → `StreamJsonState` (agentMessage + deltas,
        reasoning, commandExecution, fileChange, mcpToolCall, webSearch,
        userMessage, plan, error; token usage; turn summary). Tests in
        `stream-json.appserver.test.ts` (11 cases).
      - `CodexAppServerSessionManager` in `src/main/codex/appServerSession.ts`:
        ONE shared client, per-section thread, `thread/start`|`thread/resume`
        → `turn/start`; interrupt on stop; disposes client when idle. Tests in
        `appServerSession.test.ts` (6 cases).
      - Chose one shared client (threads multiplex) over one-per-session.
        app-server sessions live in their own map, NOT `ManagedStreamSession`
        (which assumes a per-session child). `sendStreamSnapshot` widened to
        `{ state }` so both reuse the same snapshot/relay path.
      - Wiring: `SessionStartRequest.codexTransport?: "exec" | "app-server"`
        (undefined = exec). `startStreamSession` branches to the manager;
        `sessionService` gained an `appServer` dep for input/stop/list/replay.
      - Verified: real `codex app-server` accepts the exact `thread/start`
        params (`cwd`/`sandbox: read-only`/`approvalPolicy: never`) and returns
        a thread id. Typecheck clean; 90 tests pass.
      - **Activation**: nothing sets the flag by default → exec unchanged.
        Dev opt-in: `PANDA_CODE_CODEX_TRANSPORT=app-server` (see
        `codexTransportFor` in `index.ts`) flips Codex sessions to app-server.
- [x] Phase 3: reconciled the mapper against a REAL turn.
      - Captured a live app-server notification stream ("Read hello.txt and
        reply DONE") into `src/shared/appserver-capture.fixture.json` and replay
        it through the reducer in `stream-json.appserver-replay.test.ts` (6
        cases) — a regression guard on actual payload shapes + ordering.
      - Confirmed the delta-coalescing risk is a non-issue: real
        `item/agentMessage/delta.itemId` == the `item/started`/`item/completed`
        `item.id`, so all three key on `messageItemId(id)` and fold into one
        bubble. Empty-text `agentMessage` on `item/started` is skipped.
        `commandExecution` renders once on completion with output + exit code.
        Token fields (`cachedInputTokens`/`reasoningOutputTokens`) map correctly;
        usage is cumulative → replace. `turn/completed.turn.durationMs` → summary.
      - Drove the full `CodexAppServerSessionManager` against the real server
        (one-off `CODEX_LIVE` test, since removed): thread opened, turn ran,
        notifications routed by threadId → reducer → snapshot, assistant "DONE"
        landed, state → waiting. End-to-end path validated.
- [x] Bugfix (2026-07-16): **first Codex prompt dropped on app-server**. The
      renderer sends the first prompt as a separate input ~3ms after start, but
      `CodexAppServerSessionManager.start` only registered the section in its map
      *after* `await ensureClient()` + `thread/start` (~1.6s), so `appServer.has(id)`
      was still false — `sessionService.sendInput` fell through every branch to the
      no-op PTY fallback (`session:input hasSession:false`) and no turn ran. Thread
      opened (no error) but `agentState` stayed at default `waiting` ("Ready") while
      the optimistic "Thinking…" bubble never cleared. Fix: register the section
      synchronously before the async handshake, and buffer any prompt that arrives
      before `threadId` is known (`pendingPrompt`), flushing it once the thread is
      ready. Regression test in `appServerSession.test.ts` ("buffers a prompt that
      races the thread opening").
- [x] Phase 4: interactive approvals + questions (2026-07-30).
      - `threadParamsFromRequest` now asks: `approvalPolicy: "on-request"`, except
        under `danger-full-access` (the operator already opted out of restrictions,
        so prompting them would be noise) where it stays `"never"`.
      - `handleServerRequest` HOLDS the JSON-RPC request open and publishes a
        `PendingApproval` (`shared/ipc.ts`) on `StreamJsonState.pendingApproval`;
        the section parks at `needs_action` until answered. Handled:
        `item/commandExecution/requestApproval` and
        `item/fileChange/requestApproval` (accept / acceptForSession / decline) and
        `item/tool/requestUserInput` (options or free text; a multi-question
        request is surfaced one question at a time and the JSON-RPC request is
        answered ONCE with every answer).
      - Still refused, but refused *fast* and with a transcript line saying why
        (never left hanging): `item/permissions/requestApproval`,
        `mcpServer/elicitation/request`, `item/tool/call`.
      - `manager.answerApproval()` → IPC `session:answer-approval` → desktop
        `ApprovalPanel` (docked above the composer). `serverRequest/resolved` and
        `turn/started` clear a prompt that was answered elsewhere or expired;
        `stop()` answers a held request with `cancel` so the thread is not wedged.
      - Relay: `pendingApproval` + `pendingPromptId` ride `runtimeCipher`, and the
        `approve`/`deny` commands reserved in `docs/protocol.md` §6 are now
        implemented (`dispatchApproval`). Mobile UI for it is NOT built yet.
      - `item/tool/requestUserInput` is gated by Codex's own
        `default_mode_request_user_input` experimental flag (stage
        `underDevelopment`, default off). Panda honors that default; set
        `PANDA_CODE_CODEX_REQUEST_USER_INPUT=1` to enable it process-wide for our
        app-server (never written to the user's `~/.codex` config). With the flag
        on, codex-cli 0.142.3 still would not reach for the tool in testing, so
        that path is covered by unit tests + the probe's opt-in scenario rather
        than a proven live run.
- [x] Phase 5: cutover complete (2026-07-30). **The exec path is gone.**
      - Deleted: `buildStreamCodexCommand`, `hasCodex{Model,Sandbox,Approval,Json,Reasoning}Flag`,
        the codex branch of the stream `close` handler (idle/deferred-input/resume
        restart), `codex-resume-for-input` + `sendCodexInput` in `sessionService`,
        `ManagedStreamSession.{stdinClosed,pendingInput}`, and the
        `codexTransport` / `CodexTransport` plumbing (request field, the
        "Speed: Fast/Slow" picker, its localStorage key, `PANDA_CODE_CODEX_TRANSPORT`).
      - `startStreamSession` routes every `runtime: "codex"` request to the
        manager, and now records a resume request so a prompt arriving after the
        section left the manager can re-open the thread instead of being dropped.
      - Remote/mobile-started Codex sessions come along for free (they no longer
        pick a transport at all).
      - History on reload needed no new work: app-server threads write the same
        `~/.codex/sessions/**/rollout-*<threadId>.jsonl` files that
        `readCodexConversation` already parses (verified against live app-server
        thread ids), so the `thread/read` loader listed below as open is not
        required. Left as a possible refinement, not a gap.

### Hardening that shipped with the cutover

- **Prompt queue, not a slot.** `pendingPrompt` became `queue: QueuedPrompt[]`.
  A second prompt arriving while the thread opens used to overwrite the first;
  now the queue drains into one turn, in order. `flushQueue` is the single drain
  point (start, and turn/completed).
- **Honest send results.** `sendInput` is `async` all the way to
  `sessionService.sendInput` and the IPC handler; a queued prompt reports
  `ok: true` ONLY when something will actually flush it. With the client dead it
  returns `ok: false` so the renderer restarts the section instead of showing
  "Thinking…" forever.
- **`turn/steer` for mid-turn prompts.** Firing `turn/start` during a live turn
  was wrong; steering carries `expectedTurnId`, a server-side precondition on the
  ACTIVE turn. `turnActive` tracks the window (`turn/started` → `turn/completed`)
  because `turnId` lingers past the end. Losing the race falls back to a new turn.
- **Real turn status.** `turn/completed` carries `status`
  (`completed|interrupted|failed`) and `error` — there is no `turn/failed`
  notification, so a failed turn used to render as a clean idle turn with a
  duration footer. It now surfaces the error and parks at `needs_action`.
- **Images.** Prompts carry `imagePaths`, sent as `{type: "localImage", path}`
  inputs, so the model SEES the image instead of reading a path in the prose.
  The text keeps its "Attached image files:" list (thumbnails and the transcript
  dedupe both key off it).
- **Usage stopped spawning processes.** `readCodexRateLimitsViaAppServer` asks the
  live session client first (or its `account/rateLimits/updated` cache) and only
  spawns a throwaway app-server every 15 minutes at most. It used to spawn and
  SIGTERM one per poll — 3,611 times in one debug log.

### Testing

- Unit: `appServerSession.test.ts` (24 cases) covers the queue, steering, the
  steer-race fallback, images, approvals (hold → answer → clear, stale answers,
  cancel on stop, multi-question), and the sandbox opt-out.
  `stream-json.appserver.test.ts` covers failed/interrupted turns and the relay
  payload.
- Live: `pnpm probe:codex <scenario>` (`apps/desktop/scripts/codex-probe.ts`)
  drives the REAL `codex app-server` through the same manager the app uses and
  asserts each outcome. `all` runs turn, queue, steer, image, approve, usage.
  `question` is opt-in (see the flag note above). `PROBE_VERBOSE=1` prints every
  event and state transition.
