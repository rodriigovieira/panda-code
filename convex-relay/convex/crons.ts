import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Every minute, because this is what notices a desktop that died mid-turn and
// demotes its stranded sessions — a phone left staring at a spinner for five
// minutes reads as a hang. Deliberately narrow: two small indexed ranges.
crons.interval("demote stranded relay state", { minutes: 1 }, internal.maintenance.pruneLive);

// The retention sweeps deal in rows that are a week (commands) to a month
// (events) past their expiry, so a minute-by-minute cadence bought nothing and
// cost fifteen times the reads. Batch caps, not the interval, bound the backlog.
crons.interval("prune expired relay state", { minutes: 15 }, internal.maintenance.pruneSweep);

crons.interval("prune private diagnostics and orphan media", { hours: 1 }, internal.maintenance.pruneSecurityArtifacts, {});

export default crons;
