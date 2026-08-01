import { describe, expect, it } from "vitest";
import type { PersistedThread } from "./ipc";
import {
  parseClaudeTurns,
  parseCodexTurns,
  peerActivity,
  renderPeerDetail,
  renderPeerList,
  sameWorkspace,
  selectWorkspacePeers,
  summarizePeer,
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

describe("sameWorkspace", () => {
  it("ignores a trailing slash", () => {
    expect(sameWorkspace("/repo/", "/repo")).toBe(true);
    expect(sameWorkspace("/repo", "/repo-two")).toBe(false);
  });
});

describe("peerActivity", () => {
  it("reports a live mid-turn agent as working", () => {
    expect(peerActivity(thread({ id: "a", status: "running", agentState: "working" }))).toBe("working");
  });

  it("treats an approval prompt as waiting on the operator", () => {
    expect(peerActivity(thread({ id: "a", status: "running", agentState: "needs_action" }))).toBe("waiting");
  });

  it("reports a dead process as finished even when its state was left mid-turn", () => {
    // A crash leaves `agentState: working` behind; the process is what decides.
    expect(peerActivity(thread({ id: "a", status: "exited", agentState: "working" }))).toBe("exited");
    expect(peerActivity(thread({ id: "a", status: "error", agentState: "working" }))).toBe("exited");
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
    expect(peers.map((peer) => peer.id)).toEqual(["busy", "done"]);
  });

  it("puts working sections first even when a finished one is more recent", () => {
    const peers = selectWorkspacePeers(threads, { cwd: "/repo" });
    expect(peers[0]?.id).toBe("busy");
  });

  it("includes the asking section by default", () => {
    const peers = selectWorkspacePeers(threads, { cwd: "/repo", selfId: "self" });
    expect(peers.map((peer) => peer.id)).toContain("self");
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
    expect(parseClaudeTurns(claudeTranscript)).toEqual([
      { role: "user", text: "Fix the flush test", at: "t1" },
      { role: "agent", text: "Patched relayBridge.", at: "t2" },
    ]);
  });

  it("returns only the tail when a limit is given", () => {
    expect(parseClaudeTurns(claudeTranscript, 1)).toEqual([{ role: "agent", text: "Patched relayBridge.", at: "t2" }]);
  });
});

describe("parseCodexTurns", () => {
  it("reads both legacy message rows and current app-server event rows", () => {
    const transcript = [
      JSON.stringify({ timestamp: "t1", payload: { type: "message", role: "user", content: [{ type: "text", text: "Ship it" }] } }),
      JSON.stringify({ timestamp: "t2", payload: { type: "reasoning", content: [{ type: "text", text: "thinking" }] } }),
      JSON.stringify({ timestamp: "t3", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Shipped" }] } }),
      JSON.stringify({ timestamp: "t4", payload: { type: "user_message", message: "Follow-up" } }),
      JSON.stringify({ timestamp: "t5", payload: { type: "agent_message", message: "Done" } }),
    ].join("\n");

    expect(parseCodexTurns(transcript)).toEqual([
      { role: "user", text: "Ship it", at: "t1" },
      { role: "agent", text: "Shipped", at: "t3" },
      { role: "user", text: "Follow-up", at: "t4" },
      { role: "agent", text: "Done", at: "t5" },
    ]);
  });
});

describe("summarizePeer", () => {
  it("surfaces the latest exchange of each side", () => {
    const peer = summarizePeer(thread({ id: "busy", agentState: "working" }), { selfId: "self", transcript: claudeTranscript });
    expect(peer.lastPrompt).toBe("Fix the flush test");
    expect(peer.lastReply).toBe("Patched relayBridge.");
    expect(peer.activity).toBe("working");
    expect(peer.isSelf).toBe(false);
  });

  it("still describes a section with no readable transcript", () => {
    const peer = summarizePeer(thread({ id: "fresh" }), {});
    expect(peer.lastPrompt).toBeUndefined();
    expect(peer.title).toBe("Section fresh");
  });
});

describe("rendering", () => {
  it("says so plainly when the workspace is empty", () => {
    expect(renderPeerList([], "/repo")).toContain("No other sections");
  });

  it("marks the asking section and names the next tool", () => {
    const peers = [summarizePeer(thread({ id: "self" }), { selfId: "self", transcript: claudeTranscript })];
    const text = renderPeerList(peers, "/repo");
    expect(text).toContain("(you)");
    expect(text).toContain("read_session");
  });

  it("labels the two speakers in a detail view", () => {
    const peer = summarizePeer(thread({ id: "busy" }), { transcript: claudeTranscript });
    const text = renderPeerDetail(peer, parseClaudeTurns(claudeTranscript));
    expect(text).toContain("**Operator**");
    expect(text).toContain("**Agent**");
  });
});
