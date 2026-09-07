import { stripDeveloperInstructions } from "./agent-prompts";
import type { AgentRuntime, PersistedThread } from "./ipc";

/**
 * "What else is running in this workspace?"
 *
 * A workspace routinely holds several sections at once — one refactoring, one
 * reviewing, one chasing a test — and none of them can see the others. Git shows
 * the merged result of their edits with no attribution, and each agent's own
 * transcript ends at its own turn. So an agent asked to "finish what the other
 * one started" has no way to find out what that was.
 *
 * This module answers that from the two things already on disk: the section list
 * (`threads.json`, which the renderer keeps current) and each section's
 * transcript. It is deliberately pure — no `fs`, no `electron` — because it runs
 * both inside the main process and inside the out-of-process helper that serves
 * the agent-facing tools (`main/peers-entry.ts`). Callers supply the bytes.
 *
 * One rule shapes the whole file: every tool answers from the SAME parsed
 * transcript object. A caller once concluded a section had died because
 * `list_sessions` and `read_session` each did their own reading and disagreed;
 * it spawned two replacements for a section that was working fine. So the
 * transcript is loaded once, into `PeerTranscript`, and the list, the detail
 * view and the status verdict are all projections of that one value.
 */

/**
 * What a caller actually needs to know, and the reason the old four-way
 * `working | waiting | idle | exited` was not enough: it could not separate
 * "still thinking" from "dead", and it called a dead section "finished" whether
 * it had produced anything or not.
 *
 * - `running`  — a turn is in progress; output is not final.
 * - `idle`     — alive, waiting for a prompt (or for an approval).
 * - `finished` — terminal AND its transcript is readable here.
 * - `failed`   — terminal, and it will produce nothing further; `reason` says why.
 */
export type PeerState = "running" | "idle" | "finished" | "failed";

export type PeerStatus = {
  state: PeerState;
  /** Present whenever the state alone would leave the caller guessing. */
  reason?: string;
};

/**
 * The last thing a section reached for, and whether it has come back yet.
 *
 * `running` alone does not tell a caller what it needs before starting an
 * expensive command: a section thinking about a diff and a section eight minutes
 * into `pnpm typecheck` are both `running`, and only one of them is a reason to
 * wait. `pending` is the discriminator — a tool call with no result written yet
 * is a call still in flight.
 */
export type PeerActivity = {
  /** `command` when the section shelled out; `tool` for everything else. */
  kind: "command" | "tool";
  /** The command line, or the tool's name and its most identifying argument. */
  detail: string;
  /** No result recorded for this call yet, so it is still going. */
  pending: boolean;
  at?: string;
};

/** One turn of a peer's conversation, flattened to text. */
export type PeerTurn = {
  role: "user" | "agent";
  text: string;
  at?: string;
};

/** Why no transcript could be parsed for a section. */
export type PeerTranscriptMiss =
  /** The runtime never reported a session/thread id, so there is nothing to open. */
  | "not-linked"
  /** The id is known but no file exists at the path it implies. */
  | "not-found"
  /** The file exists and could not be read or held no turns at all. */
  | "unreadable";

/**
 * A section's transcript as read from disk, once.
 *
 * `turns` is everything the read window contained — not a tail slice. Slicing is
 * the renderer's job, so that "what the list summarised" and "what the reader
 * can page through" are the same set by construction.
 */
export type PeerTranscript = {
  found: boolean;
  turns: PeerTurn[];
  /** False when only the tail of a very large file was read. */
  complete: boolean;
  /** Bytes of transcript before the read window; > 0 implies `complete: false`. */
  omittedBytes: number;
  /** Epoch ms of the file's last write; the liveness signal `peerStatus` trusts. */
  modifiedAt?: number;
  path?: string;
  miss?: PeerTranscriptMiss;
  /** The last tool call in the read window, and whether it has returned. */
  activity?: PeerActivity;
};

export const EMPTY_TRANSCRIPT: PeerTranscript = { found: false, turns: [], complete: false, omittedBytes: 0 };

export function missingTranscript(miss: PeerTranscriptMiss, path?: string): PeerTranscript {
  return { ...EMPTY_TRANSCRIPT, miss, path };
}

export type PeerSession = {
  id: string;
  title: string;
  runtime: AgentRuntime;
  cwd: string;
  state: PeerState;
  stateReason?: string;
  /** True for the section whose agent is asking; it sees itself in the list. */
  isSelf: boolean;
  createdAt: string;
  lastActiveAt: string;
  lastPromptAt?: string;
  /** Most recent operator prompt, trimmed for display. */
  lastPrompt?: string;
  /** Most recent agent reply, trimmed for display. */
  lastReply?: string;
  /** Turns available through `read_session`; the list promises what the reader can deliver. */
  turnCount: number;
  transcriptAt?: number;
  /** The last tool call it made; `pending` means it has not come back. */
  activity?: PeerActivity;
  /** Set when this section is a sub-thread; the section it hangs off. */
  parentId?: string;
  /** Its parent's name, resolved for display so the reader needn't cross-reference. */
  parentTitle?: string;
  /** Ids of the sub-threads directly under it. */
  childIds?: string[];
  /**
   * The user starred this section in the sidebar.
   *
   * The only signal on the board that comes from the operator rather than from
   * the runtime, which is exactly why it is worth carrying: sections are
   * otherwise indistinguishable to an agent reading the list, and the ones a
   * user bothered to star are the standing ones — the section that owns a
   * long-running investigation, or the one holding a device and a logged-in app
   * that can answer a question no other section can. Surfacing it is what makes
   * "ask the section that can actually see it" a move an agent can make on its
   * own instead of a thing only the user knows to arrange.
   */
  starred?: boolean;
};

