import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserActivity, BrowserState } from "../shared/browser";
import { createBrowserService, describeBrowser, type BrowserService, type GuestContents, type GuestFrame } from "./browserService";

/**
 * The service is tested against a fake page rather than a real one.
 *
 * That is the reason it takes its guest as a structural type instead of
 * importing `electron`: everything worth checking here — that a click lands at
 * the right coordinates, that a frame's offset is added in, that every action
 * leaves an audit record, that a failure is recorded as a failure — is about
 * this code's own decisions, not about Chromium.
 */

type ScriptHandler = (source: string) => unknown;

type FakeFrame = GuestFrame & { scripts: string[] };

function makeFrame(url: string, handler: ScriptHandler, parent?: GuestFrame): FakeFrame {
  const frame: FakeFrame = {
    url,
    parent: parent ?? null,
    scripts: [],
    executeJavaScript: (source: string) => {
      frame.scripts.push(source);
      return Promise.resolve(handler(source));
    },
  };
  return frame;
}

type FakeGuest = GuestContents & {
  input: Record<string, unknown>[];
  typed: string[];
  loaded: string[];
  frames: FakeFrame[];
};

function makeGuest(options: { handler?: ScriptHandler; nested?: { url: string; handler: ScriptHandler }; png?: Buffer } = {}): FakeGuest {
  const handler: ScriptHandler = options.handler ?? (() => ({ ok: true }));
  const main = makeFrame("https://example.com/", handler);
  const nested = options.nested ? makeFrame(options.nested.url, options.nested.handler, main) : undefined;
  main.framesInSubtree = nested ? [main, nested] : [main];

  const guest: FakeGuest = {
    input: [],
    typed: [],
    loaded: [],
    frames: nested ? [main, nested] : [main],
    isDestroyed: () => false,
    isLoading: () => false,
    loadURL: (url: string) => {
      guest.loaded.push(url);
      return Promise.resolve();
    },
    executeJavaScript: main.executeJavaScript,
    focus: () => undefined,
    insertText: (text: string) => guest.typed.push(text),
    sendInputEvent: (event: Record<string, unknown>) => guest.input.push(event),
    capturePage: () => Promise.resolve({ toPNG: () => options.png ?? Buffer.from([1, 2, 3]) }),
    reload: () => undefined,
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: () => guest.loaded.push("(back)"),
      goForward: () => undefined,
    },
    on: () => undefined,
    off: () => undefined,
    mainFrame: main,
  };
  return guest;
}

/**
 * A debugger that answers the off-surface render the way a real page does:
 * layout metrics, then the metrics override, then the clipped capture.
 */
type CdpCommand = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function makeCdp(png = "rendered") {
  const sendCommand = vi.fn<CdpCommand>(async (method) => {
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { clientWidth: 900, clientHeight: 700, pageX: 0, pageY: 120 } };
    }
    if (method === "Page.captureScreenshot") return { data: Buffer.from(png).toString("base64") };
    return {};
  });
  return { attach: () => undefined, isAttached: () => false, detach: () => undefined, sendCommand };
}

/** The params one recorded `sendCommand` call was made with. */
const paramsOf = (cdp: ReturnType<typeof makeCdp>, index: number): Record<string, unknown> =>
  cdp.sendCommand.mock.calls[index]?.[1] ?? {};

/** The shape `findElementScript` returns for a hit. */
const hit = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  visible: true,
  x: 100,
  y: 50,
  label: "Save",
  tag: "button",
  ...patch,
});

const NO_MATCH = { ok: false, error: "No element matches .save" };

/** The section under test. Tabs belong to one, so every call names it. */
const T = "sec-1";
/** A second section, for the isolation tests. */
const OTHER = "sec-2";

