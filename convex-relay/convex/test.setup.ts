import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");

export function createRelayTest() {
  return convexTest(schema, modules);
}

export type RelayTest = ReturnType<typeof createRelayTest>;

export const relayFixture = {
  deviceId: "device-1",
  deviceToken: "desktop-token-with-at-least-256-bits-of-entropy-fixture",
  mobileId: "mobile-1",
  mobileToken: "mobile-token-with-at-least-256-bits-of-entropy-fixture",
  pairingCode: "single-use-pairing-code-fixture",
  sessionId: "session-1",
} as const;

export async function registerDevice(t: RelayTest): Promise<void> {
  const { deviceId, deviceToken } = relayFixture;
  await enrollDevice(t, {
    deviceId,
    token: deviceToken,
    name: "Fixture Mac",
    platform: "darwin",
  });
}

export async function pairMobile(t: RelayTest): Promise<void> {
  const { deviceId, deviceToken, mobileId, mobileToken, pairingCode } = relayFixture;
  await t.mutation(api.pairing.createCode, {
    deviceId,
    token: deviceToken,
    code: pairingCode,
  });
  await t.mutation(api.pairing.claimCode, {
    code: pairingCode,
    mobileId,
    token: mobileToken,
    name: "Fixture Phone",
  });
}

export async function upsertSession(t: RelayTest): Promise<void> {
  const { deviceId, deviceToken, sessionId } = relayFixture;
  await t.mutation(api.sessions.upsertSession, {
    deviceId,
    token: deviceToken,
    sessionId,
    titleCipher: "cipher:title",
    cwdCipher: "cipher:cwd",
    status: "running",
    agentState: "working",
    executionMode: "stream-json",
  });
}

export async function enrollDevice(t: RelayTest, args: { deviceId: string; token: string; name: string; platform: string }) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(args.token)));
  const tokenFingerprint = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
  await t.mutation(internal.pairing.authorizeDevice, { deviceId: args.deviceId, tokenFingerprint });
  return t.mutation(api.pairing.registerDevice, args);
}
