import { connect } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PersistedThread } from "../shared/ipc";
import { createPeerMessageDeliverer, startPeerMessageServer } from "./peerMessaging";

function thread(overrides: Partial<PersistedThread> & { id: string; title: string }): PersistedThread {
  return {
    cwd: "/repo",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastActiveAt: "2026-08-01T00:00:00.000Z",
    status: "running",
    ...overrides,
  } as PersistedThread;
}

function setup(threads: PersistedThread[], sendResult: { ok: boolean; message?: string } = { ok: true }) {
  const sendInput = vi.fn(async () => sendResult);
  const deliverer = createPeerMessageDeliverer({
    readThreads: () => threads,
    sendInput,
    log: () => {},
  });
  return { deliverer, sendInput };
}

const peers = [
  thread({ id: "alpha", title: "Relay work" }),
  thread({ id: "beta", title: "Docs pass" }),
  thread({ id: "gamma", title: "Other repo", cwd: "/elsewhere" }),
];

describe("peer message delivery", () => {
  it("caps generated titles and preserves a manual title", () => {
    const setTitle = vi.fn();
    const generated = createPeerMessageDeliverer({
      readThreads: () => peers,
      sendInput: vi.fn(async () => ({ ok: true })),
      setTitle,
      log: () => {},
    });

    expect(generated.setOwnTitle({ from: "alpha", cwd: "/repo", title: "x".repeat(100) }).ok).toBe(true);
    expect(setTitle.mock.calls[0]?.[1]).toBe(`${"x".repeat(79)}…`);

    const manual = createPeerMessageDeliverer({
      readThreads: () => [thread({ id: "alpha", title: "My own name", titleSource: "manual" })],
      sendInput: vi.fn(async () => ({ ok: true })),
      setTitle,
      log: () => {},
    });
    expect(manual.setOwnTitle({ from: "alpha", cwd: "/repo", title: "Generated name" }).message).toContain("Kept");
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it("delivers to a section matched by id, tagged with the sender", async () => {
    const { deliverer, sendInput } = setup(peers);

    const result = await deliverer.deliver({ op: "send", from: "alpha", to: "beta", cwd: "/repo", text: "Leave pricing.ts to me." });

    expect(result.ok).toBe(true);
    expect(sendInput).toHaveBeenCalledOnce();
    const [request] = sendInput.mock.calls[0] as unknown as [{ id: string; data: string }];
    expect(request.id).toBe("beta");
    expect(request.data).toContain("Relay work");
    expect(request.data).toContain("Leave pricing.ts to me.");
  });

  it("matches a title fragment when no id matches", async () => {
    const { deliverer, sendInput } = setup(peers);

    await deliverer.deliver({ op: "send", from: "alpha", to: "docs", cwd: "/repo", text: "ping" });

    expect((sendInput.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe("beta");
  });

  it("cannot reach a section in another workspace", async () => {
    const { deliverer, sendInput } = setup(peers);

    const result = await deliverer.deliver({ op: "send", from: "alpha", to: "gamma", cwd: "/repo", text: "ping" });

    expect(result.ok).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("refuses a message a section addresses to itself", async () => {
    const { deliverer, sendInput } = setup(peers);

    const result = await deliverer.deliver({ op: "send", from: "alpha", to: "alpha", cwd: "/repo", text: "ping" });

    expect(result.ok).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("stops a sender that floods a neighbour", async () => {
    const { deliverer, sendInput } = setup(peers);

    const results = [];
    for (let index = 0; index < 10; index += 1) {
      results.push(await deliverer.deliver({ op: "send", from: "alpha", to: "beta", cwd: "/repo", text: `ping ${index}` }));
    }

    expect(results.filter((result) => result.ok)).toHaveLength(8);
    expect(sendInput).toHaveBeenCalledTimes(8);
    expect(results.at(-1)?.message).toContain("Rate limit");
  });

  it("reports a refused delivery instead of claiming success", async () => {
    const { deliverer } = setup(peers, { ok: false, message: "This section's agent is no longer running." });

    const result = await deliverer.deliver({ op: "send", from: "alpha", to: "beta", cwd: "/repo", text: "ping" });

    expect(result).toEqual({ ok: false, message: "This section's agent is no longer running." });
  });

  it("rejects an empty message and an oversized one", async () => {
    const { deliverer, sendInput } = setup(peers);

    expect((await deliverer.deliver({ op: "send", from: "alpha", to: "beta", cwd: "/repo", text: "   " })).ok).toBe(false);
    expect((await deliverer.deliver({ op: "send", from: "alpha", to: "beta", cwd: "/repo", text: "x".repeat(5000) })).ok).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
  });
});

describe("peer message deliverability", () => {
  // The old code answered "queued … will be read when that section's current
  // turn ends" for a section that would never read anything again.
  it("refuses a section that has ended and cannot be restarted", async () => {
    const sendInput = vi.fn(async () => ({ ok: true }));
    const deliverer = createPeerMessageDeliverer({
      readThreads: () => [thread({ id: "alpha", title: "Relay work" }), thread({ id: "beta", title: "Docs pass", status: "exited" })],
      sendInput,
      liveSessionIds: () => ["alpha"],
      canRestart: () => false,
      log: () => {},
    });

    const result = await deliverer.deliver({ op: "send", from: "alpha", to: "beta", cwd: "/repo", text: "ping" });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("cannot receive");
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("says how the message will actually arrive", async () => {
    const threads = [
      thread({ id: "alpha", title: "Relay work" }),
      thread({ id: "busy", title: "Busy one", agentState: "working" }),
      thread({ id: "dormant", title: "Dormant one", status: "exited" }),
    ];
    const deliverer = createPeerMessageDeliverer({
      readThreads: () => threads,
      sendInput: async () => ({ ok: true }),
      liveSessionIds: () => ["alpha", "busy"],
      canRestart: () => true,
      log: () => {},
    });

    expect((await deliverer.deliver({ op: "send", from: "alpha", to: "busy", cwd: "/repo", text: "a" })).message).toContain("mid-turn");
    expect((await deliverer.deliver({ op: "send", from: "alpha", to: "dormant", cwd: "/repo", text: "b" })).message).toContain("restarted");
  });

  it("journals what it delivered so the target's transcript can be checked for it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "panda-peers-journal-"));
    const messagesPath = join(directory, "peer-messages.json");
    const deliverer = createPeerMessageDeliverer({
      readThreads: () => peers,
      sendInput: async () => ({ ok: true }),
      liveSessionIds: () => ["alpha", "beta"],
      messagesPath,
      log: () => {},
    });

    try {
      await deliverer.deliver({ op: "send", from: "alpha", to: "beta", cwd: "/repo", text: "Leave pricing.ts to me." });

      const records = JSON.parse(readFileSync(messagesPath, "utf8")) as { to: string; preview: string; fromTitle?: string }[];
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ to: "beta", fromTitle: "Relay work", preview: "Leave pricing.ts to me." });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("spawned section completion", () => {
  const parent = thread({ id: "alpha", title: "Relay work" });
  const transcript = (turns: { role: "user" | "agent"; text: string }[]) => ({
    found: true,
    turns,
    complete: true,
    omittedBytes: 0,
    modifiedAt: 0,
  });

  function setupWatch(childState: Partial<PersistedThread>, turns: { role: "user" | "agent"; text: string }[]) {
    const child = thread({ id: "new-section", title: "Ledger tests", ...childState });
    const sendInput = vi.fn(async () => ({ ok: true }));
    const deliverer = createPeerMessageDeliverer({
      readThreads: () => [parent, child],
      sendInput,
      createSection: async () => ({ ok: true, id: "new-section" }),
      liveSessionIds: () => ["alpha", ...(child.status === "running" ? ["new-section"] : [])],
      readTranscript: () => transcript(turns),
      log: () => {},
    });
    return { deliverer, sendInput };
  }

  // Completion is silent by design: the parent asks (`wait_for_session`,
  // `list_sessions`) instead of being interrupted. Only the watch is retired.
  it("retires the watch when a section it opened is done, without notifying the spawner", async () => {
    const { deliverer, sendInput } = setupWatch({ status: "exited", agentState: "exited" }, [{ role: "agent", text: "All four claims hold." }]);

    await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Audit the claims", title: "Ledger tests" });
    expect(deliverer.watchedSectionIds()).toEqual(["new-section"]);

    await deliverer.pollWatches();
    await deliverer.pollWatches();

    // Only the opening task was ever sent.
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(deliverer.watchedSectionIds()).toEqual([]);
  });

  // The shape a healthy sub-thread ACTUALLY settles in. The Claude CLI runs with
  // `--input-format stream-json`, so its process outlives the turn: a section
  // that has done its work is alive and idle, not exited. It must be retired
  // just as silently as an exited one, or the watch leaks until it times out.
  it("retires a live section that answered and went quiet", async () => {
    const { deliverer, sendInput } = setupWatch({ status: "running", agentState: "waiting" }, [
      { role: "user", text: "Audit the claims" },
      { role: "agent", text: "All four claims hold." },
    ]);

    await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Audit the claims", title: "Ledger tests" });
    await deliverer.pollWatches();

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(deliverer.watchedSectionIds()).toEqual([]);
  });

  it("does not call an approval-blocked section finished", async () => {
    const { deliverer, sendInput } = setupWatch({ status: "running", agentState: "needs_action" }, [
      { role: "user", text: "Audit the claims" },
      { role: "agent", text: "I need approval before I can run that command." },
    ]);

    await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Audit the claims", title: "Ledger tests" });
    await deliverer.pollWatches();

    const [notice] = sendInput.mock.calls[1] as unknown as [{ id: string; data: string }];
    expect(notice.id).toBe("alpha");
    expect(notice.data).toContain("still needs input");
    expect(notice.data).toContain("waiting on an approval or a question");
    expect(notice.data).not.toContain("has finished");
    expect(deliverer.watchedSectionIds()).toEqual(["new-section"]);

    await deliverer.pollWatches();
    expect(sendInput).toHaveBeenCalledTimes(2);
  });

  // The false-completion bug: a running section whose transcript has been quiet
  // for longer than the freshness window (thinking, a build, a background e2e
  // run). It must NOT be announced on the strength of that silence alone.
  it("does not announce a running section that has merely gone quiet", async () => {
    const { deliverer, sendInput } = setupWatch({ status: "running", agentState: "working" }, [
      { role: "user", text: "Audit the claims" },
      { role: "agent", text: "Reading the ledger now..." },
    ]);

    await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Audit the claims" });
    await deliverer.pollWatches();
    await deliverer.pollWatches();

    expect(sendInput).toHaveBeenCalledTimes(1); // the opening task, and nothing else
  });

  it("does not announce a section that is still working", async () => {
    const { deliverer, sendInput } = setupWatch({ agentState: "working" }, [{ role: "user", text: "Audit the claims" }]);

    await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Audit the claims" });
    await deliverer.pollWatches();
    await deliverer.pollWatches();

    expect(sendInput).toHaveBeenCalledTimes(1); // the opening task, and nothing else
    expect(deliverer.watchedSectionIds()).toEqual(["new-section"]);
  });

  it("keeps watching until the section settles, then drops it silently", async () => {
    let agentState: PersistedThread["agentState"] = "working";
    const child = () => thread({ id: "new-section", title: "Ledger tests", agentState });
    const sendInput = vi.fn(async () => ({ ok: true }));
    const deliverer = createPeerMessageDeliverer({
      readThreads: () => [parent, child()],
      sendInput,
      createSection: async () => ({ ok: true, id: "new-section" }),
      liveSessionIds: () => ["alpha", "new-section"],
      readTranscript: () => transcript([{ role: "user", text: "Audit" }, { role: "agent", text: "All four claims hold." }]),
      log: () => {},
    });

    await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Audit the claims" });
    await deliverer.pollWatches();
    expect(sendInput).toHaveBeenCalledTimes(1);

    // Codex sections never exit; "answered and gone quiet" is their completion.
    agentState = "waiting";
    await deliverer.pollWatches();

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(deliverer.watchedSectionIds()).toEqual([]);
  });

  it("says nothing about a section that died with nothing to read", async () => {
    const { deliverer, sendInput } = setupWatch({ status: "error", agentState: "exited" }, []);

    await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Audit the claims" });
    await deliverer.pollWatches();

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(deliverer.watchedSectionIds()).toEqual([]);
  });
});

function setupCreate(
  threads: PersistedThread[],
  started: { ok: boolean; id?: string; message?: string } = { ok: true, id: "new-section" },
) {
  const sendInput = vi.fn(async () => ({ ok: true }));
  const createSection = vi.fn(async () => started);
  const deliverer = createPeerMessageDeliverer({
    readThreads: () => threads,
    sendInput,
    createSection,
    log: () => {},
  });
  return { deliverer, sendInput, createSection };
}

describe("peer section creation", () => {
  const creators = [
    thread({ id: "alpha", title: "Relay work", runtime: "codex", model: "gpt-5", effort: "high", permissionMode: "workspace-write" }),
  ];

  it("opens a section inheriting the creator's runtime and settings, then prompts it", async () => {
    const { deliverer, createSection, sendInput } = setupCreate(creators);

    const result = await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Port the ledger tests", title: "Ledger tests" });

    expect(result.ok).toBe(true);
    expect(result.id).toBe("new-section");
    expect(createSection).toHaveBeenCalledWith({
      cwd: "/repo",
      title: "Ledger tests",
      runtime: "codex",
      model: "gpt-5",
      effort: "high",
      permissionMode: "workspace-write",
      // Nesting is the default: the section that asked for the work owns it.
      parentId: "alpha",
    });
    const [request] = sendInput.mock.calls[0] as unknown as [{ id: string; data: string }];
    expect(request.id).toBe("new-section");
    expect(request.data).toContain("Port the ledger tests");
    expect(request.data).toContain("Relay work");
  });

  it("does not carry the creator's model or permissions across a runtime change", async () => {
    const { deliverer, createSection } = setupCreate(creators);

    await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", runtime: "claude", task: "Review the diff" });

    expect(createSection).toHaveBeenCalledWith({
      cwd: "/repo",
      title: undefined,
      runtime: "claude",
      model: undefined,
      effort: undefined,
      permissionMode: undefined,
      parentId: "alpha",
    });
  });

  it("preserves full access for a child and rejects an escalation request", async () => {
    const fullAccessCreator = [
      thread({ id: "alpha", title: "Trusted work", runtime: "codex", permissionMode: "danger-full-access" }),
    ];
    const { deliverer, createSection } = setupCreate(fullAccessCreator);

    await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Run the trusted migration" });
    expect(createSection).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "danger-full-access" }));

    const restricted = thread({ id: "beta", title: "Restricted work", runtime: "codex", permissionMode: "read-only" });
    const second = setupCreate([restricted]);
    const result = await second.deliverer.create({
      op: "create",
      from: "beta",
      cwd: "/repo",
      task: "Break out of the sandbox",
      permissionMode: "danger-full-access",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("more permissive");
    expect(second.createSection).not.toHaveBeenCalled();
  });

  it("rejects an empty task, an oversized one, and an unknown workspace", async () => {
    const { deliverer, createSection } = setupCreate(creators);

    expect((await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "  " })).ok).toBe(false);
    expect((await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "x".repeat(20_000) })).ok).toBe(false);
    expect((await deliverer.create({ op: "create", from: "alpha", cwd: "", task: "do the thing" })).ok).toBe(false);
    expect(createSection).not.toHaveBeenCalled();
  });

  it("reports a section that opened but refused its first prompt as a failure", async () => {
    const sendInput = vi.fn(async () => ({ ok: false, message: "transport is gone" }));
    const deliverer = createPeerMessageDeliverer({
      readThreads: () => creators,
      sendInput,
      createSection: async () => ({ ok: true, id: "new-section" }),
      log: () => {},
    });

    const result = await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "do the thing" });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("transport is gone");
  });

  it("stops a section from opening sections without end", async () => {
    const { deliverer } = setupCreate(creators);

    const results = [];
    for (let index = 0; index < 5; index += 1) {
      results.push(await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: `task ${index}` }));
    }

    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.at(-1)?.message).toContain("Rate limit");
  });

  it("refuses when the build cannot open sections", async () => {
    const { deliverer } = setup(creators);

    expect((await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "do the thing" })).ok).toBe(false);
  });
});