describe("browserService", () => {
  let service: BrowserService;
  let guest: FakeGuest;
  let states: BrowserState[];
  let records: BrowserActivity[];
  let revealed: number;
  let screenshotDir: string;
  /** Advanceable, so the idle sweep has something to measure against. */
  let clock: number;

  function build(options: Parameters<typeof makeGuest>[0] = {}, extra: Record<string, unknown> = {}): void {
    guest = makeGuest(options);
    states = [];
    records = [];
    revealed = 0;
    screenshotDir = mkdtempSync(join(tmpdir(), "panda-browser-test-"));
    clock = 1_700_000_000_000;
    service = createBrowserService({
      broadcast: (state) => states.push(state),
      revealPanel: () => {
        revealed += 1;
      },
      sectionTitle: (id) => (id === T ? "Billing cleanup" : id === OTHER ? "Release cutting" : undefined),
      contentsById: () => guest,
      screenshotDir,
      audit: (record) => records.push(record),
      activity: (limit) => records.slice(-(limit ?? 40)),
      log: () => undefined,
      now: () => clock,
      ...extra,
    });
  }

  /** Open a tab and complete the renderer's attach handshake, as the UI would. */
  async function openTabIn(threadId: string, url = "https://example.com"): Promise<string> {
    const opening = service.open({ threadId, url });
    service.attach(states.at(-1)?.tabs.at(-1)?.id ?? "", 42);
    const result = await opening;
    return result.tabId ?? "";
  }

  async function openTab(url = "https://example.com", by?: string): Promise<string> {
    const opening = service.open({ threadId: by ?? T, by, url });
    // The renderer mounts the webview and reports back; the id is in the state
    // main broadcast before it started waiting.
    const pending = states.at(-1)?.tabs.at(-1);
    service.attach(pending?.id ?? "", 42);
    const result = await opening;
    return result.tabId ?? "";
  }

  beforeEach(() => {
    build();
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  describe("opening", () => {
    it("broadcasts the tab before it is attached, so the renderer can mount it", async () => {
      const opening = service.open({ threadId: T, url: "example.com" });
      expect(states.at(-1)?.tabs).toHaveLength(1);
      expect(states.at(-1)?.tabs[0]?.url).toBe("https://example.com/");
      expect(revealed).toBe(1);

      service.attach(states[0]?.tabs[0]?.id ?? "", 42);
      const result = await opening;
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Opened");
    });

    it("credits the section that opened it", async () => {
      await openTab("https://example.com", "sec-1");
      expect(service.state().tabs[0]?.openedBy).toBe("Billing cleanup");
    });

    it("refuses a URL that is not http(s)", async () => {
      const result = await service.open({ threadId: T, url: "file:///etc/passwd" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Refusing");
      expect(service.state().tabs).toHaveLength(0);
    });

    it("caps the number of tabs a runaway agent can open", async () => {
      for (let index = 0; index < 12; index += 1) {
        const opening = service.open({ threadId: T, url: `https://example.com/${index}` });
        service.attach(states.at(-1)?.tabs.at(-1)?.id ?? "", 42);
        await opening;
      }
      const result = await service.open({ threadId: T, url: "https://example.com/13" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("12 tabs");
    });
  });

  describe("clicking", () => {
    it("sends a real mouse event at the element's own coordinates", async () => {
      build({ handler: () => hit() });
      const tabId = await openTab();

      const result = await service.click({ threadId: T, tab: tabId, text: "Save" });
      expect(result.ok).toBe(true);
      expect(guest.input).toEqual([
        { type: "mouseMove", x: 100, y: 50 },
        { type: "mouseDown", x: 100, y: 50, button: "left", clickCount: 1 },
        { type: "mouseUp", x: 100, y: 50, button: "left", clickCount: 1 },
      ]);
    });

    it("passes the button and click count through", async () => {
      build({ handler: () => hit() });
      const tabId = await openTab();

      await service.click({ threadId: T, tab: tabId, selector: ".row", button: "right", clickCount: 2 });
      expect(guest.input.at(-1)).toMatchObject({ button: "right", clickCount: 2 });
    });

    it("refuses to click something that is not visible", async () => {
      build({ handler: () => hit({ visible: false }) });
      const tabId = await openTab();

      const result = await service.click({ threadId: T, tab: tabId, selector: ".save" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not visible");
      expect(guest.input).toHaveLength(0);
    });

    it("reports the page's own error when nothing matches", async () => {
      build({ handler: () => NO_MATCH });
      const tabId = await openTab();

      const result = await service.click({ threadId: T, tab: tabId, selector: ".save" });
      expect(result.ok).toBe(false);
      expect(result.message).toBe("No element matches .save");
    });

    it("says WHICH kind of unreachable, since being off screen is no longer one of them", async () => {
      // The page scrolls to the element before reporting, so a refusal now has
      // to name something scrolling could not have fixed.
      build({ handler: () => hit({ visible: false, reason: '<div> "Cookie banner" is covering it' }) });
      const tabId = await openTab();

      const result = await service.click({ threadId: T, tab: tabId, selector: ".save" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain('<div> "Cookie banner" is covering it');
      expect(guest.input).toHaveLength(0);
    });
  });

  describe("the cursor", () => {
    /** The page's answer to `pointProbeScript`: what is there, and the coordinate space. */
    const point = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
      ok: true,
      under: { tag: "canvas#board", label: "", clickable: false },
      viewport: { width: 1280, height: 800, scale: 2, scrollX: 0, scrollY: 0 },
      ...patch,
    });
    /** A guest whose page answers the probe, and draws the cursor without comment. */
    const cursorPage = (patch: Record<string, unknown> = {}): ScriptHandler => (source) =>
      source.includes("scrollX") ? point(patch) : { ok: true };

    const mouse = (): Record<string, unknown>[] => guest.input.filter((event) => event.type !== "mouseMove");

    it("clicks a bare coordinate, and says what was under it", async () => {
      build({ handler: cursorPage({ under: { tag: "canvas#board", label: "", clickable: false } }) });
      const tabId = await openTab();

      const result = await service.cursor({ threadId: T, tab: tabId, action: "click", x: 420, y: 300 });
      expect(result.ok).toBe(true);
      expect(mouse()).toEqual([
        { type: "mouseDown", x: 420, y: 300, button: "left", clickCount: 1 },
        { type: "mouseUp", x: 420, y: 300, button: "left", clickCount: 1 },
      ]);
      expect(result.message).toContain("over canvas#board");
      expect(result.message).toContain("viewport is 1280×800");
    });

    it("remembers where it is, so a later call can act without coordinates", async () => {
      build({ handler: cursorPage() });
      const tabId = await openTab();

      await service.cursor({ threadId: T, tab: tabId, action: "move", x: 100, y: 120 });
      guest.input.length = 0;
      const result = await service.cursor({ threadId: T, tab: tabId, action: "click" });
      expect(result.ok).toBe(true);
      // The pointer did not go home between calls: this is what keeps a
      // hover-opened menu open long enough to click something in it.
      expect(mouse()).toEqual([
        { type: "mouseDown", x: 100, y: 120, button: "left", clickCount: 1 },
        { type: "mouseUp", x: 100, y: 120, button: "left", clickCount: 1 },
      ]);
    });

    it("moves relative to where it already is", async () => {
      build({ handler: cursorPage() });
      const tabId = await openTab();

      await service.cursor({ threadId: T, tab: tabId, action: "move", x: 200, y: 200 });
      const result = await service.cursor({ threadId: T, tab: tabId, action: "move", dx: 40, dy: -25 });
      expect(result.message).toContain("(240, 175)");
    });

    it("holds a button down across separate calls, and releases it on another", async () => {
      build({ handler: cursorPage() });
      const tabId = await openTab();

      await service.cursor({ threadId: T, tab: tabId, action: "down", x: 50, y: 50 });
      const held = await service.cursor({ threadId: T, tab: tabId, action: "move", dx: 30, dy: 0 });
      expect(held.ok).toBe(true);
      const released = await service.cursor({ threadId: T, tab: tabId, action: "up" });
      expect(released.ok).toBe(true);

      expect(mouse()).toEqual([
        { type: "mouseDown", x: 50, y: 50, button: "left", clickCount: 1 },
        { type: "mouseUp", x: 80, y: 50, button: "left", clickCount: 1 },
      ]);
    });

    it("drags along a path with the button held, not as a teleport", async () => {
      build({ handler: cursorPage() });
      const tabId = await openTab();

      await service.cursor({ threadId: T, tab: tabId, action: "drag", x: 0, y: 0, toX: 140, toY: 70 });
      const moves = guest.input.filter((event) => event.type === "mouseMove");
      // Interpolated: a hand-rolled slider tracks mousemove, and a single jump
      // reads as no movement at all.
      expect(moves.length).toBeGreaterThan(10);
      expect(mouse()).toEqual([
        { type: "mouseDown", x: 0, y: 0, button: "left", clickCount: 1 },
        { type: "mouseUp", x: 140, y: 70, button: "left", clickCount: 1 },
      ]);
    });

    it("puts the pointer on a named element, letting the page say where that is", async () => {
      build({ handler: (source) => (source.includes("scrollX") ? point() : source.includes("visible") ? hit({ x: 640, y: 480 }) : { ok: true }) });
      const tabId = await openTab();

      const result = await service.cursor({ threadId: T, tab: tabId, action: "move", text: "Save" });
      expect(result.message).toContain("(640, 480)");
    });

    it("refuses a coordinate outside the viewport instead of firing into nothing", async () => {
      // Chromium silently drops an out-of-bounds event, which looks exactly like
      // a click that did nothing — the worst failure to debug.
      build({ handler: cursorPage() });
      const tabId = await openTab();

      const result = await service.cursor({ threadId: T, tab: tabId, action: "click", x: 2_000, y: 300 });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("1280×800");
      expect(mouse()).toHaveLength(0);
    });

    it("says there is no `here` yet rather than clicking the top-left corner", async () => {
      build({ handler: cursorPage() });
      const tabId = await openTab();

      const result = await service.cursor({ threadId: T, tab: tabId, action: "click" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not on this page yet");
      expect(mouse()).toHaveLength(0);
    });

    it("warns when the page reports nothing at all under the pointer", async () => {
      build({ handler: cursorPage({ under: undefined }) });
      const tabId = await openTab();

      const result = await service.cursor({ threadId: T, tab: tabId, action: "click", x: 10, y: 10 });
      expect(result.message).toContain("check the coordinates against a screenshot");
    });

    it("reports without touching anything when asked where it is", async () => {
      build({ handler: cursorPage() });
      const tabId = await openTab();

      await service.cursor({ threadId: T, tab: tabId, action: "move", x: 12, y: 34 });
      guest.input.length = 0;
      const result = await service.cursor({ threadId: T, tab: tabId, action: "where" });
      expect(result.message).toContain("(12, 34)");
      expect(mouse()).toHaveLength(0);
    });

    it("draws the cursor into the page, so the user can see where the agent's hand is", async () => {
      build({ handler: cursorPage() });
      const tabId = await openTab();

      await service.cursor({ threadId: T, tab: tabId, action: "move", x: 90, y: 45 });
      const drawn = guest.frames[0]?.scripts.filter((source) => source.includes("__panda_code_cursor__")) ?? [];
      expect(drawn.length).toBeGreaterThan(0);
      expect(drawn.at(-1)).toContain("translate(");
      // It must never intercept the page's own input, nor show up as the thing
      // under the cursor.
      expect(drawn.at(-1)).toContain("pointer-events:none");
    });

    it("takes the cursor back off on request", async () => {
      build({ handler: cursorPage() });
      const tabId = await openTab();

      await service.cursor({ threadId: T, tab: tabId, action: "move", x: 5, y: 5 });
      const result = await service.cursor({ threadId: T, tab: tabId, action: "hide" });
      expect(result.ok).toBe(true);
      expect(guest.frames[0]?.scripts.at(-1)).toContain("remove()");
    });
  });

  describe("scrolling", () => {
    const scrolled = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
      ok: true,
      moved: true,
      container: "<div.pane>",
      scrollY: 420,
      pageHeight: 3_000,
      viewHeight: 700,
      x: 640,
      y: 400,
      ...patch,
    });

    it("names the pane it moved, not just a page offset", async () => {
      build({ handler: () => scrolled() });
      const tabId = await openTab();

      const result = await service.scroll({ threadId: T, tab: tabId, deltaY: 900 });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("<div.pane>");
      expect(result.message).toContain("y=420 of 3000");
    });

    it("scrolls to an element named only by its visible text", async () => {
      build({ handler: () => scrolled({ label: "Orçamento total" }) });
      const tabId = await openTab();

      const result = await service.scroll({ threadId: T, tab: tabId, text: "Orçamento total" });
      expect(result.ok).toBe(true);
      expect(result.message).toContain('"Orçamento total" is now in view');
      expect(records.at(-1)?.detail).toContain("Orçamento total");
    });

    it("falls back to a real wheel event when nothing moved programmatically", async () => {
      // A canvas or a virtualised grid implements scrolling off the wheel event
      // itself, so setting scrollTop does nothing at all to it.
      build({
        handler: (source) =>
          !source.includes("const delta =")
            ? { ok: true, scrollY: 900, pageHeight: 3_000, viewHeight: 700 }
            : scrolled({ moved: false, scrollY: 0 }),
      });
      const tabId = await openTab();

      const result = await service.scroll({ threadId: T, tab: tabId, deltaY: 900 });
      expect(result.ok).toBe(true);
      // Aimed at the pane's own coordinates, and inverted: Electron's wheel
      // delta runs the opposite way from ours.
      expect(guest.input.at(-1)).toMatchObject({ type: "mouseWheel", x: 640, y: 400, deltaY: -900 });
      expect(result.message).toContain("y=900 of 3000");
    });

    it("says so plainly when the pane is already at its limit", async () => {
      build({ handler: (source) => (!source.includes("const delta =") ? { ok: true, scrollY: 0, pageHeight: 700, viewHeight: 700 } : scrolled({ moved: false, scrollY: 0, pageHeight: 700 })) });
      const tabId = await openTab();

      const result = await service.scroll({ threadId: T, tab: tabId, deltaY: 900 });
      expect(result.message).toContain("Nothing moved");
    });
  });

  describe("dropdowns", () => {
    /** What the page says when the target is a div-based combobox, not a <select>. */
    const NOT_A_SELECT = { ok: false, aria: true, role: "combobox", error: "That is a <div>, not a <select>." };

    it("sets a native <select> without touching the mouse", async () => {
      build({ handler: () => ({ ok: true, label: "Brazil", value: "BR" }) });
      const tabId = await openTab();

      const result = await service.selectOption({ threadId: T, tab: tabId, selector: "#country", label: "Brazil" });
      expect(result.ok).toBe(true);
      expect(result.message).toContain('Chose "Brazil"');
      expect(guest.input).toHaveLength(0);
    });

    it("drives an ARIA combobox: clicks the trigger, then the option in the portalled popup", async () => {
      build({
        handler: (source) => {
          if (source.includes("not a <select>")) return NOT_A_SELECT;
          if (source.includes("aria-activedescendant")) return { ok: true, text: "Orçamento diário", expanded: "false" };
          if (source.includes("role=option")) return { ok: true, visible: true, x: 300, y: 480, label: "Orçamento diário", tag: "div" };
          return hit({ label: "Orçamento total", tag: "div", x: 200, y: 120 });
        },
      });
      const tabId = await openTab();

      const result = await service.selectOption({ threadId: T, tab: tabId, selector: "[role=combobox]", label: "Orçamento diário" });
      expect(result.ok).toBe(true);
      // Two real clicks: the trigger where it is, then the option where the
      // popup rendered it — which is nowhere near the trigger.
      expect(guest.input.filter((event) => event.type === "mouseDown")).toEqual([
        { type: "mouseDown", x: 200, y: 120, button: "left", clickCount: 1 },
        { type: "mouseDown", x: 300, y: 480, button: "left", clickCount: 1 },
      ]);
      expect(result.message).toContain('The control now reads "Orçamento diário"');
    });

    it("lists what the open dropdown does offer when the option is not there", async () => {
      build({
        handler: (source) => {
          if (source.includes("not a <select>")) return NOT_A_SELECT;
          if (source.includes("role=option")) return { ok: false, error: "The dropdown is open but has no such option. It offers: Daily | Lifetime" };
          return hit({ tag: "div" });
        },
      });
      const tabId = await openTab();

      const result = await service.selectOption({ threadId: T, tab: tabId, selector: "[role=combobox]", label: "Weekly" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("It offers: Daily | Lifetime");
    });
  });

  describe("inspecting", () => {
    it("reports field state and a selector that will address it again", async () => {
      build({
        handler: () => ({
          ok: true,
          total: 1,
          matches: [
            {
              selector: '[data-testid="adset-name"]',
              tag: "input",
              role: "textbox",
              name: "Ad set name",
              type: "text",
              value: "Conjunto de anúncios — cópia",
              visible: true,
              box: { x: 10, y: 20, w: 300, h: 32 },
            },
          ],
        }),
      });
      const tabId = await openTab();

      const result = await service.inspect({ threadId: T, tab: tabId, text: "Ad set name" });
      expect(result.ok).toBe(true);
      expect(result.message).toContain('[data-testid="adset-name"]');
      expect(result.message).toContain('value="Conjunto de anúncios — cópia"');
    });

    it("appends form state to a read when asked, since rendered text cannot carry it", async () => {
      build({
        handler: (source) =>
          source.includes("FORM")
            ? { ok: true, total: 1, matches: [{ selector: "#budget", tag: "input", value: "50", visible: true, box: { x: 0, y: 0, w: 1, h: 1 } }] }
            : { ok: true, title: "Ad set", url: "https://example.com/", text: "Budget", links: [] },
      });
      const tabId = await openTab();

      const result = await service.read({ threadId: T, tab: tabId, values: true });
      expect(result.message).toContain("## Form state");
      expect(result.message).toContain('`#budget`');
      expect(result.message).toContain('value="50"');
    });
  });

  describe("frames", () => {
    it("finds an element in a nested frame and offsets the click into page coordinates", async () => {
      // The main document has neither the button nor — until asked — the frame's
      // position; the frame has the button at its own (100, 50).
      build({
        handler: (source) => (source.includes("frames") ? { ok: true, x: 300, y: 200 } : NO_MATCH),
        nested: { url: "https://pay.example.com/card", handler: () => hit({ label: "Pay" }) },
      });
      const tabId = await openTab();

      const result = await service.click({ threadId: T, tab: tabId, text: "Pay" });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("in the frame at https://pay.example.com/card");
      // 100 + 300 across, 50 + 200 down: the frame's offset in the top document.
      expect(guest.input.at(-1)).toMatchObject({ x: 400, y: 250 });
    });

    it("says which frame a read came from", async () => {
      build({
        handler: () => NO_MATCH,
        nested: {
          url: "https://docs.example.com/embed",
          handler: () => ({ ok: true, title: "Embedded", url: "https://docs.example.com/embed", text: "Inside", links: [] }),
        },
      });
      const tabId = await openTab();

      const result = await service.read({ threadId: T, tab: tabId });
      expect(result.message).toContain("Inside");
      expect(result.message).toContain("[Read from the frame at https://docs.example.com/embed]");
    });
  });

  describe("typing and keys", () => {
    it("focuses, inserts, and only presses Enter when asked", async () => {
      build({ handler: () => ({ ok: true, tag: "input" }) });
      const tabId = await openTab();

      await service.type({ threadId: T, tab: tabId, selector: "#q", text: "hello" });
      expect(guest.typed).toEqual(["hello"]);
      expect(guest.input).toHaveLength(0);

      await service.type({ threadId: T, tab: tabId, selector: "#q", text: "again", submit: true });
      expect(guest.input.map((event) => event.type)).toEqual(["keyDown", "char", "keyUp"]);
    });

    it("does not emit a character for a chord, so Cmd+A does not type an 'a'", async () => {
      const tabId = await openTab();
      await service.key({ threadId: T, tab: tabId, keys: "Cmd+A" });
      expect(guest.input.map((event) => event.type)).toEqual(["keyDown", "keyUp"]);
      expect(guest.input[0]).toMatchObject({ keyCode: "A", modifiers: ["cmd"] });
    });

    it("emits a character for a plain letter", async () => {
      const tabId = await openTab();
      await service.key({ threadId: T, tab: tabId, keys: "k" });
      expect(guest.input.map((event) => event.type)).toEqual(["keyDown", "char", "keyUp"]);
    });

    it("rejects a key name it does not know rather than pressing nothing", async () => {
      const tabId = await openTab();
      const result = await service.key({ threadId: T, tab: tabId, keys: "Wiggle" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Unknown key");
      expect(guest.input).toHaveLength(0);
    });
  });

  describe("drag", () => {
    it("presses, moves through intermediate points, and releases at the target", async () => {
      let call = 0;
      build({
        handler: () => {
          call += 1;
          return call === 1 ? hit({ x: 0, y: 0, label: "Card" }) : hit({ x: 120, y: 0, label: "Done column" });
        },
      });
      const tabId = await openTab();

      const result = await service.drag({ threadId: T, tab: tabId, from: ".card", to: ".done" });
      expect(result.ok).toBe(true);
      const moves = guest.input.filter((event) => event.type === "mouseMove");
      expect(moves.length).toBeGreaterThan(5);
      expect(guest.input[0]).toMatchObject({ type: "mouseMove", x: 0 });
      expect(guest.input.at(-1)).toMatchObject({ type: "mouseUp", x: 120 });
    });
  });

  describe("screenshots and recording", () => {
    it("writes a PNG and hands back the path", async () => {
      const tabId = await openTab();
      const result = await service.screenshot({ threadId: T, tab: tabId });
      expect(result.ok).toBe(true);
      const path = result.message.match(/to (\S+\.png)/)?.[1] ?? "";
      expect(existsSync(path)).toBe(true);
    });

    it("brings the tab to the front before capturing it", async () => {
      // The defect this came from: `open` and `note` both front their tab and
      // reveal the panel, `screenshot` did neither — so it photographed a tab
      // nothing was painting and failed. Agents worked around it by calling
      // `browser_note` first, which leaves a real note on the user's page.
      const tabId = await openTab();
      const other = await openTab("https://elsewhere.example");
      expect(service.state().activeTabByThread[T]).toBe(other);
      const before = revealed;

      const result = await service.screenshot({ threadId: T, tab: tabId });

      expect(result.ok).toBe(true);
      expect(service.state().activeTabByThread[T]).toBe(tabId);
      expect(revealed).toBe(before + 1);
    });

    it("does not disturb the panel when the tab is already on screen", async () => {
      const tabId = await openTab();
      service.setPanelVisible({ threadId: T, visible: true });
      const before = revealed;

      const result = await service.screenshot({ threadId: T, tab: tabId });

      expect(result.ok).toBe(true);
      expect(revealed).toBe(before);
    });

    it("leaves the panel alone when asked for a background capture", async () => {
      // The counterpart to the fronting above: sometimes the point is a check
      // the user does not need to watch, and taking over their panel to make it
      // is the intrusion. CDP renders from the page, so a hidden tab still has
      // an image in it — `capturePage` is skipped rather than waited out,
      // because the caller has already decided nothing is painting this tab.
      const capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from("painted") }));
      const cdp = makeCdp();
      build();
      guest.capturePage = capturePage;
      guest.debugger = cdp;
      const tabId = await openTab();
      const other = await openTab("https://elsewhere.example");
      const before = revealed;

      const result = await service.screenshot({ threadId: T, tab: tabId, background: true });

      expect(result.ok).toBe(true);
      expect(revealed).toBe(before);
      expect(service.state().activeTabByThread[T]).toBe(other);
      expect(capturePage).not.toHaveBeenCalled();
      const path = result.message.match(/to (\S+\.png)/)?.[1] ?? "";
      expect(readFileSync(path, "utf8")).toBe("rendered");
    });

    it("stages the exact live background guest, captures it, and always restores the surface", async () => {
      const release = vi.fn();
      const stageCapture = vi.fn(async () => release);
      const capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from("live-state") }));
      const setBackgroundThrottling = vi.fn();
      const invalidate = vi.fn();
      build({}, { stageCapture });
      guest.capturePage = capturePage;
      guest.setBackgroundThrottling = setBackgroundThrottling;
      guest.invalidate = invalidate;
      const tabId = await openTab();
      await openTab("https://elsewhere.example");

      const result = await service.screenshot({ threadId: T, tab: tabId, background: true });

      expect(result.ok).toBe(true);
      expect(stageCapture).toHaveBeenCalledWith(tabId);
      expect(capturePage).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenCalledOnce();
      expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
      expect(release).toHaveBeenCalledOnce();
      const path = result.message.match(/to (\S+\.png)/)?.[1] ?? "";
      expect(readFileSync(path, "utf8")).toBe("live-state");
    });

    it("renders off the compositing surface, and leaves the page's metrics as it found them", async () => {
      // The defect this came from: the CDP fallback asked for `fromSurface: true`,
      // which reads the same compositing surface `capturePage` does — so for a
      // tab nothing was painting (every tab in a section the user is not looking
      // at) BOTH stages failed, and the error blamed the machine's load for it.
      const cdp = makeCdp();
      build();
      guest.debugger = cdp;
      const tabId = await openTab();
      await openTab("https://elsewhere.example");

      const result = await service.screenshot({ threadId: T, tab: tabId, background: true });

      expect(result.ok).toBe(true);
      const calls = cdp.sendCommand.mock.calls.map(([method]) => method);
      expect(calls).toEqual([
        "Page.getLayoutMetrics",
        "Emulation.setDeviceMetricsOverride",
        "Page.captureScreenshot",
        "Emulation.clearDeviceMetricsOverride",
      ]);

      // The override has to be dimensionally identical to what the page already
      // had: it exists to force an offscreen surface, and a different size would
      // reflow a live page mid-interaction.
      expect(paramsOf(cdp, 1)).toMatchObject({ width: 900, height: 700, deviceScaleFactor: 0 });
      // Clipped to the visual viewport, so a scrolled page photographs what is
      // in view rather than the top of the document.
      expect(paramsOf(cdp, 2)).toMatchObject({
        fromSurface: false,
        captureBeyondViewport: true,
        clip: { x: 0, y: 120, width: 900, height: 700, scale: 1 },
      });
    });

    it("falls back to the surface read when the page cannot report its layout", async () => {
      // Mid-navigation there is no viewport to clip to. An empty PNG would be
      // worse than the old behaviour, so the plain capture stays as a last try.
      const cdp = makeCdp();
      cdp.sendCommand.mockImplementation(async (method: string) => {
        if (method === "Page.getLayoutMetrics") return {};
        if (method === "Page.captureScreenshot") return { data: Buffer.from("surface").toString("base64") };
        return {};
      });
      build();
      guest.debugger = cdp;
      const tabId = await openTab();
      await openTab("https://elsewhere.example");

      const result = await service.screenshot({ threadId: T, tab: tabId, background: true });

      expect(result.ok).toBe(true);
      expect(cdp.sendCommand.mock.calls.map(([method]) => method)).toEqual([
        "Page.getLayoutMetrics",
        "Page.captureScreenshot",
      ]);
      expect(paramsOf(cdp, 1)).toMatchObject({ fromSurface: true });
      const path = result.message.match(/to (\S+\.png)/)?.[1] ?? "";
      expect(readFileSync(path, "utf8")).toBe("surface");
    });

    it("photographs a background capture normally when the tab happens to be on screen", async () => {
      // `background` asks not to DISTURB the panel, not to avoid the compositor.
      // A tab already being painted is the cheap path and stays the cheap path.
      const sendCommand = vi.fn();
      build();
      guest.debugger = { isAttached: () => false, attach: () => undefined, detach: () => undefined, sendCommand };
      const tabId = await openTab();
      service.setPanelVisible({ threadId: T, visible: true });
      const before = revealed;

      const result = await service.screenshot({ threadId: T, tab: tabId, background: true });

      expect(result.ok).toBe(true);
      expect(revealed).toBe(before);
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it("gives up on the whole capture rather than hanging the turn", async () => {
      // `live` alone can spend 45s between attaching and loading, which no
      // per-stage ceiling ever bounded. The activity log holds screenshots that
      // ran for eleven minutes; an agent needs an answer more than the frame.
      build();
      const tabId = await openTab();
      // A page that never settles, then a capture that never answers: 30s of
      // load plus both capture ceilings, which is more than the op is worth.
      guest.isLoading = () => true;
      guest.capturePage = () => new Promise(() => undefined);
      guest.debugger = {
        isAttached: () => false,
        attach: () => undefined,
        detach: () => undefined,
        sendCommand: () => new Promise(() => undefined),
      };

      vi.useFakeTimers();
      const pending = service.screenshot({ threadId: T, tab: tabId });
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.message).toContain("did not finish within 30s");
      expect(records.at(-1)).toMatchObject({ action: "screenshot", ok: false });
    });

    it("prunes old captures instead of growing the directory forever", async () => {
      // Nothing ever deleted one: a day of agents taking screenshots left every
      // PNG on disk, at up to half a megabyte each.
      const tabId = await openTab();
      for (let index = 0; index < 100; index += 1) {
        const path = join(screenshotDir, `old-${String(index).padStart(3, "0")}.png`);
        writeFileSync(path, "x");
        // Distinct ages, oldest first, so "the oldest go" is a real assertion
        // rather than whatever order the directory happened to list in.
        const age = new Date(Date.now() - (30 * 24 * 60 + 100 - index) * 60_000);
        utimesSync(path, age, age);
      }

      const result = await service.screenshot({ threadId: T, tab: tabId });

      expect(result.ok).toBe(true);
      const left = readdirSync(screenshotDir);
      expect(left.length).toBe(80);
      // The one just taken is never a victim; the oldest are.
      expect(left).toContain(result.message.match(/to \S+\/(\S+\.png)/)?.[1]);
      expect(left).not.toContain("old-000.png");
    });

    it("renders through CDP when the view is not being painted", async () => {
      // The real failure this came from: `capturePage` reads the compositor, so
      // a tab that is not on screen — or a webview Chromium is not compositing —
      // returns an empty image. `Page.captureScreenshot` renders from the page.
      const cdp = makeCdp();
      const detach = vi.fn();
      build({ png: Buffer.alloc(0) });
      guest.debugger = { ...cdp, detach };
      const tabId = await openTab();

      const result = await service.screenshot({ threadId: T, tab: tabId });
      expect(result.ok).toBe(true);
      // Not `fromSurface: true`: that reads the compositing surface this path
      // exists precisely because there isn't one. `false` on its own captures
      // the host WINDOW — which is how a screenshot of a page once came back
      // showing the Panda Code chat — so it is the explicit clip that makes it
      // safe. See `renderOffSurface`.
      expect(cdp.sendCommand).toHaveBeenCalledWith(
        "Page.captureScreenshot",
        expect.objectContaining({ fromSurface: false, captureBeyondViewport: true }),
      );
      expect(detach).toHaveBeenCalledOnce();

      const path = result.message.match(/to (\S+\.png)/)?.[1] ?? "";
      expect(readFileSync(path, "utf8")).toBe("rendered");
    });

    it("falls through to CDP when capturePage never settles", async () => {
      // What a loaded machine actually does: `capturePage` on a view Chromium is
      // not compositing does not fail, it waits for a frame that never comes.
      const cdp = makeCdp();
      build();
      guest.capturePage = () => new Promise(() => undefined);
      guest.debugger = cdp;
      const tabId = await openTab();

      vi.useFakeTimers();
      const pending = service.screenshot({ threadId: T, tab: tabId });
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(cdp.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", expect.anything());
    });

    it("gives up with a readable failure when the render hangs too", async () => {
      // The bug this came from: neither stage had a ceiling, so a wedged capture
      // hung the agent's whole turn — and `run` writes its activity record after
      // the body returns, so the attempt left no trace in the log either.
      build({ png: Buffer.alloc(0) });
      guest.debugger = {
        isAttached: () => false,
        attach: () => undefined,
        detach: () => undefined,
        sendCommand: () => new Promise(() => undefined),
      };
      const tabId = await openTab();

      vi.useFakeTimers();
      const pending = service.screenshot({ threadId: T, tab: tabId });
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.message).toContain("did not render in time");
      expect(records.at(-1)).toMatchObject({ action: "screenshot", ok: false });
    });

    it("says so when it can neither paint nor render", async () => {
      build({ png: Buffer.alloc(0) });
      const tabId = await openTab();
      const result = await service.screenshot({ threadId: T, tab: tabId });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not being painted");
    });

    it("keeps recording frames through the fallback too", async () => {
      vi.useFakeTimers();
      const sendCommand = vi.fn().mockResolvedValue({ data: Buffer.from("frame").toString("base64") });
      build({ png: Buffer.alloc(0) });
      guest.debugger = { isAttached: () => false, attach: () => undefined, detach: () => undefined, sendCommand };
      const tabId = await openTab();

      await service.record({ threadId: T, tab: tabId, action: "start", fps: 4 });
      await vi.advanceTimersByTimeAsync(1_000);
      const stopped = await service.record({ threadId: T, tab: tabId, action: "stop" });

      expect(stopped.ok).toBe(true);
      expect(stopped.message).not.toContain("no frames captured");
    });

    it("grabs frames on a timer and encodes them on stop", async () => {
      vi.useFakeTimers();
      const encode = vi.fn().mockResolvedValue({ ok: true, message: "/tmp/out.mp4" });
      build({}, { encodeVideo: encode });
      const tabId = await openTab();

      const started = await service.record({ threadId: T, tab: tabId, action: "start", fps: 4 });
      expect(started.ok).toBe(true);
      expect(service.state().tabs[0]?.recording).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      const stopped = await service.record({ threadId: T, tab: tabId, action: "stop" });

      expect(stopped.ok).toBe(true);
      expect(encode).toHaveBeenCalledOnce();
      expect(service.state().tabs[0]?.recording).toBe(false);
      const framesDir = readdirSync(screenshotDir).find((entry) => entry.startsWith("recording-"));
      expect(readdirSync(join(screenshotDir, framesDir ?? "")).length).toBeGreaterThan(0);
    });

    it("falls back to the frames when there is no encoder", async () => {
      vi.useFakeTimers();
      build();
      const tabId = await openTab();
      await service.record({ threadId: T, tab: tabId, action: "start" });
      await vi.advanceTimersByTimeAsync(1_000);

      const stopped = await service.record({ threadId: T, tab: tabId, action: "stop" });
      expect(stopped.ok).toBe(true);
      expect(stopped.message).toContain("No video encoder is available");
      expect(stopped.message).toContain("recording-");
    });

    it("refuses a second recording while one is running", async () => {
      vi.useFakeTimers();
      const tabId = await openTab();
      await service.record({ threadId: T, tab: tabId, action: "start" });
      const second = await service.record({ threadId: T, tab: tabId, action: "start" });
      expect(second.ok).toBe(false);
      expect(second.message).toContain("Already recording");
    });
  });

  describe("file upload", () => {
    it("goes through CDP, and detaches afterwards", async () => {
      const sendCommand = vi
        .fn()
        .mockResolvedValueOnce({ root: { nodeId: 1 } })
        .mockResolvedValueOnce({ nodeId: 7 })
        .mockResolvedValueOnce({});
      const detach = vi.fn();
      build();
      guest.debugger = { isAttached: () => false, attach: () => undefined, detach, sendCommand };
      const tabId = await openTab();

      const result = await service.upload({ threadId: T, tab: tabId, selector: "input[type=file]", paths: ["/tmp/a.png"] });
      expect(result.ok).toBe(true);
      expect(sendCommand).toHaveBeenLastCalledWith("DOM.setFileInputFiles", { nodeId: 7, files: ["/tmp/a.png"] });
      expect(detach).toHaveBeenCalledOnce();
    });

    it("reports a missing input instead of silently doing nothing", async () => {
      const sendCommand = vi.fn().mockResolvedValueOnce({ root: { nodeId: 1 } }).mockResolvedValueOnce({ nodeId: 0 });
      build();
      guest.debugger = { isAttached: () => false, attach: () => undefined, detach: () => undefined, sendCommand };
      const tabId = await openTab();

      const result = await service.upload({ threadId: T, tab: tabId, selector: "#nope", paths: ["/tmp/a.png"] });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("No element matches #nope");
    });
  });

  describe("notes", () => {
    it("pins the note, reveals the panel, and draws it on the page", async () => {
      build({ handler: () => ({ ok: true, anchored: true }) });
      const tabId = await openTab("https://example.com", "sec-1");
      revealed = 0;

      const result = await service.note({ threadId: T, by: T, tab: tabId, text: "Check the VAT line", selector: ".total" });
      expect(result.ok).toBe(true);
      expect(revealed).toBe(1);
      expect(result.message).toContain("ringed and scrolled into view");

      const note = service.state().tabs[0]?.note;
      expect(note).toMatchObject({ text: "Check the VAT line", from: T, fromTitle: "Billing cleanup", selector: ".total" });
    });

    it("hands back the section to answer when the user clears it", async () => {
      build({ handler: () => ({ ok: true, anchored: false }) });
      const tabId = await openTab("https://example.com", "sec-1");
      await service.note({ threadId: T, by: T, tab: tabId, text: "Look at this" });

      const resolved = service.resolveNote(tabId);
      expect(resolved?.from).toBe(T);
      expect(service.state().tabs[0]?.note).toBeUndefined();
      // Clearing is itself an auditable act — it is the user's half of the loop.
      expect(records.at(-1)).toMatchObject({ action: "resolve_note", actor: "You", ok: true });
    });

    it("hides and restores the banner without resolving the note", async () => {
      build({ handler: () => ({ ok: true, anchored: false }) });
      const tabId = await openTab("https://example.com", "sec-1");
      await service.note({ threadId: T, by: T, tab: tabId, text: "Check this", selector: ".total" });

      expect(await service.setNoteHidden(tabId, true)).toBe(true);
      expect(service.state().tabs[0]?.note).toMatchObject({ text: "Check this", hidden: true });
      expect(guest.frames[0]?.scripts.at(-1)).toContain("?.remove()");
      expect(records.at(-1)).toMatchObject({ action: "hide_note", actor: "You" });

      expect(await service.setNoteHidden(tabId, false)).toBe(true);
      expect(service.state().tabs[0]?.note?.hidden).toBeUndefined();
      expect(guest.frames[0]?.scripts.at(-1)).toContain('data-panda-code", "note');
      expect(records.at(-1)).toMatchObject({ action: "show_note", actor: "You" });
    });

    it("returns nothing when there is no note, so no message is sent", async () => {
      const tabId = await openTab();
      expect(service.resolveNote(tabId)).toBeUndefined();
    });

    it("lets the agent take its own note back off when it can carry on after all", async () => {
      build({ handler: () => ({ ok: true, anchored: false }) });
      const tabId = await openTab("https://example.com", "sec-1");
      await service.note({ threadId: T, by: T, tab: tabId, text: "Log in for me" });

      const result = await service.note({ threadId: T, by: T, tab: tabId, text: "", clear: true });
      expect(result.ok).toBe(true);
      expect(service.state().tabs[0]?.note).toBeUndefined();
    });

    it("will not clear a note another section is still waiting on an answer to", async () => {
      build({ handler: () => ({ ok: true, anchored: false }) });
      const tabId = await openTab("https://example.com", "sec-1");
      await service.note({ threadId: T, by: OTHER, tab: tabId, text: "Approve this?" });

      const result = await service.note({ threadId: T, by: T, tab: tabId, text: "", clear: true });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Release cutting");
      expect(service.state().tabs[0]?.note).toBeDefined();
    });
  });

  describe("telemetry", () => {
    it("records every action with actor, arguments, outcome and duration", async () => {
      build({ handler: () => hit() });
      const tabId = await openTab("https://example.com", "sec-1");
      await service.click({ threadId: T, tab: tabId, text: "Save", by: "sec-1" });

      const click = records.find((record) => record.action === "click");
      expect(click).toMatchObject({
        actorId: "sec-1",
        actor: "Billing cleanup",
        action: "click",
        tabId,
        ok: true,
      });
      expect(click?.detail).toContain('text="Save"');
      expect(click?.outcome).toContain("Clicked button");
      expect(typeof click?.ms).toBe("number");
    });

    it("attributes an action with no section to the user", async () => {
      await openTab();
      expect(records[0]).toMatchObject({ action: "open", actor: "You", actorId: undefined });
    });

    it("records failures as failures, with the reason", async () => {
      build({ handler: () => NO_MATCH });
      const tabId = await openTab();
      await service.click({ threadId: T, tab: tabId, selector: ".save" });

      expect(records.at(-1)).toMatchObject({ action: "click", ok: false, outcome: "No element matches .save" });
    });

    it("redacts what was typed into a password field", async () => {
      build({ handler: () => ({ ok: true, tag: "input" }) });
      const tabId = await openTab();
      await service.type({ threadId: T, tab: tabId, selector: "#password", text: "hunter2" });

      const typed = records.at(-1);
      expect(typed?.detail).toContain("[redacted]");
      expect(JSON.stringify(records)).not.toContain("hunter2");
    });

    it("redacts on what the field turned out to be, not just on its name", async () => {
      // The selector says nothing — the page does. Without asking the field what
      // type it is, this password would have been written to the log verbatim.
      build({ handler: () => ({ ok: true, tag: "input", inputType: "password" }) });
      const tabId = await openTab();
      await service.type({ threadId: T, tab: tabId, selector: "#field-3", text: "correct-horse" });

      expect(records.at(-1)?.detail).toContain("[redacted]");
      expect(JSON.stringify(records)).not.toContain("correct-horse");
    });

    it("names the tab it actually drove, and the page it was on", async () => {
      build({ handler: () => hit() });
      const tabId = await openTab();
      service.report(tabId, { url: "https://example.com/invoice/7", title: "Invoice" });

      // Called with no tab at all: the record still has to say which one it hit.
      await service.click({ threadId: T, text: "Save", by: "sec-1" });
      expect(records.at(-1)).toMatchObject({ tabId, url: "https://example.com/invoice/7" });
    });

    it("records a thrown error as a failed action rather than rejecting", async () => {
      build({
        handler: () => {
          throw new Error("page exploded");
        },
      });
      const tabId = await openTab();

      const result = await service.read({ threadId: T, tab: tabId });
      expect(result.ok).toBe(false);
      expect(records.at(-1)).toMatchObject({ action: "read", ok: false });
    });

    it("reads the log back through `activity`", async () => {
      await openTab();
      const rendered = service.activity({ threadId: T, limit: 10 });
      expect(rendered.ok).toBe(true);
      expect(rendered.message).toContain("**open**");
    });
  });

  describe("section scoping", () => {
    it("shows a section only its own tabs", async () => {
      await openTabIn(T, "https://example.com/mine");
      await openTabIn(OTHER, "https://example.com/theirs");

      const listed = describeBrowser(service.state(), T);
      expect(listed).toContain("1 tab open in this section's browser");
      expect(listed).toContain("example.com/mine");
      expect(listed).not.toContain("example.com/theirs");
    });

    it("tells a section with no tabs that others exist without offering them", async () => {
      await openTabIn(OTHER);
      const listed = describeBrowser(service.state(), T);
      expect(listed).toContain("This section's browser has no tabs open");
      expect(listed).toContain("1 tab is open in other sections");
      expect(listed).toContain("not yours to drive");
    });

    it("refuses to drive another section's tab, even given its exact id", async () => {
      // The failure this prevents: an agent reads a neighbour's transcript,
      // finds a tab id in it, and navigates a page that section is working in.
      const theirs = await openTabIn(OTHER);

      const result = await service.navigate({ threadId: T, tab: theirs, url: "https://example.com/hijack" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("belongs to another section");
      expect(guest.loaded).not.toContain("https://example.com/hijack");
    });

    it("acts on the calling section's own tab when none is named", async () => {
      const mine = await openTabIn(T, "https://example.com/mine");
      await openTabIn(OTHER, "https://example.com/theirs");

      await service.navigate({ threadId: T, url: "https://example.com/next" });
      expect(service.state().tabs.find((tab) => tab.id === mine)?.threadId).toBe(T);
      expect(service.state().activeTabByThread[T]).toBe(mine);
    });

    it("counts the tab cap per section, not across the workspace", async () => {
      for (let index = 0; index < 12; index += 1) {
        await openTabIn(OTHER, `https://example.com/${index}`);
      }
      // Through the same attach handshake the renderer performs, or `open` sits
      // waiting for a webview that never mounts.
      const mine = await openTabIn(T, "https://example.com/mine");
      expect(mine).not.toBe("");
      expect(service.state().tabs.filter((tab) => tab.threadId === T)).toHaveLength(1);
    });

    it("keeps each section's active tab separate", async () => {
      const mineA = await openTabIn(T, "https://example.com/a");
      const mineB = await openTabIn(T, "https://example.com/b");
      const theirs = await openTabIn(OTHER);

      service.select({ threadId: T, tabId: mineA });
      expect(service.state().activeTabByThread[T]).toBe(mineA);
      expect(service.state().activeTabByThread[OTHER]).toBe(theirs);

      // Selecting across sections is ignored rather than honoured.
      service.select({ threadId: T, tabId: theirs });
      expect(service.state().activeTabByThread[T]).toBe(mineA);
      expect(mineB).not.toBe(mineA);
    });

    it("gives each section its own slice of the activity log", async () => {
      await openTabIn(T, "https://example.com/mine");
      await openTabIn(OTHER, "https://example.com/theirs");

      const ours = service.activity({ threadId: T });
      expect(ours.message).toContain("example.com/mine");
      expect(ours.message).not.toContain("example.com/theirs");
    });

    it("closes a section's tabs when the section goes away", async () => {
      await openTabIn(T);
      await openTabIn(OTHER);

      service.closeThread(T);
      expect(service.state().tabs.map((tab) => tab.threadId)).toEqual([OTHER]);
      expect(service.state().activeTabByThread[T]).toBeUndefined();
    });
  });

  describe("sleeping", () => {
    it("releases an idle tab and keeps it in the strip", async () => {
      const tabId = await openTabIn(T);
      clock += 10 * 60_000;
      service.sweep({ idleTimeoutMs: 5 * 60_000, maxAwake: 0 });

      const tab = service.state().tabs[0];
      expect(tab?.id).toBe(tabId);
      expect(tab?.asleep).toBe(true);
      expect(service.stats()).toMatchObject({ tabs: 1, awake: 0, asleep: 1 });
    });

    it("records the sleep in the activity log, so it is not a silent disappearance", async () => {
      await openTabIn(T);
      clock += 10 * 60_000;
      service.sweep({ idleTimeoutMs: 5 * 60_000, maxAwake: 0 });

      expect(records.at(-1)).toMatchObject({ action: "sleep", actor: "Panda Code", ok: true, detail: "idle" });
    });

    it("never sleeps the tab the user is looking at", async () => {
      await openTabIn(T);
      clock += 10 * 60_000;
      service.sweep({ visibleThreadId: T, idleTimeoutMs: 5 * 60_000, maxAwake: 0 });
      expect(service.state().tabs[0]?.asleep).toBeFalsy();
    });

    it("wakes on use, and the op goes through once the page comes back", async () => {
      build({ handler: () => hit() });
      const tabId = await openTabIn(T);
      clock += 10 * 60_000;
      service.sweep({ idleTimeoutMs: 5 * 60_000, maxAwake: 0 });
      expect(service.state().tabs[0]?.asleep).toBe(true);

      // Driving a sleeping tab: the renderer remounts it and reports the guest
      // back, exactly as it does for a freshly opened one.
      const clicking = service.click({ threadId: T, tab: tabId, text: "Save" });
      service.attach(tabId, 99);
      const result = await clicking;

      expect(result.ok).toBe(true);
      expect(service.state().tabs[0]?.asleep).toBe(false);
    });

    it("wakes when the user clicks the tab", async () => {
      const tabId = await openTabIn(T);
      clock += 10 * 60_000;
      service.sweep({ idleTimeoutMs: 5 * 60_000, maxAwake: 0 });

      service.select({ threadId: T, tabId });
      expect(service.state().tabs[0]?.asleep).toBe(false);
    });

    it("holds the awake ceiling across sections, not per section", async () => {
      // The bound that actually caps memory: two sections with two tabs each is
      // four renderer processes, however the per-section cap is set.
      await openTabIn(T, "https://example.com/1");
      await openTabIn(T, "https://example.com/2");
      await openTabIn(OTHER, "https://example.com/3");
      await openTabIn(OTHER, "https://example.com/4");

      service.sweep({ idleTimeoutMs: 0, maxAwake: 2 });
      expect(service.stats()).toMatchObject({ tabs: 4, awake: 2, asleep: 2 });
    });

    it("does not sleep a tab holding a note the user has not cleared", async () => {
      build({ handler: () => ({ ok: true, anchored: false }) });
      const tabId = await openTabIn(T);
      await service.note({ threadId: T, by: T, tab: tabId, text: "Check this" });

      clock += 10 * 60_000;
      service.sweep({ idleTimeoutMs: 5 * 60_000, maxAwake: 0 });
      expect(service.state().tabs[0]?.asleep).toBeFalsy();
    });
  });

  describe("the detached window", () => {
    it("hands the pages over by dropping every guest", async () => {
      // Each tab's page belongs to whichever window mounted it, so moving means
      // the old host destroys it and the new one loads it again.
      build({ handler: () => ({ ok: true, title: "Example", url: "https://example.com/", text: "Hi", links: [] }) });
      const tabId = await openTabIn(T);
      expect(service.state().floating).toBeFalsy();

      service.setFloating(true);
      expect(service.state().floating).toBe(true);

      // With the guest dropped, an op waits for the new host to attach rather
      // than driving a page that no longer exists.
      const reading = service.read({ threadId: T, tab: tabId });
      service.attach(tabId, 77);
      await expect(reading).resolves.toMatchObject({ ok: true });
    });

    it("is idempotent, so a second open changes nothing", async () => {
      await openTabIn(T);
      service.setFloating(true);
      const before = service.state();
      service.setFloating(true);
      expect(service.state()).toEqual(before);
    });

    it("carries each tab's section title for the grouped view", async () => {
      await openTabIn(T);
      await openTabIn(OTHER);
      expect(service.state().tabs.map((tab) => tab.threadTitle)).toEqual(["Billing cleanup", "Release cutting"]);
    });

    it("keeps the title fresh when a section is renamed", async () => {
      await openTabIn(T);
      let renamed = false;
      build({}, { sectionTitle: (id: string) => (id === T ? (renamed ? "Renamed" : "Billing cleanup") : undefined) });
      await openTabIn(T);
      renamed = true;
      // Resolved at publish, not stored at open.
      expect(service.state().tabs[0]?.threadTitle).toBe("Renamed");
    });
  });

  describe("visibility", () => {
    it("does not claim a tab is on screen just because it is the front tab", async () => {
      // The bug this came from: `browser_list` told an agent a page was "shown
      // to the user" while the panel was closed and the chat was in front, so
      // the agent screenshotted and reasoned about the wrong thing.
      await openTabIn(T);
      expect(service.state().tabs[0]?.onScreen).toBeFalsy();
      expect(describeBrowser(service.state(), T)).toContain("not on screen");
    });

    it("says a tab is on screen once the renderer reports its panel showing", async () => {
      await openTabIn(T);
      service.setPanelVisible({ threadId: T, visible: true });

      expect(service.state().tabs[0]?.onScreen).toBe(true);
      expect(describeBrowser(service.state(), T)).toContain("on screen now");
    });

    it("only the front tab of a visible section counts", async () => {
      const first = await openTabIn(T, "https://example.com/1");
      const second = await openTabIn(T, "https://example.com/2");
      service.setPanelVisible({ threadId: T, visible: true });

      const onScreen = service.state().tabs.filter((tab) => tab.onScreen).map((tab) => tab.id);
      expect(onScreen).toEqual([second]);
      expect(first).not.toBe(second);
    });

    it("treats every tab as on screen while the detached window has them", async () => {
      await openTabIn(T);
      service.setFloating(true);
      expect(service.state().tabs[0]?.onScreen).toBe(true);
    });
  });

  describe("tab lookup", () => {
    it("finds a tab by title as well as by id", async () => {
      const tabId = await openTab();
      service.report(tabId, { title: "Pricing" });

      const result = await service.close({ threadId: T, tab: "pricing" });
      expect(result.ok).toBe(true);
      expect(service.state().tabs).toHaveLength(0);
    });

    it("says so when there is no such tab", async () => {
      const result = await service.click({ threadId: T, tab: "tab-nope", selector: ".x" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("No open tab called `tab-nope`");
    });

    it("stops a recording when its tab is closed", async () => {
      vi.useFakeTimers();
      const tabId = await openTab();
      await service.record({ threadId: T, tab: tabId, action: "start" });
      await service.close({ threadId: T, tab: tabId });

      // Nothing left running: a second stop has nothing to stop.
      const stopped = await service.record({ threadId: T, action: "stop" });
      expect(stopped.message).toContain("Nothing is being recorded");
    });
  });
});
