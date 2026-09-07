import { execFile } from "node:child_process";
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import type { MachineProcess, MachineStats } from "./machine-stats";

/**
 * The probe behind `MachineStats`. Shells out once per metric, tolerates every
 * failure (a missing tool means a null field, never a rejected snapshot), and
 * caches briefly so three surfaces asking at once cost one `ps`.
 *
 * Node builtins only — no electron — because the MCP entry point
 * (`peers-entry.ts`) runs this in a plain Node process too.
 */

const run = promisify(execFile);
const PROCESS_LIMIT = 12;
/** Cheap enough to re-run, expensive enough not to on every keystroke. */
const CACHE_MS = 2_000;
const CPU_SAMPLE_MS = 180;

let cached: { at: number; stats: MachineStats } | null = null;
let inflight: Promise<MachineStats> | null = null;

/** Aggregate busy/idle jiffies across all cores. */
function cpuTimes(): { busy: number; idle: number } {
  let busy = 0;
  let idle = 0;
  for (const core of cpus()) {
    const { user, nice, sys, irq, idle: coreIdle } = core.times;
    busy += user + nice + sys + irq;
    idle += coreIdle;
  }
  return { busy, idle };
}

async function sampleCpuPct(): Promise<number | null> {
  try {
    const start = cpuTimes();
    await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_MS));
    const end = cpuTimes();
    const busy = end.busy - start.busy;
    const total = busy + (end.idle - start.idle);
    return total > 0 ? Math.round((busy / total) * 1000) / 10 : null;
  } catch {
    return null;
  }
}

/**
 * macOS memory, the way Activity Monitor means it. `os.freemem()` counts only
 * genuinely free pages, so on a healthy Mac it reads near zero and makes every
 * machine look like it is about to die — the number that predicts whether the
 * next process swaps is free + inactive + speculative + purgeable.
 */
export function parseVmStat(
  stdout: string,
): { availableBytes: number; compressedBytes: number; wiredBytes: number } | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number => {
    const match = new RegExp(`${label}:\\s+(\\d+)`).exec(stdout);
    return match ? Number(match[1]) : 0;
  };
  const available =
    pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
  return {
    availableBytes: available * pageSize,
    compressedBytes: pages("Pages occupied by compressor") * pageSize,
    // Kernel, drivers, page tables, network stack. Reported because it belongs
    // to no process and so appears in no row of the "heaviest by memory" list —
    // on an 8 GB box it is routinely 1.5 GB, which is the single largest reason
    // that list cannot be made to sum to the headline "used" figure.
    wiredBytes: pages("Pages wired down") * pageSize,
  };
}

/** `total = 6144.00M  used = 5091.94M  free = 1052.06M  (encrypted)` */
export function parseSwapUsage(stdout: string): { usedBytes: number; totalBytes: number } | null {
  const scale = (value: string, unit: string): number => {
    const factor = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : 1024;
    return Math.round(Number(value) * factor);
  };
  const total = /total\s*=\s*([\d.]+)([KMG])/.exec(stdout);
  const used = /used\s*=\s*([\d.]+)([KMG])/.exec(stdout);
  if (!total || !used) return null;
  return { usedBytes: scale(used[1]!, used[2]!), totalBytes: scale(total[1]!, total[2]!) };
}

/**
 * On macOS `/` is the sealed read-only system snapshot — a dozen GB that never
 * moves — so `df /` reports a reassuring 22% while the volume that actually
 * fills up, `/System/Volumes/Data`, is at 90%. Probe the data volume there and
 * fall back to `/` if it is missing (pre-Catalina, or a non-APFS root).
 *
 * What made this bug survive so long: both volumes live in one APFS container
 * and so share its free space, meaning the `Available` column — and therefore
 * the "44 GB free" half of the card — was right the whole time. Only the
 * percentage was wrong, and a card reading "22% used · 44 GB free" is internally
 * consistent enough to look like a small machine rather than a full one. Do not
 * "simplify" this back to a single `df /`.
 */
async function readDf(): Promise<string | null> {
  if (platform() === "win32") return null;
  if (platform() === "darwin") {
    const data = await readOptional("df", ["-kP", "/System/Volumes/Data"]);
    if (data) return data;
  }
  return readOptional("df", ["-kP", "/"]);
}

/**
 * `df -kP <mount>`, which prints a header and exactly one row for the one
 * filesystem asked about:
 *
 *     Filesystem     1024-blocks      Used Available Capacity  Mounted on
 *     /dev/disk3s5     482797652 407364036  46395988    90%    /System/Volumes/Data
 *
 * `-k` fixes the unit at 1K blocks and `-P` forces that single-line layout, so
 * the numeric columns are stable across macOS and Linux. Two consequences the
 * code below relies on: the row is the LAST line (the header is first), and the
 * numbers are matched positionally from the left because the mount point is
 * last precisely so it can contain slashes and spaces.
 */
export function parseDf(stdout: string): { usedPct: number; freeBytes: number } | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const match = /\s(\d+)\s+(\d+)\s+(\d+)%\s/.exec(`${line} `);
  if (!match) return null;
  return { usedPct: Number(match[3]), freeBytes: Number(match[2]) * 1024 };
}

