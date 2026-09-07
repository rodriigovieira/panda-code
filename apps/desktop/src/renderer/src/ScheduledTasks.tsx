import { Bot, Clock, Plus, Trash2, User, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { describeFrequency, emptySchedule, type ScheduleFrequency, type ScheduledTask, type WorkspaceSchedule } from "../../shared/schedule";
import type { DesktopApi } from "../../shared/ipc";

/**
 * The workspace's scheduled tasks: a flat list rather than the backlog's
 * columns, because a job's only two states worth showing at a glance are "due
 * X" and "off" — see `Backlog.tsx` for the sibling this is modeled on and the
 * round-trip-every-mutation rationale, which applies here unchanged.
 */

type Props = {
  cwd: string;
  workspaceName: string;
  desktopApi: DesktopApi;
  onClose: () => void;
};

type Editing = { mode: "edit"; item: ScheduledTask } | { mode: "create" } | null;

export function ScheduledTasksPanel({ cwd, workspaceName, desktopApi, onClose }: Props): ReactElement {
  const [schedule, setSchedule] = useState<WorkspaceSchedule>(() => emptySchedule(cwd));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void desktopApi
      .loadSchedule(cwd)
      .then((loaded) => {
        if (!cancelled) setSchedule(loaded);
      })
      .catch(() => {
        if (!cancelled) setError("Could not read this workspace's schedule.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, desktopApi]);

  // An agent's schedule_add, or the ticker firing a job, writes the file out of
  // process — this is how an open panel learns about it.
  useEffect(() => {
    return desktopApi.onScheduleChanged((event) => {
      if (event.cwd === cwd) {
        setSchedule(event.schedule);
      }
    });
  }, [cwd, desktopApi]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (editing) {
        setEditing(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onClose]);

  const mutate = useCallback(
    async (mutation: Parameters<DesktopApi["mutateSchedule"]>[0]): Promise<boolean> => {
      setError(null);
      try {
        const result = await desktopApi.mutateSchedule(mutation);
        if (!result.ok) {
          setError(result.message);
          return false;
        }
        setSchedule(result.schedule);
        return true;
      } catch {
        setError("The schedule could not be saved.");
        return false;
      }
    },
    [desktopApi],
  );

  return (
    <div className="backlog-backdrop" role="presentation" onClick={onClose}>
      <section
        className="schedule-board"
        role="dialog"
        aria-modal="true"
        aria-label={`Scheduled tasks for ${workspaceName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="backlog-head">
          <div className="backlog-title">
            <strong>Scheduled tasks</strong>
            <span title={cwd}>{workspaceName}</span>
          </div>
          <div className="backlog-head-actions">
            <span className="backlog-count">
              {schedule.items.length} task{schedule.items.length === 1 ? "" : "s"}
            </span>
            <button
              className="ghost-icon-button"
              type="button"
              aria-label="New scheduled task"
              title="New scheduled task"
              onClick={() => setEditing({ mode: "create" })}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
            <button className="ghost-icon-button" type="button" onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {error ? <div className="backlog-error">{error}</div> : null}

        <div className="schedule-list">
          {loading ? <div className="backlog-empty">Reading…</div> : null}
          {!loading && schedule.items.length === 0 ? (
            <div className="backlog-empty">
              Nothing scheduled. New tasks fire only while this Mac and Panda Code are running.
            </div>
          ) : null}

          {schedule.items.map((item) => (
            <article key={item.id} className="schedule-row" onClick={() => setEditing({ mode: "edit", item })}>
              <div className="schedule-row-main">
                <div className="schedule-row-title">{item.title}</div>
                <p className="schedule-row-prompt">{item.prompt}</p>
              </div>
              <div className="schedule-row-side">
                <span className={`schedule-cadence ${item.enabled ? "" : "is-disabled"}`}>
                  <Clock size={11} aria-hidden="true" />
                  {item.enabled ? describeFrequency(item.frequency) : "disabled"}
                </span>
                <span className={`backlog-author ${item.createdBy}`} title={authorTitle(item)}>
                  {item.createdBy === "agent" ? <Bot size={11} aria-hidden="true" /> : <User size={11} aria-hidden="true" />}
                  {item.createdBy === "agent" ? (item.createdBySection ?? "agent") : "you"}
                </span>
              </div>
            </article>
          ))}
        </div>

        {editing ? (
          <ScheduleEditor
            editing={editing}
            onCancel={() => setEditing(null)}
            onDelete={
              editing.mode === "edit"
                ? () => {
                    const { id } = editing.item;
                    setEditing(null);
                    void mutate({ op: "delete", cwd, id });
                  }
                : undefined
            }
            onSave={(draft) => {
              const saved =
                editing.mode === "edit"
                  ? mutate({
                      op: "update",
                      cwd,
                      id: editing.item.id,
                      title: draft.title,
                      prompt: draft.prompt,
                      frequency: draft.frequency,
                      enabled: draft.enabled,
                    })
                  : mutate({ op: "add", cwd, title: draft.title, prompt: draft.prompt, frequency: draft.frequency });
              void saved.then((ok) => {
                if (ok) setEditing(null);
              });
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

function authorTitle(item: ScheduledTask): string {
  const who = item.createdBy === "agent" ? `agent${item.createdBySection ? ` · ${item.createdBySection}` : ""}` : "you";
  return `Scheduled by ${who} on ${new Date(item.createdAt).toLocaleString()}`;
}

type FrequencyKind = ScheduleFrequency["type"];

type Draft = { title: string; prompt: string; frequency: ScheduleFrequency; enabled: boolean };

function defaultFrequencyFor(kind: FrequencyKind, current?: ScheduleFrequency): ScheduleFrequency {
  switch (kind) {
    case "hourly":
      return { type: "hourly", everyHours: current?.type === "hourly" ? current.everyHours : 1 };
    case "daily":
      return { type: "daily", time: current?.type === "daily" ? current.time : "09:00" };
    case "once": {
      const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
      return { type: "once", at: current?.type === "once" ? current.at : inOneHour.toISOString() };
    }
  }
}

/** `datetime-local` wants naive local time with no `Z`/offset, to the minute. */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ScheduleEditor({
  editing,
  onSave,
  onCancel,
  onDelete,
}: {
  editing: NonNullable<Editing>;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
  onDelete?: () => void;
}): ReactElement {
  const initial: Draft =
    editing.mode === "edit"
      ? { title: editing.item.title, prompt: editing.item.prompt, frequency: editing.item.frequency, enabled: editing.item.enabled }
      : { title: "", prompt: "", frequency: { type: "daily", time: "09:00" }, enabled: true };

  const [draft, setDraft] = useState<Draft>(initial);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  const submit = (): void => {
    if (draft.title.trim() && draft.prompt.trim()) {
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
        <input
          ref={titleRef}
          className="backlog-input"
          placeholder="Title"
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
        <textarea
          className="backlog-input backlog-textarea"
          placeholder="Prompt — the instruction the new section opens with"
          rows={4}
          value={draft.prompt}
          onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="schedule-frequency-row">
          <select
            className="backlog-input backlog-select"
            value={draft.frequency.type}
            onChange={(event) => setDraft({ ...draft, frequency: defaultFrequencyFor(event.target.value as FrequencyKind, draft.frequency) })}
            aria-label="Frequency"
          >
            <option value="hourly">Every N hours</option>
            <option value="daily">Daily at</option>
            <option value="once">Once at</option>
          </select>

          {draft.frequency.type === "hourly" ? (
            <input
              className="backlog-input schedule-frequency-input"
              type="number"
              min={1}
              max={24 * 7}
              value={draft.frequency.everyHours}
              onChange={(event) =>
                setDraft({ ...draft, frequency: { type: "hourly", everyHours: Math.max(1, Math.floor(Number(event.target.value) || 1)) } })
              }
              aria-label="Hours between runs"
            />
          ) : null}

          {draft.frequency.type === "daily" ? (
            <input
              className="backlog-input schedule-frequency-input"
              type="time"
              value={draft.frequency.time}
              onChange={(event) => setDraft({ ...draft, frequency: { type: "daily", time: event.target.value } })}
              aria-label="Time of day"
            />
          ) : null}

          {draft.frequency.type === "once" ? (
            <input
              className="backlog-input schedule-frequency-input"
              type="datetime-local"
              value={toLocalInputValue(draft.frequency.at)}
              onChange={(event) => {
                const value = event.target.value;
                if (!value) return;
                setDraft({ ...draft, frequency: { type: "once", at: new Date(value).toISOString() } });
              }}
              aria-label="Date and time"
            />
          ) : null}
        </div>

        <label className="schedule-enabled-toggle">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
          Enabled
        </label>

        <div className="backlog-editor-actions">
          <div />
          <div className="backlog-editor-buttons">
            {onDelete ? (
              <button className="quiet-action" type="button" onClick={onDelete}>
                <Trash2 size={14} aria-hidden="true" />
                Delete
              </button>
            ) : null}
            <button className="quiet-action" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="primary-action" type="submit" disabled={!draft.title.trim() || !draft.prompt.trim()}>
              {editing.mode === "edit" ? "Save" : "Schedule"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
