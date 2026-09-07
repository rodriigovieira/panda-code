import type { AgentRuntime, AgentState } from "../shared/ipc";

/**
 * Hibernation — killing an idle agent process and bringing it back on the next
 * prompt via `claude --resume` / `thread/resume`.
 *
 * Every live section costs a full CLI process plus its MCP helper fork, held for
 * as long as the section exists. Measured with `vmmap --summary` (physical
 * footprint, which counts compressed pages — RSS badly understates an idle
 * section, reading 8 MB for a process whose real footprint is 216 MB): about a
 * 215 MB floor, rising to ~390 MB as the conversation grows, mean 281 MB across
 * 24 live sections. That was 6.6 GB on an 8 GB machine.
 *
 * Nothing used to release one: `stopSession` is only reachable from the stop
 * button or from closing a thread, so a day's work accumulated ~24 processes,
 * most idle for hours and all holding the sleep blocker awake. Two bounds fix
 * that, and they cover different failure modes:
 *
 *   - a **cap** on live sections bounds the worst case (all of them busy), and
 *   - an **idle timeout** releases memory when you walk away, which the cap
 *     alone never does.
 *
 * This module is only the choice of victims; the killing lives in index.ts.
 * Keeping it pure is what makes the edge cases below testable, and they are the
 * whole difficulty — an eviction that picks wrong doesn't waste memory, it
 * throws away a turn.
 *
 * Invariants a future edit here would break, none of them visible from this
 * file alone:
 *
 *  - **The caller must be able to resume what this picks.** `resumable` is not
 *    advisory. `hibernateSession` refuses a section with no claudeSessionId /
 *    thread id, so widening eligibility here doesn't free more memory, it just
 *    produces reaps that log `hibernated: false`.
 *  - **Eviction must stay invisible.** The teardown in sessionService deletes
 *    from `streamSessions` BEFORE the async `close` fires, so the exit handler
 *    takes its stale-exit branch and no `session:exit` reaches the UI. A section
 *    that surfaced as "exited" every time it was reaped would read as a crash.
 *  - **Reasons are load-bearing.** index.ts emits `session:hibernated` per
 *    eviction and the renderer drops that section's transcript on it. A new
 *    reason string needs the renderer to understand it.
 *  - **Returning more ids is never safer than returning fewer.** Every guard
 *    below (working, needs_action, background work, unresumable, drafted,
 *    exempt) protects work
 *    the user would lose. Exceeding the cap costs memory; a wrong pick costs a
 *    turn, and those are not the same currency.
 */

/** What the reaper needs to know about one live section. */
export type LiveSection = {
  id: string;
  runtime: AgentRuntime;
  agentState: AgentState;
  /**
   * Whether this section can be resumed after its process dies — a Claude
   * section needs its `claudeSessionId`, a Codex one its thread id. False for a
   * section whose agent hasn't answered yet, and evicting one of those would not
   * be hibernation but deletion.
   */
  resumable: boolean;
  /** Epoch ms of the last prompt the user sent this section. */
  lastPromptAt: number;
  /**
   * Whether the section's composer holds text (or attachments) the user has
   * written but not sent. Reported by the renderer, which is the only side that
   * knows — the draft never leaves the composer until it is submitted.
   *
   * A half-written prompt is the strongest signal of intent the app has: the
   * user is about to press Enter here. `lastPromptAt` cannot see it — someone
   * who has been reading a transcript and typing a reply for ten minutes looks,
   * by prompt time alone, exactly like someone who walked away.
   */
  hasUnsentDraft?: boolean;
  /**
   * Whether work the section spawned is still running even though the agent
   * itself has settled: a `run_in_background` subagent, or a background shell
   * (`git push`, a release script, a long build) that outlives the turn by
   * design.
   *
   * `agentState` cannot see this. Background cards are deliberately flagged so
   * they stop pinning the spinner at "working" — see `markBackgroundAgents` in
   * shared/stream-json.ts — which is right for the UI and exactly wrong here:
   * to the reaper the section reads as idle, and hibernating it kills the child
   * process mid-push. The turn resumes later and the output never comes back.
   */
  hasBackgroundWork?: boolean;
};

export type Eviction = { id: string; reason: "cap" | "idle" };

