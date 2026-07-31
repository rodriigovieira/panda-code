import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenUsageStats } from "../shared/ipc";
import { createUsageLedger, usageDelta } from "./usageLedger";

const tokens = (partial: Partial<TokenUsageStats>): TokenUsageStats => {
  const next = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...partial,
  };
  return {
    ...next,
    totalTokens:
      partial.totalTokens ??
      next.inputTokens + next.outputTokens + next.cacheCreationInputTokens + next.cacheReadInputTokens,
  };
};

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "panda-usage-")), "usage-ledger.json");
}

describe("usageDelta", () => {
  it("returns the whole reading on the first sample", () => {
    expect(usageDelta(undefined, tokens({ inputTokens: 100 })).inputTokens).toBe(100);
  });

  it("returns only the increment while the counter climbs", () => {
    const delta = usageDelta(tokens({ inputTokens: 100, outputTokens: 10 }), tokens({ inputTokens: 250, outputTokens: 40 }));
    expect(delta.inputTokens).toBe(150);
    expect(delta.outputTokens).toBe(30);
    expect(delta.totalTokens).toBe(180);
  });

  it("treats a drop as a restarted thread and takes the full reading", () => {
    // Claude re-spawns on resume and counts from zero again.
    const delta = usageDelta(tokens({ inputTokens: 5_000 }), tokens({ inputTokens: 120 }));
    expect(delta.inputTokens).toBe(120);
  });
});

describe("createUsageLedger", () => {
  it("accumulates deltas per model and prices them", () => {
    const at = new Date("2026-07-20T10:15:00.000Z");
    const ledger = createUsageLedger({ filePath: ledgerPath(), now: () => at });

    ledger.record({ sessionId: "s1", runtime: "claude", model: "claude-opus-5", cumulative: tokens({ inputTokens: 1_000_000 }) });
    ledger.record({
      sessionId: "s1",
      runtime: "claude",
      model: "claude-opus-5",
      cumulative: tokens({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    });

    const report = ledger.query();
    expect(report.tokens.inputTokens).toBe(1_000_000);
    expect(report.tokens.outputTokens).toBe(1_000_000);
    // Opus 5: $5/M in + $25/M out.
    expect(report.cost.totalUsd).toBeCloseTo(30);
    expect(report.groups).toHaveLength(1);
    expect(report.sessionCount).toBe(1);
  });

  it("keeps a section's Claude spend after a handoff to Codex", () => {
    const at = new Date("2026-07-20T10:15:00.000Z");
    const ledger = createUsageLedger({ filePath: ledgerPath(), now: () => at });

    ledger.record({ sessionId: "s1", runtime: "claude", model: "claude-opus-5", cumulative: tokens({ outputTokens: 400_000 }) });
    // The handoff starts a fresh Codex thread whose counter begins at zero.
    ledger.record({ sessionId: "s1", runtime: "codex", model: "gpt-5-codex", cumulative: tokens({ outputTokens: 100_000 }) });

    const report = ledger.query({ sessionId: "s1" });
    expect(report.groups.map((group) => group.runtime).sort()).toEqual(["claude", "codex"]);
    expect(report.tokens.outputTokens).toBe(500_000);
    // 0.4M Opus output at $25/M + 0.1M Codex output at $10/M.
    expect(report.cost.totalUsd).toBeCloseTo(10 + 1);
  });

  it("filters by section and by date range", () => {
    const path = ledgerPath();
    let clock = new Date("2026-07-01T08:00:00.000Z");
    const ledger = createUsageLedger({ filePath: path, now: () => clock });

    ledger.record({ sessionId: "a", runtime: "claude", model: "claude-opus-5", cumulative: tokens({ inputTokens: 100 }) });
    clock = new Date("2026-07-20T08:00:00.000Z");
    ledger.record({ sessionId: "b", runtime: "claude", model: "claude-opus-5", cumulative: tokens({ inputTokens: 300 }) });

    expect(ledger.query({ sessionId: "a" }).tokens.inputTokens).toBe(100);
    expect(
      ledger.query({ fromIso: "2026-07-15T00:00:00.000Z", toIso: "2026-07-31T00:00:00.000Z" }).tokens.inputTokens,
    ).toBe(300);
    expect(ledger.query().sessionCount).toBe(2);
  });

  it("reports models it has no rate for instead of pricing them at zero silently", () => {
    const ledger = createUsageLedger({ filePath: ledgerPath(), now: () => new Date("2026-07-20T10:00:00.000Z") });
    ledger.record({ sessionId: "s1", runtime: "codex", model: "mystery-model", cumulative: tokens({ inputTokens: 1_000 }) });

    const report = ledger.query();
    expect(report.unpricedModels).toEqual(["mystery-model"]);
    expect(report.cost.priced).toBe(false);
  });

  it("survives a restart without double counting a resumed thread", () => {
    const path = ledgerPath();
    const at = new Date("2026-07-20T10:00:00.000Z");

    const first = createUsageLedger({ filePath: path, now: () => at });
    first.record({ sessionId: "s1", runtime: "codex", model: "gpt-5-codex", cumulative: tokens({ inputTokens: 5_000 }) });
    first.flush();

    const second = createUsageLedger({ filePath: path, now: () => at });
    // Codex app-server replays the thread's cumulative total on resume.
    second.record({ sessionId: "s1", runtime: "codex", model: "gpt-5-codex", cumulative: tokens({ inputTokens: 5_000 }) });
    second.record({ sessionId: "s1", runtime: "codex", model: "gpt-5-codex", cumulative: tokens({ inputTokens: 6_000 }) });

    expect(second.query().tokens.inputTokens).toBe(6_000);
  });

  it("persists entries and watermarks to disk on flush", () => {
    const path = ledgerPath();
    const ledger = createUsageLedger({ filePath: path, now: () => new Date("2026-07-20T10:00:00.000Z") });
    ledger.record({ sessionId: "s1", runtime: "claude", model: "claude-opus-5", cumulative: tokens({ inputTokens: 42 }) });
    ledger.flush();

    const stored = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Array<{ sessionId: string; at: string }>;
      watermarks: Record<string, TokenUsageStats>;
    };
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]?.at).toBe("2026-07-20T10:00:00.000Z");
    expect(stored.watermarks.s1?.inputTokens).toBe(42);
  });
});
