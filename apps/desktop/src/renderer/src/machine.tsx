import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Activity, Cpu, HardDrive, MemoryStick, PauseCircle, RefreshCw, Terminal, X, Zap } from "lucide-react";
import type { DesktopApi } from "../../shared/ipc";
import {
  PRESSURE_LABELS,
  formatBytes,
  formatPct,
  formatUptime,
  machinePressure,
  type MachineProcess,
  type MachineStats,
} from "../../shared/machine-stats";

/**
 * "What is this Mac doing right now?" — the desktop half.
 *
 * Every section shares one laptop, and until now nothing in the app said so:
 * the sidebar showed twelve happy sections while the box was swapping. This
 * drawer is the shared answer — the same snapshot the phone's device sheet and
 * the agents' `machine_status` tool read, so the human and the agents are never
 * looking at two different machines.
 */

/** Live while the drawer is open. Slow enough to read, fast enough to trust. */
const REFRESH_MS = 4_000;

export function useMachineStats(desktopApi: DesktopApi, open: boolean): {
  stats: MachineStats | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [stats, setStats] = useState<MachineStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A slow machine is exactly when this polls, so never let two probes overlap:
  // the reader that reports the load must not be part of it.
  const busy = useRef(false);

  const load = useCallback(
    async (force: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      try {
        setStats(await desktopApi.loadMachineStats(force));
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not read machine state.");
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [desktopApi],
  );

  useEffect(() => {
    if (!open) return;
    // Automatic reads may share the probe cache with the phone and agent
    // surfaces. Only the user's explicit refresh bypasses it.
    void load(false);
    const timer = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  return { stats, loading, error, refresh: () => void load(true) };
}

function Meter(props: { label: string; pct: number | null; detail: string; icon: ReactElement }): ReactElement {
  const pct = props.pct === null || !Number.isFinite(props.pct) ? null : Math.min(100, Math.max(0, props.pct));
  const tone = pct === null ? "" : pct >= 90 ? "danger" : pct >= 75 ? "warn" : "ok";
  return (
    <div className="machine-meter">
      <div className="machine-meter-head">
        <span className="machine-meter-label">
          {props.icon}
          {props.label}
        </span>
        <strong>{formatPct(props.pct)}</strong>
      </div>
      <div className="machine-meter-track">
        <div className={`machine-meter-fill ${tone}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
      <span className="machine-meter-detail">{props.detail}</span>
    </div>
  );
}

/**
 * One process in a ranked list.
 *
 * "312 MB" next to "301 MB" next to "251 MB" is three numbers to compare by
 * hand; the bar is the same three facts read at a glance. It is scaled against
 * the heaviest row in the list, not against the machine, because the question
 * this list answers is *which of these* is the expensive one.
 */
function ProcessRow(props: {
  process: MachineProcess;
  sectionTitle?: string;
  emphasis: "cpu" | "memory";
  /** 0–1 against the heaviest row, on whichever axis this list is ranked by. */
  share: number;
}): ReactElement {
  const { process: row } = props;
  return (
    <li className="machine-process" title={row.command ?? row.name}>
      <span className="machine-process-name">{row.name}</span>
      <span className="machine-process-bar">
        <span
          className="machine-process-bar-fill"
          style={{ width: `${Math.max(2, Math.min(100, props.share * 100))}%` }}
        />
      </span>
      <strong className="machine-process-metric primary">
        {props.emphasis === "cpu" ? `${row.cpuPct.toFixed(1)}%` : formatBytes(row.rssBytes)}
      </strong>
      <span className="machine-process-metric">
        {props.emphasis === "cpu" ? formatBytes(row.rssBytes) : `${row.cpuPct.toFixed(1)}%`}
      </span>
      <span className="machine-process-owner">{props.sectionTitle ?? ""}</span>
      <span className="machine-process-pid">{row.pid}</span>
    </li>
  );
}

/**
 * A destructive action that asks once, in place.
 *
 * Everything in this drawer reaches across sections — pausing all of them, or
 * killing a build another section is mid-way through — so none of it may fire on
 * a single stray click. The second press is the confirmation, and it forgets the
 * arming after a few seconds so a stale "Sure?" is never sitting there waiting
 * to be hit by accident.
 */
function ConfirmAction(props: {
  label: string;
  confirmLabel: string;
  title: string;
  icon: ReactElement;
  disabled?: boolean;
  onConfirm: () => void;
}): ReactElement {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={`machine-action ${armed ? "armed" : ""}`}
      disabled={props.disabled}
      title={props.title}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        props.onConfirm();
      }}
    >
      {props.icon}
      {armed ? props.confirmLabel : props.label}
    </button>
  );
}

/**
 * One spawned command.
 *
 * The section that owns it is already the group heading directly above, so this
 * row never repeats it — what it adds is the argv and what the thing costs.
 */
function CommandRow(props: { process: MachineProcess; onKill: () => void }): ReactElement {
  const { process: row } = props;
  return (
    <li className="machine-command">
      <span className="machine-command-name" title={row.command ?? row.name}>
        {row.command ?? row.name}
      </span>
      <span className="machine-command-cost">
        {row.cpuPct.toFixed(1)}% · {formatBytes(row.rssBytes)}
      </span>
      <span className="machine-process-pid">pid {row.pid}</span>
      <button
        className="ghost-icon-button machine-command-kill"
        type="button"
        onClick={props.onKill}
        aria-label={`Stop ${row.name}`}
        title={`Stop ${row.name} (pid ${row.pid}) and everything under it`}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

type MachineTab = "commands" | "cpu" | "memory";

export function MachineDrawer(props: {
  stats: MachineStats | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
  /** Section id → title, so a hungry process can be named by the work it is doing. */
  sectionTitles: Record<string, string>;
  /** How many sections have a turn in flight right now — what "pause all" would hit. */
  workingCount: number;
  /** Interrupt every working section's turn. They keep their conversation; the next prompt resumes. */
  onPauseAll: () => void;
  /** SIGKILL the given spawned commands and their subtrees; omit `pids` for all of them. */
  onKillCommands: (pids?: number[]) => void;
}): ReactElement {
  const { stats } = props;
  const pressure = stats ? machinePressure(stats) : null;
  const commands = stats?.sectionCommands ?? [];
  // Three process lists stacked made the drawer a mile of scroll for three
  // answers that are read one at a time. They are the same shape, so they are
  // tabs: the running commands first, because that is the actionable one.
  const [tab, setTab] = useState<MachineTab>("commands");
  const topByCpu = (stats?.topByCpu ?? []).slice(0, 12);
  const topByMemory = (stats?.topByMemory ?? []).slice(0, 12);
  // Each list's bars are scaled to its own leader, so the top row is always full.
  const maxCpu = Math.max(0, ...topByCpu.map((row) => row.cpuPct));
  const maxRss = Math.max(0, ...topByMemory.map((row) => row.rssBytes));

  // One heading per section, in the order the heaviest command puts them: the
  // section costing the most is the one the reader is looking for.
  const grouped = useMemo(() => {
    const groups: { sessionId: string; title: string; rows: MachineProcess[] }[] = [];
    for (const row of commands) {
      const sessionId = row.sessionId ?? "";
      const existing = groups.find((group) => group.sessionId === sessionId);
      if (existing) existing.rows.push(row);
      else {
        groups.push({
          sessionId,
          title: props.sectionTitles[sessionId] ?? `section ${sessionId.slice(0, 8) || "unknown"}`,
          rows: [row],
        });
      }
    }
    return groups;
  }, [commands, props.sectionTitles]);

  return (
    <div className="git-drawer-backdrop from-right" role="presentation" onClick={props.onClose}>
      <aside
        className="git-drawer from-right machine-drawer"
        role="dialog"
        aria-label="This machine"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="git-drawer-head">
          <div className="git-drawer-title">
            <Activity size={15} aria-hidden="true" />
            <div className="git-drawer-title-copy">
              <strong>{stats?.hostname ?? "This machine"}</strong>
              <span>
                {stats
                  ? `${PRESSURE_LABELS[pressure!]} · up ${formatUptime(stats.uptimeSec)} · ${stats.cpuCount} cores`
                  : "Reading…"}
              </span>
            </div>
          </div>
          <div className="git-drawer-head-actions">
            <button
              className={`ghost-icon-button ${props.loading ? "spinning" : ""}`}
              type="button"
              onClick={props.onRefresh}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
            <button className="ghost-icon-button" type="button" onClick={props.onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="git-drawer-body">
          {props.error ? <div className="git-empty">{props.error}</div> : null}
          {!stats && !props.error ? <div className="git-empty">Reading machine state…</div> : null}

          {stats ? (
            <>
              <div className="machine-actions">
                <ConfirmAction
                  label={props.workingCount > 0 ? `Pause all sections (${props.workingCount})` : "Pause all sections"}
                  confirmLabel={`Pause ${props.workingCount} section${props.workingCount === 1 ? "" : "s"}?`}
                  title={
                    props.workingCount > 0
                      ? "Interrupt every section's turn. Nothing is lost — each one picks up from your next prompt."
                      : "No section is working right now."
                  }
                  icon={<PauseCircle size={13} aria-hidden="true" />}
                  disabled={props.workingCount === 0}
                  onConfirm={props.onPauseAll}
                />
                <ConfirmAction
                  label={commands.length > 0 ? `Stop all commands (${commands.length})` : "Stop all commands"}
                  confirmLabel="Kill every command?"
                  title={
                    commands.length > 0
                      ? "Kill every build, test run and script the sections started — the agents stay alive and will report the failure."
                      : "No section has a command running."
                  }
                  icon={<Zap size={13} aria-hidden="true" />}
                  disabled={commands.length === 0}
                  onConfirm={() => props.onKillCommands()}
                />
              </div>

              <div className={`machine-verdict ${pressure}`}>
                {pressure === "loaded"
                  ? "Saturated — a heavy check started now will queue behind the work above."
                  : pressure === "busy"
                    ? "Busy — there is room, but not for two builds."
                    : "Quiet — go ahead."}
              </div>

              <section className="machine-meters">
                <Meter
                  label="CPU"
                  pct={stats.cpuPct}
                  icon={<Cpu size={12} aria-hidden="true" />}
                  detail={`load ${stats.loadAvg.map((value) => value.toFixed(1)).join(" · ")} across ${stats.cpuCount} cores`}
                />
                <Meter
                  label="Memory"
                  pct={stats.memUsedPct}
                  icon={<MemoryStick size={12} aria-hidden="true" />}
                  detail={`${formatBytes(stats.memAvailableBytes)} available of ${formatBytes(stats.memTotalBytes)}${
                    stats.memCompressedBytes ? ` · ${formatBytes(stats.memCompressedBytes)} compressed` : ""
                  }${stats.memWiredBytes ? ` · ${formatBytes(stats.memWiredBytes)} wired` : ""}`}
                />
                {stats.swapTotalBytes ? (
                  <Meter
                    label="Swap"
                    pct={
                      stats.swapUsedBytes !== null && stats.swapTotalBytes
                        ? (stats.swapUsedBytes / stats.swapTotalBytes) * 100
                        : null
                    }
                    icon={<HardDrive size={12} aria-hidden="true" />}
                    detail={`${formatBytes(stats.swapUsedBytes)} used of ${formatBytes(stats.swapTotalBytes)}`}
                  />
                ) : null}
                {stats.diskUsedPct !== null ? (
                  <Meter
                    label="Disk"
                    pct={stats.diskUsedPct}
                    icon={<HardDrive size={12} aria-hidden="true" />}
                    detail={`${formatBytes(stats.diskFreeBytes)} free`}
                  />
                ) : null}
              </section>

              <div className="git-drawer-tabs machine-tabs" role="tablist">
                {(
                  [
                    ["commands", "Commands running", commands.length],
                    ["cpu", "Heaviest by CPU", topByCpu.length],
                    ["memory", "Heaviest by memory", topByMemory.length],
                  ] as [MachineTab, string, number][]
                ).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    className={`git-drawer-tab ${tab === id ? "active" : ""}`}
                    onClick={() => setTab(id)}
                  >
                    {label}
                    <em>{count}</em>
                  </button>
                ))}
              </div>

              {tab === "commands" ? (
                <section className="git-section">
                  {grouped.length === 0 ? (
                    <p className="git-note">No section is waiting on a command right now.</p>
                  ) : (
                    grouped.map((group) => (
                      <div className="machine-command-group" key={group.sessionId || group.title}>
                        <div className="machine-command-group-head">
                          <span>
                            <Terminal size={12} aria-hidden="true" />
                            {group.title}
                          </span>
                          <ConfirmAction
                            label="Stop"
                            confirmLabel="Sure?"
                            title={`Kill the ${group.rows.length} command${
                              group.rows.length === 1 ? "" : "s"
                            } this section started`}
                            icon={<X size={12} aria-hidden="true" />}
                            onConfirm={() => props.onKillCommands(group.rows.map((row) => row.pid))}
                          />
                        </div>
                        <ul className="machine-process-list">
                          {group.rows.map((row) => (
                            <CommandRow
                              key={`cmd-${row.pid}`}
                              process={row}
                              onKill={() => props.onKillCommands([row.pid])}
                            />
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </section>
              ) : null}

              {tab === "cpu" ? (
                <section className="git-section">
                  <ul className="machine-process-list">
                    {topByCpu.map((row) => (
                      <ProcessRow
                        key={`cpu-${row.pid}`}
                        process={row}
                        emphasis="cpu"
                        share={maxCpu > 0 ? row.cpuPct / maxCpu : 0}
                        sectionTitle={row.sessionId ? props.sectionTitles[row.sessionId] : undefined}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {tab === "memory" ? (
                <section className="git-section">
                  <ul className="machine-process-list">
                    {topByMemory.map((row) => (
                      <ProcessRow
                        key={`mem-${row.pid}`}
                        process={row}
                        emphasis="memory"
                        share={maxRss > 0 ? row.rssBytes / maxRss : 0}
                        sectionTitle={row.sessionId ? props.sectionTitles[row.sessionId] : undefined}
                      />
                    ))}
                  </ul>
                  {/*
                    These rows never sum to the Memory meter above, and without
                    saying so the panel reads as if they should. Two reasons, in
                    order of size: the compressor holds pages that have LEFT the
                    owning process's RSS, and wired memory belongs to the kernel
                    rather than to any process at all.
                  */}
                  <p className="git-note">
                    Top {topByMemory.length} processes only — these do not sum to the {formatPct(stats.memUsedPct)}{" "}
                    above.
                    {stats.memWiredBytes ? ` ${formatBytes(stats.memWiredBytes)} is wired kernel memory (no process),` : ""}
                    {stats.memCompressedBytes
                      ? ` ${formatBytes(stats.memCompressedBytes)} sits in the compressor, held out of any process's footprint.`
                      : ""}
                  </p>
                </section>
              ) : null}

              {stats.error ? <p className="git-note">Process list unavailable: {stats.error}</p> : null}
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
