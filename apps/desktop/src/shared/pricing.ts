import type { TokenUsageStats } from "./ipc";

/**
 * Token → dollar conversion.
 *
 * Sections run on subscriptions today, so these numbers are informational: they
 * answer "what would this section have cost on metered API pricing?". The table
 * is the single place to adjust when a provider changes its rates.
 */

export type ModelRate = {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens (reasoning tokens included). */
  output: number;
  /** USD per million tokens written to the prompt cache. */
  cacheWrite: number;
  /** USD per million tokens read from the prompt cache. */
  cacheRead: number;
};

export type PricedModel = {
  /** Lowercased substrings that identify this model in a runtime's model id. */
  match: string[];
  label: string;
  rate: ModelRate;
};

// Anthropic publishes an input/output rate per model; cache writes bill at 1.25x
// input (the 5-minute TTL, which is what Claude Code uses) and cache reads at
// 0.1x input.
function claudeRate(input: number, output: number): ModelRate {
  return { input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 };
}

// OpenAI bills cached input at 0.1x input and charges no write premium.
function openAiRate(input: number, output: number): ModelRate {
  return { input, output, cacheWrite: input, cacheRead: input * 0.1 };
}

/**
 * Ordered most-specific-first: the first entry whose `match` appears in the
 * normalized model id wins, so `claude-opus-4-8` must precede `opus`.
 */
export const MODEL_RATES: PricedModel[] = [
  // ---- Claude ------------------------------------------------------------
  { match: ["claude-mythos-5", "mythos"], label: "Mythos 5", rate: claudeRate(10, 50) },
  { match: ["claude-fable-5", "fable"], label: "Fable 5", rate: claudeRate(10, 50) },
  { match: ["claude-opus-5"], label: "Opus 5", rate: claudeRate(5, 25) },
  { match: ["claude-opus-4-8"], label: "Opus 4.8", rate: claudeRate(5, 25) },
  { match: ["claude-opus-4-7"], label: "Opus 4.7", rate: claudeRate(5, 25) },
  { match: ["claude-opus-4-6"], label: "Opus 4.6", rate: claudeRate(5, 25) },
  { match: ["claude-opus-4-5"], label: "Opus 4.5", rate: claudeRate(5, 25) },
  // "Opus plan" runs Opus for planning and Sonnet for execution; usage events
  // report the real model per message, so this only catches the alias itself.
  { match: ["opusplan"], label: "Opus plan", rate: claudeRate(5, 25) },
  { match: ["claude-opus", "opus"], label: "Opus", rate: claudeRate(5, 25) },
  { match: ["claude-sonnet-5"], label: "Sonnet 5", rate: claudeRate(3, 15) },
  { match: ["claude-sonnet-4-6"], label: "Sonnet 4.6", rate: claudeRate(3, 15) },
  { match: ["claude-sonnet-4-5"], label: "Sonnet 4.5", rate: claudeRate(3, 15) },
  { match: ["claude-sonnet", "sonnet"], label: "Sonnet", rate: claudeRate(3, 15) },
  { match: ["claude-haiku-4-5"], label: "Haiku 4.5", rate: claudeRate(1, 5) },
  { match: ["claude-haiku", "haiku"], label: "Haiku", rate: claudeRate(1, 5) },

  // ---- Codex / OpenAI ----------------------------------------------------
  // Worth re-checking against OpenAI's pricing page: the Codex CLI does not
  // report a rate, and these were transcribed by hand from the GPT-5 family
  // list prices. An id we don't match shows as "no known rate" rather than
  // being priced at a guess, so a stale row here under-reports rather than
  // inventing a number.
  { match: ["gpt-5.1-codex-mini", "gpt-5-codex-mini"], label: "GPT-5 Codex mini", rate: openAiRate(0.25, 2) },
  { match: ["codex-mini"], label: "Codex mini", rate: openAiRate(0.25, 2) },
  { match: ["gpt-5.1-codex-max"], label: "GPT-5.1 Codex Max", rate: openAiRate(1.25, 10) },
  { match: ["gpt-5.1-codex"], label: "GPT-5.1 Codex", rate: openAiRate(1.25, 10) },
  { match: ["gpt-5-codex"], label: "GPT-5 Codex", rate: openAiRate(1.25, 10) },
  { match: ["gpt-5.1-mini", "gpt-5-mini"], label: "GPT-5 mini", rate: openAiRate(0.25, 2) },
  { match: ["gpt-5.1"], label: "GPT-5.1", rate: openAiRate(1.25, 10) },
  { match: ["gpt-5"], label: "GPT-5", rate: openAiRate(1.25, 10) },
  { match: ["codex"], label: "Codex", rate: openAiRate(1.25, 10) },
];

