import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireDevice, requireMobile } from "./lib/auth";
import { OFFLINE_AFTER_MS } from "./lib/retention";

/**
 * Desktop heartbeat. Called every ~10-15s while the app is alive. One tiny doc
 * write — negligible cost. Doubles as the presence signal the phone reads.
 *
 * The usage snapshot rides along but lands in `deviceUsage`, not on the device
 * row: the device row is read by `requireDevice` on every relay call, so keeping
 * a multi-KB blob there (and rewriting it on every heartbeat) taxed the entire
 * protocol. The desktop only sends it when the underlying numbers changed.
 */
export const heartbeat = mutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    appVersion: v.optional(v.string()),
    // Encrypted plan-usage snapshot, refreshed on a slow timer desktop-side.
    usageCipher: v.optional(v.string()),
  },
  handler: async (ctx, { deviceId, token, appVersion, usageCipher }) => {
    const device = await requireDevice(ctx, deviceId, token);
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "online",
      lastHeartbeatAt: now,
      ...(appVersion ? { appVersion } : {}),
    });
    if (usageCipher) {
      const existing = await ctx.db
        .query("deviceUsage")
        .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { usageCipher, updatedAt: now });
      } else {
        await ctx.db.insert("deviceUsage", { deviceId, usageCipher, updatedAt: now });
      }
    }
  },
});

/** Mobile reads its paired desktop's presence to enable/disable actions. */
export const status = query({
  args: { mobileId: v.string(), token: v.string() },
  handler: async (ctx, { mobileId, token }) => {
    const mobile = await requireMobile(ctx, mobileId, token);
    const device = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", mobile.deviceId))
      .unique();
    if (!device) return { online: false as const };
    const online = device.status === "online" && Date.now() - device.lastHeartbeatAt < OFFLINE_AFTER_MS;
    // This is the only reader of `deviceUsage` — the phone renders it. Falls back
    // to the pre-split field for a device that hasn't heartbeated since upgrading.
    const usage = await ctx.db
      .query("deviceUsage")
      .withIndex("by_device", (q) => q.eq("deviceId", mobile.deviceId))
      .unique();
    return {
      online,
      name: device.name,
      appVersion: device.appVersion,
      lastHeartbeatAt: device.lastHeartbeatAt,
      usageCipher: usage?.usageCipher ?? device.usageCipher,
    };
  },
});