/** Keeps a single peer's excerpt from crowding out the rest of the list. */
const EXCERPT_CAP = 400;

/** Turns per page of `read_session`, when the caller names no other number. */
export const DEFAULT_PAGE_TURNS = 12;

/** Per-turn cap in a page. Exceeding it is always announced, never silent. */
export const TURN_PREVIEW_CAP = 2000;

/** Characters of a single turn returned per `part` when reading one in full. */
export const TURN_PART_CHARS = 12_000;

/** Guards against a workspace with a runaway number of sections. */
const MAX_PEERS = 40;

/**
 * How recently a transcript must have been written for its section to count as
 * alive regardless of what `threads.json` says.
 *
 * `threads.json` is a renderer snapshot: it goes stale when the window reloads,
 * when a reconcile pass runs mid-turn, or when a section is started by something
 * other than the UI. A file being appended to right now is ground truth, and it
 * outranks the snapshot — that is what stops a working section being reported
 * "finished" seventy seconds in.
 */
export const TRANSCRIPT_ACTIVE_MS = 45_000;

/**
 * How long a section may look terminal-with-no-session-id before that verdict is
 * believed.
 *
 * A section that is still booting and one that died on the launch pad present
 * identically: no `claudeSessionId`, so no transcript to read, and a renderer
 * snapshot that has not yet been flipped to `working`. The watch poll runs every
 * four seconds, so on a loaded machine — where spawning a runtime means paging it
 * in off swap — it lands squarely inside that window and reports a healthy
 * sub-thread as failed while its process is very much alive. Age is the only
 * thing that separates the two cases, and a spurious failure notice costs a
 * parent's whole turn while a late one costs a minute.
 */
export const PEER_BOOT_GRACE_MS = 90_000;

function normalizeWorkspace(path: string): string {
  return path.replace(/\/+$/, "");
}

export function sameWorkspace(first: string, second: string): boolean {
  return normalizeWorkspace(first) === normalizeWorkspace(second);
}

/**
 * How deep the sub-thread tree may go: a top-level section, its sub-threads,
 * and theirs.
 *
 * Not a storage limit — the tree is three ids in a JSON file — but a legibility
 * one. Past three levels the sidebar has no width left to indent into, and, more
 * to the point, an agent that can nest without limit will: each level costs a
 * whole agent process, and the level that opened it is not the one paying
 * attention to whether it was needed. Delegation depth is where a runaway shows
 * up, so it is capped here rather than left to the rate limiter to catch after
 * the fact.
 */
export const MAX_SUBTHREAD_DEPTH = 3;

type ThreadNode = { id: string; parentId?: string };

/**
 * The chain from a section up to its top-level ancestor, nearest parent first.
 *
 * Tolerates a broken tree instead of trusting one: a `parentId` pointing at a
 * deleted section simply ends the walk, and a cycle (which nothing should be
 * able to create, but which a hand-edited `threads.json` can) is cut by the
 * visited set rather than hanging the renderer that called this while painting.
 */
export function ancestorIds(threads: readonly ThreadNode[], id: string): string[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let current = byId.get(id)?.parentId;
  // A parent that is not in the list is not an ancestor: the section is a root
  // as far as anything reading this is concerned, which is exactly how the
  // sidebar and the phone draw it. Counting a deleted parent as a level would
  // make a top-level section fail the depth check for no visible reason.
  while (current && byId.has(current) && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = byId.get(current)?.parentId;
  }
  return chain;
}

/** Depth in the tree: 0 for a top-level section, 1 for its sub-threads, … */
export function subthreadDepth(threads: readonly ThreadNode[], id: string): number {
  return ancestorIds(threads, id).length;
}

/**
 * The sections that render at the TOP of a list, in the order given.
 *
 * A section is top-level when it has no parent, when its parent is not in this
 * list (deleted, filtered out, or in another workspace — the child is still a
 * running agent process and has to be reachable), or when its parent chain
 * loops. That last case is the one worth spelling out: with a cycle, every
 * section in it has a present parent, so a plain "no parent" test makes all of
 * them roots of nothing and they disappear from the sidebar completely. Nothing
 * in the app can write a cycle, but a hand-edited `threads.json` can, and
 * "sessions vanished" is not the failure this should have.
 */
export function topLevelThreads<T extends ThreadNode>(threads: readonly T[]): T[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return threads.filter((thread) => {
    const parent = thread.parentId;
    if (!parent || !byId.has(parent)) {
      return true;
    }
    const seen = new Set<string>([thread.id]);
    let current: string | undefined = parent;
    while (current && byId.has(current)) {
      if (seen.has(current)) {
        return true; // The walk came back around: treat it as its own root.
      }
      seen.add(current);
      current = byId.get(current)?.parentId;
    }
    return false;
  });
}

/** The sections directly under `parentId`, in the order given. */
export function childrenOf<T extends ThreadNode>(threads: readonly T[], parentId: string): T[] {
  return threads.filter((thread) => thread.parentId === parentId);
}

