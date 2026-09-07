import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Read the last `maxLines` lines of a file without loading the whole thing.
 *
 * The session detector needs the tail of a transcript to spot new user prompts,
 * and it re-checks every transcript that changed, once per live section, every
 * second. Doing that with `readFileSync(path).split("\n").slice(-25)` made the
 * cost proportional to total transcript size times live sections — measured at
 * 16 MB/s of reads with a single 1.3 MB session live, and transcripts here reach
 * 8 MB. Both factors grow with ordinary use, which is why it degraded silently.
 *
 * Reading a bounded window off the end makes it O(1) in file size instead.
 */
export const TAIL_WINDOW_BYTES = 256 * 1024;

export type TailLine = {
  text: string;
  /** Stable byte position of this line's first byte in the source file. */
  byteOffset: number;
};

/**
 * Offset-bearing form used when a tail reader also needs stable record ids.
 * A local array index is not stable: it changes whenever the file grows enough
 * to move the beginning of the tail window.
 */
export function readTailLineEntries(path: string, maxLines: number, windowBytes = TAIL_WINDOW_BYTES): TailLine[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];

    const length = Math.min(size, windowBytes);
    const start = size - length;
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, start);
    const bytes = buffer.subarray(0, read);
    const lines: TailLine[] = [];
    let lineStart = 0;
    for (let cursor = 0; cursor <= bytes.length; cursor += 1) {
      if (cursor !== bytes.length && bytes[cursor] !== 0x0a) continue;
      // A non-zero file start may land in the middle of both a JSON line and a
      // UTF-8 code point. Skip that first fragment at the byte level so it can
      // never manufacture a replacement character or an invalid JSON record.
      const isBoundaryFragment = start > 0 && lineStart === 0;
      if (!isBoundaryFragment && cursor > lineStart) {
        lines.push({
          text: bytes.subarray(lineStart, cursor).toString("utf8"),
          byteOffset: start + lineStart,
        });
      }
      lineStart = cursor + 1;
    }

    return lines.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

export function readTailLines(path: string, maxLines: number, windowBytes = TAIL_WINDOW_BYTES): string[] {
  return readTailLineEntries(path, maxLines, windowBytes).map((line) => line.text);
}
