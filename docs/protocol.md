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
| `commandPayloads.payloadCipher` (`type: "start"`) | `SessionStartRequest` (`parentSessionId?` opens it as a sub-thread) |
| `commandPayloads.payloadCipher` (`type: "input"`) | `{ data: string }` |
| `commandPayloads.payloadCipher` (`approve`/`deny`) | `{ promptId: string }` |
| `sessions.titleCipher` / `cwdCipher` | `string` |
| `sessionRuntime.runtimeCipher` | `SessionRuntimeEvent` (minus `id`) |
| `deviceUsage.usageCipher` | `UsageBundle` |
| `events.payloadCipher` | `ConversationItem` (see below) |
| `commandPayloads.payloadCipher` (`type: "backlog"`) | `{ cwd, op: "list"\|"add"\|"update"\|"move"\|"delete"\|"epic-add"\|"epic-update"\|"epic-delete", id?, title?, summary?, description?, metadata?, column?, onHold?, verificationNotes?, epicId?, scope?, acceptanceCriteria?, acceptanceScenario?, index?, removeAttachmentIds? }` |
| `commandPayloads.payloadCipher` (`type: "schedule"`) | `{ cwd }` — view-only in V1, no `op` |
| `commands.resultCipher` | `SessionStartResult` / `{ message }` / `{ backlog: WorkspaceBacklog }` / `{ schedule: WorkspaceSchedule }` |

**The workspace backlog is not relay state.** A workspace's kanban board is a
file on the Mac (`userData/backlogs/<flattened-cwd>.json`), written by the
desktop UI *and* by every agent working in that folder through its own process.
The relay stores no copy: the phone asks with a `backlog` command and the desktop
answers with the whole board in `resultCipher`, on every operation including a
mutation. Returning the whole board rather than the edited card is deliberate —
by the time the answer is written another writer may have changed something
else, and a phone reconciling a diff against a file it does not own would be
inventing state. The workspace path travels *inside* the sealed payload, so the
relay never learns which folder is being read, and the desktop refuses any path
it does not already know as a workspace (the same gate as a remote start).
Boards may additionally contain flat `epics`, a card's optional `epicId`, and
append-only `verificationScenarios`. Scenario records link to attachment ids;
they do not duplicate the media. Older version-1 boards omit these fields and
remain valid.

