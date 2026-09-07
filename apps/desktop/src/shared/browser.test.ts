/**
 * The pure half of the browser: URL rules, the injected page scripts, key
 * parsing, and every string an agent reads back.
 *
 * Two things about the script tests are deliberate and easy to mistake for
 * laziness.
 *
 * They assert on the script SOURCE rather than on its behaviour, because this
 * repo has no DOM implementation and adding one for these was judged not worth
 * a dependency. So "pierces shadow roots" is verified as *written*, not as
 * *executed* — a real gap, and the reason the escaping tests below matter more
 * than they otherwise would: a selector or a note's text is caller-supplied and
 * gets spliced into source that runs inside the user's logged-in session.
 *
 * And the rendering tests pin exact wording, which looks brittle until you
 * remember these strings are an API: they are what an agent reads to decide what
 * to do next. `renderBrowser` once said a tab was "shown to the user" when it
 * merely was that section's designated tab, and an agent believed it and
 * screenshotted the wrong window. The wording is the contract.
 */

import { describe, expect, it } from "vitest";
import {
  browserUserAgent,
  groupTabsByThread,
  clip,
  ariaOptionScript,
  drawNoteScript,
  findElementScript,
  inspectScript,
  renderInspect,
  SCROLLER_MARK,
  scrollPositionScript,
  normalizeUrl,
  pageTextScript,
  parseKeyChord,
  renderActivity,
  renderBrowser,
  renderPageRead,
  scrollScript,
  selectOptionScript,
  summarizeArgs,
  tabLabel,
  waitForScript,
  type BrowserActivity,
  type BrowserTab,
} from "./browser";

const tab = (patch: Partial<BrowserTab> = {}): BrowserTab => ({
  id: "tab-abc123",
  threadId: "sec-1",
  url: "https://example.com/pricing",
  title: "Pricing",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...patch,
});

describe("normalizeUrl", () => {
  it("keeps a full URL as it is", () => {
    expect(normalizeUrl("https://example.com/x?y=1")).toEqual({ url: "https://example.com/x?y=1" });
  });

  it("https-es a bare host", () => {
    expect(normalizeUrl("example.com/pricing")).toEqual({ url: "https://example.com/pricing" });
  });

  it("treats a local dev server as an http address, not a scheme or a search", () => {
    expect(normalizeUrl("localhost:5173")).toEqual({ url: "http://localhost:5173/" });
    expect(normalizeUrl("127.0.0.1:8080/health")).toEqual({ url: "http://127.0.0.1:8080/health" });
  });

  it("still reads a host with a port as an address", () => {
    expect(normalizeUrl("example.com:8443/status")).toEqual({ url: "https://example.com:8443/status" });
  });

  it("searches for anything that is not address-shaped", () => {
    const result = normalizeUrl("electron webview docs");
    expect(result).toEqual({ url: "https://duckduckgo.com/?q=electron%20webview%20docs" });
  });

  it("refuses schemes that are not http(s)", () => {
    // The agent has the filesystem through its own tools, and a local page would
    // sit in the same logged-in session as the user's real accounts.
    expect(normalizeUrl("file:///etc/passwd")).toEqual({
      error: "Refusing to open a file: URL — the browser opens http(s) pages only.",
    });
    expect(normalizeUrl("javascript:alert(1)")).toMatchObject({ error: expect.stringContaining("Refusing") });
  });

  it("rejects an empty address", () => {
    expect(normalizeUrl("   ")).toEqual({ error: "No URL given." });
  });
});

describe("tabLabel", () => {
  it("prefers the title", () => {
    expect(tabLabel(tab())).toBe("Pricing");
  });

  it("falls back to the host while a page is still untitled", () => {
    expect(tabLabel(tab({ title: "  " }))).toBe("example.com");
  });
});

describe("clip", () => {
  it("leaves short text alone", () => {
    expect(clip("hello", 100)).toBe("hello");
  });

  it("says how much it dropped rather than trailing off", () => {
    const clipped = clip("x".repeat(50), 10);
    expect(clipped).toContain("40 more characters");
    expect(clipped).toContain("selector");
  });
});