/** Everything under `id`, at any depth — what a "close the whole branch" action acts on. */
export function descendantIds(threads: readonly ThreadNode[], id: string): string[] {
  const found: string[] = [];
  const queue = [id];
  const seen = new Set<string>([id]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of threads) {
      if (child.parentId !== current || seen.has(child.id)) continue;
      seen.add(child.id);
      found.push(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

export type AdoptionCheck = { ok: true } | { ok: false; reason: string };

/**
 * May `childId` be re-parented under `parentId`?
 *
 * The single gate every path goes through — the agent's `create_session`, the
 * sidebar's "make this a sub-thread of…", the phone's. It exists so the three
 * invariants the readers rely on (no self-parent, no cycle, no fourth level) are
 * checked in ONE place: a walker that trusts the tree is only safe if nothing
 * can write a bad one, and three separate near-copies of this check is exactly
 * how one of them ends up missing the cycle case.
 */
export function canAdopt(threads: readonly ThreadNode[], parentId: string, childId: string): AdoptionCheck {
  if (parentId === childId) {
    return { ok: false, reason: "A section cannot be its own sub-thread." };
  }
  if (!threads.some((thread) => thread.id === parentId)) {
    return { ok: false, reason: "That parent section no longer exists." };
  }
  // Adopting your own ancestor would close the loop and orphan the branch.
  if (ancestorIds(threads, parentId).includes(childId) || descendantIds(threads, childId).includes(parentId)) {
    return { ok: false, reason: "That section is already inside this one's sub-threads." };
  }
  const depth = subthreadDepth(threads, parentId) + 1;
  const branch = descendantIds(threads, childId).reduce(
    (deepest, descendant) => Math.max(deepest, subthreadDepth(threads, descendant) - subthreadDepth(threads, childId)),
    0,
  );
  if (depth + branch >= MAX_SUBTHREAD_DEPTH) {
    return {
      ok: false,
      reason: `Sub-threads only nest ${MAX_SUBTHREAD_DEPTH} levels deep. Open this one alongside instead of underneath.`,
    };
  }
  return { ok: true };
}

function isTerminal(thread: PersistedThread): boolean {
  return thread.status === "exited" || thread.status === "error" || thread.agentState === "exited";
}

/**
 * The state of a section, decided from the snapshot AND the transcript.
 *
 * Order matters. A live file beats a stale snapshot, so the "still writing"
 * check comes before any terminal verdict — a terminal state is never reported
 * while output is still arriving. And terminal-with-no-readable-output is
 * `failed`, not `finished`: a caller told "finished" will go and read the
 * output, and there has to be some for that to mean anything.
 */
export function peerStatus(thread: PersistedThread, transcript: PeerTranscript, now: number = Date.now()): PeerStatus {
  const writingNow = transcript.modifiedAt !== undefined && now - transcript.modifiedAt < TRANSCRIPT_ACTIVE_MS;

  if (writingNow && thread.status !== "error") {
    return isTerminal(thread)
      ? { state: "running", reason: "still writing output; its recorded state is stale" }
      : { state: "running" };
  }

  if (thread.status === "error") {
    return { state: "failed", reason: "the section's agent process reported an error" };
  }

  if (isTerminal(thread)) {
    if (transcript.turns.some((turn) => turn.role === "agent")) {
      return { state: "finished" };
    }

    switch (transcript.miss) {
      case "not-linked": {
        // Too young to call. See `PEER_BOOT_GRACE_MS`: a booting section and a
        // stillborn one look the same, and the poll is fast enough to catch a
        // healthy one mid-launch.
        const createdAt = Date.parse(thread.createdAt);
        if (Number.isFinite(createdAt) && now - createdAt < PEER_BOOT_GRACE_MS) {
          return { state: "running", reason: "still starting up; its runtime has not reported a session id yet" };
        }
        return {
          state: "failed",
          reason: "it ended before its runtime reported a session id, so no transcript exists to read",
        };
      }
      case "not-found":
        return { state: "failed", reason: "its transcript file is not on disk, so nothing it did can be read here" };
      default:
        return { state: "failed", reason: "it ended without writing a single agent turn" };
    }
  }

  if (thread.agentState === "working") {
    return { state: "running" };
  }
  if (thread.agentState === "needs_action") {
    return { state: "idle", reason: "waiting on an approval or a question" };
  }

  return { state: "idle" };
}

/**
 * A section that has answered and gone quiet.
 *
 * Not the same question as "is it terminal". A Codex section never exits on its
 * own — one app-server serves its thread indefinitely — so a caller waiting for
 * a Codex peer to finish a task would wait forever on process state alone. The
 * transcript answers it for every runtime: the last thing said is the agent's.
 */
export function hasAnswered(transcript: PeerTranscript): boolean {
  return transcript.turns[transcript.turns.length - 1]?.role === "agent";
}

export function isWaitingForInput(status: PeerStatus): boolean {
  return status.state === "idle" && status.reason !== undefined;
}

/**
 * "Is there any point waiting longer?" — the condition `wait_for_session` and
 * the completion notice both settle on.
 */
export function isSettled(status: PeerStatus, transcript: PeerTranscript): boolean {
  if (status.state === "finished" || status.state === "failed") {
    return true;
  }
  return status.state === "idle" && !isWaitingForInput(status) && hasAnswered(transcript);
}

function stateRank(state: PeerState): number {
  switch (state) {
    case "running":
      return 0;
    case "idle":
      return 1;
    case "finished":
      return 2;
    default:
      return 3;
  }
}

function activityTime(thread: PersistedThread): number {
  const stamp = thread.lastPromptAt ?? thread.lastActiveAt ?? thread.createdAt;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The sections sharing `cwd`, most recently active first.
 *
 * Unlike the sidebar — which sorts by `lastPromptAt` so replay cannot float old
 * sections to the top — this list answers "what is happening right now", so
 * `lastActiveAt` is a legitimate tiebreaker. Ordering by live-ness happens after
 * the transcripts are read, in `sortPeers`, since state is not knowable here.
 */
export function selectWorkspacePeers(
  threads: readonly PersistedThread[],
  options: { cwd: string; selfId?: string; includeSelf?: boolean },
): PersistedThread[] {
  return threads
    .filter((thread) => !thread.draft && sameWorkspace(thread.cwd, options.cwd))
    .filter((thread) => options.includeSelf !== false || thread.id !== options.selfId)
    .sort((first, second) => activityTime(second) - activityTime(first))
    .slice(0, MAX_PEERS);
}

/** Live sections first, each band by recency. */
export function sortPeers(peers: readonly PeerSession[]): PeerSession[] {
  return [...peers].sort((first, second) => {
    const byState = stateRank(first.state) - stateRank(second.state);
    if (byState !== 0) return byState;
    const firstAt = Date.parse(first.lastPromptAt ?? first.lastActiveAt ?? first.createdAt);
    const secondAt = Date.parse(second.lastPromptAt ?? second.lastActiveAt ?? second.createdAt);
    return (Number.isNaN(secondAt) ? 0 : secondAt) - (Number.isNaN(firstAt) ? 0 : firstAt);
  });
}

/** Shortest id fragment that may stand in for a whole uuid. */
const MIN_ID_PREFIX = 6;

/**
 * Resolve "which section did you mean" the same way everywhere.
 *
 * Ids are uuids and agents quote the first block of one; a lookup that only
 * accepted the whole thing answered "no section matching 2b16a124 is open",
 * which reads exactly like the section being gone.
 */
export function matchThread<T extends { id: string; title: string }>(threads: readonly T[], idOrTitle: string): T | undefined {
  const needle = idOrTitle.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }

  const byPrefix = threads.filter((thread) => needle.length >= MIN_ID_PREFIX && thread.id.toLowerCase().startsWith(needle));
  return (
    threads.find((thread) => thread.id.toLowerCase() === needle) ??
    threads.find((thread) => thread.title.toLowerCase() === needle) ??
    // Ambiguous prefixes are left to the title matchers rather than guessed at.
    (byPrefix.length === 1 ? byPrefix[0] : undefined) ??
    threads.find((thread) => thread.title.toLowerCase().includes(needle))
  );
}

export function trimExcerpt(text: string, cap = EXCERPT_CAP): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > cap ? `${collapsed.slice(0, cap - 1)}…` : collapsed;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      ["text", "input_text", "output_text"].includes((block as { type?: string }).type ?? "")
    ) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }

  return parts.join("\n");
}

