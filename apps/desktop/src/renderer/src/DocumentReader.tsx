import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  Minus,
  MoveHorizontal,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type { DesktopApi, TextFileContents } from "../../shared/ipc";
import { FormattedBody } from "./FormattedBody";
import { docFileName, isMarkdownPath } from "./documents";
import { MarkdownLiveEditor } from "./MarkdownLiveEditor";
import { MARKDOWN_HINTS } from "./markdownLive";

/**
 * The in-app reader: a Markdown file, rendered, without leaving the app.
 *
 * The app already renders Markdown in two places (a transcript, a backlog card)
 * through `FormattedBody`, and had nowhere to point it at a file — a README in
 * the file tree, or the report a section just wrote, meant a trip out to an
 * external editor that shows the source. Same parser, same CSS, so a document
 * looks the same here as an agent's message does.
 *
 * Rendered by default with Source and Edit toggles, because the three questions
 * ("what does this say", "what did the agent actually write", "fix this line")
 * are all real. A file with no Markdown to render — a log, a JSON blob — opens
 * on Source, since rendering it as prose would only reflow it wrongly.
 *
 * Edit writes through on a 500 ms idle timer: there is no Save button, the way
 * there is none in a notes app, and the toolbar says when the last write landed.
 */

/** How long the editor sits still before the file is written. */
const AUTOSAVE_DELAY_MS = 500;

const FONT_SIZE_KEY = "panda-code.docFontSize";
/** Roomier than the transcript's 14px: this is a document, read at length. */
const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 26;

function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}

/* The measure — how wide a line of prose is allowed to get. Typography's rule
   of thumb is 45-90 characters; the dialog is wide enough to blow past that, so
   the column is squeezed independently of the window and remembered. */
const MEASURE_KEY = "panda-code.docMeasure";
const DEFAULT_MEASURE = 760;
const MIN_MEASURE = 420;
const MAX_MEASURE = 900;

function clampMeasure(width: number): number {
  return Math.min(MAX_MEASURE, Math.max(MIN_MEASURE, Math.round(width)));
}

// Guarded because the view tests render this to static markup in Node, where
// there is no storage — the app itself always has one.
function storedFontSize(): number {
  if (typeof localStorage === "undefined") return DEFAULT_FONT_SIZE;
  const raw = Number.parseFloat(localStorage.getItem(FONT_SIZE_KEY) ?? "");
  return Number.isFinite(raw) ? clampFontSize(raw) : DEFAULT_FONT_SIZE;
}

function rememberFontSize(size: number): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(FONT_SIZE_KEY, String(size));
}

function storedMeasure(): number {
  if (typeof localStorage === "undefined") return DEFAULT_MEASURE;
  const raw = Number.parseFloat(localStorage.getItem(MEASURE_KEY) ?? "");
  return Number.isFinite(raw) ? clampMeasure(raw) : DEFAULT_MEASURE;
}

type Mode = "rendered" | "source" | "edit";

