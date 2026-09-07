/**
 * The workspace backlog: one Trello-ish board per project folder, shared by the
 * operator and by every agent working in that folder.
 *
 * It exists because a workspace's work outlives any one section. A section is a
 * conversation — it ends, it compacts, it gets deleted — while "the three things
 * still wrong with the relay" is a property of the workspace, and until now the
 * only place it lived was the operator's head. The board gives that list a home
 * both sides can write to: the user drags cards in the UI, and an agent CRUDs
 * the same file through `backlog_*` (MCP) or `panda-peers backlog` (shell).
 *
 * Few columns and few fields on purpose. Anything richer — assignees, due
 * dates, links to sections — is a guess about how it will be used; `metadata` is
 * the free-form escape hatch until the real shape shows itself.
 *
 * Pure module: no fs, no electron. The store (`backlog-store.ts`) owns the disk
 * and the renderer owns the pixels, so both can be tested without either.
 */

/**
 * `globalThis.crypto` rather than `node:crypto`: this module is imported by the
 * renderer for its types and labels, and a node built-in in that import graph
 * breaks the browser bundle.
 */
export function newBacklogId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Board order, left to right. `pending` sits before `backlog` because it is
 * upstream of it: the triage step, not a stage of the work. `review` sits
 * between `in_progress` and `done` because it is the opposite — a stage of the
 * work, and the last one an agent can reach on its own.
 */
export const BACKLOG_COLUMNS = ["pending", "backlog", "in_progress", "review", "done"] as const;

export type BacklogColumn = (typeof BACKLOG_COLUMNS)[number];

/**
 * Columns that vanish when they hold nothing.
 *
 * `pending` is an inbox for cards filed by automation — today, findings from the
 * post-push AI review — which nobody has looked at yet. That makes it unlike the
 * other three: an empty Backlog is information ("nothing waiting"), while an
 * empty Pending is just a column of dead pixels on every board that has no
 * robot writing to it. It earns its place on the board only while it has
 * something to triage, and disappears again once the last card is moved out.
 *
 * The rule is deliberately a property of the column rather than a user setting:
 * a switch for this is a question the user has to answer once per workspace to
 * get back to the board they already wanted.
 */
export const COLUMNS_HIDDEN_WHEN_EMPTY: readonly BacklogColumn[] = ["pending"];

/**
 * Whether a column should be drawn at all, given how many cards it is showing.
 *
 * Takes the *visible* count, not the raw one: a Pending column holding nothing
 * but parked cards is, to a reader who has not asked to see held cards, empty.
 */
export function isColumnVisible(column: BacklogColumn, visibleCount: number): boolean {
  return visibleCount > 0 || !COLUMNS_HIDDEN_WHEN_EMPTY.includes(column);
}

/** Who put the card on the board. Agents get a badge so the user can tell. */
export type BacklogAuthor = "user" | "agent";

export type BacklogItem = {
  id: string;
  /**
   * The card's number on this board — `#12`, counting from 1.
   *
   * The uuid stays the identity (it is what links, section records and the
   * phone's payloads carry), but nobody can say "let's do 1a73aead" out loud,
   * and an agent asked to work on a card had to be handed eight hex digits.
   * Numbers are per board, assigned in the order cards were filed, and never
   * reused: `#7` means the same card tomorrow even if six cards are deleted.
   */
  number: number;
  title: string;
  /**
   * One-line TL;DR of the card, written by whoever last wrote the description.
   *
   * The board grew agent-written descriptions that are genuinely long — a
   * paragraph of findings, a list of what shipped — and the title alone stopped
   * being enough to decide whether to open a card. This is the sentence that
   * answers "what is this, and where does it stand?" without reading the body.
   * Empty string when nobody wrote one; the UI simply omits it.
   */
  summary: string;
  /** Free-form body, in Markdown. Empty string when the author gave none. */
  description: string;
  /**
   * Free-form notes the board itself takes no position on — labels, an estimate,
   * a file path, a link to a section. Deliberately a string rather than a
   * key/value map: the first real convention to emerge out of use can be parsed
   * out of it later, and until then nothing has to be migrated.
   */
  metadata: string;
  column: BacklogColumn;
  createdAt: string;
  updatedAt: string;
  createdBy: BacklogAuthor;
  /** Section title (or id) of the agent that filed it, when one did. */
  createdBySection?: string;
  /**
   * Sections working on this card, by thread id.
   *
   * The one relationship the board turned out to need: a card and the
   * conversations about it were connected only in the operator's head, so
   * "which section was doing this?" and "what is this section for?" were both
   * questions you answered by reading transcripts. Ids rather than titles —
   * titles are renamed and auto-generated, ids are not — which means a link to a
   * section that has since been deleted simply resolves to nothing, and the
   * reader drops it. Order is the order they were linked.
   */
  sections?: string[];
  /**
   * Parked: kept, but not up for work right now.
   *
   * A flag rather than a fourth column, because it is not a stage of the work —
   * a card can be parked out of any column and comes back to exactly where it
   * was. It answers the thing the board had no answer for: the idea you do not
   * want to lose and do not want to look at, which until now was either clutter
   * at the bottom of Backlog or a delete. Held cards are hidden everywhere the
   * board is read — the columns, the counts, the render an agent acts on — and
   * shown by asking for them.
   *
   * Undefined rather than `false` when a card is not held, so a board full of
   * ordinary cards stays byte-identical on disk to one written before this
   * existed.
   */
  onHold?: boolean;
  /**
   * Screenshots and recordings pinned to the card, newest last.
   *
   * Undefined rather than `[]` when there are none, for the same on-disk
   * compatibility reason every other optional field here is.
   */
  attachments?: BacklogAttachment[];
  /**
   * What was actually checked before calling this done — distinct from
   * `description`, which says what the card is; this says what proved it.
   * Free-form Markdown, same as description, so a note can sit right next to
   * the screenshots that back it up.
   */
  verificationNotes?: string;
};

