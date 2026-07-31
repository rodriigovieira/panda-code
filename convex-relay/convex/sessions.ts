import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireDevice, requireMobile } from "./lib/auth";
import { demoteStrandedSessions } from "./lib/stranded";
import {
  EVENT_RATE_LIMIT_MAX_BYTES,
  EVENT_RATE_LIMIT_MAX_EVENTS,
  EVENT_RATE_LIMIT_WINDOW_MS,
  MAX_EVENTS_PER_APPEND,
  MAX_EVENT_PAYLOAD_BYTES,
} from "./lib/retention";

function isTerminalStatus(status: "idle" | "running" | "exited" | "error"): boolean {
  return status === "exited" || status === "error";
}

/**
 * Byte length of a ciphertext payload. `payloadCipher` is base64-ish ASCII, so
 * `.length` is the byte count; counting code units avoids allocating an encoder
 * per event on the hot path. A multi-byte character would undercount, which is
 * acceptable for a ceiling that sits an order of magnitude above real traffic.
 */
function payloadBytes(payloadCipher: string): number {
  return payloadCipher.length;
}

/**
 * Write the shared pin/star state for one session into `sessionStars`.
 *
 * Never touches the `sessions` row: a star flip must not invalidate anything that
 * reads the (much fatter) session documents, and the desktop's permanent
 * `starredForDevice` subscription reads this table alone.
 */
async function writeStar(
  ctx: MutationCtx,
  deviceId: string,
  sessionId: string,
  starred: boolean,
): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("sessionStars")
    .withIndex("by_device_session", (q) => q.eq("deviceId", deviceId).eq("sessionId", sessionId))
    .unique();
  if (!existing) {
    await ctx.db.insert("sessionStars", {
      deviceId,
      sessionId,
      starred,
      ...(starred ? { starredAt: now } : {}),
      updatedAt: now,
    });
    return;
  }
  if (existing.starred === starred) return;
  await ctx.db.patch(existing._id, {
    starred,
    starredAt: starred ? now : undefined,
    updatedAt: now,
  });
}

/** Per-tick runtime badge write, shared by `upsertSession` and `putRuntime`. */
async function writeRuntime(
  ctx: MutationCtx,
  deviceId: string,
  sessionId: string,
  runtimeCipher: string,
): Promise<void> {
  const rt = await ctx.db
    .query("sessionRuntime")
    .withIndex("by_device_session", (q) => q.eq("deviceId", deviceId).eq("sessionId", sessionId))
    .unique();
  if (rt) {
    await ctx.db.patch(rt._id, { runtimeCipher });
  } else {
    await ctx.db.insert("sessionRuntime", { deviceId, sessionId, headSeq: 0, runtimeCipher });
  }
}

/**
 * Desktop upserts a session's routing/status row. Low frequency: called on
 * lifecycle transitions (created, status change, title resolved), NOT per token.
 * Content (title, cwd, runtime badge) is ciphertext.
 */
