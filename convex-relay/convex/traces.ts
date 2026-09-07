// Operator-only diagnostics. Never expose these handlers as public functions.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Dictation diagnostics.
 *
 * Three attempts at the "my transcript erases itself" bug were all reasoned
 * from the outside and all wrong, because the failure lives in a native
 * callback sequence that cannot be reproduced off-device. This streams the
 * actual sequence off the phone so it can be read rather than guessed.
 *
 * NO TRANSCRIPT TEXT CROSSES THIS BOUNDARY — see the schema comment. Events
 * carry character counts and the recogniser task generation, which is what
 * identifies the bug: the moment `committedLen` drops, and whether two task
 * generations were live when it did.
 */

const MAX_AGE_MS = 60 * 60 * 1000; // an hour is plenty to debug a session
const MAX_BATCH = 200;

export const append = internalMutation({
  args: {
    mobileId: v.string(),
    entries: v.array(
      v.object({
        ts: v.number(),
        seq: v.number(),
        event: v.string(),
        gen: v.optional(v.number()),
        baseLen: v.optional(v.number()),
        committedLen: v.optional(v.number()),
        partialLen: v.optional(v.number()),
        textLen: v.optional(v.number()),
        note: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { mobileId, entries }) => {
    for (const entry of entries.slice(0, MAX_BATCH)) {
      await ctx.db.insert("dictationTraces", { mobileId, ...entry });
    }

    // Prune inline so this table can never become another storage surprise.
    const cutoff = Date.now() - MAX_AGE_MS;
    const stale = await ctx.db
      .query("dictationTraces")
      .withIndex("by_mobile_ts", (q) => q.eq("mobileId", mobileId).lt("ts", cutoff))
      .take(MAX_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
  },
});

/** Newest-last, so the tail reads in the order things happened. */
export const recent = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("dictationTraces").order("desc").take(limit ?? 300);
    return rows.reverse().map((r) => ({
      ts: r.ts,
      seq: r.seq,
      event: r.event,
      gen: r.gen,
      base: r.baseLen,
      committed: r.committedLen,
      partial: r.partialLen,
      text: r.textLen,
      note: r.note,
    }));
  },
});

/** Wipe between reproduction attempts so a run reads clean. */
export const clear = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("dictationTraces").take(1000);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

/**
 * Performance diagnostics — same shape and lifecycle as the dictation trace
 * above ("this bug cannot be reproduced off-device, stream real numbers
 * instead of guessing"), applied to jank/timing samples. See schema.ts for
 * why this is a separate table rather than reusing dictationTraces.
 */

export const appendPerf = internalMutation({
  args: {
    mobileId: v.string(),
    entries: v.array(
      v.object({
        ts: v.number(),
        seq: v.number(),
        event: v.string(),
        durationMs: v.optional(v.number()),
        route: v.optional(v.string()),
        count: v.optional(v.number()),
        note: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { mobileId, entries }) => {
    for (const entry of entries.slice(0, MAX_BATCH)) {
      await ctx.db.insert("perfTraces", { mobileId, ...entry });
    }

    const cutoff = Date.now() - MAX_AGE_MS;
    const stale = await ctx.db
      .query("perfTraces")
      .withIndex("by_mobile_ts", (q) => q.eq("mobileId", mobileId).lt("ts", cutoff))
      .take(MAX_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
  },
});

/** Newest-last, so the tail reads in the order things happened. */
export const recentPerf = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("perfTraces").order("desc").take(limit ?? 300);
    return rows.reverse().map((r) => ({
      ts: r.ts,
      seq: r.seq,
      event: r.event,
      durationMs: r.durationMs,
      route: r.route,
      count: r.count,
      note: r.note,
    }));
  },
});

/** Wipe between reproduction attempts so a run reads clean. */
export const clearPerf = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("perfTraces").take(1000);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