export type EvictionInput = {
  sections: LiveSection[];
  /** Maximum live sections; 0 disables the cap. */
  maxLive: number;
  /** Idle time before a section hibernates, in ms; 0 disables the sweep. */
  idleTimeoutMs: number;
  now: number;
  /**
   * Sections about to be spawned, counted against the cap before they exist.
   * Starting the (cap + 1)th section evicts as part of the launch rather than
   * after it, so the process count never actually crosses the ceiling.
   */
  incoming?: number;
  /**
   * Sections that must survive this pass. The section a launch is making room
   * for goes here: a restart of one that is already live counts as `incoming: 0`
   * and would otherwise be a legal victim of its own cap check — the reaper
   * would kill the process the caller is about to write a prompt to.
   */
  exempt?: readonly string[];
};

/**
 * Only a section sitting idle can be hibernated.
 *
 * `working` is mid-turn and killing it discards that turn's work. `needs_action`
 * is blocked on an approval or a question — the pending request lives in the
 * process, so killing it strands the section on a prompt nobody can answer.
 * `exited` has no process left to reclaim.
 *
 * A section with background work still running is ineligible for the same
 * reason `working` is — the turn is not over, only the part of it the spinner
 * can see. This holds against the cap too, not just the idle sweep: exceeding
 * the ceiling costs memory, killing a release mid-flight costs the release.
 */
function isEligible(section: LiveSection): boolean {
  return section.agentState === "waiting" && section.resumable && !section.hasBackgroundWork;
}

/**
 * Least-recently-prompted first, with unsent drafts held back to the end.
 *
 * Deliberately the last *prompt* and not the last output: a section that just
 * finished a long autonomous run has output the user hasn't read yet, and by
 * any activity-based ordering it would look freshly used while the section they
 * were actually reading looked stale. The prompt time tracks the user's
 * attention, which is what eviction should follow. (The sidebar learned the same
 * lesson — it sorts on `lastPromptAt`, never on a timestamp that replay bumps.)
 *
 * A section with a half-written prompt in it is still evictable — the cap is a
 * memory ceiling and something has to give — but it goes last, behind every
 * section the user has actually walked away from.
 */
function byLeastRecentlyPrompted(a: LiveSection, b: LiveSection): number {
  const draftRank = Number(Boolean(a.hasUnsentDraft)) - Number(Boolean(b.hasUnsentDraft));
  if (draftRank !== 0) return draftRank;
  return a.lastPromptAt - b.lastPromptAt;
}

/**
 * Choose which sections to hibernate. Idle victims are taken first, then as many
 * more as the cap requires. Sections holding an unsent draft are skipped by the
 * idle sweep and sorted last for the cap.
 *
 * When every live section is ineligible the cap is knowingly exceeded: running
 * over the ceiling costs memory, but interrupting a working turn — or evicting a
 * section that cannot come back — costs the user their work.
 */
export function selectEvictions(input: EvictionInput): Eviction[] {
  const { sections, maxLive, idleTimeoutMs, now, incoming = 0 } = input;
  const exempt = new Set(input.exempt ?? []);
  const evictions: Eviction[] = [];
  const evicted = new Set<string>();

  if (idleTimeoutMs > 0) {
    for (const section of sections) {
      // An unsent draft opts a section out of the idle sweep entirely. The sweep
      // is "the user walked away"; a composer with text in it says they did not,
      // and hibernating under a typed prompt would put a resume in front of the
      // one keystroke that was left.
      if (section.hasUnsentDraft) continue;
      if (!exempt.has(section.id) && isEligible(section) && now - section.lastPromptAt >= idleTimeoutMs) {
        evictions.push({ id: section.id, reason: "idle" });
        evicted.add(section.id);
      }
    }
  }

  if (maxLive > 0) {
    const survivors = sections.filter((section) => !evicted.has(section.id));
    const candidates = survivors
      .filter((section) => !exempt.has(section.id) && isEligible(section))
      .sort(byLeastRecentlyPrompted);
    let liveCount = survivors.length + incoming;
    for (const candidate of candidates) {
      if (liveCount <= maxLive) break;
      evictions.push({ id: candidate.id, reason: "cap" });
      evicted.add(candidate.id);
      liveCount -= 1;
    }
  }

  return evictions;
}
