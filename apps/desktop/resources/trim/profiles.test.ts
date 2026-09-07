import { describe, expect, it } from "vitest";
import { capOutput, findProfile, matchProfile } from "./profiles.mjs";

describe("capOutput", () => {
  it("passes short text through unchanged", () => {
    const text = ["one", "two", "three"].join("\n");
    expect(capOutput(text)).toBe(text);
  });

  it("caps long text to head + tail with a trimmed-count marker", () => {
    const headLines = 5;
    const tailLines = 5;
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const result = capOutput(lines.join("\n"), headLines, tailLines);
    const resultLines = result.split("\n");

    expect(resultLines.slice(0, headLines)).toEqual(lines.slice(0, headLines));
    expect(resultLines.slice(-tailLines)).toEqual(lines.slice(-tailLines));

    const trimmedCount = lines.length - headLines - tailLines;
    expect(result).toContain(`… ${trimmedCount} lines trimmed …`);
  });
});

describe("typecheck-build profile", () => {
  const profile = findProfile("typecheck-build");

  it("matches typecheck/build commands", () => {
    expect(profile.match("pnpm typecheck")).toBe(true);
    expect(profile.match("cd apps/desktop && pnpm run build")).toBe(true);
  });

  it("does not match unrelated commands", () => {
    expect(profile.match("git status")).toBe(false);
  });

  it("onSuccess returns a short summary", () => {
    const summary = profile.onSuccess("lots of tsc chatter\n".repeat(100), "");
    expect(summary.length).toBeLessThan(100);
    expect(summary).toContain("succeeded");
  });
});

describe("test profile", () => {
  const profile = findProfile("test");

  it("matches test commands", () => {
    expect(profile.match("pnpm test")).toBe(true);
    expect(profile.match("vitest run resources/trim/profiles.test.ts")).toBe(true);
  });

  it("does not match unrelated commands", () => {
    expect(profile.match("git diff")).toBe(false);
  });

  it("onSuccess returns something short", () => {
    const stdout = ["✓ some test passed", "Test Files  1 passed (1)", "Tests  3 passed (3)", "Duration  120ms"].join(
      "\n",
    );
    const summary = profile.onSuccess(stdout, "");
    expect(summary.length).toBeLessThan(stdout.length + 20);
    expect(summary).toContain("Tests");
  });

  it("onFailure drops passing noise but keeps failure content", () => {
    const stdout = ["✓ some test passed", "FAIL src/foo.test.ts > something broke", "  expected 1 to be 2"].join(
      "\n",
    );
    const result = profile.onFailure(stdout, "");
    expect(result).toContain("FAIL src/foo.test.ts > something broke");
    expect(result).not.toContain("✓ some test passed");
  });
});

describe("matchProfile fail-open path", () => {
  it("returns undefined for a totally unrelated command", () => {
    expect(matchProfile("some totally unrelated command")).toBeUndefined();
  });
});

describe("compound commands are never rewritten", () => {
  // Regression: `cp … && vitest run … && pnpm run typecheck` matched the
  // typecheck-build profile and collapsed the vitest output the agent had
  // actually asked for into a canned "typecheck clean" line.
  it("refuses a && chain even when part of it matches a profile", () => {
    expect(matchProfile("cp /tmp/x.bak src/x.ts && pnpm exec vitest run src/x.test.ts && pnpm run typecheck")).toBeUndefined();
  });

  it("refuses `;` chains, pipes and multi-line scripts", () => {
    expect(matchProfile("pnpm run typecheck; git status")).toBeUndefined();
    expect(matchProfile("pnpm test | grep FAIL")).toBeUndefined();
    expect(matchProfile("pnpm run build || echo failed")).toBeUndefined();
    expect(matchProfile("pnpm run typecheck\ngit status")).toBeUndefined();
  });

  it("still matches a single plain command", () => {
    expect(matchProfile("pnpm run typecheck")?.id).toBe("typecheck-build");
  });
});

describe("git-diff profile stays removed", () => {
  // `git diff -- <path>` is a deliberate read, not noise. Measured: an 8 kB
  // requested diff was replaced by a 97-byte stat, forcing a re-run.
  it("does not rewrite a git diff", () => {
    expect(findProfile("git-diff")).toBeUndefined();
    expect(matchProfile("git diff -- src/App.tsx")).toBeUndefined();
  });
});
