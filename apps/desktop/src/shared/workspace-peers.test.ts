import { describe, expect, it } from "vitest";
import type { PersistedThread } from "./ipc";
import {
  ancestorIds,
  canAdopt,
  childrenOf,
  DEFAULT_PAGE_TURNS,
  descendantIds,
  MAX_SUBTHREAD_DEPTH,
  subthreadDepth,
  isSettled,
  matchThread,
  missingTranscript,
  parseClaudeActivity,
  parseClaudeTurns,
  parseCodexActivity,
  parseCodexTurns,
  peerStatus,
  renderInbox,
  renderPeerDetail,
  renderPeerList,
  renderPeerTurn,
  sameWorkspace,
  selectWorkspacePeers,
  sortPeers,
  summarizePeer,
  TURN_PART_CHARS,
  TURN_PREVIEW_CAP,
  type PeerTranscript,
  type PeerTurn,
} from "./workspace-peers";

function thread(overrides: Partial<PersistedThread> & { id: string }): PersistedThread {
  return {
    title: `Section ${overrides.id}`,
    cwd: "/repo",
    command: "claude",
    status: "running",
    agentState: "waiting",
    createdAt: "2026-08-01T10:00:00.000Z",
    lastActiveAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
/** Older than TRANSCRIPT_ACTIVE_MS, so the file counts as no longer growing. */
const COLD = NOW - 10 * 60_000;

function transcript(turns: PeerTurn[], overrides: Partial<PeerTranscript> = {}): PeerTranscript {
  return { found: true, turns, complete: true, omittedBytes: 0, modifiedAt: COLD, path: "/tmp/t.jsonl", ...overrides };
}

const exchange: PeerTurn[] = [
  { role: "user", text: "Fix the flush test", at: "t1" },
  { role: "agent", text: "Patched relayBridge.", at: "t2" },
];

describe("sameWorkspace", () => {
  it("ignores a trailing slash", () => {
    expect(sameWorkspace("/repo/", "/repo")).toBe(true);
    expect(sameWorkspace("/repo", "/repo-two")).toBe(false);
  });
});

describe("peerStatus", () => {
  it("reports a live mid-turn agent as running", () => {
    expect(peerStatus(thread({ id: "a", agentState: "working" }), transcript(exchange), NOW).state).toBe("running");
  });

  it("treats an approval prompt as idle, and says what it is waiting on", () => {
    const status = peerStatus(thread({ id: "a", agentState: "needs_action" }), transcript(exchange), NOW);
    expect(status.state).toBe("idle");
    expect(status.reason).toContain("approval");
  });

  it("calls a dead section with a readable transcript finished", () => {
    const status = peerStatus(thread({ id: "a", status: "exited", agentState: "exited" }), transcript(exchange), NOW);
    expect(status).toEqual({ state: "finished" });
  });

  // The incident this whole model was rebuilt after: threads.json said the
  // section had exited seventy seconds in, while it was busily writing turns.
  it("never reports a terminal state while the transcript is still being written", () => {
    const status = peerStatus(
      thread({ id: "a", status: "exited", agentState: "exited" }),
      transcript(exchange, { modifiedAt: NOW - 3_000 }),
      NOW,
    );
    expect(status.state).toBe("running");
    expect(status.reason).toContain("still writing output");
  });

  it("separates a section that died with nothing to read from one that finished", () => {
    const dead = peerStatus(thread({ id: "a", status: "exited", agentState: "exited" }), missingTranscript("not-linked"), NOW);
    expect(dead.state).toBe("failed");
    expect(dead.reason).toContain("session id");

    const errored = peerStatus(thread({ id: "a", status: "error", agentState: "exited" }), transcript(exchange), NOW);
    expect(errored.state).toBe("failed");
  });

  // A sub-thread three seconds into launching on a swap-thrashing machine has no
  // session id yet and a renderer snapshot nobody has flipped to `working` — the
  // exact shape of a section that died on the launch pad. Age is what tells them
  // apart, and calling the live one failed costs its parent a whole turn.
  it("does not call a section that is still booting failed", () => {
    const booting = thread({
      id: "a",
      status: "exited",
      agentState: "exited",
      createdAt: new Date(NOW - 3_000).toISOString(),
    });
    const status = peerStatus(booting, missingTranscript("not-linked"), NOW);
    expect(status.state).toBe("running");
    expect(status.reason).toContain("starting up");

    // ...but the grace period expires, so a genuinely stillborn one is still reported.
    const stillborn = thread({
      id: "a",
      status: "exited",
      agentState: "exited",
      createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    });
    expect(peerStatus(stillborn, missingTranscript("not-linked"), NOW).state).toBe("failed");
  });

  it("counts an idle section that has answered as settled, and a working one as not", () => {
    const answered = thread({ id: "a", agentState: "waiting" });
    expect(isSettled(peerStatus(answered, transcript(exchange), NOW), transcript(exchange))).toBe(true);

    const asked = transcript([...exchange, { role: "user", text: "And the other one?" }]);
    expect(isSettled(peerStatus(answered, asked, NOW), asked)).toBe(false);
  });
});

describe("selectWorkspacePeers", () => {
  const threads = [
    thread({ id: "other-repo", cwd: "/elsewhere", agentState: "working" }),
    thread({ id: "done", status: "exited", agentState: "exited", lastActiveAt: "2026-08-01T12:00:00.000Z" }),
    thread({ id: "self" }),
    thread({ id: "busy", agentState: "working", lastActiveAt: "2026-08-01T09:00:00.000Z" }),
    thread({ id: "draft-section", draft: true, agentState: "working" }),
  ];

  it("keeps only the asking workspace, and drops the asker and the draft", () => {
    const peers = selectWorkspacePeers(threads, { cwd: "/repo", selfId: "self", includeSelf: false });
    expect(peers.map((peer) => peer.id).sort()).toEqual(["busy", "done"]);
  });

  it("includes the asking section by default", () => {
    const peers = selectWorkspacePeers(threads, { cwd: "/repo", selfId: "self" });
    expect(peers.map((peer) => peer.id)).toContain("self");
  });

  it("puts running sections first even when a finished one is more recent", () => {
    const peers = selectWorkspacePeers(threads, { cwd: "/repo" }).map((candidate) =>
      summarizePeer(candidate, { transcript: transcript(exchange), now: NOW }),
    );
    expect(sortPeers(peers)[0]?.id).toBe("busy");
  });
});

const claudeTranscript = [
  JSON.stringify({ type: "user", timestamp: "t1", message: { role: "user", content: "Fix the flush test" } }),
  JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>ignore me</system-reminder>" } }),
  JSON.stringify({ type: "assistant", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "Patched relayBridge." }] } }),
  "{ not json",
  "",
].join("\n");

