import { createServer, type Server, type Socket } from "node:net";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { AgentAttentionChoice, AgentRuntime, PersistedThread } from "../shared/ipc";
import { compactSectionTitle } from "../shared/section-title";
import {
  describeDelivery,
  EMPTY_TRANSCRIPT,
  formatPeerMessage,
  formatPeerNeedsInput,
  formatPeerTask,
  isSettled,
  isWaitingForInput,
  matchThread,
  MAX_SUBTHREAD_DEPTH,
  normalizeRuntime,
  peerStatus,
  subthreadDepth,
  PEER_MESSAGE_CAP,
  PEER_TASK_CAP,
  sameWorkspace,
  trimExcerpt,
  type PeerDelivery,
  type PeerMessageRecord,
  type PeerTranscript,
} from "../shared/workspace-peers";

/**
 * The write half of workspace awareness: one section handing another an
 * instruction.
 *
 * Reading peers is a disk job (`peers-entry.ts` parses `threads.json` and the
 * transcripts, with no app involved). Sending is not — a prompt only lands if
 * something drives the live transport, and that lives in the main process. So
 * the helper stops being self-sufficient here and asks the app, over a unix
 * socket in `userData`: no port to collide, no token to leak, and the file
 * permissions of the user's own data directory are the access control.
 *
 * Delivery goes through the same `sessionService.sendInput` the phone uses, so a
 * message to a dormant section restarts it and a message to a busy one queues
 * behind the turn in flight — both already true of a remote prompt.
 */

export type PeerMessageRequest = {
  op?: string;
  /** Section id of the sender; absent for a shell caller with no section env. */
  from?: string;
  /** Target section id, or a title fragment, as shown by `list_sessions`. */
  to?: string;
  /** Workspace the sender is in; targets are confined to it. */
  cwd?: string;
  text?: string;
};

/**
 * "Open a new section in this workspace and give it this task."
 *
 * The counterpart to a message: instead of interrupting a neighbour, the sender
 * gets a fresh session with its own transcript, model and cost. The operator
 * asks for it in words ("do the migration in a separate thread") and the agent
 * turns that into one of these.
 */
export type PeerSectionRequest = {
  op?: string;
  /** Section id of the creator; absent for a shell caller with no section env. */
  from?: string;
  /** Workspace the creator is in; the new section is confined to it. */
  cwd?: string;
  /** Opening prompt. Required — an empty section helps nobody. */
  task?: string;
  /** Sidebar name until the runtime generates one. */
  title?: string;
  /** Defaults to the creator's own runtime. */
  runtime?: string;
  model?: string;
  effort?: string;
  /** Optional permission/sandbox mode; it may not exceed the creator's mode. */
  permissionMode?: string;
  /**
   * Where the new section sits relative to its creator.
   *
   * `subthread` (the default) hangs it under the creator: it appears nested in
   * the sidebar, it is told to report its result back, and the creator is the
   * one accountable for it. `sibling` is the older, flatter thing — an
   * independent section the user will steer themselves, which is right when the
   * work is genuinely a separate errand rather than a piece of this one.
   *
   * The agent picks; the user re-arranges afterwards from either UI.
   */
  mode?: string;
};

/** "Give this section a useful generated name." */
export type PeerTitleRequest = {
  op?: string;
  from?: string;
  cwd?: string;
  title?: string;
};

/**
 * "Drive the browser the user is looking at."
 *
 * Unlike the backlog — a file the helper can read and write on its own — the
 * browser only exists inside the running app, so every one of these is a call
 * home. `action` names the operation (`open`, `read`, `click`, …) and the rest
 * of the fields are its arguments; the app answers with the text the agent sees.
 */
