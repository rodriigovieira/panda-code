import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Circle,
  EyeOff,
  Globe,
  History,
  Maximize2,
  MessageSquare,
  Minimize2,
  Moon,
  PictureInPicture2,
  Plus,
  RotateCw,
  Send,
  X,
} from "lucide-react";
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeTabForThread,
  BROWSER_PARTITION,
  emptyBrowserState,
  browserUserAgent,
  groupTabsByThread,
  tabLabel,
  tabsForThread,
  type BrowserActivity,
  type BrowserState,
  type BrowserTab,
} from "../../shared/browser";
import type { DesktopApi } from "../../shared/ipc";
import { recordRendererPerf } from "./perf-client";
import { useBrowserFramePerf, useBrowserRenderPerf } from "./browser-perf";

/**
 * The browser panel: the human half of a browser an agent is also driving.
 *
 * It holds no tab state of its own. Main owns the list, this renders it, and
 * every action here — typing a URL, closing a tab, going back — is the same call
 * an agent's tool makes. The one thing the renderer knows and main cannot is
 * what the guest page is doing, so the per-tab component reports navigation back
 * up (`browserReport`) and hands main the guest's WebContents id on attach.
 *
 * Tabs belong to sections, and this shows one section's. Every tab in the
 * workspace stays MOUNTED, though — the ones belonging to other sections merely
 * sit hidden — because unmounting a webview destroys the page, and switching
 * sections must not kill the work an agent is doing in another one.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PRESENTATIONS, AND WHO HOSTS THE PAGES
 * ---------------------------------------------------------------------------
 *
 * One component, three shapes (`BrowserPresentation`):
 *
 *   - `docked` — a resizable column beside the conversation, in the same grid
 *     slot /btw uses. Per section, toggled with ⌘⇧J. The default.
 *   - `full` — the same panel spanning the whole workspace, with the
 *     conversation and the section topbar hidden. Also per section. Losing the
 *     topbar means this tab bar is both the way back (exit full width, hide) and
 *     the window's drag region; see the `browser-full` rules in `styles.css`.
 *   - `window` — the detached window (`BrowserWindowApp`). The only view that
 *     shows more than one section, so it is also where you see which thread a
 *     page belongs to and click through to it.
 *
 * The layout itself lives in `styles.css`, not here — see the workspace grid
 * rules next to /btw's, and `workspace-grid.test.ts`, which guards them. Those
 * rules are order-sensitive in a way that has already caused one silent
 * regression, so change them there rather than adding overrides.
 *
 * **Exactly one surface may host the pages at a time.** A `<webview>` guest
 * belongs to the window that created it, so if the dock and the detached window
 * both rendered a webview for the same tab there would be two live pages
 * claiming one tab id. Main's `floating` flag is the arbiter (`hosting` below);
 * whichever surface loses shows a placeholder instead.
 *
 * The cost of that rule, worth knowing before reaching for the window button:
 * moving between docked and detached **reloads every page**, because the old
 * host destroys its guests and the new one creates them fresh. It is the same
 * mechanic as waking a slept tab, deliberately reusing that machinery rather
 * than pretending pages can migrate. Unsaved form state does not survive it.
 */

/**
 * React does know a `webview` element, but only with the handful of attributes
 * the DOM spec gives it — not Electron's `partition` or `useragent`, which are
 * the two that matter here. `createElement` takes the props as written rather
 * than checking them against that table.
 */
type WebviewProps = {
  ref: React.Ref<HTMLElement>;
  className: string;
  src: string;
  partition: string;
  useragent: string;
  allowpopups: string;
};

/** The subset of the guest element this component uses, without pulling in Electron's types. */
type WebviewElement = HTMLElement & {
  src: string;
  getWebContentsId: () => number;
  getURL: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
};

