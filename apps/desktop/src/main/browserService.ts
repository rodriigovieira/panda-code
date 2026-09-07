import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectShotEvictions, selectTabEvictions } from "./browserReaper";
import {
  ariaOptionScript,
  clearCursorScript,
  clearNoteScript,
  comboStateScript,
  drawCursorScript,
  drawNoteScript,
  findElementScript,
  focusFieldScript,
  frameOffsetScript,
  inspectScript,
  normalizeUrl,
  pageTextScript,
  parseKeyChord,
  pointProbeScript,
  renderActivity,
  renderBrowser,
  renderInspect,
  renderPageRead,
  renderTabLine,
  scrollPositionScript,
  scrollScript,
  selectOptionScript,
  summarizeArgs,
  type InspectedElement,
  tabLabel,
  waitForScript,
  type BrowserActivity,
  type BrowserNote,
  type BrowserState,
  type BrowserTab,
} from "../shared/browser";

/**
 * The built-in browser, main-process side.
 *
 * Two design decisions everything else follows from.
 *
 * **Main owns the tab list, and both drivers go through it.** The human's URL bar and the agent's
 * `browser_navigate` land in the same `navigate()`; the renderer holds no tab
 * state of its own, it renders what it is told and reports what the page did.
 * That is what makes "the agent left something on this page for you" true rather
 * than aspirational — there is exactly one browser, and both sides see the same
 * one.
 *
 * The pages themselves live in `<webview>` elements in the renderer (the panel
 * has to lay out, clip and stack with the rest of the UI, which a
 * `WebContentsView` pinned over the window does not do). Main reaches each
 * guest's `WebContents` by the id the renderer reports on attach.
 *
 * **Tabs belong to a section.** Every op is scoped to one: an agent's calls
 * carry its own section id, the panel's carry the section the user is looking
 * at, and neither can reach a tab belonging to a third. That is what keeps two
 * sections working in parallel from navigating each other's pages, and it is the
 * same rule terminals already follow.
 *
 * Nothing here imports `electron`. The guest is described by the structural
 * types below and handed in, which keeps the whole service — every op, the frame
 * walking, the audit trail — testable against a fake page.
 */

/** A frame in a guest page: the main document, or anything nested in it. */
export type GuestFrame = {
  url: string;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  /** Every frame below this one, main frame excluded. Only asked of the main frame. */
  framesInSubtree?: GuestFrame[];
  parent?: GuestFrame | null;
};