export type BrowserRequest = {
  op?: string;
  from?: string;
  cwd?: string;
  action?: string;
  tab?: string;
  url?: string;
  selector?: string;
  text?: string;
  links?: boolean;
  /** read: also report the state of the form controls, not just the words. */
  values?: boolean;
  submit?: boolean;
  /** type: empty the field first. note: take the note back off the page. */
  clear?: boolean;
  /** inspect: narrow by ARIA role, and to a subtree. */
  role?: string;
  within?: string;
  /** click: which button, and how many clicks. */
  button?: string;
  clickCount?: number;
  /** wait: how long to give it. */
  timeout?: number;
  /** key: the chord, e.g. "Escape" or "Cmd+A". */
  keys?: string;
  /** scroll: "top", "bottom", a selector, or a pixel delta. */
  to?: string;
  deltaY?: number;
  /** drag: the two ends, as selectors. (`from` is taken by the caller's id.) */
  start?: string;
  end?: string;
  /** cursor: what to do with the pointer, and where. Page CSS pixels. */
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  toX?: number;
  toY?: number;
  toSelector?: string;
  toText?: string;
  /** select_option: pick by value or by visible label. */
  value?: string;
  label?: string;
  /** upload: absolute paths to attach to a file input. */
  paths?: string[];
  /** record: `start` or `stop`, and the frame rate. */
  mode?: string;
  fps?: number;
  /**
   * screenshot/record: capture without bringing the tab to the front of the
   * user's panel. See `capture` in `browserService.ts` for what pays for it.
   */
  background?: boolean;
  /** activity: how many records to return. */
  limit?: number;
};

export type PeerAttentionRequest = {
  userRequested?: boolean;
  op?: string;
  from?: string;
  cwd?: string;
  summary?: string;
  detail?: string;
  severity?: string;
  choices?: AgentAttentionChoice[];
};

export type PeerMessageResponse = { ok: boolean; message: string; id?: string };

/** What the main process needs to open a section on a peer's behalf. */
export type PeerSectionSpec = {
  cwd: string;
  title?: string;
  runtime: AgentRuntime;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** Set when the new section is a sub-thread: the creator it hangs under. */
  parentId?: string;
};

function permissionRank(runtime: AgentRuntime, mode: string | undefined): number {
  const value = mode?.trim();
  if (!value) return runtime === "codex" ? 0 : 1;
  if (runtime === "codex") {
    return { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 }[value] ?? -1;
  }
  return { plan: 0, acceptEdits: 2, bypassPermissions: 3 }[value] ?? -1;
}

type Dependencies = {
  socketPath: string;
  readThreads: () => PersistedThread[];
  sendInput: (request: { id: string; data: string }) => Promise<{ ok: boolean; message?: string }>;
  /**
   * Start a section and return its id. Absent → creation is refused, which keeps
   * the deliverer usable in tests and in any build that does not wire it.
   */
  createSection?: (spec: PeerSectionSpec) => Promise<{ ok: boolean; id?: string; message?: string }>;
  /** Publish an automatic title to the renderer/relay. */
  setTitle?: (id: string, title: string) => void;
  /**
   * Ids with a live agent process right now. The authority on whether a message
   * can be delivered at all — `threads.json` only records what the UI last saw.
   */
  liveSessionIds?: () => readonly string[];
  /** Whether a dormant section can be restarted to receive a prompt. */
  canRestart?: (id: string) => boolean;
  /**
   * Drive the built-in browser on a section's behalf. Absent → the op is
   * refused, which keeps the server usable in tests and in any build without a
   * window to host the browser in.
   */
  browser?: (request: BrowserRequest) => Promise<PeerMessageResponse>;
  /** Pull the app forward with an explicit, time-sensitive user hand-off. */
  attention?: (request: PeerAttentionRequest) => Promise<PeerMessageResponse>;
  /** The section's transcript, for deciding finished-vs-failed in a completion notice. */
  readTranscript?: (thread: PersistedThread) => PeerTranscript;
  /** Where delivered messages are journalled so `read_session` can report reads. */
  messagesPath?: string;
  now?: () => number;
  log: (event: string, details?: Record<string, unknown>) => void;
};

