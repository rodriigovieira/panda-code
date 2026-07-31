import { convexTest } from "convex-test";
import { api } from "./_generated/api";
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
  await t.mutation(api.pairing.registerDevice, {
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