function BrowserTabView({
  tab,
  visible,
  desktopApi,
}: {
  tab: BrowserTab;
  visible: boolean;
  desktopApi: DesktopApi;
}): React.ReactElement {
  const ref = useRef<WebviewElement | null>(null);
  // The tab's URL changes as it navigates, but `src` must not follow it: main
  // drives navigation through the guest's own WebContents, and re-setting `src`
  // would make every reported navigation trigger another one.
  const initialUrl = useRef(tab.url);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const report = (patch: Parameters<DesktopApi["browserReport"]>[0]): void => {
      const started = performance.now();
      void desktopApi.browserReport(patch).then(
        () => recordRendererPerf("renderer:browser:report-roundtrip", performance.now() - started),
        () => recordRendererPerf("renderer:browser:report-failed", performance.now() - started),
      );
    };

    recordRendererPerf("renderer:browser:guest-mount", 0);

    // `dom-ready` is the first moment `getWebContentsId()` is answerable, and it
    // is what main is waiting on before it will drive this tab at all.
    const onDomReady = (): void => {
      void desktopApi.browserAttach({ tabId: tab.id, webContentsId: element.getWebContentsId() });
      report({ tabId: tab.id, url: element.getURL(), canGoBack: element.canGoBack(), canGoForward: element.canGoForward() });
    };
    const onTitle = (event: Event): void => {
      report({ tabId: tab.id, title: (event as Event & { title: string }).title });
    };
    const onNavigate = (): void => {
      report({
        tabId: tab.id,
        url: element.getURL(),
        canGoBack: element.canGoBack(),
        canGoForward: element.canGoForward(),
      });
    };
    const onStart = (): void => report({ tabId: tab.id, loading: true });
    const onStop = (): void => report({ tabId: tab.id, loading: false, url: element.getURL() });

    element.addEventListener("dom-ready", onDomReady);
    element.addEventListener("page-title-updated", onTitle);
    element.addEventListener("did-navigate", onNavigate);
    element.addEventListener("did-navigate-in-page", onNavigate);
    element.addEventListener("did-start-loading", onStart);
    element.addEventListener("did-stop-loading", onStop);

    return () => {
      recordRendererPerf("renderer:browser:guest-unmount", 0);
      element.removeEventListener("dom-ready", onDomReady);
      element.removeEventListener("page-title-updated", onTitle);
      element.removeEventListener("did-navigate", onNavigate);
      element.removeEventListener("did-navigate-in-page", onNavigate);
      element.removeEventListener("did-start-loading", onStart);
      element.removeEventListener("did-stop-loading", onStop);
    };
  }, [desktopApi, tab.id]);

  return createElement<WebviewProps>("webview" as unknown as React.FunctionComponent<WebviewProps>, {
    ref: ref as unknown as React.Ref<HTMLElement>,
    className: `browser-view ${visible ? "" : "hidden"}`,
    src: initialUrl.current,
    partition: BROWSER_PARTITION,
    useragent: browserUserAgent(navigator.userAgent),
    // Sign-in-with-X flows are `window.open` popups that talk back to the page
    // that opened them. Without this the guest's `window.open` returns null and
    // the flow dead-ends. Main decides what an opened window actually becomes
    // (see `wireGuestPopups`); this attribute only stops Chromium from refusing
    // outright.
    //
    // It must be the STRING "true", not the boolean. `webview` is not a custom
    // element to React (no dash in the name) and `allowpopups` is not an
    // attribute it knows, so a boolean lands in `setValueForAttribute`, which
    // calls `removeAttribute` for any non-`data-`/`aria-` boolean and silently
    // drops it. The attribute never reached the DOM, Chromium blocked every
    // `window.open`, and no popup ever got as far as `wireGuestPopups`.
    allowpopups: "true",
  });
}

/**
 * How the panel is being shown.
 *
 * `docked` is the column beside the conversation, `full` takes the whole
 * workspace, and `window` is the detached window — which is also the only view
 * that shows more than one section's tabs.
 */
export type BrowserPresentation = "docked" | "full" | "window";

