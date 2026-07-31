import type { ConversationItem } from "../../shared/ipc";

const MERGE_LIMIT = 500;

function normalizedPromptBody(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function collapseDoubledBody(value: string): string {
  const half = value.length / 2;
  if (Number.isInteger(half) && half > 0 && value.slice(0, half) === value.slice(half)) {
    return value.slice(0, half);
  }
  return value;
}

function isOptimisticPrompt(item: ConversationItem): boolean {
  return item.kind === "user" && item.id.startsWith("local:");
}

function isOptimisticThinking(item: ConversationItem): boolean {
  return item.kind === "assistant" && item.id.startsWith("local-thinking:");
}

function isSteeringMarker(item: ConversationItem): boolean {
  return item.kind === "marker" && item.id.startsWith("local-steer:");
}

function isSamePrompt(first: ConversationItem, second: ConversationItem): boolean {
  if (first.kind !== "user" || second.kind !== "user") {
    return false;
  }

  const firstBody = normalizedPromptBody(first.body);
  const secondBody = normalizedPromptBody(second.body);
  return firstBody === secondBody || firstBody + firstBody === secondBody || secondBody + secondBody === firstBody;
}

function itemTime(item: ConversationItem): number {
  if (!item.timestamp) {
    // A missing timestamp must still produce a consistent total order for the
    // sort comparator; NaN here made Array.sort scramble whole runs of items.
    return 0;
  }

  const time = new Date(item.timestamp).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function kindRank(item: ConversationItem): number {
  if (isOptimisticThinking(item)) {
    return 2;
  }

  if (item.kind === "user") {
    return 0;
  }

  if (item.kind === "marker") {
    return 1;
  }

  if (item.kind === "system") {
    return 2;
  }

  if (item.kind === "tool") {
    return 3;
  }

  return 4;
}

function itemSequence(item: ConversationItem): number {
  return item.sequence ?? Number.POSITIVE_INFINITY;
}

function itemIdentity(item: ConversationItem): string {
  if (isSteeringMarker(item)) {
    return `id:${item.id}`;
  }

  // Optimistic local prompts match their canonical copy by content (the
  // canonical id is unknowable in advance). Canonical user items keep their
  // id identity so two identical prompts stay two bubbles.
  if (item.kind === "user" && item.id.startsWith("local:")) {
    return `content:user:${collapseDoubledBody(normalizedPromptBody(item.body))}`;
  }

  if (!item.id.startsWith("local:") && !item.id.startsWith("local-thinking:") && !item.id.startsWith("local-steer:")) {
    return `id:${item.id}`;
  }

  return `content:${item.kind}:${normalizedPromptBody(item.body)}`;
}

function hasIncomingTurnActivity(incoming: ConversationItem[], since: number): boolean {
  return incoming.some((incomingItem) => {
    if (incomingItem.kind === "user") {
      return false;
    }
    const incomingTime = itemTime(incomingItem);
    if (Number.isNaN(incomingTime)) {
      return false;
    }

    if (incomingTime >= since - 1_000) {
      return true;
    }

    return isTerminalResponseItem(incomingItem) && incomingTime >= since - 60_000;
  });
}

function isTerminalResponseItem(item: ConversationItem): boolean {
  const text = `${item.title ?? ""}\n${item.body}`.toLowerCase();
  return [
    "monthly spend limit",
    "usage limit",
    "raise it at claude.ai/settings/usage",
    "codex error",
    "turn failed",
  ].some((needle) => text.includes(needle));
}

function steeringAgentText(marker: ConversationItem): { waiting: string; accepted: string; started: string } {
  if (/\bcodex\b/i.test(`${marker.title ?? ""}\n${marker.body}`)) {
    return { waiting: "Codex", accepted: "Codex", started: "Codex" };
  }

  return { waiting: "Claude Code", accepted: "Claude Code", started: "Claude" };
}

function acceptedPromptForMarker(marker: ConversationItem, incoming: ConversationItem[]): ConversationItem | null {
  const markerTime = itemTime(marker);
  if (Number.isNaN(markerTime)) {
    return null;
  }

  return (
    incoming.find((incomingItem) => {
      if (incomingItem.kind !== "user") {
        return false;
      }

      const incomingTime = itemTime(incomingItem);
      return !Number.isNaN(incomingTime) && Math.abs(markerTime - incomingTime) < 10_000;
    }) ?? null
  );
}

function hasPostPromptActivity(incoming: ConversationItem[], prompt: ConversationItem): boolean {
  const promptTime = itemTime(prompt);
  return !Number.isNaN(promptTime) && hasIncomingTurnActivity(incoming, promptTime);
}

function steeringMarkerWithStatus(marker: ConversationItem, incoming: ConversationItem[]): ConversationItem {
  const agent = steeringAgentText(marker);
  const acceptedPrompt = acceptedPromptForMarker(marker, incoming);
  if (!acceptedPrompt) {
    return markerWithoutAcceptedPrompt(marker, incoming);
  }

  if (hasPostPromptActivity(incoming, acceptedPrompt)) {
    return {
      ...marker,
      title: "Steering applied",
      body: `${agent.started} started working with the follow-up.`,
      timestamp: acceptedPrompt.timestamp ?? marker.timestamp,
    };
  }

  return {
    ...marker,
    title: "Steering received",
    body: `${agent.accepted} accepted the follow-up.`,
    timestamp: acceptedPrompt.timestamp ?? marker.timestamp,
  };
}

function markerWithoutAcceptedPrompt(marker: ConversationItem, incoming: ConversationItem[]): ConversationItem {
  const agent = steeringAgentText(marker);
  const markerTime = itemTime(marker);
  if (!Number.isNaN(markerTime) && hasIncomingTurnActivity(incoming, markerTime)) {
    return {
      ...marker,
      title: "Steering applied",
      body: `${agent.started} started working with the follow-up.`,
    };
  }

  return {
    ...marker,
    title: "Steering sent",
    body: `Waiting for ${agent.waiting} to receive the follow-up.`,
  };
}

function earliestTimestamp(first: ConversationItem, second: ConversationItem): string | undefined {
  const firstTime = itemTime(first);
  const secondTime = itemTime(second);
  if (firstTime === 0) {
    return second.timestamp ?? first.timestamp;
  }
  if (secondTime === 0) {
    return first.timestamp;
  }
  return firstTime <= secondTime ? first.timestamp : second.timestamp;
}

function dedupeConversationItems(items: ConversationItem[]): ConversationItem[] {
  const byIdentity = new Map<string, ConversationItem>();

  for (const item of items) {
    const identity = itemIdentity(item);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, item);
      continue;
    }

    const existingIsLocal = existing.id.startsWith("local:");
    const itemIsCanonical = !item.id.startsWith("local:");
    const winner = existingIsLocal && itemIsCanonical ? item : existing;
    // The same item can arrive stamped with its transcript time and again with
    // its stream arrival time. Keep the earliest so an item never jumps
    // forward in the feed when it is re-delivered. The model tag may only be
    // present on one of the copies, so keep whichever copy knows it.
    const timestamp = earliestTimestamp(existing, item);
    const model = winner.model ?? existing.model ?? item.model;
    byIdentity.set(
      identity,
      timestamp === winner.timestamp && model === winner.model ? winner : { ...winner, timestamp, model },
    );
  }

  return Array.from(byIdentity.values());
}