/**
 * A sender may not flood a neighbour. Two agents can talk each other into a
 * ping-pong that neither one is able to see from the inside — the prompt header
 * discourages it, this stops it. Generous enough that legitimate coordination
 * (a handful of hand-offs during one piece of work) never trips it.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 8;

/**
 * Creating sections is rationed far harder than messaging them. A section is a
 * whole agent process with its own token spend, and the failure mode is not
 * noise but a fork bomb: a section that opens sections can be opened by a
 * section. Three in five minutes is more than any honest hand-off needs and
 * cheap to explain when it trips.
 */
const CREATE_WINDOW_MS = 5 * 60_000;
const CREATE_LIMIT = 3;

/**
 * How long a spawned section is watched for completion before the watch is
 * dropped. Long enough for real work, short enough that a section left idle
 * forever does not keep a timer alive for the life of the app.
 */
const WATCH_TIMEOUT_MS = 60 * 60_000;

/** How often spawned sections are checked for completion. */
const WATCH_POLL_MS = 4_000;

/** Journal entries kept; enough to cover any live coordination, bounded on disk. */
const JOURNAL_CAP = 200;

type ChildWatch = {
  parentId: string;
  childTitle: string;
  startedAt: number;
  /** True when the link is a real sub-thread rather than a bare spawn. */
  subthread: boolean;
};

export type PeerMessageDeliverer = {
  deliver: (request: PeerMessageRequest) => Promise<PeerMessageResponse>;
  create: (request: PeerSectionRequest) => Promise<PeerMessageResponse>;
  setOwnTitle: (request: PeerTitleRequest) => PeerMessageResponse;
  /**
   * Check the sections this one spawned and notify their spawners about any that
   * have settled. Driven by a timer in the server; called directly in tests.
   */
  pollWatches: () => Promise<void>;
  watchedSectionIds: () => string[];
};

