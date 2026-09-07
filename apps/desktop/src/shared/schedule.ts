/**
 * Per-workspace scheduled tasks: recurring or one-off jobs that open a new
 * section with a starting prompt when they come due.
 *
 * Same shape of problem as the backlog (`backlog.ts`): work that belongs to the
 * workspace rather than to any one section, shared by the operator and by
 * every agent working in that folder. A human sets one up from the workspace
 * menu; an agent files one with `schedule_add` when asked to "check back on
 * this every morning" — either way the same file, the same board.
 *
 * The clock lives in the main process (see `scheduleRunner` wiring in
 * `index.ts`), not here: this module only knows how to compute *when* a task
 * is next due, never what time it is now unless told. Firing only happens
 * while the desktop app is running — there is no server-side compute behind
 * this, deliberately the same trade-off the backlog makes for the same reason.
 *
 * Pure module: no fs, no electron. The store (`schedule-store.ts`) owns the
 * disk and the renderer owns the pixels, so both can be tested without either.
 */

export function newScheduleId(): string {
  return globalThis.crypto.randomUUID();
}

/** Who set the job up. Agents get a badge so the user can tell. */
export type ScheduleAuthor = "user" | "agent";

export type ScheduleFrequency =
  | { type: "hourly"; everyHours: number }
  | { type: "daily"; time: string }
  | { type: "once"; at: string };

export type ScheduledTask = {
  id: string;
  cwd: string;
  title: string;
  /** The opening prompt sent to the new section when this fires. */
  prompt: string;
  frequency: ScheduleFrequency;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: ScheduleAuthor;
  createdBySection?: string;
  lastRunAt?: string;
  /** ISO timestamp of the next time this is due. Undefined once a `once` job has fired. */
  nextRunAt?: string;
};

export type WorkspaceSchedule = {
  version: 1;
  cwd: string;
  items: ScheduledTask[];
  updatedAt: string;
};

export const MAX_SCHEDULE_ITEMS = 200;
export const TITLE_CAP = 200;
export const PROMPT_CAP = 4_000;
export const MIN_HOURLY_INTERVAL = 1;
export const MAX_HOURLY_INTERVAL = 24 * 7;

export function emptySchedule(cwd: string, now = new Date().toISOString()): WorkspaceSchedule {
  return { version: 1, cwd, items: [], updatedAt: now };
}

function cap(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/**
 * Accept the shapes a human form or an agent tool call actually produces.
 * Unrecognized input returns undefined so the caller can say why.
 */
export function parseFrequency(value: unknown): ScheduleFrequency | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "hourly": {
      const everyHours = clampInt(record.everyHours, MIN_HOURLY_INTERVAL, MAX_HOURLY_INTERVAL);
      return everyHours === undefined ? undefined : { type: "hourly", everyHours };
    }
    case "daily": {
      const time = typeof record.time === "string" && TIME_RE.test(record.time) ? record.time : undefined;
      return time ? { type: "daily", time } : undefined;
    }
    case "once": {
      const at = typeof record.at === "string" ? record.at : undefined;
      if (!at || Number.isNaN(Date.parse(at))) {
        return undefined;
      }
      return { type: "once", at: new Date(at).toISOString() };
    }
    default:
      return undefined;
  }
}

function isFrequency(value: unknown): value is ScheduleFrequency {
  return parseFrequency(value) !== undefined;
}