/**
 * `ps -Ao pid=,ppid=,pcpu=,rss=,comm=`. The command column is last precisely
 * because it contains spaces (`/Applications/Panda Code.app/…/Panda Code Helper
 * (Renderer)`), so the four numeric columns are matched first and everything
 * after them is the name.
 */
export function parsePsTable(stdout: string, memTotalBytes: number): MachineProcess[] {
  const rows: MachineProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const rssBytes = Number(match[4]) * 1024;
    const full = match[5]!;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: (full.split("/").pop() || full).slice(0, 80),
      cpuPct: Math.round(Number(match[3]) * 10) / 10,
      rssBytes,
      memPct: memTotalBytes > 0 ? Math.round((rssBytes * 1000) / memTotalBytes) / 10 : 0,
    });
  }
  return rows;
}

/** Full argv for the handful of processes we are about to show, and only those. */
async function attachCommands(processes: MachineProcess[]): Promise<void> {
  const pids = [...new Set(processes.map((row) => row.pid))];
  if (pids.length === 0) return;
  try {
    const { stdout } = await run("ps", ["-o", "pid=,args=", "-p", pids.join(",")]);
    const byPid = new Map<number, string>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) byPid.set(Number(match[1]), match[2]!.slice(0, 300));
    }
    for (const row of processes) {
      const command = byPid.get(row.pid);
      if (command) row.command = command;
    }
  } catch {
    // argv is a nicety; the row still says pid, name, CPU and RSS without it.
  }
}

async function readProcesses(memTotalBytes: number): Promise<MachineProcess[]> {
  const args =
    platform() === "darwin"
      ? ["-Ao", "pid=,ppid=,pcpu=,rss=,comm=", "-r"]
      : ["-eo", "pid=,ppid=,pcpu=,rss=,comm=", "--sort=-pcpu"];
  const { stdout } = await run("ps", args, { maxBuffer: 8 * 1024 * 1024 });
  return parsePsTable(stdout, memTotalBytes);
}

async function readOptional(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(file, args);
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Walk each process up its parent chain until it hits a known section root, so
 * a `tsc` three levels under a section's shell is still attributed to it. The
 * chain is bounded by the map itself (pid 0/1 terminate it) and by a hop limit,
 * because a corrupt `ps` read must not spin here.
 */
export function attributeSessions(
  processes: MachineProcess[],
  ownerPids: ReadonlyMap<number, string>,
): void {
  if (ownerPids.size === 0) return;
  const parents = new Map(processes.map((row) => [row.pid, row.ppid]));
  for (const row of processes) {
    let pid: number | undefined = row.pid;
    for (let hop = 0; hop < 24 && pid !== undefined && pid > 1; hop += 1) {
      const owner = ownerPids.get(pid);
      if (owner) {
        row.sessionId = owner;
        if (pid === row.pid) row.sessionRoot = true;
        break;
      }
      pid = parents.get(pid);
    }
  }
}

/** How many spawned commands the snapshot carries; more than this is a list nobody reads. */
const SECTION_COMMAND_LIMIT = 24;

/**
 * The commands the sections started, one row each.
 *
 * A row is a DIRECT child of a section's agent CLI — `sh -c pnpm build`, not the
 * eight processes under it — because that is simultaneously the thing the human
 * means by "the command this section is waiting on" and the single pid whose
 * death takes the whole build with it.
 *
 * The catch that makes the naive version useless: that `sh` sits at 0.0% CPU
 * while the `tsc` three levels below it eats a core, so the list would rank the
 * expensive work last. Each row therefore reports its whole subtree's CPU and
 * RSS — what stopping it would actually give back.
 */
export function collectSectionCommands(processes: MachineProcess[]): MachineProcess[] {
  const roots = new Map<number, MachineProcess>();
  const children = new Map<number, MachineProcess[]>();
  for (const row of processes) {
    if (row.sessionRoot) roots.set(row.pid, row);
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  if (roots.size === 0) return [];

  const subtree = (row: MachineProcess): { cpuPct: number; rssBytes: number } => {
    let cpuPct = row.cpuPct;
    let rssBytes = row.rssBytes;
    // Bounded by the process table: every pid is visited at most once per walk,
    // and `seen` keeps a corrupt ppid cycle from spinning here.
    const seen = new Set<number>([row.pid]);
    const queue = [row.pid];
    while (queue.length > 0) {
      for (const child of children.get(queue.pop()!) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        cpuPct += child.cpuPct;
        rssBytes += child.rssBytes;
        queue.push(child.pid);
      }
    }
    return { cpuPct: Math.round(cpuPct * 10) / 10, rssBytes };
  };

  const commands: MachineProcess[] = [];
  for (const [pid] of roots) {
    for (const child of children.get(pid) ?? []) {
      if (child.sessionRoot) continue;
      commands.push({ ...child, ...subtree(child) });
    }
  }
  return commands.sort((a, b) => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes).slice(0, SECTION_COMMAND_LIMIT);
}

/**
 * The pids to actually signal for "stop these commands", deepest-first.
 *
 * Killing only the row the user clicked is the trap: that row is usually a
 * `sh -c`, and killing it leaves the `tsc` underneath reparented to launchd and
 * still eating the core the user was trying to get back. So each selected
 * command expands to its whole subtree, and children are signalled before their
 * parent so nothing gets a chance to respawn a supervisor.
 *
 * Re-reads `ps` rather than trusting pids from the renderer: a stale snapshot
 * plus pid reuse is how a "kill the build" button kills something else. A pid is
 * only ever returned if, right now, it sits under a live section's agent CLI —
 * and the agent CLIs themselves are never returned.
 */
export async function resolveSectionKillTargets(
  ownerPids: ReadonlyMap<number, string>,
  requested?: readonly number[],
): Promise<MachineProcess[]> {
  const rows = await readProcesses(totalmem());
  attributeSessions(rows, ownerPids);
  const wanted = requested && requested.length > 0 ? new Set(requested) : null;
  const selected = collectSectionCommands(rows).filter((row) => !wanted || wanted.has(row.pid));
  if (selected.length === 0) return [];

  const children = new Map<number, MachineProcess[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));

  const ordered: MachineProcess[] = [];
  const seen = new Set<number>();
  const walk = (pid: number, depth: number): void => {
    if (seen.has(pid) || depth > 24) return;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) walk(child.pid, depth + 1);
    const row = byPid.get(pid);
    // Never the app itself, and never a section's agent CLI: this button frees
    // the machine, it does not end anyone's work.
    if (row && !row.sessionRoot && !ownerPids.has(pid) && pid !== process.pid) ordered.push(row);
  };
  for (const row of selected) walk(row.pid, 0);
  return ordered;
}

