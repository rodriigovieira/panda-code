import { ArrowRight, Bot, Camera, Check, MessageSquare, Pause, Pencil, Play, Plus, Rocket, Trash2, User, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  activeItemsInColumn,
  BACKLOG_COLUMNS,
  cardRef,
  COLUMN_LABELS,
  emptyBacklog,
  findBacklogItem,
  isColumnVisible,
  itemsInColumn,
  ON_HOLD_LABEL,
  onHoldItems,
  type BacklogColumn,
  type BacklogItem,
  type WorkspaceBacklog,
} from "../../shared/backlog";
import type { DesktopApi } from "../../shared/ipc";
import { TaskDetail, type LinkedSection } from "./Task";

/**
 * The workspace board: drag to move, click a card to open it. Pending is drawn
 * only when it has something in it, so most boards read as three columns.
 *
 * The card itself is `Task.tsx` — the board shows it over the columns, and a
 * transcript link shows the same view over the app.
 *
 * Its own module rather than another thousand lines of App.tsx, because nothing
 * here touches sections: it opens on a `cwd`, talks to the backlog IPC, and the
 * app only has to know how to show and hide it.
 *
 * Every mutation is a round trip. The board is shared with agents writing to the
 * same file from their own processes, so local optimistic state would be a
 * second opinion about what is on it — and the whole point of the board is that
 * there is only one.
 */

type Props = {
  cwd: string;
  workspaceName: string;
  desktopApi: DesktopApi;
  onClose: () => void;
  /**
   * Hands one or more cards' title + description to a new session's composer.
   * Cards that exist carry their id, so the section that comes out of them can
   * be linked back to them once it has one.
   */
  onCreateSession: (drafts: ReadonlyArray<{ id?: string; title: string; description: string }>) => void;
  /**
   * Card to scroll to and highlight when the board appears — set when the board
   * was opened from a card that was already on screen ("Open backlog" on a
   * task). Agents quote ids in their short form, so a prefix counts as a match.
   *
   * It highlights rather than re-opening the card: the user came *from* the
   * card and asked for the board, so putting the card back over the board would
   * hand them the thing they just left.
   */
  focusItemId?: string | null;
  /** Turns a card's linked section ids into rows it can name and open. */
  resolveSections: (ids: readonly string[]) => LinkedSection[];
  onOpenSection: (sectionId: string) => void;
};

/**
 * The card being read, or the blank one being composed for a column.
 *
 * The open card is held by id, not by value: agents write to this board from
 * their own processes, and a card captured at click time would go stale the
 * moment one did — with the user reading a description that had since changed.
 */
type Editing =
  | { mode: "edit"; id: string }
  | { mode: "create"; column: BacklogColumn }
  | null;

