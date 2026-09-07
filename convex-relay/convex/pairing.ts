import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { hashToken, requireDevice, verifyToken } from "./lib/auth";
import { deletePayload } from "./lib/commandPayloads";
import { deleteResult } from "./lib/commandResults";

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

/** Run only from the owner's Convex CLI/dashboard, using the fingerprint shown
 * by THEIR desktop. Never approve an enrollment supplied by an unknown client. */
export const authorizeDevice = internalMutation({
  args: { deviceId: v.string(), tokenFingerprint: v.string() },
  handler: async (ctx, { deviceId, tokenFingerprint }) => {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(deviceId) || !/^[a-f0-9]{64}$/.test(tokenFingerprint)) throw new Error("INVALID_ENROLLMENT");
    const old = await ctx.db.query("deviceEnrollments").withIndex("by_device", q => q.eq("deviceId", deviceId)).unique();
    if (old) await ctx.db.delete(old._id);
    await ctx.db.insert("deviceEnrollments", { deviceId, tokenFingerprint, expiresAt: Date.now() + 15 * 60_000 });
    return { authorized: true, deviceId, expiresInMinutes: 15 };
  },
});

async function tokenFingerprint(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

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
      if (existing.resettingPairing) throw new Error("PAIRING_RESET_IN_PROGRESS");
      await ctx.db.patch(existing._id, {
        name,
        platform,
        // Re-salt current records and opportunistically upgrade legacy SHA-256 rows.
        tokenHash: await hashToken(token),
      });
    } else {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(deviceId) || token.length < 32 || token.length > 256 || name.length > 200 || platform.length > 30) throw new Error("INVALID_DEVICE");
      const fingerprint = await tokenFingerprint(token);
      const enrollment = await ctx.db.query("deviceEnrollments").withIndex("by_device", q => q.eq("deviceId", deviceId)).unique();
      if (!enrollment || enrollment.expiresAt < Date.now() || enrollment.tokenFingerprint !== fingerprint) {
        throw new Error(`Owner enrollment required. On your relay, run: npx convex run pairing:authorizeDevice '${JSON.stringify({ deviceId, tokenFingerprint: fingerprint })}'`);
      }
      await ctx.db.delete(enrollment._id);
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
    const device = await ctx.db.query("devices").withIndex("by_device", q => q.eq("deviceId", pairing.deviceId)).unique();
    if (!device || device.resettingPairing) throw new Error("PAIRING_RESET_IN_PROGRESS");
    const clients = await ctx.db.query("mobileClients").withIndex("by_device", q => q.eq("deviceId", pairing.deviceId)).take(100);
    if (clients.length >= 100) throw new Error("PAIRED_DEVICE_LIMIT");
    if (mobileId.length > 128 || token.length < 32 || token.length > 256 || (name?.length ?? 0) > 200) throw new Error("INVALID_MOBILE");
    const existing = await ctx.db.query("mobileClients").withIndex("by_mobile", q => q.eq("mobileId", mobileId)).first();
    if (existing) throw new Error("MOBILE_ALREADY_EXISTS");
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
        notificationsEnabled: client.notifMuted !== true,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Desktop: mute or unmute push delivery on every phone paired to this Mac. */
