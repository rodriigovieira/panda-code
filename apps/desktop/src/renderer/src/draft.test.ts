import { describe, expect, it } from "vitest";
import type { PersistedThread } from "../../shared/ipc";
import { DRAFT_THREAD_ID, isDraftThread, isSectionWorthKeeping, persistableThreads } from "./draft";

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
