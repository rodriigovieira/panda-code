# Panda Code Relay Protocol

This is the wire contract between `apps/desktop` (TS), `convex-relay` (TS), and
`apps/mobile` (Dart). The Convex schema generates the *transport* types for both
clients, but the **pairing handshake and the E2E envelope are implemented twice, in
two languages, so they can silently drift.** This file is their single source of
truth. Change it here first.

## 1. Trust model

- The relay is **blind**: Convex stores only ciphertext + coarse routing/status
  enums. It cannot read prompts, code, titles, or output.
- The real trust boundary is a **symmetric key shared only by your Mac and your
  phone**, established by QR pairing. Whoever holds that key can read the session
  and — critically — **run code on your Mac**. Treat it like an SSH key.

## 2. Pairing

```
Desktop                         Convex relay                    Phone
  │  registerDevice(token) ───────▶ devices row (tokenHash)
  │  createCode(code) ────────────▶ pairings row (pending, TTL 5m)
  │
  │  render QR  ───────────────────────────────────────────────▶ scan
  │  QR payload (NOT sent to Convex):
  │    { url, deviceId, code, k }
  │                                                    claimCode(code, token) ─▶
  │                                 mobileClients row (tokenHash)
  │                                                    reads k straight off QR
```

- `url`  — the Convex deployment URL.
- `deviceId` — the desktop to pair with.
- `code` — single-use pairing code (also stored in `pairings`, TTL 5 min).
- `k` — **the 32-byte E2E key, base64.** This is the out-of-band secret. It is in
  the QR only; it never reaches Convex. Both sides persist it in secure storage
  (Keychain on Mac, `flutter_secure_storage` on the phone).

Tokens (`token` args on every function) are bearer tokens for *relay* auth, stored
hashed. They are **not** the E2E key — a stolen relay token lets you enqueue
ciphertext nobody can decrypt, not read content.

> v1 embeds `k` in the QR (a physically-present trust act — you're pointing your
> phone at your own screen). v2 upgrade: X25519 ECDH so the key is derived, never
> displayed. Same pairing rows, different QR payload.

## 3. E2E envelope

Every `*Cipher` field is one string:

```
base64( nonce (24 bytes) || secretbox(plaintext, nonce, k) )
```

- Cipher: **XSalsa20-Poly1305** (libsodium `crypto_secretbox`).
  - TS (desktop): `libsodium-wrappers` or `tweetnacl` (`nacl.secretbox`).
  - Dart (mobile): `pinenacl` or `cryptography` (`SecretBox` / `Xsalsa20Poly1305`).
- `nonce`: 24 random bytes per message, prepended.
- `plaintext`: UTF-8 JSON of the payload type below.

**Interop test (must pass before anything else ships):** a fixed `k`, fixed nonce,
fixed plaintext → identical ciphertext in TS and Dart, and each opens the other's.
Put it in both test suites.

## 4. Payload types (plaintext inside the envelope)

These mirror `apps/desktop/src/shared/ipc.ts`. Keep them aligned.

| Cipher field | Plaintext JSON |
|---|---|
| `commandPayloads.payloadCipher` (`type: "start"`) | `SessionStartRequest` |
| `commandPayloads.payloadCipher` (`type: "input"`) | `{ data: string }` |
| `commandPayloads.payloadCipher` (`approve`/`deny`) | `{ promptId: string }` |
| `sessions.titleCipher` / `cwdCipher` | `string` |
| `sessionRuntime.runtimeCipher` | `SessionRuntimeEvent` (minus `id`) |
| `deviceUsage.usageCipher` | `UsageBundle` |
| `events.payloadCipher` | `ConversationItem` (see below) |
| `commands.resultCipher` | `SessionStartResult` / `{ message }` |

### ConversationItem (events.payloadCipher)

Base fields mirror `ipc.ts`: `{ id, kind, title?, body?, sequence?, model? }` where
`kind ∈ user|assistant|tool|system|marker`. The mobile chat UI renders richer when
the desktop ALSO populates these OPTIONAL, backward-compatible fields (absent →
mobile degrades to `title`/`body`):

- `thinking: boolean` — assistant reasoning block (rendered collapsed/dim).
- `tool: { ... }` — present when `kind == "tool"`:
  - `name: string` — tool display name.
  - `category?: "bash"|"edit"|"read"|"search"|"web"|"task"|"other"` — picks icon/layout.
  - `status?: "running"|"success"|"error"`, `exitCode?: number`.
  - `command?: string` — for bash (rendered as a shell code block).
  - `filePath?: string` — for edit/read (shown next to the name).
  - `diff?: string` — a **unified diff** for edits (per-line +/- coloring).
  - `input?: string` — generic tool input when there's no command.
  - `output?: string` — stdout/result (collapsed if long).

`SessionRuntimeEvent` (runtimeCipher) SHOULD also carry `pendingPromptId?: string`
when `agentState == needs_action`, so the phone's Approve/Deny answers the exact
prompt (`commands.payloadCipher = { promptId }`).