/** When this frequency next comes due, strictly after `from`. `once` in the past has no next run. */
export function computeNextRun(frequency: ScheduleFrequency, from: Date = new Date()): string | undefined {
  switch (frequency.type) {
    case "hourly":
      return new Date(from.getTime() + frequency.everyHours * 60 * 60 * 1000).toISOString();
    case "daily": {
      // `time` is only ever constructed through `parseFrequency`, which already
      // validated the "HH:MM" shape — the fallbacks here are for the type checker.
      const [hoursText, minutesText] = frequency.time.split(":");
      const next = new Date(from);
      next.setHours(Number(hoursText ?? 0), Number(minutesText ?? 0), 0, 0);
      if (next.getTime() <= from.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      return next.toISOString();
    }
    case "once": {
      const at = new Date(frequency.at);
      return at.getTime() > from.getTime() ? at.toISOString() : undefined;
    }
  }
}

export function describeFrequency(frequency: ScheduleFrequency): string {
  switch (frequency.type) {
    case "hourly":
      return frequency.everyHours === 1 ? "every hour" : `every ${frequency.everyHours} hours`;
    case "daily":
      return `daily at ${frequency.time}`;
    case "once":
      return `once on ${new Date(frequency.at).toLocaleString()}`;
  }
}

function sanitizeItem(raw: unknown, now: string): ScheduledTask | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const title = cap(record.title, TITLE_CAP);
  const prompt = cap(record.prompt, PROMPT_CAP);
  const frequency = parseFrequency(record.frequency);
  if (!title || !prompt || !frequency) {
    return null;
  }

  return {
    id: typeof record.id === "string" && record.id ? record.id : newScheduleId(),
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    title,
    prompt,
    frequency,
    enabled: record.enabled !== false,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
    createdBy: record.createdBy === "agent" ? "agent" : "user",
    createdBySection: typeof record.createdBySection === "string" && record.createdBySection ? record.createdBySection : undefined,
    lastRunAt: typeof record.lastRunAt === "string" ? record.lastRunAt : undefined,
    nextRunAt: typeof record.nextRunAt === "string" ? record.nextRunAt : computeNextRun(frequency, now ? new Date(now) : new Date()),
  };
}

/** Read a board off disk without ever throwing — see `parseBacklog` for why. */
export function parseSchedule(text: string, cwd: string, now = new Date().toISOString()): WorkspaceSchedule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return emptySchedule(cwd, now);
  }
  if (!parsed || typeof parsed !== "object") {
    return emptySchedule(cwd, now);
  }

  const record = parsed as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const seen = new Set<string>();
  const items: ScheduledTask[] = [];
  for (const raw of rawItems) {
    const item = sanitizeItem(raw, now);
    if (!item || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    items.push(item);
    if (items.length >= MAX_SCHEDULE_ITEMS) {
      break;
    }
  }

  return {
    version: 1,
    cwd: typeof record.cwd === "string" && record.cwd ? record.cwd : cwd,
    items,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
  };
}

export type ScheduleCreate = {
  title: string;
  prompt: string;
  frequency: unknown;
  createdBy?: ScheduleAuthor;
  createdBySection?: string;
};

export type SchedulePatch = {
  title?: string;
  prompt?: string;
  frequency?: unknown;
  enabled?: boolean;
};

export type ScheduleResult =
  | { ok: true; schedule: WorkspaceSchedule; item?: ScheduledTask; message: string }
  | { ok: false; message: string };

function withItems(schedule: WorkspaceSchedule, items: ScheduledTask[], now: string): WorkspaceSchedule {
  return { ...schedule, items, updatedAt: now };
}

function frequencyErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") {
    return 'A schedule needs a frequency: { "type": "hourly", "everyHours": N }, { "type": "daily", "time": "HH:MM" }, or { "type": "once", "at": ISO-timestamp }.';
  }
  const type = (value as Record<string, unknown>).type;
  if (type === "once") {
    return "A one-off schedule's date must be a valid, future timestamp.";
  }
  return `Unrecognized or invalid frequency ${JSON.stringify(value)}.`;
}

