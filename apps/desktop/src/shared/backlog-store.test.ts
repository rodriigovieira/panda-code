/**
 * The attachment half of the board's disk store: copying a captured file in,
 * and cleaning up after it once the card drops it.
 *
 * `backlog.ts` never touches bytes, on purpose — the cases worth covering here
 * are exactly the ones that live in this file instead: an unrecognized
 * extension, a file that is not there, one over the size cap, and the copy
 * landing somewhere the original moving or disappearing cannot reach.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addBacklogItem } from "./backlog";
import {
  attachBacklogFile,
  createBacklogStore,
  deleteBacklogAttachmentFiles,
  storeDelete,
  storeUpdate,
  MAX_IMAGE_ATTACHMENT_BYTES,
} from "./backlog-store";

const NOW = "2026-08-11T10:00:00.000Z";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "panda-backlog-"));
}

function sourceFile(dir: string, name: string, bytes = "fake-png-bytes"): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("attachBacklogFile", () => {
  it("copies the file into the board's own attachments directory", () => {
    const dir = tempDir();
    const source = sourceFile(dir, "shot.png");
    const result = attachBacklogFile(dir, source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.kind).toBe("image");
    expect(result.attachment.path).not.toBe(source);
    expect(result.attachment.path.startsWith(join(dir, "attachments"))).toBe(true);
    expect(readFileSync(result.attachment.path, "utf8")).toBe("fake-png-bytes");
    // The original is untouched — a reaper or an overwrite of the source
    // later must not take the attached copy with it.
    expect(existsSync(source)).toBe(true);
  });

  it("carries the caption and section through", () => {
    const dir = tempDir();
    const result = attachBacklogFile(dir, sourceFile(dir, "shot.png"), { caption: "Empty state", createdBySection: "UI fix" });
    expect(result.ok && result.attachment.caption).toBe("Empty state");
    expect(result.ok && result.attachment.createdBySection).toBe("UI fix");
  });

  it("sorts video extensions into the video kind", () => {
    const dir = tempDir();
    const result = attachBacklogFile(dir, sourceFile(dir, "clip.mp4", "fake-mp4"));
    expect(result.ok && result.attachment.kind).toBe("video");
    expect(result.ok && result.attachment.mimeType).toBe("video/mp4");
  });

  it("refuses a file type it does not recognize", () => {
    const dir = tempDir();
    const result = attachBacklogFile(dir, sourceFile(dir, "notes.pdf"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("pdf");
  });

  it("refuses a source that is not there", () => {
    const dir = tempDir();
    const result = attachBacklogFile(dir, join(dir, "missing.png"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("No file");
  });

  it("refuses a file over the size cap for its kind", () => {
    const dir = tempDir();
    const source = join(dir, "huge.png");
    writeFileSync(source, Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1));
    const result = attachBacklogFile(dir, source);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("MB");
  });
});

describe("deleteBacklogAttachmentFiles", () => {
  it("is best-effort — a file already gone does not throw", () => {
    const dir = tempDir();
    expect(() => deleteBacklogAttachmentFiles([{ id: "x", kind: "image", path: join(dir, "gone.png"), name: "gone.png", mimeType: "image/png", size: 0, createdAt: NOW }])).not.toThrow();
  });
});

describe("storeUpdate", () => {
  it("deletes a removed attachment's file off disk", () => {
    const dir = tempDir();
    const store = createBacklogStore(dir);
    const attached = attachBacklogFile(dir, sourceFile(dir, "shot.png"));
    if (!attached.ok) throw new Error(attached.message);

    const added = store.apply("/repo", (backlog) => addBacklogItem(backlog, { title: "Ship it", attachments: [attached.attachment] }, NOW, "id-0"));
    if (!added.ok || !added.item) throw new Error(added.message);
    expect(existsSync(attached.attachment.path)).toBe(true);

    const updated = storeUpdate(store, "/repo", "id-0", { removeAttachmentIds: [attached.attachment.id] });
    expect(updated.ok).toBe(true);
    expect(existsSync(attached.attachment.path)).toBe(false);
  });

  it("leaves attachment files alone when the patch does not touch them", () => {
    const dir = tempDir();
    const store = createBacklogStore(dir);
    const attached = attachBacklogFile(dir, sourceFile(dir, "shot.png"));
    if (!attached.ok) throw new Error(attached.message);
    store.apply("/repo", (backlog) => addBacklogItem(backlog, { title: "Ship it", attachments: [attached.attachment] }, NOW, "id-0"));

    storeUpdate(store, "/repo", "id-0", { summary: "Still true" });
    expect(existsSync(attached.attachment.path)).toBe(true);
  });
});

describe("storeDelete", () => {
  it("deletes every attachment file the card was carrying", () => {
    const dir = tempDir();
    const store = createBacklogStore(dir);
    const a = attachBacklogFile(dir, sourceFile(dir, "a.png"));
    const b = attachBacklogFile(dir, sourceFile(dir, "b.png"));
    if (!a.ok || !b.ok) throw new Error("attach failed");
    store.apply("/repo", (backlog) => addBacklogItem(backlog, { title: "Ship it", attachments: [a.attachment, b.attachment] }, NOW, "id-0"));

    const deleted = storeDelete(store, "/repo", "id-0");
    expect(deleted.ok).toBe(true);
    expect(existsSync(a.attachment.path)).toBe(false);
    expect(existsSync(b.attachment.path)).toBe(false);
  });
});
