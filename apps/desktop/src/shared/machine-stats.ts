/**
 * "What is this Mac actually doing right now?" — the shape of one snapshot, and
 * the formatting every surface shares.
 *
 * Three readers, one answer: the desktop drawer, the phone's device sheet (round
 * -tripped over the relay), and agents (`machine_status`, and the headline
 * `list_sessions` already prints). Every section runs on the same laptop, so
 * "who is eating the RAM" is a question the human and the agents both ask.
 *
 * Deliberately free of node imports: the renderer imports this file. The probe
 * that fills it in lives in `machine-probe.ts`.
 */

export type MachineProcess = {
  pid: number;
  ppid: number;
  /** Executable basename — "node", "tsc", "Panda Code Helper (Renderer)". */
  name: string;
  /** Full argv when we could read it; the UI shows it as the row's detail line. */
  command?: string;
  cpuPct: number;
  rssBytes: number;
  /** RSS against physical RAM, so a number the "78% used" headline can be read against. */
  memPct: number;
  /**
   * The Panda section this process belongs to (itself or an ancestor), when the
   * app could attribute it. This is what turns "node at 300% CPU" into "the
   * typecheck your neighbour section started".
   */
  sessionId?: string;
  /**
   * This process IS a section's agent CLI, not something the agent started.
   *
   * The distinction is the whole safety story behind "kill every command": the
   * roots are the sections themselves, so killing one does not free the machine,
   * it destroys the work. Only strict descendants are ever killable.
   */
  sessionRoot?: boolean;
};

export type MachineStats = {
  capturedAt: string;
  hostname: string;
  platform: NodeJS.Platform | string;
  /** e.g. "macOS 15.6" — best effort, purely for the sheet's subtitle. */
  osLabel?: string;
  uptimeSec: number;
  cpuCount: number;
  loadAvg: [number, number, number];
  /** Busy share across all cores over a short sampling window, 0-100. */
  cpuPct: number | null;
  memTotalBytes: number;
  /** free + inactive + speculative + purgeable on macOS; os.freemem elsewhere. */
  memAvailableBytes: number | null;
  memUsedPct: number | null;
  /** Physical memory held by the compressor — macOS's "we are already squeezing". */
  memCompressedBytes?: number;
  /**
   * Kernel, drivers, page tables, network stack. Attributable to no process, so
   * it can never show up in `topByMemory` — surfaced separately precisely so the
   * process list stops looking like it ought to add up to `memUsedPct`.
   */
  memWiredBytes?: number;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  diskUsedPct: number | null;
  diskFreeBytes: number | null;
  /** Sorted by CPU, descending. */
  topByCpu: MachineProcess[];
  /** Sorted by resident memory, descending. Same sample, different question. */
  topByMemory: MachineProcess[];
  /**
   * What the sections are actually waiting on: every process a section started
   * (its agent CLI's descendants — the builds, typechecks and test runs), never
   * the agent processes themselves. Sorted by CPU, descending.
   *
   * This is the list the "kill every command" button acts on, so it is also the
   * list the human reads before pressing it — the two must not diverge.
   */
  sectionCommands: MachineProcess[];
  /** Set when the probe could not run at all (unsupported platform, ps missing). */
  error?: string;
};

export type MachinePressure = "quiet" | "busy" | "loaded";

/**
 * One word for the whole box, from load-per-core and memory headroom together —
 * a machine can be idle and still one `pnpm build` away from swapping.
 */
export function machinePressure(stats: MachineStats): MachinePressure {
  const perCore = stats.cpuCount > 0 ? stats.loadAvg[0] / stats.cpuCount : stats.loadAvg[0];
  const memUsed = stats.memUsedPct ?? 0;
  if (perCore > 1.5 || memUsed >= 92) return "loaded";
  if (perCore > 0.8 || memUsed >= 80) return "busy";
  return "quiet";
}

export const PRESSURE_LABELS: Record<MachinePressure, string> = {
  quiet: "Quiet",
  busy: "Busy",
  loaded: "Heavily loaded",
};

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatPct(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${Math.round(value)}%`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * The agent-facing rendering. Same numbers the human sees, as text a model can
 * act on — including the advice that follows from them, because an agent that
 * reads "92% used" and starts a build anyway has learned nothing.
 */
export function renderMachineStats(stats: MachineStats, limit = 8): string {
  if (stats.error && stats.topByCpu.length === 0) {
    return `Could not read machine state: ${stats.error}`;
  }
  const pressure = machinePressure(stats);
  const [one, five, fifteen] = stats.loadAvg;
  const lines: string[] = [];

  lines.push(
    `${stats.hostname} · ${PRESSURE_LABELS[pressure].toLowerCase()} · up ${formatUptime(stats.uptimeSec)}`,
  );
  lines.push(
    `CPU: ${formatPct(stats.cpuPct)} busy · load ${one.toFixed(1)} / ${five.toFixed(1)} / ${fifteen.toFixed(1)} across ${stats.cpuCount} cores`,
  );
  lines.push(
    `RAM: ${formatPct(stats.memUsedPct)} of ${formatBytes(stats.memTotalBytes)} used · ` +
      `${formatBytes(stats.memAvailableBytes)} available` +
      (stats.memCompressedBytes ? ` · ${formatBytes(stats.memCompressedBytes)} compressed` : "") +
      (stats.memWiredBytes ? ` · ${formatBytes(stats.memWiredBytes)} wired` : ""),
  );
  if (stats.swapUsedBytes !== null) {
    lines.push(`Swap: ${formatBytes(stats.swapUsedBytes)} used of ${formatBytes(stats.swapTotalBytes)}`);
  }
  if (stats.diskUsedPct !== null) {
    lines.push(`Disk: ${formatPct(stats.diskUsedPct)} used · ${formatBytes(stats.diskFreeBytes)} free`);
  }

  const rows = (list: MachineProcess[]): string[] =>
    list.slice(0, limit).map((process) => {
      const owner = process.sessionId ? ` · section ${process.sessionId.slice(0, 8)}` : "";
      return `  ${String(process.pid).padStart(6)}  ${process.cpuPct.toFixed(1).padStart(5)}%  ${formatBytes(
        process.rssBytes,
      ).padStart(8)}  ${process.name}${owner}`;
    });

  lines.push("", "Heaviest by CPU:", ...rows(stats.topByCpu));
  lines.push("", "Heaviest by memory:", ...rows(stats.topByMemory));

  if (stats.sectionCommands?.length) {
    lines.push(
      "",
      "Commands sections are waiting on:",
      ...stats.sectionCommands.slice(0, limit).map((process) => {
        const owner = process.sessionId ? `section ${process.sessionId.slice(0, 8)}` : "unattributed";
        return `  ${String(process.pid).padStart(6)}  ${process.cpuPct.toFixed(1).padStart(5)}%  ${owner}  ${
          process.command ?? process.name
        }`;
      }),
    );
  }

  if (pressure === "loaded") {
    lines.push(
      "",
      "The box is saturated. Prefer a scoped check over a full one, and wait for a heavy " +
        "process above to finish rather than starting a second one beside it.",
    );
  }
  return lines.join("\n");
}