export const upsertSession = mutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    titleCipher: v.optional(v.string()),
    cwdCipher: v.optional(v.string()),
    status: v.union(v.literal("idle"), v.literal("running"), v.literal("exited"), v.literal("error")),
    agentState: v.union(v.literal("working"), v.literal("waiting"), v.literal("needs_action"), v.literal("exited")),
    executionMode: v.union(v.literal("terminal"), v.literal("stream-json")),
    claudeSessionId: v.optional(v.string()),
    runtimeCipher: v.optional(v.string()),
    startedByMobileId: v.optional(v.string()),
    notifyOnExit: v.optional(v.boolean()),
    starred: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireDevice(ctx, args.deviceId, args.token);
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_device_session", (q) => q.eq("deviceId", args.deviceId).eq("sessionId", args.sessionId))
      .unique();
    const now = Date.now();
    // The LOW-CHURN routing/status state that lives on the `sessions` row (what
    // `sessions.list` reads). Sticky: an omitted arg keeps the existing value so
    // a partial upsert never clears a resolved title/cwd/claudeSessionId.
    const nextSlow = {
      titleCipher: args.titleCipher ?? existing?.titleCipher,
      cwdCipher: args.cwdCipher ?? existing?.cwdCipher,
      status: args.status,
      agentState: args.agentState,
      executionMode: args.executionMode,
      claudeSessionId: args.claudeSessionId ?? existing?.claudeSessionId,
      startedByMobileId: args.startedByMobileId ?? existing?.startedByMobileId,
      notifyOnExit: args.notifyOnExit ?? existing?.notifyOnExit,
    };
    const enteredTerminal =
      isTerminalStatus(args.status) &&
      !isTerminalStatus(existing?.status ?? "idle") &&
      existing?.notifiedExitAt === undefined;
    // A fresh entry into needs_action (fired once per transition).
    const enteredNeedsApproval =
      args.agentState === "needs_action" &&
      existing?.agentState !== "needs_action";
    // The agent finished a turn (working -> waiting). In normal use the Claude
    // process stays alive between turns, so `status` never goes terminal here —
    // this transition is the real "done" signal, mirroring how the desktop
    // detects a finished turn. Fires once per working->waiting transition.
    const finishedTurn =
      args.agentState === "waiting" && existing?.agentState === "working";

    // Which notification (if any) this upsert triggers. Preference gating +
    // muting happen inside the action; here we only detect transitions.
    let notifyKind: "done" | "needs_approval" | "error" | null = null;
    if (enteredTerminal) {
      notifyKind = args.status === "error" ? "error" : "done";
    } else if (enteredNeedsApproval) {
      notifyKind = "needs_approval";
    } else if (finishedTurn) {
      notifyKind = "done";
    }

    // Resolve the set of phones subscribed to this session. Default subscription
    // is `mobileId == startedByMobileId`; the sessionSubs table stores only
    // deviations (a phone explicitly (un)subscribing). Union the auto-subscribed
    // starter (unless it opted out) with any phone that opted in.
    const targets = new Set<string>();
    if (notifyKind) {
      const overrides = await ctx.db
        .query("sessionSubs")
        .withIndex("by_device_session", (q) =>
          q.eq("deviceId", args.deviceId).eq("sessionId", args.sessionId),
        )
        .collect();
      const override = new Map(overrides.map((o) => [o.mobileId, o.subscribed]));
      if (nextSlow.startedByMobileId && override.get(nextSlow.startedByMobileId) !== false) {
        targets.add(nextSlow.startedByMobileId);
      }
      for (const [mobileId, on] of override) {
        if (on) targets.add(mobileId);
      }
    }
    const markExit = enteredTerminal && targets.size > 0;
    const nextNotifiedExitAt = markExit ? now : existing?.notifiedExitAt;

    if (!existing) {
      await ctx.db.insert("sessions", {
        deviceId: args.deviceId,
        sessionId: args.sessionId,
        ...nextSlow,
        ...(nextNotifiedExitAt !== undefined ? { notifiedExitAt: nextNotifiedExitAt } : {}),
        updatedAt: now,
      });
    } else {
      // Only write the `sessions` row when a low-churn field actually changed.
      // This is what stops `sessions.list` from re-firing on the per-tick upserts
      // (same status/agentState, fresh runtimeCipher) that stream during a turn —
      // the runtime badge write below is what carries those, off the list's path.
      const changed =
        existing.titleCipher !== nextSlow.titleCipher ||
        existing.cwdCipher !== nextSlow.cwdCipher ||
        existing.status !== nextSlow.status ||
        existing.agentState !== nextSlow.agentState ||
        existing.executionMode !== nextSlow.executionMode ||
        existing.claudeSessionId !== nextSlow.claudeSessionId ||
        existing.startedByMobileId !== nextSlow.startedByMobileId ||
        existing.notifyOnExit !== nextSlow.notifyOnExit ||
        existing.notifiedExitAt !== nextNotifiedExitAt;
      if (changed) {
        await ctx.db.patch(existing._id, {
          ...nextSlow,
          ...(nextNotifiedExitAt !== undefined ? { notifiedExitAt: nextNotifiedExitAt } : {}),
          updatedAt: now,
        });
      }
    }

    // Star state lives in `sessionStars` (see `writeStar`). Still accepted here so
    // the desktop can seed a locally-pinned thread in the same call that
    // registers it.
    if (args.starred !== undefined) {
      await writeStar(ctx, args.deviceId, args.sessionId, args.starred);
    }

    // Per-tick runtime badge lives in `sessionRuntime`, NOT on the `sessions` row
    // that `list` reads. Writing it here never invalidates the list subscription.
    // The steady-state path for this is `putRuntime` — reaching it through a full
    // upsert costs a `sessions` read the badge doesn't need.
    if (args.runtimeCipher !== undefined) {
      await writeRuntime(ctx, args.deviceId, args.sessionId, args.runtimeCipher);
    }

    if (notifyKind) {
      for (const mobileId of targets) {
        await ctx.scheduler.runAfter(
          0,
          internal.notifications.sendSessionNotification,
          { mobileId, sessionId: args.sessionId, kind: notifyKind },
        );
      }
    }
  },
});

