/**
 * The shared vocabulary of the built-in browser.
 *
 * The browser is one surface with two drivers: the human clicks and types in the
 * panel, an agent drives the same tabs through `browser_*` tools. Both go through
 * the main process, which owns the tab list — so neither side can hold a view of
 * the browser that the other's actions do not update. This module is the part
 * both halves agree on: the tab shape, the URL rules, the scripts that get
 * injected into a page, and the way a tab is described back to an agent.
 *
 * Nothing here may import `electron`: the agent-facing helper (`peers-entry`)
 * and the renderer both pull from this file.
 *
 * ---------------------------------------------------------------------------
 * HOW THE PIECES FIT
 * ---------------------------------------------------------------------------
 *
 * Four surfaces, one source of truth. Read them in this order:
 *
 *   1. `shared/browser.ts` (here) — types, URL normalisation, the injected
 *      page scripts, and every string an agent reads back. Imported by all
 *      three of the others, which is what stops them drifting apart.
 *
 *   2. `main/browserService.ts` — the state and every operation. It owns the
 *      tab list; nothing else may hold tab state. It reaches a page through the
 *      guest `WebContents` id the renderer reports, and it takes that guest as a
 *      structural type (`GuestContents`) rather than importing `electron`, which
 *      is what makes the whole service testable against a fake page.
 *      Alongside it: `browserReaper.ts` (which idle tabs to release) and
 *      `browserAudit.ts` (the durable activity log).
 *
 *   3. `renderer/src/BrowserPanel.tsx` — the view. It renders what main tells
 *      it and hosts the actual pages as `<webview>` guests. The one thing it
 *      knows that main cannot is what a page is doing, so it reports navigation
 *      back (`browserReport`) and hands over the guest id on attach.
 *      `BrowserWindowApp.tsx` is the same panel rendered as a detached window.
 *
 *   4. `main/peers-entry.ts` — the agent's end. Each `browser_*` MCP tool (and
 *      its `panda-peers browser …` CLI twin) is one round trip over the peer
 *      unix socket to `runBrowserRequest` in `main/index.ts`, which calls the
 *      service. Unlike the backlog — a file the helper reads on its own — the
 *      browser exists only inside the running app, so there is no disk fallback.
 *
 * A human's click and an agent's tool call meet in the same service method. The
 * only difference between them is who the action is attributed to, which is why
 * "the agent left this page for you" is true rather than aspirational: there is
 * exactly one browser and both sides are looking at it.
 *
 * ---------------------------------------------------------------------------
 * WHO A TAB BELONGS TO
 * ---------------------------------------------------------------------------
 *
 * Every tab carries a `threadId`, and every operation is scoped to one section —
 * the same rule terminals follow. Where that id comes from depends on the
 * caller:
 *
 *   - an agent supplies its own section id (it is both `by` and `threadId`, and
 *     those have always been the same value);
 *   - the panel supplies the section the user is currently viewing;
 *   - a shell caller with no section of its own (`panda-peers browser …` typed
 *     into a terminal) acts on whatever section the user has in front of them,
 *     which main tracks via `browser:active-thread`.
 *
 * The isolation is enforced, not merely filtered: passing another section's tab
 * id is refused with a message saying so, rather than quietly working. An agent
 * that read a neighbour's transcript must not be able to navigate the page that
 * neighbour is working in. Consequences worth knowing:
 *
 *   - `browser_list` shows a section only its own tabs;
 *   - the 12-tab cap is per section, so the ceiling that actually bounds memory
 *     is the global awake cap in `browserReaper.ts`, not this one;
 *   - each section keeps its own active tab and its own slice of the activity
 *     log;
 *   - closing a section closes its tabs and stops any recording on them;
 *   - EVERY tab in the workspace stays mounted regardless, because unmounting a
 *     webview destroys the page — switching sections must not kill the work an
 *     agent is doing in another one.
 */

/**
 * Something an agent left on a page for the human to look at.
 *
 * This is the reason the browser is shared rather than headless: an agent that
 * has filled a form, reached a preview, or landed on a diff can stop and hand
 * the tab over instead of guessing. The note rides on the tab (so it survives
 * the human switching away and back) and, when it names a selector, is also
 * drawn onto the page itself.
 */
export type BrowserNote = {
  text: string;
  /** Section id that left it, so resolving it can answer that agent. */
  from?: string;
  /** That section's title at the time, for the banner. */
  fromTitle?: string;
  /** Element the note is about; outlined and scrolled to in the page. */
  selector?: string;
  at: string;
  /** Hidden by the user without resolving the hand-off or notifying its section. */
  hidden?: boolean;
};

export type BrowserTab = {
  id: string;
  /**
   * The section this tab belongs to.
   *
   * The browser is scoped the way terminals are: a section's pages are its own.
   * An agent sees and drives only its section's tabs, so two sections working in
   * parallel cannot navigate each other's pages out from under themselves, and
   * the user opening the panel in a section sees that section's work rather than
   * a pile of everyone's tabs.
   */
  threadId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Title of the section that opened it; absent when the human did. */
  openedBy?: string;
  /**
   * The section's title, for surfaces that show tabs from more than one.
   *
   * Carried on the tab rather than looked up, because the floating window shows
   * every section's tabs at once and has no thread list of its own to resolve
   * ids against.
   */
  threadTitle?: string;
  note?: BrowserNote;
  /** Frames are being grabbed off this tab right now. */
  recording?: boolean;
  /**
   * The page has been dropped to reclaim its process; the tab is still here.
   *
   * A tab is a renderer process — ~200 MB for a real app — so an idle one is
   * released the way an idle section is hibernated. Touching it reloads the URL
   * it was on, which costs a page load rather than anything the user has to
   * think about.
   */
  asleep?: boolean;
  /** Epoch ms of the last thing either driver did to it. Drives the sweep. */
  lastUsedAt?: number;
  /**
   * The user can actually see this page right now.
   *
   * Distinct from being a section's active tab: the panel may be closed, or the
   * user may be in another section entirely. Only the renderer knows, so it
   * reports it — and `browser_list` says so rather than implying it.
   */
  onScreen?: boolean;
};

export type BrowserState = {
  /** Every tab, across every section: the renderer keeps them all mounted. */
  tabs: BrowserTab[];
  /** Which tab is on top, per section. */
  activeTabByThread: Record<string, string>;
  /**
   * Whether the detached browser window is open.
   *
   * Main owns this because it decides which window HOSTS the pages. A guest can
   * only live in one window, so exactly one surface may mount webviews at a
   * time: when this is true the floating window does, and the docked panel shows
   * a placeholder instead.
   */
  floating?: boolean;
};

export const emptyBrowserState = (): BrowserState => ({ tabs: [], activeTabByThread: {} });

/** One group of tabs for the all-sections view. */
export type BrowserThreadGroup = {
  threadId: string;
  title: string;
  tabs: BrowserTab[];
};

/**
 * Tabs grouped by the section they belong to, for the floating window.
 *
 * Section order follows first appearance, which is the order tabs were opened —
 * stable as tabs come and go within a section, so groups do not reshuffle under
 * the pointer.
 */
