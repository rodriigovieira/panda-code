import { randomBytes, randomUUID } from "node:crypto";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionService } from "../sessionService";
import { createRelayBridge, type RelayBridge } from "./relayBridge";

const runSmoke = process.env.PANDA_CODE_RELAY_SMOKE === "1";
const relayUrl = process.env.PANDA_CODE_RELAY_URL;

const claimCodeRef = makeFunctionReference<
  "mutation",
  { code: string; mobileId: string; token: string; name?: string },
  { deviceId: string }
>("pairing:claimCode");
const enqueueRef = makeFunctionReference<
  "mutation",
  { mobileId: string; token: string; sessionId?: string; type: "stop" },
  string
>("commands:enqueue");
const watchMineRef = makeFunctionReference<
  "query",
  { mobileId: string; token: string },
  Array<{ _id: string; status: "pending" | "claimed" | "done" | "error" }>
>("commands:watchMine");

describe.skipIf(!runSmoke || !relayUrl)("relay bridge dev smoke", () => {
  let bridge: RelayBridge | undefined;
  let mobileClient: ConvexClient | undefined;

  afterEach(async () => {
    bridge?.stop();
    if (mobileClient) await mobileClient.close();
  });

  it("claims, dispatches, and acknowledges a stop command", async () => {
    if (!relayUrl) throw new Error("PANDA_CODE_RELAY_URL is required for the relay smoke test.");
    const stoppedIds: string[] = [];
    const sessionService: SessionService = {
      startSession: () => ({ ok: false, message: "not used" }),
      sendInput: async () => ({ ok: true }),
      answerApproval: () => ({ ok: true }),
      switchSession: () => undefined,
      stopSession: ({ id }) => stoppedIds.push(id),
      listSessions: () => [],
    };
    bridge = createRelayBridge({
      url: relayUrl,
      appVersion: "smoke-test",
      sessionService,
      isRemoteWorkspaceAllowed: () => true,
      log: () => undefined,
      pairingChanged: () => undefined,
      getUsageBundle: async () => null,
      runBtw: async () => ({ ok: false, message: "not used" }),
      loadUsageCost: () => ({
        tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0 },
        cost: { inputUsd: 0, outputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, totalUsd: 0, priced: true },
        groups: [],
        unpricedModels: [],
        sessionCount: 0,
        generatedAt: new Date(0).toISOString(),
      }),
    });
    await bridge.start();
    const pairing = bridge.getPairingInfo();
    if (pairing.status !== "ready") throw new Error(`Pairing failed: ${pairing.message}`);

    mobileClient = new ConvexClient(relayUrl);
    const mobileId = `smoke-${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    await mobileClient.mutation(claimCodeRef, { code: pairing.code, mobileId, token, name: "Desktop smoke test" });
    const commandId = await mobileClient.mutation(enqueueRef, {
      mobileId,
      token,
      sessionId: "smoke-stop",
      type: "stop",
    });

    let status: "pending" | "claimed" | "done" | "error" | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const commands = await mobileClient.query(watchMineRef, { mobileId, token });
      status = commands.find((command) => command._id === commandId)?.status;
      if (status === "done" || status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(stoppedIds).toContain("smoke-stop");
    expect(status).toBe("done");
  }, 15_000);
});
