import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedThread } from "../shared/ipc";
import { startPeerMessageServer } from "./peerMessaging";
import { createPeerSection, listPeers, loadPeerTranscript, parseArgv, readPeer, requestAttention, sendPeerMessage, waitForSession } from "./peers-entry";

describe("parseArgv", () => {
  it("keeps explicit attention authorization separate from the summary", () => {
    const parsed = parseArgv(["--self", "section", "attention", "Build finished", "--user-requested"]);
    expect(parsed.positionals).toEqual(["attention", "Build finished"]);
    expect(parsed.switches.has("user-requested")).toBe(true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the shell cwd for panda-peers even when the section env has a stale workspace", () => {
    vi.stubEnv("PANDA_CODE_WORKSPACE", "/repo/from-section-env");

    const { options } = parseArgv([]);

    expect(options.cwd).toBe(process.cwd());
  });

  it("uses the section workspace env for MCP mode when no cwd flag is provided", () => {
    vi.stubEnv("PANDA_CODE_WORKSPACE", "/repo/from-section-env");

    const { options } = parseArgv(["--mcp"]);

    expect(options.cwd).toBe("/repo/from-section-env");
  });

  it("lets an explicit cwd flag override both CLI and MCP defaults", () => {
    vi.stubEnv("PANDA_CODE_WORKSPACE", "/repo/from-section-env");

    expect(parseArgv(["--cwd", "/repo/from-flag"]).options.cwd).toBe(
      "/repo/from-flag",
    );
    expect(parseArgv(["--mcp", "--cwd", "/repo/from-flag"]).options.cwd).toBe(
      "/repo/from-flag",
    );
  });
});

describe("sendPeerMessage", () => {
  const options = {
    threadsPath: "/tmp/threads.json",
    cwd: "/repo",
    selfId: "alpha",
    home: "/tmp",
  };

  it("carries a message to the app and reports back what the app said", async () => {
    const directory = mkdtempSync(join(tmpdir(), "panda-peers-client-"));
    const socketPath = join(directory, "peers.sock");
    const sendInput = vi.fn(async () => ({ ok: true }));
    const server = startPeerMessageServer({
      socketPath,
      readThreads: () =>
        [
          { id: "alpha", title: "Sender", cwd: "/repo", createdAt: "", lastActiveAt: "", status: "running" },
          { id: "beta", title: "Receiver", cwd: "/repo", createdAt: "", lastActiveAt: "", status: "running" },
        ] as never,
      sendInput,
      log: () => {},
    });

    try {
      const result = await sendPeerMessage({ ...options, socketPath }, "beta", "take over the docs pass");

      expect(result).toContain("Receiver");
      expect((sendInput.mock.calls[0] as unknown as [{ data: string }])[0].data).toContain("take over the docs pass");
    } finally {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("says so plainly when there is no app to deliver through", async () => {
    expect(await sendPeerMessage(options, "beta", "ping")).toContain("Messaging is unavailable");
    expect(await sendPeerMessage({ ...options, socketPath: "/tmp/panda-peers-missing.sock" }, "beta", "ping")).toContain(
      "Could not reach the Panda Code app",
    );
  });
});

describe("requestAttention", () => {
  it("carries the source section, TL;DR, and quick replies to the app", async () => {
    const directory = mkdtempSync(join(tmpdir(), "panda-peers-attention-"));
    const socketPath = join(directory, "peers.sock");
    const attention = vi.fn(async () => ({ ok: true, message: "Shown." }));
    const server = startPeerMessageServer({
      socketPath,
      readThreads: () => [],
      sendInput: async () => ({ ok: true }),
      attention,
      log: () => {},
    });

    try {
      const result = await requestAttention(
        { threadsPath: "/tmp/threads.json", cwd: "/repo", selfId: "alpha", home: "/tmp", socketPath },
        { summary: "Release aborted", userRequested: true, choices: [{ label: "Retry", response: "Retry the release." }] },
      );

      expect(result).toBe("Shown.");
      expect(attention).toHaveBeenCalledWith(expect.objectContaining({
        op: "attention",
        userRequested: true,
        from: "alpha",
        cwd: "/repo",
        summary: "Release aborted",
        choices: [{ label: "Retry", response: "Retry the release." }],
      }));
    } finally {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails plainly when the app bridge is unavailable", async () => {
    const result = await requestAttention(
      { threadsPath: "/tmp/threads.json", cwd: "/repo", selfId: "alpha", home: "/tmp" },
      { summary: "Release aborted" },
    );
    expect(result).toContain("Attention requests are unavailable");
  });
});

describe("createPeerSection", () => {
  const options = {
    threadsPath: "/tmp/threads.json",
    cwd: "/repo",
    selfId: "alpha",
    home: "/tmp",
  };

  it("asks the app to open a section in the caller's workspace and reports back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "panda-peers-create-"));
    const socketPath = join(directory, "peers.sock");
    const createSection = vi.fn(async () => ({ ok: true, id: "new-section" }));
    const server = startPeerMessageServer({
      socketPath,
      readThreads: () =>
        [{ id: "alpha", title: "Creator", cwd: "/repo", createdAt: "", lastActiveAt: "", status: "running" }] as never,
      sendInput: async () => ({ ok: true }),
      createSection,
      log: () => {},
    });

    try {
      const result = await createPeerSection({ ...options, socketPath }, { task: "audit the pricing table", title: "Pricing audit" });

      expect(result).toContain("new-section");
      expect(createSection).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", title: "Pricing audit" }));
    } finally {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("says so plainly when there is no app to open a section", async () => {
    expect(await createPeerSection(options, { task: "do the thing" })).toContain("Opening sections is unavailable");
  });
});

/**
 * A fake `~` holding one Claude section's transcript, so the reader can be
 * exercised against the shape of file that fooled it.
 */
function workspace(): {
  home: string;
  cwd: string;
  options: { threadsPath: string; cwd: string; home: string };
  writeThreads: (threads: PersistedThread[]) => void;
  writeClaudeTranscript: (sessionId: string, lines: string[]) => void;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "panda-peers-home-"));
  const cwd = join(home, "repo");
  const threadsPath = join(home, "threads.json");
  mkdirSync(cwd, { recursive: true });

  return {
    home,
    cwd,
    options: { threadsPath, cwd, home },
    writeThreads: (threads) => writeFileSync(threadsPath, JSON.stringify(threads), "utf8"),
    writeClaudeTranscript: (sessionId, lines) => {
      const directory = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function claudeThread(overrides: Partial<PersistedThread> & { id: string; cwd: string }): PersistedThread {
  return {
    title: `Section ${overrides.id}`,
    command: "claude",
    runtime: "claude",
    status: "running",
    agentState: "waiting",
    createdAt: "2026-08-01T10:00:00.000Z",
    lastActiveAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  } as PersistedThread;
}

const userLine = (text: string) => JSON.stringify({ type: "user", timestamp: "t1", message: { role: "user", content: text } });
const agentLine = (text: string) =>
  JSON.stringify({ type: "assistant", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text }] } });
/** A tool call and its result: bulky, and carrying no turn text at all. */
const toolLine = (index: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "t",
    message: { role: "assistant", content: [{ type: "tool_use", id: `tool_${index}`, name: "Read", input: { file: "x".repeat(3000) } }] },
  });

describe("transcript reading", () => {
  // The incident: a working section's last 200 KB were all tool traffic, the
  // tail parsed to nothing, and the reader announced it had no transcript.
  it("finds the turns of a section whose recent history is all tool calls", () => {
    const fixture = workspace();
    try {
      fixture.writeClaudeTranscript("session-1", [
        userLine("Audit the print-failure claims"),
        agentLine("Verdict: all four claims hold."),
        ...Array.from({ length: 120 }, (_, index) => toolLine(index)),
      ]);
      fixture.writeThreads([claudeThread({ id: "child", cwd: fixture.cwd, claudeSessionId: "session-1" })]);

      const thread = claudeThread({ id: "child", cwd: fixture.cwd, claudeSessionId: "session-1" });
      const transcript = loadPeerTranscript(thread, fixture.options);

      expect(transcript.found).toBe(true);
      expect(transcript.turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
      expect(readPeer(fixture.options, "child", {})).toContain("Verdict: all four claims hold.");
    } finally {
      fixture.cleanup();
    }
  });

  // The invariant the incident broke: two tools, one source of truth.
  it("never lets the list quote a reply the reader cannot return", () => {
    const fixture = workspace();
    try {
      fixture.writeClaudeTranscript("session-1", [userLine("Do the audit"), agentLine("Done: three of four hold.")]);
      fixture.writeThreads([claudeThread({ id: "child", cwd: fixture.cwd, claudeSessionId: "session-1", status: "exited", agentState: "exited" })]);

      const { text } = listPeers(fixture.options, true);
      expect(text).toContain("Done: three of four hold.");
      expect(text).toContain("2 turns readable");
      expect(readPeer(fixture.options, "child", {})).toContain("Done: three of four hold.");
    } finally {
      fixture.cleanup();
    }
  });

  it("separates a section with no transcript file from one that has said nothing", () => {
    const fixture = workspace();
    try {
      fixture.writeThreads([claudeThread({ id: "child", cwd: fixture.cwd, status: "exited", agentState: "exited" })]);

      const detail = readPeer(fixture.options, "child", {});
      expect(detail).toContain("has not reported a session id");
      expect(detail).toContain("failed");
      expect(detail).not.toContain("finished");
    } finally {
      fixture.cleanup();
    }
  });

  it("pages a long conversation and hands back a clipped turn in full", () => {
    const fixture = workspace();
    try {
      const long = "y".repeat(5000);
      fixture.writeClaudeTranscript("session-1", [
        ...Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? userLine(`ask ${index}`) : agentLine(`answer ${index}`))),
        agentLine(long),
      ]);
      fixture.writeThreads([claudeThread({ id: "child", cwd: fixture.cwd, claudeSessionId: "session-1" })]);

      const latest = readPeer(fixture.options, "child", {});
      expect(latest).toContain("turns 10–21 of 21");
      expect(latest).toContain("TRUNCATED");

      expect(readPeer(fixture.options, "child", { offset: 12 })).toContain("ask 0");
      expect(readPeer(fixture.options, "child", { turn: 21 })).toContain("part 1 of 1");
      expect(readPeer(fixture.options, "child", { turn: 21 })).toContain(long);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("waitForSession", () => {
  const immediately = async (): Promise<void> => {};

  it("returns as soon as the section has answered and settled", async () => {
    const fixture = workspace();
    try {
      fixture.writeClaudeTranscript("session-1", [userLine("Do the audit"), agentLine("All four claims hold.")]);
      fixture.writeThreads([
        claudeThread({ id: "child", cwd: fixture.cwd, claudeSessionId: "session-1", status: "exited", agentState: "exited" }),
      ]);

      // `now` is pushed past the window in which a fresh file counts as live.
      const result = await waitForSession(fixture.options, "child", 60_000, immediately, () => Date.now() + 600_000);

      expect(result).toContain("finished");
      expect(result).toContain("2 turns are readable");
    } finally {
      fixture.cleanup();
    }
  });

  it("returns immediately when the section needs input", async () => {
    const fixture = workspace();
    try {
      fixture.writeClaudeTranscript("session-1", [userLine("Run the probe"), agentLine("I need approval before I can continue.")]);
      fixture.writeThreads([claudeThread({ id: "child", cwd: fixture.cwd, claudeSessionId: "session-1", agentState: "needs_action" })]);

      const sleep = vi.fn(async () => {});
      const result = await waitForSession(fixture.options, "child", 60_000, sleep, () => Date.now() + 600_000);

      expect(result).toContain("waiting on an approval or a question");
      expect(result).toContain("has NOT finished");
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  /**
   * The incident: a parent waited on a sub-thread it had just created, and three
   * minutes in was told "No section matching <id> is open", while `list_sessions`
   * one second later listed that same sub-thread as running. The store is
   * rewritten about once a second and the loop reads it every two, so one poll
   * caught a half-written file, and a half-written file parsed as an empty
   * workspace.
   */
  it("keeps waiting when a poll catches the store mid-write", async () => {
    const fixture = workspace();
    try {
      fixture.writeClaudeTranscript("session-1", [userLine("Do the audit")]);
      const live = [claudeThread({ id: "child", cwd: fixture.cwd, claudeSessionId: "session-1", agentState: "working" })];
      fixture.writeThreads(live);

      // The second poll reads a truncated file, exactly as a reader landing
      // inside a non-atomic write would; the third sees the whole store again.
      let polls = 0;
      const sleep = vi.fn(async () => {
        polls += 1;
        if (polls === 1) {
          writeFileSync(fixture.options.threadsPath, JSON.stringify(live).slice(0, 40), "utf8");
        } else {
          fixture.writeThreads(live);
        }
      });

      let clock = Date.now();
      const result = await waitForSession(fixture.options, "child", 60_000, sleep, () => (clock += 1_000));

      expect(result).not.toContain("No section matching");
      expect(result).toContain("still **running**");
      expect(polls).toBeGreaterThan(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("still reports a section that is genuinely gone", async () => {
    const fixture = workspace();
    try {
      fixture.writeThreads([claudeThread({ id: "other", cwd: fixture.cwd })]);

      const result = await waitForSession(fixture.options, "child", 60_000, immediately, () => Date.now());

      expect(result).toContain('No section matching "child"');
    } finally {
      fixture.cleanup();
    }
  });

  it("reports progress rather than failure when the wait runs out", async () => {
    const fixture = workspace();
    try {
      fixture.writeClaudeTranscript("session-1", [userLine("Do the audit")]);
      fixture.writeThreads([claudeThread({ id: "child", cwd: fixture.cwd, claudeSessionId: "session-1", agentState: "working" })]);

      let clock = Date.now();
      const result = await waitForSession(fixture.options, "child", 5_000, immediately, () => (clock += 4_000));

      expect(result).toContain("still **running**");
      expect(result).toContain("has NOT failed");
    } finally {
      fixture.cleanup();
    }
  });
});