/**
 * Strip the noise that surrounds a model id so the same model reported as
 * `claude-opus-5`, `Claude-Opus-5-20260101`, or `opus[1m]` all match one rate.
 */
export function normalizeModelId(model: string | undefined): string {
  return (model ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, "")
    .replace(/-20\d{6}$/, "")
    .replace(/[\s_]+/g, "-");
}

export function findModelRate(model: string | undefined): PricedModel | null {
  const normalized = normalizeModelId(model);
  if (!normalized) {
    return null;
  }
  for (const entry of MODEL_RATES) {
    if (entry.match.some((needle) => normalized.includes(needle))) {
      return entry;
    }
  }
  return null;
}

/**
 * How a model id should read in the UI: the priced model's friendly label when
 * we recognize it, the raw id when we don't, and a placeholder when the runtime
 * never told us which model ran.
 */
export function modelDisplayLabel(model: string | undefined): string {
  const trimmed = model?.trim() ?? "";
  if (!trimmed) {
    return "Unspecified model";
  }
  return findModelRate(trimmed)?.label ?? trimmed;
}

export type CostBreakdown = {
  inputUsd: number;
  outputUsd: number;
  cacheWriteUsd: number;
  cacheReadUsd: number;
  totalUsd: number;
  /** False when no rate is known for the model, so the dollar figures are 0. */
  priced: boolean;
};

export const EMPTY_COST: CostBreakdown = {
  inputUsd: 0,
  outputUsd: 0,
  cacheWriteUsd: 0,
  cacheReadUsd: 0,
  totalUsd: 0,
  priced: true,
};

function perMillion(tokens: number, rate: number): number {
  return (Math.max(0, tokens) / 1_000_000) * rate;
}

export function costForUsage(usage: TokenUsageStats, model: string | undefined): CostBreakdown {
  const priced = findModelRate(model);
  if (!priced) {
    return { ...EMPTY_COST, priced: false };
  }
  const { rate } = priced;
  const inputUsd = perMillion(usage.inputTokens, rate.input);
  const outputUsd = perMillion(usage.outputTokens, rate.output);
  const cacheWriteUsd = perMillion(usage.cacheCreationInputTokens, rate.cacheWrite);
  const cacheReadUsd = perMillion(usage.cacheReadInputTokens, rate.cacheRead);
  return {
    inputUsd,
    outputUsd,
    cacheWriteUsd,
    cacheReadUsd,
    totalUsd: inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd,
    priced: true,
  };
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    inputUsd: a.inputUsd + b.inputUsd,
    outputUsd: a.outputUsd + b.outputUsd,
    cacheWriteUsd: a.cacheWriteUsd + b.cacheWriteUsd,
    cacheReadUsd: a.cacheReadUsd + b.cacheReadUsd,
    totalUsd: a.totalUsd + b.totalUsd,
    priced: a.priced && b.priced,
  };
}

export function addTokens(a: TokenUsageStats, b: TokenUsageStats): TokenUsageStats {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export const EMPTY_TOKENS: TokenUsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
};

/**
 * Money for a usage readout. Sub-cent amounts still need to read as a real
 * number (a section that cost $0.004 shouldn't render as "$0.00"), so the
 * precision grows as the amount shrinks.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  if (value < 1) {
    return `$${value.toFixed(3)}`;
  }
  if (value < 1000) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** The per-million rate line shown next to a model row ("$5.00 / $25.00 per M"). */
export function formatRateSummary(model: string | undefined): string | null {
  const priced = findModelRate(model);
  if (!priced) {
    return null;
  }
  return `$${priced.rate.input.toFixed(2)} in · $${priced.rate.output.toFixed(2)} out per Mtok`;
}