describe("sibling vs sub-thread", () => {
  const creators = [thread({ id: "alpha", title: "Relay work" })];

  it("opens a sibling — no parent — when the caller asks for one", async () => {
    const { deliverer, createSection } = setupCreate(creators);

    const result = await deliverer.create({ op: "create", from: "alpha", cwd: "/repo", mode: "sibling", task: "Separate errand" });

    expect(result.ok).toBe(true);
    expect((createSection.mock.calls[0] as unknown as [{ parentId?: string }])[0].parentId).toBeUndefined();
    expect(result.message).toContain("alongside");
  });

  it("tells a sub-thread it is one, and tells a sibling it is not", async () => {
    const subthread = setupCreate(creators);
    await subthread.deliverer.create({ op: "create", from: "alpha", cwd: "/repo", task: "Port the tests" });
    const nested = (subthread.sendInput.mock.calls[0] as unknown as [{ data: string }])[0].data;
    expect(nested).toContain("SUB-THREAD");
    expect(nested).toContain("send_message` your parent");

    const sibling = setupCreate(creators);
    await sibling.deliverer.create({ op: "create", from: "alpha", cwd: "/repo", mode: "sibling", task: "Port the tests" });
    const flat = (sibling.sendInput.mock.calls[0] as unknown as [{ data: string }])[0].data;
    expect(flat).not.toContain("SUB-THREAD");
    expect(flat).toContain("You do not need to report back");
  });

  it("opens a sibling, and says why, once the tree is at its depth limit", async () => {
    // alpha -> beta -> gamma is the deepest allowed; a sub-thread of gamma
    // would be a fourth level, so it is opened alongside instead of refused.
    const deep = [
      thread({ id: "alpha", title: "Top" }),
      thread({ id: "beta", title: "Middle", parentId: "alpha" }),
      thread({ id: "gamma", title: "Leaf", parentId: "beta" }),
    ];
    const { deliverer, createSection } = setupCreate(deep);

    const result = await deliverer.create({ op: "create", from: "gamma", cwd: "/repo", task: "One more level" });

    expect(result.ok).toBe(true);
    expect((createSection.mock.calls[0] as unknown as [{ parentId?: string }])[0].parentId).toBeUndefined();
    expect(result.message).toContain("already at the limit");
  });

  // A Codex section's shell has no per-section environment, so `panda-peers`
  // can arrive without a `from`. That silently cost the caller both halves of
  // the inheritance — the nesting AND the permission mode — and the reply read
  // as though a sibling was what it asked for. Say what actually happened.
  it("tells a caller it could not identify what it lost, and how to fix it", async () => {
    const { deliverer, createSection } = setupCreate(creators);

    const result = await deliverer.create({ op: "create", cwd: "/repo", task: "Nest me under you" });

    expect(result.ok).toBe(true);
    const spec = (createSection.mock.calls[0] as unknown as [{ parentId?: string; permissionMode?: string }])[0];
    expect(spec.parentId).toBeUndefined();
    expect(spec.permissionMode).toBeUndefined();
    expect(result.message).toContain("--self");
    expect(result.message).toContain("approve its commands");
    expect(result.message).not.toContain("already at the limit");
  });

  it("still nests one level below a sub-thread", async () => {
    const nested = [thread({ id: "alpha", title: "Top" }), thread({ id: "beta", title: "Middle", parentId: "alpha" })];
    const { deliverer, createSection } = setupCreate(nested);

    await deliverer.create({ op: "create", from: "beta", cwd: "/repo", task: "One level down" });

    expect((createSection.mock.calls[0] as unknown as [{ parentId?: string }])[0].parentId).toBe("beta");
  });

  it("routes `parent` to the section a sub-thread hangs under, labelled as a report", async () => {
    const tree = [thread({ id: "alpha", title: "Top" }), thread({ id: "beta", title: "Sub", parentId: "alpha" })];
    const { deliverer, sendInput } = setup(tree);

    const result = await deliverer.deliver({ op: "send", from: "beta", to: "parent", cwd: "/repo", text: "Done: 4 files, tests green." });

    expect(result.ok).toBe(true);
    const [request] = sendInput.mock.calls[0] as unknown as [{ id: string; data: string }];
    expect(request.id).toBe("alpha");
    expect(request.data).toContain("a SUB-THREAD you opened");
    expect(request.data).toContain("Done: 4 files");
  });

  it("labels a parent's instruction to its sub-thread as coming from the parent", async () => {
    const tree = [thread({ id: "alpha", title: "Top" }), thread({ id: "beta", title: "Sub", parentId: "alpha" })];
    const { deliverer, sendInput } = setup(tree);

    await deliverer.deliver({ op: "send", from: "alpha", to: "beta", cwd: "/repo", text: "Skip the CSS." });

    const [request] = sendInput.mock.calls[0] as unknown as [{ id: string; data: string }];
    expect(request.data).toContain("the section this one is a SUB-THREAD of");
  });

  it("tells a section with no parent that it has none, rather than guessing a target", async () => {
    const { deliverer, sendInput } = setup([thread({ id: "alpha", title: "Top" }), thread({ id: "beta", title: "Other" })]);

    const result = await deliverer.deliver({ op: "send", from: "alpha", to: "parent", cwd: "/repo", text: "hello?" });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a sub-thread");
    expect(sendInput).not.toHaveBeenCalled();
  });
});