**`sessions.parentSessionId` is plaintext, deliberately.** A section can be a
*sub-thread* of another one (the desktop's `PersistedThread.parentId`), and the
phone nests its list the same way the sidebar does. The field carries an opaque
local session id and nothing else — the same class of value as `sessionId`, which
the relay already routes on in the clear — so encrypting it would hide nothing
the relay cannot already see, while forcing the phone to decrypt every row before
it could group them. No title, path or prompt travels with it. The link is
written by `sessions:upsertSession` (on the section's first flush, from the
`parentId` on its start request) and by `sessions:setParentByDevice` when the
user re-arranges the tree; an absent value means top-level, which is why the
latter is a patch rather than a sticky upsert argument.

**Scheduled tasks follow the backlog's pattern, one-way.** A workspace's
scheduled tasks live in `userData/schedules/<flattened-cwd>.json` on the Mac,
written by the desktop UI, by every agent's `schedule_add`/`schedule_update`,
and by the in-process ticker that fires a job and records its run. The relay
stores no copy here either: the phone sends a `schedule` command with just the
workspace path and the desktop answers with the whole schedule in
`resultCipher`. Unlike `backlog`, there is no mutation `op` yet — mobile is
view-only for V1, so creating or editing a job is desktop/agent-only until a
write path is added.

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
2. **Coalesce at meaningful boundaries.** Batch conversation items on the
   desktop and flush on transitions (new user/tool/marker, tool start/end, run
   done, needs-approval). Keep the latest growing assistant/reasoning snapshot
   local between those boundaries; rewriting the complete, ever-larger body once
   per stream tick is quadratic bandwidth, not delta streaming. Never per token.
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

### Large command results

Successful encrypted answers are stored in ordered `commandResults` rows of at
most 256 Ki UTF-16 code units each (below 1 MiB even with UTF-8 expansion).
`commands:result` rejoins them into the original ciphertext, so existing clients
and encryption envelopes remain compatible. The optional plaintext `chunkIndex`
exposes only ordering and approximate response size; all user content stays
encrypted. Legacy single rows and inline results remain readable. Consumption,
replacement, and retention cleanup delete every piece. This removes the per-row
limit, not Convex's overall function argument, return, or transaction limits.

## Authenticated commands and per-phone identity (command protocols v2/v3)

Command v2 is the migration baseline. Every command, including Stop and empty
requests, requires a secretbox ciphertext under
`HMAC-SHA256(pairingKey, UTF8("panda-code/command/v2"))`. Its envelope is
`{v:2, domain:"panda-code/command/v2", id, deviceId, mobileId, sessionId,
type, issuedAt, expiresAt, payload}`. The desktop binds every routing field,
allows at most five minutes with 30 seconds of future clock skew, and records the
UUID durably before dispatch. Pre-v2 and payload-free commands fail closed.

Command v3 adds an independent P-256 identity for each paired phone. On iPhones
with Secure Enclave support, the private key is generated there and never
exported. It is a non-synchronizable Keychain item with
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and `biometryCurrentSet` when
biometrics are enrolled, so an enrollment change invalidates it. Devices and simulators without a
Secure Enclave use a non-exportable software P-256 Keychain key with the same
ThisDeviceOnly/biometric policy when available, otherwise device-owner presence.
Face ID happens on the phone while signing; nobody must be present at the Mac.

The phone canonicalizes the inner payload as UTF-8 JSON (object keys sorted
recursively, array order preserved), computes
`payloadDigest = hex(SHA-256(payloadCanonical))`, and signs these UTF-8 bytes:

```text
JSON.stringify(["panda-code/command-auth/v3", commandUuid, deviceId,
  mobileId, sessionIdOrNull, commandType, issuedAtMs, expiresAtMs,
  payloadDigest])
```

The signature is P-256 ECDSA/SHA-256 in X9.62 DER form. The secretbox-protected
v3 envelope is `{v:3, domain:"panda-code/command-auth/v3", id, deviceId,
mobileId, sessionId, type, issuedAt, expiresAt, payloadCanonical,
payloadDigest}`. The relay row carries the auth version, key ID, and signature.
The desktop obtains the enrolled X9.63 public point for that exact phone/key ID,
recomputes the key ID and payload digest, verifies the complete context, and only
then records the replay UUID and dispatches. Missing, partial, mismatched,
expired, replayed, or downgraded identity data fails closed. Event and result
content encryption remains group-key compatible.

### Migration and rollout

Deploy the additive relay schema/functions first, then desktop and mobile. A
mobile row with no command identity is explicitly legacy and may send only v2.
On first launch against an updated relay, an existing phone creates its key,
registers it once, stores version 3 in ThisDeviceOnly storage, and thereafter
sends only v3. Registration is idempotent only for the exact same key. A changed
or invalidated key cannot overwrite the enrolled identity and requires a fresh QR
pairing/new mobile ID. Against an older self-hosted relay, the mobile app keeps
using v2 until the additive function exists; a row already enrolled as v3 can
never downgrade.

The relay URL is public configuration, not a credential. New desktop enrollment
requires the owner's internal `pairing:authorizeDevice` operation with the
fingerprint shown by their own desktop. Existing registered desktops authenticate
as before. Public diagnostic reads and writes are removed; trace maintenance is
internal. Authenticated media uploads use `/media/upload` on the Convex HTTP site,
with device identity and bearer token in headers. Bodies are capped at 16 MiB,
with 60 attempts per device per hour; source captures are capped at 8 MiB. The
server registers ownership before replying. Old unregistered blobs are pruned.

Revocation first marks one phone's bearer credential unusable and removes its
public command identity in a small transaction. `requireMobile`, pending-command
identity resolution, and command claiming then fail immediately. Scheduled,
idempotent cleanup removes at most 100 push tokens, 100 subscriptions, and 25
commands (with bounded result pieces) per transaction until the tombstone can be
deleted. This keeps revocation prompt even with thousands of retained commands.
Other phones continue working without key rotation. A command already claimed by
the desktop before revocation may finish; pending or merely delivered commands
must pass the post-revocation claim check and cannot start. The content E2E key remains shared initially for
compatibility, so revocation cannot recall content already downloaded or a copied
historical group key. The older bounded all-phone reset remains only to finish a
reset persisted by an earlier desktop. A phone never holds another phone's
command-signing private key.
A stolen bearer token can affect that phone's relay subscriptions and expose
ciphertext/traffic metadata; it cannot produce a valid new desktop command without
the pairing key. Notification subscriptions remain bearer-authenticated routing
preferences, not authorization to execute code. A compromised relay can suppress
traffic and replay content displays; command routing substitution and duplicate
execution are rejected by the desktop. Protect the Convex owner account too.

Remote session input/start/model changes respect a Mac-owned permission ceiling.
Before every input, queued-prompt delivery, switch, aside, or approval response,
the desktop resolves a conservative ceiling from both the saved selector and
Claude command-line permission flags. If either could grant unrestricted access,
the session is treated as unrestricted; this also covers sessions launched by
older desktop versions whose flag parser could append both forms. A Codex session
without an explicitly resolved sandbox, or any session whose effective authority
is unknown, fails closed for phone control. Full-access sessions and approval
responses require the Mac owner's explicit remote-full-access opt-in. This does
not make a paired phone untrusted: it can request work and read files inside the
permitted workspace. Denials remain available without the full-access opt-in.
