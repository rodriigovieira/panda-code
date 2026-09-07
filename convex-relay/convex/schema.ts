import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Panda Code relay schema — the single source of truth both clients codegen from.
 *
 * DESIGN RULES (see docs/protocol.md):
 *  - E2E: every field carrying user content is an opaque ciphertext string
 *    (`*Cipher`). The relay never sees plaintext. Only routing + coarse status
 *    enums are stored in clear so the mobile list/badges render without a decrypt.
 *  - DELTA STREAMING: conversation state is an append-only `events` log keyed by a
 *    monotonic per-session `seq`. Mobile subscribes to the TAIL via a seq cursor;
 *    it never re-reads the whole session. `sessionRuntime.headSeq` is the cursor
 *    head. This is what keeps Convex bandwidth near-zero — do NOT add a "full
 *    snapshot" field to `sessions` that gets rewritten every tick (that is
 *    exactly why the per-tick head/runtime fields live in `sessionRuntime`, a
 *    table the all-sessions `list` query deliberately does not read).
 */

// Mirrors the Electron ipc.ts enums so the contract lines up 1:1.
const sessionStatus = v.union(
  v.literal("idle"),
  v.literal("running"),
  v.literal("exited"),
  v.literal("error"),
);
const agentState = v.union(
  v.literal("working"),
  v.literal("waiting"),
  v.literal("needs_action"),
  v.literal("exited"),
);
const executionMode = v.union(v.literal("terminal"), v.literal("stream-json"));
const itemKind = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("tool"),
  v.literal("system"),
  v.literal("marker"),
);

