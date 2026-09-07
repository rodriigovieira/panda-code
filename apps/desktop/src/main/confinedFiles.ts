import { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, realpathSync, statSync, writeSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
/** Check both lexical and canonical containment, including ancestor symlinks. */
export function confinedPath(root: string, requested: string): string {
  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(lexicalRoot, requested);
  if (!contains(lexicalRoot, lexicalTarget)) throw new Error("That path is outside the trusted directory.");
  const canonicalRoot = realpathSync(lexicalRoot);
  const target = realpathSync(lexicalTarget);
  if (!contains(canonicalRoot, target)) throw new Error("That path links outside the trusted directory.");
  return target;
}
function openChecked(path: string, write: boolean, root?: string): number {
  const target = root ? confinedPath(root, path) : realpathSync(path);
  const fd = openSync(target, (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("Only regular files can be opened.");
    // Revalidate after open and compare inode identity before reading/writing.
    const current = root ? confinedPath(root, path) : realpathSync(path);
    const expected = statSync(current);
    if (current !== target || opened.dev !== expected.dev || opened.ino !== expected.ino) throw new Error("File changed while opening it.");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
export function readBoundedFile(path: string, cap: number, root?: string): { bytes: Buffer; size: number; truncated: boolean } {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 64 * 1024 * 1024) throw new Error("Invalid file size limit.");
  const fd = openChecked(path, false, root);
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, cap));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return { bytes: buffer.subarray(0, offset), size, truncated: size > cap };
  } finally { closeSync(fd); }
}
export function writeConfinedText(root: string, path: string, content: string, cap = 2 * 1024 * 1024): number {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > cap) throw new Error("This document is too large to save.");
  const fd = openChecked(path, true, root);
  try {
    const stat = fstatSync(fd);
    if (stat.size > cap) throw new Error("This document is too large to edit.");
    const head = Buffer.alloc(Math.min(stat.size, 8192));
    const count = readSync(fd, head, 0, head.length, 0);
    if (head.subarray(0, count).includes(0)) throw new Error("That file is binary.");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    ftruncateSync(fd, bytes.length);
    return bytes.length;
  } finally { closeSync(fd); }
}