export function groupTabsByThread(state: BrowserState): BrowserThreadGroup[] {
  const groups = new Map<string, BrowserThreadGroup>();
  for (const tab of state.tabs) {
    const existing = groups.get(tab.threadId);
    if (existing) {
      existing.tabs.push(tab);
      // A later tab may carry a fresher title than the one that opened the group.
      if (tab.threadTitle) existing.title = tab.threadTitle;
      continue;
    }
    groups.set(tab.threadId, {
      threadId: tab.threadId,
      title: tab.threadTitle || "Untitled section",
      tabs: [tab],
    });
  }
  return [...groups.values()];
}

/** One section's tabs, in the order they were opened. */
export function tabsForThread(state: BrowserState, threadId: string): BrowserTab[] {
  return state.tabs.filter((tab) => tab.threadId === threadId);
}

/** The tab a section is looking at, falling back to its first. */
export function activeTabForThread(state: BrowserState, threadId: string): BrowserTab | undefined {
  const mine = tabsForThread(state, threadId);
  const chosen = state.activeTabByThread[threadId];
  return mine.find((tab) => tab.id === chosen) ?? mine[0];
}

/** Agent-facing text is capped: a page's body can be megabytes of markup. */
export const PAGE_TEXT_CAP = 12_000;

/**
 * Every tab shares one persistent partition.
 *
 * That is the feature, not an implementation detail: a session the user logged
 * into by hand is the session the agent then works in, which is what makes
 * "check this page I can only see when signed in" possible at all. It is also
 * why the agent is told never to type a credential — it is already inside the
 * user's accounts.
 */
export const BROWSER_PARTITION = "persist:panda-browser";

/**
 * The user agent the guests present.
 *
 * Electron's default string carries `Electron/34` and the app name, and a
 * surprising number of sites either block it or serve a degraded page. Stripping
 * those two tokens leaves an ordinary Chrome UA, which is what the underlying
 * engine actually is.
 */
export function browserUserAgent(defaultAgent: string): string {
  return defaultAgent
    .replace(/\s*(Panda Code|Electron)\/[^\s]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Schemes a tab may be pointed at. `file:` is deliberately absent — see below. */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "about:"]);

/**
 * Turn what a human typed in the URL bar — or what an agent passed to
 * `browser_open` — into a URL to load.
 *
 * Bare hosts get `https://`, and anything that is not host-shaped becomes a
 * search, which is what both a person and an agent mean by typing words into a
 * browser. `file:` is refused: the agent already has the filesystem through its
 * own tools, and a page loaded from disk would sit in the same persistent
 * session as the user's real logins.
 */
export function normalizeUrl(input: string): { url: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No URL given." };
  }

  // `localhost:5173` is a host and a port, not a scheme and a path — and it is
  // the single most common thing anyone types into this bar, since it is where
  // the dev server is.
  const hostAndPort = /^[a-z][a-z0-9.-]*:\d+(\/.*)?$/i.test(trimmed);
  const hasScheme = !hostAndPort && /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (hasScheme) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { error: `Not a URL: ${trimmed}` };
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return { error: `Refusing to open a ${parsed.protocol} URL — the browser opens http(s) pages only.` };
    }
    return { url: parsed.toString() };
  }

  // No scheme: host-shaped (a dot, no spaces) reads as an address, everything
  // else as a search. `localhost[:port]` and bare IPv4 are addresses too.
  const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(trimmed);
  const hostShaped = local || hostAndPort || /^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(trimmed);
  if (hostShaped) {
    try {
      // A local address is a dev server, and a dev server is http.
      return { url: new URL(`${local ? "http" : "https"}://${trimmed}`).toString() };
    } catch {
      return { error: `Not a URL: ${trimmed}` };
    }
  }

  return { url: `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}` };
}

/** A short, human-readable label for a tab — the title, falling back to the host. */
export function tabLabel(tab: BrowserTab): string {
  if (tab.title.trim()) {
    return tab.title.trim();
  }
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url || "New tab";
  }
}

/** Clip agent-facing page text, saying so rather than trailing off silently. */
export function clip(text: string, cap = PAGE_TEXT_CAP): string {
  if (text.length <= cap) {
    return text;
  }
  return `${text.slice(0, cap)}\n\n[… ${text.length - cap} more characters. Narrow the read with a \`selector\`.]`;
}

// ---------------------------------------------------------------------------
// Injected scripts
//
// Each of these is evaluated in the page with `executeJavaScript`, so it has to
// be a self-contained expression returning something JSON-serializable. They are
// built as strings here (rather than in the main process) so the renderer's own
// tests can exercise them and so the two callers cannot drift apart.
// ---------------------------------------------------------------------------

/** JSON-encodes a value for splicing into injected source. */
function lit(value: unknown): string {
  // `JSON.stringify` can emit `</script`; nothing here goes into an inline
  // script tag, but escaping the sequence keeps that true if it ever does.
  return JSON.stringify(value ?? null).replace(/</g, "\\u003c");
}

/**
 * Query helpers spliced into every script below.
 *
 * `document.querySelector` stops at a shadow boundary, which in practice means
 * an agent cannot see into any app built out of web components — the element is
 * right there on screen and the selector finds nothing. `__deep` walks open
 * shadow roots as well, so "what the user can see" and "what the agent can
 * address" stay the same set. (Closed roots are genuinely unreachable; nothing
 * can be done about those from outside.)
 */
const PIERCE = `
  const __deep = (selector) => {
    const out = [];
    const walk = (root) => {
      try { out.push(...root.querySelectorAll(selector)); } catch { return; }
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out;
  };
  const __deepOne = (selector) => __deep(selector)[0] || null;
  const __candidates = () => {
    const out = [];
    const walk = (root) => {
      out.push(...root.querySelectorAll("a, button, [role=button], [role=link], [role=tab], [role=menuitem], input, select, textarea, summary, label, [onclick], [tabindex]"));
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out;
  };
  const __readable = (node) => ((node.innerText || node.value || node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("placeholder") || "")).trim();
`;

/**
 * Reaching, revealing and explaining an element. Spliced in after `PIERCE`,
 * whose `__deep`/`__readable` it builds on.
 *
 * All of this exists because of one failure that used to end a task outright:
 * "found it, but it is not visible on screen, so it cannot be clicked". A modern
 * app puts its form inside a nested `overflow: auto` pane, so the control an
 * agent wants is real, addressable, and forty pixels below the bottom of a div
 * the window knows nothing about. Finding it and then refusing to act on it is
 * the worst of both answers — so the rule here is: reveal first, and only report
 * a failure that scrolling could not fix, saying which one it is.
 */