describe("injected scripts", () => {
  it("escapes the selector rather than splicing it in raw", () => {
    // A selector is agent-supplied; splicing it unescaped would let a quote in
    // it rewrite the script that runs in the user's logged-in session.
    const source = pageTextScript('a[href="\'; alert(1); //"]');
    expect(source).toContain('const selector = "a[href=\\"\'; alert(1); //\\"]"');
    expect(source).not.toContain("alert(1); //\"]\";");
  });

  it("asks for links only when links were requested", () => {
    expect(pageTextScript(undefined, true)).toContain("a[href]");
    expect(pageTextScript(undefined, false)).toContain("false\n");
  });

  it("refuses to look for an element with neither a selector nor text", () => {
    expect(findElementScript()).toContain("Give either a selector or the visible text");
  });

  it("keeps a note's own text out of the script grammar", () => {
    const source = drawNoteScript({ text: 'she said "ship it"\n</script>', at: "2026-08-07T00:00:00.000Z" });
    expect(source).toContain('\\"ship it\\"');
    expect(source).not.toContain("</script>");
  });
});

describe("renderBrowser", () => {
  it("explains what the browser is when nothing is open", () => {
    const text = renderBrowser({ tabs: [], activeTabByThread: {} }, "sec-1");
    expect(text).toContain("no tabs open");
    expect(text).toContain("browser_open");
  });

  it("marks the tab the user is looking at, who opened it, and any pending note", () => {
    const text = renderBrowser(
      {
        tabs: [
          tab(),
          tab({
            id: "tab-def456",
            url: "https://example.com/invoice",
            title: "Invoice",
            openedBy: "Billing cleanup",
            note: { text: "Confirm the VAT line before I submit.", at: "2026-08-07T00:00:00.000Z" },
          }),
        ],
        activeTabByThread: { "sec-1": "tab-def456" },
      },
      "sec-1",
    );

    expect(text).toContain("2 tabs open");
    expect(text).toContain("`tab-abc123` **Pricing**");
    // The front tab of a section nobody is looking at is NOT "shown to the user";
    // saying so sent an agent off screenshotting the wrong window.
    expect(text).toContain("this section's front tab, but the browser is not on screen");
    expect(text).not.toContain("on screen now");
    expect(text).toContain("opened by Billing cleanup");
    expect(text).toContain("note awaiting the user: Confirm the VAT line before I submit.");
  });

  it("says a tab is on screen only when the renderer says so", () => {
    const text = renderBrowser(
      { tabs: [tab({ onScreen: true })], activeTabByThread: { "sec-1": "tab-abc123" } },
      "sec-1",
    );
    expect(text).toContain("on screen now");
    expect(text).not.toContain("not on screen");
  });

  it("tells an agent how to get the page in front of the user", () => {
    const text = renderBrowser({ tabs: [tab()], activeTabByThread: {} }, "sec-1");
    expect(text).toContain("None of them is on screen right now");
    expect(text).toContain("browser_note");
  });
});

describe("renderPageRead", () => {
  it("leads with the title and URL and omits an empty link list", () => {
    const text = renderPageRead({ title: "Pricing", url: "https://example.com/pricing", text: "Free\nPro", links: [] });
    expect(text).toBe("# Pricing\nhttps://example.com/pricing\n\nFree\nPro");
  });

  it("appends links when there are some", () => {
    const text = renderPageRead({
      title: "Pricing",
      url: "https://example.com/pricing",
      text: "Free",
      links: [{ text: "Contact", href: "https://example.com/contact" }],
    });
    expect(text).toContain("## Links\n- [Contact](https://example.com/contact)");
  });
});

describe("browserUserAgent", () => {
  it("drops the tokens that get pages blocked or degraded", () => {
    const agent = browserUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Panda Code/1.0.0 Chrome/132.0.0.0 Electron/34.0.2 Safari/537.36",
    );
    expect(agent).not.toContain("Electron");
    expect(agent).not.toContain("Panda Code");
    expect(agent).toContain("Chrome/132.0.0.0");
    expect(agent).toContain("Safari/537.36");
  });
});

describe("parseKeyChord", () => {
  it("reads a bare named key", () => {
    expect(parseKeyChord("Escape")).toEqual({ keyCode: "Escape", modifiers: [] });
    expect(parseKeyChord("arrowdown")).toEqual({ keyCode: "Down", modifiers: [] });
  });

  it("normalizes the modifier spellings people actually write", () => {
    expect(parseKeyChord("Cmd+A")).toEqual({ keyCode: "A", modifiers: ["cmd"] });
    expect(parseKeyChord("command+shift+k")).toEqual({ keyCode: "K", modifiers: ["cmd", "shift"] });
    expect(parseKeyChord("ctrl+alt+Delete")).toEqual({ keyCode: "Delete", modifiers: ["control", "alt"] });
  });

  it("takes function keys", () => {
    expect(parseKeyChord("F5")).toEqual({ keyCode: "F5", modifiers: [] });
  });

  it("refuses what it cannot send, rather than sending nothing", () => {
    // The failure this prevents: a typo'd key name that produces a keystroke
    // nobody receives, which reads to the agent as "the page ignored it".
    expect(parseKeyChord("Wiggle")).toMatchObject({ error: expect.stringContaining("Unknown key") });
    expect(parseKeyChord("hyper+a")).toMatchObject({ error: expect.stringContaining("Unknown modifier") });
    expect(parseKeyChord("  ")).toEqual({ error: "No key given." });
  });
});