/**
 * Desktop: the per-tick runtime badge, on its own. THE steady-state metadata
 * write during a turn (roughly once a second per streaming session).
 *
 * Split out of `upsertSession` because that mutation reads the `sessions` row (and
 * its `sessionSubs`) to diff lifecycle fields and detect notification
 * transitions — work a badge refresh has no use for, charged once a second per
 * session. This touches exactly one small `sessionRuntime` document. The desktop
 * calls `upsertSession` only when a low-churn field actually changed.
 */
export const putRuntime = mutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    runtimeCipher: v.string(),
  },
  handler: async (ctx, { deviceId, token, sessionId, runtimeCipher }) => {
    await requireDevice(ctx, deviceId, token);
    await writeRuntime(ctx, deviceId, sessionId, runtimeCipher);
    return null;
  },
});

/**
 * Called by the desktop right after it registers, with the sessions that are
 * genuinely live in the freshly started app. Everything else this device owns
 * that still reads as mid-turn was stranded by the previous run (force-quit,
 * crash, reboot) and is demoted to idle/waiting — otherwise the phone spins on
 * it forever, because the relaunched desktop reloads those threads as idle and
 * so has no transition to report. Complements the prune cron's heartbeat-based
 * sweep, which cannot help once the device is back online.
 */
export const reconcileDevice = mutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    activeSessionIds: v.array(v.string()),
  },
  handler: async (ctx, { deviceId, token, activeSessionIds }) => {
    await requireDevice(ctx, deviceId, token);
    const demoted = await demoteStrandedSessions(ctx, deviceId, activeSessionIds);
    return { demoted };
  },
});

/**
 * Desktop appends a batch of conversation/runtime deltas. THE hot path.
 * Coalesce on the desktop to ~1/sec (or per-transition) before calling — do not
 * call this per token. Bumps `headSeq` so the mobile tail query re-fires once.
 */