export const setMobileNotifications = mutation({
  args: { deviceId: v.string(), token: v.string(), enabled: v.boolean() },
  handler: async (ctx, { deviceId, token, enabled }) => {
    await requireDevice(ctx, deviceId, token);
    const clients = await ctx.db
      .query("mobileClients")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .collect();
    await Promise.all(clients.map((client) => ctx.db.patch(client._id, { notifMuted: !enabled })));
    return clients
      .map((client) => ({
        mobileId: client.mobileId,
        name: client.name,
        createdAt: client.createdAt,
        notificationsEnabled: enabled,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Old desktops cannot revoke safely without rotating their shared key. */
export const revokeMobileClient = mutation({
  args: { deviceId: v.string(), token: v.string(), mobileId: v.string() },
  handler: async (ctx, { deviceId, token }) => {
    await requireDevice(ctx, deviceId, token);
    throw new Error("Update Panda Code on your Mac to revoke phones and rotate the encryption key.");
  },
});

/** Idempotent, bounded reset. Desktop persists a new key BEFORE starting this.
 * All phone reads/writes fail closed until the old relay mirror is gone.
 * Local desktop transcripts are never deleted. */
export const resetPairing = mutation({
  args: { deviceId: v.string(), token: v.string(), resetId: v.string() },
  handler: async (ctx, { deviceId, token, resetId }) => {
    const device = await requireDevice(ctx, deviceId, token, true);
    if (!/^[a-f0-9-]{36}$/i.test(resetId)) throw new Error("INVALID_RESET_ID");
    if (device.completedResetId === resetId) return { complete: true };
    if (device.resettingPairing && device.pairingResetId !== resetId) throw new Error("PAIRING_RESET_IN_PROGRESS");
    await ctx.db.patch(device._id, { resettingPairing: true, pairingResetId: resetId });
    const phones = await ctx.db.query("mobileClients").withIndex("by_device", q => q.eq("deviceId", deviceId)).take(10);
    for (const phone of phones) {
      const tokens = await ctx.db.query("pushTokens").withIndex("by_mobile", q => q.eq("mobileId", phone.mobileId)).take(100);
      for (const row of tokens) await ctx.db.delete(row._id);
      if (tokens.length === 100) return { complete: false };
      await ctx.db.delete(phone._id);
    }
    if (phones.length) return { complete: false };
    const commands = await ctx.db.query("commands").withIndex("by_device_status", q => q.eq("deviceId", deviceId)).take(5);
    for (const row of commands) {
      await deletePayload(ctx, row._id);
      await deleteResult(ctx, row._id);
      await ctx.db.delete(row._id);
    }
    if (commands.length) return { complete: false };
    const blobs = await ctx.db.query("mediaBlobs").withIndex("by_device", q => q.eq("deviceId", deviceId)).take(50);
    for (const blob of blobs) { await ctx.storage.delete(blob.storageId); await ctx.db.delete(blob._id); }
    if (blobs.length) return { complete: false };
    {
      const rows = await ctx.db.query("pairings").withIndex("by_device", q => q.eq("deviceId", deviceId)).take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { complete: false };
    }
    {
      const rows = await ctx.db.query("events").withIndex("by_device_session_seq", q => q.eq("deviceId", deviceId)).take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { complete: false };
    }
    {
      const rows = await ctx.db.query("sessions").withIndex("by_device", q => q.eq("deviceId", deviceId)).take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { complete: false };
    }
    {
      const rows = await ctx.db.query("sessionRuntime").withIndex("by_device_session", q => q.eq("deviceId", deviceId)).take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { complete: false };
    }
    {
      const rows = await ctx.db.query("deviceUsage").withIndex("by_device", q => q.eq("deviceId", deviceId)).take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { complete: false };
    }
    {
      const rows = await ctx.db.query("sessionStars").withIndex("by_device", q => q.eq("deviceId", deviceId)).take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { complete: false };
    }
    {
      const rows = await ctx.db.query("sessionArchive").withIndex("by_device", q => q.eq("deviceId", deviceId)).take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { complete: false };
    }
    {
      const rows = await ctx.db.query("sessionSubs").withIndex("by_device_session", q => q.eq("deviceId", deviceId)).take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { complete: false };
    }
    {
      const rows = await ctx.db.query("deviceWriteBudget").withIndex("by_device", q => q.eq("deviceId", deviceId)).take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { complete: false };
    }
    await ctx.db.patch(device._id, { resettingPairing: false, pairingResetId: undefined, completedResetId: resetId });
    return { complete: true };
  },
});