const REACH = `
  /** Up one step, crossing out of an open shadow root the way a user's eye does. */
  const __host = (node) => { const root = node.getRootNode && node.getRootNode(); return root && root.host ? root.host : null; };
  const __up = (node) => node.parentElement || __host(node);

  /** Does this element scroll, and does it have anywhere to scroll to? */
  const __scrolls = (node) => {
    if (!node || node.nodeType !== 1) return false;
    const style = getComputedStyle(node);
    if (!/(auto|scroll|overlay)/.test(style.overflowY + " " + style.overflowX)) return false;
    return node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1;
  };

  /** The pane an element actually lives in — not the window, which is the bug. */
  const __scroller = (el) => {
    let node = __up(el);
    while (node && node !== document.body && node !== document.documentElement) {
      if (__scrolls(node)) return node;
      node = __up(node);
    }
    return null;
  };

  /** The page's main scroller, or the biggest scrollable pane on screen. */
  const __biggestScroller = () => {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 1) return doc;
    const vw = window.innerWidth || doc.clientWidth;
    const vh = window.innerHeight || doc.clientHeight;
    let best = null;
    let bestArea = 0;
    const walk = (root) => {
      for (const node of root.querySelectorAll("*")) {
        if (node.shadowRoot) walk(node.shadowRoot);
        if (!__scrolls(node)) continue;
        const rect = node.getBoundingClientRect();
        const area =
          Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0)) *
          Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
        if (area > bestArea) { bestArea = area; best = node; }
      }
    };
    walk(document);
    return best || doc;
  };

  /**
   * Bring an element into view, through however many nested panes it takes.
   *
   * \`scrollIntoView\` handles most of it, but it is defeated by a pane that is
   * itself clipped inside another one, and by a virtualised list that only
   * renders rows once its container has moved. Centring each scrollable ancestor
   * by hand afterwards is what makes a control in the third nested pane reachable.
   */
  const __reveal = (el) => {
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (error) { void error; }
    let node = __scroller(el);
    for (let guard = 0; node && guard < 6; guard += 1) {
      const box = node.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const dy = (rect.top + rect.height / 2) - (box.top + box.height / 2);
      const dx = (rect.left + rect.width / 2) - (box.left + box.width / 2);
      if (Math.abs(dy) > 4) node.scrollTop += dy;
      if (Math.abs(dx) > 4) node.scrollLeft += dx;
      node = __scroller(node);
    }
  };

  /** What is really on top at a point, descending into open shadow roots. */
  const __at = (x, y) => {
    let node = document.elementFromPoint(x, y);
    while (node && node.shadowRoot) {
      const inner = node.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === node) break;
      node = inner;
    }
    return node;
  };

  /**
   * Why can this element not be clicked? \`null\` means it can be.
   *
   * Called only after \`__reveal\`, so "below the fold" is no longer one of the
   * answers — every remaining reason is something scrolling cannot fix, and the
   * agent is told which one rather than a flat "not visible".
   */
  const __why = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "none") return "it is display:none";
    if (style.visibility === "hidden" || style.visibility === "collapse") return "it is visibility:" + style.visibility;
    if (Number(style.opacity) === 0) return "it is fully transparent (opacity:0)";
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return "it has zero size";
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= vh || rect.left >= vw) {
      return "it is still outside the viewport after scrolling to it";
    }
    // Sampled at three points, not one. A decorative overlay across the middle
    // of a control, or a label sitting over its own input, blocks the centre
    // while the element is perfectly clickable — and refusing those would break
    // clicks that used to work. Only something covering every sample is really
    // in the way.
    const clamp = (value, high) => Math.min(Math.max(value, 1), high - 1);
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + rect.width * 0.15, rect.top + rect.height * 0.5],
      [rect.left + rect.width * 0.85, rect.top + rect.height * 0.5],
    ];
    let blocker = null;
    for (const [px, py] of points) {
      const top = __at(clamp(px, vw), clamp(py, vh));
      if (!top || top === el || el.contains(top) || top.contains(el)) return null;
      blocker = blocker || top;
    }
    if (blocker) {
      const covering = __readable(blocker).slice(0, 60);
      return "<" + blocker.tagName.toLowerCase() + ">" + (covering ? " " + JSON.stringify(covering) : "") + " is covering it";
    }
    return null;
  };

  /**
   * The element that reads as a piece of text.
   *
   * Interactive elements first — "Save" means the button, not the section that
   * contains the word. Failing that, the innermost element carrying the text,
   * because on a page of hashed class names a label is often all an agent has,
   * and refusing to resolve it leaves nothing else to try.
   */
  const __byText = (needle) => {
    const wanted = String(needle).trim().toLowerCase();
    if (!wanted) return null;
    const candidates = __candidates();
    const exact = candidates.filter((node) => __readable(node).toLowerCase() === wanted);
    const partial = candidates.filter((node) => __readable(node).toLowerCase().includes(wanted));
    const pool = exact.length ? exact : partial;
    if (pool.length) return pool.sort((a, b) => __readable(a).length - __readable(b).length)[0];
    const leaves = [];
    const walk = (root) => {
      for (const node of root.querySelectorAll("*")) {
        if (node.shadowRoot) walk(node.shadowRoot);
        if (node.children.length) continue;
        if ((node.textContent || "").trim().toLowerCase().includes(wanted)) leaves.push(node);
      }
    };
    walk(document);
    if (!leaves.length) return null;
    return leaves.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0];
  };
`;

/**
 * Read the page as text.
 *
 * Deliberately not the raw DOM: an agent asking "what does this page say" wants
 * what a reader sees, so script/style/nav chrome is dropped and whitespace is
 * collapsed. `innerText` (not `textContent`) does the layout-aware part of that
 * for free — it respects `display: none` and inserts real line breaks.
 */
export function pageTextScript(selector?: string, withLinks = false): string {
  return `(() => {${PIERCE}
  const selector = ${lit(selector)};
  const root = selector ? __deepOne(selector) : document.body;
  if (!root) return { ok: false, error: "No element matches " + selector };
  const clone = root.cloneNode(true);
  for (const el of clone.querySelectorAll("script, style, noscript, svg, template")) el.remove();
  const text = (clone.innerText || clone.textContent || "").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
  const links = ${withLinks ? "true" : "false"}
    ? Array.from(root.querySelectorAll("a[href]"))
        .map((a) => ({ text: (a.innerText || "").trim().slice(0, 120), href: a.href }))
        .filter((l) => l.text && l.href.startsWith("http"))
        .slice(0, 100)
    : [];
  return { ok: true, title: document.title, url: location.href, text, links };
})()`;
}

/**
 * Locate a clickable element and report where it is on screen.
 *
 * Two ways to name one, because an agent has two kinds of knowledge about a
 * page: a CSS selector when it has read the markup, and visible text when all it
 * has is what the page says ("the Save button"). Text matching prefers the
 * smallest element that contains it, so asking for "Save" does not return the
 * whole form because the form contains the word.
 *
 * It returns a rect rather than clicking, so the caller can synthesize a real
 * mouse event at those coordinates — pages that ignore untrusted `.click()`
 * (file pickers, some popup flows) accept that one.
 */
export function findElementScript(selector?: string, text?: string, scroll = true): string {
  return `(() => {${PIERCE}${REACH}
  const selector = ${lit(selector)};
  const wanted = ${lit(text)};
  let el = null;
  if (selector) {
    el = __deepOne(selector);
    if (!el) return { ok: false, error: "No element matches " + selector };
  } else if (wanted) {
    el = __byText(wanted);
    if (!el) return { ok: false, error: "Nothing on the page reads " + JSON.stringify(wanted) };
  } else {
    return { ok: false, error: "Give either a selector or the visible text of the element." };
  }
  // Reveal before measuring: an element below the fold of a nested pane is a
  // scroll away from being clickable, and reporting it as unreachable was the
  // single most common dead end in a real app.
  if (${scroll ? "true" : "false"}) __reveal(el);
  const reason = __why(el);
  const rect = el.getBoundingClientRect();
  return {
    ok: true,
    visible: !reason,
    reason: reason || undefined,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    label: __readable(el).slice(0, 120),
    tag: el.tagName.toLowerCase(),
    inputType: (el.getAttribute && el.getAttribute("type")) || undefined,
  };
})()`;
}

