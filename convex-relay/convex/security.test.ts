import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { createRelayTest, registerDevice, pairMobile, relayFixture as f, upsertSession } from "./test.setup";
const auth = { deviceId: f.deviceId, token: f.deviceToken };
const resetId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
describe("relay security boundaries", () => {
  test("knowing the deployment does not authorize enrollment or uploads", async () => {
    const t = createRelayTest();
    await expect(t.mutation(api.pairing.registerDevice, { ...auth, name: "unapproved", platform: "darwin" })).rejects.toThrow("Owner enrollment required");
    const response = await t.fetch("/media/upload", { method: "POST", body: "untrusted" });
    expect(response.status).toBe(403);
    expect(await t.run(ctx => ctx.db.query("devices").collect())).toEqual([]);
  });
  test("phone token alone cannot enqueue a payload-free Stop", async () => {
    const t = createRelayTest(); await registerDevice(t); await pairMobile(t);
    await expect(t.mutation(api.commands.enqueue, { mobileId: f.mobileId, token: f.mobileToken, sessionId: f.sessionId, type: "stop" })).rejects.toThrow();
  });
  test("reset blocks old codes, clears mirrors, and resumes idempotently", async () => {
    const t = createRelayTest(); await registerDevice(t); await pairMobile(t); await upsertSession(t);
    await t.mutation(api.pairing.createCode, { ...auth, code: "pending-code" });
    expect(await t.mutation(api.pairing.resetPairing, { ...auth, resetId })).toEqual({ complete: false });
    await expect(t.mutation(api.pairing.claimCode, { code: "pending-code", mobileId: "late-phone", token: f.mobileToken })).rejects.toThrow("PAIRING_RESET_IN_PROGRESS");
    await expect(t.mutation(api.pairing.createCode, { ...auth, code: "new-code" })).rejects.toThrow("PAIRING_RESET_IN_PROGRESS");
    let complete = false;
    for (let i = 0; i < 30 && !complete; i++) ({ complete } = await t.mutation(api.pairing.resetPairing, { ...auth, resetId }));
    expect(complete).toBe(true);
    expect(await t.mutation(api.pairing.resetPairing, { ...auth, resetId })).toEqual({ complete: true });
    expect(await t.run(ctx => ctx.db.query("sessions").collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("mobileClients").collect())).toEqual([]);
    const storageId = await t.run(ctx => ctx.storage.store(new Blob(["old upload"])));
    await expect(t.mutation(internal.media.finishUpload, { ...auth, storageId, generation: "initial" })).rejects.toThrow("PAIRING_CHANGED");
    await pairMobile(t);
  });
  test("upload endpoint bounds streaming bodies and records ownership itself", async () => {
    const t = createRelayTest(); await registerDevice(t);
    const headers = { Authorization: `Bearer ${f.deviceToken}`, "X-Panda-Device": f.deviceId };
    const tooLarge = await t.fetch("/media/upload", { method: "POST", headers, body: new Uint8Array(16 * 1024 * 1024 + 1) });
    expect(tooLarge.status).toBe(413);
    const accepted = await t.fetch("/media/upload", { method: "POST", headers, body: "opaque encrypted content" });
    expect(accepted.status).toBe(200);
    const rows = await t.run(ctx => ctx.db.query("mediaBlobs").collect());
    expect(rows).toHaveLength(1); expect(rows[0].deviceId).toBe(f.deviceId);
  });
});