export function BacklogBoard({
  cwd,
  workspaceName,
  desktopApi,
  onClose,
  onCreateSession,
  focusItemId,
  resolveSections,
  onOpenSection,
}: Props): ReactElement {
  const [backlog, setBacklog] = useState<WorkspaceBacklog>(() => emptyBacklog(cwd));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Right-clicked card, and where to hang its menu. */
  const [menu, setMenu] = useState<{ item: BacklogItem; x: number; y: number } | null>(null);
  /**
   * Cards picked with ⌘- or ⌥-click, in the order they were picked — a session
   * started from several cards should read in the order the user assembled them,
   * not in board order.
   */
  const [selected, setSelected] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<{ column: BacklogColumn; index: number } | null>(null);
  /**
   * Whether parked cards are on screen. Off by default and not remembered: the
   * point of putting a card on hold is that the board stops showing it, so the
   * board a session opens on is the short one every time.
   */
  const [showOnHold, setShowOnHold] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
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
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, desktopApi]);

  // An agent filing an item writes the file from its own process, so the board
  // on screen learns about it the same way any other window would.
  useEffect(() => {
    return desktopApi.onBacklogChanged((event) => {
      if (event.cwd === cwd) {
        setBacklog(event.backlog);
      }
    });
  }, [cwd, desktopApi]);

  /** The card the user came in on, resolved from a possibly-short id. */
  const focusedId = useMemo(() => {
    if (!focusItemId) {
      return null;
    }
    // Same resolution the card view uses, so a board opened from a `#12` link
    // lands on the same card the link did.
    return findBacklogItem(backlog, focusItemId)?.id ?? null;
  }, [backlog, focusItemId]);

  // Scrolling to it once, not on every write: the board reloads itself whenever
  // an agent touches the file, and a board that yanked itself back to the same
  // card each time would be unusable while one is working.
  const scrolledTo = useRef<string | null>(null);
  const focusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!focusedId || scrolledTo.current === focusedId) {
      return;
    }
    scrolledTo.current = focusedId;
    focusedRef.current?.scrollIntoView({ block: "center" });
  }, [focusedId]);

  /** The open card, read live off the board rather than from the click. */
  const openItem = useMemo(
    () => (editing?.mode === "edit" ? backlog.items.find((item) => item.id === editing.id) : undefined),
    [backlog, editing],
  );

  // A card deleted from anywhere — this board, an agent, the phone — takes its
  // detail view with it rather than leaving a view of something that is gone.
  useEffect(() => {
    if (editing?.mode === "edit" && !openItem) {
      setEditing(null);
    }
  }, [editing, openItem]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      // Escape backs out one layer at a time: the card menu, the composer, the board.
      if (menu) {
        setMenu(null);
      } else if (editing) {
        setEditing(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, menu, onClose]);

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

  /** A column as this board is currently drawing it. */
  const visibleInColumn = useCallback(
    (column: BacklogColumn): BacklogItem[] => (showOnHold ? itemsInColumn(backlog, column) : activeItemsInColumn(backlog, column)),
    [backlog, showOnHold],
  );

  const handleDrop = useCallback(
    /** Where the card landed among the cards the user can *see*. */
    (column: BacklogColumn, visibleIndex: number): void => {
      const id = dragging;
      setDragging(null);
      setDropTarget(null);
      if (!id) {
        return;
      }
      // A move is a position in the whole column, and the column on screen can
      // be missing its parked cards — so the slot is translated through the card
      // that occupies it rather than passed as a number. The dragged card is
      // skipped on both sides, since a move is computed after it is lifted out.
      const rest = itemsInColumn(backlog, column).filter((item) => item.id !== id);
      const anchor = visibleInColumn(column)
        .slice(visibleIndex)
        .find((item) => item.id !== id);
      const index = anchor ? rest.findIndex((item) => item.id === anchor.id) : rest.length;
      void mutate({ op: "move", cwd, id, column, index });
    },
    [backlog, cwd, dragging, mutate, visibleInColumn],
  );

  // Cards that were deleted (by anyone, from anywhere) drop out of the
  // selection rather than being carried into a prompt as gaps.
  const selectedItems = useMemo(
    () => selected.map((id) => backlog.items.find((item) => item.id === id)).filter((item): item is BacklogItem => Boolean(item)),
    [backlog, selected],
  );

  const toggleSelected = useCallback((id: string): void => {
    setSelected((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));
  }, []);

  const startSession = useCallback(
    (items: ReadonlyArray<{ id?: string; title: string; description: string }>): void => {
      setMenu(null);
      setSelected([]);
      onCreateSession(items);
    },
    [onCreateSession],
  );

  const setHold = useCallback(
    (item: BacklogItem, onHold: boolean): void => {
      setMenu(null);
      void mutate({ op: "update", cwd, id: item.id, onHold });
    },
    [cwd, mutate],
  );

  // Column counts follow what the column shows: a "5" over four cards reads as a
  // bug, and the parked ones are counted on the toggle that reveals them.
  const counts = useMemo(
    () =>
      Object.fromEntries(BACKLOG_COLUMNS.map((column) => [column, visibleInColumn(column).length])) as Record<BacklogColumn, number>,
    [visibleInColumn],
  );

  const heldCount = useMemo(() => onHoldItems(backlog).length, [backlog]);

  // Pending is drawn only while it holds something to triage — see
  // COLUMNS_HIDDEN_WHEN_EMPTY. Derived from the same counts the headers show, so
  // a column can never render with a "0" over it.
  const shownColumns = useMemo(
    () => BACKLOG_COLUMNS.filter((column) => isColumnVisible(column, counts[column])),
    [counts],
  );

  return (
    <div className="backlog-backdrop" role="presentation" onClick={onClose}>
      <section
        className="backlog-board"
        role="dialog"
        aria-modal="true"
        aria-label={`Backlog for ${workspaceName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="backlog-head">
          <div className="backlog-title">
            <strong>Backlog</strong>
            <span title={cwd}>{workspaceName}</span>
          </div>
          <div className="backlog-head-actions">
            {/* Only when there is something behind it: a switch that reveals
                nothing is a question the user has to answer every time. */}
            {heldCount > 0 ? (
              <button
                className={`quiet-action ${showOnHold ? "active" : ""}`}
                type="button"
                aria-pressed={showOnHold}
                title={showOnHold ? "Hide cards that are on hold" : `Show the ${heldCount} card${heldCount === 1 ? "" : "s"} on hold`}
                onClick={() => setShowOnHold((current) => !current)}
              >
                <Pause size={13} aria-hidden="true" />
                {ON_HOLD_LABEL}
                <span className="backlog-head-badge">{heldCount}</span>
              </button>
            ) : null}
            {selectedItems.length > 0 ? (
              <>
                <span className="backlog-count">{selectedItems.length} selected</span>
                <button className="quiet-action" type="button" onClick={() => startSession(selectedItems)}>
                  <Rocket size={14} aria-hidden="true" />
                  Start session
                </button>
                <button className="quiet-action" type="button" onClick={() => setSelected([])}>
                  Clear
                </button>
              </>
            ) : (
              <span className="backlog-count">
                {backlog.items.length} item{backlog.items.length === 1 ? "" : "s"}
              </span>
            )}
            <button className="ghost-icon-button" type="button" onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {error ? <div className="backlog-error">{error}</div> : null}

        <div className="backlog-columns">
          {shownColumns.map((column) => {
            const items = visibleInColumn(column);
            return (
              <div
                key={column}
                className={`backlog-column ${dropTarget?.column === column ? "is-drop-target" : ""}`}
                onDragOver={(event) => {
                  if (!dragging) return;
                  event.preventDefault();
                  setDropTarget({ column, index: items.length });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  handleDrop(column, dropTarget?.column === column ? dropTarget.index : items.length);
                }}
              >
                <div className="backlog-column-head">
                  <span>{COLUMN_LABELS[column]}</span>
                  <em>{counts[column]}</em>
                  <button
                    className="ghost-icon-button"
                    type="button"
                    aria-label={`Add to ${COLUMN_LABELS[column]}`}
                    title={`Add to ${COLUMN_LABELS[column]}`}
                    onClick={() => setEditing({ mode: "create", column })}
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>
                </div>

                <div className="backlog-column-body">
                  {loading ? <div className="backlog-empty">Reading…</div> : null}
                  {!loading && items.length === 0 ? (
                    <div className="backlog-empty">{emptyColumnNote(backlog, column, showOnHold)}</div>
                  ) : null}

                  {items.map((item, index) => (
                    <article
                      key={item.id}
                      ref={(node) => {
                        if (item.id === focusedId) {
                          focusedRef.current = node;
                        }
                      }}
                      className={`backlog-card ${dragging === item.id ? "is-dragging" : ""} ${
                        selected.includes(item.id) ? "is-selected" : ""
                      } ${item.id === focusedId ? "is-focused" : ""} ${item.onHold ? "is-on-hold" : ""}`}
                      aria-selected={selected.includes(item.id)}
                      draggable
                      onDragStart={() => setDragging(item.id)}
                      onDragEnd={() => {
                        setDragging(null);
                        setDropTarget(null);
                      }}
                      onDragOver={(event) => {
                        if (!dragging) return;
                        event.preventDefault();
                        event.stopPropagation();
                        // Above the midpoint means "before this card"; below it,
                        // after — the ordering people expect from a kanban.
                        const box = event.currentTarget.getBoundingClientRect();
                        const after = event.clientY > box.top + box.height / 2;
                        setDropTarget({ column, index: after ? index + 1 : index });
                      }}
                      // ⌘- or ⌥-click picks cards instead of opening one, so a
                      // session can be started from several at once. A plain
                      // click on a card while a selection is up would otherwise
                      // silently discard it, so it clears the selection too.
                      onClick={(event) => {
                        if (event.metaKey || event.altKey || event.ctrlKey) {
                          toggleSelected(item.id);
                          return;
                        }
                        setSelected([]);
                        setEditing({ mode: "edit", id: item.id });
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMenu({ item, x: event.clientX, y: event.clientY });
                      }}
                    >
                      {/* Title, and the TL;DR when there is one. A *description*
                          preview made every card as tall as its longest
                          paragraph; the summary is one capped line by
                          construction, which is the whole reason it exists. */}
                      <div className="backlog-card-title" title={item.description || undefined}>
                        {/* The number leads, the way it does on the rendered
                            board an agent reads: it is what the user types into
                            the composer to point at this card. */}
                        <span className="backlog-card-number">{cardRef(item)}</span>
                        {item.title}
                      </div>
                      {item.summary ? <p className="backlog-card-summary">{item.summary}</p> : null}
                      <footer className="backlog-card-foot">
                        {/* Leads the footer: it is the reason this card is on
                            screen at all, and the reason it usually is not. */}
                        {item.onHold ? (
                          <span className="backlog-hold-chip" title="On hold — hidden from the board until it comes back">
                            <Pause size={10} aria-hidden="true" />
                            {ON_HOLD_LABEL}
                          </span>
                        ) : null}
                        <span className={`backlog-author ${item.createdBy}`} title={authorTitle(item)}>
                          {item.createdBy === "agent" ? <Bot size={11} aria-hidden="true" /> : <User size={11} aria-hidden="true" />}
                          <span className="backlog-author-name">
                            {item.createdBy === "agent" ? (item.createdBySection ?? "agent") : "you"}
                          </span>
                        </span>
                        {item.metadata ? <span className="backlog-meta">{item.metadata}</span> : null}
                        {/* Proof pinned to the card — a screenshot or a
                            recording. The count alone here too; the gallery is
                            the card's own view. */}
                        {item.attachments?.length ? (
                          <span
                            className="backlog-attachments"
                            title={`${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}`}
                          >
                            <Camera size={11} aria-hidden="true" />
                            {item.attachments.length}
                          </span>
                        ) : null}
                        {/* Sections working on it. The count alone: the titles
                            belong on the card's own view, where there is room
                            to read them. */}
                        {item.sections?.length ? (
                          <span
                            className="backlog-sections"
                            title={`${item.sections.length} section${item.sections.length === 1 ? "" : "s"} linked to this task`}
                          >
                            <MessageSquare size={11} aria-hidden="true" />
                            {item.sections.length}
                          </span>
                        ) : null}
                      </footer>
                    </article>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {menu ? (
          <>
            {/* The board's own backdrop closes the board, so the menu needs its
                own dismiss layer or the first click outside it would take the
                whole board with it. */}
            <div
              className="menu-shield"
              role="presentation"
              onClick={() => setMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu(null);
              }}
            />
            <div className="context-menu" style={cardMenuPosition(menu.x, menu.y)} role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setEditing({ mode: "edit", id: menu.item.id });
                  setMenu(null);
                }}
              >
                <Pencil size={14} aria-hidden="true" />
                Open
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  toggleSelected(menu.item.id);
                  setMenu(null);
                }}
              >
                <Check size={14} aria-hidden="true" />
                {selected.includes(menu.item.id) ? "Deselect" : "Select"}
              </button>
              <button
                type="button"
                role="menuitem"
                // Right-clicking a card that is part of a selection acts on the
                // whole selection; right-clicking any other card acts on it
                // alone, the way Finder treats a click outside the selection.
                onClick={() => startSession(selected.includes(menu.item.id) ? selectedItems : [menu.item])}
              >
                <Rocket size={14} aria-hidden="true" />
                {selected.includes(menu.item.id) && selectedItems.length > 1
                  ? `Start session from ${selectedItems.length} cards`
                  : "Start session"}
              </button>
              <div className="context-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => setHold(menu.item, !menu.item.onHold)}>
                {menu.item.onHold ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                {menu.item.onHold ? `Take off hold` : `Put on hold`}
              </button>
              {BACKLOG_COLUMNS.filter((column) => column !== menu.item.column).map((column) => (
                <button
                  key={column}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const { id } = menu.item;
                    const index = itemsInColumn(backlog, column).length;
                    setMenu(null);
                    void mutate({ op: "move", cwd, id, column, index });
                  }}
                >
                  <ArrowRight size={14} aria-hidden="true" />
                  Move to {COLUMN_LABELS[column]}
                </button>
              ))}
              <div className="context-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  const { id } = menu.item;
                  setMenu(null);
                  void mutate({ op: "delete", cwd, id });
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                Delete
              </button>
            </div>
          </>
        ) : null}

        {/* Reading a card and filing one are different jobs with different
            shapes: the detail view edits a card that already exists, field by
            field, while a new card is a form you fill in and submit. */}
        {openItem ? (
          <div className="task-backdrop is-inset" role="presentation" onClick={() => setEditing(null)}>
            <TaskDetail
              item={openItem}
              cwd={cwd}
              workspaceName={workspaceName}
              sections={resolveSections(openItem.sections ?? [])}
              onPatch={(patch) => void mutate({ op: "update", cwd, id: openItem.id, ...patch })}
              onClose={() => setEditing(null)}
              onDelete={() => {
                setEditing(null);
                void mutate({ op: "delete", cwd, id: openItem.id });
              }}
              onStartSession={() => startSession([openItem])}
              onOpenSection={onOpenSection}
              onUnlinkSection={(sectionId) => void mutate({ op: "unlink", cwd, id: openItem.id, sectionId })}
            />
          </div>
        ) : null}

        {editing?.mode === "create" ? (
          <CardEditor
            column={editing.column}
            onCancel={() => setEditing(null)}
            onCreateSession={(draft) => {
              setEditing(null);
              startSession([draft]);
            }}
            onSave={(draft) => {
              void mutate({ op: "add", cwd, ...draft }).then((ok) => {
                if (ok) {
                  setEditing(null);
                }
              });
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

/** Keeps a card menu opened near an edge inside the window. Seven items + rules. */
function cardMenuPosition(x: number, y: number): { left: number; top: number } {
  const width = 220;
  const height = 288;
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
}

/**
 * What an empty column says. A column whose cards are all parked is not the same
 * as an empty one, and the difference is exactly what the user is deciding
 * about when they look at it.
 */
function emptyColumnNote(backlog: WorkspaceBacklog, column: BacklogColumn, showOnHold: boolean): string {
  const held = showOnHold ? 0 : onHoldItems(backlog).filter((item) => item.column === column).length;
  if (held === 0) {
    return "Nothing here.";
  }
  return `Nothing here — ${held} on hold.`;
}

function authorTitle(item: BacklogItem): string {
  const who = item.createdBy === "agent" ? `agent${item.createdBySection ? ` · ${item.createdBySection}` : ""}` : "you";
  return `Filed by ${who} on ${new Date(item.createdAt).toLocaleString()}`;
}

type Draft = { title: string; summary: string; description: string; metadata: string; column: BacklogColumn };

/** The blank-card form. Existing cards are read and edited in {@link TaskDetail}. */
function CardEditor({
  column,
  onSave,
  onCancel,
  onCreateSession,
}: {
  column: BacklogColumn;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
  onCreateSession: (draft: Draft) => void;
}): ReactElement {
  const [draft, setDraft] = useState<Draft>({ title: "", summary: "", description: "", metadata: "", column });
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  const submit = (): void => {
    if (draft.title.trim()) {
      onSave(draft);
    }
  };

  return (
    <div className="backlog-editor-backdrop" role="presentation" onClick={onCancel}>
      <form
        className="backlog-editor"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="backlog-field">
          <label className="backlog-field-label" htmlFor="backlog-field-title">
            Title
          </label>
          <input
            id="backlog-field-title"
            ref={titleRef}
            className="backlog-input"
            placeholder="Title"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </div>
        <div className="backlog-field">
          <label className="backlog-field-label" htmlFor="backlog-field-summary">
            Summary
          </label>
          <input
            id="backlog-field-summary"
            className="backlog-input"
            placeholder="One line: what this is, in short"
            value={draft.summary}
            onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
          />
        </div>
        <div className="backlog-field">
          <label className="backlog-field-label" htmlFor="backlog-field-description">
            Description
          </label>
          <textarea
            id="backlog-field-description"
            className="backlog-input backlog-textarea"
            placeholder="Add more detail — Markdown works here…"
            rows={6}
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            // Cmd/Ctrl+Enter saves from anywhere in the form, since a textarea
            // takes plain Enter for its own newlines.
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div className="backlog-field">
          <label className="backlog-field-label" htmlFor="backlog-field-metadata">
            Metadata
          </label>
          <input
            id="backlog-field-metadata"
            className="backlog-input"
            placeholder="Labels, estimate, links — anything"
            value={draft.metadata}
            onChange={(event) => setDraft({ ...draft, metadata: event.target.value })}
          />
        </div>

        <div className="backlog-editor-actions">
          <select
            className="backlog-input backlog-select"
            value={draft.column}
            onChange={(event) => setDraft({ ...draft, column: event.target.value as BacklogColumn })}
            aria-label="Column"
          >
            {BACKLOG_COLUMNS.map((column) => (
              <option key={column} value={column}>
                {COLUMN_LABELS[column]}
              </option>
            ))}
          </select>
          <div className="backlog-editor-buttons">
            <button
              className="quiet-action"
              type="button"
              disabled={!draft.title.trim()}
              onClick={() => onCreateSession(draft)}
            >
              <Rocket size={14} aria-hidden="true" />
              Start session
            </button>
            <button className="quiet-action" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="primary-action" type="submit" disabled={!draft.title.trim()}>
              Add
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
