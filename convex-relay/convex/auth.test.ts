import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  createRelayTest,
  pairMobile,
  registerDevice,
  relayFixture,
  upsertSession,
} from "./test.setup";

describe("relay authentication failures", () => {
  test("every authenticated public function rejects an invalid bearer token", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    const commandId = await t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      type: "stop",
    });

    const invalidDeviceToken = "invalid-device-token";
    const invalidMobileToken = "invalid-mobile-token";
    const checks: Array<{
      name: string;
      run: () => Promise<unknown>;
      error: string;
    }> = [
      {
        name: "pairing.registerDevice re-registration",
        run: () =>
          t.mutation(api.pairing.registerDevice, {
            deviceId: relayFixture.deviceId,
            token: invalidDeviceToken,
            name: "Attacker",
            platform: "darwin",
          }),
        error: "DEVICE_AUTH_FAILED",
      },
      {
        name: "pairing.createCode",
        run: () =>
          t.mutation(api.pairing.createCode, {
            deviceId: relayFixture.deviceId,
            token: invalidDeviceToken,
            code: "unauthorized-code",
          }),
        error: "DEVICE_AUTH_FAILED",
      },
      {
        name: "devices.heartbeat",
        run: () =>
          t.mutation(api.devices.heartbeat, {
            deviceId: relayFixture.deviceId,
            token: invalidDeviceToken,
          }),
        error: "DEVICE_AUTH_FAILED",
      },
      {
        name: "devices.status",
        run: () =>
          t.query(api.devices.status, {
            mobileId: relayFixture.mobileId,
            token: invalidMobileToken,
          }),
        error: "MOBILE_AUTH_FAILED",
      },
      {
        name: "commands.enqueue",
        run: () =>
          t.mutation(api.commands.enqueue, {
            mobileId: relayFixture.mobileId,
            token: invalidMobileToken,
            type: "stop",
          }),
        error: "MOBILE_AUTH_FAILED",
      },
      {
        name: "commands.pending",
        run: () =>
          t.query(api.commands.pending, {
            deviceId: relayFixture.deviceId,
            token: invalidDeviceToken,
          }),
        error: "DEVICE_AUTH_FAILED",
      },
      {
        name: "commands.claim",
        run: () =>
          t.mutation(api.commands.claim, {
            deviceId: relayFixture.deviceId,
            token: invalidDeviceToken,
            commandId,
          }),
        error: "DEVICE_AUTH_FAILED",
      },
      {
        name: "commands.ack",
        run: () =>
          t.mutation(api.commands.ack, {
            deviceId: relayFixture.deviceId,
            token: invalidDeviceToken,
            commandId,
            status: "done",
          }),
        error: "DEVICE_AUTH_FAILED",
      },
      {
        name: "commands.watchMine",
        run: () =>
          t.query(api.commands.watchMine, {
            mobileId: relayFixture.mobileId,
            token: invalidMobileToken,
          }),
        error: "MOBILE_AUTH_FAILED",
      },
      {
        name: "sessions.upsertSession",
        run: () =>
          t.mutation(api.sessions.upsertSession, {
            deviceId: relayFixture.deviceId,
            token: invalidDeviceToken,
            sessionId: relayFixture.sessionId,
            status: "running",
            agentState: "working",
            executionMode: "stream-json",
          }),
        error: "DEVICE_AUTH_FAILED",
      },
      {
        name: "sessions.appendEvents",
        run: () =>
          t.mutation(api.sessions.appendEvents, {
            deviceId: relayFixture.deviceId,
            token: invalidDeviceToken,
            sessionId: relayFixture.sessionId,
            events: [],
          }),
        error: "DEVICE_AUTH_FAILED",
      },
      {
        name: "sessions.list",
        run: () =>
          t.query(api.sessions.list, {
            mobileId: relayFixture.mobileId,
            token: invalidMobileToken,
          }),
        error: "MOBILE_AUTH_FAILED",
      },
      {
        name: "sessions.tail",
        run: () =>
          t.query(api.sessions.tail, {
            mobileId: relayFixture.mobileId,
            token: invalidMobileToken,
            sessionId: relayFixture.sessionId,
            afterSeq: 0,
          }),
        error: "MOBILE_AUTH_FAILED",
      },
      {
        name: "sessions.history",
        run: () =>
          t.query(api.sessions.history, {
            mobileId: relayFixture.mobileId,
            token: invalidMobileToken,
            sessionId: relayFixture.sessionId,
          }),
        error: "MOBILE_AUTH_FAILED",
      },
    ];

    for (const check of checks) {
      await expect(check.run(), check.name).rejects.toThrow(check.error);
    }
  });

  test("claimCode rejects an invalid pairing credential", async () => {
    const t = createRelayTest();
    await registerDevice(t);

    await expect(
      t.mutation(api.pairing.claimCode, {
        code: "unknown-code",
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      }),
    ).rejects.toThrow("PAIRING_NOT_FOUND");
  });

  test("claimCode distinguishes expired and claimed pairing codes", async () => {
    const t = createRelayTest();
    await registerDevice(t);

    await t.mutation(api.pairing.createCode, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      code: "expired-code",
    });
    await t.run(async (ctx) => {
      const pairing = await ctx.db
        .query("pairings")
        .withIndex("by_code", (query) => query.eq("code", "expired-code"))
        .unique();
      if (!pairing) throw new Error("fixture pairing missing");
      await ctx.db.patch(pairing._id, { status: "expired" });
    });

    await expect(
      t.mutation(api.pairing.claimCode, {
        code: "expired-code",
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      }),
    ).rejects.toThrow("PAIRING_EXPIRED");

    await pairMobile(t);
    await expect(
      t.mutation(api.pairing.claimCode, {
        code: relayFixture.pairingCode,
        mobileId: "mobile-2",
        token: "second-mobile-token-with-at-least-256-bits-fixture",
      }),
    ).rejects.toThrow("PAIRING_ALREADY_USED");
  });
});