export function mergeConversationItems(existing: ConversationItem[], incoming: ConversationItem[]): ConversationItem[] {
  const pendingLocalItems = existing.flatMap((item) => {
    if (isOptimisticPrompt(item)) {
      return incoming.some((incomingItem) => isSamePrompt(item, incomingItem)) ? [] : [item];
    }

    if (isOptimisticThinking(item)) {
      const thinkingTime = itemTime(item);
      return !Number.isNaN(thinkingTime) && !hasIncomingTurnActivity(incoming, thinkingTime) ? [item] : [];
    }

    if (isSteeringMarker(item)) {
      return [steeringMarkerWithStatus(item, incoming)];
    }

    return [];
  });

  // Carry forward canonical items we already know about (history loaded from
  // the transcript, or earlier stream items) so a replaying or partial stream
  // snapshot never blanks the conversation. Incoming comes first so it wins on
  // identity collisions (it is the fresher copy).
  const retainedExisting = existing.filter(
    (item) => !isOptimisticPrompt(item) && !isOptimisticThinking(item) && !isSteeringMarker(item),
  );

  return dedupeConversationItems([...incoming, ...retainedExisting, ...pendingLocalItems]).sort((first, second) => {
    const firstTime = itemTime(first);
    const secondTime = itemTime(second);
    if (
      isOptimisticThinking(first) &&
      second.kind === "user" &&
      !Number.isNaN(firstTime) &&
      !Number.isNaN(secondTime) &&
      Math.abs(firstTime - secondTime) < 10_000
    ) {
      return 1;
    }

    if (
      first.kind === "user" &&
      isOptimisticThinking(second) &&
      !Number.isNaN(firstTime) &&
      !Number.isNaN(secondTime) &&
      Math.abs(firstTime - secondTime) < 10_000
    ) {
      return -1;
    }

    if (!Number.isNaN(firstTime) && !Number.isNaN(secondTime) && firstTime !== secondTime) {
      return firstTime - secondTime;
    }

    const firstSequence = itemSequence(first);
    const secondSequence = itemSequence(second);
    if (firstSequence !== secondSequence) {
      return firstSequence - secondSequence;
    }

    const rankDelta = kindRank(first) - kindRank(second);
    if (rankDelta !== 0) {
      return rankDelta;
    }

    return first.id.localeCompare(second.id);
  }).slice(-MERGE_LIMIT);
}
