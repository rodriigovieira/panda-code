import { describe, expect, it } from "vitest";
import { costForUsage, findModelRate, formatUsd, modelDisplayLabel, normalizeModelId } from "./pricing";
import type { TokenUsageStats } from "./ipc";

const tokens = (partial: Partial<TokenUsageStats>): TokenUsageStats => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
  ...partial,
});

describe("normalizeModelId", () => {
  it("strips long-context suffixes and date stamps", () => {
    expect(normalizeModelId("opus[1m]")).toBe("opus");
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("  Claude-Opus-5  ")).toBe("claude-opus-5");
  });
});

describe("findModelRate", () => {
  it("prefers the specific model over the family alias", () => {
    expect(findModelRate("claude-opus-4-8")?.label).toBe("Opus 4.8");
    expect(findModelRate("claude-opus-5")?.label).toBe("Opus 5");
    expect(findModelRate("opusplan")?.label).toBe("Opus plan");
    expect(findModelRate("claude-sonnet-4-6")?.label).toBe("Sonnet 4.6");
  });

  it("matches Codex model ids", () => {
    expect(findModelRate("gpt-5.1-codex-max")?.label).toBe("GPT-5.1 Codex Max");
    expect(findModelRate("gpt-5-codex")?.label).toBe("GPT-5 Codex");
  });

  it("returns null for an unknown or missing model", () => {
    expect(findModelRate("")).toBeNull();
    expect(findModelRate(undefined)).toBeNull();
    expect(findModelRate("llama-9000")).toBeNull();
  });
});

describe("costForUsage", () => {
  it("prices each token class at its own rate", () => {
    const cost = costForUsage(
      tokens({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      }),
      "claude-opus-5",
    );
    expect(cost.inputUsd).toBeCloseTo(5);
    expect(cost.outputUsd).toBeCloseTo(25);
    expect(cost.cacheWriteUsd).toBeCloseTo(6.25);
    expect(cost.cacheReadUsd).toBeCloseTo(0.5);
    expect(cost.totalUsd).toBeCloseTo(36.75);
    expect(cost.priced).toBe(true);
  });

  it("flags an unknown model instead of guessing a rate", () => {
    const cost = costForUsage(tokens({ inputTokens: 1_000_000 }), "who-knows");
    expect(cost.priced).toBe(false);
    expect(cost.totalUsd).toBe(0);
  });
});

describe("formatUsd", () => {
  it("keeps sub-cent amounts legible", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0034)).toBe("$0.0034");
    expect(formatUsd(0.42)).toBe("$0.420");
    expect(formatUsd(12.3456)).toBe("$12.35");
    expect(formatUsd(4200)).toBe("$4,200");
  });
});

describe("modelDisplayLabel", () => {
  it("falls back to the raw id, then a placeholder", () => {
    expect(modelDisplayLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelDisplayLabel("custom-thing")).toBe("custom-thing");
    expect(modelDisplayLabel("")).toBe("Unspecified model");
  });
});
