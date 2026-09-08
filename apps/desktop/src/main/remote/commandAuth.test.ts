import vectors from "../../../../../docs/crypto-vectors.json";
import { encryptJsonWithNonce } from "./crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMMAND_DOMAIN, COMMAND_SIGNATURE_DOMAIN, commandKey, commandSigningMessage, CommandReplayGuard, type CommandEnvelope } from "./commandAuth";
import { encryptJson, generateSecretboxKey } from "./crypto";
const now = 1_800_000_000_000;
const key = generateSecretboxKey();
function fixture(patch: Partial<CommandEnvelope> = {}) {
  const envelope: CommandEnvelope = { v: 2, domain: COMMAND_DOMAIN, id: randomUUID(), deviceId: "device", mobileId: "phone", sessionId: "section", type: "stop", issuedAt: now, expiresAt: now + 60_000, payload: null, ...patch };
  return { envelope, command: { mobileId: "phone", sessionId: "section", type: "stop", payloadCipher: encryptJson(envelope, commandKey(key)) } };
}
function signedFixture(payload: unknown = { text: "hello", nested: { b: 2, a: 1 } }) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const decode = (value: string) => Buffer.from(value, "base64url");
  const publicRaw = Buffer.concat([Buffer.from([4]), decode(jwk.x!), decode(jwk.y!)]);
  const payloadCanonical = JSON.stringify(payload);
  const envelope = {
    v: 3 as const, domain: COMMAND_SIGNATURE_DOMAIN, id: randomUUID(), deviceId: "device",
    mobileId: "phone", sessionId: "section", type: "stop", issuedAt: now,
    expiresAt: now + 60_000, payloadCanonical,
    payloadDigest: createHash("sha256").update(payloadCanonical).digest("hex"),
  };
  const signature = sign("sha256", Buffer.from(commandSigningMessage(envelope)), privateKey).toString("base64");
  return {
    envelope,
    command: {
      mobileId: "phone", sessionId: "section", type: "stop",
      payloadCipher: encryptJson(envelope, commandKey(key)), commandAuthVersion: 3,
      commandKeyId: createHash("sha256").update(publicRaw).digest("hex"),
      commandSignature: signature, commandIdentityState: "signed" as const,
      commandPublicKey: publicRaw.toString("base64"),
    },
  };
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
  it("verifies a per-phone P-256 signature over routing, times, and payload digest", () => {
    const { command } = signedFixture();
    expect(new CommandReplayGuard().open(command, "device", key, now).payload).toEqual({ text: "hello", nested: { b: 2, a: 1 } });
    for (const patch of [
      { mobileId: "other" }, { sessionId: "other" }, { type: "approve" },
      { commandKeyId: "0".repeat(64) }, { commandSignature: Buffer.from("wrong").toString("base64") },
      { commandIdentityState: "invalid" as const },
    ]) expect(() => new CommandReplayGuard().open({ ...command, ...patch }, "device", key, now)).toThrow();
  });
  it("rejects modified signed payloads, expiry, replay, and command-v2 downgrade", () => {
    const { envelope, command } = signedFixture();
    const modified = { ...envelope, payloadCanonical: JSON.stringify({ text: "changed" }) };
    expect(() => new CommandReplayGuard().open({ ...command, payloadCipher: encryptJson(modified, commandKey(key)) }, "device", key, now)).toThrow();
    const expired = { ...envelope, issuedAt: now - 120_000, expiresAt: now - 60_000 };
    expect(() => new CommandReplayGuard().open({ ...command, payloadCipher: encryptJson(expired, commandKey(key)) }, "device", key, now)).toThrow();
    const guard = new CommandReplayGuard();
    const opened = guard.open(command, "device", key, now); guard.consume(opened, now);
    expect(() => guard.open(command, "device", key, now)).toThrow(/already handled/);
    expect(() => guard.open({ ...fixture().command, commandIdentityState: "signed", commandAuthVersion: 3 }, "device", key, now)).toThrow();
  });
  it("keeps explicit legacy command-v2 migration while rejecting partial identity metadata", () => {
    const { command } = fixture();
    expect(new CommandReplayGuard().open({ ...command, commandIdentityState: "legacy" }, "device", key, now).v).toBe(2);
    expect(() => new CommandReplayGuard().open({ ...command, commandIdentityState: "legacy", commandKeyId: "0".repeat(64) }, "device", key, now)).toThrow(/ambiguous/);
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

it("matches the Dart canonical v3 signing context vector", () => {
 const vector = vectors.commandSignatureVector;
 expect(createHash("sha256").update(vector.payloadCanonical).digest("hex")).toBe(vector.payloadDigest);
 expect(commandSigningMessage(vector)).toBe(vector.signingMessage);
});
