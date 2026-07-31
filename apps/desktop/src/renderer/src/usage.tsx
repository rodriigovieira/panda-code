import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { CalendarRange, RefreshCw } from "lucide-react";
import type { AgentRuntime, TokenUsageStats, UsageCostReport } from "../../shared/ipc";
import { formatUsd } from "../../shared/pricing";

// Cost readouts. Two surfaces share one set of rows: the per-section info card
// and the global report in Settings. Both take a `UsageCostReport` computed in
// the main process from the persisted usage ledger, so the renderer only
// formats — it never has to know a price.

const tokenFormatter = new Intl.NumberFormat();

function formatTokens(value: number): string {
  return tokenFormatter.format(Math.max(0, Math.round(value)));
}

const RUNTIME_LABELS: Record<AgentRuntime, string> = { claude: "Claude", codex: "Codex" };

/** The four token classes, in the order they read best (spend, then cache). */
function tokenClassRows(
  tokens: TokenUsageStats,
  cost: UsageCostReport["cost"],
): Array<{ label: string; hint: string; tokens: number; usd: number }> {
  return [
    { label: "Input", hint: "Fresh prompt tokens", tokens: tokens.inputTokens, usd: cost.inputUsd },
    { label: "Output", hint: "Generated + reasoning tokens", tokens: tokens.outputTokens, usd: cost.outputUsd },
    {
      label: "Cache write",
      hint: "Prompt cached for reuse — billed above the input rate",
      tokens: tokens.cacheCreationInputTokens,
      usd: cost.cacheWriteUsd,
    },
    {
      label: "Cache read",
      hint: "Served from cache — billed at a fraction of the input rate",
      tokens: tokens.cacheReadInputTokens,
      usd: cost.cacheReadUsd,
    },
  ];
}