/**
 * Wait for something to appear.
 *
 * The single biggest source of "the agent read the page too early": a load event
 * says the document arrived, not that the app finished rendering. This polls in
 * the page — cheap, and it resolves the instant the thing shows up rather than
 * on a fixed sleep. `executeJavaScript` resolves a returned promise, so the wait
 * happens in the page and the tool call simply takes that long to answer.
 */
export function waitForScript(selector: string | undefined, text: string | undefined, timeoutMs: number): string {
  return `(() => {${PIERCE}
  const selector = ${lit(selector)};
  const wanted = ${lit(text)};
  const deadline = Date.now() + ${Math.max(0, Math.floor(timeoutMs))};
  const hit = () => {
    if (selector) {
      const el = __deepOne(selector);
      return el && el.getBoundingClientRect().width > 0 ? { label: __readable(el).slice(0, 120) } : null;
    }
    const needle = String(wanted).toLowerCase();
    const found = __candidates().find((node) => __readable(node).toLowerCase().includes(needle));
    if (found) return { label: __readable(found).slice(0, 120) };
    return (document.body.innerText || "").toLowerCase().includes(needle) ? { label: wanted } : null;
  };
  return new Promise((resolve) => {
    const tick = () => {
      let found = null;
      try { found = hit(); } catch (error) { resolve({ ok: false, error: String(error) }); return; }
      if (found) { resolve({ ok: true, label: found.label, waitedMs: Date.now() - (deadline - ${Math.max(0, Math.floor(timeoutMs))}) }); return; }
      if (Date.now() >= deadline) { resolve({ ok: false, error: "Still not there after the wait ran out." }); return; }
      setTimeout(tick, 120);
    };
    tick();
  });
})()`;
}

/**
 * The attribute the chosen scroll container is tagged with, so a follow-up
 * probe can find the same one again after a real wheel event.
 */
export const SCROLLER_MARK = "data-panda-code-scroller";

/**
 * Move the viewport: to the top, to the bottom, to an element named by selector
 * or by its visible text, or by a delta.
 *
 * The delta case is the one that used to lie. It called `window.scrollBy`, so on
 * any app whose content lives in a nested `overflow: auto` pane it moved
 * nothing and cheerfully reported `y=0 of 786` — the window had nothing to
 * scroll, and the pane the agent meant was never touched. It now resolves the
 * pane that actually scrolls and moves that, reporting whether anything shifted
 * so the caller can fall back to a real wheel event when a page handles wheel
 * itself.
 */
export function scrollScript(target: string | undefined, deltaY: number | undefined, text?: string): string {
  return `(() => {${PIERCE}${REACH}
  const target = ${lit(target)};
  const wanted = ${lit(text)};
  const delta = ${typeof deltaY === "number" ? Math.round(deltaY) : "null"};
  const doc = document.scrollingElement || document.documentElement;
  const mark = ${lit(SCROLLER_MARK)};

  const describe = (node) => {
    if (node === doc || node === document.body) return "the page";
    const id = node.id ? "#" + node.id : "";
    const cls = typeof node.className === "string" && node.className.trim()
      ? "." + node.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    return "<" + node.tagName.toLowerCase() + id + cls + ">";
  };
  const report = (node, moved, label) => {
    for (const stale of __deep("[" + mark + "]")) stale.removeAttribute(mark);
    if (node !== doc) { try { node.setAttribute(mark, "1"); } catch (error) { void error; } }
    const rect = node === doc ? null : node.getBoundingClientRect();
    const vw = window.innerWidth || doc.clientWidth;
    const vh = window.innerHeight || doc.clientHeight;
    return {
      ok: true,
      moved,
      label: label || undefined,
      container: describe(node),
      scrollY: Math.round(node.scrollTop),
      pageHeight: Math.round(node.scrollHeight),
      viewHeight: Math.round(node === doc ? vh : node.clientHeight),
      // Where a real wheel event should be aimed if this did not move anything.
      x: Math.round(rect ? Math.min(Math.max(rect.left + rect.width / 2, 1), vw - 1) : vw / 2),
      y: Math.round(rect ? Math.min(Math.max(rect.top + rect.height / 2, 1), vh - 1) : vh / 2),
    };
  };

  if (target === "top" || target === "bottom") {
    const node = __biggestScroller();
    const before = node.scrollTop;
    node.scrollTop = target === "top" ? 0 : node.scrollHeight;
    return report(node, node.scrollTop !== before, undefined);
  }

  if (target || wanted) {
    const el = target ? __deepOne(target) : __byText(wanted);
    if (!el) {
      return {
        ok: false,
        error: target
          ? "No element matches " + target
          : "Nothing on the page reads " + JSON.stringify(wanted),
      };
    }
    __reveal(el);
    const node = __scroller(el) || doc;
    return report(node, true, __readable(el).slice(0, 120));
  }

  if (delta !== null) {
    const node = __biggestScroller();
    const before = node.scrollTop;
    node.scrollTop = before + delta;
    return report(node, Math.abs(node.scrollTop - before) > 0.5, undefined);
  }

  return { ok: false, error: "Give a target (\\"top\\", \\"bottom\\", a selector or \`text\`) or a pixel delta." };
})()`;
}

/**
 * Read back where the container a previous `scrollScript` chose has got to.
 *
 * Used after a synthesized wheel event, which happens outside the page and so
 * cannot report its own effect. The mark is cleared as it is read.
 */
export function scrollPositionScript(): string {
  return `(() => {${PIERCE}
  const doc = document.scrollingElement || document.documentElement;
  const marked = __deepOne("[" + ${lit(SCROLLER_MARK)} + "]");
  const node = marked || doc;
  if (marked) marked.removeAttribute(${lit(SCROLLER_MARK)});
  return {
    ok: true,
    scrollY: Math.round(node.scrollTop),
    pageHeight: Math.round(node.scrollHeight),
    viewHeight: Math.round(node === doc ? (window.innerHeight || doc.clientHeight) : node.clientHeight),
  };
})()`;
}

/**
 * Choose an option in a `<select>`.
 *
 * Clicking one opens a native popup that lives outside the page entirely, so
 * there is nothing for a synthesized mouse event to hit. Setting the value and
 * firing the events a real choice fires is the only way in — and it has to go
 * through the native setter, or React's onChange never hears about it.
 *
 * When the element is not a `<select>` at all — which is the common case now,
 * since every component library builds its dropdown out of divs — this reports
 * `aria: true` rather than failing, and the caller drives the ARIA pattern
 * instead. See `ariaOptionScript`.
 */