/** What kind of file an attachment is — the only two the board can show inline. */
export type BacklogAttachmentKind = "image" | "video";

/**
 * A screenshot or recording pinned to a card — most often an agent's proof that
 * a piece of work actually happened, taken with the built-in browser and
 * attached to the card it verifies.
 *
 * `path` is absolute on the Mac that owns the board, inside the board's own
 * attachments directory rather than wherever it was captured (`browserService`'s
 * screenshot/recording output, typically): the file is copied in on attach, so
 * moving or cleaning up the original never breaks the card. The bytes never
 * touch this pure module — {@link attachBacklogFile} in `backlog-store.ts` does
 * the copy and hands back the resolved record this type describes.
 */
export type BacklogAttachment = {
  id: string;
  kind: BacklogAttachmentKind;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  /** One line about what the image or video shows. Optional — not every screenshot needs a caption. */
  caption?: string;
  createdAt: string;
  createdBySection?: string;
};

export type WorkspaceBacklog = {
  version: 1;
  /** The workspace this board belongs to; carried for readability on disk. */
  cwd: string;
  /** Board order. Within a column, first here is first on the board. */
  items: BacklogItem[];
  /**
   * The number the next card filed here will get.
   *
   * Stored rather than derived from `max(number) + 1` so that deleting the
   * newest card does not hand its number to the next one: `#12` in a sentence
   * written last week should never resolve to a card filed today.
   */
  nextNumber: number;
  updatedAt: string;
};

export const COLUMN_LABELS: Record<BacklogColumn, string> = {
  pending: "Pending",
  backlog: "Backlog",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

/** What a parked card is called, everywhere it is named. */
export const ON_HOLD_LABEL = "On hold";

/** Keeps a runaway agent from turning the board into a log file. */
export const MAX_BACKLOG_ITEMS = 500;
export const TITLE_CAP = 200;
/** A TL;DR that runs past this is a description; it is meant to be one line. */
export const SUMMARY_CAP = 300;
export const DESCRIPTION_CAP = 4_000;
export const METADATA_CAP = 1_000;
/** A card worked on by more sections than this is a project, not a card. */
export const MAX_LINKED_SECTIONS = 20;
/** A card carrying more proof than this is a project, not a card — same reasoning as {@link MAX_LINKED_SECTIONS}. */
export const MAX_ATTACHMENTS = 20;
export const CAPTION_CAP = 300;
export const VERIFICATION_NOTES_CAP = 4_000;

export function emptyBacklog(cwd: string, now = new Date().toISOString()): WorkspaceBacklog {
  return { version: 1, cwd, items: [], nextNumber: 1, updatedAt: now };
}

/** How a card is named in prose, in a link, and on its own face. */
export function cardRef(item: Pick<BacklogItem, "number">): string {
  return `#${item.number}`;
}

/**
 * `#12`, `12`, or anything else — the number a reference names, if it names one.
 *
 * Takes the bare form too because that is what an agent passes back after
 * reading a rendered board, and refusing it would only teach it to add the hash.
 */
export function parseCardRef(value: string): number | null {
  const match = value.trim().match(/^#?(\d{1,6})$/);
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function cap(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/**
 * The TL;DR, forced back onto one line.
 *
 * It renders in a single-line slot on the board and in the card's lead, so a
 * newline that slipped in from a pasted paragraph would either be swallowed or
 * blow up the row height depending on where it landed.
 */
function capSummary(value: unknown): string {
  return cap(value, SUMMARY_CAP).replace(/\s*\n+\s*/g, " ");
}

/**
 * Section links, cleaned up: strings only, no blanks, no duplicates, capped.
 *
 * Returns undefined for "none" rather than an empty array, so a card that has
 * never been linked to anything stays byte-identical on disk to one written
 * before the field existed.
 */
function capSections(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids: string[] = [];
  for (const raw of value) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
    if (ids.length >= MAX_LINKED_SECTIONS) {
      break;
    }
  }
  return ids.length > 0 ? ids : undefined;
}

function isAttachmentKind(value: unknown): value is BacklogAttachmentKind {
  return value === "image" || value === "video";
}

/** One attachment off disk, or null if the record is too broken to show. */
function sanitizeAttachment(raw: unknown, now: string): BacklogAttachment | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!isAttachmentKind(record.kind)) {
    return null;
  }
  const path = cap(record.path, 4_096);
  const name = cap(record.name, TITLE_CAP);
  if (!path || !name) {
    return null;
  }
  return {
    id: typeof record.id === "string" && record.id ? record.id : newBacklogId(),
    kind: record.kind,
    path,
    name,
    mimeType: cap(record.mimeType, 100) || "application/octet-stream",
    size: typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0 ? record.size : 0,
    caption: cap(record.caption, CAPTION_CAP) || undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    createdBySection: typeof record.createdBySection === "string" && record.createdBySection ? record.createdBySection : undefined,
  };
}

/** Attachments, cleaned up: valid records only, capped. Undefined for "none", like {@link capSections}. */
function capAttachments(value: unknown, now: string): BacklogAttachment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const attachments: BacklogAttachment[] = [];
  for (const raw of value) {
    const attachment = sanitizeAttachment(raw, now);
    if (attachment) {
      attachments.push(attachment);
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      break;
    }
  }
  return attachments.length > 0 ? attachments : undefined;
}

