import type { MutationCtx, QueryCtx } from "../_generated/server";

const TOKEN_HASH_ALGORITHM = "pbkdf2-sha256";
const TOKEN_HASH_ITERATIONS = 120_000;
const TOKEN_SALT_BYTES = 16;
const TOKEN_HASH_BYTES = 32;
const LEGACY_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) return null;

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Compare byte arrays without returning early on the first mismatch. */
function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function deriveTokenHash(
  raw: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(raw),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    TOKEN_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Hash a relay bearer token for storage.
 *
 * The salt and work factor are encoded alongside the derived key so the schema
 * can retain its single `tokenHash` field. No raw token material is persisted.
 */
export async function hashToken(raw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(TOKEN_SALT_BYTES));
  const derived = await deriveTokenHash(raw, salt, TOKEN_HASH_ITERATIONS);
  return [
    TOKEN_HASH_ALGORITHM,
    TOKEN_HASH_ITERATIONS.toString(),
    bytesToHex(salt),
    bytesToHex(derived),
  ].join("$");
}

/** Verify a token using a constant-time comparison of the derived key. */
export async function verifyToken(raw: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length === 4 && parts[0] === TOKEN_HASH_ALGORITHM) {
    const iterations = Number(parts[1]);
    const salt = hexToBytes(parts[2]);
    const expected = hexToBytes(parts[3]);
    if (
      !Number.isSafeInteger(iterations) ||
      iterations < TOKEN_HASH_ITERATIONS ||
      iterations > 1_000_000 ||
      salt?.length !== TOKEN_SALT_BYTES ||
      expected?.length !== TOKEN_HASH_BYTES
    ) {
      return false;
    }

    const actual = await deriveTokenHash(raw, salt, iterations);
    return constantTimeEqual(actual, expected);
  }

  // Existing deployments may have deterministic SHA-256 records. New writes
  // never use this format, but accepting it avoids breaking already-paired clients.
  if (LEGACY_SHA256_PATTERN.test(storedHash)) {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(raw)),
    );
    const expected = hexToBytes(storedHash);
    return expected !== null && constantTimeEqual(digest, expected);
  }

  return false;
}

/** Validate a desktop device token; returns the device row or throws. */
export async function requireDevice(
  ctx: QueryCtx | MutationCtx,
  deviceId: string,
  token: string,
) {
  const device = await ctx.db
    .query("devices")
    .withIndex("by_device", (query) => query.eq("deviceId", deviceId))
    .unique();
  if (!device) throw new Error("DEVICE_NOT_FOUND");
  if (!(await verifyToken(token, device.tokenHash))) {
    throw new Error("DEVICE_AUTH_FAILED");
  }
  return device;
}

/** Validate a paired phone token; returns the mobile row (with its deviceId) or throws. */
export async function requireMobile(
  ctx: QueryCtx | MutationCtx,
  mobileId: string,
  token: string,
) {
  const mobile = await ctx.db
    .query("mobileClients")
    .withIndex("by_mobile", (query) => query.eq("mobileId", mobileId))
    .unique();
  if (!mobile) throw new Error("MOBILE_NOT_FOUND");
  if (!(await verifyToken(token, mobile.tokenHash))) {
    throw new Error("MOBILE_AUTH_FAILED");
  }
  return mobile;
}