export const appendEvents = mutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    events: v.array(
      v.object({
        kind: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"), v.literal("system"), v.literal("marker")),
        payloadCipher: v.string(),
      }),
    ),
  },
  handler: async (ctx, { deviceId, token, sessionId, events }) => {
    // Per-call caps first: reject a hostile payload before it costs a read.
    if (events.length > MAX_EVENTS_PER_APPEND) {
      throw new Error("EVENT_BATCH_TOO_LARGE");
    }
    let batchBytes = 0;
    for (const event of events) {
      const bytes = payloadBytes(event.payloadCipher);
      if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
        throw new Error("EVENT_PAYLOAD_TOO_LARGE");
      }
      batchBytes += bytes;
    }

    await requireDevice(ctx, deviceId, token);

    // Per-device write budget. `appendEvents` is the relay's only unmetered
    // write path, and `registerDevice` is open by design, so without this a
    // self-registered device is an unbounded blob store. Enforced per DEVICE,
    // not per session — per-session would be trivially bypassed by creating
    // more sessions with the same token.
    const now = Date.now();
    const budget = await ctx.db
      .query("deviceWriteBudget")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    const carried =
      budget && now - budget.windowStartedAt < EVENT_RATE_LIMIT_WINDOW_MS ? budget : null;
    const windowStartedAt = carried ? carried.windowStartedAt : now;
    const usedEvents = carried ? carried.events : 0;
    const usedBytes = carried ? carried.bytes : 0;
    if (
      usedEvents + events.length > EVENT_RATE_LIMIT_MAX_EVENTS ||
      usedBytes + batchBytes > EVENT_RATE_LIMIT_MAX_BYTES
    ) {
      throw new Error("EVENT_RATE_LIMITED");
    }

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_device_session", (q) => q.eq("deviceId", deviceId).eq("sessionId", sessionId))
      .unique();
    if (!session) throw new Error("SESSION_NOT_FOUND");

    // Charged only once the write is certain to happen: a rejected append (bad
    // session, over budget) must not consume the caller's allowance, or a
    // misconfigured client could lock a legitimate device out of its own budget.
    const budgetPatch = {
      windowStartedAt,
      events: usedEvents + events.length,
      bytes: usedBytes + batchBytes,
    };
    if (budget) {
      await ctx.db.patch(budget._id, budgetPatch);
    } else {
      await ctx.db.insert("deviceWriteBudget", { deviceId, ...budgetPatch });
    }

    // The head cursor lives in `sessionRuntime` so this hot-path write never
    // touches the `sessions` row that `list` reads. The row may not exist yet
    // (append can beat the first runtime upsert); default the head to 0.
    const runtime = await ctx.db
      .query("sessionRuntime")
      .withIndex("by_device_session", (q) => q.eq("deviceId", deviceId).eq("sessionId", sessionId))
      .unique();
    let seq = runtime?.headSeq ?? 0;
    for (const e of events) {
      seq += 1;
      await ctx.db.insert("events", { deviceId, sessionId, seq, kind: e.kind, payloadCipher: e.payloadCipher, createdAt: now });
    }
    if (runtime) {
      await ctx.db.patch(runtime._id, { headSeq: seq });
    } else {
      await ctx.db.insert("sessionRuntime", { deviceId, sessionId, headSeq: seq });
    }
    // A `user`-kind event is a real prompt (the desktop only emits it for user
    // message text, not tool results). Bumping `lastPromptAt`/`updatedAt` is the
    // ONE case where the streaming path touches `sessions` — and it's rare (once
    // per user turn), so it's a legitimate list re-fire: it gives the mobile list
    // a stable sort key that ignores the assistant/tool event storm.
    const hasUserPrompt = events.some((e) => e.kind === "user");
    if (hasUserPrompt) {
      await ctx.db.patch(session._id, { lastPromptAt: now, updatedAt: now });
    }
    return { headSeq: seq };
  },
});

/** Mobile: list sessions for its paired desktop (routing + coarse status only). */
export const list = query({
  args: { mobileId: v.string(), token: v.string() },
  handler: async (ctx, { mobileId, token }) => {
    const mobile = await requireMobile(ctx, mobileId, token);
    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_device", (q) => q.eq("deviceId", mobile.deviceId))
      .order("desc")
      .take(100);
    // Annotate each row with THIS phone's effective notification subscription:
    // its explicit override if any, else the default (subscribed to sessions it
    // started). Overrides are keyed by (deviceId, sessionId); fetch this phone's
    // once and join in memory.
    const overrides = await ctx.db
      .query("sessionSubs")
      .withIndex("by_mobile", (q) => q.eq("mobileId", mobileId))
      .collect();
    const override = new Map(overrides.map((o) => [o.sessionId, o.subscribed]));
    // Stars live in their own table now; join this device's (small) star rows in
    // memory so the list keeps its single-shape contract for the phone.
    const starRows = await ctx.db
      .query("sessionStars")
      .withIndex("by_device", (q) => q.eq("deviceId", mobile.deviceId))
      .collect();
    const stars = new Map(starRows.map((s) => [s.sessionId, s]));
    // Project to the low-churn routing/status shape ONLY. Deliberately excludes
    // `runtimeCipher` and `headSeq` (now in `sessionRuntime`): the mobile list
    // renders coarse status from `agentState`, and the open session view pulls
    // the live runtime badge from `sessions:runtime`. Returning the runtime blob
    // here is what made this query the relay's biggest cost — re-shipping ~100
    // rows on every streamed token. Keep this lean.
    return rows.map((row) => ({
      _id: row._id,
      _creationTime: row._creationTime,
      sessionId: row.sessionId,
      titleCipher: row.titleCipher,
      cwdCipher: row.cwdCipher,
      status: row.status,
      agentState: row.agentState,
      executionMode: row.executionMode,
      updatedAt: row.updatedAt,
      lastPromptAt: row.lastPromptAt,
      startedByMobileId: row.startedByMobileId,
      notifyOnExit: row.notifyOnExit,
      // `sessionStars` when present, else the pre-split field still on the row.
      starred: stars.get(row.sessionId)?.starred ?? row.starred ?? false,
      starredAt: stars.get(row.sessionId)?.starredAt ?? row.starredAt,
      // Back-compat stub for already-installed mobile builds that parse
      // `(row['headSeq'] as num)` off the list shape and would crash on null.
      // New builds ignore this and read the head from `sessions:runtime`.
      headSeq: 0,
      subscribed: override.get(row.sessionId) ?? row.startedByMobileId === mobileId,
    }));
  },
});