function savedLabel(at: number): string {
  return `Saved ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

export function DocumentReader({
  path,
  text,
  title,
  desktopApi,
  editorName,
  onOpenInEditor,
  onReveal,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  onClose,
}: {
  /** The file being read. Omitted when the reader was opened on `text`. */
  path?: string;
  /** Markdown the app already holds — an agent's reply — with no file behind it. */
  text?: string;
  title?: string;
  desktopApi: DesktopApi;
  editorName?: string;
  onOpenInEditor: (path: string) => void;
  onReveal: (path: string) => void;
  /** The reader's history, kept by the app: opening a document stacks it. */
  onBack?: () => void;
  onForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onClose: () => void;
}): ReactElement {
  // A scratch document: nothing to read, nothing to write, and no file actions.
  // Edits live in this component only, which the footer says out loud.
  const scratch = text !== undefined;
  const filePath = path ?? "";
  const [file, setFile] = useState<TextFileContents | null>(
    scratch ? { path: "", name: title ?? "Message", content: text ?? "", size: (text ?? "").length, truncated: false } : null,
  );
  const [loading, setLoading] = useState(!scratch);
  const [mode, setMode] = useState<Mode>(scratch || isMarkdownPath(filePath) ? "rendered" : "source");
  const [copied, setCopied] = useState(false);
  const [fontSize, setFontSize] = useState<number>(storedFontSize);
  const [measure, setMeasure] = useState<number>(storedMeasure);
  const [draft, setDraft] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The autosave's own state, off the render path: what is waiting to be
  // written, the idle timer, and what is already on disk.
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const savedContentRef = useRef<string>("");

  // Returns its own cancel, so the effect can drop a read that a path change
  // has already made irrelevant. The Reload button ignores it.
  const load = useCallback((): (() => void) => {
    let cancelled = false;
    if (scratch) {
      const content = text ?? "";
      setFile({ path: "", name: title ?? "Message", content, size: content.length, truncated: false });
      setDraft(content);
      savedContentRef.current = content;
      pendingRef.current = null;
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    void desktopApi
      .readTextFile({ path: filePath })
      .then((contents) => {
        if (cancelled) return;
        setFile(contents);
        setDraft(contents.content);
        savedContentRef.current = contents.content;
        pendingRef.current = null;
      })
      .catch(() => {
        if (!cancelled) {
          setFile({ path: filePath, name: docFileName(filePath), content: "", size: 0, truncated: false, error: "Could not read this file" });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopApi, filePath, scratch, text, title]);

  useEffect(() => {
    setMode(scratch || isMarkdownPath(filePath) ? "rendered" : "source");
    setSavedAt(null);
    setSaveError(null);
    return load();
  }, [load, filePath, scratch]);

  // Write whatever is waiting, now. Called by the idle timer, by leaving edit
  // mode, and on unmount — so a document can never be left with an edit that
  // only exists in a component that is about to go away.
  const flushPending = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null || pending === savedContentRef.current) return;
    // No file behind a scratch document: the edit stays in this component, so
    // it only has to reach `file` for Source and Copy to agree with the editor.
    if (scratch) {
      savedContentRef.current = pending;
      setFile((current) => (current ? { ...current, content: pending, size: pending.length } : current));
      return;
    }
    void desktopApi
      .writeTextFile({ path: filePath, content: pending })
      .then((result) => {
        if (result.error) {
          setSaveError(result.error);
          return;
        }
        savedContentRef.current = pending;
        setFile((current) => (current ? { ...current, content: pending, size: result.size } : current));
        setSavedAt(result.savedAt);
        setSaveError(null);
      })
      .catch(() => setSaveError("Could not write this file"));
  }, [desktopApi, filePath, scratch]);

  const handleEdit = useCallback(
    (markdown: string): void => {
      setDraft(markdown);
      pendingRef.current = markdown;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flushPending, AUTOSAVE_DELAY_MS);
    },
    [flushPending],
  );

  // Unmount is the last chance: the reader closes on Esc and on a backdrop
  // click, neither of which goes through a save.
  useEffect(() => () => flushPending(), [flushPending]);

  const leaveEdit = useCallback(
    (next: Mode): void => {
      if (mode === "edit" && next !== "edit") flushPending();
      setMode(next);
    },
    [flushPending, mode],
  );

  // Esc closes, the same as everywhere else in the app. Captured on the
  // document because the reader is a modal layer, not a focused control.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        flushPending();
        onClose();
        return;
      }
      // Cmd+[ / Cmd+] walk the reader's own stack while it is open — the same
      // keys the app uses for section history, taken over by the modal layer on
      // top, the way a browser's back key belongs to whatever is in front.
      // Capture + stopPropagation is what keeps the app handler from also
      // firing, since it listens on this same window.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "[" || event.key === "]")) {
        const go = event.key === "[" ? onBack : onForward;
        const allowed = event.key === "[" ? canGoBack : canGoForward;
        event.preventDefault();
        event.stopPropagation();
        if (allowed && go) {
          flushPending();
          go();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [canGoBack, canGoForward, flushPending, onBack, onClose, onForward]);

  const close = useCallback((): void => {
    flushPending();
    onClose();
  }, [flushPending, onClose]);

  const adjustFontSize = useCallback((delta: number): void => {
    setFontSize((current) => {
      const next = clampFontSize(current + delta);
      rememberFontSize(next);
      return next;
    });
  }, []);

  const adjustMeasure = useCallback((width: number): void => {
    const next = clampMeasure(width);
    setMeasure(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(MEASURE_KEY, String(next));
  }, []);

  const copy = useCallback((): void => {
    if (!file?.content) return;
    void navigator.clipboard.writeText(file.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }, [file?.content]);

  const name = file?.name ?? docFileName(filePath);
  const markdown = scratch || isMarkdownPath(filePath);
  // Editing needs the whole file in hand: a truncated read only holds its head,
  // and saving that back would delete the tail.
  const editable = markdown && !!file && !file.error && !file.truncated;
  const editing = mode === "edit" && editable;

  return (
    <div className="doc-reader-backdrop" role="presentation" onClick={close}>
      <div
        className="doc-reader-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={name}
        style={{ "--doc-font-size": `${fontSize}px`, "--doc-measure": `${measure}px` } as React.CSSProperties}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="doc-reader-toolbar">
          {onBack || onForward ? (
            <div className="doc-reader-nav" role="group" aria-label="Reader history">
              <button
                type="button"
                onClick={() => {
                  flushPending();
                  onBack?.();
                }}
                disabled={!canGoBack}
                aria-label="Back"
                title="Back (⌘[)"
              >
                <ChevronLeft size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => {
                  flushPending();
                  onForward?.();
                }}
                disabled={!canGoForward}
                aria-label="Forward"
                title="Forward (⌘])"
              >
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <span className="doc-reader-icon">
            <FileText size={14} aria-hidden="true" />
          </span>
          <div className="doc-reader-heading">
            <strong>{name}</strong>
            <span title={scratch ? undefined : filePath}>{scratch ? "Scratch copy — edits here are not saved to a file" : filePath}</span>
          </div>
          <div className="doc-reader-actions">
            {markdown ? (
              <div className="doc-reader-modes" role="group" aria-label="View as">
                <button className={mode === "rendered" ? "is-active" : ""} type="button" onClick={() => leaveEdit("rendered")}>
                  Rendered
                </button>
                <button className={mode === "source" ? "is-active" : ""} type="button" onClick={() => leaveEdit("source")}>
                  Source
                </button>
                <button
                  className={mode === "edit" ? "is-active" : ""}
                  type="button"
                  onClick={() => setMode("edit")}
                  disabled={!editable}
                  title={scratch ? "Edit this copy — nothing is written to disk" : editable ? "Edit, saved as you type" : "This file is too large to edit here"}
                >
                  Edit
                </button>
              </div>
            ) : null}
            <label className="doc-reader-measure-control" title="Column width">
              <MoveHorizontal size={13} aria-hidden="true" />
              <input
                type="range"
                min={MIN_MEASURE}
                max={MAX_MEASURE}
                step={10}
                value={measure}
                aria-label="Column width"
                onChange={(event) => adjustMeasure(Number(event.target.value))}
                onDoubleClick={() => adjustMeasure(DEFAULT_MEASURE)}
              />
            </label>
            <div className="doc-reader-zoom" role="group" aria-label="Text size">
              <button
                type="button"
                onClick={() => adjustFontSize(-1)}
                disabled={fontSize <= MIN_FONT_SIZE}
                aria-label="Smaller text"
                title="Smaller text"
              >
                <Minus size={12} aria-hidden="true" />
              </button>
              <span title="Text size">{fontSize}</span>
              <button
                type="button"
                onClick={() => adjustFontSize(1)}
                disabled={fontSize >= MAX_FONT_SIZE}
                aria-label="Larger text"
                title="Larger text"
              >
                <Plus size={12} aria-hidden="true" />
              </button>
            </div>
            <button className="ghost-icon-button" type="button" onClick={copy} disabled={!file?.content} aria-label="Copy text" title="Copy text">
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </button>
            {scratch ? null : (
              <button className="ghost-icon-button" type="button" onClick={load} aria-label="Reload" title="Reload from disk">
                <RefreshCw size={14} aria-hidden="true" />
              </button>
            )}
            {scratch ? null : (
            <button
              className="ghost-icon-button"
              type="button"
              onClick={() => onOpenInEditor(filePath)}
              aria-label={editorName ? `Open in ${editorName}` : "Open in editor"}
              title={editorName ? `Open in ${editorName}` : "Open in editor"}
            >
              <ExternalLink size={14} aria-hidden="true" />
            </button>
            )}
            {scratch ? null : (
              <button className="ghost-icon-button" type="button" onClick={() => onReveal(filePath)} aria-label="Reveal in Finder" title="Reveal in Finder">
                <Folder size={14} aria-hidden="true" />
              </button>
            )}
            <button className="ghost-icon-button" type="button" onClick={close} aria-label="Close reader" title="Close">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="doc-reader-body">
          <div className="doc-reader-measure">
            {loading && !file ? (
              <p className="doc-reader-note">Reading…</p>
            ) : file?.error ? (
              <p className="doc-reader-note">{file.error}</p>
            ) : editing ? (
              <MarkdownLiveEditor value={draft} onChange={handleEdit} placeholder="Write in Markdown…" autoFocus />
            ) : !file || file.content.trim().length === 0 ? (
              <p className="doc-reader-note">{scratch ? "Nothing to show." : "This file is empty."}</p>
            ) : mode === "source" || !markdown ? (
              <pre className="doc-reader-source">
                <code>{file.content}</code>
              </pre>
            ) : (
              <FormattedBody value={file.content} />
            )}
            {file?.truncated ? <p className="doc-reader-note">Showing the beginning of the file — the rest is past the reader's size limit.</p> : null}
          </div>
        </div>

        {editing ? (
          <div className="doc-reader-footer">
            <span className="doc-reader-hint">{MARKDOWN_HINTS}</span>
            <span className={saveError ? "doc-reader-save is-failed" : "doc-reader-save"}>
              {saveError ? (
                <>
                  <AlertTriangle size={12} aria-hidden="true" />
                  {saveError}
                </>
              ) : scratch ? (
                "Not saved — copy the text to keep it"
              ) : savedAt !== null ? (
                savedLabel(savedAt)
              ) : (
                "Saves as you type"
              )}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
