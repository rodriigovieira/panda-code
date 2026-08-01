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
 */

export type PeerActivity = "working" | "waiting" | "idle" | "exited";

/** One turn of a peer's conversation, flattened to text. */
export type PeerTurn = {
  role: "user" | "agent";
  text: string;
  at?: string;
};

export type PeerSession = {
  id: string;
  title: string;
  runtime: AgentRuntime;
  cwd: string;
  activity: PeerActivity;
  /** True for the section whose agent is asking; it sees itself in the list. */
  isSelf: boolean;
  createdAt: string;
  lastActiveAt: string;
  lastPromptAt?: string;
  /** Most recent operator prompt, trimmed for display. */
  lastPrompt?: string;
  /** Most recent agent reply, trimmed for display. */
  lastReply?: string;
};

/** Keeps a single peer's excerpt from crowding out the rest of the list. */
const EXCERPT_CAP = 400;

/** A transcript tail long enough to be useful, short enough to stay cheap. */
const MAX_TURNS = 12;

/** Guards against a workspace with a runaway number of sections. */
const MAX_PEERS = 40;

function normalizeWorkspace(path: string): string {
  return path.replace(/\/+$/, "");
}

export function sameWorkspace(first: string, second: string): boolean {
  return normalizeWorkspace(first) === normalizeWorkspace(second);
}

/**
 * An agent is "working" only while its process is alive and mid-turn; a section
 * that is running but has answered is "waiting" (on the operator, or on an
 * approval). Exited sections stay listed — a finished neighbour is often exactly
 * the context the asker needs.
 */
export function peerActivity(thread: PersistedThread): PeerActivity {
  if (thread.status === "exited" || thread.status === "error") {
    return "exited";
  }

  switch (thread.agentState) {
    case "working":
      return "working";
    case "needs_action":
    case "waiting":
      return "waiting";
    default:
      return thread.status === "running" ? "waiting" : "idle";
  }
}

function activityRank(activity: PeerActivity): number {
  switch (activity) {
    case "working":
      return 0;
    case "waiting":
      return 1;
    case "idle":
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
 * The sections sharing `cwd`, live ones first and each band ordered by recency.
 *
 * Unlike the sidebar — which sorts by `lastPromptAt` so replay cannot float old
 * sections to the top — this list answers "what is happening right now", so
 * activity leads and `lastActiveAt` is a legitimate tiebreaker.
 */
export function selectWorkspacePeers(
  threads: readonly PersistedThread[],
  options: { cwd: string; selfId?: string; includeSelf?: boolean },
): PersistedThread[] {
  return threads
    .filter((thread) => !thread.draft && sameWorkspace(thread.cwd, options.cwd))
    .filter((thread) => options.includeSelf !== false || thread.id !== options.selfId)
    .sort((first, second) => {
      const byActivity = activityRank(peerActivity(first)) - activityRank(peerActivity(second));
      return byActivity !== 0 ? byActivity : activityTime(second) - activityTime(first);
    })
    .slice(0, MAX_PEERS);
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
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
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

export function parseClaudeTurns(transcript: string, limit = MAX_TURNS): PeerTurn[] {
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

  return turns.slice(-limit);
}

type CodexTranscriptLine = {
  timestamp?: string;
  payload?: { type?: string; role?: string; content?: unknown; message?: unknown };
};

export function parseCodexTurns(transcript: string, limit = MAX_TURNS): PeerTurn[] {
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

    const role =
      payload.type === "user_message" ? "user" : payload.type === "agent_message" ? "agent" : payload.role === "user" ? "user" : "agent";
    if (payload.type !== "message" && payload.type !== "user_message" && payload.type !== "agent_message") {
      continue;
    }

    const text = textFromContent(payload.content ?? payload.message);
    if (!text.trim()) {
      continue;
    }

    turns.push({ role, text: text.trim(), at: entry.timestamp });
  }

  return turns.slice(-limit);
}

export function parseTurns(runtime: AgentRuntime, transcript: string, limit = MAX_TURNS): PeerTurn[] {
  return runtime === "codex" ? parseCodexTurns(transcript, limit) : parseClaudeTurns(transcript, limit);
}

/**
 * A section plus the headline of its transcript. `transcript` is optional: a
 * section whose transcript is missing (never started, or a runtime that keeps no
 * file we can find) still belongs in the list — its title and state are useful
 * on their own.
 */
export function summarizePeer(
  thread: PersistedThread,
  options: { selfId?: string; transcript?: string },
): PeerSession {
  const runtime = thread.runtime ?? "claude";
  const turns = options.transcript ? parseTurns(runtime, options.transcript) : [];
  const lastPrompt = [...turns].reverse().find((turn) => turn.role === "user");
  const lastReply = [...turns].reverse().find((turn) => turn.role === "agent");

  return {
    id: thread.id,
    title: thread.title,
    runtime,
    cwd: thread.cwd,
    activity: peerActivity(thread),
    isSelf: thread.id === options.selfId,
    createdAt: thread.createdAt,
    lastActiveAt: thread.lastActiveAt,
    lastPromptAt: thread.lastPromptAt,
    lastPrompt: lastPrompt ? trimExcerpt(lastPrompt.text) : undefined,
    lastReply: lastReply ? trimExcerpt(lastReply.text) : undefined,
  };
}

function activityLabel(peer: PeerSession): string {
  switch (peer.activity) {
    case "working":
      return "working now";
    case "waiting":
      return "waiting for input";
    case "idle":
      return "idle";
    default:
      return "finished";
  }
}

/** Markdown, because every agent-facing tool result is read as text. */
export function renderPeerList(peers: readonly PeerSession[], cwd: string): string {
  if (peers.length === 0) {
    return `No other sections are open in ${cwd}.`;
  }

  const lines = [`${peers.length} section${peers.length === 1 ? "" : "s"} in ${cwd}:`, ""];
  for (const peer of peers) {
    lines.push(`## ${peer.title}${peer.isSelf ? " (you)" : ""}`);
    lines.push(`- id: \`${peer.id}\` · ${peer.runtime} · ${activityLabel(peer)} · last active ${peer.lastActiveAt}`);
    if (peer.lastPrompt) {
      lines.push(`- asked: ${peer.lastPrompt}`);
    }
    if (peer.lastReply) {
      lines.push(`- replied: ${peer.lastReply}`);
    }
    lines.push("");
  }

  lines.push("Use `read_session` with an id to read more of one section's conversation.");
  return lines.join("\n");
}

export function renderPeerDetail(peer: PeerSession, turns: readonly PeerTurn[]): string {
  const header = [
    `# ${peer.title}${peer.isSelf ? " (you)" : ""}`,
    `id: \`${peer.id}\` · ${peer.runtime} · ${activityLabel(peer)} · workspace ${peer.cwd}`,
    "",
  ];

  if (turns.length === 0) {
    return [...header, "No transcript is readable for this section yet."].join("\n");
  }

  const body = turns.map((turn) => `**${turn.role === "user" ? "Operator" : "Agent"}**${turn.at ? ` (${turn.at})` : ""}\n${trimExcerpt(turn.text, 2000)}`);
  return [...header, body.join("\n\n")].join("\n");
}
