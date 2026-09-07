import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards on the workspace grid, checked against the stylesheet itself.
 *
 * These exist because of a bug that neither typecheck nor any behavioural test
 * could see: `.workspace.with-browser > .browser-dock` was declared TWICE, and
 * the second copy sat after `.workspace.browser-full > .browser-dock`. Same
 * specificity, later in the file, so it silently won — full width put the dock
 * in column 2 and nothing about the code looked wrong.
 *
 * The knock-on was worse than it sounds: with the dock pinned to column 2 while
 * the inline template declared one column, column 2 became an IMPLICIT track,
 * and `grid-column: 1 / -1` does not span implicit tracks — so the topbar
 * collapsed into a 260px strip too. One duplicated rule, three visible defects.
 *
 * Parsing CSS with a regex is crude, and fine here: these assertions are about
 * a file this repo writes by hand, and a false positive is a rule worth looking
 * at anyway.
 */

const raw = readFileSync(join(__dirname, "styles.css"), "utf8");

/**
 * The stylesheet with every `@media` block removed.
 *
 * Responsive overrides legitimately repeat a selector — the narrow-window rules
 * restack both docks under the conversation — so counting them as duplicates
 * would make these guards cry wolf. Only the unconditional rules are compared.
 */
const css = ((): string => {
  let out = "";
  let index = 0;
  for (;;) {
    const at = raw.indexOf("@media", index);
    if (at < 0) {
      out += raw.slice(index);
      return out;
    }
    out += raw.slice(index, at);
    // Walk braces to the end of the block, which may contain nested rules.
    let depth = 0;
    let cursor = raw.indexOf("{", at);
    if (cursor < 0) return out;
    for (; cursor < raw.length; cursor += 1) {
      if (raw[cursor] === "{") depth += 1;
      else if (raw[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = cursor + 1;
  }
})();

/** Every occurrence of a selector, as an index into the stylesheet. */
function occurrences(selector: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    // Followed by `{` (allowing whitespace) so a selector is not matched inside
    // a longer one, and comments mentioning it do not count.
    const index = css.indexOf(`${selector} {`, from);
    if (index < 0) break;
    found.push(index);
    from = index + 1;
  }
  return found;
}

describe("workspace grid rules", () => {
  it("places the browser dock exactly once outside the responsive rules", () => {
    expect(occurrences(".workspace.with-browser > .browser-dock")).toHaveLength(1);
  });

  it("lets full width override the docked placement", () => {
    // Equal specificity, so order is the whole mechanism.
    const docked = occurrences(".workspace.with-browser > .browser-dock")[0];
    const full = occurrences(".workspace.browser-full > .browser-dock")[0];
    expect(docked).toBeDefined();
    expect(full).toBeDefined();
    expect(full).toBeGreaterThan(docked as number);
  });

  it("pins both permanent children of the workspace, so nothing auto-places into a dock's column", () => {
    expect(occurrences(".workspace > .workspace-top")).toHaveLength(1);
    expect(occurrences(".workspace > .conversation-shell")).toHaveLength(1);
  });

  it("gives /btw its own column when the browser is docked too", () => {
    expect(occurrences(".workspace.with-browser.with-btw > .btw-panel").length).toBeGreaterThan(0);
  });

  it("keeps a drag region at full width, where the topbar is hidden", () => {
    // The topbar is the window's drag region; full width hides it, so the tab
    // bar has to take that over or the window becomes impossible to move.
    expect(occurrences(".workspace.browser-full > .conversation-shell,\n.workspace.browser-full > .workspace-top")).toHaveLength(1);
    const drag = css.slice(css.indexOf(".workspace.browser-full .browser-tabbar {"));
    expect(drag.slice(0, drag.indexOf("}"))).toContain("-webkit-app-region: drag");
  });

  it("never hides the dock with display:none", () => {
    // A <webview> under a display:none ancestor loses its compositing surface
    // and comes back blank, which silently kills every tab an agent is using.
    const hidden = css.slice(css.indexOf(".browser-dock.hidden {"));
    const body = hidden.slice(0, hidden.indexOf("}"));
    expect(body).toContain("position: fixed");
    expect(body).not.toContain("display: none");
  });
});