export function selectOptionScript(selector: string, value: string | undefined, label: string | undefined): string {
  return `(() => {${PIERCE}
  const el = __deepOne(${lit(selector)});
  if (!el) return { ok: false, error: "No element matches " + ${lit(selector)} };
  if (el.tagName.toLowerCase() !== "select") {
    const role = el.getAttribute("role") || "";
    const popup = el.getAttribute("aria-haspopup") || "";
    const combo =
      role === "combobox" || role === "listbox" || popup === "listbox" || popup === "menu" || popup === "true"
        ? el
        : el.querySelector("[role=combobox],[role=listbox],[aria-haspopup]") ||
          el.closest("[role=combobox],[role=listbox],[aria-haspopup]");
    return {
      ok: false,
      aria: true,
      role: combo ? combo.getAttribute("role") || combo.getAttribute("aria-haspopup") : undefined,
      error: "That is a <" + el.tagName.toLowerCase() + ">, not a <select>.",
    };
  }
  const wantValue = ${lit(value)};
  const wantLabel = ${lit(label)};
  const options = Array.from(el.options);
  const match =
    wantValue !== null ? options.find((option) => option.value === wantValue) : undefined;
  const byLabel =
    wantLabel !== null
      ? options.find((option) => option.text.trim() === String(wantLabel).trim()) ||
        options.find((option) => option.text.trim().toLowerCase().includes(String(wantLabel).trim().toLowerCase()))
      : undefined;
  const chosen = match || byLabel;
  if (!chosen) {
    return { ok: false, error: "No such option. Available: " + options.map((option) => option.text.trim()).slice(0, 25).join(" | ") };
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter ? setter.call(el, chosen.value) : (el.value = chosen.value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, label: chosen.text.trim(), value: chosen.value };
})()`;
}

/** Roles a popped-open dropdown's choices carry, in the order they are preferred. */
const OPTION_ROLES = "[role=option],[role=menuitemradio],[role=menuitemcheckbox],[role=menuitem],[role=treeitem]";

/**
 * Wait for a just-opened dropdown's options and find the one that was asked for.
 *
 * The hard part is *where to look*. A component library portals its popup to
 * `document.body`, so the options are nowhere near the trigger that opened them —
 * any search confined to the trigger's subtree finds nothing, which is why
 * "click the trigger, then click the option" fails on most real apps. This
 * searches the whole document (and open shadow roots), polls until the popup
 * renders, and reveals the match before reporting its rect so a long listbox
 * does not hand back a point that is scrolled out of view.
 *
 * On failure it lists what the popup *does* offer — the agent's next move is
 * almost always to pick a differently-worded option, not to try again.
 */
export function ariaOptionScript(label: string | undefined, value: string | undefined, timeoutMs: number): string {
  return `(() => {${PIERCE}${REACH}
  const wantLabel = ${lit(label)};
  const wantValue = ${lit(value)};
  const deadline = Date.now() + ${Math.max(0, Math.floor(timeoutMs))};
  const needle = wantLabel === null ? null : String(wantLabel).trim().toLowerCase();

  const options = () => __deep(${lit(OPTION_ROLES)}).filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || node.offsetParent !== null;
  });
  const nameOf = (node) => (__readable(node) || node.getAttribute("aria-label") || "").trim();
  const match = (pool) => {
    if (wantValue !== null) {
      const byValue = pool.find(
        (node) =>
          node.getAttribute("data-value") === wantValue ||
          node.getAttribute("value") === wantValue ||
          node.id === wantValue,
      );
      if (byValue) return byValue;
    }
    if (needle === null) return null;
    return (
      pool.find((node) => nameOf(node).toLowerCase() === needle) ||
      pool.find((node) => nameOf(node).toLowerCase().includes(needle)) ||
      null
    );
  };

  return new Promise((resolve) => {
    const tick = () => {
      let pool = [];
      try { pool = options(); } catch (error) { resolve({ ok: false, error: String(error) }); return; }
      const found = pool.length ? match(pool) : null;
      if (found) {
        __reveal(found);
        const reason = __why(found);
        const rect = found.getBoundingClientRect();
        resolve({
          ok: true,
          visible: !reason,
          reason: reason || undefined,
          label: nameOf(found).slice(0, 120),
          tag: found.tagName.toLowerCase(),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        });
        return;
      }
      if (Date.now() >= deadline) {
        const offered = pool.map((node) => nameOf(node)).filter(Boolean).slice(0, 25);
        resolve({
          ok: false,
          error: pool.length
            ? "The dropdown is open but has no such option. It offers: " + offered.join(" | ")
            : "No dropdown options appeared after clicking it — the trigger may not be the control that opens the list.",
        });
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
})()`;
}

/**
 * What a combobox says it is set to now.
 *
 * The point of the exercise: an agent that changed a dropdown has to be able to
 * state what it changed it to from the DOM, not from a screenshot.
 */
export function comboStateScript(selector: string): string {
  return `(() => {${PIERCE}
  const el = __deepOne(${lit(selector)});
  if (!el) return { ok: false, error: "No element matches " + ${lit(selector)} };
  const active = el.getAttribute("aria-activedescendant");
  const target = active ? document.getElementById(active) : null;
  const selected = __deep("[role=option][aria-selected=true]")[0];
  return {
    ok: true,
    text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 120),
    active: target ? (target.innerText || "").trim().slice(0, 120) : undefined,
    selected: selected ? (selected.innerText || "").trim().slice(0, 120) : undefined,
    expanded: el.getAttribute("aria-expanded") || undefined,
  };
})()`;
}

/**
 * Report the state of elements, rather than the words on the page.
 *
 * `browser_read` gives rendered text, which cannot answer "what is in that
 * field" — an agent that had just typed a name could only read it back off a
 * screenshot, which is precisely the evidence it is not supposed to rely on.
 * This is also how selectors get discovered: on a site with hashed class names
 * guessing is the only alternative, and guessing does not work. Every match
 * comes back with a selector that will address it again.
 */