describe("parseClaudeTurns", () => {
  it("keeps real turns and skips injected meta turns and broken lines", () => {
    expect(parseClaudeTurns(claudeTranscript)).toEqual(exchange);
  });

  it("returns only the tail when a limit is given", () => {
    expect(parseClaudeTurns(claudeTranscript, 1)).toEqual([exchange[1]]);
  });
});

describe("parseCodexTurns", () => {
  it("reads both legacy message rows and current app-server event rows", () => {
    const codex = [
      JSON.stringify({ timestamp: "t1", payload: { type: "message", role: "user", content: [{ type: "text", text: "Ship it" }] } }),
      JSON.stringify({ timestamp: "t2", payload: { type: "reasoning", content: [{ type: "text", text: "thinking" }] } }),
      JSON.stringify({ timestamp: "t3", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Shipped" }] } }),
      JSON.stringify({ timestamp: "t4", payload: { type: "user_message", message: "Follow-up" } }),
      JSON.stringify({ timestamp: "t5", payload: { type: "agent_message", message: "Done" } }),
    ].join("\n");

    expect(parseCodexTurns(codex)).toEqual([
      { role: "user", text: "Ship it", at: "t1" },
      { role: "agent", text: "Shipped", at: "t3" },
      { role: "user", text: "Follow-up", at: "t4" },
      { role: "agent", text: "Done", at: "t5" },
    ]);
  });

  it("reads current Codex input/output text blocks and ignores developer messages", () => {
    const codex = [
      JSON.stringify({ payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "internal" }] } }),
      JSON.stringify({ timestamp: "t1", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<developer_instructions>hidden</developer_instructions>\n\nVisible prompt" }] } }),
      JSON.stringify({ timestamp: "t2", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Visible reply" }] } }),
    ].join("\n");

    expect(parseCodexTurns(codex)).toEqual([
      { role: "user", text: "Visible prompt", at: "t1" },
      { role: "agent", text: "Visible reply", at: "t2" },
    ]);
  });
});

describe("summarizePeer", () => {
  it("surfaces the latest exchange of each side", () => {
    const peer = summarizePeer(thread({ id: "busy", agentState: "working" }), {
      selfId: "self",
      transcript: transcript(exchange),
      now: NOW,
    });
    expect(peer.lastPrompt).toBe("Fix the flush test");
    expect(peer.lastReply).toBe("Patched relayBridge.");
    expect(peer.state).toBe("running");
    expect(peer.turnCount).toBe(2);
    expect(peer.isSelf).toBe(false);
  });

  it("still describes a section with no readable transcript", () => {
    const peer = summarizePeer(thread({ id: "fresh" }), { now: NOW });
    expect(peer.lastPrompt).toBeUndefined();
    expect(peer.turnCount).toBe(0);
    expect(peer.title).toBe("Section fresh");
  });
});

describe("rendering", () => {
  const page = { limit: DEFAULT_PAGE_TURNS, offset: 0 };

  it("says so plainly when the workspace is empty", () => {
    expect(renderPeerList([], "/repo")).toContain("No other sections");
  });

  it("marks the asking section and names the next tool", () => {
    const peers = [summarizePeer(thread({ id: "self" }), { selfId: "self", transcript: transcript(exchange), now: NOW })];
    const text = renderPeerList(peers, "/repo");
    expect(text).toContain("(you)");
    expect(text).toContain("read_session");
  });

  it("marks a section the user starred, and says what the mark is for", () => {
    const peers = [summarizePeer(thread({ id: "e2e", title: "Admin-flutter e2e", starred: true }), { now: NOW })];
    const text = renderPeerList(peers, "/repo");
    expect(text).toContain("## ★ Admin-flutter e2e");
    expect(text).toContain("send_message");
  });

  it("leaves the star legend off a board with nothing starred", () => {
    // Otherwise every list explains a mark the reader will never see.
    const peers = [summarizePeer(thread({ id: "plain" }), { now: NOW })];
    expect(renderPeerList(peers, "/repo")).not.toContain("★");
  });

  // The invariant the incident broke: the list quoted a reply that the reader
  // then claimed did not exist. Both now project the same transcript.
  it("promises in the list exactly what the reader can deliver", () => {
    const loaded = transcript(exchange);
    const peer = summarizePeer(thread({ id: "busy", status: "exited", agentState: "exited" }), { transcript: loaded, now: NOW });
    expect(renderPeerList([peer], "/repo")).toContain("2 turns readable");
    expect(renderPeerDetail(peer, loaded, page)).toContain("Patched relayBridge.");
  });

  it("labels the two speakers and numbers the turns in a detail view", () => {
    const peer = summarizePeer(thread({ id: "busy" }), { transcript: transcript(exchange), now: NOW });
    const text = renderPeerDetail(peer, transcript(exchange), page);
    expect(text).toContain("**Operator** · turn 1");
    expect(text).toContain("**Agent** · turn 2");
    expect(text).toContain("turns 1–2 of 2");
  });

  it("distinguishes a section with no transcript file from one that has said nothing", () => {
    const linkless = summarizePeer(thread({ id: "a", status: "exited", agentState: "exited" }), {
      transcript: missingTranscript("not-linked"),
      now: NOW,
    });
    expect(renderPeerDetail(linkless, missingTranscript("not-linked"), page)).toContain("has not reported a session id");

    const empty = transcript([]);
    const quiet = summarizePeer(thread({ id: "b" }), { transcript: empty, now: NOW });
    expect(renderPeerDetail(quiet, empty, page)).toContain("holds no turns yet");
  });

  it("pages backwards through older turns and says how to reach them", () => {
    const many = transcript(
      Array.from({ length: 30 }, (_, index) => ({ role: index % 2 === 0 ? ("user" as const) : ("agent" as const), text: `turn ${index + 1}` })),
    );
    const peer = summarizePeer(thread({ id: "a" }), { transcript: many, now: NOW });

    const latest = renderPeerDetail(peer, many, page);
    expect(latest).toContain("turns 19–30 of 30");
    expect(latest).toContain("offset: 12");

    const older = renderPeerDetail(peer, many, { limit: 12, offset: 12 });
    expect(older).toContain("turns 7–18 of 30");
    expect(older).toContain("6 older turns above this page");
    expect(older).toContain("12 newer turns below this page");
  });

  it("announces every truncation and says which call returns the rest", () => {
    const long = transcript([{ role: "agent", text: "x".repeat(TURN_PREVIEW_CAP + 500) }]);
    const peer = summarizePeer(thread({ id: "a" }), { transcript: long, now: NOW });

    const clipped = renderPeerDetail(peer, long, page);
    expect(clipped).toContain("TRUNCATED: 500 of 2,500 characters not shown");
    expect(clipped).toContain("turn: 1");

    expect(renderPeerDetail(peer, long, { ...page, full: true })).not.toContain("TRUNCATED");
  });

  it("returns one long turn whole, in parts, with a pointer to the next", () => {
    const long = transcript([{ role: "agent", text: "abc".repeat(TURN_PART_CHARS) }]);
    const peer = summarizePeer(thread({ id: "a" }), { transcript: long, now: NOW });

    const first = renderPeerTurn(peer, long, 1, 1);
    expect(first).toContain("part 1 of 3");
    expect(first).toContain("part: 2");

    const last = renderPeerTurn(peer, long, 1, 3);
    expect(last).toContain("part 3 of 3");
    expect(last).not.toContain("CONTINUES");

    expect(renderPeerTurn(peer, long, 9, 1)).toContain("there is no turn 9");
  });
});

describe("renderInbox", () => {
  it("reports a message as read only once it shows up in the target's own transcript", () => {
    const records = [{ at: "2026-08-01T11:00:00.000Z", to: "a", fromTitle: "Reviewer", preview: "stop editing relayBridge" }];
    const unseen = transcript(exchange);
    expect(renderInbox(records, unseen)).toContain("not read yet");

    const seen = transcript([...exchange, { role: "user", text: "[Message from …] stop editing relayBridge please" }]);
    expect(renderInbox(records, seen)).toContain("**read**");
  });
});

describe("matchThread", () => {
  const threads = [
    { id: "2b16a124-5299-46dd-9075-1e82a92f69a1", title: "Print findings audit" },
    { id: "2b16ffff-0000-0000-0000-000000000000", title: "Other audit" },
    { id: "6a6abf54-d1d5-4938-86a6-2570f66da0b6", title: "Docs pass" },
  ];

  it("accepts the id fragment an agent actually quotes", () => {
    expect(matchThread(threads, "2b16a124")?.title).toBe("Print findings audit");
    expect(matchThread(threads, "6a6abf54-d1d5-4938-86a6-2570f66da0b6")?.title).toBe("Docs pass");
  });

  it("falls back to titles rather than guessing between two matching prefixes", () => {
    expect(matchThread(threads, "2b16")).toBeUndefined();
    expect(matchThread(threads, "docs")?.title).toBe("Docs pass");
  });
});

describe("the sub-thread tree", () => {
  // alpha
  //  └ beta
  //     └ gamma
  // delta (unrelated, top-level)
  const tree = [
    thread({ id: "alpha" }),
    thread({ id: "beta", parentId: "alpha" }),
    thread({ id: "gamma", parentId: "beta" }),
    thread({ id: "delta" }),
  ];

  it("walks from a section up to its top-level ancestor", () => {
    expect(ancestorIds(tree, "gamma")).toEqual(["beta", "alpha"]);
    expect(ancestorIds(tree, "alpha")).toEqual([]);
    expect(subthreadDepth(tree, "gamma")).toBe(2);
    expect(subthreadDepth(tree, "delta")).toBe(0);
  });

  it("collects a whole branch, and only that branch", () => {
    expect(descendantIds(tree, "alpha")).toEqual(["beta", "gamma"]);
    expect(descendantIds(tree, "delta")).toEqual([]);
    expect(childrenOf(tree, "alpha").map((child) => child.id)).toEqual(["beta"]);
  });

  it("ends the walk at a parent that no longer exists instead of throwing", () => {
    const orphan = [thread({ id: "lost", parentId: "deleted-long-ago" })];
    expect(ancestorIds(orphan, "lost")).toEqual([]);
    expect(subthreadDepth(orphan, "lost")).toBe(0);
  });

  it("survives a cycle that a hand-edited threads.json could contain", () => {
    const cyclic = [thread({ id: "one", parentId: "two" }), thread({ id: "two", parentId: "one" })];
    expect(ancestorIds(cyclic, "one")).toEqual(["two"]);
    expect(descendantIds(cyclic, "one")).toEqual(["two"]);
  });

  describe("canAdopt", () => {
    it("allows an ordinary nesting", () => {
      expect(canAdopt(tree, "alpha", "delta").ok).toBe(true);
    });

    it("refuses a section as its own parent", () => {
      expect(canAdopt(tree, "alpha", "alpha").ok).toBe(false);
    });

    it("refuses the move that would close a loop", () => {
      // alpha under its own grandchild.
      const check = canAdopt(tree, "gamma", "alpha");
      expect(check.ok).toBe(false);
      expect(check.ok === false && check.reason).toContain("already inside");
    });

    it("refuses a parent that has been deleted", () => {
      expect(canAdopt(tree, "vanished", "delta").ok).toBe(false);
    });

    it("stops at the depth cap, counting the branch being moved", () => {
      // A fourth level: gamma is already at depth 2.
      const tooDeep = canAdopt(tree, "gamma", "delta");
      expect(tooDeep.ok).toBe(false);
      expect(tooDeep.ok === false && tooDeep.reason).toContain(String(MAX_SUBTHREAD_DEPTH));

      // Moving a section that HAS children counts their depth too: beta's
      // branch is one level tall, so it cannot go under another sub-thread.
      const withBranch = [...tree, thread({ id: "epsilon", parentId: "delta" })];
      expect(canAdopt(withBranch, "beta", "delta").ok).toBe(false);
    });
  });
});

describe("the peer list's view of the tree", () => {
  const threads = [
    thread({ id: "alpha", title: "Orchestrator" }),
    thread({ id: "beta", title: "Ledger tests", parentId: "alpha" }),
  ];

  it("names a section's parent and its sub-threads, resolving the caller's own title", () => {
    const peers = threads.map((entry) =>
      summarizePeer(entry, { selfId: "alpha", transcript: missingTranscript("not-found"), threads }),
    );
    const text = renderPeerList(peers, "/repo", "alpha");

    expect(text).toContain('sub-thread of "Orchestrator"');
    expect(text).toContain("you opened it");
    expect(text).toContain('sub-threads (1): "Ledger tests"');
  });
});

describe("activity", () => {
  const bash = (id: string, command: string) =>
    JSON.stringify({ type: "assistant", timestamp: "t1", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const result = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });

  it("reports the command a Claude section has not finished", () => {
    const activity = parseClaudeActivity([bash("t_1", "pnpm typecheck")].join("\n"));
    expect(activity).toMatchObject({ kind: "command", detail: "pnpm typecheck", pending: true });
  });

  it("stops reporting a command once its result lands", () => {
    const activity = parseClaudeActivity([bash("t_1", "pnpm typecheck"), result("t_1")].join("\n"));
    expect(activity?.pending).toBe(false);
  });

  it("tracks the newest call, not the first unanswered one", () => {
    const activity = parseClaudeActivity([bash("t_1", "git status"), result("t_1"), bash("t_2", "pnpm test")].join("\n"));
    expect(activity).toMatchObject({ detail: "pnpm test", pending: true });
  });

  it("names a non-shell tool by what it is working on", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t_1", name: "Edit", input: { file_path: "/repo/App.tsx" } }] },
    });
    expect(parseClaudeActivity(line)).toMatchObject({ kind: "tool", detail: "Edit /repo/App.tsx" });
  });

  it("reads a Codex shell call out of its JSON arguments", () => {
    const call = JSON.stringify({
      timestamp: "t1",
      payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "pnpm build" }) },
    });
    expect(parseCodexActivity(call)).toMatchObject({ kind: "command", detail: "pnpm build", pending: true });
    const answered = [call, JSON.stringify({ payload: { type: "function_call_output", call_id: "c1", output: "ok" } })].join("\n");
    expect(parseCodexActivity(answered)?.pending).toBe(false);
  });

  it("survives the half-written line a live tail read ends on", () => {
    expect(parseClaudeActivity(`${bash("t_1", "pnpm test")}\n{"type":"assis`)).toMatchObject({ detail: "pnpm test" });
  });

  // A dangling call in a transcript that ENDED was interrupted, not left running:
  // reporting it live is how a caller waits forever on a section that stopped.
  it("only surfaces a running section's command in the list", () => {
    const live = summarizePeer(thread({ id: "a", agentState: "working" }), {
      transcript: transcript(exchange, { activity: { kind: "command", detail: "pnpm typecheck", pending: true } }),
      now: NOW,
    });
    expect(renderPeerList([live], "/repo")).toContain("running now:");

    const dead = summarizePeer(thread({ id: "a", status: "exited", agentState: "exited" }), {
      transcript: transcript(exchange, { activity: { kind: "command", detail: "pnpm typecheck", pending: true } }),
      now: NOW,
    });
    expect(renderPeerList([dead], "/repo")).not.toContain("running now:");
  });

  it("puts the machine headline where every section will read it", () => {
    const peer = summarizePeer(thread({ id: "a" }), { transcript: transcript(exchange), now: NOW });
    expect(renderPeerList([peer], "/repo", undefined, "Machine: load 9.0")).toContain("Machine: load 9.0");
  });
});