/**
 * Claude Code injects turns of its own — skill bodies, system reminders, slash
 * command wrappers — as `user` entries flagged `isMeta`. They are not prompts,
 * and showing them as such would misreport what the operator asked for.
 */
type ClaudeTranscriptLine = {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: { role?: string; content?: unknown };
};

export function parseClaudeTurns(transcript: string, limit?: number): PeerTurn[] {
  const turns: PeerTurn[] = [];

  for (const line of transcript.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let entry: ClaudeTranscriptLine;
    try {
      entry = JSON.parse(line) as ClaudeTranscriptLine;
    } catch {
      // A tail read can start mid-line, and a live transcript can be half-written.
      continue;
    }

    if (entry.type !== "user" && entry.type !== "assistant") {
      continue;
    }

    const text = textFromContent(entry.message?.content);
    if (!text.trim() || (entry.type === "user" && entry.isMeta)) {
      continue;
    }

    turns.push({ role: entry.type === "user" ? "user" : "agent", text: text.trim(), at: entry.timestamp });
  }

  return limit === undefined ? turns : turns.slice(-limit);
}

type CodexTranscriptLine = {
  timestamp?: string;
  payload?: { type?: string; role?: string; content?: unknown; message?: unknown };
};

export function parseCodexTurns(transcript: string, limit?: number): PeerTurn[] {
  const turns: PeerTurn[] = [];

  for (const line of transcript.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let entry: CodexTranscriptLine;
    try {
      entry = JSON.parse(line) as CodexTranscriptLine;
    } catch {
      continue;
    }

    const payload = entry.payload;
    if (!payload) {
      continue;
    }

    if (payload.type === "message" && payload.role !== "user" && payload.role !== "assistant") {
      continue;
    }
    const role =
      payload.type === "user_message" ? "user" : payload.type === "agent_message" ? "agent" : payload.role === "user" ? "user" : "agent";
    if (payload.type !== "message" && payload.type !== "user_message" && payload.type !== "agent_message") {
      continue;
    }

    const rawText = textFromContent(payload.content ?? payload.message);
    const text = role === "user" ? stripDeveloperInstructions(rawText) : rawText;
    if (!text.trim()) {
      continue;
    }

    turns.push({ role, text: text.trim(), at: entry.timestamp });
  }

  return limit === undefined ? turns : turns.slice(-limit);
}

// Groq sessions have no persisted CLI transcript (nothing spawns a `codex` or
// `claude` process for them), but when one is available it is built from the
// same `applyStreamJsonEvent`/message shape as Claude's, so the Claude parser
// is the correct one to reuse rather than inventing a third format.
export function parseTurns(runtime: AgentRuntime, transcript: string, limit?: number): PeerTurn[] {
  return runtime === "codex" ? parseCodexTurns(transcript, limit) : parseClaudeTurns(transcript, limit);
}

/** Enough of a command to recognise it; the rest is noise in a list. */
const ACTIVITY_CAP = 120;

/**
 * Both runtimes write a call and its result as separate lines with a shared id,
 * so "still running" is just: the newest call whose id has no result yet. That
 * survives a tail read — an unmatched id near the end of the window is either
 * genuinely in flight or, at worst, a call whose result landed after the read.
 */
function activityFrom(
  calls: readonly { id: string; kind: "command" | "tool"; detail: string; at?: string }[],
  answered: ReadonlySet<string>,
): PeerActivity | undefined {
  const last = calls[calls.length - 1];
  if (!last) {
    return undefined;
  }
  return { kind: last.kind, detail: trimExcerpt(last.detail, ACTIVITY_CAP), pending: !answered.has(last.id), at: last.at };
}