describe("injected scripts for the full-control ops", () => {
  it("pierces shadow roots when looking for anything", () => {
    // Without this, an app built from web components is invisible to selectors:
    // the element is on screen and the query returns nothing.
    for (const source of [pageTextScript(".x"), findElementScript(".x"), waitForScript(".x", undefined, 1_000), scrollScript(".x", undefined)]) {
      expect(source).toContain("shadowRoot");
    }
  });

  it("bakes the deadline into the wait rather than looping forever", () => {
    const source = waitForScript("#ready", undefined, 4_500);
    expect(source).toContain("4500");
    expect(source).toContain("setTimeout(tick, 120)");
  });

  it("sets a select through the native setter so frameworks see the change", () => {
    const source = selectOptionScript("#country", undefined, "Brazil");
    expect(source).toContain("HTMLSelectElement.prototype");
    expect(source).toContain('new Event("change"');
    expect(source).toContain("Brazil");
  });

  it("lists the real options when the wanted one is not there", () => {
    expect(selectOptionScript("#country", "zz", undefined)).toContain("Available: ");
  });

  it("hands a non-<select> over to the ARIA path instead of failing outright", () => {
    // Almost no serious app ships a <select> any more; refusing everything else
    // meant this tool could not set a dropdown in the apps that matter most.
    const source = selectOptionScript("[role=combobox]", undefined, "Daily");
    expect(source).toContain("aria: true");
    expect(source).toContain("aria-haspopup");
  });

  it("looks for a dropdown's options across the whole document, since popups are portalled", () => {
    const source = ariaOptionScript("Daily", undefined, 4_000);
    // Not scoped to the trigger's subtree — that is the assumption that breaks
    // on every component library.
    expect(source).toContain("__deep(");
    expect(source).toContain("role=option");
    expect(source).toContain("4000");
  });

  it("reveals an element through its nested scroll panes before judging it unreachable", () => {
    const source = findElementScript(undefined, "Orçamento total");
    expect(source).toContain("__reveal(el)");
    expect(source).toContain("scrollIntoView");
    // Every remaining refusal names something scrolling could not have fixed.
    expect(source).toContain("is covering it");
    expect(source).toContain("display:none");
  });

  it("scrolls the pane the content is in, not the window", () => {
    const source = scrollScript(undefined, 900);
    expect(source).not.toContain("window.scrollBy");
    expect(source).toContain("__biggestScroller()");
    expect(source).toContain("moved");
  });

  it("accepts visible text as a scroll target, the way clicking does", () => {
    const source = scrollScript(undefined, undefined, "Estratégia de orçamento");
    expect(source).toContain("__byText(wanted)");
    expect(source).toContain("Estratégia de orçamento");
  });

  it("marks the container it scrolled so a wheel fallback can measure the same one", () => {
    expect(scrollScript(undefined, 900)).toContain(SCROLLER_MARK);
    expect(scrollPositionScript()).toContain(SCROLLER_MARK);
  });

  it("reports element state and a way to address each match again", () => {
    const source = inspectScript({ role: "combobox" });
    expect(source).toContain("aria-labelledby");
    expect(source).toContain("data-testid");
    expect(source).toContain("nth-of-type");
    expect(source).toContain("combobox");
  });
});

describe("renderInspect", () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };

  it("leads with the selector, because the point is to act on the match next", () => {
    const rendered = renderInspect({
      total: 1,
      matches: [{ selector: "#budget", tag: "input", type: "text", name: "Daily budget", value: "50", visible: true, box }],
    });
    expect(rendered).toContain("`#budget`");
    expect(rendered).toContain('value="50"');
    expect(rendered).toContain("on screen");
  });

  it("distinguishes an empty field from one it could not read", () => {
    const rendered = renderInspect({ total: 1, matches: [{ selector: "#name", tag: "input", value: "", visible: false, box }] });
    expect(rendered).toContain('value=""');
    expect(rendered).toContain("off screen");
  });

  it("says how many it did not show rather than trailing off", () => {
    const rendered = renderInspect({ total: 40, matches: [{ selector: "#a", tag: "input", visible: true, box }] });
    expect(rendered).toContain("39 more matched");
  });

  it("says so plainly when nothing matched", () => {
    expect(renderInspect({ total: 0, matches: [] })).toBe("Nothing matched.");
  });
});

