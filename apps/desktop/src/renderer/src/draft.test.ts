import { describe, expect, it } from "vitest";
import type { PersistedThread, SessionPromptHistoryEntry } from "../../shared/ipc";
import {
  DRAFT_THREAD_ID,
  MAX_PROMPT_HISTORY_ENTRIES,
  MAX_PROMPT_HISTORY_TEXT,
  isDraftThread,
  isSectionWorthKeeping,
  persistableThreads,
} from "./draft";

function thread(overrides: Partial<PersistedThread> = {}): PersistedThread {
  return {
    id: "thread-1",
    title: "Untitled",
    titleSource: "auto",
    cwd: "/repo",
    command: "claude",
    runtime: "claude",
    executionMode: "stream-json",
    status: "idle",
    agentState: "exited",
    createdAt: "2026-07-30T00:00:00.000Z",
    lastActiveAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("the session draft", () => {
  it("uses a reserved id that cannot collide with a real section", () => {
    expect(DRAFT_THREAD_ID).toBe("new-session");
    // A real section id is a uuid; the draft's deliberately is not one.
    expect(DRAFT_THREAD_ID).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("is recognised by its flag, not its id", () => {
    expect(isDraftThread(thread({ id: DRAFT_THREAD_ID, draft: true }))).toBe(true);
    expect(isDraftThread(thread({ id: DRAFT_THREAD_ID }))).toBe(false);
    expect(isDraftThread(undefined)).toBe(false);
  });

  it("is never persisted", () => {
    const kept = thread({ id: "real", lastPromptAt: "2026-07-30T01:00:00.000Z" });
    const draft = thread({ id: DRAFT_THREAD_ID, draft: true });

    expect(persistableThreads([draft, kept])).toEqual([kept]);
  });
});

describe("capping prompt history at the persistence boundary", () => {
  const entry = (index: number, text = `prompt ${index}`): SessionPromptHistoryEntry => ({
    id: `p${index}`,
    text,
    attachments: 0,
    timestamp: `2026-07-30T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
  });

  it("keeps only the most recent entries, dropping the oldest", () => {
    const history = Array.from({ length: MAX_PROMPT_HISTORY_ENTRIES + 25 }, (_, i) => entry(i));
    const persisted = persistableThreads([thread({ promptHistory: history })])[0]!;

    expect(persisted.promptHistory).toHaveLength(MAX_PROMPT_HISTORY_ENTRIES);
    // The tail is what /prompts is for — the newest must survive, not the oldest.
    expect(persisted.promptHistory?.at(-1)?.id).toBe(`p${MAX_PROMPT_HISTORY_ENTRIES + 24}`);
    expect(persisted.promptHistory?.[0]?.id).toBe("p25");
  });

  it("truncates oversized entries, which is where the megabytes actually were", () => {
    const huge = entry(1, "x".repeat(MAX_PROMPT_HISTORY_TEXT * 3));
    const persisted = persistableThreads([thread({ promptHistory: [huge] })])[0]!;

    expect(persisted.promptHistory?.[0]?.text).toHaveLength(MAX_PROMPT_HISTORY_TEXT + 1);
    expect(persisted.promptHistory?.[0]?.text.endsWith("…")).toBe(true);
  });

  it("leaves history under both limits untouched, preserving identity", () => {
    const history = [entry(1), entry(2)];
    const source = thread({ promptHistory: history });
    const persisted = persistableThreads([source])[0]!;

    // Identity matters: this runs on every persist, so a fresh object each time
    // would invalidate memoization downstream for no reason.
    expect(persisted).toBe(source);
    expect(persisted.promptHistory).toBe(history);
  });

  it("does not disturb sections that never stored a prompt", () => {
    const source = thread({ id: "no-history" });
    expect(persistableThreads([source])[0]).toBe(source);
  });
});

describe("pruning sections that never ran", () => {
  it("drops a never-prompted Untitled section", () => {
    expect(isSectionWorthKeeping(thread())).toBe(false);
    expect(isSectionWorthKeeping(thread({ title: "New session" }))).toBe(false);
  });

  it("keeps anything with a prompt or a resolved agent session", () => {
    expect(isSectionWorthKeeping(thread({ lastPromptAt: "2026-07-30T01:00:00.000Z" }))).toBe(true);
    expect(isSectionWorthKeeping(thread({ claudeSessionId: "abc" }))).toBe(true);
    expect(isSectionWorthKeeping(thread({ codexThreadId: "def" }))).toBe(true);
  });

  it("keeps sections the user acted on deliberately", () => {
    expect(isSectionWorthKeeping(thread({ starred: true }))).toBe(true);
    expect(isSectionWorthKeeping(thread({ title: "Untitled", titleSource: "manual" }))).toBe(true);
    expect(isSectionWorthKeeping(thread({ title: "Fix the printer" }))).toBe(true);
  });
});