type ClaudeToolBlock = {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  input?: { command?: unknown; file_path?: unknown; pattern?: unknown; description?: unknown };
};

/** `Bash` is the only tool that can hold the machine hostage, so it reads as a command. */
function claudeToolDetail(block: ClaudeToolBlock): { kind: "command" | "tool"; detail: string } {
  const input = block.input ?? {};
  if (block.name === "Bash" && typeof input.command === "string") {
    return { kind: "command", detail: input.command };
  }
  const argument = [input.file_path, input.pattern, input.description].find((value) => typeof value === "string");
  return { kind: "tool", detail: argument ? `${block.name ?? "tool"} ${argument as string}` : (block.name ?? "tool") };
}

export function parseClaudeActivity(transcript: string): PeerActivity | undefined {
  const calls: { id: string; kind: "command" | "tool"; detail: string; at?: string }[] = [];
  const answered = new Set<string>();

  for (const line of transcript.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let entry: { type?: string; timestamp?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const raw of content) {
      const block = raw as ClaudeToolBlock;
      if (block?.type === "tool_use" && typeof block.id === "string") {
        calls.push({ id: block.id, ...claudeToolDetail(block), at: entry.timestamp });
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        answered.add(block.tool_use_id);
      }
    }
  }

  return activityFrom(calls, answered);
}

export function parseCodexActivity(transcript: string): PeerActivity | undefined {
  const calls: { id: string; kind: "command" | "tool"; detail: string; at?: string }[] = [];
  const answered = new Set<string>();

  for (const line of transcript.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let entry: { timestamp?: string; payload?: { type?: string; name?: string; call_id?: string; arguments?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }

    const payload = entry.payload;
    const callId = typeof payload?.call_id === "string" ? payload.call_id : undefined;
    if (!payload || !callId) {
      continue;
    }

    if (payload.type === "function_call_output") {
      answered.add(callId);
      continue;
    }

    if (payload.type !== "function_call") {
      continue;
    }

    // Codex hands the shell its argv as JSON: `cmd` as a string on
    // `exec_command`, `command` as an array on `shell`. Anything else is named
    // by its tool rather than guessed at.
    let detail = payload.name ?? "tool";
    let kind: "command" | "tool" = "tool";
    try {
      const args = JSON.parse(String(payload.arguments ?? "{}")) as { cmd?: unknown; command?: unknown };
      const command = typeof args.cmd === "string" ? args.cmd : Array.isArray(args.command) ? args.command.join(" ") : undefined;
      if (command) {
        detail = command;
        kind = "command";
      }
    } catch {
      // Malformed or half-written arguments: the tool name still says something.
    }

    calls.push({ id: callId, kind, detail, at: entry.timestamp });
  }

  return activityFrom(calls, answered);
}

// Same reasoning as parseTurns: groq has no distinct transcript format of its
// own, so it rides the Claude parser rather than the Codex one.
export function parseActivity(runtime: AgentRuntime, transcript: string): PeerActivity | undefined {
  return runtime === "codex" ? parseCodexActivity(transcript) : parseClaudeActivity(transcript);
}

/**
 * A section plus the headline of its transcript.
 *
 * `turnCount` is part of the contract: whatever the list quotes here, the reader
 * can hand back in full. A section with turns can never be summarised as having
 * none, because both numbers come from the same `transcript`.
 */
export function summarizePeer(
  thread: PersistedThread,
  options: {
    selfId?: string;
    transcript?: PeerTranscript;
    now?: number;
    /**
     * Every section in the workspace, self included, purely to resolve the tree
     * around this one. Absent → the relationship fields are left off rather than
     * guessed at, which is what keeps this function usable from a test with one
     * thread in hand.
     */
    threads?: readonly PersistedThread[];
  },
): PeerSession {
  const runtime = thread.runtime ?? "claude";
  const transcript = options.transcript ?? EMPTY_TRANSCRIPT;
  const turns = transcript.turns;
  const lastPrompt = [...turns].reverse().find((turn) => turn.role === "user");
  const lastReply = [...turns].reverse().find((turn) => turn.role === "agent");
  const status = peerStatus(thread, transcript, options.now);

  return {
    id: thread.id,
    title: thread.title,
    runtime,
    cwd: thread.cwd,
    state: status.state,
    stateReason: status.reason,
    isSelf: thread.id === options.selfId,
    createdAt: thread.createdAt,
    lastActiveAt: thread.lastActiveAt,
    lastPromptAt: thread.lastPromptAt,
    lastPrompt: lastPrompt ? trimExcerpt(lastPrompt.text) : undefined,
    lastReply: lastReply ? trimExcerpt(lastReply.text) : undefined,
    turnCount: turns.length,
    transcriptAt: transcript.modifiedAt,
    activity: transcript.activity,
    parentId: thread.parentId,
    parentTitle: options.threads?.find((candidate) => candidate.id === thread.parentId)?.title,
    childIds: options.threads ? childrenOf(options.threads, thread.id).map((child) => child.id) : undefined,
    // Undefined rather than false when unstarred, so the renderer can test the
    // field without every ordinary section carrying a negative.
    starred: thread.starred === true ? true : undefined,
  };
}

/** Longest message one section may hand another; steering, not a document. */
export const PEER_MESSAGE_CAP = 4000;

/**
 * How a peer's message is presented to the section that receives it.
 *
 * It arrives on the same channel as an operator prompt — that is the only input
 * a running agent has — so the header has to do the disambiguating: say who sent
 * it, say plainly that it is not the user talking, and discourage the reflexive
 * "thanks, noted" reply that would otherwise bounce between two agents forever.
 */
export function formatPeerMessage(
  sender: { id: string; title: string },
  text: string,
  /**
   * How the sender sits relative to the reader. Worth a sentence because the two
   * directions are not the same message: a report arriving from a sub-thread is
   * a result the reader asked for and has to fold into its own work, while an
   * instruction from a parent is closer to the operator's own voice.
   */
  relation: "parent" | "subthread" | "peer" = "peer",
): string {
  const preamble =
    relation === "subthread"
      ? [
          `[Message from "${sender.title}" (id \`${sender.id}\`), a SUB-THREAD you opened in this workspace.`,
          "It is reporting on the piece of work you handed it — read it as a result to act on, not as a request for approval.",
          "Verify anything you are about to rely on with `read_session` rather than taking the summary on trust.]",
        ]
      : relation === "parent"
        ? [
            `[Message from "${sender.title}" (id \`${sender.id}\`), the section this one is a SUB-THREAD of.`,
            "It is steering the work it handed you, so treat this much like an instruction from the operator — but it is another",
            "agent, not the user, and the user's own instructions in this section still take precedence.]",
          ]
        : [
            `[Message from the Panda Code section "${sender.title}" (id \`${sender.id}\`) working in this same workspace.`,
            "It was sent by another agent, not by the user. Act on it if it bears on your current work, and otherwise just take it as context.",
            "Do not reply out of politeness: send a message back only if the other section actually needs an answer from you to continue.]",
          ];

  return [...preamble, "", text.trim()].join("\n");
}

/**
 * What a section is told when one it opened is BLOCKED waiting for input.
 *
 * The only unsolicited notice left. Completion used to be announced the same
 * way and no longer is — a parent that wants to know a child is done can call
 * `list_sessions` / `wait_for_session` — but a blocked child cannot ask for
 * itself, so nobody would ever unblock it.
 */
export function formatPeerNeedsInput(
  child: { id: string; title: string },
  status: PeerStatus,
  options: { subthread?: boolean } = {},
): string {
  const kind = options.subthread ? "sub-thread" : "section";

  return [
    `[Panda Code notice, not a message from the user: the ${kind} "${child.title}" (id \`${child.id}\`) that you opened still needs input${status.reason ? `: ${status.reason}` : "."}`,
    "It has not produced a result yet; read it for context or wait until the requested input is resolved.]",
  ].join("\n");
}

/**
 * Longest opening brief one section may give a section it creates.
 *
 * Larger than `PEER_MESSAGE_CAP` on purpose: steering an agent that already has
 * the context is a sentence, while handing a task to an empty session means
 * writing down everything it will not otherwise know.
 */
export const PEER_TASK_CAP = 12_000;

export function normalizeRuntime(value: string | undefined): AgentRuntime | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed === "codex" || trimmed === "claude" || trimmed === "groq" ? trimmed : undefined;
}

