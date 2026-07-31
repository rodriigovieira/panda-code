import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  CLOSED_COMMAND_RETENTION_MS,
  COMMAND_PRUNE_BATCH,
  DEVICE_PRUNE_BATCH,
  EVENT_PRUNE_BATCH,
  EVENT_RETENTION_MS,
  OFFLINE_AFTER_MS,
  PAIRING_PRUNE_BATCH,
  PENDING_COMMAND_TTL_MS,
  WRITE_BUDGET_PRUNE_BATCH,
  WRITE_BUDGET_RETENTION_MS,
} from "./lib/retention";
import { demoteStrandedSessions } from "./lib/stranded";
import { deletePayload } from "./lib/commandPayloads";

/**
 * One-off admin remediation for a session wedged in a re-emit loop (mobile
 * "loads forever"). Marks the routing row terminal and enqueues a `stop` so the
 * running desktop drops it from its in-memory map and stops replaying it.
 * Invoke with `npx convex run maintenance:forceStopSession '{"deviceId":"…","sessionId":"…"}'`.
 */
export const forceStopSession = internalMutation({
  args: { deviceId: v.string(), sessionId: v.string() },
  handler: async (ctx, { deviceId, sessionId }) => {
    const now = Date.now();
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_device_session", (q) => q.eq("deviceId", deviceId).eq("sessionId", sessionId))
      .unique();
    if (session) {
      await ctx.db.patch(session._id, { status: "exited", agentState: "exited", updatedAt: now });
    }
    const runtime = await ctx.db
      .query("sessionRuntime")
      .withIndex("by_device_session", (q) => q.eq("deviceId", deviceId).eq("sessionId", sessionId))
      .unique();
    if (runtime?.runtimeCipher !== undefined) {
      await ctx.db.patch(runtime._id, { runtimeCipher: undefined });
    }
    const commandId = await ctx.db.insert("commands", {
      deviceId,
      mobileId: "admin-force-stop",
      sessionId,
      type: "stop",
      status: "pending",
      createdAt: now,
    });
    return { patched: Boolean(session), commandId };
  },
});

/**
 * One-shot backfill for the `sessionRuntime` split. For each `sessions` row that
 * still carries the legacy per-tick fields, seed/merge its `sessionRuntime` row
 * (head cursor + runtime badge) and strip `headSeq`/`runtimeCipher` off the
 * `sessions` row so `list` stops shipping the runtime blob. Idempotent and
 * paginated — re-invoke with the returned `cursor` until `isDone`:
 *   npx convex run maintenance:migrateSessionRuntime '{}'
 *   npx convex run maintenance:migrateSessionRuntime '{"cursor":"<continueCursor>"}'
 */
export const migrateSessionRuntime = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("sessions").paginate({ cursor: cursor ?? null, numItems: 100 });
    let migrated = 0;
    let skipped = 0;
    for (const s of page.page) {
      const legacyHead = s.headSeq;
      const legacyRuntime = s.runtimeCipher;
      if (legacyHead === undefined && legacyRuntime === undefined) continue;
      // Skip only actively-alive sessions (status "running"). A live desktop
      // writes their `sessionRuntime` row via upsertSession, so reading/writing
      // it here loses the optimistic-concurrency race on every retry; they also
      // already have an up-to-date runtime row, so they need no backfill. Idle/
      // exited sessions aren't written concurrently, so they migrate cleanly.
      if (s.status === "running") {
        skipped += 1;
        continue;
      }
      const rt = await ctx.db
        .query("sessionRuntime")
        .withIndex("by_device_session", (q) => q.eq("deviceId", s.deviceId).eq("sessionId", s.sessionId))
        .unique();
      if (!rt) {
        await ctx.db.insert("sessionRuntime", {
          deviceId: s.deviceId,
          sessionId: s.sessionId,
          headSeq: legacyHead ?? 0,
          ...(legacyRuntime !== undefined ? { runtimeCipher: legacyRuntime } : {}),
        });
      } else {
        // A newer append/upsert may already have written the runtime row; never
        // regress the head, and only fill a missing badge.
        const nextHead = Math.max(rt.headSeq, legacyHead ?? 0);
        const fillRuntime = rt.runtimeCipher === undefined && legacyRuntime !== undefined;
        if (nextHead !== rt.headSeq || fillRuntime) {
          await ctx.db.patch(rt._id, {
            headSeq: nextHead,
            ...(fillRuntime ? { runtimeCipher: legacyRuntime } : {}),
          });
        }
      }
      await ctx.db.patch(s._id, { headSeq: undefined, runtimeCipher: undefined });
      migrated += 1;
    }
    return { migrated, skipped, isDone: page.isDone, cursor: page.continueCursor };
  },
});

/** Read-only: (deviceId, sessionId) of every session still carrying legacy fields. */
export const listSessionsToMigrate = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db.query("sessions").collect();
    return sessions
      .filter((s) => s.headSeq !== undefined || s.runtimeCipher !== undefined)
      .map((s) => ({ deviceId: s.deviceId, sessionId: s.sessionId }));
  },
});