function isColumn(value: unknown): value is BacklogColumn {
  return typeof value === "string" && (BACKLOG_COLUMNS as readonly string[]).includes(value);
}

/**
 * Accept the words a human or an agent actually types, not just the enum.
 *
 * An agent asked to "move it to doing" should not have to guess that the
 * canonical token is `in_progress`; refusing it teaches nothing and costs a
 * turn. Unrecognized input returns undefined so the caller can say so.
 */
export function normalizeColumn(value: unknown): BacklogColumn | undefined {
  if (isColumn(value)) {
    return value;
  }
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  switch (text) {
    case "pending":
    case "triage":
    case "inbox":
    case "unreviewed":
    case "new":
      return "pending";
    case "todo":
    case "to_do":
    case "backlog":
    case "open":
      return "backlog";
    case "in_progress":
    case "progress":
    case "doing":
    case "wip":
    case "started":
      return "in_progress";
    case "review":
    case "in_review":
    case "needs_review":
    case "ready_for_review":
    case "awaiting_review":
    case "verify":
    case "verifying":
    case "qa":
    case "testing":
      return "review";
    case "done":
    case "complete":
    case "completed":
    case "finished":
    case "closed":
      return "done";
    default:
      return undefined;
  }
}

function sanitizeItem(raw: unknown, now: string): BacklogItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const title = cap(record.title, TITLE_CAP);
  if (!title) {
    return null;
  }

  return {
    id: typeof record.id === "string" && record.id ? record.id : newBacklogId(),
    // 0 means "not numbered yet" — a board written before numbers existed, or a
    // hand-edited card. {@link numberItems} fills those in on the way out.
    number: typeof record.number === "number" && Number.isInteger(record.number) && record.number > 0 ? record.number : 0,
    title,
    summary: capSummary(record.summary),
    description: cap(record.description, DESCRIPTION_CAP),
    metadata: cap(record.metadata, METADATA_CAP),
    column: normalizeColumn(record.column) ?? "backlog",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
    createdBy: record.createdBy === "agent" ? "agent" : "user",
    createdBySection: typeof record.createdBySection === "string" && record.createdBySection ? record.createdBySection : undefined,
    sections: capSections(record.sections),
    onHold: record.onHold === true ? true : undefined,
    attachments: capAttachments(record.attachments, now),
    verificationNotes: cap(record.verificationNotes, VERIFICATION_NOTES_CAP) || undefined,
  };
}

/**
 * Read a board off disk without ever throwing.
 *
 * Two processes write this file (the app and the out-of-process helper), so a
 * truncated or hand-edited read is a normal event rather than a bug: a board
 * that comes back empty is recoverable, an exception on the IPC path is not.
 */
