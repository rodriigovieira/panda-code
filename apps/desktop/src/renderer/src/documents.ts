/**
 * Documents the app can open in its own reader.
 *
 * The app is full of Markdown that currently has nowhere to be read: a `README`
 * in the file tree, the plan an agent just wrote to `docs/`, a report a section
 * left behind. Every one of those was a trip out to an external editor, which
 * shows the source rather than the document.
 *
 * Same two answers `media.ts` gives for images — is this path something we can
 * show, and how does a thing nested deep in rendered Markdown ask for the
 * viewer — with the same negative rule: only an absolute local path is ever
 * read. A remote URL stays a link.
 */

import { localMediaPath } from "./media";

const MARKDOWN_EXTENSIONS = /\.(md|markdown|mdown|mdx|mdc)$/i;

/** Plain text the reader shows as source rather than pretending to render. */
const PLAIN_TEXT_EXTENSIONS = /\.(txt|text|log|json|ya?ml|toml|ini|env|csv|diff|patch)$/i;

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.test(path);
}

/** Anything the reader will open — Markdown rendered, the rest as source. */
export function isReadableDocPath(path: string): boolean {
  return isMarkdownPath(path) || PLAIN_TEXT_EXTENSIONS.test(path);
}

export function docFileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "document";
}

/**
 * A local document an href points at, or null.
 *
 * Reuses `localMediaPath` for the "is this a path on this Mac" half — the two
 * forms that reach us are the bare absolute path an agent types and the
 * `file://` URL something has already encoded — and then insists the file is
 * one the reader can actually show, so a link to a binary stays a link.
 */
export function localDocPath(href: string): string | null {
  const path = localMediaPath(href);
  return path && isReadableDocPath(path) ? path : null;
}

/**
 * Opening the reader from deep inside rendered Markdown.
 *
 * A window event rather than a prop, for the same reason as the media preview
 * and the `panda://backlog/` links: the link is nested six components below the
 * transcript and the reader lives at the root of App.
 */
export const OPEN_DOCUMENT_EVENT = "panda:open-document";

/**
 * Either a file on disk, or text the app already has in hand — an agent's reply
 * has no path, but it is the same Markdown, and reading it at document width in
 * the same reader is worth more than the file/no-file distinction.
 */
export type DocumentRequest = { path: string } | { text: string; title?: string };

export function isTextDocumentRequest(request: DocumentRequest): request is { text: string; title?: string } {
  return "text" in request;
}

export function openDocument(request: DocumentRequest): void {
  window.dispatchEvent(new CustomEvent(OPEN_DOCUMENT_EVENT, { detail: request }));
}

/** Word count as the "is this long enough to be worth reading elsewhere" test. */
export function documentWordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