/**
 * The first prompt of a section another agent opened.
 *
 * It has no history at all — not the conversation that led to it, not the user
 * who is ultimately asking — so the header has to establish three things: the
 * task is legitimate (a person asked for it, one step removed), the sender is a
 * peer rather than the operator, and the new section is not expected to answer
 * back. Without that last part two sections narrate progress at each other, and
 * neither is the one doing the work.
 */
export function formatPeerTask(
  sender: { id: string; title: string },
  task: string,
  options: { subthread?: boolean } = {},
): string {
  // A sub-thread is told it is one. The difference is not decorative: its parent
  // is answering for the whole piece of work, so "report back when you are done"
  // is the honest instruction here and the wrong one for a sibling, which the
  // user is steering directly and which reporting at would just be noise.
  const relationship = options.subthread
    ? [
        `[This section is a SUB-THREAD of the Panda Code section "${sender.title}" (id \`${sender.id}\`), working in this same workspace.`,
        "It opened you to carry out one piece of the work it is responsible for — normally because the user asked for that piece",
        "to run separately. Treat the task below as the operator's own request and get on with it; the user can read this section",
        "and steer it directly. When you are done, `send_message` your parent a short result — it is waiting on this to finish its",
        "own work — and message it earlier if you are blocked on something only it knows.]",
      ]
    : [
        `[This section was opened by the Panda Code section "${sender.title}" (id \`${sender.id}\`), working in this same workspace,`,
        "to carry out the task below — normally because the user asked for it to be done in a separate section.",
        "Treat the task as the operator's own request and get on with it. The user can read this section and steer it directly.",
        "You do not need to report back: only use `send_message` if you are blocked on something the other section knows,",
        "or if it explicitly asked for an answer.]",
      ];

  return [...relationship, "", task.trim()].join("\n");
}

export function stateLabel(peer: Pick<PeerSession, "state" | "stateReason">): string {
  const base = peer.state;
  return peer.stateReason ? `${base} (${peer.stateReason})` : base;
}

/**
 * What a section is doing this second, when it is worth a line.
 *
 * Only for `running` sections: a dangling call in a transcript that ended is a
 * call that was interrupted, not one still going, and reporting it as live is
 * how a caller talks itself into waiting for a section that stopped an hour ago.
 */
function activityLine(peer: PeerSession): string | undefined {
  if (peer.state !== "running" || !peer.activity?.pending) {
    return undefined;
  }
  const { kind, detail, at } = peer.activity;
  const since = at ? ` (since ${at})` : "";
  return kind === "command" ? `- **running now:** \`${detail}\`${since}` : `- **running now:** ${detail}${since}`;
}

