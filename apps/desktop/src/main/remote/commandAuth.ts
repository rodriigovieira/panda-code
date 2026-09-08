import { createHash, createHmac, createPublicKey, verify } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptJson } from "./crypto";

export const COMMAND_DOMAIN = "panda-code/command/v2";
export const COMMAND_SIGNATURE_DOMAIN = "panda-code/command-auth/v3";
export const COMMAND_LIFETIME_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;
export function commandKey(key: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(COMMAND_DOMAIN).digest());
}
export type CommandRouting = {
  mobileId: string;
  sessionId?: string;
  type: string;
  payloadCipher?: string;
  commandAuthVersion?: number;
  commandKeyId?: string;
  commandSignature?: string;
  commandIdentityState?: "signed" | "legacy" | "invalid";
  commandPublicKey?: string;
};
export type CommandEnvelope = {
  v: 2; domain: typeof COMMAND_DOMAIN; id: string; deviceId: string;
  mobileId: string; sessionId: string | null; type: string;
  issuedAt: number; expiresAt: number; payload: unknown;
};
type SignedCommandEnvelope = {
  v: 3; domain: typeof COMMAND_SIGNATURE_DOMAIN; id: string; deviceId: string;
  mobileId: string; sessionId: string | null; type: string;
  issuedAt: number; expiresAt: number; payloadCanonical: string; payloadDigest: string;
};

export function commandSigningMessage(envelope: Pick<SignedCommandEnvelope,
  "id" | "deviceId" | "mobileId" | "sessionId" | "type" | "issuedAt" | "expiresAt" | "payloadDigest">): string {
  return JSON.stringify([
    COMMAND_SIGNATURE_DOMAIN, envelope.id, envelope.deviceId, envelope.mobileId,
    envelope.sessionId, envelope.type, envelope.issuedAt, envelope.expiresAt, envelope.payloadDigest,
  ]);
}

function publicKeyFromX963(encoded: string) {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Invalid phone command public key.");
  // SubjectPublicKeyInfo prefix for id-ecPublicKey / prime256v1 followed by the
  // uncompressed ANSI X9.63 point exported by SecKey.
  const prefix = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

function validTimes(value: { issuedAt?: number; expiresAt?: number }, now: number): boolean {
  return Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) &&
    value.issuedAt! <= now + CLOCK_SKEW_MS && value.expiresAt! >= now &&
    value.expiresAt! > value.issuedAt! && value.expiresAt! - value.issuedAt! <= COMMAND_LIFETIME_MS;
}
/** Stored before execution. A crash may lose an action, but can never repeat it. */
export class CommandReplayGuard {
  private seen: Record<string, number> = {};
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.entries(value).some(([id, expiry]) => !/^[a-f0-9-]{36}$/i.test(id) || !Number.isFinite(expiry))) {
        throw new Error("Remote replay protection is unreadable. Remote control is disabled.");
      }
      this.seen = Object.assign(Object.create(null), value);
    }
  }
  open(command: CommandRouting, deviceId: string, key: Uint8Array, now = Date.now()): CommandEnvelope {
    if (!command.payloadCipher) throw new Error("Update Panda Code on your phone: an authenticated command is required.");
    const value = decryptJson(command.payloadCipher, commandKey(key)) as
      | Partial<CommandEnvelope>
      | Partial<SignedCommandEnvelope>
      | null;
    const hasAnySignatureMetadata = command.commandAuthVersion !== undefined || command.commandKeyId !== undefined ||
      command.commandSignature !== undefined || command.commandPublicKey !== undefined;
    if (command.commandIdentityState === "invalid" ||
        (command.commandIdentityState === "legacy" && hasAnySignatureMetadata) ||
        (command.commandIdentityState === "signed" && !hasAnySignatureMetadata)) {
      throw new Error("Remote command identity is incomplete or ambiguous.");
    }
    if (value?.v === 3) {
      if (value.domain !== COMMAND_SIGNATURE_DOMAIN || command.commandAuthVersion !== 3 ||
          command.commandIdentityState !== "signed" || typeof command.commandKeyId !== "string" ||
          !/^[a-f0-9]{64}$/.test(command.commandKeyId) || typeof command.commandSignature !== "string" ||
          typeof command.commandPublicKey !== "string" || typeof value.id !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(value.id) || value.deviceId !== deviceId ||
          value.mobileId !== command.mobileId || value.sessionId !== (command.sessionId ?? null) ||
          value.type !== command.type || !validTimes(value, now) || typeof value.payloadCanonical !== "string" ||
          typeof value.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.payloadDigest)) {
        throw new Error("Remote command signature context is invalid.");
      }
      const signedEnvelope = value as SignedCommandEnvelope;
      const publicRaw = Buffer.from(command.commandPublicKey, "base64");
      const keyId = createHash("sha256").update(publicRaw).digest("hex");
      const digest = createHash("sha256").update(signedEnvelope.payloadCanonical, "utf8").digest("hex");
      if (keyId !== command.commandKeyId || digest !== signedEnvelope.payloadDigest ||
          !verify("sha256", Buffer.from(commandSigningMessage(signedEnvelope)),
            publicKeyFromX963(command.commandPublicKey), Buffer.from(command.commandSignature, "base64"))) {
        throw new Error("Remote command signature verification failed.");
      }
      let payload: unknown;
      try { payload = JSON.parse(signedEnvelope.payloadCanonical); } catch { throw new Error("Remote command payload is not canonical JSON."); }
      if (this.seen[signedEnvelope.id] !== undefined) throw new Error("Remote command was already handled.");
      return { v: 2, domain: COMMAND_DOMAIN, id: signedEnvelope.id, deviceId: signedEnvelope.deviceId,
        mobileId: signedEnvelope.mobileId, sessionId: signedEnvelope.sessionId, type: signedEnvelope.type,
        issuedAt: signedEnvelope.issuedAt, expiresAt: signedEnvelope.expiresAt, payload };
    }
    if (hasAnySignatureMetadata || command.commandIdentityState === "signed") {
      throw new Error("A phone with an enrolled identity cannot use command v2.");
    }
    if (!value || value.v !== 2 || value.domain !== COMMAND_DOMAIN ||
        typeof value.id !== "string" || !/^[a-f0-9-]{36}$/i.test(value.id) ||
        value.deviceId !== deviceId || value.mobileId !== command.mobileId ||
        value.sessionId !== (command.sessionId ?? null) || value.type !== command.type ||
        !validTimes(value, now) ||
        !Object.hasOwn(value, "payload")) {
      throw new Error("Remote command authentication or expiry check failed.");
    }
    const legacyEnvelope = value as CommandEnvelope;
    if (this.seen[legacyEnvelope.id] !== undefined) throw new Error("Remote command was already handled.");
    return legacyEnvelope;
  }
  consume(envelope: CommandEnvelope, now = Date.now()): void {
    if (this.seen[envelope.id] !== undefined) throw new Error("Remote command was already handled.");
    const next = Object.fromEntries(Object.entries(this.seen).filter(([, expiry]) => expiry >= now));
    // Never evict an unexpired replay marker to make room for a flood.
    if (Object.keys(next).length >= 10_000) throw new Error("Remote command replay capacity reached; try again later.");
    next[envelope.id] = envelope.expiresAt;
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.tmp`;
      const fd = openSync(temp, "w", 0o600);
      try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.path);
      const directory = openSync(dirname(this.path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    this.seen = next;
  }
}