/** The part of Electron's `WebContents` this service uses. */
export type GuestContents = {
  isDestroyed: () => boolean;
  isLoading: () => boolean;
  loadURL: (url: string) => Promise<unknown>;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  focus: () => void;
  insertText: (text: string) => void;
  sendInputEvent: (event: Record<string, unknown>) => void;
  capturePage: () => Promise<{ toPNG: () => Buffer }>;
  /** Keep a guest scheduled while its owning app window is backgrounded. */
  setBackgroundThrottling?: (allowed: boolean) => void;
  /** Ask Chromium to repaint after the renderer has staged this guest. */
  invalidate?: () => void;
  reload: () => void;
  navigationHistory: {
    canGoBack: () => boolean;
    canGoForward: () => boolean;
    goBack: () => void;
    goForward: () => void;
  };
  on: (event: string, listener: () => void) => void;
  off: (event: string, listener: () => void) => void;
  mainFrame: GuestFrame;
  /** Chrome DevTools Protocol, used for the one thing no injected script can do. */
  debugger?: {
    isAttached: () => boolean;
    attach: (version?: string) => void;
    detach: () => void;
    sendCommand: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

/** More than this many tabs in one section is a runaway agent, not a workflow. */
const TAB_CAP = 12;

/** How long a fresh tab has to attach its webview before we give up on it. */
const ATTACH_TIMEOUT_MS = 15_000;

/** How long any single navigation is waited on before reporting what loaded. */
const LOAD_TIMEOUT_MS = 30_000;

/** Ceiling on a script's run time, so a wedged page cannot hang an agent's turn. */
const SCRIPT_TIMEOUT_MS = 15_000;

/** Ceiling on an explicit wait. Longer than this is a page that is not coming. */
export const MAX_WAIT_MS = 60_000;

/**
 * Ceiling on one capture attempt, per stage.
 *
 * A real capture of a real page is tens of milliseconds; a slow one on a
 * swapping machine is a second or two. Ten is generous enough that a loaded box
 * still gets its screenshot, and short enough that both stages plus the
 * attach/detach still fit inside an agent's patience.
 */
const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * Ceiling on `capturePage` when the tab IS on screen.
 *
 * Measured over 217 real screenshots in the activity log: the ones that worked
 * had a median of 39ms, and 64 of 99 finished inside a second. So a painted tab
 * that has not answered in two seconds is not a slow capture, it is a capture
 * that is not coming — and the eight remaining seconds of the general ceiling
 * bought nothing but an agent staring at a wall.
 */
const PAINTED_CAPTURE_TIMEOUT_MS = 2_000;

/**
 * Ceiling on a whole `screenshot`, end to end.
 *
 * The per-stage ceilings never bounded the op. `live` may spend 15s waiting for
 * a webview to attach and another 30s waiting for a page to settle before a
 * capture is even attempted, and the activity log holds screenshots that took
 * eleven minutes — long enough that whatever the picture was going to show has
 * stopped being the question. An agent needs an answer more than it needs this
 * particular frame.
 */
const SCREENSHOT_BUDGET_MS = 30_000;

/**
 * Captures kept on disk, and the age below which one is never deleted.
 *
 * See `selectShotEvictions`. Eighty is a few days of ordinary use and about a
 * hundred megabytes at the sizes real pages produce.
 */
const SHOT_KEEP = 80;
const SHOT_GRACE_MS = 24 * 60 * 60_000;

/**
 * How long the renderer gets to composite a tab that was just brought forward.
 *
 * A blind wait, because nothing reports a frame back to main. It only has to
 * cover an IPC hop and a repaint; `capturePage`'s own ceiling, and the CDP path
 * behind it, cover the case where it was not enough.
 */
const PAINT_SETTLE_MS = 200;

/** What `withCeiling` resolves to when the promise it wrapped did not settle. */
const TIMED_OUT = Symbol("timed out");

/** The attached debugger session `renderOffSurface` drives. */
type CdpSession = NonNullable<GuestContents["debugger"]>;

/**
 * Render a page to PNG bytes without going anywhere near its compositing
 * surface. See `capture` for why that is the whole point.
 *
 * The device-metrics override is deliberately a no-op in every dimension: the
 * size comes straight back from `Page.getLayoutMetrics`, and the scale factor is
 * left at 0 ("keep the system's"). Overriding at all is what makes Chromium
 * allocate an offscreen surface for the target; overriding with DIFFERENT values
 * would reflow a live page the agent is mid-interaction with, and the point here
 * is to photograph the page, not to change it. It is cleared in `finally` for
 * the same reason.
 *
 * The clip is anchored at the visual viewport's page offset, so what comes back
 * is what is scrolled into view rather than the top of the document.
 */
async function renderOffSurface(cdp: CdpSession): Promise<{ data?: string }> {
  let overrode = false;
  try {
    const metrics = (await cdp.sendCommand("Page.getLayoutMetrics")) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    const width = Math.round(viewport?.clientWidth ?? 0);
    const height = Math.round(viewport?.clientHeight ?? 0);
    // A page mid-navigation reports nothing useful. Rather than clip to a zero
    // rectangle and hand back an empty PNG, fall through to the plain capture,
    // which at least succeeds whenever the tab does happen to be painted.
    if (width > 0 && height > 0) {
      await cdp.sendCommand("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 0,
        mobile: false,
      });
      overrode = true;
      return (await cdp.sendCommand("Page.captureScreenshot", {
        format: "png",
        fromSurface: false,
        captureBeyondViewport: true,
        clip: {
          x: Math.round(metrics.cssVisualViewport?.pageX ?? 0),
          y: Math.round(metrics.cssVisualViewport?.pageY ?? 0),
          width,
          height,
          scale: 1,
        },
      })) as { data?: string };
    }
  } catch {
    // An old target, a page that navigated out from under the override, a build
    // without `Emulation` — none of that is worth failing the capture over while
    // the surface read below is still there to try.
  } finally {
    if (overrode) {
      try {
        await cdp.sendCommand("Emulation.clearDeviceMetricsOverride");
      } catch {
        // The page went away. Nothing left to restore.
      }
    }
  }

  return (await cdp.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: true })) as {
    data?: string;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Resolve with the promise's value, or with `TIMED_OUT` after `budgetMs`.
 *
 * The losing promise is abandoned, not cancelled — nothing in Electron's
 * capture path is cancellable. That is fine: it holds a frame nobody reads.
 */
async function withCeiling<T>(promise: Promise<T>, budgetMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tabs that may hold a live page at once, across every section.
 *
 * The number that actually bounds memory. At a measured ~200 MB for a real
 * single-page app, six is already more than an 8 GB machine wants to spend on
 * pages nobody is looking at; the rest stay in the strip, asleep.
 */
const MAX_AWAKE_TABS = 6;

/**
 * How long a tab sits untouched before it sleeps.
 *
 * Shorter than the session idle timeout on purpose. Waking a tab is a page
 * reload; resuming a section is a model round trip — so the same amount of
 * memory is worth reclaiming sooner here.
 */
const TAB_IDLE_MS = 5 * 60_000;

/** Recording frame rates. Low on purpose: this is a screen grab on a laptop. */
const DEFAULT_FPS = 2;
const MAX_FPS = 10;

/** A recording nobody stops still stops, rather than filling the disk. */
const MAX_RECORDING_MS = 5 * 60_000;

export type BrowserDependencies = {
  /** Push the whole tab list at every renderer window. */
  broadcast: (state: BrowserState) => void;
  /** Push a new activity record at every renderer window. */
  broadcastActivity?: (record: BrowserActivity) => void;
  /** Ask the renderer to reveal the browser panel for a section. */
  revealPanel: (threadId: string) => void;
  /** Put the exact live guest on a paintable renderer surface for one capture. */
  stageCapture?: (tabId: string) => Promise<(() => void) | undefined>;
  /** Title of a section id, for `opened by`, note attribution and the audit trail. */
  sectionTitle?: (id: string) => string | undefined;
  /** The live guest for a renderer-reported WebContents id. */
  contentsById: (webContentsId: number) => GuestContents | undefined;
  /** Where screenshots and recordings are written. */
  screenshotDir: string;
  /** Append one line to the activity log. */
  audit?: (record: BrowserActivity) => void;
  /** Read the activity log back. */
  activity?: (limit?: number) => BrowserActivity[];
  /**
   * Turn a directory of PNG frames into a video. Absent, or failing, and a
   * recording still yields its frames — which is worth more than nothing.
   */
  encodeVideo?: (request: { framesDir: string; outPath: string; fps: number }) => Promise<{ ok: boolean; message: string }>;
  log: (event: string, details?: Record<string, unknown>) => void;
  now?: () => number;
};

type TabRecord = BrowserTab & {
  /** Renderer-reported id of the guest `WebContents`; unset until it attaches. */
  webContentsId?: number;
  /** Resolvers waiting for this tab's webview to attach. */
  waiters: (() => void)[];
  /**
   * Where this tab's pointer is, and whether a button is being held.
   *
   * The whole point of the cursor: it PERSISTS between calls. A hover menu stays
   * open because the pointer is still on it; a drag can be picked up in one call
   * and released in another; a click needs no selector because the pointer is
   * already somewhere. Position is in the page's CSS pixels, the same space
   * `getBoundingClientRect` and `sendInputEvent` both use.
   */
  cursor?: { x: number; y: number; down?: "left" | "right" | "middle" };
};

type Recording = {
  tabId: string;
  framesDir: string;
  fps: number;
  startedAt: number;
  frames: number;
  timer: ReturnType<typeof setInterval>;
  /** Frames the capture could not take — a hidden panel, mostly. See `record`. */
  misses: number;
  /** Started with `background`: never front the tab, render every frame via CDP. */
  background: boolean;
};

export type BrowserOpResult = { ok: boolean; message: string };

/** Who asked for an action, for the audit trail. */
export type BrowserActor = { id?: string };

/** Which section an op belongs to, and who asked. */
export type Scope = {
  /**
   * The section the op belongs to. For an agent it is its own section id (`by`);
   * for the panel it is the section the user is looking at.
   */
  threadId: string;
  /** Section id behind the action; absent when the human did it themselves. */
  by?: string;
};

export type BrowserService = {
  state: () => BrowserState;
  attach: (tabId: string, webContentsId: number) => void;
  report: (tabId: string, patch: Partial<Pick<BrowserTab, "url" | "title" | "loading" | "canGoBack" | "canGoForward">>) => void;
  open: (request: Scope & { url: string }) => Promise<BrowserOpResult & { tabId?: string }>;
  navigate: (request: Scope & { tab?: string; url: string }) => Promise<BrowserOpResult>;
  read: (request: Scope & { tab?: string; selector?: string; links?: boolean; values?: boolean }) => Promise<BrowserOpResult>;
  /** Element state and addressable selectors, rather than rendered text. */
  inspect: (request: Scope & {
    tab?: string;
    selector?: string;
    text?: string;
    role?: string;
    within?: string;
    limit?: number;
  }) => Promise<BrowserOpResult>;
  waitFor: (request: Scope & { tab?: string; selector?: string; text?: string; timeoutMs?: number }) => Promise<BrowserOpResult>;
  click: (request: Scope & {
    tab?: string;
    selector?: string;
    text?: string;
    button?: "left" | "right" | "middle";
    clickCount?: number;
  }) => Promise<BrowserOpResult>;
  hover: (request: Scope & { tab?: string; selector?: string; text?: string }) => Promise<BrowserOpResult>;
  drag: (request: Scope & { tab?: string; from: string; to: string }) => Promise<BrowserOpResult>;
  type: (request: Scope & {
    tab?: string;
    selector: string;
    text: string;
    submit?: boolean;
    clear?: boolean;
  }) => Promise<BrowserOpResult>;
  key: (request: Scope & { tab?: string; keys: string }) => Promise<BrowserOpResult>;
  /**
   * Drive the tab's pointer directly, in page coordinates.
   *
   * The escape hatch from "everything must have a selector": a canvas, a map, a
   * custom slider, a drag handle, a hover-only menu. The pointer stays where it
   * is put, so a press and its release can be separate calls.
   */
  cursor: (request: Scope & {
    tab?: string;
    action: "move" | "click" | "down" | "up" | "drag" | "wheel" | "where" | "hide";
    /** Absolute page coordinates, in CSS pixels. */
    x?: number;
    y?: number;
    /** Or relative to where the pointer already is. */
    dx?: number;
    dy?: number;
    /** Or an element to put the pointer on. */
    selector?: string;
    text?: string;
    /** Where a drag ends: coordinates, or an element. */
    toX?: number;
    toY?: number;
    toSelector?: string;
    toText?: string;
    button?: "left" | "right" | "middle";
    clickCount?: number;
    deltaY?: number;
  }) => Promise<BrowserOpResult>;
  scroll: (request: Scope & { tab?: string; to?: string; text?: string; deltaY?: number }) => Promise<BrowserOpResult>;
  selectOption: (request: Scope & { tab?: string; selector: string; value?: string; label?: string }) => Promise<BrowserOpResult>;
  upload: (request: Scope & { tab?: string; selector: string; paths: string[] }) => Promise<BrowserOpResult>;
  screenshot: (request: Scope & { tab?: string; background?: boolean }) => Promise<BrowserOpResult>;
  record: (request: Scope & { tab?: string; action: "start" | "stop"; fps?: number; background?: boolean }) => Promise<BrowserOpResult>;
  note: (request: Scope & { tab?: string; text: string; selector?: string; clear?: boolean }) => Promise<BrowserOpResult>;
  setNoteHidden: (tabId: string, hidden: boolean) => Promise<boolean>;
  resolveNote: (tabId: string) => { from?: string; tabTitle: string; url: string; note?: BrowserNote } | undefined;
  close: (request: Scope & { tab: string }) => Promise<BrowserOpResult>;
  select: (request: { threadId: string; tabId: string }) => void;
  back: (request: Scope & { tab?: string }) => Promise<BrowserOpResult>;
  forward: (request: Scope & { tab?: string }) => Promise<BrowserOpResult>;
  reload: (request: Scope & { tab?: string }) => Promise<BrowserOpResult>;
  /** The activity log for one section, rendered. */
  activity: (request: { threadId: string; limit?: number }) => BrowserOpResult;
  /** Drop a section's tabs when the section itself goes away. */
  closeThread: (threadId: string) => void;
  /**
   * Release idle pages, and hold the awake count under its ceiling. Driven by
   * the same one-minute timer that sweeps idle sections.
   */
  sweep: (request: { visibleThreadId?: string; idleTimeoutMs?: number; maxAwake?: number }) => void;
  /** Memory-relevant counts, for the machine report and the debug log. */
  stats: () => { tabs: number; awake: number; asleep: number };
  /**
   * The renderer reporting whether a section's browser is actually on screen.
   *
   * Main cannot know this: the panel can be closed, the section can be one the
   * user is not looking at, and the window can be behind something else. Without
   * it `browser_list` was telling agents a tab was "shown to the user" when it
   * merely was the section's designated tab — which is exactly the kind of
   * confident-and-wrong that sends an agent down a wrong path.
   */
  setPanelVisible: (request: { threadId: string; visible: boolean }) => void;
  /**
   * Move the pages between the docked panel and the detached window.
   *
   * A guest belongs to the window that mounts it, so this is a hand-off rather
   * than a move: every page is dropped by the old host and re-created by the new
   * one, which costs a reload. The same mechanic as waking a slept tab, and the
   * reason that machinery is reused rather than duplicated.
   */
  setFloating: (on: boolean) => void;
  /** Stop any recording and drop the timers. Called when the app is going away. */
  dispose: () => void;
};

/** What an injected script hands back: a result, or a reason it could not. */
type ScriptResult<T> = ({ ok: true } & T) | { ok: false; error: string };

type ElementHit = {
  visible: boolean;
  /** When it is not visible: which unfixable-by-scrolling reason applies. */
  reason?: string;
  x: number;
  y: number;
  label: string;
  tag: string;
  inputType?: string;
};

export function createBrowserService(deps: BrowserDependencies): BrowserService {
  const tabs = new Map<string, TabRecord>();
  /** Insertion order is tab order; the map preserves it, the UI relies on it. */
  const activeTabByThread = new Map<string, string>();
  let recording: Recording | null = null;
  /** Whether the detached window is open and hosting the pages. */
  let floating = false;
  /** Sections whose browser panel the renderer says is actually on screen. */
  const visibleThreads = new Set<string>();
  const now = (): number => (deps.now ? deps.now() : Date.now());

  /**
   * Whether a tab is actually on screen: its section's panel is showing (or the
   * detached window is), AND it is that section's front tab.
   *
   * Both halves matter, and both have to hold for the page to be painting at
   * all — which makes this the same question as "can this tab be captured".
   * `capture` reads it for exactly that.
   */
  function onScreen(tab: { id: string; threadId: string }): boolean {
    return (floating || visibleThreads.has(tab.threadId)) && activeTabByThread.get(tab.threadId) === tab.id;
  }

  function snapshot(): BrowserState {
    return {
      tabs: [...tabs.values()].map(({ waiters: _waiters, webContentsId: _id, ...tab }) => ({
        ...tab,
        // Resolved at publish rather than stored, so a section renamed after its
        // tab was opened shows its new name in the floating window.
        threadTitle: deps.sectionTitle?.(tab.threadId) ?? tab.threadTitle,
        onScreen: onScreen(tab),
      })),
      activeTabByThread: Object.fromEntries(activeTabByThread),
      floating,
    };
  }

  function publish(): void {
    deps.broadcast(snapshot());
  }

  function actorName(id?: string): string {
    if (!id) return "You";
    return deps.sectionTitle?.(id) ?? "An agent";
  }

  /**
   * Record one action, however it ended.
   *
   * Every op goes through here — there is no path to the page that skips it,
   * which is the property that makes the log worth trusting. It also means a
   * thrown error is turned into a recorded failure rather than a rejected
   * promise crossing the socket.
   */
  async function run(
    action: string,
    context: { threadId: string; by?: string; tabId?: string; url?: string; detail?: string },
    // The body is handed the same context it was called with, so it can correct
    // it once it knows more than the caller did: which tab it actually resolved
    // to, which page that tab was on, and — the one that matters — whether the
    // field it just focused turned out to be a password box.
    body: (context: { tabId?: string; url?: string; detail?: string }) => Promise<BrowserOpResult> | BrowserOpResult,
  ): Promise<BrowserOpResult> {
    const startedAt = now();
    let result: BrowserOpResult;
    try {
      result = await body(context);
    } catch (error) {
      result = { ok: false, message: `The browser could not do that: ${String(error)}` };
    }

    const record: BrowserActivity = {
      at: new Date(startedAt).toISOString(),
      threadId: context.threadId,
      actorId: context.by,
      actor: actorName(context.by),
      action,
      tabId: context.tabId,
      url: context.url,
      detail: context.detail,
      ok: result.ok,
      ms: now() - startedAt,
      // The first line only: the outcome column is for scanning, and a `read`
      // returns a whole page.
      outcome: result.message.split("\n")[0]?.slice(0, 200),
    };
    deps.audit?.(record);
    deps.broadcastActivity?.(record);
    deps.log("browser-action", {
      action,
      actor: record.actor,
      tabId: record.tabId,
      ok: record.ok,
      ms: record.ms,
      detail: record.detail,
    });
    return result;
  }

  function mine(threadId: string): TabRecord[] {
    return [...tabs.values()].filter((tab) => tab.threadId === threadId);
  }

  /**
   * Resolve a tab reference within one section.
   *
   * A tab id from another section resolves to nothing here rather than to that
   * tab: an agent that guessed, or that held onto an id from a transcript it
   * read, must not end up driving a neighbour's page.
   */
  function pick(threadId: string, id?: string): TabRecord | undefined {
    const owned = mine(threadId);
    if (id) {
      const byId = owned.find((tab) => tab.id === id);
      if (byId) return byId;
      // Agents hold onto a title as readily as an id; accept either.
      return owned.find((tab) => tabLabel(tab).toLowerCase() === id.toLowerCase());
    }
    const chosen = activeTabByThread.get(threadId);
    return owned.find((tab) => tab.id === chosen) ?? owned[0];
  }

  function missing(threadId: string, id?: string): BrowserOpResult {
    if (!id) {
      return { ok: false, message: "This section has no tab open. `browser_open` opens one." };
    }
    const elsewhere = [...tabs.values()].some((tab) => tab.id === id && tab.threadId !== threadId);
    return {
      ok: false,
      message: elsewhere
        ? `\`${id}\` belongs to another section, so it is not yours to drive. \`browser_list\` shows this section's tabs.`
        : `No open tab called \`${id}\` in this section. \`browser_list\` shows what is open.`,
    };
  }

  /**
   * Mark a tab as used, and wake it if it was asleep.
   *
   * Every path to a page goes through `live()`, which calls this — so "when was
   * this last touched" needs no bookkeeping at the call sites, and neither does
   * waking. An op on a sleeping tab simply takes a page load longer.
   */
  function touch(tab: TabRecord): void {
    tab.lastUsedAt = now();
    if (tab.asleep) {
      tab.asleep = false;
      tab.loading = true;
      // The renderer mounts a webview for any tab that is not asleep, so this
      // publish is what brings the page back; `whenAttached` waits for it.
      publish();
      deps.log("browser-tab-woke", { tabId: tab.id });
    }
  }

  function contentsFor(tab: TabRecord): GuestContents | undefined {
    if (tab.webContentsId === undefined) return undefined;
    const wc = deps.contentsById(tab.webContentsId);
    return wc && !wc.isDestroyed() ? wc : undefined;
  }

  /**
   * Wait for the renderer to mount a tab's webview.
   *
   * An agent's `browser_open` finishes a round trip through the UI: main creates
   * the record, the renderer mounts a `<webview>` for it and reports the guest
   * id back. Until that lands there is nothing to drive, so every op that needs
   * a live page goes through here rather than failing on a race the agent has no
   * way to understand.
   */
  function whenAttached(tab: TabRecord): Promise<GuestContents | undefined> {
    const live = contentsFor(tab);
    if (live) return Promise.resolve(live);

    return new Promise((resolve) => {
      const onAttach = (): void => {
        clearTimeout(timer);
        resolve(contentsFor(tab));
      };
      const timer = setTimeout(() => {
        tab.waiters = tab.waiters.filter((waiter) => waiter !== onAttach);
        resolve(contentsFor(tab));
      }, ATTACH_TIMEOUT_MS);
      timer.unref?.();
      tab.waiters.push(onAttach);
    });
  }

  /**
   * Resolve once the page settles, so an agent reads a loaded page, not a blank
   * one — and record that it settled.
   *
   * `loading` used to be cleared only by the renderer's `did-stop-loading`
   * report. Main can see the same thing, and needs to: a tab main still believes
   * is loading is never eligible to sleep, so a missed report would quietly opt
   * that page out of the memory sweep forever.
   */
  function whenLoaded(wc: GuestContents, tab?: TabRecord): Promise<void> {
    const settle = (): void => {
      if (tab) tab.loading = false;
    };
    if (!wc.isLoading()) {
      settle();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        wc.off("did-stop-loading", finish);
        wc.off("did-fail-load", finish);
        settle();
        resolve();
      };
      const timer = setTimeout(finish, LOAD_TIMEOUT_MS);
      timer.unref?.();
      wc.on("did-stop-loading", finish);
      wc.on("did-fail-load", finish);
    });
  }

  /** Run injected source in a frame, with a ceiling and a readable failure. */
  async function evaluate<T>(frame: GuestFrame | GuestContents, source: string, budgetMs = SCRIPT_TIMEOUT_MS): Promise<ScriptResult<T>> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        frame.executeJavaScript(source, true) as Promise<ScriptResult<T>>,
        new Promise<ScriptResult<T>>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, error: "The page did not answer in time." }), budgetMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      return result;
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  /**
   * Every frame in the page, main document first.
   *
   * Frames are why "the selector matches nothing" used to be the most common
   * dead end: a checkout field, an embedded player, a docs preview — all of them
   * live in an iframe, and an injected script only ever sees its own document.
   */
  function framesOf(wc: GuestContents): GuestFrame[] {
    const main = wc.mainFrame;
    const nested = main.framesInSubtree ?? [];
    // `framesInSubtree` includes the main frame in Electron; dedupe on identity.
    return [main, ...nested.filter((frame) => frame !== main)];
  }

  /**
   * Run a script in whichever frame can answer it.
   *
   * The main document is tried first — it is the answer almost every time, and
   * probing every frame on a page full of ad iframes would be slow. Only a
   * "nothing matches" failure moves on to the next frame; a script that threw is
   * reported as it is.
   */
  async function inBestFrame<T>(
    wc: GuestContents,
    source: string,
    budgetMs = SCRIPT_TIMEOUT_MS,
  ): Promise<{ result: ScriptResult<T>; frame: GuestFrame }> {
    const frames = framesOf(wc);
    let lastFailure: { result: ScriptResult<T>; frame: GuestFrame } | undefined;
    for (const frame of frames) {
      const result = await evaluate<T>(frame, source, budgetMs);
      if (result.ok) {
        return { result, frame };
      }
      lastFailure ??= { result, frame };
    }
    return lastFailure ?? { result: { ok: false, error: "The page has no frames to run that in." }, frame: wc.mainFrame };
  }

  /**
   * Where a frame's viewport sits inside the top-level page.
   *
   * A rect measured inside an iframe is in that iframe's coordinates, but a
   * synthesized mouse event is delivered in the top document's — so a click on
   * something in a frame lands somewhere else entirely unless the offsets are
   * added up. Each step asks the *parent* where the child frame's element is,
   * which works across an origin boundary that reading into the child would not.
   */
  async function frameOffset(wc: GuestContents, frame: GuestFrame): Promise<{ x: number; y: number }> {
    let offset = { x: 0, y: 0 };
    let current: GuestFrame | null | undefined = frame;
    while (current && current !== wc.mainFrame) {
      const parent: GuestFrame | null | undefined = current.parent ?? wc.mainFrame;
      const found = await evaluate<{ x: number; y: number }>(parent, frameOffsetScript(current.url));
      if (!found.ok) {
        break;
      }
      offset = { x: offset.x + found.x, y: offset.y + found.y };
      current = parent === wc.mainFrame ? undefined : parent;
    }
    return offset;
  }

  /** Find an element anywhere in the page and give its point in top-level coordinates. */
  async function locate(
    wc: GuestContents,
    selector?: string,
    text?: string,
  ): Promise<{ hit: ElementHit; frame: GuestFrame; point: { x: number; y: number } } | BrowserOpResult> {
    const { result, frame } = await inBestFrame<ElementHit>(wc, findElementScript(selector, text));
    if (!result.ok) {
      return { ok: false, message: result.error };
    }
    if (!result.visible) {
      // The element was scrolled to before this check, so "below the fold" is
      // never the answer any more — `reason` says what scrolling could not fix.
      return {
        ok: false,
        message: `Found ${result.tag} "${result.label}" but ${result.reason ?? "it is not visible on screen"}, so it cannot be clicked.`,
      };
    }
    const offset = frame === wc.mainFrame ? { x: 0, y: 0 } : await frameOffset(wc, frame);
    return { hit: result, frame, point: { x: result.x + offset.x, y: result.y + offset.y } };
  }

  /** Everything an agent op needs: an existing tab with a live, settled page. */
  async function live(
    threadId: string,
    id: string | undefined,
    context?: { tabId?: string; url?: string },
  ): Promise<{ tab: TabRecord; wc: GuestContents } | BrowserOpResult> {
    const tab = pick(threadId, id);
    if (!tab) return missing(threadId, id);
    // The audit record should name the tab that was actually driven, not the
    // string the caller passed — which is often nothing at all.
    if (context) {
      context.tabId = tab.id;
      context.url = tab.url;
    }
    touch(tab);
    const wc = await whenAttached(tab);
    if (!wc) {
      return { ok: false, message: `Tab \`${tab.id}\` has no live page yet — the browser panel may still be starting up.` };
    }
    await whenLoaded(wc, tab);
    return { tab, wc };
  }

  function isResult(value: unknown): value is BrowserOpResult {
    return typeof value === "object" && value !== null && "ok" in value && "message" in value;
  }

  /**
   * Bring a tab to the front of its section's panel, so there is something to
   * capture. Returns whether it was already there — i.e. whether anything had
   * to change, which is what tells the caller if a repaint is owed.
   *
   * This is the step `screenshot` was missing. `open` and `note` both make their
   * tab the front one and reveal the panel; `screenshot` did neither, so it
   * routinely photographed a tab that nothing was painting — a background tab is
   * `visibility: hidden`, and a closed panel is parked off-screen. That is the
   * shape of the failures in the activity log, and it is why agents learned to
   * call `browser_note` before `browser_screenshot`: the note was never the
   * point, revealing the panel was. Doing it here means they no longer have to
   * leave a note on the user's page to take a picture of it.
   */
  function front(tab: TabRecord): boolean {
    if (onScreen(tab)) return true;
    activeTabByThread.set(tab.threadId, tab.id);
    deps.revealPanel(tab.threadId);
    publish();
    return false;
  }

  /**
   * `front`, plus the wait for it to have happened. For a one-shot capture,
   * where there is no second chance at the frame — a recording grabs on a timer
   * and can afford to miss its first one, so it uses `front` directly rather
   * than making the agent's `record` call block on a repaint.
   */
  async function bringToFront(tab: TabRecord): Promise<void> {
    if (front(tab)) return;
    // The renderer has to receive that, restyle the dock and composite a frame
    // before there is anything to read, and it does not report back when it has
    // — `setPanelVisible` arrives on its own schedule, so re-reading `onScreen`
    // here would just say "no" to a panel that is on its way up. Hence a fixed
    // wait, kept short because `capturePage`'s ceiling is the real backstop and
    // the CDP path still sits behind that.
    await delay(PAINT_SETTLE_MS);
  }

  /**
   * Capture a tab as PNG bytes.
   *
   * `capturePage` reads the compositor's output, so it returns an empty image
   * whenever the view is not being painted. CDP's `Page.captureScreenshot`
   * renders from the page rather than the screen, so it stands a chance on a tab
   * that is not on screen. It is the fallback rather than the primary because it
   * needs the debugger attached, and attaching interferes with any DevTools the
   * user has open on that page.
   *
   * "Stands a chance" was doing a lot of work there, and for a long time it was
   * false. `Page.captureScreenshot` with `fromSurface: true` reads the target's
   * COMPOSITING SURFACE — the same thing `capturePage` reads. So the fallback
   * shared the primary's one dependency, and a tab nothing was painting failed
   * both stages, twelve seconds apart, and blamed the machine's load for it.
   *
   * Three things in the renderer guarantee "nothing is painting it" for exactly
   * the case agents hit — a section the user is not currently looking at:
   * inactive tabs are `visibility: hidden` (Chromium does not raster a hidden
   * subtree), the closed dock is parked 20000px off-screen (kept alive, but
   * culled from rastering), and `bringToFront` cannot front a panel belonging to
   * a section that is not on screen at all. None of that is fixable from here,
   * and all of it is load-bearing for other reasons.
   *
   * So the fallback stops reading the screen. `renderOffSurface` overrides the
   * page's device metrics to their own current values — a dimensional no-op that
   * nonetheless makes Chromium allocate an offscreen surface — and captures an
   * explicit clip with `captureBeyondViewport`, which rasters the requested
   * region from the renderer's layer tree instead of sampling a compositor frame
   * that is never coming. This is the recipe headless capture uses, and it does
   * not care whether the tab is visible, occluded, or on a Space the user left
   * an hour ago.
   *
   * `fromSurface: false` alone was tried and is not the answer: for a guest
   * attached to a window it captures THE WINDOW, which is how a screenshot of a
   * page once came back showing the Panda Code chat. It is safe here only
   * because the explicit `clip` leaves no ambiguity about what is being rastered.
   *
   * Callers are expected to have put the tab on screen first (`bringToFront`),
   * because that is what makes the first stage work at all. What is left here is
   * the ceiling: ten seconds was far too long to wait for a frame that, on the
   * evidence of 217 real captures, arrives in 39ms when it is coming and never
   * when it is not. Two seconds keeps the slow-machine case and stops paying
   * eight more for a frame that does not exist.
   *
   * `skipPainted` is for the deliberate background capture, where the caller has
   * chosen NOT to front the tab and therefore already knows nothing is painting
   * it. Waiting out the first stage there is two seconds spent to learn what was
   * decided at the call site, so it goes straight to the renderer.
   *
   * Both stages still get a ceiling. Neither call fails on its own when the
   * frame it is waiting for never arrives — on a loaded machine, `capturePage`
   * on an unpainted view simply never settles, and an unanswered ceiling here is
   * the one that hangs the agent's whole turn: `run` writes its activity record
   * after the body returns, so a wedged capture leaves no trace at all.
   */
  async function capture(
    wc: GuestContents,
    { skipPainted = false }: { skipPainted?: boolean } = {},
  ): Promise<{ ok: true; png: Buffer } | { ok: false; error: string }> {
    if (!skipPainted) {
      try {
        const shot = await withCeiling(wc.capturePage(), PAINTED_CAPTURE_TIMEOUT_MS);
        if (shot === TIMED_OUT) {
          deps.log("browser-capture-failed", { stage: "capturePage", error: "timed out" });
        } else {
          const painted = shot.toPNG();
          if (painted.length) {
            return { ok: true, png: painted };
          }
        }
      } catch (error) {
        deps.log("browser-capture-failed", { stage: "capturePage", error: String(error) });
      }
    }

    const cdp = wc.debugger;
    if (!cdp) {
      return { ok: false, error: "The page is not being painted and this build cannot attach to it to render one." };
    }

    const attachedHere = !cdp.isAttached();
    try {
      if (attachedHere) cdp.attach("1.3");
      const rendered = await withCeiling(renderOffSurface(cdp), CAPTURE_TIMEOUT_MS);
      if (rendered === TIMED_OUT) {
        return {
          ok: false,
          error:
            "The page did not render in time. It is awake but not being painted — nothing on this machine is compositing it — and the off-surface render did not answer either.",
        };
      }
      if (!rendered.data) {
        return { ok: false, error: "The page rendered an empty image." };
      }
      return { ok: true, png: Buffer.from(rendered.data, "base64") };
    } catch (error) {
      return { ok: false, error: String(error) };
    } finally {
      if (attachedHere) {
        try {
          cdp.detach();
        } catch {
          // Already gone, or the page navigated out from under us.
        }
      }
    }
  }

  /**
   * Delete old captures, keeping the newest `SHOT_KEEP` and anything written in
   * the last day. Run after a capture lands, which is the only thing that grows
   * the directory.
   *
   * Best-effort throughout: a shots directory that cannot be tidied is not a
   * reason to fail a screenshot that already succeeded.
   */
  function pruneShots(): void {
    try {
      const entries = readdirSync(deps.screenshotDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.name.endsWith(".png"))
        .flatMap((entry) => {
          const path = join(deps.screenshotDir, entry.name);
          try {
            return [{ path, writtenAt: statSync(path).mtimeMs, directory: entry.isDirectory() }];
          } catch {
            // Vanished between the listing and the stat. Nothing to prune.
            return [];
          }
        });

      const doomed = selectShotEvictions({
        entries,
        keep: SHOT_KEEP,
        graceMs: SHOT_GRACE_MS,
        // The OS clock, not the service's `now`: these are compared against
        // mtimes the filesystem wrote, which know nothing about an injected one.
        now: Date.now(),
        activeDirectory: recording?.framesDir,
      });
      for (const path of doomed) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          // Open elsewhere, or already gone.
        }
      }
      if (doomed.length) deps.log("browser-shots-pruned", { deleted: doomed.length, kept: SHOT_KEEP });
    } catch (error) {
      deps.log("browser-shots-prune-failed", { error: String(error) });
    }
  }

  function moveMouse(wc: GuestContents, point: { x: number; y: number }): void {
    wc.sendInputEvent({ type: "mouseMove", ...point });
  }

  async function stopRecording(reason: string): Promise<BrowserOpResult> {
    if (!recording) {
      return { ok: false, message: "Nothing is being recorded." };
    }

    const finished = recording;
    recording = null;
    clearInterval(finished.timer);
    const tab = tabs.get(finished.tabId);
    if (tab) {
      tab.recording = false;
    }
    publish();

    const seconds = Math.round((now() - finished.startedAt) / 1000);
    const summary = `${finished.frames} frame${finished.frames === 1 ? "" : "s"} over ${seconds}s${finished.misses ? `, ${finished.misses} missed` : ""}`;
    if (!finished.frames) {
      return { ok: false, message: `Recording stopped (${reason}) with no frames captured — every grab failed.` };
    }

    const outPath = join(finished.framesDir, "recording.mp4");
    const encoded = await deps.encodeVideo?.({ framesDir: finished.framesDir, outPath, fps: finished.fps });
    // A recording is the largest thing this directory ever grows by, and a user
    // who only ever records would otherwise never reach the prune on `screenshot`.
    pruneShots();
    if (encoded?.ok) {
      return { ok: true, message: `Recording stopped (${reason}): ${summary}. Video at ${outPath}` };
    }
    return {
      ok: true,
      message:
        `Recording stopped (${reason}): ${summary}. ${encoded ? `Could not encode a video (${encoded.message}); the` : "No video encoder is available, so the"} ` +
        `frames are in ${finished.framesDir} — read them in order, or hand the user the folder.`,
    };
  }

  return {
    state: snapshot,

    attach(tabId, webContentsId) {
      const tab = tabs.get(tabId);
      if (!tab) return;
      tab.webContentsId = webContentsId;
      deps.log("browser-attach", { tabId, webContentsId });
      const waiters = tab.waiters;
      tab.waiters = [];
      for (const waiter of waiters) waiter();
    },

    report(tabId, patch) {
      const tab = tabs.get(tabId);
      if (!tab) return;
      Object.assign(tab, patch);
      // The user scrolling and clicking in the page is invisible to us, but a
      // navigation is not — and it is evidence the tab is still in use.
      if (patch.url || patch.title) tab.lastUsedAt = now();
      publish();
    },

    open({ url, by, threadId }) {
      return run("open", { threadId, by, detail: summarizeArgs("open", { url }) }, async () => {
        if (mine(threadId).length >= TAB_CAP) {
          return { ok: false, message: `This section already has ${TAB_CAP} tabs open. Close one with \`browser_close\` first.` };
        }

        const target = normalizeUrl(url);
        if ("error" in target) return { ok: false, message: target.error };

        const id = `tab-${Math.random().toString(36).slice(2, 8)}`;
        const tab: TabRecord = {
          id,
          threadId,
          url: target.url,
          title: "",
          loading: true,
          canGoBack: false,
          canGoForward: false,
          openedBy: by ? (deps.sectionTitle?.(by) ?? "an agent") : undefined,
          lastUsedAt: now(),
          waiters: [],
        };
        tabs.set(id, tab);
        activeTabByThread.set(threadId, id);
        deps.revealPanel(threadId);
        publish();

        const wc = await whenAttached(tab);
        if (!wc) {
          return { ok: true, tabId: id, message: `Opened \`${id}\` at ${target.url}, but the page has not reported back yet.` };
        }
        await whenLoaded(wc, tab);
        publish();
        return { ok: true, tabId: id, message: `Opened \`${id}\` — ${tabLabel(tab)}\n${tab.url}` };
      }) as Promise<BrowserOpResult & { tabId?: string }>;
    },

    navigate({ tab: id, url, by, threadId }) {
      return run("navigate", { threadId, by, tabId: id, detail: summarizeArgs("navigate", { url }) }, async (context) => {
        const target = normalizeUrl(url);
        if ("error" in target) return { ok: false, message: target.error };

        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        found.tab.loading = true;
        publish();
        await found.wc.loadURL(target.url).catch(() => undefined);
        await whenLoaded(found.wc, found.tab);
        publish();
        return { ok: true, message: `\`${found.tab.id}\` is now on ${found.tab.url} — ${tabLabel(found.tab)}` };
      });
    },

    read({ tab: id, selector, links, values, by, threadId }) {
      return run("read", { threadId, by, tabId: id, detail: summarizeArgs("read", { selector }) }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        const { result, frame } = await inBestFrame<{
          title: string;
          url: string;
          text: string;
          links: { text: string; href: string }[];
        }>(found.wc, pageTextScript(selector, links ?? false));
        if (!result.ok) return { ok: false, message: result.error };

        const inFrame = frame !== found.wc.mainFrame ? `\n\n[Read from the frame at ${frame.url}]` : "";
        // Rendered text cannot say what is IN a field, which is what an agent
        // needs to confirm its own edit rather than believe a screenshot.
        let form = "";
        if (values) {
          const state = await evaluate<{ total: number; matches: InspectedElement[] }>(
            frame,
            inspectScript({ within: selector }),
          );
          form = `\n\n## Form state\n${state.ok ? renderInspect(state) : state.error}`;
        }
        return { ok: true, message: renderPageRead(result) + form + inFrame };
      });
    },

    inspect({ tab: id, selector, text, role, within, limit, by, threadId }) {
      return run("inspect", { threadId, by, tabId: id, detail: summarizeArgs("inspect", { selector, text }) }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        const { result, frame } = await inBestFrame<{ total: number; matches: InspectedElement[] }>(
          found.wc,
          inspectScript({ selector, text, role, within, limit }),
        );
        if (!result.ok) return { ok: false, message: result.error };

        const where = frame !== found.wc.mainFrame ? `\n\n[From the frame at ${frame.url}]` : "";
        return { ok: true, message: renderInspect(result) + where };
      });
    },

    waitFor({ tab: id, selector, text, timeoutMs, by, threadId }) {
      return run("wait", { threadId, by, tabId: id, detail: summarizeArgs("wait", { selector, text }) }, async (context) => {
        if (!selector && !text) {
          return { ok: false, message: "Give either a `selector` to wait for or the `text` you expect to appear." };
        }

        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        const budget = Math.min(Math.max(timeoutMs ?? 10_000, 500), MAX_WAIT_MS);
        // The wait happens in the page, so the script's own ceiling has to be
        // the one that matters — hence the budget passed through here.
        const { result, frame } = await inBestFrame<{ label: string; waitedMs?: number }>(
          found.wc,
          waitForScript(selector, text, budget),
          budget + 2_000,
        );
        if (!result.ok) {
          return { ok: false, message: `${result.error} Waited up to ${Math.round(budget / 1000)}s for ${selector ?? JSON.stringify(text)}.` };
        }
        const where = frame !== found.wc.mainFrame ? ` in the frame at ${frame.url}` : "";
        return { ok: true, message: `It is there${where}: "${result.label}". The tab is on ${found.tab.url}.` };
      });
    },

    click({ tab: id, selector, text, button, clickCount, by, threadId }) {
      return run("click", { threadId, by, tabId: id, detail: summarizeArgs("click", { selector, text }) }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        const located = await locate(found.wc, selector, text);
        if (isResult(located)) return located;

        // A synthesized mouse event at the element's own coordinates, rather than
        // `element.click()`: it is a trusted event, so flows that browsers gate on
        // real user input (popups, file pickers, some payment frames) accept it.
        const point = located.point;
        const mouseButton = button ?? "left";
        const count = Math.min(Math.max(clickCount ?? 1, 1), 3);
        found.wc.focus();
        moveMouse(found.wc, point);
        found.wc.sendInputEvent({ type: "mouseDown", ...point, button: mouseButton, clickCount: count });
        found.wc.sendInputEvent({ type: "mouseUp", ...point, button: mouseButton, clickCount: count });
        await whenLoaded(found.wc, found.tab);
        publish();

        const where = located.frame !== found.wc.mainFrame ? ` (in the frame at ${located.frame.url})` : "";
        const how = mouseButton === "left" && count === 1 ? "Clicked" : `${mouseButton}-clicked ×${count}`;
        return {
          ok: true,
          message: `${how} ${located.hit.tag}${located.hit.label ? ` "${located.hit.label}"` : ""}${where}. The tab is on ${found.tab.url}.`,
        };
      });
    },

    hover({ tab: id, selector, text, by, threadId }) {
      return run("hover", { threadId, by, tabId: id, detail: summarizeArgs("hover", { selector, text }) }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        const located = await locate(found.wc, selector, text);
        if (isResult(located)) return located;

        // Two moves: one to arrive, one a pixel away, because a menu that opens
        // on `mousemove` wants to see movement, not a single teleport.
        moveMouse(found.wc, located.point);
        moveMouse(found.wc, { x: located.point.x + 1, y: located.point.y });
        return { ok: true, message: `Hovering ${located.hit.tag}${located.hit.label ? ` "${located.hit.label}"` : ""}. Read the page to see what appeared.` };
      });
    },

    drag({ tab: id, from, to, by, threadId }) {
      return run("drag", { threadId, by, tabId: id, detail: `from=${from} to=${to}` }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        const start = await locate(found.wc, from);
        if (isResult(start)) return start;
        const end = await locate(found.wc, to);
        if (isResult(end)) return end;

        // Interpolated moves, not a jump: HTML5 drag-and-drop and every
        // hand-rolled implementation alike need the intermediate mousemoves.
        found.wc.focus();
        moveMouse(found.wc, start.point);
        found.wc.sendInputEvent({ type: "mouseDown", ...start.point, button: "left", clickCount: 1 });
        const steps = 12;
        for (let step = 1; step <= steps; step += 1) {
          moveMouse(found.wc, {
            x: Math.round(start.point.x + ((end.point.x - start.point.x) * step) / steps),
            y: Math.round(start.point.y + ((end.point.y - start.point.y) * step) / steps),
          });
        }
        found.wc.sendInputEvent({ type: "mouseUp", ...end.point, button: "left", clickCount: 1 });
        await whenLoaded(found.wc, found.tab);
        return { ok: true, message: `Dragged "${start.hit.label || from}" onto "${end.hit.label || to}". Read the page to check it took.` };
      });
    },

    type({ tab: id, selector, text, submit, clear, by, threadId }) {
      return run(
        "type",
        { threadId, by, tabId: id, detail: summarizeArgs("type", { selector, text }) },
        async (context) => {
          const found = await live(threadId, id, context);
          if (isResult(found)) return found;

          const { result, frame } = await inBestFrame<{ tag: string; inputType?: string }>(
            found.wc,
            focusFieldScript(selector, clear ?? true),
          );
          if (!result.ok) return { ok: false, message: result.error };

          // Now that the field has identified itself, redact on what it IS
          // rather than only on what the selector looked like.
          context.detail = summarizeArgs("type", { selector, text, inputType: result.inputType });

          found.wc.focus();
          found.wc.insertText(text);
          if (submit) {
            for (const type of ["keyDown", "char", "keyUp"] as const) {
              found.wc.sendInputEvent({ type, keyCode: "Enter" });
            }
            await whenLoaded(found.wc, found.tab);
          }
          publish();

          const where = frame !== found.wc.mainFrame ? ` (in the frame at ${frame.url})` : "";
          return {
            ok: true,
            message: `Typed into ${result.tag}${where}${submit ? " and pressed Enter" : ""}. The tab is on ${found.tab.url}.`,
          };
        },
      );
    },

    key({ tab: id, keys, by, threadId }) {
      return run("key", { threadId, by, tabId: id, detail: summarizeArgs("key", { keys }) }, async (context) => {
        const chord = parseKeyChord(keys);
        if ("error" in chord) return { ok: false, message: chord.error };

        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        found.wc.focus();
        const event = { keyCode: chord.keyCode, modifiers: chord.modifiers };
        found.wc.sendInputEvent({ type: "keyDown", ...event });
        // Only a plain character produces text; a chord or a named key must not,
        // or Cmd+A types an "a" into whatever has focus.
        if (chord.keyCode.length === 1 && !chord.modifiers.some((modifier) => modifier !== "shift")) {
          found.wc.sendInputEvent({ type: "char", ...event });
        }
        found.wc.sendInputEvent({ type: "keyUp", ...event });
        await whenLoaded(found.wc, found.tab);
        return { ok: true, message: `Pressed ${keys}. The tab is on ${found.tab.url}.` };
      });
    },

    cursor({ tab: id, action, x, y, dx, dy, selector, text, toX, toY, toSelector, toText, button, clickCount, deltaY, by, threadId }) {
      const aim = selector ?? text ?? (typeof x === "number" ? `${x},${y}` : typeof dx === "number" ? `+${dx},${dy}` : "here");
      return run("cursor", { threadId, by, tabId: id, detail: `${action} ${aim}` }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;
        const { tab, wc } = found;

        if (action === "hide") {
          tab.cursor = undefined;
          await evaluate<{ ok: true }>(wc, clearCursorScript());
          return { ok: true, message: `Took the cursor off \`${tab.id}\`.` };
        }

        /**
         * Where this call is aimed. An element wins if one was named, then
         * absolute coordinates, then a nudge from where the pointer already is,
         * and failing all three the pointer simply stays put — which is what
         * makes "press here, then release" two separate calls.
         */
        const resolve = async (
          bySelector?: string,
          byText?: string,
          absX?: number,
          absY?: number,
        ): Promise<{ x: number; y: number } | BrowserOpResult | undefined> => {
          if (bySelector || byText) {
            const located = await locate(wc, bySelector, byText);
            if (isResult(located)) return located;
            return located.point;
          }
          if (typeof absX === "number" && typeof absY === "number") return { x: Math.round(absX), y: Math.round(absY) };
          return undefined;
        };

        const here = tab.cursor ?? { x: 0, y: 0 };
        let point = await resolve(selector, text, x, y);
        if (isResult(point)) return point;
        if (!point && (typeof dx === "number" || typeof dy === "number")) {
          point = { x: Math.round(here.x + (dx ?? 0)), y: Math.round(here.y + (dy ?? 0)) };
        }
        if (!point) {
          if (!tab.cursor && action !== "where") {
            return {
              ok: false,
              message:
                "The cursor is not on this page yet, so there is no \"here\" to act at. " +
                "Give `x`/`y`, or a `selector`/`text` to put it on something first.",
            };
          }
          point = { x: here.x, y: here.y };
        }

        // Clamp into the page rather than sending an event nothing can receive:
        // an off-viewport coordinate is silently dropped by Chromium, which
        // looks exactly like a click that did nothing.
        const probe = await evaluate<{
          under?: { tag: string; role?: string; label?: string; clickable: boolean };
          viewport?: { width: number; height: number; scale: number; scrollX: number; scrollY: number };
        }>(wc, pointProbeScript(point.x, point.y));
        const view = probe.ok ? probe.viewport : undefined;
        if (view && (point.x < 0 || point.y < 0 || point.x > view.width || point.y > view.height)) {
          return {
            ok: false,
            message:
              `(${point.x}, ${point.y}) is outside the page: the viewport is ${view.width}×${view.height} CSS pixels. ` +
              "Scroll the content into view first — page coordinates are viewport-relative, not document-relative.",
          };
        }

        const held = button ?? tab.cursor?.down ?? "left";
        const count = Math.min(Math.max(clickCount ?? 1, 1), 3);
        const under = probe.ok ? probe.under : undefined;
        const target = under
          ? `${under.tag}${under.label ? ` "${under.label}"` : ""}${under.role ? ` (role=${under.role})` : ""}`
          : "nothing the page reports";

        wc.focus();
        moveMouse(wc, point);

        switch (action) {
          case "where":
            break;
          case "move":
            break;
          case "down":
            wc.sendInputEvent({ type: "mouseDown", ...point, button: held, clickCount: 1 });
            tab.cursor = { ...point, down: held };
            break;
          case "up":
            wc.sendInputEvent({ type: "mouseUp", ...point, button: held, clickCount: 1 });
            break;
          case "click":
            wc.sendInputEvent({ type: "mouseDown", ...point, button: held, clickCount: count });
            wc.sendInputEvent({ type: "mouseUp", ...point, button: held, clickCount: count });
            break;
          case "wheel":
            // Same inversion as `scroll`: our positive delta means "down".
            wc.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY: -(deltaY ?? 0), canScroll: true });
            break;
          case "drag": {
            const end = await resolve(toSelector, toText, toX, toY);
            if (isResult(end)) return end;
            if (!end) {
              return { ok: false, message: "A drag needs somewhere to go — `toX`/`toY`, or `toSelector`/`toText`." };
            }
            // Interpolated, and with the button genuinely held down across the
            // whole path: HTML5 drag-and-drop and every hand-rolled slider alike
            // need the intermediate moves, not a teleport.
            wc.sendInputEvent({ type: "mouseDown", ...point, button: held, clickCount: 1 });
            const steps = 14;
            for (let step = 1; step <= steps; step += 1) {
              const at = {
                x: Math.round(point.x + ((end.x - point.x) * step) / steps),
                y: Math.round(point.y + ((end.y - point.y) * step) / steps),
              };
              moveMouse(wc, at);
              // Redrawn a few times along the way, so the user sees a drag
              // happening rather than a jump.
              if (step % 5 === 0) await evaluate<{ ok: true }>(wc, drawCursorScript(at.x, at.y, { down: true }));
            }
            wc.sendInputEvent({ type: "mouseUp", ...end, button: held, clickCount: 1 });
            point = end;
            break;
          }
        }

        if (action !== "down") {
          tab.cursor = { x: point.x, y: point.y };
        }
        await whenLoaded(wc, tab);
        // The user is watching this panel: the cursor is drawn where the agent
        // left it, so its position is something they can see rather than infer.
        await evaluate<{ ok: true }>(wc, drawCursorScript(point.x, point.y, { down: Boolean(tab.cursor?.down), label: under?.label }));
        publish();

        const where = `(${point.x}, ${point.y})`;
        // The coordinate space goes on every answer, not just a query: the next
        // call is usually another coordinate, and this is what bounds it.
        const size = view ? ` The viewport is ${view.width}×${view.height} CSS pixels.` : "";
        const verb =
          action === "where" || action === "move"
            ? `The cursor is at ${where}, over ${target}.`
            : action === "down"
              ? `Pressed and holding ${held} at ${where}, over ${target}. It stays down until you call \`up\`.`
              : action === "up"
                ? `Released at ${where}, over ${target}.`
                : action === "wheel"
                  ? `Wheeled ${deltaY ?? 0}px at ${where}, over ${target}.`
                  : action === "drag"
                    ? `Dragged to ${where}, over ${target}.`
                    : `Clicked ${held}${count > 1 ? ` ×${count}` : ""} at ${where}, over ${target}.`;
        const blind =
          !under && action !== "where"
            ? " Nothing is reported at that point — check the coordinates against a screenshot before trusting it."
            : "";
        return { ok: true, message: `${verb}${size}${blind} The tab is on ${tab.url}.` };
      });
    },

    scroll({ tab: id, to, text, deltaY, by, threadId }) {
      const detail = to ? `to=${to}` : text ? `text=${JSON.stringify(text)}` : `deltaY=${deltaY}`;
      return run("scroll", { threadId, by, tabId: id, detail }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        type Scrolled = {
          moved: boolean;
          label?: string;
          container: string;
          scrollY: number;
          pageHeight: number;
          viewHeight: number;
          x: number;
          y: number;
        };
        const { result, frame } = await inBestFrame<Scrolled>(found.wc, scrollScript(to, deltaY, text));
        if (!result.ok) return { ok: false, message: result.error };

        let { scrollY, pageHeight } = result;
        let wheeled = false;
        // A pane that did not move under a programmatic scroll is usually one
        // that implements scrolling itself off the wheel event — a canvas, a
        // virtualised grid, a map. A synthesized wheel at the pane's own
        // coordinates is the only thing those respond to.
        if (!result.moved && typeof deltaY === "number") {
          const offset = frame === found.wc.mainFrame ? { x: 0, y: 0 } : await frameOffset(found.wc, frame);
          const point = { x: result.x + offset.x, y: result.y + offset.y };
          moveMouse(found.wc, point);
          // Electron's wheel delta runs the other way from ours: a positive
          // `deltaY` here means "scroll down", which is a negative wheel delta.
          found.wc.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY: -deltaY, canScroll: true });
          await delay(120);
          const after = await evaluate<{ scrollY: number; pageHeight: number; viewHeight: number }>(frame, scrollPositionScript());
          if (after.ok) {
            wheeled = after.scrollY !== scrollY;
            scrollY = after.scrollY;
            pageHeight = after.pageHeight;
          }
        }

        const reach = result.label ? ` "${result.label}" is now in view.` : "";
        const stuck =
          !result.moved && !wheeled && !to && !text
            ? " Nothing moved — that container is already at its limit; name the element with `to` or `text` instead."
            : "";
        return {
          ok: true,
          message: `Scrolled ${result.container} to y=${scrollY} of ${pageHeight} (viewport ${result.viewHeight}px).${reach}${stuck}`,
        };
      });
    },

    /**
     * Set a dropdown — native `<select>` first, then the ARIA pattern.
     *
     * Almost no serious web app ships a `<select>` any more: the control is a
     * div with `role=combobox` whose options are portalled to `document.body`
     * when it opens. Refusing anything that is not a `<select>` meant this tool
     * could not set a dropdown in exactly the apps that matter most. The ARIA
     * path clicks the trigger with a real mouse event, waits for the popup
     * wherever it renders, clicks the named option, and then reads the control
     * back so the result is a DOM fact rather than an assumption.
     */
    selectOption({ tab: id, selector, value, label, by, threadId }) {
      return run("select_option", { threadId, by, tabId: id, detail: summarizeArgs("select_option", { selector, text: value ?? label }) }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        const { result } = await inBestFrame<{ label: string; value: string }>(found.wc, selectOptionScript(selector, value, label));
        if (result.ok) {
          return { ok: true, message: `Chose "${result.label}" (value ${result.value}) in the <select>.` };
        }
        const native = result as { ok: false; error: string; aria?: boolean };
        if (!native.aria) return { ok: false, message: native.error };

        const trigger = await locate(found.wc, selector);
        if (isResult(trigger)) return trigger;
        found.wc.focus();
        moveMouse(found.wc, trigger.point);
        found.wc.sendInputEvent({ type: "mouseDown", ...trigger.point, button: "left", clickCount: 1 });
        found.wc.sendInputEvent({ type: "mouseUp", ...trigger.point, button: "left", clickCount: 1 });

        // The popup is portalled, so it is searched for across the whole
        // document rather than under the trigger — that is the step that fails
        // on most component libraries when it is not done this way.
        const option = await evaluate<ElementHit>(trigger.frame, ariaOptionScript(label, value, 4_000), 6_000);
        if (!option.ok) {
          return { ok: false, message: `${native.error} Opened it as an ARIA dropdown instead, but ${option.error}` };
        }
        if (!option.visible) {
          return { ok: false, message: `Found the option "${option.label}" but ${option.reason ?? "it is not visible"}.` };
        }

        const offset = trigger.frame === found.wc.mainFrame ? { x: 0, y: 0 } : await frameOffset(found.wc, trigger.frame);
        const point = { x: option.x + offset.x, y: option.y + offset.y };
        moveMouse(found.wc, point);
        found.wc.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        found.wc.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
        await whenLoaded(found.wc, found.tab);
        publish();

        const state = await evaluate<{ text: string; active?: string; selected?: string; expanded?: string }>(
          trigger.frame,
          comboStateScript(selector),
        );
        const confirmed = state.ok ? state.active || state.selected || state.text : "";
        return {
          ok: true,
          message:
            `Chose "${option.label}" in the ARIA ${trigger.hit.tag} (not a <select> — the trigger was clicked and the option picked from the popup).` +
            (confirmed ? ` The control now reads "${confirmed}".` : " Read it back to confirm it took."),
        };
      });
    },

    upload({ tab: id, selector, paths, by, threadId }) {
      return run("upload", { threadId, by, tabId: id, detail: summarizeArgs("upload", { selector, paths }) }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        const cdp = found.wc.debugger;
        if (!cdp) {
          return { ok: false, message: "This build cannot attach to the page to set a file input." };
        }

        // The one thing an injected script genuinely cannot do: a `File` cannot
        // be constructed from a path in page context, by design. CDP's
        // `DOM.setFileInputFiles` is the supported way in, and it is also what
        // every browser automation tool uses for exactly this.
        const attachedHere = !cdp.isAttached();
        try {
          if (attachedHere) cdp.attach("1.3");
          const document = (await cdp.sendCommand("DOM.getDocument")) as { root: { nodeId: number } };
          const node = (await cdp.sendCommand("DOM.querySelector", {
            nodeId: document.root.nodeId,
            selector,
          })) as { nodeId: number };
          if (!node.nodeId) {
            return { ok: false, message: `No element matches ${selector}. (File inputs inside a frame are not reachable this way.)` };
          }
          await cdp.sendCommand("DOM.setFileInputFiles", { nodeId: node.nodeId, files: paths });
          return { ok: true, message: `Attached ${paths.length} file${paths.length === 1 ? "" : "s"} to ${selector}.` };
        } catch (error) {
          return { ok: false, message: `Could not set the file input: ${String(error)}` };
        } finally {
          if (attachedHere) {
            try {
              cdp.detach();
            } catch {
              // Already gone, or the page navigated out from under us.
            }
          }
        }
      });
    },

    screenshot({ tab: id, by, threadId, background }) {
      return run("screenshot", { threadId, by, tabId: id, detail: background ? "background" : undefined }, async (context) => {
        // One budget over the whole thing, not one per stage. `live` alone can
        // spend 45s between attaching and loading before a capture is even
        // attempted, and an agent that gets no answer cannot even report why.
        const done = await withCeiling(
          (async (): Promise<BrowserOpResult> => {
            const found = await live(threadId, id, context);
            if (isResult(found)) return found;

            // A background capture leaves the user's panel exactly as it was —
            // the page is rendered rather than photographed. It still has to be
            // AWAKE, which `live` above guarantees; what it does not need is to
            // be the front tab, or the panel to be open at all.
            const rendered = background === true && !onScreen(found.tab);
            if (!rendered) await bringToFront(found.tab);

            // A live webview in another section is scriptable but not
            // paintable. Stage THAT guest rather than loading a duplicate page:
            // this preserves scroll position, form state and in-memory UI.
            const staged = !onScreen(found.tab) ? await deps.stageCapture?.(found.tab.id) : undefined;
            if (staged) {
              found.wc.setBackgroundThrottling?.(false);
              found.wc.invalidate?.();
            }

            let capture_;
            try {
              capture_ = await capture(found.wc, { skipPainted: rendered && !staged });
            } finally {
              if (staged) {
                staged();
                found.wc.setBackgroundThrottling?.(true);
              }
            }
            if (!capture_.ok) {
              return { ok: false, message: `Could not capture the tab: ${capture_.error}` };
            }

            try {
              mkdirSync(deps.screenshotDir, { recursive: true });
              const path = join(deps.screenshotDir, `${found.tab.id}-${now()}.png`);
              writeFileSync(path, capture_.png);
              pruneShots();
              // A capture is in device pixels; a click is in CSS pixels. Without
              // the ratio between them, "the button is at (840, 420) in this
              // image" cannot be turned into a cursor coordinate that lands —
              // which is the whole point of being able to read the picture.
              const probe = await evaluate<{
                viewport?: { width: number; height: number; scale: number; scrollX: number; scrollY: number };
              }>(found.wc, pointProbeScript(0, 0));
              // A page that is mid-navigation answers without a viewport; the
              // capture is still good, so this stays additive rather than fatal.
              const view = probe.ok ? probe.viewport : undefined;
              const space = view
                ? ` The page is ${view.width}×${view.height} CSS pixels at ${view.scale}× — divide a pixel coordinate in the image by ${view.scale} to get a \`browser_cursor\` coordinate.`
                : "";
              return {
                ok: true,
                message: `Captured \`${found.tab.id}\` (${tabLabel(found.tab)}) to ${path} — read that path to see it.${space}`,
              };
            } catch (error) {
              return { ok: false, message: `Could not write the capture: ${String(error)}` };
            }
          })(),
          SCREENSHOT_BUDGET_MS,
        );
        if (done === TIMED_OUT) {
          return {
            ok: false,
            message:
              `The capture did not finish within ${Math.round(SCREENSHOT_BUDGET_MS / 1000)}s and was given up on. ` +
              `The page may still be loading — check it with \`browser_read\`, then try again.`,
          };
        }
        return done;
      });
    },

    record({ tab: id, action, fps, by, threadId, background }) {
      return run("record", { threadId, by, tabId: id, detail: background ? `${action} (background)` : action }, async (context) => {
        if (action === "stop") {
          return stopRecording("asked to");
        }

        if (recording) {
          return { ok: false, message: `Already recording \`${recording.tabId}\`. Stop that one first.` };
        }

        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        // Recording is a thing to watch, so bring the panel up — and it is also
        // what makes the frames cheap to grab, since a tab nobody is painting
        // costs a CDP render per frame. `background` buys the user's screen back
        // at exactly that price, which is why it is opt-in and why the frame rate
        // matters more when it is on.
        const hidden = background === true;
        if (!hidden) front(found.tab);

        const rate = Math.min(Math.max(fps ?? DEFAULT_FPS, 1), MAX_FPS);
        const framesDir = join(deps.screenshotDir, `recording-${found.tab.id}-${now()}`);
        mkdirSync(framesDir, { recursive: true });

        const session: Recording = {
          tabId: found.tab.id,
          framesDir,
          fps: rate,
          startedAt: now(),
          frames: 0,
          misses: 0,
          background: hidden,
          timer: setInterval(() => {
            const current = recording;
            if (!current) return;
            if (now() - current.startedAt > MAX_RECORDING_MS) {
              void stopRecording("the five-minute ceiling");
              return;
            }
            const tab = tabs.get(current.tabId);
            const wc = tab ? contentsFor(tab) : undefined;
            if (!tab || !wc) {
              current.misses += 1;
              return;
            }
            void capture(wc, { skipPainted: current.background && !onScreen(tab) })
              .then((grabbed) => {
                if (!grabbed.ok) {
                  current.misses += 1;
                  return;
                }
                writeFileSync(join(current.framesDir, `frame-${String(current.frames).padStart(6, "0")}.png`), grabbed.png);
                current.frames += 1;
              })
              .catch(() => {
                current.misses += 1;
              });
          }, Math.round(1000 / rate)),
        };
        session.timer.unref?.();
        recording = session;
        found.tab.recording = true;
        publish();

        return {
          ok: true,
          message:
            `Recording \`${found.tab.id}\` at ${rate} fps${hidden ? ", in the background — the panel is left as the user had it" : ""}. ` +
            "Call `browser_record` with action `stop` when you are done — it stops on its own after five minutes.",
        };
      });
    },

    note({ tab: id, text, selector, clear, by, threadId }) {
      return run("note", { threadId, by, tabId: id, detail: clear ? "clear" : summarizeArgs("note", { selector, text }) }, async (context) => {
        if (!clear && !text.trim()) return { ok: false, message: "A note needs something to say." };

        const found = await live(threadId, id, context);
        if (isResult(found)) return found;

        // An agent that left a note and then needs the page back has to be able
        // to take its own overlay off. Only the note this section left: a note
        // is a hand-off, and clearing someone else's would erase a question the
        // user has not answered yet.
        if (clear) {
          const existing = found.tab.note;
          if (!existing) return { ok: true, message: `There is no note on \`${found.tab.id}\`.` };
          if (existing.from && by && existing.from !== by) {
            return { ok: false, message: `That note was left by ${existing.fromTitle ?? "another section"} — only they or the user can clear it.` };
          }
          found.tab.note = undefined;
          publish();
          await evaluate<{ ok: true }>(found.wc, clearNoteScript(existing.selector));
          return { ok: true, message: `Took your note off \`${found.tab.id}\` — the page is yours again.` };
        }

        const note: BrowserNote = {
          text: text.trim(),
          from: by,
          fromTitle: by ? deps.sectionTitle?.(by) : undefined,
          selector,
          at: new Date(now()).toISOString(),
        };
        found.tab.note = note;
        activeTabByThread.set(threadId, found.tab.id);
        deps.revealPanel(threadId);
        publish();

        const drawn = await evaluate<{ anchored: boolean }>(found.wc, drawNoteScript(note));
        const anchor = drawn.ok && drawn.anchored ? " The element is ringed and scrolled into view." : "";
        return {
          ok: true,
          message:
            `Left the note on \`${found.tab.id}\` (${tabLabel(found.tab)}) and brought the browser to the front.${anchor}\n` +
            "The user sees it on the tab and on the page. When they clear it you get a message saying so — do not wait on it in a loop.",
        };
      });
    },

    async setNoteHidden(tabId, hidden) {
      const tab = tabs.get(tabId);
      if (!tab?.note) return false;

      const note = tab.note;
      note.hidden = hidden || undefined;
      publish();

      const wc = contentsFor(tab);
      if (wc) {
        const script = hidden ? clearNoteScript(note.selector) : drawNoteScript(note);
        await wc.executeJavaScript(script, true).catch(() => undefined);
      }
      deps.audit?.({
        at: new Date(now()).toISOString(),
        threadId: tab.threadId,
        actor: "You",
        action: hidden ? "hide_note" : "show_note",
        tabId,
        url: tab.url,
        ok: true,
        outcome: hidden ? "hid the agent note without resolving it" : "restored the agent note",
        ms: 0,
      });
      return true;
    },

    resolveNote(tabId) {
      const tab = tabs.get(tabId);
      if (!tab?.note) return undefined;
      const note = tab.note;
      tab.note = undefined;
      publish();
      const wc = contentsFor(tab);
      void wc?.executeJavaScript(clearNoteScript(note.selector), true).catch(() => undefined);
      deps.audit?.({
        at: new Date(now()).toISOString(),
        threadId: tab.threadId,
        actor: "You",
        action: "resolve_note",
        tabId,
        url: tab.url,
        detail: note.from ? `answering ${actorName(note.from)}` : undefined,
        ok: true,
        ms: 0,
        outcome: note.text.slice(0, 200),
      });
      return { from: note.from, tabTitle: tabLabel(tab), url: tab.url, note };
    },

    close({ tab: id, by, threadId }) {
      return run("close", { threadId, by, tabId: id }, async () => {
        const tab = pick(threadId, id);
        if (!tab) return missing(threadId, id);
        if (recording?.tabId === tab.id) {
          await stopRecording("the tab was closed");
        }
        tabs.delete(tab.id);
        if (activeTabByThread.get(threadId) === tab.id) {
          const next = mine(threadId)[0];
          if (next) activeTabByThread.set(threadId, next.id);
          else activeTabByThread.delete(threadId);
        }
        publish();
        return { ok: true, message: `Closed \`${tab.id}\`.` };
      });
    },

    select({ threadId, tabId }) {
      const tab = tabs.get(tabId);
      if (!tab || tab.threadId !== threadId) return;
      activeTabByThread.set(threadId, tabId);
      // Clicking a slept tab in the strip is the commonest way to wake one.
      touch(tab);
      publish();
    },

    back({ tab: id, by, threadId }) {
      return run("back", { threadId, by, tabId: id }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;
        if (!found.wc.navigationHistory.canGoBack()) return { ok: false, message: `\`${found.tab.id}\` has nothing to go back to.` };
        found.wc.navigationHistory.goBack();
        await whenLoaded(found.wc, found.tab);
        publish();
        return { ok: true, message: `\`${found.tab.id}\` went back to ${found.tab.url}.` };
      });
    },

    forward({ tab: id, by, threadId }) {
      return run("forward", { threadId, by, tabId: id }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;
        if (!found.wc.navigationHistory.canGoForward()) return { ok: false, message: `\`${found.tab.id}\` has nothing to go forward to.` };
        found.wc.navigationHistory.goForward();
        await whenLoaded(found.wc, found.tab);
        publish();
        return { ok: true, message: `\`${found.tab.id}\` went forward to ${found.tab.url}.` };
      });
    },

    reload({ tab: id, by, threadId }) {
      return run("reload", { threadId, by, tabId: id }, async (context) => {
        const found = await live(threadId, id, context);
        if (isResult(found)) return found;
        found.wc.reload();
        await whenLoaded(found.wc, found.tab);
        publish();
        return { ok: true, message: `Reloaded \`${found.tab.id}\`.` };
      });
    },

    activity({ threadId, limit }) {
      // Read a generous window and then narrow, so a busy neighbour cannot push
      // this section's own history out of the answer.
      const all = deps.activity?.() ?? [];
      const ours = all.filter((record) => record.threadId === threadId);
      return { ok: true, message: renderActivity(ours, limit ?? 40) };
    },

    closeThread(threadId) {
      if (recording && tabs.get(recording.tabId)?.threadId === threadId) {
        void stopRecording("the section was closed");
      }
      for (const tab of mine(threadId)) {
        tabs.delete(tab.id);
      }
      activeTabByThread.delete(threadId);
      publish();
    },

    sweep({ visibleThreadId, idleTimeoutMs, maxAwake }) {
      const visibleTabId = visibleThreadId ? activeTabByThread.get(visibleThreadId) : undefined;
      const evictions = selectTabEvictions({
        tabs: [...tabs.values()].map((tab) => ({
          id: tab.id,
          threadId: tab.threadId,
          lastUsedAt: tab.lastUsedAt ?? 0,
          recording: tab.recording,
          hasNote: Boolean(tab.note),
          loading: tab.loading,
          asleep: tab.asleep,
        })),
        maxAwake: maxAwake ?? MAX_AWAKE_TABS,
        idleTimeoutMs: idleTimeoutMs ?? TAB_IDLE_MS,
        now: now(),
        visibleTabId,
      });
      if (!evictions.length) return;

      for (const eviction of evictions) {
        const tab = tabs.get(eviction.id);
        if (!tab) continue;
        tab.asleep = true;
        tab.loading = false;
        // The renderer unmounts the webview for a sleeping tab, which is what
        // actually frees the process; dropping the id here stops us driving a
        // guest that is about to go away.
        tab.webContentsId = undefined;
        deps.log("browser-tab-slept", { tabId: tab.id, threadId: tab.threadId, reason: eviction.reason });
        // Sleeping is something that happened TO the user's tab, so it belongs
        // in the same log as everything else that touched it.
        deps.audit?.({
          at: new Date(now()).toISOString(),
          threadId: tab.threadId,
          actor: "Panda Code",
          action: "sleep",
          tabId: tab.id,
          url: tab.url,
          detail: eviction.reason === "idle" ? "idle" : "over the awake ceiling",
          ok: true,
          ms: 0,
          outcome: "Page released; it reloads when anything touches the tab.",
        });
      }
      publish();
    },

    setPanelVisible({ threadId, visible }) {
      const had = visibleThreads.has(threadId);
      if (visible) visibleThreads.add(threadId);
      else visibleThreads.delete(threadId);
      if (had !== visible) publish();
    },

    setFloating(on) {
      if (floating === on) return;
      floating = on;
      // Every guest is about to be destroyed by the window that is losing it.
      // Dropping the ids here stops us driving a page that no longer exists;
      // the new host attaches fresh ones as it mounts them.
      for (const tab of tabs.values()) {
        tab.webContentsId = undefined;
        tab.loading = true;
      }
      deps.log("browser-floating", { floating: on, tabs: tabs.size });
      publish();
    },

    stats() {
      const all = [...tabs.values()];
      const asleep = all.filter((tab) => tab.asleep).length;
      return { tabs: all.length, awake: all.length - asleep, asleep };
    },

    dispose() {
      if (recording) {
        clearInterval(recording.timer);
        recording = null;
      }
    },
  };
}

/** `browser_list` for one section, rendered from a snapshot. */
export function describeBrowser(state: BrowserState, threadId: string): string {
  return renderBrowser(state, threadId);
}

export { renderTabLine };
