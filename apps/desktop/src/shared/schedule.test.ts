import { describe, expect, it } from "vitest";
import {
  addScheduledTask,
  computeNextRun,
  deleteScheduledTask,
  describeFrequency,
  dueScheduledTasks,
  emptySchedule,
  findScheduledTask,
  markScheduledTaskRun,
  parseFrequency,
  parseSchedule,
  renderSchedule,
  scheduleFileName,
  updateScheduledTask,
  MAX_SCHEDULE_ITEMS,
  TITLE_CAP,
  type WorkspaceSchedule,
} from "./schedule";

const NOW = "2026-08-03T10:00:00.000Z";

function withTask(frequency: unknown = { type: "hourly", everyHours: 2 }): WorkspaceSchedule {
  const result = addScheduledTask(emptySchedule("/repo", NOW), { title: "Ping the queue", prompt: "Check the queue depth and report.", frequency }, NOW, "a");
  if (!result.ok) throw new Error(result.message);
  return result.schedule;
}

describe("parseFrequency", () => {
  it("accepts hourly, daily, and once shapes", () => {
    expect(parseFrequency({ type: "hourly", everyHours: 3 })).toEqual({ type: "hourly", everyHours: 3 });
    expect(parseFrequency({ type: "daily", time: "09:30" })).toEqual({ type: "daily", time: "09:30" });
    expect(parseFrequency({ type: "once", at: "2026-08-05T10:00:00.000Z" })).toEqual({ type: "once", at: "2026-08-05T10:00:00.000Z" });
  });

  it("clamps an out-of-range hourly interval instead of rejecting it", () => {
    expect(parseFrequency({ type: "hourly", everyHours: 0 })).toEqual({ type: "hourly", everyHours: 1 });
    expect(parseFrequency({ type: "hourly", everyHours: 9999 })).toEqual({ type: "hourly", everyHours: 24 * 7 });
  });

  it("refuses malformed input", () => {
    expect(parseFrequency({ type: "daily", time: "9:30" })).toBeUndefined();
    expect(parseFrequency({ type: "once", at: "not a date" })).toBeUndefined();
    expect(parseFrequency({ type: "weekly" })).toBeUndefined();
    expect(parseFrequency(undefined)).toBeUndefined();
  });
});

describe("computeNextRun", () => {
  it("hourly advances by the interval", () => {
    expect(computeNextRun({ type: "hourly", everyHours: 2 }, new Date(NOW))).toBe("2026-08-03T12:00:00.000Z");
  });

  it("daily rolls to tomorrow once today's time has passed", () => {
    // Local time, not UTC — "9am" means the user's 9am wherever they are.
    const now = new Date(2026, 7, 3, 10, 0, 0, 0);
    expect(computeNextRun({ type: "daily", time: "11:00" }, now)).toBe(new Date(2026, 7, 3, 11, 0, 0, 0).toISOString());
    expect(computeNextRun({ type: "daily", time: "09:00" }, now)).toBe(new Date(2026, 7, 4, 9, 0, 0, 0).toISOString());
  });

  it("once returns the timestamp only while it is still in the future", () => {
    expect(computeNextRun({ type: "once", at: "2026-08-05T10:00:00.000Z" }, new Date(NOW))).toBe("2026-08-05T10:00:00.000Z");
    expect(computeNextRun({ type: "once", at: "2026-08-01T10:00:00.000Z" }, new Date(NOW))).toBeUndefined();
  });
});

