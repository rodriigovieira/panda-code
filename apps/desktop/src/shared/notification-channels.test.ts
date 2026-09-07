import { describe, expect, it } from "vitest";
import { agentAttentionAllowed, normalizeNotificationChannels, patchNotificationChannels, resolveNotificationChannels } from "./notification-channels";

describe("notification channels", () => {
  it("keeps desktop banners and agent attention independent in every combination", () => {
    for (const desktop of [false, true]) for (const agent of [false, true]) {
      const config = patchNotificationChannels(undefined, "session", { desktop, agent });
      expect(resolveNotificationChannels(config, "session")).toEqual({ desktop, agent });
      expect(agentAttentionAllowed(config, "session", false, false)).toBe(agent);
    }
  });
  it("preserves legacy defaults and per-section overrides across serialization", () => {
    const legacy = { desktop: false, agent: true, sessions: { one: { agent: false }, two: { desktop: true } } };
    expect(normalizeNotificationChannels(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
    expect(resolveNotificationChannels(legacy, "one")).toEqual({ desktop: false, agent: false });
    expect(resolveNotificationChannels(legacy, "two")).toEqual({ desktop: true, agent: true });
  });
  it("updates one channel without overwriting other channels or sections", () => {
    let config = patchNotificationChannels(undefined, "one", { desktop: false, agent: true });
    config = patchNotificationChannels(config, "two", { agent: true });
    config = patchNotificationChannels(config, "one", { agent: false });
    expect(resolveNotificationChannels(config, "one")).toEqual({ desktop: false, agent: false });
    expect(resolveNotificationChannels(config, "two")).toEqual({ desktop: true, agent: true });
  });
  it("allows explicit user attention requests even with all channels paused or disabled", () => {
    const config = patchNotificationChannels(undefined, "one", { desktop: false, agent: false });
    expect(agentAttentionAllowed(config, "one", false, false)).toBe(false);
    expect(agentAttentionAllowed(config, "one", true, true)).toBe(true);
    const enabled = patchNotificationChannels(config, "one", { agent: true });
    expect(agentAttentionAllowed(enabled, "one", true, false)).toBe(false);
  });
  it("ignores malformed persisted values instead of coercing them into enabled channels", () => {
    expect(normalizeNotificationChannels({ desktop: false, agent: "true", sessions: { one: { agent: "true", desktop: false } } }))
      .toEqual({ desktop: false, agent: false, sessions: { one: { desktop: false } } });
  });
});