describe("sub-thread completion notices", () => {
  const settled = {
    found: true,
    turns: [{ role: "user" as const, text: "Audit" }, { role: "agent" as const, text: "Done." }],
    complete: true,
    omittedBytes: 0,
    modifiedAt: 0,
  };

  it("notifies a parent from the RECORD, so the link survives a restart", async () => {
    // Nothing called `create` here: this deliverer is as fresh as one in a
    // relaunched app, and the only thing tying the two sections together is the
    // `parentId` on disk.
    const threads = [
      thread({ id: "alpha", title: "Top" }),
      thread({ id: "beta", title: "Sub", parentId: "alpha", agentState: "waiting" }),
    ];
    const sendInput = vi.fn(async () => ({ ok: true }));
    const deliverer = createPeerMessageDeliverer({
      readThreads: () => threads,
      sendInput,
      liveSessionIds: () => ["alpha", "beta"],
      readTranscript: () => settled,
      log: () => {},
    });

    await deliverer.pollWatches();
    await deliverer.pollWatches();

    // Nothing: it had already settled when this process first saw it, so there
    // is no "just finished" to report — only a stale interruption to avoid.
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("says nothing about a sub-thread that settles while it is being watched", async () => {
    let agentState: PersistedThread["agentState"] = "working";
    const threads = () => [
      thread({ id: "alpha", title: "Top" }),
      thread({ id: "beta", title: "Sub", parentId: "alpha", agentState }),
    ];
    const sendInput = vi.fn(async () => ({ ok: true }));
    const deliverer = createPeerMessageDeliverer({
      readThreads: threads,
      sendInput,
      liveSessionIds: () => ["alpha", "beta"],
      readTranscript: () => settled,
      log: () => {},
    });

    await deliverer.pollWatches();
    expect(sendInput).not.toHaveBeenCalled();

    agentState = "waiting";
    await deliverer.pollWatches();
    await deliverer.pollWatches();

    expect(sendInput).not.toHaveBeenCalled();
    expect(deliverer.watchedSectionIds()).toEqual([]);
  });

  it("still interrupts the parent when a sub-thread is blocked on input", async () => {
    const threads = () => [
      thread({ id: "alpha", title: "Top" }),
      thread({ id: "beta", title: "Sub", parentId: "alpha", agentState: "needs_action" }),
    ];
    const sendInput = vi.fn(async () => ({ ok: true }));
    const deliverer = createPeerMessageDeliverer({
      readThreads: threads,
      sendInput,
      liveSessionIds: () => ["alpha", "beta"],
      readTranscript: () => settled,
      log: () => {},
    });

    await deliverer.pollWatches();
    await deliverer.pollWatches();

    expect(sendInput).toHaveBeenCalledTimes(1);
    const [notice] = sendInput.mock.calls[0] as unknown as [{ id: string; data: string }];
    expect(notice.id).toBe("alpha");
    expect(notice.data).toContain("sub-thread");
    expect(notice.data).toContain("still needs input");
  });
});

describe("peer message socket", () => {
  function ask(socketPath: string, payload: unknown): Promise<{ ok?: boolean; message?: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath, () => socket.write(`${JSON.stringify(payload)}\n`));
      let response = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        response += chunk;
      });
      socket.on("end", () => resolve(JSON.parse(response.trim()) as { ok?: boolean }));
      socket.on("error", reject);
    });
  }

  it("answers a send and a create over the socket, and rejects anything else", async () => {
    const directory = mkdtempSync(join(tmpdir(), "panda-peers-"));
    const socketPath = join(directory, "peers.sock");
    const sendInput = vi.fn(async () => ({ ok: true }));
    const createSection = vi.fn(async () => ({ ok: true, id: "new-section" }));
    const setTitle = vi.fn();
    const server = startPeerMessageServer({
      socketPath,
      readThreads: () => peers,
      sendInput,
      createSection,
      setTitle,
      log: () => {},
    });

    try {
      const sent = await ask(socketPath, { op: "send", from: "alpha", to: "beta", cwd: "/repo", text: "handing over the docs pass" });
      expect(sent.ok).toBe(true);
      expect(sendInput).toHaveBeenCalledOnce();

      const created = await ask(socketPath, { op: "create", from: "alpha", cwd: "/repo", task: "take the docs pass", title: "Docs" });
      expect(created.ok).toBe(true);
      expect(createSection).toHaveBeenCalledOnce();

      const titled = await ask(socketPath, { op: "title", from: "alpha", cwd: "/repo", title: "Investigate flaky relay pairing" });
      expect(titled.ok).toBe(true);
      expect(setTitle).toHaveBeenCalledWith("alpha", "Investigate flaky relay pairing");

      const unknown = await ask(socketPath, { op: "nonsense" });
      expect(unknown.ok).toBe(false);
    } finally {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