/** The transport-free half, so the routing rules can be tested without a socket. */
export function createPeerMessageDeliverer(deps: Omit<Dependencies, "socketPath">): PeerMessageDeliverer {
  const recentBySender = new Map<string, number[]>();
  const watches = new Map<string, ChildWatch>();
  /**
   * Sub-threads whose parent has already been told (or that were finished before
   * this process ever saw them). The watch map is drained as notices go out, and
   * the record-driven seeding above would otherwise refill it from the same
   * `parentId` on the very next poll — a completion notice every four seconds
   * for the rest of the session.
   */
  const settledSubthreads = new Set<string>();
  const inputNotifiedChildren = new Set<string>();
  const now = (): number => (deps.now ? deps.now() : Date.now());

  function journal(record: PeerMessageRecord): void {
    if (!deps.messagesPath) {
      return;
    }

    try {
      let records: PeerMessageRecord[] = [];
      try {
        const parsed = JSON.parse(readFileSync(deps.messagesPath, "utf8")) as unknown;
        records = Array.isArray(parsed) ? (parsed as PeerMessageRecord[]) : [];
      } catch {
        // No journal yet, or a corrupt one; either way this record starts a new.
      }
      records.push(record);
      writeFileSync(deps.messagesPath, JSON.stringify(records.slice(-JOURNAL_CAP), null, 2), "utf8");
    } catch (error) {
      deps.log("peer-message-journal-failed", { error: String(error) });
    }
  }

  /**
   * Can this section actually receive a prompt, and how will it arrive?
   *
   * The old code reported every accepted write as "queued … will be read when
   * that section's current turn ends", which is a sentence about a live section
   * and a lie about any other. A caller acting on it waits for a reply that is
   * never coming.
   */
  function deliverability(thread: PersistedThread): { delivery: PeerDelivery; refusal?: string } {
    const live = deps.liveSessionIds?.() ?? undefined;
    const isLive = live ? live.includes(thread.id) : thread.status === "running";
    if (isLive) {
      return { delivery: thread.agentState === "working" ? "live" : "queued" };
    }

    if (deps.canRestart ? deps.canRestart(thread.id) : true) {
      return { delivery: "restarted" };
    }

    return {
      delivery: "refused",
      refusal:
        `"${thread.title}" (\`${thread.id}\`) cannot receive a message: its agent process has ended and there is nothing to restart it from. ` +
        "Read its transcript with read_session, or open a new section with create_session.",
    };
  }

  function withinRateLimit(senderKey: string, limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS): boolean {
    const now = Date.now();
    const recent = (recentBySender.get(senderKey) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) {
      recentBySender.set(senderKey, recent);
      return false;
    }
    recent.push(now);
    recentBySender.set(senderKey, recent);
    return true;
  }

  async function deliver(request: PeerMessageRequest): Promise<PeerMessageResponse> {
    const text = typeof request.text === "string" ? request.text.trim() : "";
    const target = typeof request.to === "string" ? request.to.trim() : "";
    const cwd = typeof request.cwd === "string" ? request.cwd : "";

    if (!target) return { ok: false, message: "send_message needs a target section (`to`). Call list_sessions first." };
    if (!text) return { ok: false, message: "send_message needs a non-empty `message`." };
    if (text.length > PEER_MESSAGE_CAP) {
      return { ok: false, message: `That message is ${text.length} characters; keep it under ${PEER_MESSAGE_CAP}.` };
    }
    if (!cwd) return { ok: false, message: "The workspace of the sending section is unknown, so no target can be resolved." };

    const threads = deps.readThreads().filter((thread) => !thread.draft && sameWorkspace(thread.cwd, cwd));
    // "parent" is a name a sub-thread can use without first calling
    // list_sessions to look up an id it was never told. It is the one target
    // every sub-thread has and the one it is asked to report to, so making it
    // cost a tool call was the difference between reporting back and not.
    const parentOfSender = threads.find((thread) => thread.id === request.from)?.parentId;
    const match =
      target.toLowerCase() === "parent"
        ? threads.find((thread) => thread.id === parentOfSender)
        : matchThread(threads, target);

    if (target.toLowerCase() === "parent" && !parentOfSender) {
      return { ok: false, message: "This section is not a sub-thread, so it has no parent to message." };
    }
    if (!match) {
      return { ok: false, message: `No section matching "${target}" is open in ${cwd}. Call list_sessions first.` };
    }
    if (request.from && match.id === request.from) {
      return { ok: false, message: "That is this section. A section cannot send itself a message." };
    }

    const sender = threads.find((thread) => thread.id === request.from);
    // A shell caller with no section env still gets rate-limited, as one bucket.
    if (!withinRateLimit(request.from ?? "anonymous")) {
      return {
        ok: false,
        message: `Rate limit: at most ${RATE_LIMIT} peer messages a minute. Wait, or do the work yourself instead of delegating again.`,
      };
    }

    // Checked before the write, so an undeliverable target is an error the
    // caller can act on rather than a success it will wait on forever.
    const { delivery, refusal } = deliverability(match);
    if (delivery === "refused") {
      deps.log("peer-message-undeliverable", { from: request.from, to: match.id, title: match.title });
      return { ok: false, message: refusal ?? `"${match.title}" (\`${match.id}\`) cannot receive a message.` };
    }

    // How the sender sits relative to the RECEIVER, which is the direction the
    // receiver's prompt header describes.
    const relation = sender?.parentId === match.id ? "subthread" : match.parentId === sender?.id ? "parent" : "peer";
    const body = formatPeerMessage(
      { id: request.from ?? "unknown", title: sender?.title ?? "an unnamed section" },
      text,
      relation,
    );
    const sent = await deps.sendInput({ id: match.id, data: body });
    deps.log("peer-message", {
      from: request.from,
      to: match.id,
      title: match.title,
      bytes: text.length,
      delivery,
      ok: sent.ok,
      message: sent.message,
    });

    if (!sent.ok) {
      return { ok: false, message: sent.message ?? `Could not deliver the message to "${match.title}".` };
    }

    // Journalled so the next `read_session` of the target can say whether the
    // message has actually been read, rather than only that it was accepted.
    journal({
      at: new Date(now()).toISOString(),
      to: match.id,
      fromTitle: sender?.title,
      preview: trimExcerpt(text, 200),
    });

    return {
      ok: true,
      message: `${describeDelivery(delivery, match)} Call read_session on it later to see whether it has been read.`,
    };
  }

  /**
   * Watch the sections a section opened, and interrupt it only when one is
   * BLOCKED on input — a child waiting for an answer nobody is looking at hangs
   * forever, so that one notice is worth the interruption.
   *
   * Completion is deliberately silent. Announcing it injected a prompt into the
   * parent every time a child settled, which is noise for a parent that has
   * moved on; `list_sessions` and `wait_for_session` are there for the parent
   * that actually wants to know. Notices only ever go to a spawner that is
   * alive.
   */
  async function pollWatches(): Promise<void> {
    const threads = deps.readThreads();
    // Sub-threads are watched from the RECORD, not only from the in-memory map:
    // the link survives an app restart and the map does not, and a parent that
    // restarts mid-delegation is exactly the case where being told its child
    // finished matters most. `settledSubthreads` keeps the notice one-shot.
    for (const thread of threads) {
      if (!thread.parentId || thread.draft) continue;
      if (watches.has(thread.id) || settledSubthreads.has(thread.id)) continue;
      // A sub-thread that had already finished before this process started is
      // recorded as settled WITHOUT a notice. Otherwise the first poll after a
      // relaunch tells every live parent about work that ended days ago — a
      // burst of stale interruptions that reads, from inside the parent, as if
      // the children had just completed.
      const transcript = deps.readTranscript?.(thread) ?? EMPTY_TRANSCRIPT;
      if (isSettled(peerStatus(thread, transcript, now()), transcript)) {
        settledSubthreads.add(thread.id);
        continue;
      }
      watches.set(thread.id, {
        parentId: thread.parentId,
        childTitle: thread.title,
        // When the WATCH began, not when the section did. `WATCH_TIMEOUT_MS`
        // bounds how long this process keeps looking; dating the watch from
        // `createdAt` would retire every sub-thread older than an hour on the
        // first poll after a relaunch — exactly the long-running ones whose
        // completion the parent is still waiting for.
        startedAt: now(),
        subthread: true,
      });
    }

    if (watches.size === 0) {
      return;
    }

    const at = now();

    for (const [childId, watch] of [...watches]) {
      if (at - watch.startedAt > WATCH_TIMEOUT_MS) {
        watches.delete(childId);
        // Also remembered as settled, or the record-driven seeding would put a
        // long-abandoned sub-thread straight back on the watch list.
        settledSubthreads.add(childId);
        continue;
      }

      const thread = threads.find((candidate) => candidate.id === childId);
      if (!thread) {
        continue;
      }

      const transcript = deps.readTranscript?.(thread) ?? EMPTY_TRANSCRIPT;
      const status = peerStatus(thread, transcript, at);
      if (isWaitingForInput(status)) {
        const parent = threads.find((candidate) => candidate.id === watch.parentId);
        const parentLive = deps.liveSessionIds?.().includes(watch.parentId) ?? parent?.status === "running";
        deps.log("peer-section-needs-input", { child: childId, parent: watch.parentId, state: status.state, notified: parentLive });
        if (!inputNotifiedChildren.has(childId) && parent && parentLive) {
          inputNotifiedChildren.add(childId);
          const notice = formatPeerNeedsInput(
            { id: childId, title: thread.title || watch.childTitle },
            status,
            { subthread: watch.subthread || thread.parentId === watch.parentId },
          );
          const sent = await deps.sendInput({ id: watch.parentId, data: notice });
          if (!sent.ok) {
            deps.log("peer-input-notice-undelivered", { child: childId, parent: watch.parentId, message: sent.message });
          }
        }
        continue;
      }
      inputNotifiedChildren.delete(childId);
      // `isSettled` requires the last word to be the agent's, which is also what
      // keeps the gap between "created" and "read its first prompt" — during
      // which a section looks idle — from being mistaken for completion.
      if (!isSettled(status, transcript)) {
        continue;
      }

      // Completion is NOT announced: a settled child is dropped from the watch
      // list and logged, nothing more. The parent learns about it by calling
      // `list_sessions` / `wait_for_session` when it cares. Only the
      // needs-input notice above still interrupts, because a blocked child
      // hangs silently otherwise.
      watches.delete(childId);
      settledSubthreads.add(childId);
      deps.log("peer-section-settled", { child: childId, parent: watch.parentId, state: status.state, notified: false });
    }
  }

  /**
   * Open a section and hand it its first prompt.
   *
   * The launch settings default to the creator's own: a section spawned by a
   * Codex section running with workspace-write should look like the thing that
   * spawned it, and inheriting is also the only way to get a sane
   * `permissionMode` without letting a caller escalate it. An explicit mode is
   * useful when an agent carries its launch settings across a boundary, while
   * the rank check keeps the wire format from becoming an escalation path.
   */
  async function create(request: PeerSectionRequest): Promise<PeerMessageResponse> {
    const task = typeof request.task === "string" ? request.task.trim() : "";
    const cwd = typeof request.cwd === "string" ? request.cwd : "";

    if (!deps.createSection) {
      return { ok: false, message: "This build cannot open new sections." };
    }
    if (!task) {
      return { ok: false, message: "create_session needs a `task`: the opening prompt for the new section." };
    }
    if (task.length > PEER_TASK_CAP) {
      return { ok: false, message: `That task is ${task.length} characters; keep it under ${PEER_TASK_CAP}.` };
    }
    if (!cwd) {
      return { ok: false, message: "The workspace of the creating section is unknown, so no section can be opened." };
    }

    const threads = deps.readThreads().filter((thread) => !thread.draft && sameWorkspace(thread.cwd, cwd));
    const creator = threads.find((thread) => thread.id === request.from);
    if (!withinRateLimit(`create:${request.from ?? "anonymous"}`, CREATE_LIMIT, CREATE_WINDOW_MS)) {
      return {
        ok: false,
        message: `Rate limit: at most ${CREATE_LIMIT} new sections every ${CREATE_WINDOW_MS / 60_000} minutes. Do this piece of work yourself instead of opening another section.`,
      };
    }

    const title = typeof request.title === "string" ? compactSectionTitle(request.title) : "";
    const runtime = normalizeRuntime(request.runtime) ?? creator?.runtime ?? "claude";
    const requestedPermission = request.permissionMode?.trim();
    const inheritedPermission = runtime === (creator?.runtime ?? "claude") ? creator?.permissionMode?.trim() : undefined;
    const permissionMode = requestedPermission || inheritedPermission;
    if (requestedPermission && permissionRank(runtime, requestedPermission) < 0) {
      return { ok: false, message: `Unknown permission mode for ${runtime}: ${requestedPermission}.` };
    }
    if (requestedPermission && creator && runtime !== creator.runtime) {
      return { ok: false, message: "A permission mode cannot be carried across runtimes; choose the target runtime's mode explicitly." };
    }
    if (requestedPermission && creator && runtime === creator.runtime) {
      if (permissionRank(runtime, requestedPermission) > permissionRank(runtime, creator.permissionMode)) {
        return { ok: false, message: "A new section cannot use a more permissive mode than its creator." };
      }
    }
    // Nesting is the default, and it degrades to a sibling rather than failing:
    // a caller with no section of its own (a shell), or one already at the depth
    // cap, still gets its section — it just gets it alongside. Refusing outright
    // would turn a presentation choice into a work stoppage.
    const wantsSubthread = request.mode?.trim().toLowerCase() !== "sibling";
    const roomToNest = creator ? subthreadDepth(threads, creator.id) + 1 < MAX_SUBTHREAD_DEPTH : false;
    const parentId = wantsSubthread && creator && roomToNest ? creator.id : undefined;
    const started = await deps.createSection({
      cwd,
      title: title || undefined,
      runtime,
      parentId,
      // A model is only inherited when the runtime is: Codex model names mean
      // nothing to Claude and vice versa.
      model: request.model?.trim() || (runtime === (creator?.runtime ?? "claude") ? creator?.model : undefined),
      effort: request.effort?.trim() || (runtime === (creator?.runtime ?? "claude") ? creator?.effort : undefined),
      permissionMode,
    });

    deps.log("peer-section-create", {
      from: request.from,
      id: started.id,
      runtime,
      bytes: task.length,
      subthread: Boolean(parentId),
      ok: started.ok,
      message: started.message,
    });

    if (!started.ok || !started.id) {
      return { ok: false, message: started.message ?? "Could not open a new section." };
    }

    const body = formatPeerTask(
      { id: request.from ?? "unknown", title: creator?.title ?? "an unnamed section" },
      task,
      { subthread: Boolean(parentId) },
    );
    const sent = await deps.sendInput({ id: started.id, data: body });
    if (!sent.ok) {
      // The section exists but has nothing in it; say so rather than reporting a
      // success the operator would find empty.
      return { ok: false, message: `The section opened but its first prompt was refused: ${sent.message ?? "unknown error"}.` };
    }

    // Watched from here on, so its spawner is told if it BLOCKS on input.
    // Completion is not announced; the watch is simply retired.
    if (request.from) {
      watches.set(started.id, {
        parentId: request.from,
        childTitle: title || "Untitled",
        startedAt: now(),
        subthread: Boolean(parentId),
      });
    }

    // Say which of the two things happened, and why, when it is not what was
    // asked for: a caller told "opened a sub-thread" that then cannot find it
    // nested has been misled about the only part of this it can see.
    //
    // The anonymous case gets its own sentence rather than being folded into
    // "you asked for a sibling". A caller the app cannot identify loses BOTH
    // halves of the inheritance — the nesting and the permission mode — and the
    // second one is invisible until the new section stops for approval on its
    // first command. Saying so here is the difference between a puzzling
    // product and a fixable command line.
    const placement = parentId
      ? `as a SUB-THREAD of this section — the user sees it nested under yours, and you are answerable for its result`
      : !creator
        ? "alongside this one, NOT nested under you, and inheriting nothing — no runtime, model, effort or permission mode, so it will " +
          "stop and ask the user to approve its commands even if you are running unattended. The app could not tell which section made " +
          "this call: pass `--self <your section id>` (or set `PANDA_CODE_SECTION_ID`) and it will nest and inherit properly"
        : wantsSubthread
          ? `alongside this one (sub-threads only nest ${MAX_SUBTHREAD_DEPTH} levels and this section is already at the limit)`
          : "alongside this one, as an independent sibling the user steers directly";

    return {
      ok: true,
      id: started.id,
      message:
        `Opened section "${title || "Untitled"}" (\`${started.id}\`) in ${cwd} on ${runtime} ${placement}, and gave it the task. ` +
        "You will NOT be told when it finishes — only if it becomes blocked waiting for input. " +
        "Use `wait_for_session` to block on it, or `read_session` to look in on it — do not poll on a timer.",
    };
  }

  function setOwnTitle(request: PeerTitleRequest): PeerMessageResponse {
    const id = request.from?.trim();
    const cwd = request.cwd?.trim();
    const title = typeof request.title === "string" ? compactSectionTitle(request.title) : "";
    if (!id) return { ok: false, message: "A section id is required. Pass --self on this command." };
    if (!cwd) return { ok: false, message: "The workspace of this section is unknown." };
    if (!title) return { ok: false, message: "Choose a non-empty section title." };

    const thread = deps.readThreads().find((candidate) => candidate.id === id && sameWorkspace(candidate.cwd, cwd));
    if (!thread) return { ok: false, message: "This section is not open in the current workspace." };
    if (thread.titleSource === "manual") {
      return { ok: true, message: `Kept the user-defined title "${thread.title}".` };
    }
    if (!deps.setTitle) return { ok: false, message: "Automatic section titles are unavailable in this build." };

    deps.setTitle(id, title);
    deps.log("peer-section-title", { id, title });
    return { ok: true, message: `Section title set to "${title}".` };
  }

  return { deliver, create, setOwnTitle, pollWatches, watchedSectionIds: () => [...watches.keys()] };
}