/**
 * Migrate a SINGLE session in its own mutation. Isolating one session per
 * transaction means a genuinely-live session (whose `sessionRuntime` row is
 * being written concurrently) only OCC-fails its own call — it can't poison a
 * whole batch. Idempotent: re-running on an already-migrated session is a no-op.
 */
export const migrateOneSession = internalMutation({
  args: { deviceId: v.string(), sessionId: v.string() },
  handler: async (ctx, { deviceId, sessionId }) => {
    const s = await ctx.db
      .query("sessions")
      .withIndex("by_device_session", (q) => q.eq("deviceId", deviceId).eq("sessionId", sessionId))
      .unique();
    if (!s) return { migrated: false };
    const legacyHead = s.headSeq;
    const legacyRuntime = s.runtimeCipher;
    if (legacyHead === undefined && legacyRuntime === undefined) return { migrated: false };

    const rt = await ctx.db
      .query("sessionRuntime")
      .withIndex("by_device_session", (q) => q.eq("deviceId", deviceId).eq("sessionId", sessionId))
      .unique();
    if (!rt) {
      await ctx.db.insert("sessionRuntime", {
        deviceId,
        sessionId,
        headSeq: legacyHead ?? 0,
        ...(legacyRuntime !== undefined ? { runtimeCipher: legacyRuntime } : {}),
      });
    } else {
      const nextHead = Math.max(rt.headSeq, legacyHead ?? 0);
      const fillRuntime = rt.runtimeCipher === undefined && legacyRuntime !== undefined;
      if (nextHead !== rt.headSeq || fillRuntime) {
        await ctx.db.patch(rt._id, {
          headSeq: nextHead,
          ...(fillRuntime ? { runtimeCipher: legacyRuntime } : {}),
        });
      }
    }
    await ctx.db.patch(s._id, { headSeq: undefined, runtimeCipher: undefined });
    return { migrated: true };
  },
});

/**
 * Backfill any sessions the paginated `migrateSessionRuntime` skips — chiefly
 * the stale-"running" sessions a live desktop never marked terminal. Migrates
 * each in its own mutation so the one truly-live session that OCC-fails is just
 * counted as `failed` (retry later) instead of blocking the rest. Invoke with:
 *   npx convex run maintenance:migrateRemainingSessions
 */
export const migrateRemainingSessions = internalAction({
  args: {},
  handler: async (ctx): Promise<{ migrated: number; failed: number; total: number }> => {
    const targets = await ctx.runQuery(internal.maintenance.listSessionsToMigrate, {});
    let migrated = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        const r = await ctx.runMutation(internal.maintenance.migrateOneSession, target);
        if (r.migrated) migrated += 1;
      } catch {
        failed += 1;
      }
    }
    return { migrated, failed, total: targets.length };
  },
});

/**
 * One-shot backfill for the `sessionStars` split. Copies each session row's
 * legacy `starred`/`starredAt` into `sessionStars` and strips them off the
 * session, so `sessions:starredForDevice` can stop scanning the session range.
 * Only rows that were actually starred get a star row — an unstarred session
 * needs none, which is the whole point of the split. Idempotent and paginated:
 *   npx convex run maintenance:migrateSessionStars '{}'
 *   npx convex run maintenance:migrateSessionStars '{"cursor":"<continueCursor>"}'
 */
export const migrateSessionStars = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("sessions").paginate({ cursor: cursor ?? null, numItems: 100 });
    let migrated = 0;
    let starsWritten = 0;
    for (const s of page.page) {
      if (s.starred === undefined && s.starredAt === undefined) continue;
      if (s.starred) {
        const existing = await ctx.db
          .query("sessionStars")
          .withIndex("by_device_session", (q) =>
            q.eq("deviceId", s.deviceId).eq("sessionId", s.sessionId),
          )
          .unique();
        if (!existing) {
          await ctx.db.insert("sessionStars", {
            deviceId: s.deviceId,
            sessionId: s.sessionId,
            starred: true,
            ...(s.starredAt !== undefined ? { starredAt: s.starredAt } : {}),
            updatedAt: s.updatedAt,
          });
          starsWritten += 1;
        }
      }
      await ctx.db.patch(s._id, { starred: undefined, starredAt: undefined });
      migrated += 1;
    }
    return { migrated, starsWritten, isDone: page.isDone, cursor: page.continueCursor };
  },
});

/**
 * One-shot backfill for the `deviceUsage` split: move the plan-usage blob off the
 * device row, which sits on the auth path of every relay call. Idempotent; the
 * device set is tiny, so this needs no pagination.
 *   npx convex run maintenance:migrateDeviceUsage
 */
