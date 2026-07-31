import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Every minute, not every five: this sweep is also what notices a desktop that
// died mid-turn and demotes its stranded sessions, and a phone left staring at a
// spinner for five minutes reads as a hang. The work is bounded per run (see the
// *_PRUNE_BATCH caps), so the tighter cadence costs a few tiny reads.
crons.interval("prune stale relay state", { minutes: 1 }, internal.maintenance.prune);

export default crons;