export type MachineProbeOptions = {
  /** pid → Panda section id, for the running app's own sessions. */
  ownerPids?: ReadonlyMap<number, string>;
  /** Bypass the short cache (the sheet's Refresh button). */
  force?: boolean;
};

export async function collectMachineStats(options: MachineProbeOptions = {}): Promise<MachineStats> {
  const now = Date.now();
  if (!options.force && cached && now - cached.at < CACHE_MS) return cached.stats;
  // Coalesce concurrent callers: the desktop drawer, a phone round-trip and an
  // agent can all land inside one 200ms CPU sample.
  if (inflight) return inflight;

  inflight = probe(options).finally(() => {
    inflight = null;
  });
  const stats = await inflight;
  cached = { at: Date.now(), stats };
  return stats;
}

async function probe(options: MachineProbeOptions): Promise<MachineStats> {
  const memTotalBytes = totalmem();
  const isDarwin = platform() === "darwin";
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg();

  const [cpuPct, processes, vmStat, swap, df] = await Promise.all([
    sampleCpuPct(),
    readProcesses(memTotalBytes).catch((error: unknown) => (error instanceof Error ? error : new Error("ps failed"))),
    isDarwin ? readOptional("vm_stat", []) : Promise.resolve(null),
    isDarwin ? readOptional("sysctl", ["-n", "vm.swapusage"]) : Promise.resolve(null),
    readDf(),
  ]);

  const failed = processes instanceof Error ? processes : null;
  const rows = failed ? [] : (processes as MachineProcess[]);
  attributeSessions(rows, options.ownerPids ?? new Map());

  const memory = vmStat ? parseVmStat(vmStat) : null;
  const availableBytes = memory?.availableBytes ?? (memTotalBytes > 0 ? freemem() : null);
  const swapUsage = swap ? parseSwapUsage(swap) : null;
  const disk = df ? parseDf(df) : null;

  const topByCpu = [...rows].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, PROCESS_LIMIT);
  const topByMemory = [...rows].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, PROCESS_LIMIT);
  const sectionCommands = collectSectionCommands(rows);
  await attachCommands([...topByCpu, ...topByMemory, ...sectionCommands]);

  return {
    capturedAt: new Date().toISOString(),
    hostname: hostname(),
    platform: platform(),
    osLabel: `${platform()} ${release()}`,
    uptimeSec: Math.round(uptime()),
    cpuCount: cpus().length || 1,
    loadAvg: [load1, load5, load15],
    cpuPct,
    memTotalBytes,
    memAvailableBytes: availableBytes,
    memUsedPct:
      availableBytes !== null && memTotalBytes > 0
        ? Math.round(((memTotalBytes - availableBytes) * 1000) / memTotalBytes) / 10
        : null,
    ...(memory?.compressedBytes ? { memCompressedBytes: memory.compressedBytes } : {}),
    ...(memory?.wiredBytes ? { memWiredBytes: memory.wiredBytes } : {}),
    swapUsedBytes: swapUsage?.usedBytes ?? null,
    swapTotalBytes: swapUsage?.totalBytes ?? null,
    diskUsedPct: disk?.usedPct ?? null,
    diskFreeBytes: disk?.freeBytes ?? null,
    topByCpu,
    topByMemory,
    sectionCommands,
    ...(failed ? { error: failed.message } : {}),
  };
}
