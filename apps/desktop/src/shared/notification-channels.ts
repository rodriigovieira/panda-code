/** Independent local delivery channels. Mobile subscriptions remain per phone. */
export type NotificationChannels = { desktop: boolean; agent: boolean };
export type NotificationChannelConfig = NotificationChannels & {
  sessions: Record<string, Partial<NotificationChannels>>;
};

export function normalizeNotificationChannels(value: unknown): NotificationChannelConfig {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const sessions: NotificationChannelConfig["sessions"] = Object.create(null);
  if (raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
    for (const [id, override] of Object.entries(raw.sessions)) {
      if (!override || typeof override !== "object") continue;
      const entry = override as Record<string, unknown>;
      sessions[id] = {
        ...(typeof entry.desktop === "boolean" ? { desktop: entry.desktop } : {}),
        ...(typeof entry.agent === "boolean" ? { agent: entry.agent } : {}),
      };
    }
  }
  return { desktop: raw.desktop !== false, agent: raw.agent === true, sessions };
}

export function resolveNotificationChannels(config: unknown, sessionId: string): NotificationChannels {
  const normalized = normalizeNotificationChannels(config);
  return {
    desktop: normalized.sessions[sessionId]?.desktop ?? normalized.desktop,
    agent: normalized.sessions[sessionId]?.agent ?? normalized.agent,
  };
}

export function patchNotificationChannels(config: unknown, sessionId: string | null, patch: Partial<NotificationChannels>): NotificationChannelConfig {
  const current = normalizeNotificationChannels(config);
  const safe = {
    ...(typeof patch.desktop === "boolean" ? { desktop: patch.desktop } : {}),
    ...(typeof patch.agent === "boolean" ? { agent: patch.agent } : {}),
  };
  if (sessionId === null) return { ...current, ...safe };
  return { ...current, sessions: { ...current.sessions, [sessionId]: { ...current.sessions[sessionId], ...safe } } };
}

export function agentAttentionAllowed(config: unknown, sessionId: string, paused: boolean, userRequested: boolean): boolean {
  return userRequested || (!paused && resolveNotificationChannels(config, sessionId).agent);
}
