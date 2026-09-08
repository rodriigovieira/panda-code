import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  createRelayTest,
  enrollDevice,
  pairMobile,
  registerDevice,
  relayFixture,
  upsertSession,
  type RelayTest,
} from "./test.setup";
import {
  CLOSED_COMMAND_RETENTION_MS,
  COMMAND_WATCH_WINDOW_MS,
  EVENT_RATE_LIMIT_MAX_BYTES,
  EVENT_RATE_LIMIT_MAX_EVENTS,
  EVENT_RATE_LIMIT_WINDOW_MS,
  EVENT_RETENTION_MS,
  MAX_EVENTS_PER_APPEND,
  MAX_EVENT_PAYLOAD_BYTES,
  OFFLINE_AFTER_MS,
  PENDING_COMMAND_TTL_MS,
  SESSION_LIST_LIMIT,
  WRITE_BUDGET_RETENTION_MS,
} from "./lib/retention";

describe("relay protocol", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("pairing handshake stores only hashed relay credentials", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const state = await t.run(async (ctx) => {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_device", (query) =>
          query.eq("deviceId", relayFixture.deviceId),
        )
        .unique();
      const mobile = await ctx.db
        .query("mobileClients")
        .withIndex("by_mobile", (query) =>
          query.eq("mobileId", relayFixture.mobileId),
        )
        .unique();
      const pairing = await ctx.db
        .query("pairings")
        .withIndex("by_code", (query) =>
          query.eq("code", relayFixture.pairingCode),
        )
        .unique();
      return { device, mobile, pairing };
    });

    expect(state.device?.tokenHash).toMatch(/^pbkdf2-sha256\$/);
    expect(state.device?.tokenHash).not.toContain(relayFixture.deviceToken);
    expect(state.mobile?.tokenHash).toMatch(/^pbkdf2-sha256\$/);
    expect(state.mobile?.tokenHash).not.toContain(relayFixture.mobileToken);
    expect(state.mobile).toMatchObject({ deviceId: relayFixture.deviceId });
    expect(state.pairing).toMatchObject({
      status: "claimed",
      claimedByMobileId: relayFixture.mobileId,
    });
  });

  test("the usage snapshot stays off the device row every call authenticates against", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await t.mutation(api.devices.heartbeat, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      appVersion: "1.3.0",
      usageCipher: "cipher:usage",
    });

    // `requireDevice` reads this document on every append, upsert and tail, so a
    // periodically-rewritten blob on it is charged to the entire protocol.
    const device = await t.run((ctx) =>
      ctx.db
        .query("devices")
        .withIndex("by_device", (q) => q.eq("deviceId", relayFixture.deviceId))
        .unique(),
    );
    expect(device?.usageCipher).toBeUndefined();
    expect(device?.appVersion).toBe("1.3.0");

    // The phone still sees it, from the one query that renders it.
    await expect(
      t.query(api.devices.status, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      }),
    ).resolves.toMatchObject({ online: true, usageCipher: "cipher:usage" });
  });

  test("a usage snapshot written before the split is still served", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await t.run(async (ctx) => {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_device", (q) => q.eq("deviceId", relayFixture.deviceId))
        .unique();
      await ctx.db.patch(device!._id, {
        usageCipher: "cipher:legacy-usage",
        status: "online",
        lastHeartbeatAt: Date.now(),
      });
    });

    await expect(
      t.query(api.devices.status, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      }),
    ).resolves.toMatchObject({ usageCipher: "cipher:legacy-usage" });
  });

  test("a usage-cost command carries its report back in resultCipher", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    // The report is computed by the desktop's ledger and sealed before it ever
    // reaches the relay, so the relay only moves opaque ciphertext either way.
    const commandId = await t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      type: "usage-cost",
      payloadCipher: "cipher:range",
    });

    const pending = await t.query(api.commands.pending, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    });
    expect(pending[0]).toMatchObject({ _id: commandId, type: "usage-cost" });

    await t.mutation(api.commands.claim, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      commandId,
    });
    await t.mutation(api.commands.ack, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      commandId,
      status: "done",
      resultCipher: "cipher:report",
    });

    const mine = await t.query(api.commands.watchMine, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    // The answer itself is NOT on the row `watchMine` re-ships on every
    // transition — only the flag saying one is waiting.
    expect(mine[0]).toMatchObject({
      _id: commandId,
      type: "usage-cost",
      status: "done",
      hasResult: true,
    });
    expect(mine[0].resultCipher).toBeUndefined();

    await expect(
      t.query(api.commands.result, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
        commandId,
      }),
    ).resolves.toEqual({ status: "done", resultCipher: "cipher:report" });
  });

  test("a session-files command carries its file list back in resultCipher", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    // Same shape as usage-cost: the desktop is the only side that can see a
    // working tree, so the answer is sealed before it reaches the relay.
    const commandId = await t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
      type: "session-files",
      payloadCipher: "cipher:authenticated-command-fixture",
    });

    const pending = await t.query(api.commands.pending, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    });
    expect(pending[0]).toMatchObject({ _id: commandId, type: "session-files" });

    await t.mutation(api.commands.claim, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      commandId,
    });
    await t.mutation(api.commands.ack, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      commandId,
      status: "done",
      resultCipher: "cipher:changes",
    });

    const mine = await t.query(api.commands.watchMine, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    // The answer itself is NOT on the row `watchMine` re-ships on every
    // transition — only the flag saying one is waiting.
    expect(mine[0]).toMatchObject({
      _id: commandId,
      type: "session-files",
      status: "done",
      hasResult: true,
    });
    expect(mine[0].resultCipher).toBeUndefined();

    await expect(
      t.query(api.commands.result, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
        commandId,
      }),
    ).resolves.toEqual({ status: "done", resultCipher: "cipher:changes" });
  });

  test("command enqueue, claim, and ack closes the loop", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const commandId = await t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
      type: "input",
      payloadCipher: "cipher:command",
    });

    const pending = await t.query(api.commands.pending, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      _id: commandId,
      status: "pending",
      payloadCipher: "cipher:command",
    });

    await expect(
      t.mutation(api.commands.claim, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        commandId,
      }),
    ).resolves.toEqual({ claimed: true });
    await expect(
      t.mutation(api.commands.claim, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        commandId,
      }),
    ).resolves.toEqual({ claimed: false });

    await t.mutation(api.commands.ack, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      commandId,
      status: "done",
      resultCipher: "cipher:result",
    });

    const mine = await t.query(api.commands.watchMine, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    expect(mine[0]).toMatchObject({ _id: commandId, status: "done", hasResult: true });
    await expect(
      t.query(api.commands.result, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
        commandId,
      }),
    ).resolves.toEqual({ status: "done", resultCipher: "cipher:result" });
  });

  test("a successful result rides in its own document; a failure stays inline", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const answer = async (status: "done" | "error", resultCipher: string) => {
      const commandId = await t.mutation(api.commands.enqueue, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
        type: "backlog",
      payloadCipher: "cipher:authenticated-command-fixture",
      });
      await t.mutation(api.commands.claim, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        commandId,
      });
      await t.mutation(api.commands.ack, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        commandId,
        status,
        resultCipher,
      });
      return commandId;
    };

    // A whole kanban board must not sit on the row `watchMine` re-ships on every
    // transition of every command the phone has issued in the last ten minutes.
    const okId = await answer("done", "cipher:board");
    const okRow = await t.run((ctx) => ctx.db.get(okId));
    expect(okRow).toMatchObject({ hasResult: true });
    expect(okRow?.resultCipher).toBeUndefined();

    // A failure message is one sentence, and explaining a rejected command is
    // exactly what `watchMine` is for — so that one stays where the UI reads it.
    const failId = await answer("error", "cipher:why-not");
    expect(await t.run((ctx) => ctx.db.get(failId))).toMatchObject({
      resultCipher: "cipher:why-not",
      hasResult: false,
    });
    await expect(
      t.run((ctx) => ctx.db.query("commandResults").collect()),
    ).resolves.toMatchObject([{ commandId: okId, resultCipher: "cipher:board" }]);

    // The phone reads its answer once, then frees it: an unconsumed board would
    // otherwise sit in the table for a week being re-read by the sweep.
    await t.mutation(api.commands.consumeResult, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      commandId: okId,
    });
    expect(await t.run((ctx) => ctx.db.query("commandResults").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(okId))).toMatchObject({ hasResult: false });
  });

  test("large encrypted backlog results round-trip in bounded pieces and are consumed", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    const commandId = await t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId, token: relayFixture.mobileToken, type: "backlog",
      payloadCipher: "cipher:authenticated-command-fixture",
    });
    const credentials = { deviceId: relayFixture.deviceId, token: relayFixture.deviceToken, commandId };
    const reader = { mobileId: relayFixture.mobileId, token: relayFixture.mobileToken, commandId };
    await t.mutation(api.commands.claim, credentials);
    const resultCipher = "cipher:" + "a".repeat(1200000);
    await t.mutation(api.commands.ack, { ...credentials, status: "done", resultCipher });
    const pieces = await t.run((ctx) => ctx.db.query("commandResults").collect());
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(new TextEncoder().encode(JSON.stringify(piece)).length).toBeLessThan(1024 * 1024);
    }
    await expect(t.query(api.commands.result, reader)).resolves.toEqual({ status: "done", resultCipher });
    await t.mutation(api.commands.consumeResult, reader);
    expect(await t.run((ctx) => ctx.db.query("commandResults").collect())).toHaveLength(0);
  });

  test("result replacement clears all pieces and preserves legacy and Unicode results", async () => {
    const { writeResultCipher, readResultCipher, deleteResult } = await import("./lib/commandResults");
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    const commandId = await t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId, token: relayFixture.mobileToken, type: "backlog",
      payloadCipher: "cipher:authenticated-command-fixture",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("commandResults", { commandId, resultCipher: "legacy" });
      const command = (await ctx.db.get(commandId))!;
      expect(await readResultCipher(ctx, command)).toBe("legacy");
      const unicode = "a".repeat(256 * 1024 - 1) + "🐼" + "界".repeat(300000);
      await writeResultCipher(ctx, commandId, unicode);
      expect(await readResultCipher(ctx, command)).toBe(unicode);
      const pieces = await ctx.db.query("commandResults").collect();
      for (const piece of pieces) {
        expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(piece.resultCipher))).toBe(piece.resultCipher);
        expect(new TextEncoder().encode(JSON.stringify(piece)).length).toBeLessThan(1024 * 1024);
      }
      await writeResultCipher(ctx, commandId, "small");
      expect(await ctx.db.query("commandResults").collect()).toHaveLength(1);
      expect(await readResultCipher(ctx, command)).toBe("small");
      await writeResultCipher(ctx, commandId, "");
      expect(await readResultCipher(ctx, command)).toBe("");
      await deleteResult(ctx, commandId);
      expect(await readResultCipher(ctx, command)).toBeUndefined();
      expect(await readResultCipher(ctx, { ...command, resultCipher: "inline" })).toBe("inline");
    });
  });

  test("starredForDevice ships only what changed after the cursor", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    await t.mutation(api.sessions.setStarredByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      starred: true,
    });

    // The desktop's startup read: everything, once.
    const all = await t.query(api.sessions.starredForDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    });
    expect(all).toMatchObject([{ sessionId: relayFixture.sessionId, starred: true }]);

    // The subscription it then holds open for the rest of the run reads the tail
    // after that instant — empty until a star actually moves, which is the whole
    // point: re-executing it must not re-ship all ~200 rows.
    const since = all[0].updatedAt;
    await expect(
      t.query(api.sessions.starredForDevice, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        since,
      }),
    ).resolves.toEqual([]);

    await t.mutation(api.sessions.setStarredByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      starred: false,
    });
    await expect(
      t.query(api.sessions.starredForDevice, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        since,
      }),
    ).resolves.toMatchObject([{ sessionId: relayFixture.sessionId, starred: false }]);
  });

  test("a command's payload rides in its own document and is freed on ack", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const commandId = await t.mutation(api.commands.enqueue, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
      type: "input",
      payloadCipher: "cipher:attachment",
    });

    // An attachment is sized right up to Convex's 1 MiB document cap. It must not
    // sit on the routing row, which `watchMine` re-reads on every transition and
    // `enqueue` re-reads on every send.
    const row = await t.run((ctx) => ctx.db.get(commandId));
    expect(row?.payloadCipher).toBeUndefined();
    await expect(
      t.run((ctx) => ctx.db.query("commandPayloads").collect()),
    ).resolves.toMatchObject([{ commandId, payloadCipher: "cipher:attachment" }]);

    // The desktop still receives it, joined, on the one query that needs it.
    const pending = await t.query(api.commands.pending, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    });
    expect(pending[0]).toMatchObject({ _id: commandId, payloadCipher: "cipher:attachment" });

    const mine = await t.query(api.commands.watchMine, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    expect(mine[0]).toMatchObject({ _id: commandId, status: "pending" });
    expect(mine[0]).not.toHaveProperty("payloadCipher");

    await t.mutation(api.commands.claim, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      commandId,
    });
    await t.mutation(api.commands.ack, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      commandId,
      status: "done",
    });

    // Executed: nothing will read the request again, so it doesn't get to loiter
    // for the closed-command retention window.
    await expect(
      t.run((ctx) => ctx.db.query("commandPayloads").collect()),
    ).resolves.toEqual([]);
  });

  test("a command enqueued before the payload split still executes", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const legacyId = await t.run((ctx) =>
      ctx.db.insert("commands", {
        deviceId: relayFixture.deviceId,
        mobileId: relayFixture.mobileId,
        sessionId: relayFixture.sessionId,
        type: "input",
        payloadCipher: "cipher:inline-legacy",
        status: "pending",
        createdAt: Date.now(),
      }),
    );

    const pending = await t.query(api.commands.pending, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    });
    expect(pending[0]).toMatchObject({ _id: legacyId, payloadCipher: "cipher:inline-legacy" });
  });

  test("watchMine ignores commands older than its window", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await t.run((ctx) =>
      ctx.db.insert("commands", {
        deviceId: relayFixture.deviceId,
        mobileId: relayFixture.mobileId,
        sessionId: relayFixture.sessionId,
        type: "input",
        status: "done",
        createdAt: Date.now() - COMMAND_WATCH_WINDOW_MS - 1,
      }),
    );

    // Old rows are history nobody renders, and every one of them would be
    // re-read on every subsequent transition of the rows the phone does care about.
    await expect(
      t.query(api.commands.watchMine, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      }),
    ).resolves.toEqual([]);
  });

  test("stale pending commands are not delivered or claimed", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const staleCommandId = await t.run((ctx) =>
      ctx.db.insert("commands", {
        deviceId: relayFixture.deviceId,
        mobileId: relayFixture.mobileId,
        sessionId: relayFixture.sessionId,
        type: "input",
        payloadCipher: "cipher:stale",
        status: "pending",
        createdAt: Date.now() - PENDING_COMMAND_TTL_MS - 1,
      }),
    );

    await expect(
      t.query(api.commands.pending, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
      }),
    ).resolves.toEqual([]);
    await expect(
      t.mutation(api.commands.claim, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        commandId: staleCommandId,
      }),
    ).resolves.toEqual({ claimed: false });

    const command = await t.run((ctx) => ctx.db.get(staleCommandId));
    expect(command?.status).toBe("error");
  });

  test("desktop can list and revoke paired phones", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const clients = await t.query(api.pairing.listMobileClients, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    });
    expect(clients).toMatchObject([
      { mobileId: relayFixture.mobileId, name: "Fixture Phone", notificationsEnabled: true },
    ]);

    await expect(
      t.mutation(api.pairing.revokeMobileClient, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        mobileId: relayFixture.mobileId,
      }),
    ).resolves.toEqual([]);

    await expect(
      t.query(api.commands.watchMine, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      }),
    ).rejects.toThrow(/MOBILE_(REVOKED|NOT_FOUND)/);
  });

  test("desktop can subscribe and unsubscribe all paired phones from notifications", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    const muted = await t.mutation(api.pairing.setMobileNotifications, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      enabled: false,
    });
    expect(muted).toMatchObject([{ mobileId: relayFixture.mobileId, notificationsEnabled: false }]);

    const prefs = await t.query(internal.notifications.prefsForMobile, {
      mobileId: relayFixture.mobileId,
    });
    expect(prefs.muted).toBe(true);

    await expect(
      t.mutation(api.pairing.setMobileNotifications, {
        deviceId: relayFixture.deviceId,
        token: "wrong-token",
        enabled: true,
      }),
    ).rejects.toThrow("DEVICE_AUTH_FAILED");
  });

  test("desktop can control a session subscription for every paired phone", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await expect(t.query(api.notifications.sessionSubscriptionForDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
    })).resolves.toEqual({ available: true, phoneCount: 1, subscribedPhones: 0 });

    await expect(t.mutation(api.notifications.setSessionSubscriptionByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      subscribed: true,
    })).resolves.toEqual({ available: true, phoneCount: 1, subscribedPhones: 1 });

    await expect(t.query(api.notifications.sessionSubscriptionForDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
    })).resolves.toEqual({ available: true, phoneCount: 1, subscribedPhones: 1 });
  });

  test("push token registration requires mobile auth and upserts per token", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await expect(
      t.mutation(api.notifications.registerPushToken, {
        mobileId: relayFixture.mobileId,
        token: "wrong-token",
        pushToken: "apns-token-1",
        platform: "ios",
      }),
    ).rejects.toThrow("MOBILE_AUTH_FAILED");

    const firstId = await t.mutation(api.notifications.registerPushToken, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      pushToken: "apns-token-1",
      platform: "ios",
    });
    const secondId = await t.mutation(api.notifications.registerPushToken, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      pushToken: "apns-token-1",
      platform: "ios",
    });

    expect(secondId).toBe(firstId);
    const tokens = await t.run(async (ctx) =>
      ctx.db
        .query("pushTokens")
        .withIndex("by_mobile", (query) =>
          query.eq("mobileId", relayFixture.mobileId),
        )
        .collect(),
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      token: "apns-token-1",
      platform: "ios",
    });
  });

  test("session completion notification is marked only for mobile-started sessions", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await t.mutation(api.sessions.upsertSession, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      status: "running",
      agentState: "working",
      executionMode: "stream-json",
      startedByMobileId: relayFixture.mobileId,
      notifyOnExit: true,
    });
    await t.mutation(api.sessions.upsertSession, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      status: "exited",
      agentState: "exited",
      executionMode: "stream-json",
    });

    const mobileStarted = await t.run(async (ctx) =>
      ctx.db
        .query("sessions")
        .withIndex("by_device_session", (query) =>
          query
            .eq("deviceId", relayFixture.deviceId)
            .eq("sessionId", relayFixture.sessionId),
        )
        .unique(),
    );
    expect(mobileStarted?.startedByMobileId).toBe(relayFixture.mobileId);
    expect(mobileStarted?.notifyOnExit).toBe(true);
    expect(mobileStarted?.notifiedExitAt).toEqual(expect.any(Number));

    await t.mutation(api.sessions.upsertSession, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: "desktop-origin-session",
      status: "running",
      agentState: "working",
      executionMode: "stream-json",
    });
    await t.mutation(api.sessions.upsertSession, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: "desktop-origin-session",
      status: "exited",
      agentState: "exited",
      executionMode: "stream-json",
    });

    const desktopStarted = await t.run(async (ctx) =>
      ctx.db
        .query("sessions")
        .withIndex("by_device_session", (query) =>
          query
            .eq("deviceId", relayFixture.deviceId)
            .eq("sessionId", "desktop-origin-session"),
        )
        .unique(),
    );
    expect(desktopStarted?.notifiedExitAt).toBeUndefined();
  });

  test("session starred state syncs through desktop and mobile mutations", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    await t.mutation(api.sessions.setStarredByMobile, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
      starred: true,
    });

    const list = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    expect(list[0]).toMatchObject({
      sessionId: relayFixture.sessionId,
      starred: true,
    });

    const desktopStars = await t.query(api.sessions.starredForDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
    });
    expect(desktopStars).toMatchObject([
      { sessionId: relayFixture.sessionId, starred: true },
    ]);

    await t.mutation(api.sessions.setStarredByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      starred: false,
    });

    const unstarred = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    expect(unstarred[0]).toMatchObject({
      sessionId: relayFixture.sessionId,
      starred: false,
    });
  });

  test("session list joins archive state only for rows in its visible window", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    await t.mutation(api.sessions.setArchivedByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      archived: true,
    });
    // Archive flags for dormant/unmirrored sections are legitimate, but must
    // not be bulk-joined into the mobile's bounded session window.
    await t.mutation(api.sessions.setArchivedByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: "not-in-session-window",
      archived: true,
    });

    await expect(
      t.query(api.sessions.list, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      }),
    ).resolves.toMatchObject([
      { sessionId: relayFixture.sessionId, archived: true },
    ]);
  });

  test("the session list windows on recent activity and never drops a pin", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    const base = Date.now();
    const touch = async (
      sessionId: string,
      at: number,
      agentState: "working" | "waiting" = "working",
    ) => {
      vi.setSystemTime(at);
      await t.mutation(api.sessions.upsertSession, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        sessionId,
        status: "running",
        agentState,
        executionMode: "stream-json",
      });
    };

    // Three threads that first streamed long ago, then a flood of newer ones —
    // enough that creation order alone would bury all three.
    await touch("old-active", base);
    await touch("old-pinned", base + 1);
    await touch("old-quiet", base + 2);
    await t.mutation(api.sessions.setStarredByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: "old-pinned",
      starred: true,
    });
    for (let i = 0; i < SESSION_LIST_LIMIT; i += 1) {
      await touch(`filler-${i}`, base + 10 + i);
    }
    // ...and one of them is picked up again right now.
    await touch("old-active", base + 10 + SESSION_LIST_LIMIT, "waiting");

    const list = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    const ids = list.map((row) => row.sessionId);
    // Used most recently -> top of the window, despite being the oldest row.
    expect(ids[0]).toBe("old-active");
    // Quiet but pinned -> pulled in from outside the window.
    expect(ids).toContain("old-pinned");
    // Quiet and unpinned -> correctly out of the window.
    expect(ids).not.toContain("old-quiet");
    expect(list).toHaveLength(SESSION_LIST_LIMIT + 1);
  });

  test("stars live off the session row, so pinning never dirties it", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    const readSession = () =>
      t.run((ctx) =>
        ctx.db
          .query("sessions")
          .withIndex("by_device_session", (q) =>
            q.eq("deviceId", relayFixture.deviceId).eq("sessionId", relayFixture.sessionId),
          )
          .unique(),
      );
    const before = await readSession();

    await t.mutation(api.sessions.setStarredByMobile, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
      starred: true,
    });

    // The desktop subscribes to `starredForDevice` for its whole run. If a star
    // wrote the session row, that subscription's read set (and the mobile list's)
    // would be invalidated by every pin — and vice versa, every status transition
    // would re-read all ~100 session documents to answer a question about stars.
    const after = await readSession();
    expect(after).toEqual(before);
    expect(after?.starred).toBeUndefined();

    const stars = await t.run((ctx) => ctx.db.query("sessionStars").collect());
    expect(stars).toMatchObject([
      { deviceId: relayFixture.deviceId, sessionId: relayFixture.sessionId, starred: true },
    ]);
  });

  test("the star backfill moves pre-split state off the session row", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    const starredAt = Date.now() - 1_000;
    await t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_device_session", (q) =>
          q.eq("deviceId", relayFixture.deviceId).eq("sessionId", relayFixture.sessionId),
        )
        .unique();
      await ctx.db.patch(session!._id, { starred: true, starredAt });
    });

    const result = await t.mutation(internal.maintenance.migrateSessionStars, {});
    expect(result).toMatchObject({ migrated: 1, starsWritten: 1, isDone: true });

    const session = await t.run((ctx) =>
      ctx.db
        .query("sessions")
        .withIndex("by_device_session", (q) =>
          q.eq("deviceId", relayFixture.deviceId).eq("sessionId", relayFixture.sessionId),
        )
        .unique(),
    );
    expect(session?.starred).toBeUndefined();
    expect(session?.starredAt).toBeUndefined();

    // The pin survives the move, in both directions.
    await expect(
      t.query(api.sessions.starredForDevice, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
      }),
    ).resolves.toMatchObject([{ sessionId: relayFixture.sessionId, starred: true, starredAt }]);
    const list = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    expect(list[0]).toMatchObject({ starred: true, starredAt });

    // Idempotent: a second pass has nothing left to move.
    await expect(
      t.mutation(internal.maintenance.migrateSessionStars, {}),
    ).resolves.toMatchObject({ migrated: 0, starsWritten: 0 });
  });

  test("the usage backfill moves the blob off the device row", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await t.run(async (ctx) => {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_device", (q) => q.eq("deviceId", relayFixture.deviceId))
        .unique();
      await ctx.db.patch(device!._id, { usageCipher: "cipher:legacy-usage" });
    });

    await expect(
      t.mutation(internal.maintenance.migrateDeviceUsage, {}),
    ).resolves.toMatchObject({ migrated: 1 });

    const device = await t.run((ctx) =>
      ctx.db
        .query("devices")
        .withIndex("by_device", (q) => q.eq("deviceId", relayFixture.deviceId))
        .unique(),
    );
    expect(device?.usageCipher).toBeUndefined();
    await expect(
      t.query(api.devices.status, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      }),
    ).resolves.toMatchObject({ usageCipher: "cipher:legacy-usage" });
  });

  test("the desktop can pin a section the relay has never seen", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    // Unlike a rename, a pin has somewhere to live without a routing row — and it
    // must, or pinning a dormant thread desktop-side would be silently dropped.
    await t.mutation(api.sessions.setStarredByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: "never-mirrored",
      starred: true,
    });

    await expect(
      t.query(api.sessions.starredForDevice, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
      }),
    ).resolves.toMatchObject([{ sessionId: "never-mirrored", starred: true }]);
    // Still invisible to the phone: a star is not a session.
    await expect(
      t.query(api.sessions.list, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
      }),
    ).resolves.toEqual([]);
  });

  test("the runtime badge has a write path that never reads the session row", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    await t.mutation(api.sessions.putRuntime, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      runtimeCipher: "cipher:badge",
    });

    await expect(
      t.query(api.sessions.runtime, {
        mobileId: relayFixture.mobileId,
        token: relayFixture.mobileToken,
        sessionId: relayFixture.sessionId,
      }),
    ).resolves.toMatchObject({ runtimeCipher: "cipher:badge" });

    // A badge refresh must not advance the tail cursor either.
    const runtimeRow = await t.run((ctx) =>
      ctx.db
        .query("sessionRuntime")
        .withIndex("by_device_session", (q) =>
          q.eq("deviceId", relayFixture.deviceId).eq("sessionId", relayFixture.sessionId),
        )
        .unique(),
    );
    expect(runtimeRow?.headSeq).toBe(0);
  });

  test("a desktop rename reaches the mobile list without touching status", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    await t.mutation(api.sessions.setTitleByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      titleCipher: "cipher:renamed",
    });

    const list = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    // The new name, and nothing else: a rename says nothing about whether the
    // section is running, so it must not restate status/agentState.
    expect(list[0]).toMatchObject({
      titleCipher: "cipher:renamed",
      status: "running",
      agentState: "working",
    });
  });

  test("renaming a session the relay has never seen creates nothing", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await t.mutation(api.sessions.setTitleByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: "never-mirrored",
      titleCipher: "cipher:renamed",
    });

    // Otherwise every rename of a long-dormant desktop section would surface it
    // on the phone as a brand-new row.
    const list = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    expect(list).toEqual([]);
  });

  test("a sub-thread link reaches the phone's list, and detaching clears it", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    await t.mutation(api.sessions.setParentByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      parentSessionId: "parent-section",
    });

    const nested = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    expect(nested[0]).toMatchObject({ parentSessionId: "parent-section", status: "running" });

    // Detaching is the absence of the argument. It has to be expressible, which
    // is the whole reason this is not folded into the (sticky) upsert.
    await t.mutation(api.sessions.setParentByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
    });

    const detached = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    expect(detached[0]?.parentSessionId).toBeUndefined();
  });

  test("re-parenting a session the relay has never seen creates nothing", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await t.mutation(api.sessions.setParentByDevice, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: "never-mirrored",
      parentSessionId: "parent-section",
    });

    const list = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    expect(list).toEqual([]);
  });

  test("appendEvents keeps seq monotonic, updates headSeq, and tail is cursor-only", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    await expect(
      t.mutation(api.sessions.appendEvents, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        sessionId: relayFixture.sessionId,
        events: [
          { kind: "user", payloadCipher: "cipher:event-1" },
          { kind: "assistant", payloadCipher: "cipher:event-2" },
        ],
      }),
    ).resolves.toEqual({ headSeq: 2 });
    await expect(
      t.mutation(api.sessions.appendEvents, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        sessionId: relayFixture.sessionId,
        events: [
          { kind: "tool", payloadCipher: "cipher:event-3" },
          { kind: "system", payloadCipher: "cipher:event-4" },
          { kind: "marker", payloadCipher: "cipher:event-5" },
        ],
      }),
    ).resolves.toEqual({ headSeq: 5 });

    const stored = await t.run(async (ctx) => {
      const runtime = await ctx.db
        .query("sessionRuntime")
        .withIndex("by_device_session", (query) =>
          query
            .eq("deviceId", relayFixture.deviceId)
            .eq("sessionId", relayFixture.sessionId),
        )
        .unique();
      const events = await ctx.db
        .query("events")
        .withIndex("by_device_session_seq", (query) =>
          query
            .eq("deviceId", relayFixture.deviceId)
            .eq("sessionId", relayFixture.sessionId),
        )
        .collect();
      return { runtime, events };
    });
    // The head cursor now lives on the `sessionRuntime` row, not `sessions`.
    expect(stored.runtime?.headSeq).toBe(5);
    expect(stored.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);

    const tail = await t.query(api.sessions.tail, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
      afterSeq: 3,
    });
    expect(tail.map((event) => event.seq)).toEqual([4, 5]);

    const firstHistoryPage = await t.query(api.sessions.history, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
      beforeSeq: 4,
      limit: 2,
    });
    expect(firstHistoryPage.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(firstHistoryPage).toMatchObject({ nextBeforeSeq: 2, isDone: false });

    const finalHistoryPage = await t.query(api.sessions.history, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
      beforeSeq: firstHistoryPage.nextBeforeSeq ?? undefined,
      limit: 2,
    });
    expect(finalHistoryPage.events.map((event) => event.seq)).toEqual([1]);
    expect(finalHistoryPage).toMatchObject({ nextBeforeSeq: null, isDone: true });
  });

  test("runtime churn updates sessionRuntime without rewriting the sessions row or list", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    const auth = { deviceId: relayFixture.deviceId, token: relayFixture.deviceToken };
    const slow = {
      ...auth,
      sessionId: relayFixture.sessionId,
      status: "running" as const,
      agentState: "working" as const,
      executionMode: "stream-json" as const,
      titleCipher: "cipher:title",
    };

    await t.mutation(api.sessions.upsertSession, slow);
    const readSession = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("sessions")
          .withIndex("by_device_session", (q) =>
            q.eq("deviceId", relayFixture.deviceId).eq("sessionId", relayFixture.sessionId),
          )
          .unique(),
      );
    const before = await readSession();

    // Two runtime-only upserts: identical low-churn state, fresh runtime badge.
    // These are the per-tick writes that used to re-fire `list`.
    await t.mutation(api.sessions.upsertSession, { ...slow, runtimeCipher: "cipher:rt-1" });
    await t.mutation(api.sessions.upsertSession, { ...slow, runtimeCipher: "cipher:rt-2" });
    const after = await readSession();

    // The `sessions` row (what `list` reads) is NOT rewritten by runtime churn —
    // the dirty-check skips the patch, so `list` never re-fires on these ticks.
    expect(after?._creationTime).toBe(before?._creationTime);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.runtimeCipher).toBeUndefined();

    // The badge lands on `sessionRuntime` and is served by `sessions:runtime`.
    const runtimeQuery = await t.query(api.sessions.runtime, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
    });
    expect(runtimeQuery.runtimeCipher).toBe("cipher:rt-2");

    // `list` stays lean: it never ships the runtime blob.
    const list = await t.query(api.sessions.list, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
    });
    const row = list.find((r) => r.sessionId === relayFixture.sessionId);
    expect(row).toBeDefined();
    expect((row as Record<string, unknown>).runtimeCipher).toBeUndefined();

    // A genuine lifecycle change DOES rewrite the sessions row (legit list re-fire).
    await t.mutation(api.sessions.upsertSession, {
      ...slow,
      agentState: "waiting",
      runtimeCipher: "cipher:rt-3",
    });
    const settled = await readSession();
    expect(settled?.agentState).toBe("waiting");
    expect(settled?.updatedAt).not.toBe(before?.updatedAt);
  });

  test("tail never crosses device ownership even when session ids collide", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);

    await enrollDevice(t, {
      deviceId: "device-2",
      token: "second-desktop-token-with-high-entropy-fixture",
      name: "Other Mac",
      platform: "darwin",
    });
    await t.mutation(api.sessions.upsertSession, {
      deviceId: "device-2",
      token: "second-desktop-token-with-high-entropy-fixture",
      sessionId: relayFixture.sessionId,
      status: "running",
      agentState: "working",
      executionMode: "stream-json",
    });

    // The mobile is paired to device-1, so device-2's identically-named session
    // is invisible: tail scopes to the mobile's own device and returns no events
    // rather than leaking the other desktop's stream.
    const tail = await t.query(api.sessions.tail, {
      mobileId: relayFixture.mobileId,
      token: relayFixture.mobileToken,
      sessionId: relayFixture.sessionId,
      afterSeq: 0,
    });
    expect(tail).toEqual([]);
  });

  test("pruning expires stale metadata and deletes retained payload rows in bounded batches", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t);

    const now = Date.now();
    const ids = await t.run(async (ctx) => {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_device", (query) =>
          query.eq("deviceId", relayFixture.deviceId),
        )
        .unique();
      if (!device) throw new Error("fixture device missing");
      await ctx.db.patch(device._id, {
        status: "online",
        lastHeartbeatAt: now - OFFLINE_AFTER_MS - 1,
      });

      const pairingId = await ctx.db.insert("pairings", {
        code: "stale-pairing",
        deviceId: relayFixture.deviceId,
        status: "pending",
        createdAt: now - 10_000,
        expiresAt: now - 1,
      });
      const eventId = await ctx.db.insert("events", {
        deviceId: relayFixture.deviceId,
        sessionId: relayFixture.sessionId,
        seq: 1,
        kind: "system",
        payloadCipher: "cipher:old-event",
        createdAt: now - EVENT_RETENTION_MS - 1,
      });
      const closedCommandId = await ctx.db.insert("commands", {
        deviceId: relayFixture.deviceId,
        mobileId: relayFixture.mobileId,
        type: "stop",
        status: "done",
        createdAt: now - CLOSED_COMMAND_RETENTION_MS - 1,
      });
      const pendingCommandId = await ctx.db.insert("commands", {
        deviceId: relayFixture.deviceId,
        mobileId: relayFixture.mobileId,
        type: "stop",
        status: "pending",
        createdAt: now - CLOSED_COMMAND_RETENTION_MS - 1,
      });
      return { deviceId: device._id, pairingId, eventId, closedCommandId, pendingCommandId };
    });

    await expect(t.mutation(internal.maintenance.pruneLive, {})).resolves.toEqual({
      expiredPairings: 1,
      offlineDevices: 1,
      // The fixture session is mid-turn, and its desktop just went dark: the
      // sweep closes it out so the phone stops spinning on it.
      demotedSessions: 1,
    });
    await expect(t.mutation(internal.maintenance.pruneSweep, {})).resolves.toEqual({
      deletedEvents: 1,
      deletedCommands: 1,
      expiredCommands: 1,
      deletedBudgets: 0,
      deletedBlobs: 0,
    });

    const state = await t.run(async (ctx) => ({
      device: await ctx.db.get(ids.deviceId),
      pairing: await ctx.db.get(ids.pairingId),
      event: await ctx.db.get(ids.eventId),
      closedCommand: await ctx.db.get(ids.closedCommandId),
      pendingCommand: await ctx.db.get(ids.pendingCommandId),
    }));
    expect(state.device?.status).toBe("offline");
    expect(state.pairing?.status).toBe("expired");
    expect(state.event).toBeNull();
    expect(state.closedCommand).toBeNull();
    expect(state.pendingCommand?.status).toBe("error");
  });

  test("a stranded session is demoted when its desktop goes dark", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t); // running / working, with a runtime badge
    await t.mutation(api.sessions.upsertSession, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: relayFixture.sessionId,
      status: "running",
      agentState: "working",
      executionMode: "stream-json",
      runtimeCipher: "cipher:runtime",
    });
    await t.run(async (ctx) => {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_device", (q) => q.eq("deviceId", relayFixture.deviceId))
        .unique();
      await ctx.db.patch(device!._id, {
        status: "online",
        lastHeartbeatAt: Date.now() - OFFLINE_AFTER_MS - 1,
      });
    });

    await t.mutation(internal.maintenance.pruneLive, {});

    const after = await t.run(async (ctx) => ({
      session: await ctx.db
        .query("sessions")
        .withIndex("by_device_session", (q) =>
          q.eq("deviceId", relayFixture.deviceId).eq("sessionId", relayFixture.sessionId),
        )
        .unique(),
      runtime: await ctx.db
        .query("sessionRuntime")
        .withIndex("by_device_session", (q) =>
          q.eq("deviceId", relayFixture.deviceId).eq("sessionId", relayFixture.sessionId),
        )
        .unique(),
    }));
    expect(after.session).toMatchObject({ status: "idle", agentState: "waiting" });
    // The phone prefers the runtime badge over the row, so a stale "working"
    // badge left behind would outvote the demotion.
    expect(after.runtime?.runtimeCipher).toBeUndefined();
  });

  test("a relaunched desktop reconciles everything it isn't running", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await upsertSession(t); // session-1: stranded by the previous run
    await t.mutation(api.sessions.upsertSession, {
      deviceId: relayFixture.deviceId,
      token: relayFixture.deviceToken,
      sessionId: "session-live",
      status: "running",
      agentState: "working",
      executionMode: "stream-json",
    });

    await expect(
      t.mutation(api.sessions.reconcileDevice, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        activeSessionIds: ["session-live"],
      }),
    ).resolves.toEqual({ demoted: 1 });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("sessions")
        .withIndex("by_device", (q) => q.eq("deviceId", relayFixture.deviceId))
        .collect(),
    );
    const byId = new Map(rows.map((row) => [row.sessionId, row]));
    expect(byId.get(relayFixture.sessionId)).toMatchObject({ agentState: "waiting" });
    expect(byId.get("session-live")).toMatchObject({ agentState: "working" });
  });

  test("reconcile reaches stranded sessions after a large idle history", async () => {
    const t = createRelayTest();
    await registerDevice(t);
    await pairMobile(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 225; i += 1) {
        await ctx.db.insert("sessions", {
          deviceId: relayFixture.deviceId,
          sessionId: `idle-${i}`,
          status: "idle",
          agentState: "waiting",
          executionMode: "stream-json",
          updatedAt: now - 10_000 + i,
        });
      }
      await ctx.db.insert("sessions", {
        deviceId: relayFixture.deviceId,
        sessionId: "newer-stranded",
        status: "running",
        agentState: "working",
        executionMode: "stream-json",
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(api.sessions.reconcileDevice, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        activeSessionIds: [],
      }),
    ).resolves.toEqual({ demoted: 1 });

    const stranded = await t.run((ctx) =>
      ctx.db
        .query("sessions")
        .withIndex("by_device_session", (q) =>
          q.eq("deviceId", relayFixture.deviceId).eq("sessionId", "newer-stranded"),
        )
        .unique(),
    );
    expect(stranded).toMatchObject({ status: "idle", agentState: "waiting" });
  });

  describe("appendEvents write budget", () => {
    /** Append `count` events of `bytes` each. Defaults stay well inside every cap. */
    function append(t: RelayTest, count: number, bytes = 16, sessionId: string = relayFixture.sessionId) {
      return t.mutation(api.sessions.appendEvents, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        sessionId,
        events: Array.from({ length: count }, () => ({
          kind: "assistant" as const,
          payloadCipher: "c".repeat(bytes),
        })),
      });
    }

    async function seed() {
      const t = createRelayTest();
      await registerDevice(t);
      await upsertSession(t);
      return t;
    }

    test("rejects an oversized batch before touching the database", async () => {
      const t = await seed();
      await expect(append(t, MAX_EVENTS_PER_APPEND + 1)).rejects.toThrow("EVENT_BATCH_TOO_LARGE");

      // Nothing was written, and — critically — no budget row was created, so a
      // rejected call cost the caller nothing.
      const budgets = await t.run(async (ctx) => ctx.db.query("deviceWriteBudget").collect());
      expect(budgets).toHaveLength(0);
    });

    test("rejects a single oversized payload", async () => {
      const t = await seed();
      await expect(append(t, 1, MAX_EVENT_PAYLOAD_BYTES + 1)).rejects.toThrow(
        "EVENT_PAYLOAD_TOO_LARGE",
      );
    });

    test("charges the budget per device and blocks once the event ceiling is hit", async () => {
      const t = await seed();
      await append(t, 10);
      await t.run(async (ctx) => {
        const row = await ctx.db.query("deviceWriteBudget").unique();
        // Park the device just under the ceiling rather than writing 20k events.
        await ctx.db.patch(row!._id, { events: EVENT_RATE_LIMIT_MAX_EVENTS - 2 });
      });

      await expect(append(t, 2)).resolves.toMatchObject({ headSeq: 12 });
      await expect(append(t, 1)).rejects.toThrow("EVENT_RATE_LIMITED");
    });

    test("blocks on the byte ceiling even when the event count is small", async () => {
      const t = await seed();
      await t.run(async (ctx) => {
        await ctx.db.insert("deviceWriteBudget", {
          deviceId: relayFixture.deviceId,
          windowStartedAt: Date.now(),
          events: 0,
          bytes: EVENT_RATE_LIMIT_MAX_BYTES - 8,
        });
      });
      await expect(append(t, 1, 9)).rejects.toThrow("EVENT_RATE_LIMITED");
      await expect(append(t, 1, 8)).resolves.toMatchObject({ headSeq: 1 });
    });

    test("the budget spans sessions — more sessions do not buy more allowance", async () => {
      const t = await seed();
      await t.mutation(api.sessions.upsertSession, {
        deviceId: relayFixture.deviceId,
        token: relayFixture.deviceToken,
        sessionId: "session-2",
        status: "running",
        agentState: "working",
        executionMode: "stream-json",
      });
      await t.run(async (ctx) => {
        await ctx.db.insert("deviceWriteBudget", {
          deviceId: relayFixture.deviceId,
          windowStartedAt: Date.now(),
          events: EVENT_RATE_LIMIT_MAX_EVENTS,
          bytes: 0,
        });
      });
      // Exhausted on session-1, so a fresh session gets nothing.
      await expect(append(t, 1, 16, "session-2")).rejects.toThrow("EVENT_RATE_LIMITED");
    });

    test("the window rolls over, restoring the full allowance", async () => {
      const t = await seed();
      await t.run(async (ctx) => {
        await ctx.db.insert("deviceWriteBudget", {
          deviceId: relayFixture.deviceId,
          windowStartedAt: Date.now() - EVENT_RATE_LIMIT_WINDOW_MS - 1,
          events: EVENT_RATE_LIMIT_MAX_EVENTS,
          bytes: EVENT_RATE_LIMIT_MAX_BYTES,
        });
      });
      await expect(append(t, 3)).resolves.toMatchObject({ headSeq: 3 });

      const row = await t.run(async (ctx) => ctx.db.query("deviceWriteBudget").unique());
      expect(row).toMatchObject({ events: 3 });
      expect(row!.bytes).toBe(48);
    });

    test("a rejected append does not consume allowance", async () => {
      const t = await seed();
      await append(t, 5);
      await expect(
        append(t, 5, 16, "session-does-not-exist"),
      ).rejects.toThrow("SESSION_NOT_FOUND");

      const row = await t.run(async (ctx) => ctx.db.query("deviceWriteBudget").unique());
      expect(row).toMatchObject({ events: 5 });
    });

    test("prune drops budget rows that can no longer affect a decision", async () => {
      const t = await seed();
      await append(t, 1);
      await t.run(async (ctx) => {
        const row = await ctx.db.query("deviceWriteBudget").unique();
        await ctx.db.patch(row!._id, {
          windowStartedAt: Date.now() - WRITE_BUDGET_RETENTION_MS - 1,
        });
      });

      await expect(t.mutation(internal.maintenance.pruneSweep, {})).resolves.toMatchObject({
        deletedBudgets: 1,
      });
      expect(await t.run(async (ctx) => ctx.db.query("deviceWriteBudget").collect())).toHaveLength(0);
    });

    test("a fresh window is not pruned", async () => {
      const t = await seed();
      await append(t, 1);
      await expect(t.mutation(internal.maintenance.pruneSweep, {})).resolves.toMatchObject({
        deletedBudgets: 0,
      });
      expect(await t.run(async (ctx) => ctx.db.query("deviceWriteBudget").collect())).toHaveLength(1);
    });
  });
});
