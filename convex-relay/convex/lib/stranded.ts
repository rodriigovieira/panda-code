import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/**
 * How many in-flight candidates one sweep reads per state. A device with more
 * in-flight sessions than this gets the rest on the next sweep (the prune cron
 * re-runs, and the desktop reconciles again on its next launch).
 */
export const STRANDED_SWEEP_BATCH = 200;

/**
 * Demote the sessions a desktop left mid-flight.
 *
 * Nothing but the desktop ever writes a session's terminal state, so when the
 * app is force-quit / crashes / loses the machine mid-turn, its rows stay
 * `running`/`working` forever — the phone renders a spinner for a turn that
 * stopped happening, and no later event ever clears it (the desktop reloads
 * that thread as idle, so it has no transition to report). This is the sweep
 * that closes the gap, driven from two places:
 *
 *  - the prune cron, when a device's heartbeat goes stale (crash / laptop shut),
 *  - `sessions.reconcileDevice` at desktop launch, for everything not live in
 *    the freshly started app.
 *
 * The row goes to `idle` / `waiting` rather than `exited`: the thread still
 * exists on the Mac and picks right back up when the desktop is around — it is
 * just not working right now. `runtimeCipher` is cleared alongside, because the
 * phone's session view reads the runtime badge in preference to the row
 * (`runtime?.agentState ?? row.agentState`) and a stale "working" badge would
 * outvote the demotion we just made. Patching the row directly (rather than
 * going through `upsertSession`) is deliberate: a desktop that vanished did not
 * "finish a turn", and must not fire a Done push.
 */
export async function demoteStrandedSessions(
  ctx: MutationCtx,
  deviceId: string,
  keepSessionIds: Iterable<string> = [],
): Promise<number> {
  const keep = new Set(keepSessionIds);
  const rowsById = new Map<string, Doc<"sessions">>();
  const runningRows = await ctx.db
    .query("sessions")
    .withIndex("by_device_status", (q) => q.eq("deviceId", deviceId).eq("status", "running"))
    .take(STRANDED_SWEEP_BATCH);
  for (const row of runningRows) rowsById.set(row.sessionId, row);
  for (const agentState of ["working", "needs_action"] as const) {
    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_device_agent_state", (q) =>
        q.eq("deviceId", deviceId).eq("agentState", agentState),
      )
      .take(STRANDED_SWEEP_BATCH);
    for (const row of rows) rowsById.set(row.sessionId, row);
  }
  const now = Date.now();
  let demoted = 0;
  for (const row of rowsById.values()) {
    if (keep.has(row.sessionId)) continue;
    const stranded =
      row.status === "running" ||
      row.agentState === "working" ||
      row.agentState === "needs_action";
    if (!stranded) continue;
    // A row that already reached a terminal status keeps it — "exited" and
    // "error" are outcomes the desktop reported, and this sweep only clears the
    // in-flight states it never got to close.
    const terminal = row.status === "exited" || row.status === "error";
    await ctx.db.patch(row._id, {
      status: terminal ? row.status : "idle",
      agentState: terminal ? "exited" : "waiting",
      updatedAt: now,
    });
    const runtime = await ctx.db
      .query("sessionRuntime")
      .withIndex("by_device_session", (q) =>
        q.eq("deviceId", deviceId).eq("sessionId", row.sessionId),
      )
      .unique();
    if (runtime?.runtimeCipher !== undefined) {
      await ctx.db.patch(runtime._id, { runtimeCipher: undefined });
    }
    demoted += 1;
  }
  return demoted;
}
