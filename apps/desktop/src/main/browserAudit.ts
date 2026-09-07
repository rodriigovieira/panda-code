import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactBrowserUrl, type BrowserActivity } from "../shared/browser";

/**
 * The browser's activity log.
 *
 * One line of JSON per action, from either driver, appended as it happens. It is
 * on disk rather than only in memory for the reason the user asked for it: the
 * question worth answering is usually "what did that section do in the browser
 * an hour ago", and by then the section may be gone and the app may have been
 * restarted.
 *
 * JSONL, because appending is the only write on the hot path and a corrupt tail
 * (a crash mid-line) costs exactly one record instead of the whole file.
 */

/** Records kept on disk. Generous — a line is small — but bounded. */
const DEFAULT_CAP = 2_000;

/**
 * How far past the cap the file is allowed to drift before it is rewritten.
 * Trimming on every append would turn an append into a full read-modify-write.
 */
const SLACK = 1.25;

export type BrowserAudit = {
  append: (record: BrowserActivity) => void;
  /** Newest last, which is the order both the panel and an agent read them in. */
  recent: (limit?: number) => BrowserActivity[];
};

export function createBrowserAudit(options: {
  path: string;
  cap?: number;
  log?: (event: string, details?: Record<string, unknown>) => void;
}): BrowserAudit {
  const cap = options.cap ?? DEFAULT_CAP;
  const sanitize = (record: BrowserActivity): BrowserActivity => ({
    ...record, url: record.url ? redactBrowserUrl(record.url) : undefined,
    detail: record.action === "type" ? "[typed text omitted]" : record.detail,
    outcome: record.ok ? "Succeeded" : "Failed",
  });
  let records: BrowserActivity[] = read().map(sanitize);
  // Remove older typed text and raw URL query strings when opening an old log.
  if (existsSync(options.path)) {
    try { rewrite(); chmodSync(options.path, 0o600); } catch { /* logging must not stop the browser */ }
  }

  function read(): BrowserActivity[] {
    try {
      return readFileSync(options.path, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as BrowserActivity];
          } catch {
            // A torn last line from a crash mid-append. One record, not the file.
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  function rewrite(): void {
    records = records.slice(-cap);
    writeFileSync(options.path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }

  return {
    append(record) {
      record = sanitize(record);
      records.push(record);
      try {
        mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
        if (records.length > cap * SLACK) {
          rewrite();
        } else {
          appendFileSync(options.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
        }
      } catch (error) {
        // A log that cannot be written must not take the browser down with it.
        options.log?.("browser-audit-write-failed", { error: String(error) });
      }
    },
    recent(limit) {
      return limit === undefined ? [...records] : records.slice(-limit);
    },
  };
}
