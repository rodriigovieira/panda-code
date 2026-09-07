import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addScheduledTask,
  deleteScheduledTask,
  emptySchedule,
  markScheduledTaskRun,
  parseSchedule,
  scheduleFileName,
  updateScheduledTask,
  type ScheduleCreate,
  type SchedulePatch,
  type ScheduleResult,
  type WorkspaceSchedule,
} from "./schedule";

/**
 * The schedule's disk half — see `backlog-store.ts` for the rationale (file
 * based and app-free, so `schedule_add` from the MCP helper works even when
 * the desktop app's window is closed; only the in-process ticker needs the
 * app to be *running* at all).
 */

export type ScheduleStore = {
  path: (cwd: string) => string;
  read: (cwd: string) => WorkspaceSchedule;
  apply: (cwd: string, mutate: (schedule: WorkspaceSchedule) => ScheduleResult) => ScheduleResult;
};

export function createScheduleStore(directory: string): ScheduleStore {
  const path = (cwd: string): string => join(directory, scheduleFileName(cwd));

  const read = (cwd: string): WorkspaceSchedule => {
    const file = path(cwd);
    if (!existsSync(file)) {
      return emptySchedule(cwd);
    }
    try {
      return parseSchedule(readFileSync(file, "utf8"), cwd);
    } catch {
      return emptySchedule(cwd);
    }
  };

  const write = (cwd: string, schedule: WorkspaceSchedule): void => {
    const file = path(cwd);
    mkdirSync(directory, { recursive: true });
    const staging = `${file}.${process.pid}.tmp`;
    writeFileSync(staging, `${JSON.stringify(schedule, null, 2)}\n`, "utf8");
    renameSync(staging, file);
  };

  const apply = (cwd: string, mutate: (schedule: WorkspaceSchedule) => ScheduleResult): ScheduleResult => {
    const result = mutate(read(cwd));
    if (!result.ok) {
      return result;
    }
    try {
      write(cwd, result.schedule);
    } catch (error) {
      return { ok: false, message: `Could not save the schedule: ${String(error)}` };
    }
    return result;
  };

  return { path, read, apply };
}

export function storeAdd(store: ScheduleStore, cwd: string, input: ScheduleCreate): ScheduleResult {
  return store.apply(cwd, (schedule) => addScheduledTask(schedule, input));
}

export function storeUpdate(store: ScheduleStore, cwd: string, idOrTitle: string, patch: SchedulePatch): ScheduleResult {
  return store.apply(cwd, (schedule) => updateScheduledTask(schedule, idOrTitle, patch));
}

export function storeDelete(store: ScheduleStore, cwd: string, idOrTitle: string): ScheduleResult {
  return store.apply(cwd, (schedule) => deleteScheduledTask(schedule, idOrTitle));
}

export function storeMarkRun(store: ScheduleStore, cwd: string, id: string): ScheduleResult {
  return store.apply(cwd, (schedule) => markScheduledTaskRun(schedule, id));
}

/**
 * Every workspace schedule on disk, so the in-process ticker can scan all of
 * them each tick without knowing in advance which workspaces have ever had a
 * task created. The filename is a one-way hash of the cwd (`scheduleFileName`),
 * so the real cwd comes from the record each file carries, not the name.
 */
export function readAllSchedules(directory: string): WorkspaceSchedule[] {
  if (!existsSync(directory)) {
    return [];
  }
  const schedules: WorkspaceSchedule[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json") || name.includes(".tmp")) {
      continue;
    }
    try {
      const text = readFileSync(join(directory, name), "utf8");
      const schedule = parseSchedule(text, "");
      if (schedule.cwd) {
        schedules.push(schedule);
      }
    } catch {
      // Skip a file that failed to read; the next tick tries again.
    }
  }
  return schedules;
}