export function addScheduledTask(
  schedule: WorkspaceSchedule,
  input: ScheduleCreate,
  now = new Date().toISOString(),
  id: string = newScheduleId(),
): ScheduleResult {
  const title = cap(input.title, TITLE_CAP);
  if (!title) {
    return { ok: false, message: "A scheduled task needs a non-empty title." };
  }
  const prompt = cap(input.prompt, PROMPT_CAP);
  if (!prompt) {
    return { ok: false, message: "A scheduled task needs a prompt describing what the new session should do." };
  }
  if (schedule.items.length >= MAX_SCHEDULE_ITEMS) {
    return { ok: false, message: `This workspace already has ${MAX_SCHEDULE_ITEMS} scheduled tasks. Remove some before adding more.` };
  }

  const frequency = parseFrequency(input.frequency);
  if (!frequency) {
    return { ok: false, message: frequencyErrorMessage(input.frequency) };
  }
  const nextRunAt = computeNextRun(frequency, new Date(now));
  if (frequency.type === "once" && !nextRunAt) {
    return { ok: false, message: "A one-off schedule's date must be in the future." };
  }

  const item: ScheduledTask = {
    id,
    cwd: schedule.cwd,
    title,
    prompt,
    frequency,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy === "agent" ? "agent" : "user",
    createdBySection: input.createdBySection ? cap(input.createdBySection, TITLE_CAP) : undefined,
    nextRunAt,
  };

  const items = [item, ...schedule.items];
  return {
    ok: true,
    schedule: withItems(schedule, items, now),
    item,
    message: `Scheduled "${item.title}" — ${describeFrequency(frequency)}.`,
  };
}

export function updateScheduledTask(
  schedule: WorkspaceSchedule,
  idOrTitle: string,
  patch: SchedulePatch,
  now = new Date().toISOString(),
): ScheduleResult {
  const found = findScheduledTask(schedule, idOrTitle);
  if (!found) {
    return { ok: false, message: noSuchItemMessage(schedule, idOrTitle) };
  }

  const title = patch.title === undefined ? found.title : cap(patch.title, TITLE_CAP);
  if (!title) {
    return { ok: false, message: "A scheduled task needs a non-empty title." };
  }
  const prompt = patch.prompt === undefined ? found.prompt : cap(patch.prompt, PROMPT_CAP);
  if (!prompt) {
    return { ok: false, message: "A scheduled task needs a non-empty prompt." };
  }

  let frequency = found.frequency;
  let rescheduled = false;
  if (patch.frequency !== undefined) {
    const parsed = parseFrequency(patch.frequency);
    if (!parsed) {
      return { ok: false, message: frequencyErrorMessage(patch.frequency) };
    }
    frequency = parsed;
    rescheduled = true;
  }

  const enabled = patch.enabled === undefined ? found.enabled : patch.enabled;
  // Re-arm from now whenever the schedule changed shape or was just switched on —
  // otherwise a stale `nextRunAt` from before the edit could fire immediately.
  const reArm = rescheduled || (enabled && !found.enabled);
  const nextRunAt = reArm ? computeNextRun(frequency, new Date(now)) : found.nextRunAt;

  const item: ScheduledTask = { ...found, title, prompt, frequency, enabled, nextRunAt, updatedAt: now };
  const items = schedule.items.map((candidate) => (candidate.id === found.id ? item : candidate));
  return { ok: true, schedule: withItems(schedule, items, now), item, message: `Updated "${item.title}".` };
}

/** Called by the scheduler right after a task fires: records the run and re-arms it. */
export function markScheduledTaskRun(schedule: WorkspaceSchedule, id: string, now = new Date().toISOString()): ScheduleResult {
  const found = schedule.items.find((item) => item.id === id);
  if (!found) {
    return { ok: false, message: noSuchItemMessage(schedule, id) };
  }

  const nextRunAt = computeNextRun(found.frequency, new Date(now));
  const item: ScheduledTask = {
    ...found,
    lastRunAt: now,
    updatedAt: now,
    // A `once` job has nothing left to wait for; leave it visible but spent
    // rather than deleting the record of what it did.
    enabled: found.frequency.type === "once" ? false : found.enabled,
    nextRunAt: found.frequency.type === "once" ? undefined : nextRunAt,
  };
  const items = schedule.items.map((candidate) => (candidate.id === found.id ? item : candidate));
  return { ok: true, schedule: withItems(schedule, items, now), item, message: `Ran "${item.title}".` };
}

