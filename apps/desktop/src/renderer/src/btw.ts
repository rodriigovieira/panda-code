import type { ConversationItem } from "../../shared/ipc";
import { serializeConversation } from "./export";

// Per-thread state for the "By the way" side chat rendered above the composer.
export type BtwState = {
  open: boolean;
  items: ConversationItem[];
  running: boolean;
  error?: string;
};

export const EMPTY_BTW: BtwState = { open: false, items: [], running: false };

const BTW_ITEM_LIMIT = 200;

// How much of the section's transcript we hand the /btw aside as context. The
// tail is what matters (newest activity last), and capping it keeps the aside a
// cheap one-shot instead of forking the whole session — which used to blind the
// aside after a runtime handoff and trip Claude's auto-compaction on long runs.
export const BTW_CONTEXT_CHAR_LIMIT = 20000;

// Render the section's live transcript into a plain-text block the /btw aside can
// read. It serializes whatever the UI already shows — every runtime, tool call,
// and code block — so a Claude→Codex handoff no longer hides the real work. Only
// the most recent `limit` characters are kept (whole leading items dropped first),
// since the newest turns carry the most relevant context. Shares its rendering
// with `/export`, minus the header: this slice is context, not a document.
export function serializeBtwContext(
  items: ConversationItem[],
  limit: number = BTW_CONTEXT_CHAR_LIMIT,
): string {
  return serializeConversation(items, { limit, header: false });
}

// The main process streams only the current /btw run's items (a fresh parser per
// question). Accumulate them into the panel's transcript so earlier turns stay
// visible: Map insertion order keeps prior turns first, in-place updates keep an
// item where it was, and the optimistic "Thinking..." row drops once the real
// answer starts arriving.
export function mergeBtwItems(existing: ConversationItem[], incoming: ConversationItem[]): ConversationItem[] {
  const byId = new Map<string, ConversationItem>(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    const previous = byId.get(item.id);
    byId.set(item.id, previous ? { ...previous, ...item } : item);
  }

  const hasContent = incoming.some(
    (item) => item.kind === "assistant" || item.kind === "tool" || item.kind === "system",
  );
  const merged = Array.from(byId.values());
  const cleaned = hasContent ? merged.filter((item) => !item.id.startsWith("local-thinking:")) : merged;
  return cleaned.slice(-BTW_ITEM_LIMIT);
}