/** Markdown, because every agent-facing tool result is read as text. */
export function renderPeerList(
  peers: readonly PeerSession[],
  cwd: string,
  selfId?: string,
  /**
   * The machine's own headline. Sections share one laptop, and the list is the
   * one place every agent looks before starting something expensive — so the
   * load belongs here rather than behind a tool nobody thinks to call.
   */
  machine?: string,
): string {
  if (peers.length === 0) {
    return machine ? `No other sections are open in ${cwd}.\n\n${machine}` : `No other sections are open in ${cwd}.`;
  }

  const lines = [
    `${peers.length} section${peers.length === 1 ? "" : "s"} in ${cwd}:`,
    "",
    "States: `running` = a turn is in progress, `idle` = alive and waiting for a prompt,",
    "`finished` = ended with its transcript readable, `failed` = ended with nothing to read.",
    "",
  ];
  // Only mentioned when one exists: on a board with nothing starred the legend
  // would be a line explaining a mark the reader will never see.
  if (peers.some((peer) => peer.starred)) {
    lines.push(
      "★ = starred by the user: a standing section they keep on purpose. Often the one holding a device, a logged-in app or a long-running " +
        "investigation, which makes it the section to `send_message` when you need something only it can see.",
      "",
    );
  }
  if (machine) {
    lines.push(machine, "");
  }
  const titleById = new Map(peers.map((peer) => [peer.id, peer.title]));
  for (const peer of sortPeers(peers)) {
    lines.push(`## ${peer.starred ? "★ " : ""}${peer.title}${peer.isSelf ? " (you)" : ""}`);
    lines.push(`- id: \`${peer.id}\` · ${peer.runtime} · **${stateLabel(peer)}** · last active ${peer.lastActiveAt}`);
    // The tree, stated rather than drawn: an indented list reads as an ordering
    // to a model, and the relationship is the thing that matters here — who is
    // accountable for this section's result, and what it in turn delegated.
    if (peer.parentId) {
      const parentName = peer.parentTitle ?? titleById.get(peer.parentId);
      lines.push(
        `- sub-thread of ${parentName ? `"${parentName}" ` : ""}(\`${peer.parentId}\`)` +
          (selfId && peer.parentId === selfId ? " — you opened it" : ""),
      );
    }
    if (peer.childIds && peer.childIds.length > 0) {
      const names = peer.childIds.map((id) => (titleById.get(id) ? `"${titleById.get(id)}"` : `\`${id}\``));
      lines.push(`- sub-threads (${peer.childIds.length}): ${names.join(", ")}`);
    }
    const activity = activityLine(peer);
    if (activity) {
      lines.push(activity);
    }
    lines.push(`- transcript: ${peer.turnCount} turn${peer.turnCount === 1 ? "" : "s"} readable with \`read_session\``);
    if (peer.lastPrompt) {
      lines.push(`- asked: ${peer.lastPrompt}`);
    }
    if (peer.lastReply) {
      lines.push(`- replied: ${peer.lastReply}`);
    }
    lines.push("");
  }

  lines.push(
    "`read_session` reads one section's conversation in full (it pages — see its `offset` and `turn` arguments), " +
      "`wait_for_session` blocks until one reaches a terminal state, and `send_message` hands one an instruction.",
  );
  return lines.join("\n");
}

export type PeerPageRequest = {
  /** Turns per page. */
  limit: number;
  /** Turns to step back from the newest; 0 is the latest page. */
  offset: number;
  /** Return every turn on the page whole, however long. */
  full?: boolean;
};

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function detailHeader(peer: PeerSession, transcript: PeerTranscript): string[] {
  const header = [
    `# ${peer.title}${peer.isSelf ? " (you)" : ""}`,
    `id: \`${peer.id}\` · ${peer.runtime} · **${stateLabel(peer)}** · workspace ${peer.cwd}`,
  ];
  if (peer.parentId) {
    header.push(`sub-thread of ${peer.parentTitle ? `"${peer.parentTitle}" ` : ""}(\`${peer.parentId}\`)`);
  }
  if (peer.childIds && peer.childIds.length > 0) {
    header.push(`sub-threads: ${peer.childIds.length} (list_sessions shows them)`);
  }
  const activity = activityLine(peer);
  if (activity) {
    header.push(activity.replace(/^- /, ""));
  }
  if (transcript.path) {
    header.push(`transcript: ${transcript.path}`);
  }
  return header;
}

/**
 * One page of a section's conversation.
 *
 * Two things are load-bearing here. Nothing is ever dropped quietly: a shortened
 * turn says how much is missing and which call returns the rest, and a page that
 * is not the whole transcript says which `offset` reaches the older ones. And an
 * empty result distinguishes "no file to read" from "read it, it is empty" —
 * conflating those is what convinced a caller three working sections had died.
 */
