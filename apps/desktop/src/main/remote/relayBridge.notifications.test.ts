import { randomUUID } from "node:crypto";
import { commandKey, COMMAND_DOMAIN } from "./commandAuth";
import { describe, expect, it } from "vitest";
import { createRelayBridge } from "./relayBridge";
import { encryptJson } from "./crypto";
import { patchNotificationChannels, resolveNotificationChannels, type NotificationChannelConfig } from "../../shared/notification-channels";

describe("remote notification settings", () => {
  it("reads and patches only the requested session channel through encrypted commands", async () => {
    let config: NotificationChannelConfig | undefined;
    const bridge = createRelayBridge({
      notificationSettings: (id, patch) => {
        if (patch) config = patchNotificationChannels(config, id, patch);
        return resolveNotificationChannels(config, id);
      },
    } as Parameters<typeof createRelayBridge>[0]);
    const key = new Uint8Array(32).fill(7);
    const internal = bridge as unknown as {
      credentials: { key: Uint8Array; deviceId: string };
      dispatchCommand: (command: unknown) => Promise<unknown>;
    };
    internal.credentials = { key, deviceId: "device" };
    const call = async (sessionId: string, payload: unknown) => internal.dispatchCommand({
      type: "notification-settings", sessionId, mobileId: "phone",
      payloadCipher: encryptJson({
        v: 2, domain: COMMAND_DOMAIN, id: randomUUID(), deviceId: "device", mobileId: "phone",
        sessionId, type: "notification-settings", issuedAt: Date.now(), expiresAt: Date.now() + 60_000, payload,
      }, commandKey(key)),
    });
    expect(await call("one", { op: "set", desktop: false, agent: true })).toEqual({
      succeeded: true, payload: { settings: { desktop: false, agent: true } },
    });
    expect(await call("two", { op: "get" })).toEqual({
      succeeded: true, payload: { settings: { desktop: true, agent: false } },
    });
    expect(await call("one", { op: "set", agent: false })).toEqual({
      succeeded: true, payload: { settings: { desktop: false, agent: false } },
    });
    await expect(call("one", { op: "delete" })).rejects.toThrow("Invalid notification settings operation");
  });
});