export type PeerMessageServer = { close: () => void };

/**
 * Serve `deliver` over a newline-delimited JSON unix socket. One request per
 * connection: the helper is a short-lived process, and a connection per message
 * means no reconnect logic on either side.
 */
export function startPeerMessageServer(deps: Dependencies): PeerMessageServer {
  const { deliver, create, setOwnTitle, pollWatches } = createPeerMessageDeliverer(deps);

  // Only sections that were opened by another section are watched, so this is
  // idle — and free — in the ordinary case of a workspace nobody is delegating in.
  const watchTimer = setInterval(() => {
    void pollWatches().catch((error: unknown) => deps.log("peer-watch-failed", { error: String(error) }));
  }, WATCH_POLL_MS);
  watchTimer.unref?.();

  const handle = (socket: Socket): void => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        // A request that never terminates would hold the socket open forever.
        if (buffer.length > PEER_TASK_CAP * 3) socket.destroy();
        return;
      }

      const line = buffer.slice(0, newline);
      buffer = "";
      const reply = (response: PeerMessageResponse): void => {
        socket.end(`${JSON.stringify(response)}\n`);
      };

      let request: PeerMessageRequest | PeerSectionRequest | PeerTitleRequest | BrowserRequest | PeerAttentionRequest;
      try {
        request = JSON.parse(line) as PeerMessageRequest | PeerSectionRequest | PeerTitleRequest | BrowserRequest | PeerAttentionRequest;
      } catch {
        reply({ ok: false, message: "Malformed request." });
        return;
      }

      const handler =
        request.op === "send"
          ? deliver(request as PeerMessageRequest)
          : request.op === "create"
            ? create(request as PeerSectionRequest)
            : request.op === "title"
              ? Promise.resolve(setOwnTitle(request as PeerTitleRequest))
            : request.op === "browser"
              ? (deps.browser?.(request as BrowserRequest) ??
                Promise.resolve({
                  ok: false,
                  message: "The browser is unavailable: this build of the app has no window to host it.",
                }))
              : request.op === "attention"
                ? (deps.attention?.(request as PeerAttentionRequest) ??
                  Promise.resolve({ ok: false, message: "Attention requests are unavailable in this build." }))
              : undefined;
      if (!handler) {
        reply({ ok: false, message: `Unknown operation: ${String(request.op)}` });
        return;
      }

      handler.then(reply).catch((error: unknown) => reply({ ok: false, message: `Delivery failed: ${String(error)}` }));
    });
    socket.on("error", () => socket.destroy());
  };

  // A crash leaves the socket file behind and EADDRINUSE would follow; the path
  // is ours alone, so removing it is safe.
  try {
    unlinkSync(deps.socketPath);
  } catch {
    // Nothing there, which is the normal case.
  }

  let server: Server;
  try {
    server = createServer(handle);
    server.listen(deps.socketPath);
    server.on("error", (error) => deps.log("peer-message-server-error", { error: String(error) }));
  } catch (error) {
    deps.log("peer-message-server-failed", { path: deps.socketPath, error: String(error) });
    clearInterval(watchTimer);
    return { close: () => {} };
  }

  return {
    close: () => {
      clearInterval(watchTimer);
      server.close();
      try {
        unlinkSync(deps.socketPath);
      } catch {
        // Already gone.
      }
    },
  };
}
