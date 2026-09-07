import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { createRelayTest, enrollDevice, pairMobile, registerDevice, relayFixture } from "./test.setup";

// `generateUploadUrl` hands the desktop a real Convex-hosted URL it POSTs the
// ciphertext to directly — that upload endpoint is Convex's own infra, not
// code in this repo, and convex-test's `t.fetch` does not simulate it. What
// IS this repo's logic — the auth gate on minting the URL, on registering the
// blob, and on resolving it back to a fetchable URL for the right phone only
// — is exercised here by storing a blob straight through `ctx.storage`
// (the same syscall the real upload endpoint calls under the hood).

describe("media transfer", () => {
  beforeEach(() => vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site"));
  afterEach(() => vi.unstubAllEnvs());
  test("minting an upload URL requires a valid device", async () => {
    const t = createRelayTest();
    await registerDevice(t);

    const uploadUrl = await t.mutation(api.media.generateUploadUrl, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    });
    expect(uploadUrl).toMatch(/^https?:\/\//);

    await expect(
      t.mutation(api.media.generateUploadUrl, {
        deviceId: relayFixture.deviceId,
        token: "wrong-token",
      }),
    ).rejects.toThrow();
  });

  test("desktop registers a blob and the paired phone can resolve it to a URL", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["envelope:ciphertext"])));

    await t.mutation(internal.media.finishUpload, { deviceId: relayFixture.deviceId, token: relayFixture.deviceToken, storageId, generation: "initial" });
    await t.mutation(api.media.registerBlob, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      storageId,
      mimeType: "image/jpeg",
    });

    const url = await t.query(api.media.url, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      storageId,
    });
    expect(url).toMatch(/^https?:\/\//);
  });

  test("a blob is invisible to a phone paired with a different device", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await enrollDevice(t, {
      deviceId: "device-2",
      token: "other-desktop-token-with-at-least-256-bits-of-entropy",
      name: "Other Mac",
      platform: "darwin",
    });
    await t.mutation(api.pairing.createCode, {
      deviceId: "device-2",
      token: "other-desktop-token-with-at-least-256-bits-of-entropy",
      code: "other-pairing-code-fixture",
    });
    await t.mutation(api.pairing.claimCode, {
      code: "other-pairing-code-fixture",
      mobileId: "mobile-2",
      token: "other-mobile-token-with-at-least-256-bits-of-entropy",
      name: "Other phone",
    });

    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["envelope:ciphertext"])));
    await t.mutation(internal.media.finishUpload, { deviceId: relayFixture.deviceId, token: relayFixture.deviceToken, storageId, generation: "initial" });
    await t.mutation(api.media.registerBlob, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      storageId,
      mimeType: "video/mp4",
    });

    const url = await t.query(api.media.url, {
      mobileId: "mobile-2",
      token: "other-mobile-token-with-at-least-256-bits-of-entropy",
      storageId,
    });
    expect(url).toBeNull();
  });

  test("an unregistered storageId resolves to nothing, even for the right mobile", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["never-registered"])));

    const url = await t.query(api.media.url, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      storageId,
    });
    expect(url).toBeNull();
  });
});
