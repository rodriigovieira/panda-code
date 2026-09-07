import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireDevice, requireMobile } from "./lib/auth";

/**
 * Screenshot/recording transfer (docs/protocol.md §6 — see `schema.ts`'s
 * `mediaBlobs` comment for why this exists as its own table instead of riding
 * `commandResults` like every other request/response answer).
 *
 * Flow: desktop claims a `media` command, reads the file off its own disk,
 * seals it with the pairing key exactly like any other `*Cipher` field, and
 * uploads the ciphertext here — Convex file storage has no per-document size
 * cap, unlike `commandResults`. The command's actual resultCipher only ever
 * carries `{storageId, mimeType}`. The phone resolves that storageId to a
 * fetchable URL via `url` below, downloads the ciphertext over plain HTTPS,
 * and opens it locally — the relay never has the key, so serving the blob to
 * anyone who guesses a storage URL leaks nothing but its size.
 */

/** Desktop: get a one-time URL to POST the encrypted blob to. */
export const generateUploadUrl = mutation({
  args: { deviceId: v.string(), token: v.string() },
  handler: async (ctx, { deviceId, token }) => {
    await requireDevice(ctx, deviceId, token);
    const site = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CONVEX_SITE_URL;
    if (!site) throw new Error("CONVEX_SITE_URL is required for authenticated media uploads.");
    return `${site.replace(/\/$/, "")}/media/upload`;
  },
});

/** Desktop: record who owns a just-uploaded blob, once the POST above lands. */
export const registerBlob = mutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    storageId: v.id("_storage"),
    mimeType: v.string(),
  },
  handler: async (ctx, { deviceId, token, storageId, mimeType }) => {
    await requireDevice(ctx, deviceId, token);
    const owned = await ctx.db.query("mediaBlobs").withIndex("by_storage", q => q.eq("storageId", storageId)).unique();
    if (!owned || owned.deviceId !== deviceId) throw new Error("MEDIA_NOT_OWNED");
    if (!["image/jpeg", "image/gif", "video/mp4", "video/quicktime", "video/webm"].includes(mimeType)) throw new Error("INVALID_MEDIA_TYPE");
    await ctx.db.patch(owned._id, { mimeType });
  },
});

/**
 * Mobile: resolve a storageId (read off a settled `media` command's result) to
 * a fetchable URL. Gated on the requesting phone's paired device actually
 * owning the row — see the `mediaBlobs` schema comment — so this can't be used
 * to fish for another pairing's blobs even though storage ids are hard to guess.
 */
export const url = query({
  args: { mobileId: v.string(), token: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { mobileId, token, storageId }) => {
    const mobile = await requireMobile(ctx, mobileId, token);
    const owned = await ctx.db
      .query("mediaBlobs")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .unique();
    if (!owned || owned.deviceId !== mobile.deviceId) return null;
    return ctx.storage.getUrl(storageId);
  },
});

/** Debited before consuming any upload body, and cannot be bypassed by omitting
 * registerBlob. Enrollment is owner-gated, so creating identities is not free. */
export const reserveUpload = internalMutation({
  args: { deviceId: v.string(), token: v.string() },
  handler: async (ctx, { deviceId, token }) => {
    const device = await requireDevice(ctx, deviceId, token);
    const now = Date.now();
    const budget = await ctx.db.query("mediaUploadBudgets").withIndex("by_device", q => q.eq("deviceId", deviceId)).unique();
    const current = budget && now - budget.windowStart < 60 * 60_000 ? budget : null;
    if (current && current.count >= 60) throw new Error("MEDIA_RATE_LIMITED");
    const patch = { deviceId, windowStart: current?.windowStart ?? now, count: (current?.count ?? 0) + 1 };
    if (budget) await ctx.db.patch(budget._id, patch); else await ctx.db.insert("mediaUploadBudgets", patch);
    return device.completedResetId ?? "initial";
  },
});
export const finishUpload = internalMutation({
  args: { deviceId: v.string(), token: v.string(), storageId: v.id("_storage"), generation: v.string() },
  handler: async (ctx, { deviceId, token, storageId, generation }) => {
    const device = await requireDevice(ctx, deviceId, token);
    if ((device.completedResetId ?? "initial") !== generation) throw new Error("PAIRING_CHANGED");
    const file = await ctx.db.system.get(storageId);
    if (!file || file.size > 16 * 1024 * 1024) throw new Error("MEDIA_TOO_LARGE");
    await ctx.db.insert("mediaBlobs", { deviceId, storageId, mimeType: "application/octet-stream", createdAt: Date.now() });
  },
});