export function BrowserPanel({
  desktopApi,
  threadId,
  presentation = "docked",
  onHide,
  onPresentationChange,
}: {
  desktopApi: DesktopApi;
  /** The section whose browser this is. Ignored by the detached window. */
  threadId?: string;
  presentation?: BrowserPresentation;
  onHide?: () => void;
  onPresentationChange?: (presentation: BrowserPresentation) => void;
}): React.ReactElement {
  const [state, setState] = useState<BrowserState>(emptyBrowserState);
  const [address, setAddress] = useState("");
  const [reply, setReply] = useState("");
  const [activity, setActivity] = useState<BrowserActivity[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [captureStage, setCaptureStage] = useState<{ requestId: string; tabId: string } | null>(null);
  const addressFocused = useRef(false);
  useBrowserRenderPerf(presentation, state.tabs.length);
  useBrowserFramePerf(presentation);

  useEffect(() => {
    void desktopApi.browserState().then(setState);
    return desktopApi.onBrowserState((next) => {
      recordRendererPerf(`renderer:browser:${presentation}:state-received`, 0, next.tabs.length);
      setState(next);
    });
  }, [desktopApi, presentation]);

  // The activity log is the audit trail, live: the user can watch a section
  // work the browser action by action, and go back over it afterwards.
  useEffect(() => {
    void desktopApi.browserActivity(400).then(setActivity);
    return desktopApi.onBrowserActivity((record) => {
      setActivity((current) => [...current, record].slice(-400));
    });
  }, [desktopApi]);

  const allSections = presentation === "window";

  /**
   * Which surface mounts the pages.
   *
   * Exactly one may: a guest belongs to the window that created it, so if both
   * the dock and the detached window rendered a webview for the same tab there
   * would be two pages claiming one tab id. Main's `floating` flag is the
   * arbiter, and the loser shows a placeholder.
   */
  const hosting = allSections ? Boolean(state.floating) : !state.floating;

  // A background section's webview is alive and scriptable, but Chromium does
  // not raster it. Main asks the ONE renderer that currently hosts the guests
  // to put the requested tab on a temporary, nearly transparent in-viewport
  // stage. Two animation frames are the acknowledgement: React has committed
  // the class and Chromium has had a real paint opportunity before capturePage
  // runs. Releasing restores the previous tab and panel without changing any
  // user-visible browser state.
  useEffect(() => {
    const stopStage = desktopApi.onBrowserCaptureStage((event) => {
      if (!hosting || !state.tabs.some((tab) => tab.id === event.tabId && !tab.asleep)) return;
      setCaptureStage(event);
    });
    const stopRelease = desktopApi.onBrowserCaptureRelease(({ requestId }) => {
      setCaptureStage((current) => (current?.requestId === requestId ? null : current));
    });
    return () => {
      stopStage();
      stopRelease();
    };
  }, [desktopApi, hosting, state.tabs]);

  useEffect(() => {
    if (!captureStage) return;
    const stageStarted = performance.now();
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        recordRendererPerf("renderer:browser:capture-stage-paint", performance.now() - stageStarted);
        void desktopApi.browserCaptureStageReady({ requestId: captureStage.requestId });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [captureStage, desktopApi]);

  const ourActivity = useMemo(
    () => (allSections ? activity : activity.filter((record) => record.threadId === threadId)),
    [activity, allSections, threadId],
  );

  const groups = useMemo(() => (allSections ? groupTabsByThread(state) : []), [allSections, state]);
  const tabs = useMemo(
    () => (allSections ? state.tabs : threadId ? tabsForThread(state, threadId) : []),
    [allSections, state, threadId],
  );
  /** In the all-sections view the strip is one flat list, with its own selection. */
  const [windowTabId, setWindowTabId] = useState<string | undefined>();
  const sectionActive = useMemo(
    () => (threadId ? activeTabForThread(state, threadId) : undefined),
    [state, threadId],
  );
  const activeTab = allSections ? (tabs.find((tab) => tab.id === windowTabId) ?? tabs[0]) : sectionActive;

  // Follow the tab's URL except while the user is editing the field — otherwise
  // an agent navigating mid-keystroke would overwrite what they are typing.
  useEffect(() => {
    if (!addressFocused.current) {
      setAddress(activeTab?.url ?? "");
    }
  }, [activeTab?.id, activeTab?.url]);

  /**
   * Selecting a tab.
   *
   * In the docked panel this is main's per-section choice. In the window it is
   * also local state, because the window shows several sections at once and
   * "which tab am I looking at" is a question about the window, not about any
   * one section.
   */
  const selectTab = useCallback(
    (tab: BrowserTab): void => {
      setWindowTabId(tab.id);
      void desktopApi.browserSelectTab({ threadId: tab.threadId, tabId: tab.id });
    },
    [desktopApi],
  );

  /** Where a newly opened tab goes: this section, or the one in view. */
  const openTarget = threadId ?? activeTab?.threadId ?? groups[0]?.threadId;

  const submitAddress = useCallback(
    (event: React.FormEvent): void => {
      event.preventDefault();
      const url = address.trim();
      if (!url) {
        return;
      }
      if (activeTab) {
        void desktopApi.browserNavigate({ threadId: activeTab.threadId, tabId: activeTab.id, url });
      } else if (openTarget) {
        void desktopApi.browserOpen({ threadId: openTarget, url });
      }
    },
    [activeTab, address, desktopApi, openTarget],
  );

  const resolveNote = useCallback((): void => {
    if (!activeTab) {
      return;
    }
    void desktopApi.browserResolveNote({ tabId: activeTab.id, reply: reply.trim() || undefined });
    setReply("");
  }, [activeTab, desktopApi, reply]);

  const renderTab = (tab: BrowserTab): React.ReactElement => (
          <div
            key={tab.id}
            className={`browser-tab ${tab.id === activeTab?.id ? "active" : ""} ${tab.note ? "has-note" : ""} ${
              tab.asleep ? "asleep" : ""
            }`}
            role="tab"
            aria-selected={tab.id === activeTab?.id}
            tabIndex={0}
            title={[tabLabel(tab), tab.openedBy ? `opened by ${tab.openedBy}` : "", tab.asleep ? "asleep — click to reload" : ""]
              .filter(Boolean)
              .join(" · ")}
            onClick={() => void selectTab(tab)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                void selectTab(tab);
              }
            }}
          >
            <Globe size={12} aria-hidden="true" />
            <span>{tabLabel(tab)}</span>
            {tab.recording ? <Circle size={8} className="browser-tab-recording" aria-label="Recording this tab" /> : null}
            {tab.note ? <span className="browser-tab-note-dot" aria-label="An agent left a note here" /> : null}
            <button
              className="browser-tab-close"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void desktopApi.browserCloseTab({ threadId: tab.threadId, tabId: tab.id });
              }}
              aria-label={`Close ${tabLabel(tab)}`}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </div>
  );

  const surfaceTabId = captureStage?.tabId ?? activeTab?.id;

  return (
    <div className={`browser-panel ${captureStage ? "capture-staging" : ""}`}>
      <div className="browser-tabbar" role="tablist" aria-label="Browser tabs">
        {allSections
          ? groups.map((group) => (
              <div className="browser-group" key={group.threadId}>
                {/* The section a page belongs to, and the way back to it: this
                    window is often where you first notice a section did
                    something, and the transcript is where you deal with it. */}
                <button
                  className="browser-group-label"
                  type="button"
                  onClick={() => void desktopApi.browserFocusThread(group.threadId)}
                  title={`Go to “${group.title}”`}
                >
                  <MessageSquare size={11} aria-hidden="true" />
                  <span>{group.title}</span>
                </button>
                <div className="browser-group-tabs">{group.tabs.map((tab) => renderTab(tab))}</div>
              </div>
            ))
          : tabs.map((tab) => renderTab(tab))}
        <button
          className="browser-tabbar-button"
          type="button"
          onClick={() => openTarget && void desktopApi.browserOpen({ threadId: openTarget, url: "about:blank" })}
          disabled={!openTarget}
          aria-label="New tab"
          title="New tab"
        >
          <Plus size={14} aria-hidden="true" />
        </button>
        <span className="browser-tabbar-spacer" />
        <button
          className={`browser-tabbar-button ${activityOpen ? "active" : ""}`}
          type="button"
          onClick={() => setActivityOpen((open) => !open)}
          aria-label="Activity log"
          aria-pressed={activityOpen}
          title="What has been done in this browser, and by whom"
        >
          <History size={14} aria-hidden="true" />
        </button>
        {presentation !== "window" && onPresentationChange ? (
          <button
            className="browser-tabbar-button"
            type="button"
            onClick={() => onPresentationChange(presentation === "full" ? "docked" : "full")}
            aria-label={presentation === "full" ? "Exit full width" : "Full width"}
            title={presentation === "full" ? "Back to the side panel" : "Fill the window"}
          >
            {presentation === "full" ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
          </button>
        ) : null}
        {presentation !== "window" ? (
          <button
            className="browser-tabbar-button"
            type="button"
            onClick={() => void desktopApi.browserSetFloating(true)}
            aria-label="Open in its own window"
            title="Open in its own window — shows every section's tabs"
          >
            <PictureInPicture2 size={13} aria-hidden="true" />
          </button>
        ) : (
          <button
            className="browser-tabbar-button"
            type="button"
            onClick={() => void desktopApi.browserSetFloating(false)}
            aria-label="Put the browser back in the main window"
            title="Put it back in the main window"
          >
            <Minimize2 size={13} aria-hidden="true" />
          </button>
        )}
        {onHide ? (
          <button className="browser-tabbar-button" type="button" onClick={onHide} aria-label="Hide browser" title="Hide browser (⌘⇧J)">
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="browser-toolbar">
        <button
          className="browser-tabbar-button"
          type="button"
          disabled={!activeTab?.canGoBack}
          onClick={() => activeTab && void desktopApi.browserBack({ threadId: activeTab.threadId, tabId: activeTab.id })}
          aria-label="Back"
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <button
          className="browser-tabbar-button"
          type="button"
          disabled={!activeTab?.canGoForward}
          onClick={() => activeTab && void desktopApi.browserForward({ threadId: activeTab.threadId, tabId: activeTab.id })}
          aria-label="Forward"
        >
          <ArrowRight size={14} aria-hidden="true" />
        </button>
        <button
          className="browser-tabbar-button"
          type="button"
          disabled={!activeTab}
          onClick={() => activeTab && void desktopApi.browserReload({ threadId: activeTab.threadId, tabId: activeTab.id })}
          aria-label="Reload"
        >
          <RotateCw size={13} aria-hidden="true" className={activeTab?.loading ? "spin" : ""} />
        </button>
        {activeTab?.note?.hidden ? (
          <button
            className="browser-tabbar-button browser-note-restore"
            type="button"
            onClick={() => void desktopApi.browserSetNoteHidden({ tabId: activeTab.id, hidden: false })}
            aria-label="Show hidden agent note"
            title="Show the hidden agent note"
          >
            <MessageSquare size={13} aria-hidden="true" />
          </button>
        ) : null}
        <form className="browser-address" onSubmit={submitAddress}>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              addressFocused.current = true;
              event.target.select();
            }}
            onBlur={() => {
              addressFocused.current = false;
              setAddress(activeTab?.url ?? "");
            }}
            placeholder="Search or enter an address"
            spellCheck={false}
            aria-label="Address"
          />
        </form>
      </div>

      {activeTab?.note && !activeTab.note.hidden ? (
        <div className="browser-note">
          <div className="browser-note-body">
            <div className="browser-note-heading">
              <strong>{activeTab.note.fromTitle ?? "An agent"} left this for you</strong>
              <button
                className="browser-note-hide"
                type="button"
                onClick={() => void desktopApi.browserSetNoteHidden({ tabId: activeTab.id, hidden: true })}
                aria-label="Hide note without resolving it"
                title="Hide for now — the section will still be waiting"
              >
                <EyeOff size={13} aria-hidden="true" />
                Hide
              </button>
            </div>
            <p>{activeTab.note.text}</p>
          </div>
          <div className="browser-note-actions">
            <input
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  resolveNote();
                }
              }}
              placeholder="Reply to the section (optional)"
              aria-label="Reply to the section that left this note"
            />
            <button className="primary-action" type="button" onClick={resolveNote}>
              <Send size={13} aria-hidden="true" />
              {reply.trim() ? "Send & clear" : "Done"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="browser-views">
        {/* Sleeping tabs render nothing: unmounting the webview is what actually
            returns the ~200 MB its process was holding. The tab record stays, so
            the strip still shows it and touching it brings the page back. */}
        {hosting
          ? state.tabs
              .filter((tab) => !tab.asleep)
              .map((tab) => (
                <BrowserTabView key={tab.id} tab={tab} visible={tab.id === surfaceTabId} desktopApi={desktopApi} />
              ))
          : null}
        {!hosting ? (
          <div className="browser-empty">
            <PictureInPicture2 size={20} aria-hidden="true" />
            <strong>The pages are in the browser window</strong>
            <span>Close that window, or use the button above, to bring them back in here.</span>
          </div>
        ) : null}
        {hosting && activeTab?.asleep ? (
          <div className="browser-empty">
            <Moon size={20} aria-hidden="true" />
            <strong>This tab is asleep</strong>
            <span>Its page was released to save memory. Click the tab, or use it from a section, and it reloads.</span>
          </div>
        ) : null}
        {hosting && tabs.length === 0 ? (
          <div className="browser-empty">
            <Globe size={20} aria-hidden="true" />
            <strong>No pages open</strong>
            <span>
              {allSections
                ? "Nothing is open in any section yet."
                : "Open one above, or ask this section to. These tabs belong to this section; you and it share them, logins and all."}
            </span>
          </div>
        ) : null}
      </div>

      {activityOpen ? (
        <div className="browser-activity" aria-label="Browser activity log">
          {ourActivity.length === 0 ? (
            <p className="browser-activity-empty">Nothing has happened in this section's browser yet.</p>
          ) : (
            [...ourActivity].reverse().map((record, index) => (
              <div className={`browser-activity-row ${record.ok ? "" : "failed"}`} key={`${record.at}-${index}`}>
                <div className="browser-activity-head">
                  <strong>{record.action}</strong>
                  <span>{record.actor}</span>
                  <time>{record.at.slice(11, 19)}</time>
                </div>
                {record.detail ? <code>{record.detail}</code> : null}
                <small>
                  {record.ok ? "" : "failed — "}
                  {record.outcome}
                  {` · ${record.ms}ms`}
                </small>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