export function parseBacklog(text: string, cwd: string, now = new Date().toISOString()): WorkspaceBacklog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return emptyBacklog(cwd, now);
  }

  if (!parsed || typeof parsed !== "object") {
    return emptyBacklog(cwd, now);
  }

  const record = parsed as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const seen = new Set<string>();
  const items: BacklogItem[] = [];
  for (const raw of rawItems) {
    const item = sanitizeItem(raw, now);
    if (!item || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    items.push(item);
    if (items.length >= MAX_BACKLOG_ITEMS) {
      break;
    }
  }

  const nextNumber = numberItems(
    items,
    typeof record.nextNumber === "number" && Number.isInteger(record.nextNumber) && record.nextNumber > 0 ? record.nextNumber : 1,
  );

  return {
    version: 1,
    cwd: typeof record.cwd === "string" && record.cwd ? record.cwd : cwd,
    items,
    nextNumber,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
  };
}

/**
 * Give every unnumbered card a number, in place, and answer with the next one.
 *
 * Boards predate numbers, so the first read of an old one assigns them. Oldest
 * card first, by the date it was filed rather than by where it sits in the
 * array — the array is board order, and a card dragged to the top of a column
 * would otherwise come out as the newest thing on a board it has been on for
 * weeks. Ties fall back to array order, so the result never depends on how the
 * runtime happens to sort.
 *
 * This runs on every read but only ever has anything to do on the first one:
 * the assignment is written back with the next mutation, and until then it is
 * deterministic, so a card does not change number between two reads of the same
 * file.
 */
function numberItems(items: BacklogItem[], startAt: number): number {
  let next = Math.max(startAt, ...items.map((item) => item.number + 1));
  const unnumbered = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.number === 0)
    .sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt) || b.index - a.index);

  for (const { item } of unnumbered) {
    item.number = next;
    next += 1;
  }
  return next;
}

export type BacklogCreate = {
  title: string;
  /** One-line TL;DR. Optional, but agents are asked for one. */
  summary?: string;
  description?: string;
  metadata?: string;
  column?: string;
  createdBy?: BacklogAuthor;
  createdBySection?: string;
  /** Sections to link on the way in — the one that filed it, usually. */
  sections?: string[];
  /** Attachments to file alongside the card, already resolved by the store layer. */
  attachments?: BacklogAttachment[];
  verificationNotes?: string;
  /** Hold this caller to the evidence bar on `done` — see {@link BacklogPatch.requireEvidence}. */
  requireEvidence?: boolean;
};

export type BacklogPatch = {
  title?: string;
  summary?: string;
  description?: string;
  metadata?: string;
  column?: string;
  /** Park the card, or bring it back. Its column is untouched either way. */
  onHold?: boolean;
  /**
   * Section to link while editing. A patch rather than a whole `sections` array:
   * every caller that has an opinion about links has exactly one section in
   * hand (its own), and a replace would let a stale editor drop someone else's.
   */
  linkSection?: string;
  verificationNotes?: string;
  /**
   * Attachments to append, already resolved by the store layer (bytes copied,
   * size checked) — this module never touches a file. Additive like
   * `linkSection`, for the same reason: two agents attaching in the same beat
   * should not be able to stomp each other's screenshot.
   */
  addAttachments?: BacklogAttachment[];
  removeAttachmentIds?: string[];
  /**
   * Whether this caller has to show evidence to move a card into `done` — see
   * {@link evidenceRequiredMessage}.
   *
   * Opt-in rather than on by default, and set by exactly one place: the agent
   * entry points in `peers-entry.ts`. The app's own mutation path (a user
   * dragging a card, or moving one from their phone) goes through the same
   * function and must stay unrestricted, because the user *is* the review step.
   */
  requireEvidence?: boolean;
};

/** Every mutation answers the same way: the new board, or why nothing changed. */
export type BacklogResult =
  | { ok: true; backlog: WorkspaceBacklog; item?: BacklogItem; message: string }
  | { ok: false; message: string };

function withItems(backlog: WorkspaceBacklog, items: BacklogItem[], now: string): WorkspaceBacklog {
  return { ...backlog, items, updatedAt: now };
}

