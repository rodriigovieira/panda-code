import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { hashToken, requireDevice, verifyToken } from "./lib/auth";
import { deletePayload } from "./lib/commandPayloads";

const PAIRING_TTL_MS = 5 * 60_000;

/**
 * PAIRING FLOW (see docs/protocol.md for the full envelope):
 *
 *  1. Desktop registers itself (once) → gets a deviceId + device token.
 *  2. Desktop calls `createCode` → shows a QR. The QR ALSO carries the E2E
 *     symmetric key, which is exchanged OUT-OF-BAND and never sent here.
 *  3. Phone scans, calls `claimCode` → gets a mobileId + mobile token, and reads
 *     the E2E key straight off the QR. From now on all payloads are ciphertext.
 *
 * These handlers deliberately do NOT touch the E2E key. The relay stays blind.
 */

/** Desktop self-registers. Returns the raw token ONCE (store it in Keychain). */
export const registerDevice = mutation({
  args: { deviceId: v.string(), name: v.string(), platform: v.string(), token: v.string() },
  handler: async (ctx, { deviceId, name, platform, token }) => {
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (existing) {
      if (!(await verifyToken(token, existing.tokenHash))) {
        throw new Error("DEVICE_AUTH_FAILED");
      }
      await ctx.db.patch(existing._id, {
        name,
        platform,
        // Re-salt current records and opportunistically upgrade legacy SHA-256 rows.
        tokenHash: await hashToken(token),
      });
    } else {
      const tokenHash = await hashToken(token);
      await ctx.db.insert("devices", {
        deviceId,
        name,
        platform,
        status: "offline",
        lastHeartbeatAt: 0,
        tokenHash,
      });
    }
    return { deviceId };
  },
});

/** Desktop creates a single-use pairing code (rendered into the QR). */
export const createCode = mutation({
  args: { deviceId: v.string(), token: v.string(), code: v.string() },
  handler: async (ctx, { deviceId, token, code }) => {
    await requireDevice(ctx, deviceId, token);
    const now = Date.now();
    return ctx.db.insert("pairings", {
      code,
      deviceId,
      status: "pending",
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
    });
  },
});

/** Phone claims a pairing code → becomes a paired mobile client. */
export const claimCode = mutation({
  args: { code: v.string(), mobileId: v.string(), token: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, { code, mobileId, token, name }) => {
    const pairing = await ctx.db
      .query("pairings")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!pairing) throw new Error("PAIRING_NOT_FOUND");
    if (pairing.status === "expired") throw new Error("PAIRING_EXPIRED");
    if (pairing.status !== "pending") throw new Error("PAIRING_ALREADY_USED");
    if (Date.now() >= pairing.expiresAt) {
      await ctx.db.patch(pairing._id, { status: "expired" });
      throw new Error("PAIRING_EXPIRED");
    }
    await ctx.db.patch(pairing._id, { status: "claimed", claimedByMobileId: mobileId });
    await ctx.db.insert("mobileClients", {
      mobileId,
      deviceId: pairing.deviceId,
      name,
      tokenHash: await hashToken(token),
      createdAt: Date.now(),
    });
    return { deviceId: pairing.deviceId };
  },
});

/** Desktop lists paired phones so the owner can audit and revoke access. */
export const listMobileClients = query({
  args: { deviceId: v.string(), token: v.string() },
  handler: async (ctx, { deviceId, token }) => {
    await requireDevice(ctx, deviceId, token);
    const clients = await ctx.db
      .query("mobileClients")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .collect();
    return clients
      .map((client) => ({
        mobileId: client.mobileId,
        name: client.name,
        createdAt: client.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Desktop revokes one paired phone and removes its routing-only metadata. */
export const revokeMobileClient = mutation({
  args: { deviceId: v.string(), token: v.string(), mobileId: v.string() },
  handler: async (ctx, { deviceId, token, mobileId }) => {
    await requireDevice(ctx, deviceId, token);
    const mobile = await ctx.db
      .query("mobileClients")
      .withIndex("by_mobile", (q) => q.eq("mobileId", mobileId))
      .unique();
    if (!mobile || mobile.deviceId !== deviceId) throw new Error("MOBILE_NOT_FOUND");

    const pushTokens = await ctx.db
      .query("pushTokens")
      .withIndex("by_mobile", (q) => q.eq("mobileId", mobileId))
      .collect();
    const subscriptions = await ctx.db
      .query("sessionSubs")
      .withIndex("by_mobile", (q) => q.eq("mobileId", mobileId))
      .collect();
    const commands = await ctx.db
      .query("commands")
      .withIndex("by_mobile", (q) => q.eq("mobileId", mobileId))
      .collect();

    for (const row of pushTokens) await ctx.db.delete(row._id);
    for (const row of subscriptions) await ctx.db.delete(row._id);
    for (const row of commands) {
      if (row.status === "pending" || row.status === "claimed") {
        await ctx.db.patch(row._id, { status: "error" });
      }
      // A revoked phone's requests will never be executed; drop the payloads with
      // it rather than leaving orphans for the prune sweep to find.
      await deletePayload(ctx, row._id);
    }
    await ctx.db.delete(mobile._id);

    const remaining = await ctx.db
      .query("mobileClients")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .collect();
    return remaining
      .map((client) => ({
        mobileId: client.mobileId,
        name: client.name,
        createdAt: client.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});