export function CostClassTable(props: { report: UsageCostReport }): ReactElement {
  const rows = tokenClassRows(props.report.tokens, props.report.cost);
  return (
    <table className="cost-table">
      <thead>
        <tr>
          <th scope="col">Tokens</th>
          <th scope="col">Count</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row" title={row.hint}>
              {row.label}
            </th>
            <td>{formatTokens(row.tokens)}</td>
            <td className="cost-amount">{formatUsd(row.usd)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td>{formatTokens(props.report.tokens.totalTokens)}</td>
          <td className="cost-amount">{formatUsd(props.report.cost.totalUsd)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

export function CostModelTable(props: { report: UsageCostReport; showRuntime?: boolean }): ReactElement | null {
  const { groups } = props.report;
  if (groups.length === 0) {
    return null;
  }
  return (
    <ul className="cost-model-list">
      {groups.map((group) => (
        <li key={`${group.runtime}:${group.model}`}>
          <div className="cost-model-head">
            <span className="cost-model-name">
              {props.showRuntime === false ? null : (
                <em className={`cost-runtime-tag ${group.runtime}`}>{RUNTIME_LABELS[group.runtime]}</em>
              )}
              {group.modelLabel}
            </span>
            <strong className="cost-amount">{formatUsd(group.cost.totalUsd)}</strong>
          </div>
          <div className="cost-model-meta">
            <span>{formatTokens(group.tokens.totalTokens)} tokens</span>
            {group.rateSummary ? <span>{group.rateSummary}</span> : <span>no known rate</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function UnpricedNote(props: { report: UsageCostReport }): ReactElement | null {
  const { unpricedModels } = props.report;
  if (unpricedModels.length === 0) {
    return null;
  }
  return (
    <p className="cost-note warn">
      No rate on file for {unpricedModels.join(", ")}, so the total leaves those tokens out.
    </p>
  );
}

/**
 * Per-section cost, shown in the info popover. The headline is the section's
 * whole recorded history; the live thread counter only earns its own line when
 * it *differs* from that (a resumed process or a provider handoff), because
 * repeating the same number twice reads as two unrelated figures.
 */
export function SessionCostCard(props: {
  report: UsageCostReport | null;
  liveTokens: TokenUsageStats;
  runtimeLabel: string;
}): ReactElement {
  const { report, liveTokens, runtimeLabel } = props;
  const recorded = report?.tokens.totalTokens ?? 0;

  if (!report || recorded === 0) {
    return (
      <div className="cost-card">
        <div className="cost-card-head">
          <span>Session cost</span>
          <strong>{formatUsd(0)}</strong>
        </div>
        <p className="cost-note">
          {liveTokens.totalTokens > 0
            ? `${formatTokens(liveTokens.totalTokens)} tokens on this ${runtimeLabel} thread — cost lands as soon as the turn reports usage.`
            : `No usage recorded yet for this ${runtimeLabel} section.`}
        </p>
      </div>
    );
  }

  return (
    <div className="cost-card">
      <div className="cost-card-head">
        <span>Session cost</span>
        <strong>{formatUsd(report.cost.totalUsd)}</strong>
      </div>
      <p className="cost-card-sub">
        {formatTokens(recorded)} tokens recorded
        {liveTokens.totalTokens > 0 && liveTokens.totalTokens !== recorded
          ? ` · ${formatTokens(liveTokens.totalTokens)} on the live ${runtimeLabel} thread`
          : ""}
      </p>
      <CostClassTable report={report} />
      <CostModelTable report={report} />
      <UnpricedNote report={report} />
      <p className="cost-note">
        Lifetime spend for this section, including any provider it was handed off from. Priced at published API
        rates — informational while you run on a subscription.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date ranges for the global report
// ---------------------------------------------------------------------------

export type UsageRangePreset =
  | "today"
  | "yesterday"
  | "this-week"
  | "last-7"
  | "this-month"
  | "last-30"
  | "custom";

export const USAGE_RANGE_PRESETS: Array<{ value: UsageRangePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this-week", label: "This week" },
  { value: "last-7", label: "Last 7 days" },
  { value: "this-month", label: "This month" },
  { value: "last-30", label: "Last 30 days" },
  { value: "custom", label: "Custom" },
];

function startOfDay(value: Date): Date {
  const next = new Date(value.getTime());
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(value: Date): Date {
  const next = new Date(value.getTime());
  next.setHours(23, 59, 59, 999);
  return next;
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/** `YYYY-MM-DD` in local time, which is what `<input type="date">` speaks. */
export function toDateInputValue(value: Date): string {
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

export function fromDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Resolve a preset into an inclusive local-time window. Weeks start on Monday.
 * `custom` falls back to the current month when either endpoint is unparseable,
 * and swaps reversed endpoints rather than reporting an empty range.
 */
export function resolveUsageRange(
  preset: UsageRangePreset,
  now: Date,
  custom?: { from: string; to: string },
): { from: Date; to: Date } {
  switch (preset) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "yesterday": {
      const yesterday = addDays(now, -1);
      return { from: startOfDay(yesterday), to: endOfDay(yesterday) };
    }
    case "this-week": {
      // getDay(): 0 = Sunday. Shift so Monday is the first day.
      const offset = (now.getDay() + 6) % 7;
      return { from: startOfDay(addDays(now, -offset)), to: endOfDay(now) };
    }
    case "last-7":
      return { from: startOfDay(addDays(now, -6)), to: endOfDay(now) };
    case "last-30":
      return { from: startOfDay(addDays(now, -29)), to: endOfDay(now) };
    case "custom": {
      const from = custom ? fromDateInputValue(custom.from) : null;
      const to = custom ? fromDateInputValue(custom.to) : null;
      if (from && to) {
        return from <= to
          ? { from: startOfDay(from), to: endOfDay(to) }
          : { from: startOfDay(to), to: endOfDay(from) };
      }
      return resolveUsageRange("this-month", now);
    }
    case "this-month":
    default: {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: startOfDay(first), to: endOfDay(now) };
    }
  }
}

const rangeLabelFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export function formatRangeLabel(range: { from: Date; to: Date }): string {
  const from = rangeLabelFormatter.format(range.from);
  const to = rangeLabelFormatter.format(range.to);
  return from === to ? from : `${from} – ${to}`;
}

/**
 * The Settings → Usage report: a date range, its dollar total, the per-token-class
 * split, and a per-model breakdown. Refetches whenever the range changes and
 * while the tab is open, so a running section's spend keeps climbing on screen.
 */
export function UsageReportPanel(props: {
  active: boolean;
  loadReport: (fromIso: string, toIso: string) => Promise<UsageCostReport>;
}): ReactElement {
  const { active, loadReport } = props;
  const [preset, setPreset] = useState<UsageRangePreset>("this-month");
  const [customFrom, setCustomFrom] = useState(() => toDateInputValue(new Date(new Date().setDate(1))));
  const [customTo, setCustomTo] = useState(() => toDateInputValue(new Date()));
  const [report, setReport] = useState<UsageCostReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const range = useMemo(
    () => resolveUsageRange(preset, new Date(), { from: customFrom, to: customTo }),
    // `refreshToken` is deliberately a dependency and not read in the body: it is
    // what re-resolves "now" (and so re-runs the fetch) on an explicit refresh or
    // the poll tick. Reading the clock every render would loop forever.
    [preset, customFrom, customTo, refreshToken],
  );

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadReport(range.from.toISOString(), range.to.toISOString())
      .then((next) => {
        if (cancelled) return;
        setReport(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Could not read recorded usage.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, loadReport, range]);

  // Keep a visible report current while a section is spending.
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  return (
    <div className="usage-report">
      <div className="settings-field">
        <span className="settings-field-label">
          <CalendarRange size={13} aria-hidden="true" /> Date range
        </span>
        <div className="usage-range-pills" role="radiogroup" aria-label="Usage date range">
          {USAGE_RANGE_PRESETS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={preset === option.value}
              className={`selector-pill ${preset === option.value ? "selected" : ""}`}
              onClick={() => setPreset(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {preset === "custom" ? (
          <div className="usage-range-custom">
            <label>
              From
              <input type="date" value={customFrom} max={customTo} onChange={(event) => setCustomFrom(event.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={customTo} min={customFrom} onChange={(event) => setCustomTo(event.target.value)} />
            </label>
          </div>
        ) : null}
        <p>{formatRangeLabel(range)}</p>
      </div>

      <div className="usage-total-card">
        <div className="usage-total-head">
          <span>Spend in range</span>
          <button
            type="button"
            className="ghost-icon-button"
            onClick={refresh}
            aria-label="Refresh usage"
            title="Refresh usage"
          >
            <RefreshCw size={14} aria-hidden="true" className={loading ? "spinning" : ""} />
          </button>
        </div>
        <strong className="usage-total-amount">{formatUsd(report?.cost.totalUsd ?? 0)}</strong>
        <span className="usage-total-meta">
          {report
            ? `${formatTokens(report.tokens.totalTokens)} tokens across ${report.sessionCount} ${
                report.sessionCount === 1 ? "section" : "sections"
              }`
            : "Reading recorded usage…"}
        </span>
      </div>

      {error ? <p className="cost-note warn">{error}</p> : null}

      {report && report.tokens.totalTokens > 0 ? (
        <>
          <div className="settings-field">
            <span className="settings-field-label">By token type</span>
            <CostClassTable report={report} />
          </div>
          <div className="settings-field">
            <span className="settings-field-label">By model</span>
            <CostModelTable report={report} />
            <UnpricedNote report={report} />
            <p>
              Priced at each provider&apos;s published API rates. Useful as a what-if while you run on a subscription,
              and as the real bill once you switch to API keys.
            </p>
          </div>
        </>
      ) : (
        !error && !loading && <p className="cost-note">No recorded usage in this range.</p>
      )}
    </div>
  );
}