export function inspectScript(args: {
  selector?: string;
  text?: string;
  role?: string;
  within?: string;
  limit?: number;
}): string {
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
  return `(() => {${PIERCE}${REACH}
  const selector = ${lit(args.selector)};
  const wanted = ${lit(args.text)};
  const role = ${lit(args.role)};
  const within = ${lit(args.within)};
  const limit = ${limit};

  const root = within ? __deepOne(within) : null;
  if (within && !root) return { ok: false, error: "No element matches " + within };
  const inRoot = (node) => !root || root.contains(node);

  const FORM = "input,select,textarea,[contenteditable=true],[role=combobox],[role=listbox],[role=textbox],[role=checkbox],[role=switch],[role=radio],[role=spinbutton],[role=slider]";
  const IMPLICIT = { a: "link", button: "button", select: "combobox", textarea: "textbox", input: "textbox", summary: "button", form: "form", nav: "navigation" };
  const roleOf = (node) => node.getAttribute("role") || IMPLICIT[node.tagName.toLowerCase()] || "";

  /** The name a screen reader would announce — and an agent would recognise. */
  const nameOf = (node) => {
    const labelledBy = node.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((el) => (el.innerText || "").trim())
        .join(" ")
        .trim();
      if (text) return text;
    }
    const aria = node.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    if (node.id) {
      const label = __deepOne("label[for=" + JSON.stringify(node.id) + "]");
      if (label && (label.innerText || "").trim()) return (label.innerText || "").trim();
    }
    const wrapping = node.closest ? node.closest("label") : null;
    if (wrapping && (wrapping.innerText || "").trim()) return (wrapping.innerText || "").trim();
    return (node.getAttribute("placeholder") || node.getAttribute("title") || node.getAttribute("alt") || (node.innerText || "")).trim();
  };

  /** A selector that will find this element again — the whole point of discovery. */
  const selectorFor = (node) => {
    const id = node.id;
    if (id && /^[A-Za-z][\\w:.-]*$/.test(id)) return "#" + id;
    for (const attr of ["data-testid", "data-test-id", "data-test", "data-qa", "name"]) {
      const found = node.getAttribute(attr);
      if (found) {
        const candidate = (attr === "name" ? node.tagName.toLowerCase() : "") + "[" + attr + "=" + JSON.stringify(found) + "]";
        if (__deep(candidate).length === 1) return candidate;
      }
    }
    const aria = node.getAttribute("aria-label");
    if (aria) {
      const candidate = "[aria-label=" + JSON.stringify(aria) + "]";
      if (__deep(candidate).length === 1) return candidate;
    }
    const parts = [];
    let cursor = node;
    while (cursor && cursor.nodeType === 1 && parts.length < 6) {
      let part = cursor.tagName.toLowerCase();
      const parent = cursor.parentElement;
      if (!parent) { parts.unshift(part); break; }
      const twins = Array.from(parent.children).filter((child) => child.tagName === cursor.tagName);
      if (twins.length > 1) part += ":nth-of-type(" + (twins.indexOf(cursor) + 1) + ")";
      parts.unshift(part);
      if (cursor.id) { parts[0] = "#" + cursor.id; break; }
      cursor = parent;
    }
    return parts.join(" > ");
  };

  let pool = [];
  if (selector) {
    pool = __deep(selector);
    if (!pool.length) return { ok: false, error: "No element matches " + selector };
  } else if (role) {
    pool = __deep("*").filter((node) => roleOf(node) === role);
    if (!pool.length) return { ok: false, error: "Nothing on the page has the role " + JSON.stringify(role) };
  } else if (wanted) {
    const needle = String(wanted).trim().toLowerCase();
    pool = __deep("*").filter((node) => !node.children.length && (node.textContent || "").toLowerCase().includes(needle));
    const controls = __deep(FORM).filter((node) => nameOf(node).toLowerCase().includes(needle) || (node.innerText || "").toLowerCase().includes(needle));
    pool = [...new Set([...controls, ...pool])];
    if (!pool.length) return { ok: false, error: "Nothing on the page reads " + JSON.stringify(wanted) };
  } else {
    pool = __deep(FORM);
    if (!pool.length) return { ok: false, error: "This page has no form controls to report." };
  }

  pool = pool.filter(inRoot);
  const total = pool.length;
  const matches = pool.slice(0, limit).map((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const onScreen =
      rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
      rect.bottom > 0 && rect.right > 0 && rect.top < (window.innerHeight || 0) && rect.left < (window.innerWidth || 0);
    const value =
      typeof node.value === "string" ? node.value : node.isContentEditable ? (node.innerText || "") : undefined;
    return {
      selector: selectorFor(node),
      tag: node.tagName.toLowerCase(),
      role: roleOf(node) || undefined,
      name: nameOf(node).slice(0, 120) || undefined,
      type: node.getAttribute("type") || undefined,
      value: value === undefined ? undefined : String(value).slice(0, 200),
      checked: typeof node.checked === "boolean" ? node.checked : undefined,
      selected: node.getAttribute("aria-selected") ?? (typeof node.selected === "boolean" ? String(node.selected) : undefined),
      expanded: node.getAttribute("aria-expanded") || undefined,
      disabled: node.disabled === true || node.getAttribute("aria-disabled") === "true" || undefined,
      visible: onScreen,
      box: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
  });
  return { ok: true, total, matches };
})()`;
}

/** What `browser_inspect` — and `browser_read`'s `values` — hand back. */
export type InspectedElement = {
  selector: string;
  tag: string;
  role?: string;
  name?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  selected?: string;
  expanded?: string;
  disabled?: boolean;
  visible: boolean;
  box: { x: number; y: number; w: number; h: number };
};

/** Element state as a table an agent reads — one row per match, state over prose. */
export function renderInspect(result: { total: number; matches: InspectedElement[] }): string {
  if (!result.matches.length) {
    return "Nothing matched.";
  }
  const rows = result.matches.map((match) => {
    const state: string[] = [];
    if (match.value !== undefined) state.push(`value=${JSON.stringify(match.value)}`);
    if (match.checked !== undefined) state.push(`checked=${match.checked}`);
    if (match.selected !== undefined) state.push(`selected=${match.selected}`);
    if (match.expanded !== undefined) state.push(`expanded=${match.expanded}`);
    if (match.disabled) state.push("disabled");
    state.push(match.visible ? "on screen" : "off screen");
    const name = match.name ? ` "${match.name}"` : "";
    const role = match.role ? ` role=${match.role}` : "";
    const type = match.type ? ` type=${match.type}` : "";
    return `- \`${match.selector}\` — <${match.tag}>${type}${role}${name}\n  - ${state.join(" · ")}`;
  });
  const more = result.total > result.matches.length ? `\n\n(${result.total - result.matches.length} more matched; narrow it or raise \`limit\`.)` : "";
  return `${result.total} element${result.total === 1 ? "" : "s"} matched:\n\n${rows.join("\n")}${more}`;
}

/**
 * Does this frame contain the thing we are looking for, and where is it?
 *
 * Run in each frame in turn when the main document comes up empty. The rect it
 * reports is relative to that frame's own viewport, which is why the caller then
 * has to add the frame's offset in the page — see `frameOffsetScript`.
 */
export function frameProbeScript(selector?: string, text?: string): string {
  return findElementScript(selector, text);
}

/**
 * Where a child frame sits inside its parent document.
 *
 * A rect from inside an iframe is in that iframe's coordinates; a synthesized
 * mouse event is delivered in the top-level page's. Matching the frame by URL is
 * how the two get reconciled without needing to reach across an origin boundary
 * that the browser would not let us cross anyway.
 */
export function frameOffsetScript(frameUrl: string): string {
  return `(() => {
  const wanted = ${lit(frameUrl)};
  const frames = Array.from(document.querySelectorAll("iframe, frame"));
  const match = frames.find((frame) => frame.src === wanted) || frames.find((frame) => wanted.startsWith(frame.src));
  if (!match) return { ok: false, error: "This document has no frame at " + wanted };
  const rect = match.getBoundingClientRect();
  return { ok: true, x: Math.round(rect.left), y: Math.round(rect.top) };
})()`;
}

/** Focus a field so text can be typed into it, clearing it first when asked. */
export function focusFieldScript(selector: string, clear: boolean): string {
  return `(() => {${PIERCE}${REACH}
  const el = __deepOne(${lit(selector)});
  if (!el) return { ok: false, error: "No element matches " + ${lit(selector)} };
  __reveal(el);
  const reason = __why(el);
  if (reason) return { ok: false, error: "Found " + el.tagName.toLowerCase() + " but " + reason + ", so it cannot be typed into." };
  el.focus();
  if (${clear ? "true" : "false"}) {
    if ("value" in el) {
      // Set through the native setter so React's onChange sees the reset too.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter ? setter.call(el, "") : (el.value = "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = "";
    }
  }
  // The input's type comes back so the audit trail can redact a password even
  // when nothing about the selector suggested one.
  return { ok: true, tag: el.tagName.toLowerCase(), inputType: el.getAttribute && el.getAttribute("type") };
})()`;
}

/** The id of the overlay an agent's note draws into the page. */
export const NOTE_OVERLAY_ID = "__panda_code_note__";

