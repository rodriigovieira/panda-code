/**
 * The activity log's durability, which is the whole reason it is a file.
 *
 * The question these cover is "what did that section do in the browser an hour
 * ago", asked after the section is gone and possibly after a restart — so the
 * cases that matter are the boring ones: it survives reopening, a crash
 * mid-append costs one record rather than the file, the cap trims the oldest and
 * never the newest, and a log that cannot be written does not take the browser
 * down with it.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserActivity } from "../shared/browser";
import { createBrowserAudit } from "./browserAudit";

const record = (patch: Partial<BrowserActivity> = {}): BrowserActivity => ({
  at: "2026-08-07T03:00:00.000Z",
  actor: "You",
  action: "click",
  ok: true,
  ms: 12,
  ...patch,
});

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "panda-audit-")), "browser-activity.jsonl");
}

describe("browserAudit", () => {
  it("appends one line per record and reads them back in order", () => {
    const path = tempPath();
    const audit = createBrowserAudit({ path });

    audit.append(record({ action: "open" }));
    audit.append(record({ action: "click" }));

    expect(audit.recent().map((entry) => entry.action)).toEqual(["open", "click"]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("survives a restart — the log is the point of it being on disk", () => {
    const path = tempPath();
    createBrowserAudit({ path }).append(record({ action: "navigate" }));

    const reopened = createBrowserAudit({ path });
    expect(reopened.recent()).toHaveLength(1);
    expect(reopened.recent()[0]?.action).toBe("navigate");
  });

  it("drops only the torn line when a crash left a half-written record", () => {
    const path = tempPath();
    writeFileSync(path, `${JSON.stringify(record({ action: "open" }))}\n{"at":"2026-08-07T03`, "utf8");

    const audit = createBrowserAudit({ path });
    expect(audit.recent()).toHaveLength(1);
    expect(audit.recent()[0]?.action).toBe("open");
  });

  it("trims to the cap once the file has drifted past it", () => {
    const path = tempPath();
    const audit = createBrowserAudit({ path, cap: 4 });

    for (let index = 0; index < 10; index += 1) {
      audit.append(record({ action: `action-${index}` }));
    }

    // Trimming happens on the write that crosses cap × slack, so what is left is
    // the newest `cap` records — never the oldest.
    const kept = audit.recent().map((entry) => entry.action);
    expect(kept).toContain("action-9");
    expect(kept).not.toContain("action-0");
    expect(kept.length).toBeLessThanOrEqual(6);
    expect(readFileSync(path, "utf8").trim().split("\n").length).toBeLessThanOrEqual(6);
  });

  it("limits what it hands back when asked", () => {
    const audit = createBrowserAudit({ path: tempPath() });
    for (let index = 0; index < 5; index += 1) {
      audit.append(record({ action: `action-${index}` }));
    }
    expect(audit.recent(2).map((entry) => entry.action)).toEqual(["action-3", "action-4"]);
  });

  it("keeps working when the log cannot be written", () => {
    // A directory that does not exist and cannot be made — the browser must not
    // fall over because its telemetry has nowhere to go.
    const audit = createBrowserAudit({ path: "/dev/null/nope/browser-activity.jsonl" });
    expect(() => audit.append(record())).not.toThrow();
    expect(audit.recent()).toHaveLength(1);
  });
});

it("scrubs typed input and URL credentials from both new and pre-upgrade records", () => {
 const path = tempPath();
 const secret = record({action:"type",detail:"private prompt",url:"https://user:password@example.com/?token=secret#secret",outcome:"private page"});
 writeFileSync(path, JSON.stringify(secret) + "\n");
 const audit = createBrowserAudit({path});
 audit.append(secret);
 const stored = readFileSync(path,"utf8");
 for (const value of ["private prompt","password","token=secret","#secret","private page"]) expect(stored).not.toContain(value);
 expect(audit.recent()[0]!.detail).toBe("[typed text omitted]");
});
