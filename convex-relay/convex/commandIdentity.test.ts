import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { createRelayTest, pairMobile, registerDevice, relayFixture } from "./test.setup";

const publicKey = "BAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const keyId = "ee5c8300cd173089ebd4088c09e55c00142c6ef3a91d68831b199b2d9383e595";
const identity = {
  commandAuthVersion: 3,
  commandKeyId: keyId,
  commandPublicKey: publicKey,
  commandKeyProtection: "secure-enclave-biometry-current-set",
} as const;

describe("per-phone command identities", () => {
  test("migrates a legacy phone once and prevents v2 downgrade or key replacement", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    const legacyId = await t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      type: "stop",
      payloadCipher: "legacy-v2-cipher",
    });
    expect((await t.query(api.commands.pending, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    })).find(row => row._id === legacyId)?.commandIdentityState).toBe("legacy");

    await expect(t.mutation(api.pairing.registerCommandIdentity, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      ...identity,
    })).resolves.toEqual({ enrolled: true, migrated: true });
    await expect(t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      type: "stop",
      payloadCipher: "downgrade",
    })).rejects.toThrow("COMMAND_SIGNATURE_REQUIRED");
    await expect(t.mutation(api.pairing.registerCommandIdentity, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      ...identity,
      commandKeyId: "0".repeat(64),
    })).rejects.toThrow("COMMAND_IDENTITY_CHANGED_REPAIR_REQUIRED");
  });

  test("attributes signed commands and rejects another phone's key", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await t.mutation(api.pairing.registerCommandIdentity, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      ...identity,
    });
    await expect(t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      type: "stop",
      payloadCipher: "v3-cipher",
      commandAuthVersion: 3,
      commandKeyId: "0".repeat(64),
      commandSignature: "signature",
    })).rejects.toThrow("COMMAND_SIGNATURE_REQUIRED");
    const commandId = await t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      type: "stop",
      payloadCipher: "v3-cipher",
      commandAuthVersion: 3,
      commandKeyId: keyId,
      commandSignature: "signature",
    });
    const command = (await t.query(api.commands.pending, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    })).find(row => row._id === commandId);
    expect(command).toMatchObject({ commandIdentityState: "signed", commandPublicKey: publicKey, commandKeyId: keyId });
  });

  test("revokes one phone without rotating or removing another", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await t.mutation(api.pairing.createCode, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      code: "second-code",
    });
    await t.mutation(api.pairing.claimCode, {
      code: "second-code",
      mobileId: "mobile-2",
      token: "second-mobile-token-with-at-least-256-bits-fixture",
      name: "Second phone",
      ...identity,
    });
    const remaining = await t.mutation(api.pairing.revokeMobileClient, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      mobileId: relayFixture.mobileId,
    });
    expect(remaining.map(row => row.mobileId)).toEqual(["mobile-2"]);
    await expect(t.query(api.devices.status, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    })).rejects.toThrow("MOBILE_NOT_FOUND");
    await expect(t.query(api.devices.status, {
      mobileId: "mobile-2",
      token: "second-mobile-token-with-at-least-256-bits-fixture",
    })).resolves.toBeTruthy();
  });

  test("revokes immediately with thousands of rows while bounded cleanup continues", async () => {
    vi.useFakeTimers();
    try {
      const t = createRelayTest();
      await registerDevice(t);
      await pairMobile(t);
      const firstCommandId = await t.run(async (ctx) => {
        let firstCommandId;
        for (let index = 0; index < 2_000; index += 1) {
          const commandId = await ctx.db.insert("commands", {
            deviceId: relayFixture.deviceId,
            mobileId: relayFixture.mobileId,
            type: "stop",
            status: "pending",
            createdAt: Date.now(),
          });
          firstCommandId ??= commandId;
          await ctx.db.insert("commandPayloads", { commandId, payloadCipher: `cipher-${index}` });
          if (index % 10 === 0) {
            await ctx.db.insert("commandResults", { commandId, resultCipher: `result-${index}`, chunkIndex: 0 });
          }
        }
        return firstCommandId!;
      });

      await expect(t.mutation(api.pairing.revokeMobileClient, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        mobileId: relayFixture.mobileId,
      })).resolves.toEqual([]);
      await expect(t.query(api.devices.status, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      })).rejects.toThrow("MOBILE_REVOKED");
      await expect(t.mutation(api.commands.claim, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        commandId: firstCommandId,
      })).resolves.toEqual({ claimed: false });
      const duringCleanup = await t.run(async (ctx) => ({
        mobile: await ctx.db.query("mobileClients").withIndex("by_mobile", q => q.eq("mobileId", relayFixture.mobileId)).unique(),
        commands: (await ctx.db.query("commands").withIndex("by_mobile", q => q.eq("mobileId", relayFixture.mobileId)).take(2_001)).length,
      }));
      expect(duringCleanup.mobile?.revokedAt).toEqual(expect.any(Number));
      expect(duringCleanup.commands).toBeGreaterThan(1_900);

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await expect(t.run(async (ctx) => ({
        mobile: await ctx.db.query("mobileClients").withIndex("by_mobile", q => q.eq("mobileId", relayFixture.mobileId)).unique(),
        commands: await ctx.db.query("commands").withIndex("by_mobile", q => q.eq("mobileId", relayFixture.mobileId)).collect(),
        payloads: await ctx.db.query("commandPayloads").collect(),
        results: await ctx.db.query("commandResults").collect(),
      }))).resolves.toEqual({ mobile: null, commands: [], payloads: [], results: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
