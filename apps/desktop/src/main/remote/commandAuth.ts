import { createHmac } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptJson } from "./crypto";

export const COMMAND_DOMAIN = "panda-code/command/v2";
export const COMMAND_LIFETIME_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;
export function commandKey(key: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(COMMAND_DOMAIN).digest());
}
export type CommandRouting = { mobileId: string; sessionId?: string; type: string; payloadCipher?: string };
export type CommandEnvelope = {
  v: 2; domain: typeof COMMAND_DOMAIN; id: string; deviceId: string;
  mobileId: string; sessionId: string | null; type: string;
  issuedAt: number; expiresAt: number; payload: unknown;
};
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
    const value = decryptJson(command.payloadCipher, commandKey(key)) as Partial<CommandEnvelope> | null;
    if (!value || value.v !== 2 || value.domain !== COMMAND_DOMAIN ||
        typeof value.id !== "string" || !/^[a-f0-9-]{36}$/i.test(value.id) ||
        value.deviceId !== deviceId || value.mobileId !== command.mobileId ||
        value.sessionId !== (command.sessionId ?? null) || value.type !== command.type ||
        !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
        value.issuedAt! > now + CLOCK_SKEW_MS || value.expiresAt! < now ||
        value.expiresAt! <= value.issuedAt! || value.expiresAt! - value.issuedAt! > COMMAND_LIFETIME_MS ||
        !Object.hasOwn(value, "payload")) {
      throw new Error("Remote command authentication or expiry check failed.");
    }
    if (this.seen[value.id] !== undefined) throw new Error("Remote command was already handled.");
    return value as CommandEnvelope;
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