export default defineSchema({
  mediaUploadBudgets: defineTable({ deviceId: v.string(), windowStart: v.number(), count: v.number() }).index("by_device", ["deviceId"]),
  // Owner-approved, short-lived binding to a desktop-generated random token.
  // The fingerprint is not a bearer credential; only its preimage can enroll.
  deviceEnrollments: defineTable({
    deviceId: v.string(), tokenFingerprint: v.string(), expiresAt: v.number(),
  }).index("by_device", ["deviceId"]),
  // A desktop executor. One row per Mac running Panda Code.
  devices: defineTable({
    deviceId: v.string(), // stable, desktop-generated (stored in Keychain)
    resettingPairing: v.optional(v.boolean()),
    pairingResetId: v.optional(v.string()),
    completedResetId: v.optional(v.string()),
    name: v.string(),
    platform: v.string(), // "darwin" for now
    appVersion: v.optional(v.string()),
    status: v.union(v.literal("online"), v.literal("offline")),
    lastHeartbeatAt: v.number(),
    // Opaque token the desktop presents on every call. Hashed, never the raw token.
    tokenHash: v.string(),
    // DEPRECATED — moved to the `deviceUsage` table. This row is read by
    // `requireDevice` on EVERY relay call, so a multi-KB blob on it was charged
    // to every append, upsert and tail. Kept optional so existing rows validate;
    // backfilled + cleared by `maintenance:migrateDeviceUsage`.
    usageCipher: v.optional(v.string()),
  })
    .index("by_device", ["deviceId"])
    .index("by_status_heartbeat", ["status", "lastHeartbeatAt"]),

  // Encrypted plan-usage snapshot (rate-limit windows). Desktop-only data — it
  // holds the OAuth creds to fetch it — pushed on the heartbeat so the phone can
  // render account usage it could never fetch itself.
  //
  // Split OUT of `devices` for the same reason `sessionRuntime` is split out of
  // `sessions`: `devices` is on the auth path of every single relay call, and
  // Convex charges database bandwidth per DOCUMENT READ, not per field returned.
  // Parking a periodically-refreshed blob there taxed every call in the system.
  // Only `devices:status` (which the phone actually renders) reads this table.
  deviceUsage: defineTable({
    deviceId: v.string(),
    usageCipher: v.string(),
    updatedAt: v.number(),
  }).index("by_device", ["deviceId"]),

  // A paired phone. Created when a phone claims a pairing code.
  mobileClients: defineTable({
    mobileId: v.string(),
    deviceId: v.string(), // the desktop this phone is paired to
    name: v.optional(v.string()),
    tokenHash: v.string(),
    createdAt: v.number(),
    // Per-phone notification preferences (absent = notify). No content here.
    notifMuted: v.optional(v.boolean()),
    notifyOnDone: v.optional(v.boolean()),
    notifyOnNeedsApproval: v.optional(v.boolean()),
    notifyOnError: v.optional(v.boolean()),
  })
    .index("by_mobile", ["mobileId"])
    .index("by_device", ["deviceId"]),

  // Short-lived QR pairing handshake. The E2E symmetric key is exchanged
  // OUT-OF-BAND inside the QR payload and never stored here (see protocol.md).
  pairings: defineTable({
    code: v.string(), // high-entropy, single-use
    deviceId: v.string(),
    status: v.union(v.literal("pending"), v.literal("claimed"), v.literal("expired")),
    createdAt: v.number(),
    expiresAt: v.number(),
    claimedByMobileId: v.optional(v.string()),
  })
    .index("by_device", ["deviceId"])
    .index("by_code", ["code"])
    .index("by_status_expires", ["status", "expiresAt"]),

  // One row per Panda Code thread/session. Routing + coarse status in clear;
  // the human title is ciphertext. Low-churn only: mutated on lifecycle
  // transitions (create, status/agentState change, title/cwd resolved, exit) and
  // on user prompts (`lastPromptAt`), never per streamed token — so the
  // `sessions.list` subscription stays cheap. The tail cursor (`headSeq`) and the
  // per-tick runtime badge live in `sessionRuntime`.
  sessions: defineTable({
    deviceId: v.string(),
    sessionId: v.string(), // the desktop thread id
    titleCipher: v.optional(v.string()),
    cwdCipher: v.optional(v.string()),
    status: sessionStatus,
    agentState: agentState,
    executionMode: executionMode,
    claudeSessionId: v.optional(v.string()),
    // DEPRECATED — moved to the `sessionRuntime` table. These per-tick fields
    // used to live here, but every append/runtime write bumped this row and
    // re-fired the `sessions.list` reactive query for every phone (re-shipping
    // all ~100 rows on every streamed token — the relay's dominant cost). They
    // are kept as optional only so existing rows validate during migration;
    // `sessions.list` no longer reads them and no code writes them here anymore.
    // Backfilled + cleared by `maintenance:migrateSessionRuntime`.
    headSeq: v.optional(v.number()),
    runtimeCipher: v.optional(v.string()),
    // The section this one is a SUB-THREAD of, by desktop thread id.
    //
    // Plaintext, and deliberately so: it is the same class of value as
    // `sessionId` itself — an opaque local id with no user content in it — and
    // it is structural, not descriptive. Encrypting it would buy nothing (the
    // relay already sees both ids on their own rows) and would cost the phone
    // the ability to group its list without first decrypting every row. See
    // `docs/protocol.md` §5 for the plaintext-field rule this is filed under.
    parentSessionId: v.optional(v.string()),
    // Push notification routing metadata only. No prompt or output content.
    startedByMobileId: v.optional(v.string()),
    notifyOnExit: v.optional(v.boolean()),
    notifiedExitAt: v.optional(v.number()),
    // DEPRECATED — moved to the `sessionStars` table (see there for why). Kept
    // optional so existing rows validate; backfilled + cleared by
    // `maintenance:migrateSessionStars`.
    starred: v.optional(v.boolean()),
    starredAt: v.optional(v.number()),
    updatedAt: v.number(),
    // When the most recent USER PROMPT entered this session's transcript.
    // Bumped only on `user`-kind events, never on assistant/tool/system deltas,
    // so it gives the mobile list a stable sort key: concurrently-running
    // sessions don't ping-pong for the top slot on every streamed event.
    lastPromptAt: v.optional(v.number()),
  })
    .index("by_device", ["deviceId"])
    // What `sessions:list` windows on: most recently ACTIVE first. `by_device`
    // sorts by `_creationTime`, which pins a thread's position to the first time
    // it ever streamed — and since `sessions` rows are never pruned, a device
    // with a few hundred of them hides actively-used old threads from the phone.
    .index("by_device_updated", ["deviceId", "updatedAt"])
    .index("by_device_session", ["deviceId", "sessionId"])
    .index("by_device_status", ["deviceId", "status"])
    .index("by_device_agent_state", ["deviceId", "agentState"]),

  // High-churn per-session runtime state, split OUT of `sessions` so the hot
  // path (appendEvents head bumps + per-tick runtime badge) never touches a row
  // that `sessions.list` reads. `list` subscribes to `sessions` only, so the
  // token firehose no longer invalidates it; the mobile session VIEW subscribes
  // to a single row here via `sessions:runtime`, which re-fires O(1) (one row,
  // one open session) instead of re-shipping the whole list. This is THE lever
  // that keeps `sessions.list` bandwidth near-zero — do NOT read this table from
  // `list` or any all-sessions query.
  sessionRuntime: defineTable({
    deviceId: v.string(),
    sessionId: v.string(),
    headSeq: v.number(), // highest event seq written for this session (tail cursor head)
    // Small, low-frequency runtime badge (latest tool/command/token usage), encrypted.
    runtimeCipher: v.optional(v.string()),
  }).index("by_device_session", ["deviceId", "sessionId"]),

  // Shared pin/star state, one row per session the user ever starred. Routing
  // metadata only; no session content.
  //
  // Split OUT of `sessions` because the desktop holds a PERMANENT subscription to
  // `sessions:starredForDevice`. While the stars lived on the session row, that
  // query's read set was the whole `by_device` range: every status transition,
  // rename and `lastPromptAt` bump re-read all ~100 full session docs to return
  // four tiny fields — the relay's single largest line item. Reading only this
  // table means the subscription re-fires when a star actually flips, and pays
  // for a handful of ~60-byte docs when it does.
  // The desktop holds a PERMANENT subscription to `sessions:starredForDevice`.
  // Reading the whole `by_device` range there meant every re-execution re-shipped
  // all ~200 rows to report one flipped boolean, so the desktop subscribes on
  // `by_device_updated` with a `since` cursor instead: it takes the full set once
  // with a one-shot read at startup, then watches only the tail after that
  // instant, whose read set is empty until something actually changes.
  sessionStars: defineTable({
    deviceId: v.string(),
    sessionId: v.string(),
    starred: v.boolean(),
    starredAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_device", ["deviceId"])
    .index("by_device_updated", ["deviceId", "updatedAt"])
    .index("by_device_session", ["deviceId", "sessionId"]),

  // Shared archive (hide-from-list) state, same split-table shape as
  // `sessionStars` and for the same reason: archiving is a pure view-filter
  // toggled from either device, and must not invalidate the heavy
  // `sessions:list` read set when it flips.
  sessionArchive: defineTable({
    deviceId: v.string(),
    sessionId: v.string(),
    archived: v.boolean(),
    archivedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_device", ["deviceId"])
    .index("by_device_updated", ["deviceId", "updatedAt"])
    .index("by_device_session", ["deviceId", "sessionId"]),

  // Per-device write budget for the `appendEvents` hot path — a fixed-window
  // counter, one row per device (see `lib/retention.ts` for the sizing).
  //
  // This lives in its OWN table for the same reason `sessionRuntime` does: it is
  // written on every flush, and `devices` is read by the `devices:status`
  // reactive query every phone subscribes to. Counting on the device row would
  // re-fire that subscription on every batch — reintroducing exactly the
  // per-tick invalidation the sessionRuntime split removed. NOTHING reactive
  // reads this table; it is written and read only by `sessions:appendEvents`.
  deviceWriteBudget: defineTable({
    deviceId: v.string(),
    windowStartedAt: v.number(),
    events: v.number(), // events accepted in the current window
    bytes: v.number(), // payloadCipher bytes accepted in the current window
  }).index("by_device", ["deviceId"]),

  // Per-(session, phone) notification subscription OVERRIDES only. Absent = use
  // the default, which is `startedByMobileId == mobileId` (a phone is auto-subbed
  // to the sessions it launched, and not to desktop-started ones). A row exists
  // only when the user deviated from that default — subscribing to a
  // desktop-started session, or unsubscribing from one they launched. Routing
  // metadata only; no content.
  sessionSubs: defineTable({
    deviceId: v.string(),
    sessionId: v.string(),
    mobileId: v.string(),
    subscribed: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_device_session", ["deviceId", "sessionId"])
    .index("by_mobile", ["mobileId"]),

  // Append-only conversation/runtime deltas. THE hot path — keep rows small.
  events: defineTable({
    deviceId: v.string(),
    sessionId: v.string(),
    seq: v.number(), // monotonic per session
    kind: itemKind,
    payloadCipher: v.string(), // encrypted ConversationItem (or runtime delta)
    createdAt: v.number(),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    .index("by_device_session_seq", ["deviceId", "sessionId", "seq"])
    .index("by_created", ["createdAt"]),

  // Mobile → desktop control channel. Desktop subscribes to its own pending rows.
  commands: defineTable({
    deviceId: v.string(),
    mobileId: v.string(),
    sessionId: v.optional(v.string()),
    type: v.union(
      v.literal("start"), // start a new session (payload = SessionStartRequest)
      v.literal("input"), // send a prompt/keystrokes to a running session
      // Hold a prompt behind the current turn instead of steering it immediately
      // (add/remove/send-now, payload = {action, id, data?, attachments?}). The
      // desktop's relay bridge owns the queue and flushes it when the turn ends.
      v.literal("queue"),
      v.literal("stop"),
      v.literal("notification-settings"), // encrypted per-section desktop/agent routing preferences
      v.literal("switch"), // change model/effort/permission mid-session (payload = LaunchOverride)
      v.literal("approve"), // answer a tool-permission prompt
      v.literal("deny"),
      v.literal("btw"), // side question about a session; answer rides back in resultCipher
      // Token→dollar report from the desktop's usage ledger. Scoped to one
      // session or to a date range; the report rides back in resultCipher.
      v.literal("usage-cost"),
      // "What did this section change?" — the desktop joins the section's own
      // transcript to git and rides the file list back in resultCipher.
      v.literal("session-files"),
      // Force a fresh plan-usage fetch (bypassing the desktop's periodic cache
      // floor) and ride the refreshed bundle back in resultCipher.
      v.literal("usage-refresh"),
      // Read or edit a workspace's kanban board. The board is a file on the
      // Mac (agents write it from their own processes), so the phone reaches it
      // the same way it reaches the working tree: a request/response command
      // whose whole board rides back in resultCipher. The workspace path is
      // user content and travels encrypted inside the payload — the relay
      // stores no board state of its own.
      v.literal("backlog"),
      // Read a workspace's scheduled tasks. View-only from the phone (V1) — no
      // mutation variant — same request/response shape as `backlog`, whole
      // schedule riding back in resultCipher.
      v.literal("schedule"),
      // Read a workspace's git status (branch, ahead/behind, changed files,
      // stashes, worktrees, branches). Read-only, same request/response shape
      // as `schedule` — the desktop is the only place that can see the
      // working tree, so this is a round-trip too.
      v.literal("git-status"),
      // The Mac's own vital signs — load, memory, swap, disk and the heaviest
      // processes. Asked for only while the phone's device sheet is open: the
      // numbers move every second, so riding them on the heartbeat would rewrite
      // the device doc (and wake every subscription) five times a minute.
      v.literal("machine-stats"),
      // The desktop's shared "no project" scratch folder path, creating it if it
      // doesn't exist yet. Argument-less, same request/response shape as
      // `machine-stats` — lets a phone pin a "No project" entry without first
      // seeing a session already running there.
      v.literal("scratch-workspace"),
      // Fetch one browser screenshot/recording off the desktop's disk (payload =
      // {path}). The desktop uploads the encrypted bytes to Convex file storage
      // and rides back only {storageId, mimeType} in resultCipher — the file
      // itself never fits the 1 MiB document cap the way a downscaled chat
      // attachment does. See `media.ts` for the actual transfer.
      v.literal("media"),
    ),
    // DEPRECATED for new writes — the request payload now lives in
    // `commandPayloads`. Reads still fall back to it so commands enqueued by an
    // older phone build (or before the split) still execute.
    payloadCipher: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("done"),
      v.literal("error"),
    ),
    // ERROR results only — one sentence from the desktop, kept inline precisely
    // because `commands:watchMine` exists to explain a rejected command and a
    // failure message is small by construction. A SUCCESSFUL result goes to
    // `commandResults` instead: those are whole kanban boards, git statuses and
    // process lists, and inlining them made every re-fire of `watchMine`
    // re-ship all ten of them (the relay's single largest line item).
    resultCipher: v.optional(v.string()),
    // Whether a `commandResults` row exists, so the phone can subscribe to the
    // one command it is waiting on without this query reading the results table.
    hasResult: v.optional(v.boolean()),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
  })
    .index("by_device_status", ["deviceId", "status"])
    .index("by_mobile", ["mobileId"])
    .index("by_mobile_created", ["mobileId", "createdAt"])
    .index("by_status_created", ["status", "createdAt"]),

  // The request payload of a command, keyed by command id.
  //
  // Split OUT of `commands` because these documents are HUGE (image attachments
  // are base64'd into a single `payloadCipher`, sized right up to Convex's 1 MiB
  // document cap by `image_prep.dart`) while nothing that reads them repeatedly
  // needs them: `commands:watchMine` re-fires on every status transition and
  // `commands:enqueue` scans recent rows for rate limiting — both were paying for
  // every attached screenshot, over and over. Only the desktop's claim path reads
  // this table, once per command, and `commands:ack` deletes the row on the spot.
  commandPayloads: defineTable({
    commandId: v.id("commands"),
    payloadCipher: v.string(),
  }).index("by_command", ["commandId"]),

  // The SUCCESSFUL result of a request/response command, keyed by command id.
  //
  // Split OUT of `commands` for the mirror-image reason `commandPayloads` is:
  // `backlog`, `git-status`, `machine-stats`, `usage-cost`, `session-files` and
  // `btw` all ride their whole answer back through the relay, and the phone's
  // `commands:watchMine` subscription re-fires on every status transition of
  // every row it watches. With the answers inline, one round trip re-shipped the
  // last ten boards/statuses/process lists on each re-fire.
  //
  // The phone reads a result exactly once, by subscribing to `commands:result`
  // for the single command it is waiting on (O(1) per transition), then calls
  // `commands:consumeResult` to drop the row. Anything not consumed — the app
  // was killed mid-request — is swept with its command by `maintenance:pruneSweep`.
  // Large ciphertexts occupy ordered pieces, each below the document limit.
  // chunkIndex reveals only order/size, never plaintext content. Older single
  // result rows have no index and remain readable as piece zero.
  commandResults: defineTable({
    commandId: v.id("commands"),
    resultCipher: v.string(),
    chunkIndex: v.optional(v.number()),
  }).index("by_command", ["commandId"]),

  // Ownership record for one blob in Convex file storage (a screenshot or
  // screen recording the desktop uploaded for a `media` command). The blob
  // itself is ciphertext — same E2E envelope as every other `*Cipher` field,
  // just too large to live inline — so `mimeType` here is the only plaintext
  // fact about it, kept for the phone's viewer to pick an `Image` vs a video
  // player before it has decrypted anything.
  //
  // This table is what makes `media:url` an AUTHENTICATED read: Convex's own
  // storage URLs are unguessable but not access-controlled, so anyone who
  // somehow obtained one could fetch the ciphertext (though not decrypt it
  // without the pairing key). Gating on "this mobile's paired device owns this
  // storageId" keeps the same trust boundary every other command has, and lets
  // `maintenance:pruneSweep` find rows to delete from actual storage.
  mediaBlobs: defineTable({
    deviceId: v.string(),
    storageId: v.id("_storage"),
    mimeType: v.string(),
    createdAt: v.number(),
  })
    .index("by_device", ["deviceId"])
    .index("by_storage", ["storageId"])
    .index("by_created", ["createdAt"]),

  // APNs registration tokens for paired iOS clients. Tokens are metadata;
  // notification bodies remain generic because relay payloads are E2E.
  pushTokens: defineTable({
    mobileId: v.string(),
    token: v.string(),
    platform: v.literal("ios"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_mobile", ["mobileId"])
    .index("by_mobile_token", ["mobileId", "token"]),

  // Dictation diagnostics. Deliberately carries NO transcript text: only event
  // names, the recogniser task generation, and character COUNTS. That keeps the
  // E2E rule above intact (the relay never sees user content) and is all a
  // state-machine bug needs — the question is when `committed` drops to zero,
  // not what it said. Self-pruning: `append` drops anything older than an hour.
  dictationTraces: defineTable({
    mobileId: v.string(),
    ts: v.number(),
    seq: v.number(),
    // Fixed vocabulary, e.g. "native.final", "dart.render", "native.rotate".
    event: v.string(),
    // Recogniser task generation, so overlapping tasks are visible.
    gen: v.optional(v.number()),
    baseLen: v.optional(v.number()),
    committedLen: v.optional(v.number()),
    partialLen: v.optional(v.number()),
    textLen: v.optional(v.number()),
    // Diagnostic codes only (error domain/code, flags) — never user content.
    note: v.optional(v.string()),
  }).index("by_mobile_ts", ["mobileId", "ts"]),

  // Performance diagnostics: dropped-frame (jank) samples and hand-picked
  // operation timings (decrypt batches, tile builds) from the mobile app.
  // Same shape/lifecycle as dictationTraces above and for the same reason —
  // "scrolling feels laggy" cannot be reproduced off-device, so this streams
  // real numbers instead. No transcript content, only durations/counts.
  perfTraces: defineTable({
    mobileId: v.string(),
    ts: v.number(),
    seq: v.number(),
    // Fixed vocabulary, e.g. "frame.jank", "decrypt.history", "decrypt.list",
    // "tile.build".
    event: v.string(),
    durationMs: v.optional(v.number()),
    // Route name (from the navigator observer) or a short screen tag, so a
    // jank sample can be attributed to what was on screen.
    route: v.optional(v.string()),
    // Item count for a batch operation (messages decrypted, rows listed).
    count: v.optional(v.number()),
    note: v.optional(v.string()),
  }).index("by_mobile_ts", ["mobileId", "ts"]),
});