/**
 * Draw an agent's note onto the page itself.
 *
 * The banner in the panel already says a note exists; this puts it *where the
 * thing is*, because "check the total on the third row" is a sentence about a
 * place. When the note names a selector the element is ringed and scrolled to,
 * so the human lands on it rather than hunting.
 *
 * The overlay lives on `document.documentElement` at a very high z-index and is
 * removed on the next navigation by the page reload itself.
 */
export function drawNoteScript(note: BrowserNote): string {
  return `(() => {
  const id = ${lit(NOTE_OVERLAY_ID)};
  document.getElementById(id)?.remove();
  const selector = ${lit(note.selector)};
  const target = selector ? document.querySelector(selector) : null;
  if (target) {
    target.scrollIntoView({ block: "center", inline: "center" });
    target.style.outline = "3px solid #d0a85d";
    target.style.outlineOffset = "2px";
  }
  const box = document.createElement("div");
  box.id = id;
  box.setAttribute("data-panda-code", "note");
  box.style.cssText = [
    "position:fixed", "z-index:2147483647", "left:16px", "right:16px", "bottom:16px",
    "margin:0 auto", "max-width:620px", "padding:12px 14px", "border-radius:10px",
    "border:1px solid rgba(208,168,93,.55)", "background:#161b22", "color:#dbe1ea",
    "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "box-shadow:0 10px 30px rgba(0,0,0,.45)", "pointer-events:none", "white-space:pre-wrap",
  ].join(";");
  const from = ${lit(note.fromTitle ?? "An agent")};
  box.textContent = from + " left this for you:\\n" + ${lit(note.text)};
  document.documentElement.appendChild(box);
  return { ok: true, anchored: Boolean(target) };
})()`;
}

// ---------------------------------------------------------------------------
// The cursor
//
// Every mouse op in this service already sends a real, trusted mouse event —
// what it did not have was a POINTER: somewhere the mouse persistently is,
// between calls. That absence is why an agent could only ever act through
// controls it could name. A page whose menu opens on hover and closes the
// instant the pointer leaves, a canvas, a map, a drag handle, a custom slider —
// none of those have a selector to click, and all of them behave correctly the
// moment there is a cursor that stays where it was put.
//
// Three things make it real rather than a metaphor: the position lives on the
// tab, the events are the same trusted ones a human generates, and the cursor is
// DRAWN into the page so the user watching the panel can see where the agent's
// hand is. A screenshot then shows it too, for free.
// ---------------------------------------------------------------------------

/** The id of the element the agent's cursor is drawn into. */
export const CURSOR_OVERLAY_ID = "__panda_code_cursor__";

/**
 * Draw the agent's cursor at a point.
 *
 * `pointer-events: none` throughout, which matters for more than politeness:
 * `elementFromPoint` skips such elements, so the cursor can never end up
 * reporting itself as the thing under the cursor.
 */
export function drawCursorScript(x: number, y: number, options: { down?: boolean; label?: string } = {}): string {
  return `(() => {
  const id = ${lit(CURSOR_OVERLAY_ID)};
  let box = document.getElementById(id);
  if (!box) {
    box = document.createElement("div");
    box.id = id;
    box.setAttribute("data-panda-code", "cursor");
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;left:0;top:0;width:0;height:0";
    box.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22" style="position:absolute;left:-2px;top:-2px;overflow:visible">' +
      '<path d="M3 2 L3 16 L7 12.5 L9.5 18 L12 17 L9.5 11.5 L14.5 11.5 Z" fill="#f6f8fa" stroke="#161b22" stroke-width="1.4" stroke-linejoin="round"/>' +
      '</svg>' +
      '<div data-ring style="position:absolute;left:-13px;top:-13px;width:26px;height:26px;border-radius:50%;border:2px solid #d0a85d;opacity:0;transition:opacity .12s"></div>' +
      '<div data-label style="position:absolute;left:16px;top:14px;padding:2px 6px;border-radius:5px;background:#161b22;color:#dbe1ea;' +
      "font:11px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.4);opacity:0\"></div>";
    document.documentElement.appendChild(box);
  }
  box.style.transform = "translate(" + ${lit(Math.round(x))} + "px," + ${lit(Math.round(y))} + "px)";
  const ring = box.querySelector("[data-ring]");
  if (ring) ring.style.opacity = ${options.down ? '"1"' : '"0"'};
  const label = box.querySelector("[data-label]");
  const text = ${lit(options.label ?? "")};
  if (label) { label.textContent = text; label.style.opacity = text ? "1" : "0"; }
  return { ok: true };
})()`;
}

/** Take the cursor back off the page. */
export function clearCursorScript(): string {
  return `(() => {
  document.getElementById(${lit(CURSOR_OVERLAY_ID)})?.remove();
  return { ok: true };
})()`;
}

/**
 * What is under a point, and how the page's coordinate space is laid out.
 *
 * The second half is what makes a screenshot actionable. A capture is in device
 * pixels; clicks are in CSS pixels; without the ratio between them an agent
 * reading a PNG has no way to turn "the button is at (840, 420) in this image"
 * into a click that lands. Reporting what is actually at the point is the other
 * half — it turns a blind coordinate click into one the agent can verify before
 * committing to it.
 */
export function pointProbeScript(x: number, y: number): string {
  return `(() => {${PIERCE}${REACH}
  const x = ${Math.round(x)};
  const y = ${Math.round(y)};
  const doc = document.scrollingElement || document.documentElement;
  const el = __at(x, y);
  const describe = (node) => {
    if (!node) return undefined;
    const id = node.id ? "#" + node.id : "";
    const role = node.getAttribute && node.getAttribute("role");
    const name = __readable(node).slice(0, 80);
    return {
      tag: node.tagName.toLowerCase() + id,
      role: role || undefined,
      label: name || undefined,
      clickable: Boolean(node.closest && node.closest("a,button,[role=button],[role=link],[role=option],input,select,textarea,[onclick],[tabindex]")),
    };
  };
  return {
    ok: true,
    under: describe(el),
    viewport: {
      width: Math.round(window.innerWidth || doc.clientWidth),
      height: Math.round(window.innerHeight || doc.clientHeight),
      scale: window.devicePixelRatio || 1,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    },
  };
})()`;
}

/** Take an agent's note back off the page once the human has dealt with it. */
export function clearNoteScript(selector?: string): string {
  return `(() => {
  document.getElementById(${lit(NOTE_OVERLAY_ID)})?.remove();
  const selector = ${lit(selector)};
  if (selector) {
    const el = document.querySelector(selector);
    if (el) { el.style.outline = ""; el.style.outlineOffset = ""; }
  }
  return { ok: true };
})()`;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/** Key names as they get written, mapped to the ones Electron's input events use. */
const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

const MODIFIER_ALIASES: Record<string, string> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  ctrl: "control",
  control: "control",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/**
 * Parse a key chord an agent wrote — "Escape", "Cmd+A", "ctrl+shift+k".
 *
 * Pure, and separate from the sending, because the failure mode worth catching
 * is a typo'd key name turning into a silent no-op: a chord that does not parse
 * has to come back as an error the agent can read, not as a keystroke nobody
 * receives.
 */
export function parseKeyChord(chord: string): { keyCode: string; modifiers: string[] } | { error: string } {
  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return { error: "No key given." };
  }

  const keyPart = parts[parts.length - 1] as string;
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) {
      return { error: `Unknown modifier "${part}". Use cmd, ctrl, alt or shift.` };
    }
    if (!modifiers.includes(modifier)) {
      modifiers.push(modifier);
    }
  }

  const alias = KEY_ALIASES[keyPart.toLowerCase()];
  if (alias) {
    return { keyCode: alias, modifiers };
  }
  if (/^F\d{1,2}$/i.test(keyPart)) {
    return { keyCode: keyPart.toUpperCase(), modifiers };
  }
  if (keyPart.length === 1) {
    return { keyCode: keyPart.toUpperCase(), modifiers };
  }
  return { error: `Unknown key "${keyPart}". Try a single character, or Escape/Tab/Enter/ArrowDown/F5.` };
}