describe("summarizeArgs", () => {
  it("writes down what an action was given", () => {
    expect(summarizeArgs("click", { selector: ".save", text: "Save" })).toBe('selector=.save text="Save"');
    expect(summarizeArgs("open", { url: "https://example.com" })).toBe("https://example.com");
  });

  it("redacts a password field, and a field whose name gives it away", () => {
    expect(summarizeArgs("type", { selector: "#pw", text: "hunter2", inputType: "password" })).toContain("[redacted]");
    expect(summarizeArgs("type", { selector: "#api-token", text: "sk-123" })).toContain("[redacted]");
    expect(summarizeArgs("type", { selector: "#email", text: "a@b.com" })).toContain('"a@b.com"');
  });

  it("clips a very long argument", () => {
    const detail = summarizeArgs("type", { selector: "#body", text: "x".repeat(500) }) ?? "";
    expect(detail.length).toBeLessThan(200);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("returns nothing when there is nothing worth writing", () => {
    expect(summarizeArgs("screenshot", {})).toBeUndefined();
  });
});

describe("renderActivity", () => {
  const entry = (patch: Partial<BrowserActivity> = {}): BrowserActivity => ({
    at: "2026-08-07T03:04:05.000Z",
    actor: "Billing cleanup",
    action: "click",
    ok: true,
    ms: 42,
    ...patch,
  });

  it("says so when nothing has happened", () => {
    expect(renderActivity([])).toContain("Nothing has happened");
  });

  it("shows who did what, to which tab, and how it went", () => {
    const text = renderActivity([entry({ tabId: "tab-abc", detail: "selector=.save", outcome: "Clicked button" })]);
    expect(text).toContain("03:04:05");
    expect(text).toContain("Billing cleanup");
    expect(text).toContain("**click**");
    expect(text).toContain("`tab-abc`");
    expect(text).toContain("selector=.save → Clicked button");
    expect(text).toContain("42ms");
  });

  it("marks a failure as one", () => {
    expect(renderActivity([entry({ ok: false, outcome: "No element matches .save" })])).toContain("FAILED");
  });

  it("returns the newest records and says the list was cut", () => {
    const records = Array.from({ length: 10 }, (_unused, index) => entry({ action: `action-${index}` }));
    const text = renderActivity(records, 3);
    expect(text).toContain("newest 3");
    expect(text).toContain("action-9");
    expect(text).not.toContain("action-6");
  });
});

describe("groupTabsByThread", () => {
  const state = {
    activeTabByThread: {},
    tabs: [
      tab({ id: "a", threadId: "sec-1", threadTitle: "Billing cleanup" }),
      tab({ id: "b", threadId: "sec-2", threadTitle: "Release cutting" }),
      tab({ id: "c", threadId: "sec-1", threadTitle: "Billing cleanup" }),
    ],
  };

  it("groups a section's tabs together, in first-seen order", () => {
    const groups = groupTabsByThread(state);
    expect(groups.map((group) => group.threadId)).toEqual(["sec-1", "sec-2"]);
    expect(groups[0]?.tabs.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(groups[0]?.title).toBe("Billing cleanup");
  });

  it("prefers the freshest title a section's tabs carry", () => {
    // Sections get renamed while their tabs are open; the newest wins rather
    // than whichever tab happened to be opened first.
    const groups = groupTabsByThread({
      activeTabByThread: {},
      tabs: [tab({ id: "a", threadId: "sec-1", threadTitle: "Old name" }), tab({ id: "b", threadId: "sec-1", threadTitle: "New name" })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("New name");
  });

  it("labels a section whose title has not arrived yet", () => {
    const groups = groupTabsByThread({ activeTabByThread: {}, tabs: [tab({ id: "a", threadTitle: undefined })] });
    expect(groups[0]?.title).toBe("Untitled section");
  });

  it("has nothing to group when nothing is open", () => {
    expect(groupTabsByThread({ tabs: [], activeTabByThread: {} })).toEqual([]);
  });
});
