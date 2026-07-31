import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireDevice, requireMobile } from "./lib/auth";
import { deletePayload, readPayloadCipher } from "./lib/commandPayloads";
import {
  COMMAND_RATE_LIMIT_MAX,
  COMMAND_RATE_LIMIT_WINDOW_MS,
  COMMAND_WATCH_LIMIT,
  COMMAND_WATCH_WINDOW_MS,
  PENDING_COMMAND_TTL_MS,
} from "./lib/retention";

/** Mobile → desktop. Enqueue a control command (payload is E2E ciphertext). */
export const enqueue = mutation({
  args: {
    mobileId: v.string(),
    token: v.string(),
    sessionId: v.optional(v.string()),
    type: v.union(
      v.literal("start"),
      v.literal("input"),
      v.literal("stop"),
      v.literal("switch"),
      v.literal("approve"),
      v.literal("deny"),
      v.literal("btw"),
      v.literal("usage-cost"),
    ),
    payloadCipher: v.optional(v.string()),
  },
  handler: async (ctx, { mobileId, token, sessionId, type, payloadCipher }) => {
    const mobile = await requireMobile(ctx, mobileId, token);
    const now = Date.now();
    // Count only rows inside the window, via the (mobileId, createdAt) index.
    // Taking the last N rows regardless of age meant re-reading the last N
    // *documents* — attachments included — on every single send.
    const recentCommands = await ctx.db
      .query("commands")
      .withIndex("by_mobile_created", (q) =>
        q.eq("mobileId", mobileId).gt("createdAt", now - COMMAND_RATE_LIMIT_WINDOW_MS),
      )
      .take(COMMAND_RATE_LIMIT_MAX);
    if (recentCommands.length >= COMMAND_RATE_LIMIT_MAX) {
      throw new Error("COMMAND_RATE_LIMITED");
    }
    const commandId = await ctx.db.insert("commands", {
      deviceId: mobile.deviceId,
      mobileId,
      sessionId,
      type,
      status: "pending",
      createdAt: now,
    });
    // The payload (which may be a megabyte of base64 screenshot) goes to its own
    // table so the routing row stays tiny for `watchMine` and the rate-limit scan.
    if (payloadCipher !== undefined) {
      await ctx.db.insert("commandPayloads", { commandId, payloadCipher });
    }
    return commandId;
  },
});

/**
 * Desktop TAIL: subscribe to pending commands for this device. The desktop reacts
 * to new rows, claims them, executes via its local sessionService, then acks.
 *
 * This is the one reader that needs the payloads, and it re-fires only while
 * commands are actually in flight — so the join here is the cheap place to pay.
 */
export const pending = query({
  args: { deviceId: v.string(), token: v.string() },
  handler: async (ctx, { deviceId, token }) => {
    await requireDevice(ctx, deviceId, token);
    const minCreatedAt = Date.now() - PENDING_COMMAND_TTL_MS;
    const rows = await ctx.db
      .query("commands")
      .withIndex("by_device_status", (q) => q.eq("deviceId", deviceId).eq("status", "pending"))
      .filter((q) => q.gte(q.field("createdAt"), minCreatedAt))
      .take(50);
    return Promise.all(
      rows.map(async (row) => ({ ...row, payloadCipher: await readPayloadCipher(ctx, row) })),
    );
  },
});

/** Desktop claims a command so it isn't double-executed after a reconnect. */
export const claim = mutation({
  args: { deviceId: v.string(), token: v.string(), commandId: v.id("commands") },
  handler: async (ctx, { deviceId, token, commandId }) => {
    await requireDevice(ctx, deviceId, token);
    const cmd = await ctx.db.get(commandId);
    if (!cmd || cmd.deviceId !== deviceId) throw new Error("COMMAND_NOT_FOUND");
    if (cmd.status !== "pending") return { claimed: false };
    if (cmd.createdAt < Date.now() - PENDING_COMMAND_TTL_MS) {
      await ctx.db.patch(commandId, { status: "error", claimedAt: Date.now() });
      await deletePayload(ctx, commandId);
      return { claimed: false };
    }
    await ctx.db.patch(commandId, { status: "claimed", claimedAt: Date.now() });
    return { claimed: true };
  },
});

/** Desktop reports the result of a command (ciphertext), closing the loop. */
export const ack = mutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    commandId: v.id("commands"),
    status: v.union(v.literal("done"), v.literal("error")),
    resultCipher: v.optional(v.string()),
  },
  handler: async (ctx, { deviceId, token, commandId, status, resultCipher }) => {
    await requireDevice(ctx, deviceId, token);
    const cmd = await ctx.db.get(commandId);
    if (!cmd || cmd.deviceId !== deviceId) throw new Error("COMMAND_NOT_FOUND");
    await ctx.db.patch(commandId, { status, resultCipher });
    // The request has been executed; nothing will read the payload again. Freeing
    // it here is what keeps attachments from sitting in the table for a week
    // (`CLOSED_COMMAND_RETENTION_MS`) being re-read by the prune sweep.
    await deletePayload(ctx, commandId);
  },
});

/**
 * Mobile watches its own recent commands' status (pending → claimed → done/error).
 *
 * Deliberately projects the routing/outcome fields only, and never the request
 * payload: this query re-fires on every transition of every row it reads, so a
 * single attached screenshot would otherwise be re-shipped on each one.
 */
export const watchMine = query({
  args: { mobileId: v.string(), token: v.string() },
  handler: async (ctx, { mobileId, token }) => {
    await requireMobile(ctx, mobileId, token);
    const rows = await ctx.db
      .query("commands")
      .withIndex("by_mobile_created", (q) =>
        q.eq("mobileId", mobileId).gt("createdAt", Date.now() - COMMAND_WATCH_WINDOW_MS),
      )
      .order("desc")
      .take(COMMAND_WATCH_LIMIT);
    return rows.map((row) => ({
      _id: row._id,
      _creationTime: row._creationTime,
      sessionId: row.sessionId,
      type: row.type,
      status: row.status,
      resultCipher: row.resultCipher,
      createdAt: row.createdAt,
      claimedAt: row.claimedAt,
    }));
  },
});