export function addBacklogItem(
  backlog: WorkspaceBacklog,
  input: BacklogCreate,
  now = new Date().toISOString(),
  id: string = newBacklogId(),
): BacklogResult {
  const title = cap(input.title, TITLE_CAP);
  if (!title) {
    return { ok: false, message: "A backlog item needs a non-empty title." };
  }
  if (backlog.items.length >= MAX_BACKLOG_ITEMS) {
    return { ok: false, message: `This board already holds ${MAX_BACKLOG_ITEMS} items. Clear some done work before adding more.` };
  }

  const requested = input.column === undefined ? "backlog" : normalizeColumn(input.column);
  if (!requested) {
    return { ok: false, message: unknownColumnMessage(input.column) };
  }
  // Filing straight into Done is the same claim as moving a card there, so it
  // meets the same bar. The number in the message is the one this card is about
  // to get, since it does not have one yet.
  if (input.requireEvidence && requested === "done" && !hasEvidence(input)) {
    return { ok: false, message: evidenceRequiredMessage({ number: backlog.nextNumber ?? 1 }) };
  }

  // `nextNumber` can be behind a hand-edited card's number; the parse repairs
  // that on read, and taking the larger of the two here means a board written by
  // an older build never hands out a number that is already on it.
  const number = Math.max(backlog.nextNumber ?? 1, ...backlog.items.map((existing) => existing.number + 1), 1);

  const item: BacklogItem = {
    id,
    number,
    title,
    summary: capSummary(input.summary),
    description: cap(input.description, DESCRIPTION_CAP),
    metadata: cap(input.metadata, METADATA_CAP),
    column: requested,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy === "agent" ? "agent" : "user",
    createdBySection: input.createdBySection ? cap(input.createdBySection, TITLE_CAP) : undefined,
    sections: capSections(input.sections),
    attachments: input.attachments && input.attachments.length > 0 ? input.attachments.slice(0, MAX_ATTACHMENTS) : undefined,
    verificationNotes: cap(input.verificationNotes, VERIFICATION_NOTES_CAP) || undefined,
  };

  // New cards land at the top of their column: the thing just filed is the thing
  // most likely to be looked at, and appending buried it under months of done.
  const items = [item, ...backlog.items];
  const saved = { ...withItems(backlog, items, now), nextNumber: number + 1 };
  return { ok: true, backlog: saved, item, message: `Added ${cardRef(item)} "${item.title}" to ${COLUMN_LABELS[item.column]}.` };
}

function unknownColumnMessage(value: unknown): string {
  return `Unknown column ${JSON.stringify(String(value ?? ""))}. Use one of: ${BACKLOG_COLUMNS.join(", ")}.`;
}

/**
 * Whether a card carries anything that would let a reader check the claim on it,
 * rather than take it on faith.
 *
 * Either half counts. A screenshot with no note is still a thing you can look
 * at; a note saying which command was run and what it printed is still evidence
 * for the large half of the work that has no pixels to capture. Requiring both
 * would only teach agents to write "see attached" next to every screenshot.
 */
export function hasEvidence(item: Pick<BacklogItem, "attachments" | "verificationNotes">): boolean {
  return Boolean(item.verificationNotes?.trim()) || (item.attachments?.length ?? 0) > 0;
}

/**
 * The board's one hard rule: an agent does not get to close its own work on its
 * say-so.
 *
 * This lives in code rather than in the system prompt because a prompt is
 * advice — a paragraph four thousand tokens up, competing with everything else
 * in the context — while this is a fact the write cannot get around. It is also
 * the only version of the rule that reaches every agent: Claude through
 * `backlog_update`, Codex through `panda-peers backlog done`, both landing on
 * this function.
 *
 * Applied only to the agent-side callers ({@link BacklogPatch.requireEvidence}).
 * The user closing a card in the app is the sign-off this rule exists to
 * protect, so gating them would be gating the wrong side.
 */
export function evidenceRequiredMessage(item: Pick<BacklogItem, "number">): string {
  return (
    `${cardRef(item)} can't go to Done without evidence. Move it to ${COLUMN_LABELS.review} instead, with ` +
    "`verificationNotes` saying what you actually checked (the command you ran and what it printed, the test output, what you did NOT check) " +
    "and any screenshot or recording attached. Done is the user's call once they have looked at it — if they have already told you to close it, " +
    "write the note first and it will go through."
  );
}

