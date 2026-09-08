import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  addBacklogItem,
  addBacklogEpic,
  backlogFileName,
  deleteBacklogItem,
  deleteBacklogEpic,
  emptyBacklog,
  moveBacklogItem,
  newBacklogId,
  parseBacklog,
  updateBacklogItem,
  updateBacklogEpic,
  type BacklogAttachment,
  type BacklogAttachmentKind,
  type BacklogColumn,
  type BacklogCreate,
  type BacklogPatch,
  type BacklogResult,
  type EpicCreate,
  type EpicPatch,
  type WorkspaceBacklog,
} from "./backlog";

/**
 * The board's disk half.
 *
 * Deliberately file-based and app-free, for the same reason the peers helper is:
 * an agent's `backlog_add` runs in a separate Node process spawned as an MCP
 * server, and requiring the desktop to be reachable would make the board fail in
 * exactly the moments it is most useful. Both writers go through this module, so
 * "read, mutate, atomically replace" is stated once.
 *
 * Node built-ins only — no electron — because the helper process has no app
 * object to ask for paths. The directory is handed in by whoever owns it.
 */

export type BacklogStore = {
  /** Absolute path of the file backing one workspace's board. */
  path: (cwd: string) => string;
  read: (cwd: string) => WorkspaceBacklog;
  /** Runs `mutate` against the board as it is on disk right now, then saves. */
  apply: (cwd: string, mutate: (backlog: WorkspaceBacklog) => BacklogResult) => BacklogResult;
};

export function createBacklogStore(directory: string): BacklogStore {
  const path = (cwd: string): string => join(directory, backlogFileName(cwd));

  const read = (cwd: string): WorkspaceBacklog => {
    const file = path(cwd);
    if (!existsSync(file)) {
      return emptyBacklog(cwd);
    }
    try {
      return parseBacklog(readFileSync(file, "utf8"), cwd);
    } catch {
      return emptyBacklog(cwd);
    }
  };

  const write = (cwd: string, backlog: WorkspaceBacklog): void => {
    const file = path(cwd);
    mkdirSync(directory, { recursive: true });
    // Temp-then-rename: the app watches this file, and a reader that catches a
    // half-written board would show an empty one and let the user "fix" it by
    // typing the items back in. `.tmp` carries the pid so two writers racing
    // cannot truncate each other's staging file.
    const staging = `${file}.${process.pid}.tmp`;
    writeFileSync(staging, `${JSON.stringify(backlog, null, 2)}\n`, "utf8");
    renameSync(staging, file);
  };

  const apply = (cwd: string, mutate: (backlog: WorkspaceBacklog) => BacklogResult): BacklogResult => {
    // Always re-read: the other writer may have changed the board since this
    // process last looked, and a mutation applied to a stale copy would silently
    // undo their card.
    const result = mutate(read(cwd));
    if (!result.ok) {
      return result;
    }
    try {
      write(cwd, result.backlog);
    } catch (error) {
      return { ok: false, message: `Could not save the backlog: ${String(error)}` };
    }
    return result;
  };

  return { path, read, apply };
}

/** Convenience wrappers so callers do not have to close over the pure functions. */
export function storeAdd(store: BacklogStore, cwd: string, input: BacklogCreate): BacklogResult {
  return store.apply(cwd, (backlog) => addBacklogItem(backlog, input));
}

/**
 * Same as {@link storeUpdate} but also reconciles attachment files on disk: a
 * successful `removeAttachmentIds` deletes the files it dropped. Best-effort —
 * the board's own state is what `updateBacklogItem` already committed, so a
 * stray file that fails to delete is disk clutter, not a correctness bug.
 */
export function storeUpdate(store: BacklogStore, cwd: string, idOrTitle: string, patch: BacklogPatch): BacklogResult {
  const before = store.read(cwd);
  const target = findAttachmentOwner(before, idOrTitle);
  const result = store.apply(cwd, (backlog) => updateBacklogItem(backlog, idOrTitle, patch));
  if (result.ok && target && patch.removeAttachmentIds?.length) {
    const removed = target.attachments?.filter((attachment) => patch.removeAttachmentIds?.includes(attachment.id)) ?? [];
    deleteBacklogAttachmentFiles(removed);
  }
  return result;
}