export const setStarredByMobile = mutation({
  args: {
    mobileId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    starred: v.boolean(),
  },
  handler: async (ctx, { mobileId, token, sessionId, starred }) => {
    const mobile = await requireMobile(ctx, mobileId, token);
    // The session must exist (a phone can only pin what it can see), but the star
    // itself is written to `sessionStars`, leaving the session document untouched.
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_device_session", (q) => q.eq("deviceId", mobile.deviceId).eq("sessionId", sessionId))
      .unique();
    if (!session) throw new Error("SESSION_NOT_FOUND");
    await writeStar(ctx, mobile.deviceId, sessionId, starred);
    return null;
  },
});

export const setStarredByDevice = mutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    starred: v.boolean(),
  },
  handler: async (ctx, { deviceId, token, sessionId, starred }) => {
    await requireDevice(ctx, deviceId, token);
    // Unlike the mobile path this does NOT require a routing row: the desktop can
    // pin a thread it has never streamed to the relay (see `setTitleByDevice`),
    // and the star row is what carries that intent when the session shows up.
    await writeStar(ctx, deviceId, sessionId, starred);
    return null;
  },
});

/**
 * Desktop renames a section. Title only, and deliberately NOT an upsert:
 *
 *  - a rename must not create a row — renaming a long-dormant section would
 *    otherwise surface it on the phone as if it had just started;
 *  - it must not carry status/agentState, which the desktop only knows for the
 *    sections it currently runs.
 *
 * Same shape as `setStarredByDevice` and for the same reasons.
 */