## 5. Cost / streaming model

The relay is cheap **only** if the desktop respects these. See the README rationale.

1. **Append deltas, never rebroadcast.** Write new `events` rows via
   `sessions.appendEvents`. Never store a whole-conversation blob that gets
   rewritten each tick — that multiplies bandwidth by (doc size × frequency ×
   subscribers) on both read and write.
2. **Coalesce to ~1/sec or per-transition.** Batch conversation items on the
   desktop and flush on meaningful transitions (new message, tool start/end, run
   done, needs-approval). Never per token — nobody reads tokens on a phone.
3. **Keep the raw stdout firehose local.** `session:data` is for the desktop
   terminal view only. Only structured `ConversationItem` / runtime badges cross
   the relay.
4. **Mobile subscribes to the TAIL.** `sessions.tail(afterSeq)` reads only events
   past the phone's cursor. History backfill is a separate one-shot paginated read.
5. **A reactive query pays for its whole READ SET, every re-fire.** Convex charges
   database bandwidth per *document read*, not per field returned — and re-runs the
   whole handler when anything in that set changes. So a projection is not a
   saving, and two things must never share a table: something that churns, and
   something that is fat or read in bulk. When they do, the churn is multiplied by
   the bulk. Every table split on this relay is one instance of this rule:
   - `sessionRuntime` — per-tick badge + tail cursor, out of `sessions`, so the
     token firehose stops re-firing `sessions.list`.
   - `sessionStars` — the desktop's permanent `starredForDevice` subscription had
     the whole `sessions` range in its read set, so every status transition re-read
     ~100 full session docs to answer a question about pins.
   - `commandPayloads` — attachments run to Convex's 1 MiB doc cap; `watchMine`
     re-fires on every status transition and `enqueue` scans recent rows to rate
     limit, and neither needs the payload.
   - `deviceUsage` — `devices` is on the auth path of *every* call, so a
     periodically-refreshed blob there was charged to the whole protocol.
6. **Write only what changed.** Ciphertext is nondeterministic (fresh nonce per
   call), so re-encrypting an unchanged value looks like a change to the relay and
   re-fires every subscriber. Cache the {plaintext → ciphertext} pair and compare
   plaintext (`stableCipher`, `runtimeSent`, `sentUsageCipher` in `relayBridge.ts`).
7. **Prune.** TTL old `events`/`sessions`/closed `commands` (a cron, later).

## 6. Permission prompts (design note)

Unattended `claude -p` needs a permission posture. Two supported shapes:

- **Auto-approve** in trusted repos: the desktop runs a chosen permission mode and
  the phone only observes. Simplest; pick this for v1.
- **Remote approval:** desktop emits a `needs_action` runtime state + an event
  describing the prompt; phone answers with an `approve`/`deny` command carrying the
  `promptId`.

**Desktop side implemented (2026-07-30, Codex only.)** `runtimeCipher` carries
`pendingPromptId` plus a richer `pendingApproval` object whenever
`agentState == needs_action` because Codex is blocked:

```
pendingApproval: {
  promptId, kind: "command"|"fileChange"|"userInput", title, body,
  reason?, cwd?, options: [{ id, label, hint?, tone?: "approve"|"deny" }],
  allowsFreeText?, requestedAt, questionCount?, questionIndex?
}
```

`approve`/`deny` commands are dispatched (they map to the `accept` / `decline`
options). The payload MAY also name `optionId` (any id from `options` — this is
how a `userInput` question is answered) and `text` for a free-text answer:
`commands.payloadCipher = { promptId, optionId?, text? }`. Answering a prompt that
is no longer pending fails the command rather than silently succeeding.
**The mobile UI for this is not built yet** — the phone still only observes.

## 7. Section lifecycle from the phone

**A prompt restarts a dormant section.** A section only has a live agent process
while it is mid-turn; the desktop UI hides this because its composer starts the
section before writing to it. An `input` command has no UI to do that for it, so
the desktop does it: with nothing owning the section, `sessionService.sendInput`
rebuilds the launch request from the persisted thread (same cwd, runtime, model,
effort, permission mode, and resume id) and delivers the prompt to whatever
transport that produced. Only an unknown section, or a workspace folder that has
moved, still reports a drop — and the phone MUST surface a failed `input`
command, since nothing else tells the user the message was never answered.

**Titles.** `sessions.titleCipher` is what the phone renders. Auto-titles come
from the transcript readers and ride on the ordinary session upsert. A title the
user typed is different: it is pushed by `sessions:setTitleByDevice`, a
title-only mutation that will not create a row (a renamed dormant section must
not pop up on the phone as new) and does not restate status. The desktop
remembers which sections were renamed by hand and stops auto-titles from
overwriting them, mirroring the renderer's own `titleSource: "manual"` rule.
Phone-side aliases stay device-local and win over both.
