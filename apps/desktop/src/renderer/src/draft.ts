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
 * Prompt history is a convenience index for `/prompts`, not an archive — the
 * transcript is the archive. Left uncapped it grew to 6.56 MB across 1690
 * sections (84% of threads.json), and since the whole store is re-serialized on
 * every `threads` change, that cost was paid on every keystroke-driven update.
 * One section had reached 735 prompts; another held 76 prompts in 1.0 MB
 * because whole pastes were stored verbatim. Hence two limits, not one: a count
 * and a per-entry text budget.
 */
export const MAX_PROMPT_HISTORY_ENTRIES = 50;
export const MAX_PROMPT_HISTORY_TEXT = 2000;

/**
 * Applied at the persistence boundary rather than where prompts are appended, so
 * that sections carrying years of accumulated history shrink on their next write
 * instead of needing a migration. In-memory state keeps the full list for the
 * lifetime of the window; only what reaches disk is trimmed.
 */
function trimPromptHistory(thread: PersistedThread): PersistedThread {
  const history = thread.promptHistory;
  if (!history?.length) return thread;

  const recent = history.length > MAX_PROMPT_HISTORY_ENTRIES ? history.slice(-MAX_PROMPT_HISTORY_ENTRIES) : history;
  let textTrimmed = false;
  const trimmed = recent.map((entry) => {
    if (entry.text.length <= MAX_PROMPT_HISTORY_TEXT) return entry;
    textTrimmed = true;
    return { ...entry, text: `${entry.text.slice(0, MAX_PROMPT_HISTORY_TEXT)}…` };
  });

  // Preserve identity when nothing changed: this runs on every persist, and a
  // fresh array each time would defeat downstream memoization for no reason.
  if (!textTrimmed && recent === history) return thread;
  return { ...thread, promptHistory: trimmed };
}

/**
 * Persisted state must never carry the draft — it isn't a section yet, and an
 * abandoned composer coming back as a real section after a reload is the exact
 * failure the draft route exists to remove.
 */
export function persistableThreads(threads: PersistedThread[]): PersistedThread[] {
  return threads.filter((thread) => !thread.draft).map(trimPromptHistory);
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
