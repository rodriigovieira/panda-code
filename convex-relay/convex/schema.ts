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
  // A desktop executor. One row per Mac running Panda Code.
  devices: defineTable({
    deviceId: v.string(), // stable, desktop-generated (stored in Keychain)
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
  sessionStars: defineTable({
    deviceId: v.string(),
    sessionId: v.string(),
    starred: v.boolean(),
    starredAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_device", ["deviceId"])
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
      v.literal("stop"),
      v.literal("switch"), // change model/effort/permission mid-session (payload = LaunchOverride)
      v.literal("approve"), // answer a tool-permission prompt
      v.literal("deny"),
      v.literal("btw"), // side question about a session; answer rides back in resultCipher
      // Token→dollar report from the desktop's usage ledger. Scoped to one
      // session or to a date range; the report rides back in resultCipher.
      v.literal("usage-cost"),
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
    resultCipher: v.optional(v.string()),
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
});
