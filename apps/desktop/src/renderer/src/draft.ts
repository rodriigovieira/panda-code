import type { PersistedThread } from "../../shared/ipc";

/**
 * The New Session route's thread id. Fixed and reserved rather than a fresh uuid
 * per draft, because the route has to be a stable *place*: the composer draft,
 * its attachments and its terminal tabs are all keyed by thread id, so a stable
 * id is what lets a shell opened there survive both an abandoned draft and a
 * promoted one. Not a uuid, so it can never collide with a real section.
 */
export const DRAFT_THREAD_ID = "new-session";

export function isDraftThread(thread: PersistedThread | undefined): boolean {
  return Boolean(thread?.draft);
}

/**
 * Persisted state must never carry the draft — it isn't a section yet, and an
 * abandoned composer coming back as a real section after a reload is the exact
 * failure the draft route exists to remove.
 */
export function persistableThreads(threads: PersistedThread[]): PersistedThread[] {
  return threads.filter((thread) => !thread.draft);
}

/**
 * Drop sections that never became anything: no prompt was ever sent and no agent
 * session id was ever resolved, so there is no transcript to lose. These are the
 * residue of the old create-then-maybe-use flow — every "+" click and every phone
 * `start` that arrived without a prompt left one behind.
 *
 * A star or a hand-typed name means the user did something deliberate with it, so
 * those stay regardless.
 */
export function isSectionWorthKeeping(thread: PersistedThread): boolean {
  if (thread.lastPromptAt) return true;
  if (thread.claudeSessionId || thread.codexThreadId) return true;
  if (thread.starred) return true;
  if (thread.titleSource === "manual") return true;
  return thread.title !== "Untitled" && thread.title !== "New session";
}