export const setTitleByDevice = mutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    titleCipher: v.string(),
  },
  handler: async (ctx, { deviceId, token, sessionId, titleCipher }) => {
    await requireDevice(ctx, deviceId, token);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_device_session", (q) => q.eq("deviceId", deviceId).eq("sessionId", sessionId))
      .unique();
    if (!session || session.titleCipher === titleCipher) return null;
    await ctx.db.patch(session._id, { titleCipher, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Desktop: the phone's pin/unpin actions, mirrored back so the two lists agree.
 *
 * The desktop holds this open for its whole run, so its READ SET is the thing
 * that matters. Reading `sessionStars` — a table written only when the user pins
 * something — means it re-fires on a pin and nothing else. It used to scan the
 * `sessions` range instead, which made every status transition, rename and
 * prompt on the device re-read ~100 full session documents to answer a question
 * about stars: on its own, the largest single consumer of relay bandwidth.
 */
export const starredForDevice = query({
  args: { deviceId: v.string(), token: v.string() },
  handler: async (ctx, { deviceId, token }) => {
    await requireDevice(ctx, deviceId, token);
    const rows = await ctx.db
      .query("sessionStars")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .take(200);
    return rows.map((row) => ({
      sessionId: row.sessionId,
      starred: row.starred,
      starredAt: row.starredAt,
      updatedAt: row.updatedAt,
    }));
  },
});

/**
 * Mobile: live runtime badge for a SINGLE open session (working/waiting, latest
 * tool/command, token usage, pending approval). Reads one `sessionRuntime` row,
 * so it re-fires O(1) per streamed tick — only for the session currently on
 * screen — instead of re-shipping the whole list. The session VIEW subscribes to
 * this; the LIST does not (it shows coarse `agentState` from the `sessions` row).
 */
export const runtime = query({
  args: { mobileId: v.string(), token: v.string(), sessionId: v.string() },
  handler: async (ctx, { mobileId, token, sessionId }) => {
    const mobile = await requireMobile(ctx, mobileId, token);
    const rt = await ctx.db
      .query("sessionRuntime")
      .withIndex("by_device_session", (q) => q.eq("deviceId", mobile.deviceId).eq("sessionId", sessionId))
      .unique();
    if (!rt) return { headSeq: 0, runtimeCipher: null as string | null };
    return { headSeq: rt.headSeq, runtimeCipher: rt.runtimeCipher ?? null };
  },
});

/**
 * Mobile: the TAIL subscription. Reads only events after the phone's cursor,
 * capped, so the reactive result set stays small and cheap to re-execute.
 * History backfill uses a separate paginated one-shot (add later).
 */
export const tail = query({
  args: { mobileId: v.string(), token: v.string(), sessionId: v.string(), afterSeq: v.number() },
  handler: async (ctx, { mobileId, token, sessionId, afterSeq }) => {
    const mobile = await requireMobile(ctx, mobileId, token);
    // A freshly created session may not have a routing row yet: the mobile
    // generated the id and opened the transcript before the desktop upserted it.
    // Treat that as "no events yet" so the reactive tail recovers on its own once
    // the desktop registers the session and appends.
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_device_session", (q) => q.eq("deviceId", mobile.deviceId).eq("sessionId", sessionId))
      .unique();
    if (!session) return [];

    return ctx.db
      .query("events")
      .withIndex("by_device_session_seq", (q) =>
        q.eq("deviceId", mobile.deviceId).eq("sessionId", sessionId).gt("seq", afterSeq),
      )
      .take(200);
  },
});

/**
 * Mobile: one-shot history backfill, newest page first.
 *
 * `beforeSeq` is exclusive. Omit it for the newest retained page, then pass the
 * returned `nextBeforeSeq` to walk backward. Events within each page are returned
 * in ascending sequence order so callers can prepend the page directly.
 */
export const history = query({
  args: {
    mobileId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    beforeSeq: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { mobileId, token, sessionId, beforeSeq, limit }) => {
    const mobile = await requireMobile(ctx, mobileId, token);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_device_session", (q) => q.eq("deviceId", mobile.deviceId).eq("sessionId", sessionId))
      .unique();
    // Not-yet-registered session (see `tail`): no history to backfill. Return an
    // empty, finished page so the one-shot loader shows an empty transcript
    // instead of a fatal error while the desktop is still starting up.
    if (!session) return { events: [], nextBeforeSeq: null, isDone: true };

    const pageSize = limit ?? 100;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new Error("INVALID_HISTORY_LIMIT");
    }

    // The head cursor now lives in `sessionRuntime`. Fall back to `headSeq + 1`
    // as the default (newest-page) upper bound; if the runtime row isn't present
    // yet, `Infinity` still selects the newest retained events in descending order.
    let headSeq = 0;
    if (beforeSeq === undefined) {
      const rt = await ctx.db
        .query("sessionRuntime")
        .withIndex("by_device_session", (q) => q.eq("deviceId", mobile.deviceId).eq("sessionId", sessionId))
        .unique();
      headSeq = rt?.headSeq ?? 0;
    }
    const exclusiveUpperBound = beforeSeq ?? headSeq + 1;
    const candidates = await ctx.db
      .query("events")
      .withIndex("by_device_session_seq", (q) =>
        q
          .eq("deviceId", mobile.deviceId)
          .eq("sessionId", sessionId)
          .lt("seq", exclusiveUpperBound),
      )
      .order("desc")
      .take(pageSize + 1);

    const hasMore = candidates.length > pageSize;
    const pageDescending = hasMore ? candidates.slice(0, pageSize) : candidates;
    const oldest = pageDescending.at(-1);

    return {
      events: pageDescending.reverse(),
      nextBeforeSeq: hasMore && oldest ? oldest.seq : null,
      isDone: !hasMore,
    };
  },
});
