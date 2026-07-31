import { internalAction, internalQuery, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireMobile } from "./lib/auth";

type PushTokenRow = {
  token: string;
};

const encoder = new TextEncoder();

function getEnv(name: string): string | undefined {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function apnsConfig():
  | {
      keyId: string;
      teamId: string;
      bundleId: string;
      privateKey: string;
      environment: "sandbox" | "production";
    }
  | null {
  const keyId = getEnv("APNS_KEY_ID");
  const teamId = getEnv("APNS_TEAM_ID");
  const bundleId = getEnv("APNS_BUNDLE_ID");
  const privateKey = getEnv("APNS_PRIVATE_KEY")?.replaceAll("\\n", "\n");
  const environment = getEnv("APNS_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";
  if (!keyId || !teamId || !bundleId || !privateKey) return null;
  return { keyId, teamId, bundleId, privateKey, environment };
}

async function providerToken(config: {
  keyId: string;
  teamId: string;
  privateKey: string;
}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64Url(
    encoder.encode(JSON.stringify({ alg: "ES256", kid: config.keyId })),
  );
  const claim = base64Url(
    encoder.encode(JSON.stringify({ iss: config.teamId, iat: nowSeconds })),
  );
  const unsignedJwt = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(config.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(unsignedJwt),
  );
  return `${unsignedJwt}.${base64Url(new Uint8Array(signature))}`;
}

// The three notification kinds and their user-facing copy + APNs `type`.
type NotificationKind = "done" | "needs_approval" | "error";

const NOTIFICATION_COPY: Record<
  NotificationKind,
  { body: string; type: string }
> = {
  done: { body: "Session finished on your Mac", type: "session_done" },
  needs_approval: {
    body: "A session needs your approval",
    type: "session_needs_approval",
  },
  error: { body: "A session hit an error", type: "session_error" },
};

async function sendApnsMessage(args: {
  providerToken: string;
  bundleId: string;
  environment: "sandbox" | "production";
  token: string;
  sessionId: string;
  kind: NotificationKind;
}): Promise<void> {
  const host =
    args.environment === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  const copy = NOTIFICATION_COPY[args.kind];
  const response = await fetch(`${host}/3/device/${args.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${args.providerToken}`,
      "apns-topic": args.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        alert: {
          title: "Panda Code",
          body: copy.body,
        },
        sound: "default",
      },
      type: copy.type,
      sessionId: args.sessionId,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`APNS_SEND_FAILED_${response.status}:${body}`);
  }
}

export const registerPushToken = mutation({
  args: {
    mobileId: v.string(),
    token: v.string(),
    pushToken: v.string(),
    platform: v.literal("ios"),
  },
  handler: async (ctx, { mobileId, token, pushToken, platform }) => {
    await requireMobile(ctx, mobileId, token);
    const now = Date.now();
    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("by_mobile_token", (query) =>
        query.eq("mobileId", mobileId).eq("token", pushToken),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { platform, updatedAt: now });
      return existing._id;
    }
    return ctx.db.insert("pushTokens", {
      mobileId,
      token: pushToken,
      platform,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const tokensForMobile = internalQuery({
  args: { mobileId: v.string() },
  handler: async (ctx, { mobileId }): Promise<PushTokenRow[]> => {
    const rows = await ctx.db
      .query("pushTokens")
      .withIndex("by_mobile", (query) => query.eq("mobileId", mobileId))
      .collect();
    return rows.map((row) => ({ token: row.token }));
  },
});

type NotificationPrefs = {
  muted: boolean;
  notifyOnDone: boolean;
  notifyOnNeedsApproval: boolean;
  notifyOnError: boolean;
};

export const prefsForMobile = internalQuery({
  args: { mobileId: v.string() },
  handler: async (ctx, { mobileId }): Promise<NotificationPrefs> => {
    const mobile = await ctx.db
      .query("mobileClients")
      .withIndex("by_mobile", (query) => query.eq("mobileId", mobileId))
      .unique();
    // Absent prefs default to "notify" so existing clients keep working.
    return {
      muted: mobile?.notifMuted === true,
      notifyOnDone: mobile?.notifyOnDone !== false,
      notifyOnNeedsApproval: mobile?.notifyOnNeedsApproval !== false,
      notifyOnError: mobile?.notifyOnError !== false,
    };
  },
});

/// Mobile: update this phone's notification preferences.
export const setNotificationPrefs = mutation({
  args: {
    mobileId: v.string(),
    token: v.string(),
    muted: v.optional(v.boolean()),
    notifyOnDone: v.optional(v.boolean()),
    notifyOnNeedsApproval: v.optional(v.boolean()),
    notifyOnError: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const mobile = await requireMobile(ctx, args.mobileId, args.token);
    await ctx.db.patch(mobile._id, {
      ...(args.muted !== undefined ? { notifMuted: args.muted } : {}),
      ...(args.notifyOnDone !== undefined
        ? { notifyOnDone: args.notifyOnDone }
        : {}),
      ...(args.notifyOnNeedsApproval !== undefined
        ? { notifyOnNeedsApproval: args.notifyOnNeedsApproval }
        : {}),
      ...(args.notifyOnError !== undefined
        ? { notifyOnError: args.notifyOnError }
        : {}),
    });
    return null;
  },
});

/// Mobile: (un)subscribe this phone to a session's notifications. Writes an
/// override row only — the default (subscribed to sessions this phone started)
/// is derived from `sessions.startedByMobileId`, so an override exists purely to
/// deviate from it. Idempotent: re-toggling patches the same row.
export const setSessionSubscription = mutation({
  args: {
    mobileId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    subscribed: v.boolean(),
  },
  handler: async (ctx, { mobileId, token, sessionId, subscribed }) => {
    const mobile = await requireMobile(ctx, mobileId, token);
    const now = Date.now();
    const existing = await ctx.db
      .query("sessionSubs")
      .withIndex("by_mobile", (q) => q.eq("mobileId", mobileId))
      .filter((q) => q.eq(q.field("sessionId"), sessionId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { subscribed, updatedAt: now });
      return null;
    }
    await ctx.db.insert("sessionSubs", {
      deviceId: mobile.deviceId,
      sessionId,
      mobileId,
      subscribed,
      updatedAt: now,
    });
    return null;
  },
});

/// Send a session notification of the given kind, gated by the mobile's prefs.
export const sendSessionNotification = internalAction({
  args: {
    mobileId: v.string(),
    sessionId: v.string(),
    kind: v.union(
      v.literal("done"),
      v.literal("needs_approval"),
      v.literal("error"),
    ),
  },
  handler: async (ctx, { mobileId, sessionId, kind }) => {
    const config = apnsConfig();
    if (!config) {
      console.warn("APNs env missing; skipped push notification.");
      return null;
    }

    const prefs = await ctx.runQuery(internal.notifications.prefsForMobile, {
      mobileId,
    });
    if (prefs.muted) return null;
    const enabled =
      kind === "done"
        ? prefs.notifyOnDone
        : kind === "needs_approval"
          ? prefs.notifyOnNeedsApproval
          : prefs.notifyOnError;
    if (!enabled) return null;

    const rows = await ctx.runQuery(internal.notifications.tokensForMobile, {
      mobileId,
    });
    if (rows.length === 0) return null;

    const jwt = await providerToken(config);
    await Promise.allSettled(
      rows.map((row) =>
        sendApnsMessage({
          providerToken: jwt,
          bundleId: config.bundleId,
          environment: config.environment,
          token: row.token,
          sessionId,
          kind,
        }),
      ),
    );
    return null;
  },
});
