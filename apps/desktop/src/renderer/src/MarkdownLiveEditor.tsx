import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { applyEnter, renderMarkdownHighlight } from "./markdownLive";

/**
 * A single-pane live Markdown editor.
 *
 * The contenteditable's text *is* the Markdown source: formatting is applied by
 * re-highlighting that text in place (a heading sets large, `**bold**` sets
 * bold) while the syntax markers stay visible but dimmed. Because highlighting
 * never adds or removes a character, the source round-trips trivially and caret
 * offsets stay stable — which is what makes editing and autosaving the same
 * text the reader renders safe to do in one pane, with no preview to keep in
 * sync and no risk of a rich-text editor rewriting an agent's Markdown.
 */

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * Text of one block element: descendant `<br>`s become newlines, and a single
 * *trailing* newline is dropped — that one is the empty-line filler
 * (`<div><br></div>`), not something the user typed. Enter is handled
 * explicitly below, so the browser never leaves an ambiguous trailing `<br>`
 * inside a line that also holds real text.
 */
function blockToLine(el: Element): string {
  let text = "";
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue ?? "";
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if ((child as Element).tagName === "BR") text += "\n";
        else walk(child);
      }
    }
  };
  walk(el);
  return text.replace(/\n$/, "");
}

/**
 * The editor DOM back to Markdown, one line per top-level block. Bare
 * text/inline nodes — which the browser leaves behind when the editor was
 * empty — accumulate into a line; a bare `<br>` ends the current line.
 */
export function domToMarkdown(root: HTMLElement): string {
  const lines: string[] = [];
  let buffer = "";
  let buffering = false;
  const flush = (): void => {
    if (buffering) {
      lines.push(buffer);
      buffer = "";
      buffering = false;
    }
  };

  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.tagName === "BR") {
        lines.push(buffer);
        buffer = "";
        buffering = false;
      } else if (BLOCK_TAGS.has(el.tagName)) {
        flush();
        lines.push(blockToLine(el));
      } else {
        buffer += blockToLine(el);
        buffering = true;
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.nodeValue ?? "";
      buffering = true;
    }
  }
  flush();
  if (lines.length === 0) lines.push("");
  return lines.join("\n");
}

/**
 * Where the caret is, as an offset into the Markdown. Computed by serializing
 * a clone of everything before it with the very same algorithm, so the two
 * can't disagree.
 */
function getCaretOffset(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const holder = document.createElement("div");
  holder.appendChild(pre.cloneContents());
  return domToMarkdown(holder).length;
}

function placeCaretInLine(line: Element, column: number, selection: Selection): void {
  const range = document.createRange();
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  if (!node) {
    // An empty line (a lone `<br>` filler): the caret goes at the block's start.
    range.setStart(line, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  let remaining = column;
  while (node) {
    const length = node.nodeValue?.length ?? 0;
    const next = walker.nextNode();
    if (remaining <= length || !next) {
      range.setStart(node, Math.min(remaining, length));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    node = next;
  }
}

/** Put the caret back at `target` after a repaint. Relies on the canonical
 * post-render structure: one `.mdl-line` block per source line. */
function setCaretOffset(root: HTMLElement, target: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const lines = Array.from(root.children);
  if (lines.length === 0) {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  let remaining = Math.max(0, target);
  for (const line of lines) {
    const length = (line.textContent ?? "").length;
    if (remaining <= length) {
      placeCaretInLine(line, remaining, selection);
      return;
    }
    remaining -= length + 1; // the newline between two lines
  }
  const last = lines[lines.length - 1];
  if (last) placeCaretInLine(last, (last.textContent ?? "").length, selection);
}

export function MarkdownLiveEditor({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}): ReactElement {
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  // The last Markdown we know the DOM reflects, so a parent re-render echoing
  // our own edit back as `value` doesn't repaint under the caret.
  const lastMarkdownRef = useRef<string>(value);

  const renderHighlight = useCallback((markdown: string): void => {
    const editor = editorRef.current;
    if (!editor) return;
    // Truly empty stays empty, so `:empty::before` puts the placeholder on the
    // caret's line rather than in a stray block above it.
    editor.innerHTML = markdown.length === 0 ? "" : renderMarkdownHighlight(markdown);
    editor.classList.toggle("mdl-empty", markdown.length === 0);
  }, []);

  // Mount: paint what came in, and land the caret at the top of the document —
  // this is a file the user opened to read, so the first thing they see should
  // be its beginning, not its end.
  useEffect(() => {
    renderHighlight(value);
    lastMarkdownRef.current = value;
    if (autoFocus && editorRef.current) {
      editorRef.current.focus();
      setCaretOffset(editorRef.current, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // An external change (a reload from disk, a different file) repaints; a local
  // edit does not, so typing never fights the caret.
  useEffect(() => {
    if (value === lastMarkdownRef.current) return;
    renderHighlight(value);
    lastMarkdownRef.current = value;
  }, [value, renderHighlight]);

  const handleInput = useCallback((): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const markdown = domToMarkdown(editor);
    lastMarkdownRef.current = markdown;
    onChange(markdown);
    // Mid-composition the IME owns the DOM; re-highlighting would break it.
    if (composingRef.current) return;
    const caret = getCaretOffset(editor);
    renderHighlight(markdown);
    if (caret !== null) setCaretOffset(editor, caret);
  }, [onChange, renderHighlight]);

  const handleCompositionEnd = useCallback((): void => {
    composingRef.current = false;
    handleInput();
  }, [handleInput]);

  // Enter is ours: compute it on the Markdown model and repaint. Letting the
  // browser run its own contenteditable Enter leaves block/`<br>` structures
  // that are ambiguous to serialize back.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key !== "Enter" || composingRef.current) return;
      event.preventDefault();
      const editor = editorRef.current;
      if (!editor) return;
      const current = domToMarkdown(editor);
      const offset = getCaretOffset(editor) ?? current.length;
      const result = applyEnter(current, offset);
      renderHighlight(result.markdown);
      lastMarkdownRef.current = result.markdown;
      onChange(result.markdown);
      setCaretOffset(editor, result.caret);
    },
    [onChange, renderHighlight],
  );

  // Paste as plain text, so anything rich collapses to Markdown source.
  const handlePaste = useCallback(
    (event: React.ClipboardEvent): void => {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      handleInput();
    },
    [handleInput],
  );

  return (
    <div
      ref={editorRef}
      className="mdl-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Edit document"
      data-placeholder={placeholder ?? ""}
      spellCheck
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={handleCompositionEnd}
      onPaste={handlePaste}
    />
  );
}