export function storeMove(store: BacklogStore, cwd: string, id: string, column: BacklogColumn, index: number): BacklogResult {
  return store.apply(cwd, (backlog) => moveBacklogItem(backlog, id, column, index));
}

export function storeAddEpic(store: BacklogStore, cwd: string, input: EpicCreate): BacklogResult {
  return store.apply(cwd, (backlog) => addBacklogEpic(backlog, input));
}

export function storeUpdateEpic(store: BacklogStore, cwd: string, idOrTitle: string, patch: EpicPatch): BacklogResult {
  return store.apply(cwd, (backlog) => updateBacklogEpic(backlog, idOrTitle, patch));
}

export function storeDeleteEpic(store: BacklogStore, cwd: string, idOrTitle: string): BacklogResult {
  return store.apply(cwd, (backlog) => deleteBacklogEpic(backlog, idOrTitle));
}

/** Deletes the card, then best-effort deletes whatever attachment files it carried. */
export function storeDelete(store: BacklogStore, cwd: string, idOrTitle: string): BacklogResult {
  const result = store.apply(cwd, (backlog) => deleteBacklogItem(backlog, idOrTitle));
  if (result.ok && result.item?.attachments?.length) {
    deleteBacklogAttachmentFiles(result.item.attachments);
  }
  return result;
}

function findAttachmentOwner(backlog: WorkspaceBacklog, idOrTitle: string) {
  const needle = idOrTitle.trim().toLowerCase();
  return backlog.items.find((item) => item.id.toLowerCase() === needle || String(item.number) === needle || item.title.toLowerCase() === needle);
}

/** Best-effort unlink for a set of attachments — used both on removal and to roll back a partial attach. */
export function deleteBacklogAttachmentFiles(attachments: readonly BacklogAttachment[]): void {
  for (const attachment of attachments) {
    try {
      unlinkSync(attachment.path);
    } catch {
      // Best-effort: the card's own state already dropped the reference.
    }
  }
}

const ATTACHMENT_KIND_BY_EXTENSION: Record<string, BacklogAttachmentKind> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
};

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** A screenshot is a few hundred KB; this is generous headroom, not a target. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** `browser_record` caps itself at 5 minutes; this is generous headroom for that. */
export const MAX_VIDEO_ATTACHMENT_BYTES = 200 * 1024 * 1024;

export type AttachBacklogFileResult = { ok: true; attachment: BacklogAttachment } | { ok: false; message: string };

/**
 * Copy a file an agent (or the user) points at into the board's own attachments
 * directory and hand back the resolved {@link BacklogAttachment} record — the
 * only place in the backlog code that touches attachment bytes, so
 * `backlog.ts` can stay a pure module.
 *
 * The copy, not a reference to the original, is what the card remembers: a
 * `browser_screenshot` file can be reaped or overwritten long after the card
 * that cites it is still open.
 */
export function attachBacklogFile(
  directory: string,
  sourcePath: string,
  options: { caption?: string; createdBySection?: string; now?: string } = {},
): AttachBacklogFileResult {
  const extension = extname(sourcePath).toLowerCase();
  const kind = ATTACHMENT_KIND_BY_EXTENSION[extension];
  if (!kind) {
    return { ok: false, message: `"${sourcePath}" isn't an image or video Panda Code recognizes — try png, jpg, gif, webp, mp4, mov, or webm.` };
  }
  if (!existsSync(sourcePath)) {
    return { ok: false, message: `No file at "${sourcePath}".` };
  }
  const stat = statSync(sourcePath);
  const cap = kind === "image" ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_VIDEO_ATTACHMENT_BYTES;
  if (stat.size > cap) {
    return {
      ok: false,
      message: `"${sourcePath}" is ${Math.round(stat.size / (1024 * 1024))} MB, over the ${Math.round(cap / (1024 * 1024))} MB cap for a ${kind} attachment.`,
    };
  }

  const id = newBacklogId();
  const attachmentsDir = join(directory, "attachments");
  mkdirSync(attachmentsDir, { recursive: true });
  const destination = join(attachmentsDir, `${id}${extension}`);
  copyFileSync(sourcePath, destination);

  return {
    ok: true,
    attachment: {
      id,
      kind,
      path: destination,
      name: basename(sourcePath),
      mimeType: MIME_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream",
      size: stat.size,
      caption: options.caption,
      createdAt: options.now ?? new Date().toISOString(),
      createdBySection: options.createdBySection,
    },
  };
}