describe("addScheduledTask", () => {
  it("schedules a task and computes its next run", () => {
    const frequency = { type: "daily" as const, time: "09:00" };
    const result = addScheduledTask(emptySchedule("/repo", NOW), { title: "Nightly check", prompt: "Summarize today's changes.", frequency }, NOW, "a");
    expect(result.ok).toBe(true);
    expect(result.ok && result.item?.nextRunAt).toBe(computeNextRun(frequency, new Date(NOW)));
    expect(result.ok && result.item?.enabled).toBe(true);
  });

  it("records the agent that filed it", () => {
    const result = addScheduledTask(
      emptySchedule("/repo", NOW),
      { title: "Check relay health", prompt: "Look for errors.", frequency: { type: "hourly", everyHours: 1 }, createdBy: "agent", createdBySection: "Relay work" },
      NOW,
      "a",
    );
    expect(result.ok && result.item?.createdBy).toBe("agent");
    expect(result.ok && result.item?.createdBySection).toBe("Relay work");
  });

  it("refuses an empty title, empty prompt, or bad frequency", () => {
    expect(addScheduledTask(emptySchedule("/repo", NOW), { title: "  ", prompt: "x", frequency: { type: "hourly", everyHours: 1 } }, NOW).ok).toBe(false);
    expect(addScheduledTask(emptySchedule("/repo", NOW), { title: "x", prompt: "  ", frequency: { type: "hourly", everyHours: 1 } }, NOW).ok).toBe(false);
    expect(addScheduledTask(emptySchedule("/repo", NOW), { title: "x", prompt: "y", frequency: { type: "weekly" } }, NOW).ok).toBe(false);
  });

  it("refuses a `once` schedule in the past", () => {
    const result = addScheduledTask(emptySchedule("/repo", NOW), { title: "x", prompt: "y", frequency: { type: "once", at: "2026-08-01T00:00:00.000Z" } }, NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("future");
  });

  it("caps a runaway title", () => {
    const result = addScheduledTask(emptySchedule("/repo", NOW), { title: "x".repeat(TITLE_CAP + 50), prompt: "y", frequency: { type: "hourly", everyHours: 1 } }, NOW, "a");
    expect(result.ok && result.item?.title.length).toBe(TITLE_CAP);
  });

  it("stops filling once the workspace is full", () => {
    let schedule = emptySchedule("/repo", NOW);
    for (let index = 0; index < MAX_SCHEDULE_ITEMS; index += 1) {
      const result = addScheduledTask(schedule, { title: `task ${index}`, prompt: "x", frequency: { type: "hourly", everyHours: 1 } }, NOW, `id-${index}`);
      if (!result.ok) throw new Error(result.message);
      schedule = result.schedule;
    }
    const overflow = addScheduledTask(schedule, { title: "one too many", prompt: "x", frequency: { type: "hourly", everyHours: 1 } }, NOW);
    expect(overflow.ok).toBe(false);
  });
});

describe("updateScheduledTask", () => {
  it("changes fields left specified and leaves the rest", () => {
    const schedule = withTask();
    const result = updateScheduledTask(schedule, "a", { title: "Ping the queue (renamed)" }, NOW);
    expect(result.ok && result.item?.title).toBe("Ping the queue (renamed)");
    expect(result.ok && result.item?.prompt).toBe("Check the queue depth and report.");
  });

  it("re-arms nextRunAt when the frequency changes", () => {
    const schedule = withTask({ type: "hourly", everyHours: 2 });
    const later = "2026-08-03T11:00:00.000Z";
    const frequency = { type: "daily" as const, time: "09:00" };
    const result = updateScheduledTask(schedule, "a", { frequency }, later);
    expect(result.ok && result.item?.nextRunAt).toBe(computeNextRun(frequency, new Date(later)));
  });

  it("re-arms nextRunAt when a disabled task is re-enabled", () => {
    const schedule = withTask();
    const disabled = updateScheduledTask(schedule, "a", { enabled: false }, NOW);
    if (!disabled.ok) throw new Error(disabled.message);
    const later = "2026-08-03T15:00:00.000Z";
    const reenabled = updateScheduledTask(disabled.schedule, "a", { enabled: true }, later);
    expect(reenabled.ok && reenabled.item?.nextRunAt).toBe("2026-08-03T17:00:00.000Z");
  });

  it("refuses an unknown id", () => {
    expect(updateScheduledTask(emptySchedule("/repo", NOW), "nope", { title: "x" }, NOW).ok).toBe(false);
  });
});

describe("markScheduledTaskRun", () => {
  it("advances a recurring task's nextRunAt and records lastRunAt", () => {
    const schedule = withTask({ type: "hourly", everyHours: 2 });
    const firedAt = "2026-08-03T12:00:00.000Z";
    const result = markScheduledTaskRun(schedule, "a", firedAt);
    expect(result.ok && result.item?.lastRunAt).toBe(firedAt);
    expect(result.ok && result.item?.nextRunAt).toBe("2026-08-03T14:00:00.000Z");
    expect(result.ok && result.item?.enabled).toBe(true);
  });

  it("disables a `once` task after it fires, clearing nextRunAt", () => {
    const schedule = withTask({ type: "once", at: "2026-08-05T10:00:00.000Z" });
    const result = markScheduledTaskRun(schedule, "a", "2026-08-05T10:00:00.000Z");
    expect(result.ok && result.item?.enabled).toBe(false);
    expect(result.ok && result.item?.nextRunAt).toBeUndefined();
  });
});

describe("dueScheduledTasks", () => {
  it("returns only enabled tasks whose nextRunAt has arrived", () => {
    const schedule = withTask({ type: "hourly", everyHours: 1 });
    expect(dueScheduledTasks(schedule, new Date(NOW))).toHaveLength(0);
    expect(dueScheduledTasks(schedule, new Date("2026-08-03T11:00:00.000Z"))).toHaveLength(1);
  });

  it("skips disabled tasks even if their time has arrived", () => {
    const schedule = withTask({ type: "hourly", everyHours: 1 });
    const disabled = updateScheduledTask(schedule, "a", { enabled: false }, NOW);
    if (!disabled.ok) throw new Error(disabled.message);
    expect(dueScheduledTasks(disabled.schedule, new Date("2026-08-03T12:00:00.000Z"))).toHaveLength(0);
  });
});

describe("deleteScheduledTask / findScheduledTask", () => {
  it("deletes by id and matching later fails", () => {
    const schedule = withTask();
    const result = deleteScheduledTask(schedule, "a", NOW);
    expect(result.ok).toBe(true);
    expect(findScheduledTask(result.ok ? result.schedule : schedule, "a")).toBeUndefined();
  });

  it("matches an unambiguous title fragment", () => {
    const schedule = withTask();
    expect(findScheduledTask(schedule, "queue")?.id).toBe("a");
  });
});

describe("parseSchedule", () => {
  it("recovers an empty schedule from garbage rather than throwing", () => {
    expect(parseSchedule("not json", "/repo", NOW)).toEqual(emptySchedule("/repo", NOW));
    expect(parseSchedule("{}", "/repo", NOW).items).toEqual([]);
  });

  it("round-trips through JSON", () => {
    const schedule = withTask();
    const parsed = parseSchedule(JSON.stringify(schedule), "/repo", NOW);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.title).toBe("Ping the queue");
  });

  it("drops items missing a title, prompt, or valid frequency", () => {
    const raw = JSON.stringify({ version: 1, cwd: "/repo", items: [{ id: "a", title: "", prompt: "x", frequency: { type: "hourly", everyHours: 1 } }], updatedAt: NOW });
    expect(parseSchedule(raw, "/repo", NOW).items).toEqual([]);
  });
});

describe("describeFrequency", () => {
  it("reads naturally for each type", () => {
    expect(describeFrequency({ type: "hourly", everyHours: 1 })).toBe("every hour");
    expect(describeFrequency({ type: "hourly", everyHours: 3 })).toBe("every 3 hours");
    expect(describeFrequency({ type: "daily", time: "09:00" })).toBe("daily at 09:00");
  });
});

describe("renderSchedule", () => {
  it("says when nothing is scheduled", () => {
    expect(renderSchedule(emptySchedule("/repo", NOW))).toContain("empty");
  });

  it("lists a task with its short id and prompt", () => {
    const text = renderSchedule(withTask());
    expect(text).toContain("Ping the queue");
    expect(text).toContain("Check the queue depth and report.");
  });
});

describe("scheduleFileName", () => {
  it("encodes the cwd the same way the backlog does", () => {
    expect(scheduleFileName("/Users/me/repo")).toBe("-Users-me-repo.json");
  });
});