// ---------------------------------------------------------------------------
// Telemetry
//
// Every action against the browser — the agent's and the human's alike — leaves
// one of these. It is the audit trail the user asked for and, just as much, the
// thing that makes a misbehaving run explicable afterwards: who did what, to
// which page, with what arguments, and what came back.
// ---------------------------------------------------------------------------

export type BrowserActivity = {
  at: string;
  /** Section the action happened in. */
  threadId?: string;
  /** Section id behind the action; absent when the human did it themselves. */
  actorId?: string;
  /** Display name: the section's title, or "You". */
  actor: string;
  action: string;
  tabId?: string;
  /** The page it happened on, as it was at the time. */
  url?: string;
  /** Arguments, clipped and redacted. */
  detail?: string;
  ok: boolean;
  /** How long the whole op took, including any page wait. */
  ms: number;
  /** One line of what came back — the error text when it failed. */
  outcome?: string;
};

/** Detail lines are for scanning, not for storing a page in the log. */
const DETAIL_CAP = 160;

/**
 * What an action's arguments looked like, fit to be written down.
 *
 * Typing is the one that needs care: the log is meant to be readable later, and
 * the field being typed into may be a password box. The agent is told never to
 * type a credential, but a log that would record one if it did is a worse
 * failure than the one it is auditing.
 */
/** Audit URLs keep the location, never credentials, query values or fragments. */
export function redactBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.search && !url.hash) return value;
    url.username = ""; url.password = "";
    const hadQuery = Boolean(url.search);
    url.search = ""; url.hash = "";
    return `${url.toString()}${hadQuery ? "?redacted" : ""}`;
  } catch { return "[invalid URL]"; }
}

export function summarizeArgs(
  action: string,
  args: { url?: string; selector?: string; text?: string; inputType?: string; keys?: string; paths?: string[] },
): string | undefined {
  const parts: string[] = [];
  if (args.url) parts.push(redactBrowserUrl(args.url));
  if (args.selector) parts.push(`selector=${args.selector}`);
  if (args.keys) parts.push(`keys=${args.keys}`);
  if (args.paths?.length) parts.push(`files=${args.paths.join(", ")}`);
  if (args.text) {
    const secret = action === "type" && (args.inputType === "password" || /pass|secret|token|otp|cvv/i.test(args.selector ?? ""));
    parts.push(secret ? "text=[redacted]" : `text=${JSON.stringify(args.text)}`);
  }
  const detail = parts.join(" ");
  if (!detail) return undefined;
  return detail.length > DETAIL_CAP ? `${detail.slice(0, DETAIL_CAP)}…` : detail;
}

/** The activity log as text — the same rendering for the panel and for an agent. */
export function renderActivity(records: readonly BrowserActivity[], limit = 40): string {
  if (!records.length) {
    return "Nothing has happened in the browser yet.";
  }

  const shown = records.slice(-limit);
  const lines = shown.map((record) => {
    const time = record.at.slice(11, 19);
    const status = record.ok ? "ok" : "FAILED";
    const bits = [record.detail, record.outcome].filter(Boolean).join(" → ");
    const tab = record.tabId ? ` \`${record.tabId}\`` : "";
    return `- ${time} · ${record.actor} · **${record.action}**${tab} · ${status} · ${record.ms}ms${bits ? `\n  - ${bits}` : ""}`;
  });
  const head = `${records.length} action${records.length === 1 ? "" : "s"} recorded${shown.length < records.length ? `, newest ${shown.length}` : ""}:`;
  return [head, "", ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Agent-facing rendering
// ---------------------------------------------------------------------------

/** One tab as a line an agent reads. */
export function renderTabLine(tab: BrowserTab, active: boolean): string {
  const marks: string[] = [];
  // "The section's front tab" and "the user can see it" are different claims,
  // and conflating them told agents a page was on screen when the panel was
  // closed. Both are reported, separately.
  if (tab.onScreen) marks.push("on screen now");
  else if (active) marks.push("this section's front tab, but the browser is not on screen");
  if (tab.asleep) marks.push("asleep — touching it reloads the page");
  if (tab.loading) marks.push("loading");
  if (tab.openedBy) marks.push(`opened by ${tab.openedBy}`);
  const suffix = marks.length ? ` · ${marks.join(" · ")}` : "";
  const note = tab.note ? `\n  - note awaiting the user: ${tab.note.text}` : "";
  return `- \`${tab.id}\` **${tabLabel(tab)}**${suffix}\n  - ${tab.url}${note}`;
}

/**
 * This section's browser, as an agent sees it.
 *
 * Scoped to one section on purpose: an agent listing tabs wants the ones it can
 * act on, and showing it a neighbouring section's pages would invite it to drive
 * them.
 */
export function renderBrowser(state: BrowserState, threadId: string): string {
  const mine = tabsForThread(state, threadId);
  if (!mine.length) {
    const elsewhere = state.tabs.length;
    return [
      "This section's browser has no tabs open.",
      "",
      "`browser_open` opens one — it is a real, visible browser the user is looking at, sharing their logged-in session,",
      "not a headless fetch. Anything you open stays on their screen until you or they close it.",
      ...(elsewhere
        ? [
            "",
            `(${elsewhere} tab${elsewhere === 1 ? " is" : "s are"} open in other sections. Tabs belong to the section that opened them, so those are not yours to drive.)`,
          ]
        : []),
    ].join("\n");
  }

  const active = activeTabForThread(state, threadId);
  const lines = mine.map((tab) => renderTabLine(tab, tab.id === active?.id));
  const hidden = mine.every((tab) => !tab.onScreen);
  return [
    `${mine.length} tab${mine.length === 1 ? "" : "s"} open in this section's browser:`,
    "",
    ...lines,
    ...(hidden
      ? [
          "",
          "None of them is on screen right now — the panel is closed, or the user is in another section.",
          "`browser_screenshot` still works: by default it brings the tab up to photograph it, and with `background: true`",
          "it renders the page instead and leaves the user's screen alone. If you want the user LOOKING at it,",
          "`browser_note` brings the panel up and puts your note on the page.",
        ]
      : []),
  ].join("\n");
}

/** What `browser_read` hands back. */
export function renderPageRead(page: { title: string; url: string; text: string; links: { text: string; href: string }[] }): string {
  const head = `# ${page.title || "(untitled)"}\n${page.url}\n`;
  const body = clip(page.text);
  if (!page.links.length) {
    return `${head}\n${body}`;
  }
  const links = page.links.map((link) => `- [${link.text}](${link.href})`).join("\n");
  return `${head}\n${body}\n\n## Links\n${links}`;
}