export function renderPeerDetail(peer: PeerSession, transcript: PeerTranscript, page: PeerPageRequest): string {
  const header = detailHeader(peer, transcript);
  const total = transcript.turns.length;

  if (total === 0) {
    const explanation =
      transcript.miss === "not-linked"
        ? "This section has no transcript file yet: its runtime has not reported a session id. Nothing it has done can be read here."
        : transcript.miss === "not-found"
          ? "This section's transcript file is not on disk, so nothing it has done can be read here."
          : transcript.miss === "unreadable"
            ? "This section's transcript could not be read (unreadable or malformed on disk)."
            : "This section's transcript is on disk but holds no turns yet — it has not said anything.";
    return [...header, "", explanation, "", peer.state === "running" ? "It is still running; try again shortly." : ""].join("\n").trimEnd();
  }

  const limit = Math.max(1, page.limit);
  const offset = Math.max(0, page.offset);
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - limit);
  const shown = transcript.turns.slice(start, end);

  if (shown.length === 0) {
    return [
      ...header,
      "",
      `This section has ${total} turn${total === 1 ? "" : "s"}; offset ${offset} is past the beginning. Use a smaller \`offset\`.`,
    ].join("\n");
  }

  header.push(`turns ${start + 1}–${end} of ${total}${offset > 0 ? ` (offset ${offset})` : ""}`);

  const body = shown.map((turn, index) => {
    const number = start + index + 1;
    const label = `**${turn.role === "user" ? "Operator" : "Agent"}** · turn ${number}${turn.at ? ` · ${turn.at}` : ""}`;
    if (page.full || turn.text.length <= TURN_PREVIEW_CAP) {
      return `${label}\n${turn.text}`;
    }

    const kept = turn.text.slice(0, TURN_PREVIEW_CAP);
    const dropped = turn.text.length - TURN_PREVIEW_CAP;
    return [
      label,
      kept,
      `[TRUNCATED: ${formatCount(dropped)} of ${formatCount(turn.text.length)} characters not shown. ` +
        `Call read_session with id \`${peer.id}\` and turn: ${number} to read this turn in full.]`,
    ].join("\n");
  });

  const footer: string[] = [];
  if (start > 0) {
    footer.push(`${start} older turn${start === 1 ? "" : "s"} above this page: call read_session with offset: ${offset + shown.length}.`);
  }
  if (transcript.omittedBytes > 0) {
    footer.push(
      `Older still: ${formatCount(transcript.omittedBytes)} bytes of this transcript are before the read window and are not available here.`,
    );
  }
  if (end < total) {
    footer.push(`${total - end} newer turn${total - end === 1 ? "" : "s"} below this page: call read_session with offset: ${Math.max(0, offset - limit)}.`);
  }

  return [...header, "", body.join("\n\n"), ...(footer.length > 0 ? ["", footer.join(" ")] : [])].join("\n");
}

/**
 * One whole turn, in `TURN_PART_CHARS` slices.
 *
 * The escape hatch from truncation. Before this existed a caller that hit a cut
 * reply had to `send_message` the other section asking it to repeat its own
 * answer in pieces — which costs a model turn and can quietly reword the thing
 * being retrieved.
 */
export function renderPeerTurn(peer: PeerSession, transcript: PeerTranscript, turnNumber: number, part: number): string {
  const total = transcript.turns.length;
  const turn = transcript.turns[turnNumber - 1];
  if (!turn) {
    return `Section "${peer.title}" has ${total} readable turn${total === 1 ? "" : "s"}; there is no turn ${turnNumber}.`;
  }

  const parts = Math.max(1, Math.ceil(turn.text.length / TURN_PART_CHARS));
  const index = Math.min(Math.max(1, part), parts);
  const from = (index - 1) * TURN_PART_CHARS;
  const slice = turn.text.slice(from, from + TURN_PART_CHARS);

  const header = [
    `# ${peer.title} — turn ${turnNumber} of ${total}`,
    `${turn.role === "user" ? "Operator" : "Agent"}${turn.at ? ` · ${turn.at}` : ""} · part ${index} of ${parts} · ` +
      `characters ${formatCount(from + 1)}–${formatCount(Math.min(turn.text.length, from + TURN_PART_CHARS))} of ${formatCount(turn.text.length)}`,
    "",
  ];

  const footer =
    index < parts
      ? ["", `[CONTINUES: call read_session with id \`${peer.id}\`, turn: ${turnNumber}, part: ${index + 1} for the rest.]`]
      : [];

  return [...header, slice, ...footer].join("\n");
}

/**
 * A message one section sent another, as journalled by the deliverer.
 *
 * Kept so `read_session` can answer the question `send_message` cannot: was it
 * actually read? A prompt that was accepted by a live transport is not the same
 * as one an agent has seen, and the difference decides whether the sender should
 * wait or chase.
 */
export type PeerMessageRecord = {
  at: string;
  to: string;
  fromTitle?: string;
  /** Opening of the message body, used to spot it in the target's transcript. */
  preview: string;
};

/** How the message was accepted, as reported back to the sender. */
export type PeerDelivery = "live" | "queued" | "restarted" | "refused";

export function describeDelivery(delivery: PeerDelivery, target: { title: string; id: string }): string {
  switch (delivery) {
    case "live":
      return `Delivered to "${target.title}" (\`${target.id}\`); it is mid-turn, so it will read this when that turn ends.`;
    case "queued":
      return `Delivered to "${target.title}" (\`${target.id}\`); it is idle, so it starts on this now.`;
    case "restarted":
      return `"${target.title}" (\`${target.id}\`) had stopped, so it was restarted to receive this. It will answer as a fresh turn.`;
    default:
      return `Not delivered to "${target.title}" (\`${target.id}\`).`;
  }
}

/**
 * "Has it read what I sent?" — answered by looking for the message in the
 * target's own transcript rather than by trusting the send call's return value.
 */
export function renderInbox(records: readonly PeerMessageRecord[], transcript: PeerTranscript): string | undefined {
  if (records.length === 0) {
    return undefined;
  }

  const prompts = transcript.turns.filter((turn) => turn.role === "user").map((turn) => turn.text);
  const lines = records.map((record) => {
    const read = record.preview.length > 0 && prompts.some((text) => text.includes(record.preview));
    return `- ${record.at} from ${record.fromTitle ?? "another section"}: ${read ? "**read**" : "**not read yet**"} — ${trimExcerpt(record.preview, 120)}`;
  });

  return [`Messages sent to this section (${records.length}):`, ...lines].join("\n");
}