export function deleteScheduledTask(schedule: WorkspaceSchedule, idOrTitle: string, now = new Date().toISOString()): ScheduleResult {
  const found = findScheduledTask(schedule, idOrTitle);
  if (!found) {
    return { ok: false, message: noSuchItemMessage(schedule, idOrTitle) };
  }
  const items = schedule.items.filter((item) => item.id !== found.id);
  return { ok: true, schedule: withItems(schedule, items, now), item: found, message: `Deleted "${found.title}".` };
}

function noSuchItemMessage(schedule: WorkspaceSchedule, idOrTitle: string): string {
  return schedule.items.length === 0
    ? `No scheduled task matches ${JSON.stringify(idOrTitle)} — there are none in this workspace yet.`
    : `No scheduled task matches ${JSON.stringify(idOrTitle)}. Call schedule_list to see the ids.`;
}

/** Same id/prefix/title matching as the backlog's `findBacklogItem`. */
export function findScheduledTask(schedule: WorkspaceSchedule, idOrTitle: string): ScheduledTask | undefined {
  const needle = idOrTitle.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  const exact = schedule.items.find((item) => item.id.toLowerCase() === needle);
  if (exact) {
    return exact;
  }
  const byPrefix = schedule.items.filter((item) => item.id.toLowerCase().startsWith(needle));
  if (byPrefix.length === 1) {
    return byPrefix[0];
  }
  const byTitle = schedule.items.filter((item) => item.title.toLowerCase().includes(needle));
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

/** Every enabled task whose `nextRunAt` has arrived, as of `now`. */
export function dueScheduledTasks(schedule: WorkspaceSchedule, now = new Date()): ScheduledTask[] {
  const nowIso = now.toISOString();
  return schedule.items.filter((item) => item.enabled && item.nextRunAt !== undefined && item.nextRunAt <= nowIso);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The schedule as an agent reads it — see `renderBacklog` for the same rationale. */
export function renderSchedule(schedule: WorkspaceSchedule): string {
  const lines: string[] = [`# Scheduled tasks — ${schedule.cwd}`];
  if (schedule.items.length === 0) {
    lines.push(
      "",
      "_empty_",
      "",
      "Nothing is scheduled yet. Add one with `schedule_add` when the user wants something to run later or on a recurring basis.",
    );
    return lines.join("\n");
  }

  lines.push("");
  for (const item of schedule.items) {
    lines.push(...renderScheduledTaskLine(item));
  }
  return lines.join("\n");
}

function renderScheduledTaskLine(item: ScheduledTask): string[] {
  const status = item.enabled ? describeFrequency(item.frequency) : "disabled";
  const lines = [`- **${item.title}** \`${shortId(item.id)}\` — ${status}`];
  const by = item.createdBy === "agent" ? `agent${item.createdBySection ? ` (${item.createdBySection})` : ""}` : "user";
  const next = item.nextRunAt ? `next run ${item.nextRunAt}` : "no next run";
  lines.push(`  - filed by ${by} · ${next}${item.lastRunAt ? ` · last ran ${item.lastRunAt}` : ""}`);
  lines.push(`  - prompt: ${item.prompt.replace(/\n+/g, " ")}`);
  return lines;
}

export function renderScheduledTaskDetail(item: ScheduledTask): string {
  return [
    `**${item.title}** \`${shortId(item.id)}\` · ${item.enabled ? describeFrequency(item.frequency) : "disabled"}`,
    `\n${item.prompt}`,
  ].join("\n");
}

/** Same encoding `backlogFileName` uses, so a schedule file can be matched to a folder by eye. */
export function scheduleFileName(cwd: string): string {
  return `${cwd.replace(/[^a-zA-Z0-9]/g, "-")}.json`;
}

export { isFrequency };
