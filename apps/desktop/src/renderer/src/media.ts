/**
 * Local media referenced from rendered text.
 *
 * Two surfaces need the same three answers — is this href a file on this Mac,
 * is it something we can show, and what URL does the renderer load it from:
 * the transcript (an agent writing `![what it shows](/path/shot.png)` as
 * evidence) and the backlog card (attachments pinned to it). They used to
 * disagree, each with its own copy of the `file://` encoder.
 *
 * The rule that matters is the negative one: only an *absolute local path* is
 * ever loaded. A remote URL in an image stays text, exactly as it did when the
 * transcript refused to render images at all — an agent's output should not be
 * able to make the app fetch `https://…/pixel.png` and report back that the
 * user read the message.
 */

export type MediaKind = "image" | "video";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|webm)$/i;

/** `file:///Users/example/…` — every path segment encoded, so spaces and `#` survive. */
export function localFileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function mediaKindForPath(path: string): MediaKind | null {
  if (IMAGE_EXTENSIONS.test(path)) {
    return "image";
  }
  return VIDEO_EXTENSIONS.test(path) ? "video" : null;
}

/**
 * The absolute path an href points at, or null if it points anywhere else.
 *
 * Accepts the two forms that reach us: the bare path an agent types into a
 * Markdown image, and the `file://` URL the same path becomes once something
 * has already encoded it. Everything else — http(s), data:, a relative path we
 * have no base for — is not ours to load.
 */
export function localMediaPath(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.startsWith("file://")) {
    try {
      const path = decodeURIComponent(new URL(trimmed).pathname);
      return path.startsWith("/") ? path : null;
    } catch {
      return null;
    }
  }
  // A single leading slash: `/Users/example/…`. `//host/share` is a UNC/protocol-relative
  // reference, not a local file.
  return trimmed.startsWith("/") && !trimmed.startsWith("//") ? trimmed : null;
}

export function mediaFileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "attachment";
}

/**
 * Opening the full-size viewer from deep inside rendered Markdown.
 *
 * A window event rather than a prop or a context because the thumbnail is
 * nested six components below the transcript and the viewer lives at the root
 * of App — the same reason (and the same mechanism) as the `panda://backlog/`
 * links next door in `inline.tsx`.
 */
export const OPEN_MEDIA_PREVIEW_EVENT = "panda:open-media-preview";

export type MediaPreviewRequest = { path: string; kind: MediaKind };

export function openMediaPreview(request: MediaPreviewRequest): void {
  window.dispatchEvent(new CustomEvent(OPEN_MEDIA_PREVIEW_EVENT, { detail: request }));
}
