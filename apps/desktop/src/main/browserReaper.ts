/**
 * Sleeping — dropping an idle tab's page and bringing it back on next use.
 *
 * The same policy `sessionReaper` applies to agent processes, applied to web
 * pages, and for the same reason: every open tab is a full renderer process.
 * Measured on this machine with `vmmap --summary` (physical footprint, the
 * number Activity Monitor shows): a tab holding a real single-page app sits at
 * **203 MB**, a light page at ~30 MB, against a main app renderer of 269 MB. Two
 * or three working tabs cost more than the entire rest of the app.
 *
 * Nothing used to release one. A tab lived until somebody closed it, so a day of
 * agents opening pages accumulated processes exactly the way live sections used
 * to — and after tabs became section-scoped the ceiling stopped being twelve
 * tabs and became twelve *per section*, which on an 8 GB machine is not a
 * ceiling at all.
 *
 * Three bounds, covering different failure modes:
 *
 *   - a **per-section cap** on how many tabs may exist (enforced at `open`),
 *   - an **awake cap** bounding how many pages are live at once across the whole
 *     app, which is the one that actually bounds memory, and
 *   - an **idle sweep** that gives memory back when you walk away, which neither
 *     cap ever does.
 *
 * A slept tab keeps its id, title and URL — it is still in the tab strip, just
 * greyed — and wakes by reloading when anything touches it. That is far cheaper
 * than a hibernated section: a page reload, not a model round trip. Which is why
 * the idle timeout here is deliberately shorter than the session one.
 *
 * This module is only the choice of victims; the sleeping itself lives in
 * `browserService`. Keeping it pure is what makes the edge cases testable, and
 * the edge cases are the whole difficulty — sleeping the wrong tab doesn't save
 * memory, it interrupts the thing the user is looking at.
 */

/**
 * The same idea applied to disk: captures on disk are also unbounded.
 *
 * Nothing ever deleted a screenshot. Every `browser_screenshot` writes a PNG —
 * up to half a megabyte of one — and every recording writes a directory of
 * frames plus an mp4, and they sat there until somebody noticed. A screenshot
 * is written to be read once, by the agent that took it, within the same turn;
 * what it needs is to survive long enough for the user to click the path in
 * that turn's message, not forever. Backlog attachments are safe from this:
 * attaching copies the bytes into the board's own directory.
 */

/** One thing in the shots directory: a loose capture, or a recording's folder. */
export type ShotEntry = {
  /** Absolute path, which is what the caller gets back and unlinks. */
  path: string;
  /** Epoch ms it was written. */
  writtenAt: number;
  /** A recording folder rather than a single PNG — deleted as a tree. */
  directory?: boolean;
};

export type ShotEvictionInput = {
  entries: ShotEntry[];
  /** Newest captures to keep regardless of age; 0 disables the cap. */
  keep: number;
  /** Nothing younger than this is ever deleted, cap or no cap. */
  graceMs: number;
  now: number;
  /** Frames are being written into this one right now. */
  activeDirectory?: string;
};

/**
 * Choose which captures to delete: everything past the newest `keep`, except
 * anything still inside its grace window.
 *
 * The grace window is what makes this safe to run on the hot path. A section
 * that takes forty screenshots in a burst — a recording's worth of stills, a
 * before/after sweep — would otherwise delete its own earlier captures out from
 * under the message that named their paths.
 */
export function selectShotEvictions(input: ShotEvictionInput): string[] {
  const { entries, keep, graceMs, now, activeDirectory } = input;
  if (keep <= 0) return [];
  return [...entries]
    .sort((a, b) => b.writtenAt - a.writtenAt)
    .slice(keep)
    .filter((entry) => now - entry.writtenAt >= graceMs && entry.path !== activeDirectory)
    .map((entry) => entry.path);
}

/** What the reaper needs to know about one live tab. */
export type LiveTab = {
  id: string;
  threadId: string;
  /** Epoch ms of the last thing anyone did to this tab. */
  lastUsedAt: number;
  /** Frames are being grabbed off it right now. */
  recording?: boolean;
  /** An agent left a note on it that the user has not cleared. */
  hasNote?: boolean;
  /** The page is mid-navigation. */
  loading?: boolean;
  /** Already asleep; nothing to reclaim. */
  asleep?: boolean;
};

export type TabEviction = { id: string; reason: "cap" | "idle" };

export type TabEvictionInput = {
  tabs: LiveTab[];
  /** Tabs that may be awake at once across the app; 0 disables the cap. */
  maxAwake: number;
  /** Idle time before a tab sleeps, in ms; 0 disables the sweep. */
  idleTimeoutMs: number;
  now: number;
  /**
   * The tab the user is looking at right now — the active tab of the section
   * they have open. Never a victim: it is on screen, and blanking a page
   * somebody is reading is not a memory optimisation.
   */
  visibleTabId?: string;
};

/**
 * Only a tab nobody is depending on can sleep.
 *
 * `recording` is mid-capture and sleeping it ends the recording with a truncated
 * file. A tab carrying an unresolved note is the browser's equivalent of
 * `needs_action`: an agent has stopped and handed that exact page to the user,
 * and the user has not come back to it yet — dropping it would blank the thing
 * they were asked to look at. `loading` is mid-navigation, where sleeping would
 * throw away a request already in flight.
 */
function isEligible(tab: LiveTab, visibleTabId?: string): boolean {
  return !tab.asleep && !tab.recording && !tab.hasNote && !tab.loading && tab.id !== visibleTabId;
}

/**
 * Coldest first, by last use.
 *
 * Unlike sections — where the last *prompt* tracks the user's attention better
 * than the last output — a tab has only one clock: when it was last touched, by
 * either driver. An agent reading a page and a user scrolling it are the same
 * kind of evidence that the page still matters.
 */
function byColdest(a: LiveTab, b: LiveTab): number {
  return a.lastUsedAt - b.lastUsedAt;
}

/**
 * Choose which tabs to put to sleep. Idle victims first, then as many more as
 * the awake cap requires.
 *
 * When every awake tab is ineligible the cap is knowingly exceeded: running over
 * it costs memory, but interrupting a recording — or blanking the page an agent
 * is waiting on the user for — costs the user something they cannot get back by
 * waiting.
 */
export function selectTabEvictions(input: TabEvictionInput): TabEviction[] {
  const { tabs, maxAwake, idleTimeoutMs, now, visibleTabId } = input;
  const evictions: TabEviction[] = [];
  const evicted = new Set<string>();

  if (idleTimeoutMs > 0) {
    for (const tab of tabs) {
      if (isEligible(tab, visibleTabId) && now - tab.lastUsedAt >= idleTimeoutMs) {
        evictions.push({ id: tab.id, reason: "idle" });
        evicted.add(tab.id);
      }
    }
  }

  if (maxAwake > 0) {
    // `awake` already excludes anything the idle sweep just took, so this counts
    // what would still be live afterwards.
    const awake = tabs.filter((tab) => !tab.asleep && !evicted.has(tab.id));
    let live = awake.length;
    for (const tab of [...awake].sort(byColdest)) {
      if (live <= maxAwake) break;
      if (!isEligible(tab, visibleTabId)) continue;
      evictions.push({ id: tab.id, reason: "cap" });
      evicted.add(tab.id);
      live -= 1;
    }
  }

  return evictions;
}