export function updateBacklogItem(
  backlog: WorkspaceBacklog,
  idOrTitle: string,
  patch: BacklogPatch,
  now = new Date().toISOString(),
): BacklogResult {
  const found = findBacklogItem(backlog, idOrTitle);
  if (!found) {
    return { ok: false, message: noSuchItemMessage(backlog, idOrTitle) };
  }

  let column = found.column;
  if (patch.column !== undefined) {
    const next = normalizeColumn(patch.column);
    if (!next) {
      return { ok: false, message: unknownColumnMessage(patch.column) };
    }
    column = next;
  }

  const title = patch.title === undefined ? found.title : cap(patch.title, TITLE_CAP);
  if (!title) {
    return { ok: false, message: "A backlog item needs a non-empty title." };
  }

  const withoutRemoved =
    patch.removeAttachmentIds && patch.removeAttachmentIds.length > 0
      ? (found.attachments ?? []).filter((attachment) => !patch.removeAttachmentIds?.includes(attachment.id))
      : (found.attachments ?? []);
  const adding = patch.addAttachments ?? [];
  if (withoutRemoved.length + adding.length > MAX_ATTACHMENTS) {
    return {
      ok: false,
      message: `${cardRef(found)} would hold ${withoutRemoved.length + adding.length} attachments — the cap is ${MAX_ATTACHMENTS}. Remove one first.`,
    };
  }
  const attachments = [...withoutRemoved, ...adding];

  const item: BacklogItem = {
    ...found,
    title,
    summary: patch.summary === undefined ? found.summary : capSummary(patch.summary),
    description: patch.description === undefined ? found.description : cap(patch.description, DESCRIPTION_CAP),
    metadata: patch.metadata === undefined ? found.metadata : cap(patch.metadata, METADATA_CAP),
    verificationNotes: patch.verificationNotes === undefined ? found.verificationNotes : cap(patch.verificationNotes, VERIFICATION_NOTES_CAP) || undefined,
    column,
    updatedAt: now,
    sections: patch.linkSection ? withSection(found.sections, patch.linkSection) : found.sections,
    onHold: patch.onHold === undefined ? found.onHold : patch.onHold === true ? true : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  // Checked against the card as it *would* be, not as it is: an agent that
  // attaches its screenshot and closes the card in one call has met the bar, and
  // failing it there would only teach it to make two calls.
  // Only the transition is gated — a card already in Done can still be edited,
  // or the rule would make its own history unfixable.
  if (patch.requireEvidence && item.column === "done" && found.column !== "done" && !hasEvidence(item)) {
    return { ok: false, message: evidenceRequiredMessage(found) };
  }

  const items = backlog.items.map((candidate) => (candidate.id === found.id ? item : candidate));
  const moved = column !== found.column ? ` Moved to ${COLUMN_LABELS[column]}.` : "";
  const held =
    patch.onHold === undefined || Boolean(found.onHold) === Boolean(item.onHold)
      ? ""
      : item.onHold
        ? ` Put on hold — it is off the board until it comes back.`
        : ` Off hold, back in ${COLUMN_LABELS[column]}.`;
  const attached = adding.length > 0 ? ` Attached ${adding.length} file${adding.length === 1 ? "" : "s"}.` : "";
  return {
    ok: true,
    backlog: withItems(backlog, items, now),
    item,
    message: `Updated ${cardRef(item)} "${item.title}".${moved}${held}${attached}`,
  };
}

/**
 * Reorder within a column, or move across one, at an explicit position.
 *
 * The UI's drag-and-drop needs the index; agents do not, and go through
 * {@link updateBacklogItem} with just a column. Both end up here in spirit — the
 * board's order is the array's order, so a move is a splice.
 */
export function moveBacklogItem(
  backlog: WorkspaceBacklog,
  id: string,
  column: BacklogColumn,
  /** Position among the items ALREADY in the target column, after removal. */
  index: number,
  now = new Date().toISOString(),
): BacklogResult {
  const found = backlog.items.find((item) => item.id === id);
  if (!found) {
    return { ok: false, message: noSuchItemMessage(backlog, id) };
  }

  const moved: BacklogItem = { ...found, column, updatedAt: now };
  const rest = backlog.items.filter((item) => item.id !== id);
  const target = rest.filter((item) => item.column === column);
  const clamped = Math.max(0, Math.min(Math.floor(index), target.length));
  // Anchor on the item currently occupying the slot, so the splice lands in the
  // right place in the flat array however the columns are interleaved in it.
  const anchor = target[clamped];
  const at = anchor ? rest.indexOf(anchor) : rest.length;

  const items = [...rest.slice(0, at), moved, ...rest.slice(at)];
  return { ok: true, backlog: withItems(backlog, items, now), item: moved, message: `Moved ${cardRef(moved)} "${moved.title}" to ${COLUMN_LABELS[column]}.` };
}

function withSection(sections: string[] | undefined, sectionId: string): string[] | undefined {
  const id = sectionId.trim();
  if (!id) {
    return sections;
  }
  const current = sections ?? [];
  if (current.includes(id)) {
    return current;
  }
  // Oldest link falls off rather than refusing the newest: the section asking to
  // be linked is the one on screen, and a cap is a guard against runaway
  // accumulation, not a queue the user is meant to manage.
  return [...current, id].slice(-MAX_LINKED_SECTIONS);
}

/** Record that a section is working on a card. Idempotent. */
export function linkBacklogSection(
  backlog: WorkspaceBacklog,
  idOrTitle: string,
  sectionId: string,
  now = new Date().toISOString(),
): BacklogResult {
  const found = findBacklogItem(backlog, idOrTitle);
  if (!found) {
    return { ok: false, message: noSuchItemMessage(backlog, idOrTitle) };
  }
  const sections = withSection(found.sections, sectionId);
  if (sections === found.sections) {
    return { ok: true, backlog, item: found, message: `"${found.title}" is already linked to that section.` };
  }

  const item: BacklogItem = { ...found, sections, updatedAt: now };
  const items = backlog.items.map((candidate) => (candidate.id === found.id ? item : candidate));
  return { ok: true, backlog: withItems(backlog, items, now), item, message: `Linked "${item.title}" to that section.` };
}

export function unlinkBacklogSection(
  backlog: WorkspaceBacklog,
  idOrTitle: string,
  sectionId: string,
  now = new Date().toISOString(),
): BacklogResult {
  const found = findBacklogItem(backlog, idOrTitle);
  if (!found) {
    return { ok: false, message: noSuchItemMessage(backlog, idOrTitle) };
  }
  const remaining = (found.sections ?? []).filter((id) => id !== sectionId);
  const item: BacklogItem = { ...found, sections: remaining.length > 0 ? remaining : undefined, updatedAt: now };
  const items = backlog.items.map((candidate) => (candidate.id === found.id ? item : candidate));
  return { ok: true, backlog: withItems(backlog, items, now), item, message: `Unlinked "${item.title}" from that section.` };
}

/** The cards a section is working on, in board order. */
export function itemsForSection(backlog: WorkspaceBacklog, sectionId: string): BacklogItem[] {
  if (!sectionId) {
    return [];
  }
  return backlog.items.filter((item) => item.sections?.includes(sectionId));
}

export function deleteBacklogItem(backlog: WorkspaceBacklog, idOrTitle: string, now = new Date().toISOString()): BacklogResult {
  const found = findBacklogItem(backlog, idOrTitle);
  if (!found) {
    return { ok: false, message: noSuchItemMessage(backlog, idOrTitle) };
  }

  const items = backlog.items.filter((item) => item.id !== found.id);
  return { ok: true, backlog: withItems(backlog, items, now), item: found, message: `Deleted ${cardRef(found)} "${found.title}".` };
}

function noSuchItemMessage(backlog: WorkspaceBacklog, idOrTitle: string): string {
  return backlog.items.length === 0
    ? `No backlog item matches ${JSON.stringify(idOrTitle)} — this board is empty.`
    : `No backlog item matches ${JSON.stringify(idOrTitle)}. Call backlog_list to see the card numbers.`;
}

/**
 * Cards answer to their number first — `#12` or `12`, which is what the user
 * types and what a rendered board leads with. Ids are uuids, so nothing but a
 * copy-paste ever matches one exactly; a prefix or an unambiguous piece of the
 * title is the rest of what a caller has to hand.
 */
export function findBacklogItem(backlog: WorkspaceBacklog, idOrTitle: string): BacklogItem | undefined {
  const needle = idOrTitle.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }

  // Falls through when no card carries that number, since an all-digit needle
  // can also be the start of a uuid.
  const number = parseCardRef(needle);
  const byNumber = number === null ? undefined : backlog.items.find((item) => item.number === number);
  if (byNumber) {
    return byNumber;
  }

  const exact = backlog.items.find((item) => item.id.toLowerCase() === needle);
  if (exact) {
    return exact;
  }

  const byPrefix = backlog.items.filter((item) => item.id.toLowerCase().startsWith(needle));
  if (byPrefix.length === 1) {
    return byPrefix[0];
  }

  const byTitle = backlog.items.filter((item) => item.title.toLowerCase().includes(needle));
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

/**
 * Everything in a column, held cards included.
 *
 * This is board order — positions, drop indices, the array a move splices into —
 * so it must not depend on what the reader happens to be showing. Use
 * {@link activeItemsInColumn} for "what is actually up for work".
 */
export function itemsInColumn(backlog: WorkspaceBacklog, column: BacklogColumn): BacklogItem[] {
  return backlog.items.filter((item) => item.column === column);
}

/** A column as it reads by default: parked cards left out. */
export function activeItemsInColumn(backlog: WorkspaceBacklog, column: BacklogColumn): BacklogItem[] {
  return backlog.items.filter((item) => item.column === column && !item.onHold);
}

/** Every parked card, in board order, whatever column it was parked from. */
export function onHoldItems(backlog: WorkspaceBacklog): BacklogItem[] {
  return backlog.items.filter((item) => item.onHold);
}

/**
 * The board as an agent reads it.
 *
 * Markdown rather than JSON: the reader is a language model that has to act on
 * it, and every card leads with the number it will need to name the card in the
 * next call — and that the user will type as `#12` in the composer.
 */
export function renderBacklog(backlog: WorkspaceBacklog, only?: BacklogColumn): string {
  const columns = only ? [only] : BACKLOG_COLUMNS;
  const lines: string[] = [`# Backlog — ${backlog.cwd}`];

  for (const column of columns) {
    const items = activeItemsInColumn(backlog, column);
    // Same rule the UI draws by: an empty Pending is not a fact worth a heading.
    // Asking for it explicitly (`only`) still shows it, so a caller checking
    // "is there anything to triage?" gets an answer rather than silence.
    if (items.length === 0 && !only && !isColumnVisible(column, items.length)) {
      continue;
    }
    lines.push("", `## ${COLUMN_LABELS[column]} (${items.length})`);
    if (items.length === 0) {
      lines.push("_empty_");
      continue;
    }
    if (column === "pending") {
      lines.push("_Filed by automation and not yet triaged — read before proposing these as work._");
    }
    for (const item of items) {
      lines.push(...renderBacklogItem(item));
    }
  }

  // Last, and separately: parked cards are still on the board and still findable
  // by number, but they are explicitly not what to pick up next — listing them
  // inside their columns would put them back in the running.
  const held = onHoldItems(backlog).filter((item) => !only || item.column === only);
  if (held.length > 0) {
    lines.push("", `## ${ON_HOLD_LABEL} (${held.length})`, "_Parked by the user — kept, but not to be worked on now._");
    for (const item of held) {
      lines.push(...renderBacklogItem(item));
    }
  }

  if (backlog.items.length === 0) {
    lines.push(
      "",
      "Nothing is on this board yet. Add items with `backlog_add` when the user describes work to do later — do not file the task you are already doing.",
    );
  }

  return lines.join("\n");
}

function renderBacklogItem(item: BacklogItem): string[] {
  // The column is named on a held card because its section heading no longer
  // says it, and coming off hold puts it back there.
  const lines = [`- \`${cardRef(item)}\` **${item.title}**${item.onHold ? ` _(on hold, from ${COLUMN_LABELS[item.column]})_` : ""}`];
  const by = item.createdBy === "agent" ? `agent${item.createdBySection ? ` (${item.createdBySection})` : ""}` : "user";
  lines.push(`  - filed by ${by} · updated ${item.updatedAt}`);
  if (item.summary) {
    lines.push(`  - TL;DR: ${item.summary}`);
  }
  if (item.description) {
    lines.push(`  - ${item.description.replace(/\n+/g, " ")}`);
  }
  if (item.metadata) {
    lines.push(`  - metadata: ${item.metadata.replace(/\n+/g, " ")}`);
  }
  if (item.verificationNotes) {
    lines.push(`  - verification: ${item.verificationNotes.replace(/\n+/g, " ")}`);
  }
  if (item.attachments?.length) {
    lines.push(`  - attachments: ${item.attachments.length} (${describeAttachments(item.attachments)})`);
  }
  // Section ids, not titles: they are what `read_session` takes, so an agent
  // that wants to know what was already tried on a card can go and read it.
  if (item.sections?.length) {
    lines.push(`  - sections: ${item.sections.join(", ")}`);
  }
  return lines;
}

/** "2 images, 1 video" — the summary line an agent sees before deciding whether to go read one. */
function describeAttachments(attachments: readonly BacklogAttachment[]): string {
  const images = attachments.filter((attachment) => attachment.kind === "image").length;
  const videos = attachments.filter((attachment) => attachment.kind === "video").length;
  const parts: string[] = [];
  if (images > 0) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  if (videos > 0) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * The composer text for "start a session from these cards".
 *
 * One card reads as the user typed it themselves — title, blank line, body — so
 * the common case gains no scaffolding. Several need a boundary, or the second
 * card's title reads as a line of the first one's description; a rule between
 * blocks is the least opinionated one available, and nothing here tells the
 * agent what to do with them. The user edits this before sending either way.
 */
export function backlogSessionPrompt(items: ReadonlyArray<{ title: string; description: string }>): string {
  return items
    .map((item) => (item.description.trim() ? `${item.title}\n\n${item.description.trim()}` : item.title))
    .join("\n\n---\n\n");
}

/** One card, in full, for the answer to a mutation. */
export function renderBacklogItemDetail(item: BacklogItem): string {
  return [
    `\`${cardRef(item)}\` **${item.title}** · ${COLUMN_LABELS[item.column]}${item.onHold ? ` · ${ON_HOLD_LABEL}` : ""}`,
    item.summary ? `\nTL;DR: ${item.summary}` : "",
    item.description ? `\n${item.description}` : "",
    item.metadata ? `\nmetadata: ${item.metadata}` : "",
    item.verificationNotes ? `\nverification: ${item.verificationNotes}` : "",
    item.attachments?.length
      ? `\nattachments:\n${item.attachments.map((attachment) => `- \`${attachment.id}\` ${attachment.kind} "${attachment.name}" — read ${attachment.path} to see it${attachment.caption ? `: ${attachment.caption}` : ""}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * File name for a workspace's board.
 *
 * Same encoding the Claude CLI uses for its project directories (every
 * non-alphanumeric character becomes "-"), so a board file can be matched to a
 * folder by eye. Collisions between two paths that differ only in punctuation
 * are possible in principle and have never mattered in practice; the file
 * carries its own `cwd` for anyone who needs to check.
 */
export function backlogFileName(cwd: string): string {
  return `${cwd.replace(/[^a-zA-Z0-9]/g, "-")}.json`;
}