export const migrateDeviceUsage = internalMutation({
  args: {},
  handler: async (ctx) => {
    const devices = await ctx.db.query("devices").collect();
    let migrated = 0;
    for (const device of devices) {
      if (device.usageCipher === undefined) continue;
      const existing = await ctx.db
        .query("deviceUsage")
        .withIndex("by_device", (q) => q.eq("deviceId", device.deviceId))
        .unique();
      if (!existing) {
        await ctx.db.insert("deviceUsage", {
          deviceId: device.deviceId,
          usageCipher: device.usageCipher,
          updatedAt: device.lastHeartbeatAt,
        });
      }
      await ctx.db.patch(device._id, { usageCipher: undefined });
      migrated += 1;
    }
    return { migrated, devices: devices.length };
  },
});

/** Bounded cleanup work invoked by the relay pruning cron. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const expiredPairings = await ctx.db
      .query("pairings")
      .withIndex("by_status_expires", (query) =>
        query.eq("status", "pending").lte("expiresAt", now),
      )
      .take(PAIRING_PRUNE_BATCH);
    for (const pairing of expiredPairings) {
      await ctx.db.patch(pairing._id, { status: "expired" });
    }

    const staleDevices = await ctx.db
      .query("devices")
      .withIndex("by_status_heartbeat", (query) =>
        query.eq("status", "online").lt("lastHeartbeatAt", now - OFFLINE_AFTER_MS),
      )
      .take(DEVICE_PRUNE_BATCH);
    // A desktop whose heartbeat stopped cannot still be mid-turn. Demote its
    // in-flight sessions with it, so the phone stops spinning on work that died
    // with the app (see `lib/stranded.ts`).
    let demotedSessions = 0;
    for (const device of staleDevices) {
      await ctx.db.patch(device._id, { status: "offline" });
      demotedSessions += await demoteStrandedSessions(ctx, device.deviceId);
    }

    const oldEvents = await ctx.db
      .query("events")
      .withIndex("by_created", (query) =>
        query.lt("createdAt", now - EVENT_RETENTION_MS),
      )
      .take(EVENT_PRUNE_BATCH);
    for (const event of oldEvents) {
      await ctx.db.delete(event._id);
    }

    const oldDoneCommands = await ctx.db
      .query("commands")
      .withIndex("by_status_created", (query) =>
        query
          .eq("status", "done")
          .lt("createdAt", now - CLOSED_COMMAND_RETENTION_MS),
      )
      .take(COMMAND_PRUNE_BATCH);
    const oldErrorCommands = await ctx.db
      .query("commands")
      .withIndex("by_status_created", (query) =>
        query
          .eq("status", "error")
          .lt("createdAt", now - CLOSED_COMMAND_RETENTION_MS),
      )
      .take(COMMAND_PRUNE_BATCH);
    for (const command of [...oldDoneCommands, ...oldErrorCommands]) {
      // `ack` already frees the payload of anything the desktop executed; this
      // catches the rest (never-claimed requests, revoked phones' leftovers) so a
      // stale screenshot can't outlive its command row.
      await deletePayload(ctx, command._id);
      await ctx.db.delete(command._id);
    }

    const stalePendingCommands = await ctx.db
      .query("commands")
      .withIndex("by_status_created", (query) =>
        query
          .eq("status", "pending")
          .lt("createdAt", now - PENDING_COMMAND_TTL_MS),
      )
      .take(COMMAND_PRUNE_BATCH);
    const staleClaimedCommands = await ctx.db
      .query("commands")
      .withIndex("by_status_created", (query) =>
        query
          .eq("status", "claimed")
          .lt("createdAt", now - PENDING_COMMAND_TTL_MS),
      )
      .take(COMMAND_PRUNE_BATCH);
    for (const command of [...stalePendingCommands, ...staleClaimedCommands]) {
      await ctx.db.patch(command._id, { status: "error" });
      await deletePayload(ctx, command._id);
    }

    // Write-budget rows outlive their window by design (they are only reset on
    // the next append). Once a row is far past its window it can no longer
    // affect a decision, so drop it — otherwise a burst of throwaway device
    // registrations leaves a permanent row each. Deleting an active device's row
    // is harmless: the next append recreates it with a fresh window.
    const staleBudgets = await ctx.db
      .query("deviceWriteBudget")
      .withIndex("by_device")
      .take(WRITE_BUDGET_PRUNE_BATCH);
    let deletedBudgets = 0;
    for (const budget of staleBudgets) {
      if (now - budget.windowStartedAt < WRITE_BUDGET_RETENTION_MS) continue;
      await ctx.db.delete(budget._id);
      deletedBudgets += 1;
    }

    return {
      expiredPairings: expiredPairings.length,
      offlineDevices: staleDevices.length,
      demotedSessions,
      deletedEvents: oldEvents.length,
      deletedCommands: oldDoneCommands.length + oldErrorCommands.length,
      expiredCommands: stalePendingCommands.length + staleClaimedCommands.length,
      deletedBudgets,
    };
  },
});
