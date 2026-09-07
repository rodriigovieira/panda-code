import vectors from "../../../../../docs/crypto-vectors.json";
import { encryptJsonWithNonce } from "./crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMMAND_DOMAIN, commandKey, CommandReplayGuard, type CommandEnvelope } from "./commandAuth";
import { encryptJson, generateSecretboxKey } from "./crypto";
const now = 1_800_000_000_000;
const key = generateSecretboxKey();
function fixture(patch: Partial<CommandEnvelope> = {}) {
  const envelope: CommandEnvelope = { v: 2, domain: COMMAND_DOMAIN, id: randomUUID(), deviceId: "device", mobileId: "phone", sessionId: "section", type: "stop", issuedAt: now, expiresAt: now + 60_000, payload: null, ...patch };
  return { envelope, command: { mobileId: "phone", sessionId: "section", type: "stop", payloadCipher: encryptJson(envelope, commandKey(key)) } };
}
describe("authenticated remote commands", () => {
  it("accepts an empty Stop payload only inside an authenticated envelope", () => {
    const { command } = fixture();
    const guard = new CommandReplayGuard();
    expect(guard.open(command, "device", key, now).payload).toBeNull();
    expect(() => guard.open({ ...command, payloadCipher: undefined }, "device", key, now)).toThrow();
    expect(() => guard.open({ ...command, payloadCipher: encryptJson({}, key) }, "device", key, now)).toThrow();
  });
  it("rejects substituted device, phone, session, and command kind", () => {
    const { command } = fixture(); const guard = new CommandReplayGuard();
    for (const patch of [{ mobileId: "other" }, { sessionId: "other" }, { type: "approve" }]) expect(() => guard.open({ ...command, ...patch }, "device", key, now)).toThrow();
    expect(() => guard.open(command, "other", key, now)).toThrow();
    expect(() => guard.open(command, "device", generateSecretboxKey(), now)).toThrow();
  });
  it("rejects expired, future, and excessively long-lived envelopes", () => {
    for (const patch of [{ expiresAt: now - 1 }, { issuedAt: now + 60_000 }, { expiresAt: now + 600_000 }]) {
      expect(() => new CommandReplayGuard().open(fixture(patch).command, "device", key, now)).toThrow();
    }
  });
  it("persists replay rejection across restart and fails closed on corrupt state", () => {
    const dir = mkdtempSync("/tmp/panda-command-test-");
    try {
      const path = join(dir, "replays.json"); const { command } = fixture();
      const first = new CommandReplayGuard(path);
      first.consume(first.open(command, "device", key, now), now);
      expect(() => new CommandReplayGuard(path).open(command, "device", key, now)).toThrow(/already handled/);
      writeFileSync(path, "corrupted");
      expect(() => new CommandReplayGuard(path)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("does not consume a request if durable recording fails", () => {
    const dir = mkdtempSync("/tmp/panda-command-test-");
    try { const path = join(dir, "not-a-directory"); writeFileSync(path, "file");
      const guard = new CommandReplayGuard(join(path, "replays.json"));
      const { envelope } = fixture(); expect(() => guard.consume(envelope, now)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it("matches the Dart command KDF and secretbox vector", () => {
 const vector = vectors.commandVector;
 const key = Buffer.from(vector.keyBase64, "base64");
 expect(Buffer.from(commandKey(key)).toString("base64")).toBe(vector.derivedKeyBase64);
 expect(encryptJsonWithNonce(vector.plaintext, commandKey(key), Buffer.from(vector.nonceBase64, "base64"))).toBe(vector.envelopeBase64);
});
