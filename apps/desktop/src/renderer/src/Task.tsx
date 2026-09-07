import { Bot, ExternalLink, Kanban, Link2, MessageSquare, Pause, Play, Rocket, Trash2, User, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { FormattedBody } from "./FormattedBody";
import { localFileUrl } from "./media";
import { VideoPlayer } from "./videoPlayer";
import {
  BACKLOG_COLUMNS,
  cardRef,
  COLUMN_LABELS,
  emptyBacklog,
  findBacklogItem,
  itemsForSection,
  ON_HOLD_LABEL,
  type BacklogAttachment,
  type BacklogColumn,
  type BacklogItem,
  type WorkspaceBacklog,
} from "../../shared/backlog";
import type { DesktopApi } from "../../shared/ipc";

/**
 * One backlog card, opened on its own.
 *
 * The board's editor used to be the only way to see a card: a 560px form with
 * three labelled inputs, which is a fine way to *file* a card and a poor way to
 * *read* one — a paragraph of description arrived as six cramped lines in a
 * textarea, and reading it meant scrolling a form field. This is the Linear
 * shape instead: the card gets the room, fields are text until you click them,
 * and a click turns the one you clicked into an input without a mode to leave.
 *
 * It is also the destination of a `panda://backlog/<id>` link. That used to
 * open the whole board with the card's editor stacked on top — three layers to
 * dismiss for what the link actually said, which was "look at this card". Now
 * the link opens just the card, and the board is one button away *when you came
 * from a link*: opening it from the board itself and offering to open the board
 * is a door onto the room you are standing in.
 *
 * Mutations round-trip through the store, like everywhere else the board is
 * touched — agents write to the same file, so the copy on disk is the only copy
 * worth rendering.
 */

/** A section a card is linked to, resolved against the live thread list. */
export type LinkedSection = {
  id: string;
  title: string;
  /** False once the thread is gone; the row explains itself rather than vanishing. */
  present: boolean;
};

export type TaskPatch = {
  title?: string;
  summary?: string;
  description?: string;
  metadata?: string;
  column?: BacklogColumn;
  /** Park the card, or bring it back. Its column is untouched either way. */
  onHold?: boolean;
  verificationNotes?: string;
  /** The board's own UI only ever drops an attachment — attaching a file is an agent's job, through the MCP tool. */
  removeAttachmentIds?: string[];
};

type DetailProps = {
  item: BacklogItem;
  workspaceName: string;
  cwd: string;
  sections: readonly LinkedSection[];
  onPatch: (patch: TaskPatch) => void;
  onClose: () => void;
  onDelete: () => void;
  onStartSession: () => void;
  onOpenSection: (sectionId: string) => void;
  onUnlinkSection: (sectionId: string) => void;
  /**
   * Present only when the card was reached from somewhere other than the board —
   * a transcript link, or a section's task list. Absent when the board is
   * already open behind it.
   */
  onOpenBoard?: () => void;
  error?: string | null;
};

export function TaskDetail({
  item,
  workspaceName,
  cwd,
  sections,
  onPatch,
  onClose,
  onDelete,
  onStartSession,
  onOpenSection,
  onUnlinkSection,
  onOpenBoard,
  error,
}: DetailProps): ReactElement {
  const [preview, setPreview] = useState<BacklogAttachment | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const attachments = item.attachments ?? [];

  // Opening a second card reuses this DOM, so without a reset it opens halfway
  // down whatever the last card was scrolled to — and the region that scrolls
  // out from under the old content is exactly where stale paint shows up.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [item.id]);

  // Capture phase, ahead of the overlay's own Escape listener (which closes
  // the whole card): without this, closing the lightbox and closing the card
  // race, and the card usually loses.
  useEffect(() => {
    if (!preview) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setPreview(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preview]);

  // The attachment being previewed can vanish from under it — removed here, or
  // by an agent in another section — in which case there is nothing left to show.
  useEffect(() => {
    if (preview && !attachments.some((candidate) => candidate.id === preview.id)) {
      setPreview(null);
    }
  }, [attachments, preview]);

  return (
    <section
      className="task-detail"
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="task-head">
        <div className="task-breadcrumb">
          <Kanban size={13} aria-hidden="true" />
          <span title={cwd}>{workspaceName}</span>
          <span className="task-breadcrumb-sep" aria-hidden="true">
            ›
          </span>
          <span>{COLUMN_LABELS[item.column]}</span>
          <code title={item.id}>{cardRef(item)}</code>
          {/* Said in the breadcrumb as well as the sidebar: a card reached from
              a link opens with no board behind it to explain why it is parked. */}
          {item.onHold ? (
            <span className="backlog-hold-chip" title="On hold — hidden from the board until it comes back">
              <Pause size={10} aria-hidden="true" />
              {ON_HOLD_LABEL}
            </span>
          ) : null}
        </div>
        <div className="task-head-actions">
          {onOpenBoard ? (
            <button className="quiet-action" type="button" onClick={onOpenBoard} title="Show this card on the board">
              <ExternalLink size={14} aria-hidden="true" />
              Open backlog
            </button>
          ) : null}
          <button className="quiet-action" type="button" onClick={onStartSession} title="Start a section from this task">
            <Rocket size={14} aria-hidden="true" />
            Start session
          </button>
          <button className="ghost-icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {error ? <div className="backlog-error">{error}</div> : null}

      <div className="task-body">
        <div className="task-main" ref={mainRef}>
          <InlineField
            value={item.title}
            multiline={false}
            className="task-title"
            placeholder="Untitled"
            ariaLabel="Title"
            // A card with no title cannot be saved, and clearing the field is
            // much more likely to be a slip than a wish, so it reverts.
            onCommit={(next) => (next.trim() ? onPatch({ title: next.trim() }) : undefined)}
          />

          {/* The TL;DR sits between the title and the body because that is the
              order it is read in: one line that says what this is, then the
              detail for whoever needs it. Agents write it with every edit. */}
          <InlineField
            value={item.summary}
            multiline={false}
            className="task-summary"
            placeholder="Add a one-line summary…"
            ariaLabel="Summary"
            onCommit={(next) => onPatch({ summary: next.trim() })}
          />

          {/* Evidence sits above the description, not at the foot of the card
              under the verification notes where it used to live. A card's
              attachments are the fastest possible answer to "did this actually
              work?" — burying them under several screens of prose meant
              scrolling past the whole description to find out, and put the
              gallery in the middle of the text it was meant to support.
              Only shown when there is something to show: an empty "Evidence"
              heading on every card is a heading that stops being read. */}
          {attachments.length > 0 ? (
            <section className="task-evidence">
              <span className="task-main-label">Evidence</span>
              <ul className="task-attachment-grid">
                {attachments.map((attachment) => (
                  <li key={attachment.id} className="task-attachment-thumb-wrap">
                    <button
                      type="button"
                      className="task-attachment-thumb"
                      onClick={() => setPreview(attachment)}
                      title={attachment.caption ?? attachment.name}
                    >
                      {attachment.kind === "image" ? (
                        <img src={localFileUrl(attachment.path)} alt={attachment.caption ?? attachment.name} />
                      ) : (
                        // `#t=0.1` seeks just past the start so the tile shows a
                        // frame; `preload="metadata"` alone paints grey.
                        <video src={`${localFileUrl(attachment.path)}#t=0.1`} muted playsInline preload="metadata" />
                      )}
                      {attachment.kind === "video" ? (
                        <span className="task-attachment-play" aria-hidden="true">
                          <Play size={16} fill="currentColor" />
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="task-attachment-remove"
                      aria-label={`Remove ${attachment.name}`}
                      title="Remove"
                      onClick={() => onPatch({ removeAttachmentIds: [attachment.id] })}
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Markdown in, Markdown rendered — agents write headings and lists
              here, and the raw source only shows while you are editing it. */}
          <InlineField
            value={item.description}
            multiline
            className="task-description"
            placeholder="Add a description…"
            ariaLabel="Description"
            renderValue={(value) => <FormattedBody value={value} />}
            onCommit={(next) => onPatch({ description: next })}
          />

          {/* What was actually checked before calling this done, and the proof of
              it — separate from the description because a card can describe work
              precisely and still not say what verified it. Always shown, like
              every other field here: empty is a placeholder, not a hidden block. */}
          <div className="task-verification">
            <span className="task-main-label">Verification</span>
            <InlineField
              value={item.verificationNotes ?? ""}
              multiline
              className="task-verification-notes"
              placeholder="What did this prove, and what didn't it?"
              ariaLabel="Verification notes"
              renderValue={(value) => <FormattedBody value={value} />}
              onCommit={(next) => onPatch({ verificationNotes: next })}
            />
          </div>
        </div>

        <aside className="task-side">
          <div className="task-side-block">
            <span className="task-side-label">Status</span>
            <div className="task-status-picker" role="group" aria-label="Column">
              {/* Pending is offered only on a card already sitting in it. It is an
                  inbox automation writes to, so triage is a move *out* — and
                  dropping it keeps this row at four options, which is what it
                  fits: a fifth squeezes "In progress" to an ellipsis in a
                  sidebar this narrow. Same rule as the phone's picker. */}
              {BACKLOG_COLUMNS.filter((column) => column !== "pending" || item.column === "pending").map((column) => (
                <button
                  key={column}
                  type="button"
                  className={`task-status-option ${item.column === column ? "is-current" : ""}`}
                  aria-pressed={item.column === column}
                  onClick={() => (item.column === column ? undefined : onPatch({ column }))}
                >
                  {COLUMN_LABELS[column]}
                </button>
              ))}
            </div>
            {/* Under the columns rather than among them: holding a card is not a
                fourth stage of the work, it is a card set aside from whichever
                stage it is in — and it comes back to that same one. */}
            <button
              className={`task-hold-toggle ${item.onHold ? "is-held" : ""}`}
              type="button"
              aria-pressed={Boolean(item.onHold)}
              title={
                item.onHold
                  ? `Put it back in ${COLUMN_LABELS[item.column]}`
                  : "Keep it, but take it off the board until you want it back"
              }
              onClick={() => onPatch({ onHold: !item.onHold })}
            >
              {item.onHold ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
              {item.onHold ? "Take off hold" : "Put on hold"}
            </button>
          </div>

          <div className="task-side-block">
            <span className="task-side-label">Sections</span>
            {sections.length === 0 ? (
              <p className="task-side-empty">
                No section is working on this yet. Starting one from here links it.
              </p>
            ) : (
              <ul className="task-section-list">
                {sections.map((section) => (
                  <li key={section.id} className={`task-section-row ${section.present ? "" : "is-missing"}`}>
                    <button
                      type="button"
                      className="task-section-open"
                      disabled={!section.present}
                      title={section.present ? "Open this section" : "This section no longer exists"}
                      onClick={() => onOpenSection(section.id)}
                    >
                      <MessageSquare size={12} aria-hidden="true" />
                      <span>{section.title}</span>
                    </button>
                    <button
                      type="button"
                      className="task-section-unlink"
                      aria-label={`Unlink ${section.title}`}
                      title="Unlink"
                      onClick={() => onUnlinkSection(section.id)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="task-side-block">
            <span className="task-side-label">Metadata</span>
            {/* Multiline: agents write a paragraph of commit/file detail here,
                and a single-line input hands you 250px of it at a time. The
                closed state is capped and scrolls instead, so one long value
                cannot push Filed and Delete off the bottom of the sidebar. */}
            <InlineField
              value={item.metadata}
              multiline
              className="task-metadata"
              placeholder="Labels, estimate, links — anything"
              ariaLabel="Metadata"
              onCommit={(next) => onPatch({ metadata: next.trim() })}
            />
          </div>

          <div className="task-side-block">
            <span className="task-side-label">Filed</span>
            <span className={`backlog-author ${item.createdBy}`}>
              {item.createdBy === "agent" ? <Bot size={11} aria-hidden="true" /> : <User size={11} aria-hidden="true" />}
              {/* The section title can be a full sentence; the span is what
                  elides, since a flex container cannot elide bare text. */}
              <span className="backlog-author-name" title={item.createdBy === "agent" ? item.createdBySection : undefined}>
                {item.createdBy === "agent" ? (item.createdBySection ?? "agent") : "you"}
              </span>
            </span>
            <span className="task-side-note" title={new Date(item.createdAt).toLocaleString()}>
              {new Date(item.createdAt).toLocaleDateString()} · updated {new Date(item.updatedAt).toLocaleDateString()}
            </span>
          </div>

          <div className="task-side-block">
            <button className="quiet-action task-delete" type="button" onClick={onDelete}>
              <Trash2 size={14} aria-hidden="true" />
              Delete task
            </button>
          </div>
        </aside>
      </div>

      {preview ? (
        <div className="task-attachment-lightbox-backdrop" role="presentation" onClick={() => setPreview(null)}>
          <div
            className="task-attachment-lightbox-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={preview.caption ?? preview.name}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="task-attachment-lightbox-toolbar">
              <div>
                <strong>{preview.name}</strong>
                {preview.caption ? <span>{preview.caption}</span> : null}
              </div>
              <button className="ghost-icon-button" type="button" onClick={() => setPreview(null)} aria-label="Close">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            {preview.kind === "image" ? (
              <img alt={preview.caption ?? preview.name} src={localFileUrl(preview.path)} />
            ) : (
              <VideoPlayer src={localFileUrl(preview.path)} label={preview.caption ?? preview.name} />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Text that becomes an input when you click it.
 *
 * Committing on blur is what makes it feel like a document rather than a form:
 * clicking from the title into the description saves the title, the same way
 * every editor of this shape behaves. Escape reverts, because "I did not mean
 * that" needs an exit that does not travel through the save.
 */
function InlineField({
  value,
  multiline,
  className,
  placeholder,
  ariaLabel,
  renderValue,
  onCommit,
}: {
  value: string;
  multiline: boolean;
  className: string;
  placeholder: string;
  ariaLabel: string;
  /**
   * How the closed state draws the value. Given for the description, which is
   * Markdown: the editor still edits the source, and only the reading half is
   * formatted. Omitted elsewhere, where the value is already the text.
   */
  renderValue?: (value: string) => ReactNode;
  onCommit: (next: string) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // Set while committing so the blur that follows a keyboard save does not
  // commit a second time — harmless on disk, but it costs a round trip and can
  // resurrect the pre-edit value if the card changed underneath.
  const committedRef = useRef(false);

  // A write from anywhere else (an agent, the phone, another window) reaches the
  // field while it is closed; while it is open the user's draft wins.
  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [editing, value]);

  const begin = useCallback((): void => {
    committedRef.current = false;
    setDraft(value);
    setEditing(true);
  }, [value]);

  useEffect(() => {
    if (editing) {
      const node = inputRef.current;
      node?.focus();
      // Caret at the end rather than a select-all: this is an edit of existing
      // prose far more often than a replacement of it.
      node?.setSelectionRange(node.value.length, node.value.length);
    }
  }, [editing]);

  const commit = useCallback((): void => {
    if (committedRef.current) {
      return;
    }
    committedRef.current = true;
    setEditing(false);
    if (draft !== value) {
      onCommit(draft);
    }
  }, [draft, onCommit, value]);

  const cancel = useCallback((): void => {
    committedRef.current = true;
    setEditing(false);
    setDraft(value);
  }, [value]);

  if (!editing) {
    return (
      <div
        className={`inline-field ${className} ${value ? "" : "is-empty"} ${renderValue && value ? "is-rendered" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`${ariaLabel} — click to edit`}
        onClick={(event) => {
          // A rendered body can hold links — a `panda://backlog/…` card, a URL.
          // Clicking one means "follow this", not "let me rewrite the field it
          // happens to sit in", so the click is left to the anchor.
          if (event.target instanceof Element && event.target.closest("a")) {
            return;
          }
          begin();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            begin();
          }
        }}
      >
        {value ? (renderValue ? renderValue(value) : value) : placeholder}
      </div>
    );
  }

  const shared = {
    className: `inline-field-input ${className}`,
    value: draft,
    placeholder,
    "aria-label": ariaLabel,
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
      // Plain Enter saves a one-liner; a body needs it for newlines and takes
      // the modifier instead.
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commit();
      }
    },
  };

  return multiline ? (
    <textarea
      {...shared}
      ref={(node) => {
        inputRef.current = node;
      }}
      rows={Math.min(24, Math.max(6, draft.split("\n").length + 1))}
      onChange={(event) => setDraft(event.target.value)}
    />
  ) : (
    <input
      {...shared}
      ref={(node) => {
        inputRef.current = node;
      }}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

/**
 * One workspace's board, loaded and kept live.
 *
 * Shared by the task overlay and the section's task list so both see the same
 * board without either owning it, and so an agent's write shows up in both.
 */
export function useWorkspaceBacklog(
  cwd: string | null,
  desktopApi: DesktopApi,
): {
  backlog: WorkspaceBacklog;
  error: string | null;
  mutate: (mutation: Parameters<DesktopApi["mutateBacklog"]>[0]) => Promise<boolean>;
} {
  const [backlog, setBacklog] = useState<WorkspaceBacklog>(() => emptyBacklog(cwd ?? ""));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) {
      return;
    }
    let cancelled = false;
    // Blank first: this hook follows the section on screen, and the previous
    // workspace's cards must not sit under a new one's name while it loads.
    setBacklog(emptyBacklog(cwd));
    void desktopApi
      .loadBacklog(cwd)
      .then((loaded) => {
        if (!cancelled) {
          setBacklog(loaded);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not read this workspace's backlog.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, desktopApi]);

  useEffect(() => {
    if (!cwd) {
      return;
    }
    return desktopApi.onBacklogChanged((event) => {
      if (event.cwd === cwd) {
        setBacklog(event.backlog);
      }
    });
  }, [cwd, desktopApi]);

  const mutate = useCallback(
    async (mutation: Parameters<DesktopApi["mutateBacklog"]>[0]): Promise<boolean> => {
      setError(null);
      try {
        const result = await desktopApi.mutateBacklog(mutation);
        if (!result.ok) {
          setError(result.message);
          return false;
        }
        setBacklog(result.backlog);
        return true;
      } catch {
        setError("The backlog could not be saved.");
        return false;
      }
    },
    [desktopApi],
  );

  return { backlog, error, mutate };
}

type OverlayProps = {
  cwd: string;
  workspaceName: string;
  /** Full id or the short prefix an agent wrote in a transcript. */
  itemId: string;
  desktopApi: DesktopApi;
  resolveSections: (ids: readonly string[]) => LinkedSection[];
  onClose: () => void;
  onOpenBoard: () => void;
  onOpenSection: (sectionId: string) => void;
  onCreateSession: (item: BacklogItem) => void;
};

/**
 * The card on its own, over whatever the user was doing — the destination of a
 * transcript link and of a section's task list.
 */
export function TaskOverlay({
  cwd,
  workspaceName,
  itemId,
  desktopApi,
  resolveSections,
  onClose,
  onOpenBoard,
  onOpenSection,
  onCreateSession,
}: OverlayProps): ReactElement | null {
  const { backlog, error, mutate } = useWorkspaceBacklog(cwd, desktopApi);
  const item = useMemo(() => findBacklogItem(backlog, itemId), [backlog, itemId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sections = useMemo(() => resolveSections(item?.sections ?? []), [item, resolveSections]);

  if (!item) {
    // The board is still loading, or the link points at a card that has since
    // been deleted. Either way there is nothing to show and nothing to say that
    // would not flash on the way to showing it.
    return null;
  }

  return (
    <div className="task-backdrop" role="presentation" onClick={onClose}>
      <TaskDetail
        item={item}
        cwd={cwd}
        workspaceName={workspaceName}
        sections={sections}
        error={error}
        onPatch={(patch) => void mutate({ op: "update", cwd, id: item.id, ...patch })}
        onClose={onClose}
        onDelete={() => {
          onClose();
          void mutate({ op: "delete", cwd, id: item.id });
        }}
        onStartSession={() => onCreateSession(item)}
        onOpenSection={onOpenSection}
        onUnlinkSection={(sectionId) => void mutate({ op: "unlink", cwd, id: item.id, sectionId })}
        onOpenBoard={onOpenBoard}
      />
    </div>
  );
}

type SectionTasksProps = {
  cwd: string;
  sectionId: string;
  desktopApi: DesktopApi;
  onOpenTask: (itemId: string) => void;
};

/**
 * The topbar control that answers "what is this section for?".
 *
 * Silent when nothing is linked and nothing is on the board — a section opened
 * to try one command should not grow a task widget — but present as soon as
 * either is true, since linking is the only way a card gets attached to a
 * conversation the user started by typing.
 */
export function SectionTasks({ cwd, sectionId, desktopApi, onOpenTask }: SectionTasksProps): ReactElement | null {
  const { backlog, mutate } = useWorkspaceBacklog(cwd, desktopApi);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const linked = useMemo(() => itemsForSection(backlog, sectionId), [backlog, sectionId]);
  const linkable = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return backlog.items
      .filter((item) => !item.sections?.includes(sectionId))
      .filter((item) => !needle || item.title.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [backlog, query, sectionId]);

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  if (backlog.items.length === 0) {
    return null;
  }

  return (
    <div className="section-tasks-anchor">
      <button
        className={`quiet-action section-tasks-button ${open ? "active" : ""} ${linked.length > 0 ? "has-tasks" : ""}`}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        title={
          linked.length > 0
            ? `${linked.length} backlog task${linked.length === 1 ? "" : "s"} on this section`
            : "Link a backlog task to this section"
        }
      >
        <Kanban size={15} aria-hidden="true" />
        {linked.length > 0 ? <span>{linked.length}</span> : null}
      </button>

      {open ? (
        <>
          <div className="menu-shield" role="presentation" onClick={() => setOpen(false)} />
          <div className="section-tasks-popover" role="dialog" aria-label="Tasks on this section" onClick={(event) => event.stopPropagation()}>
            {linked.length > 0 ? (
              <ul className="section-tasks-list">
                {linked.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="section-tasks-row"
                      onClick={() => {
                        setOpen(false);
                        onOpenTask(item.id);
                      }}
                    >
                      <span className="section-tasks-row-title">{item.title}</span>
                      <span className={`section-tasks-row-column ${item.onHold ? "is-on-hold" : `is-${item.column}`}`}>
                        {item.onHold ? ON_HOLD_LABEL : COLUMN_LABELS[item.column]}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="task-section-unlink"
                      aria-label={`Unlink ${item.title}`}
                      title="Unlink from this section"
                      onClick={() => void mutate({ op: "unlink", cwd, id: item.id, sectionId })}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="section-tasks-empty">No backlog task is linked to this section.</p>
            )}

            <div className="section-tasks-link">
              <label className="task-side-label" htmlFor="section-tasks-search">
                Link a task
              </label>
              <input
                id="section-tasks-search"
                className="backlog-input"
                placeholder="Search this workspace's board…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {linkable.length === 0 ? (
                <p className="section-tasks-empty">Nothing else on the board matches.</p>
              ) : (
                <ul className="section-tasks-list">
                  {linkable.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="section-tasks-row"
                        onClick={() => {
                          void mutate({ op: "link", cwd, id: item.id, sectionId });
                          setQuery("");
                        }}
                      >
                        <Link2 size={12} aria-hidden="true" />
                        <span className="section-tasks-row-title">{item.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
