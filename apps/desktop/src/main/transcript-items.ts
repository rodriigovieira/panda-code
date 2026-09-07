import type { AgentActivity, ConversationItem } from "../shared/ipc";
import {
  agentCardBody,
  agentCardItemId,
  applyTaskNotificationToAgent,
  parseAsyncAgentLaunch,
  parseTaskNotification,
  thinkingItemId,
  toolInputBody,
  toolResultBody,
  toolResultItemId,
  toolUseItemId,
} from "../shared/stream-json";

/** The shape of a Claude transcript line this module needs. */
type TranscriptEntry = {
  uuid?: string;
  timestamp?: string;
  message?: { id?: string; content?: unknown };
};

// Trailing-whitespace trim that keeps blank lines. `\s+\n` would also match the
// newline itself, collapsing every paragraph break — see compactBody in
// shared/stream-json.ts.
export function trimTrailingSpaces(value: string): string {
  return value.replace(/[^\S\n]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

export function compactBody(value: string, maxLength = 10_000): string {
  const normalized = trimTrailingSpaces(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

/**
 * Subagent cards a transcript pass has opened so far, keyed by the spawning
 * tool_use id. A reloaded session has to rebuild them from the JSONL the same
 * way the live stream builds them from events (stream-json.ts): the `task_*`
 * system events are never persisted, so the Agent/Task tool_use, its async
 * launch acknowledgement, and the queued `<task-notification>` are the only
 * signals left — without this the subagents came back as bare "Agent" tool rows.
 */
export type TranscriptAgentCards = Map<string, ConversationItem & { agent: AgentActivity }>;

export function createTranscriptAgentCards(): TranscriptAgentCards {
  return new Map();
}

export function toolItemsFromContent(
  entry: TranscriptEntry,
  lineIndex: number,
  agentCards: TranscriptAgentCards,
): ConversationItem[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const messageId = entry.message?.id ?? entry.uuid ?? String(lineIndex);
  const items: ConversationItem[] = [];
  content.forEach((part, partIndex) => {
    if (!part || typeof part !== "object") {
      return;
    }

    const candidate = part as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
      content?: unknown;
      thinking?: unknown;
      tool_use_id?: unknown;
    };
    if (candidate.type === "thinking") {
      items.push({
        id: thinkingItemId(messageId, partIndex),
        kind: "system",
        title: "Thinking",
        body:
          typeof candidate.thinking === "string" && candidate.thinking.trim()
            ? compactBody(candidate.thinking)
            : "Private reasoning step. Claude Code records that thinking happened, but does not expose readable thinking text.",
        timestamp: entry.timestamp,
        sequence: lineIndex * 100 + partIndex,
      });
    }

    if (candidate.type === "tool_use") {
      const toolName = typeof candidate.name === "string" ? candidate.name : "Tool call";
      const toolUseId = typeof candidate.id === "string" ? candidate.id : "";
      if ((toolName === "Agent" || toolName === "Task") && toolUseId) {
        const input = (candidate.input ?? {}) as { description?: unknown; subagent_type?: unknown };
        const agent: AgentActivity = {
          toolUseId,
          subagentType: typeof input.subagent_type === "string" ? input.subagent_type : undefined,
          status: "running",
        };
        const card = {
          id: agentCardItemId(toolUseId),
          kind: "agent" as const,
          title: typeof input.description === "string" && input.description.trim() ? input.description : "Agent",
          body: agentCardBody(agent),
          timestamp: entry.timestamp,
          sequence: lineIndex * 100 + partIndex,
          agent,
        };
        agentCards.set(toolUseId, card);
        items.push(card);
        return;
      }

      items.push({
        id: toolUseId ? toolUseItemId(toolUseId) : `stream:${messageId}:tool:${partIndex}`,
        kind: "tool",
        title: toolName,
        body: compactBody(toolInputBody(candidate.input)),
        timestamp: entry.timestamp,
        sequence: lineIndex * 100 + partIndex,
      });
    }

    if (candidate.type === "tool_result") {
      const result = toolResultBody(candidate.content);
      const resultToolUseId = typeof candidate.tool_use_id === "string" ? candidate.tool_use_id : "";
      // A subagent's result is its async launch acknowledgement (ids and the
      // output file) or an echo of work its card already shows — either way it
      // belongs on the card, not in a row of its own.
      const card = resultToolUseId ? agentCards.get(resultToolUseId) : undefined;
      if (card) {
        const launch = parseAsyncAgentLaunch(result);
        if (launch) {
          if (launch.agentId) card.agent.taskId = launch.agentId;
          if (launch.outputFile) card.agent.outputFile = launch.outputFile;
          card.body = agentCardBody(card.agent);
        }
        return;
      }

      items.push({
        id: resultToolUseId ? toolResultItemId(resultToolUseId) : `stream:${messageId}:result:${partIndex}`,
        kind: "tool",
        title: "Tool result",
        body: compactBody(result),
        timestamp: entry.timestamp,
        sequence: lineIndex * 100 + partIndex,
      });
    }
  });

  return items;
}

/**
 * A finished async subagent reports itself only as a queued
 * `<task-notification>` user turn; it is what takes its card out of "running"
 * on a reloaded transcript. No-op for any other text.
 */
export function resolveTranscriptTaskNotification(agentCards: TranscriptAgentCards, text: string): void {
  const notification = parseTaskNotification(text);
  if (!notification) {
    return;
  }
  const card =
    (notification.toolUseId ? agentCards.get(notification.toolUseId) : undefined) ??
    (notification.taskId
      ? [...agentCards.values()].find((candidate) => candidate.agent.taskId === notification.taskId)
      : undefined);
  if (!card) {
    return;
  }
  applyTaskNotificationToAgent(card.agent, notification);
  card.body = agentCardBody(card.agent);
}
