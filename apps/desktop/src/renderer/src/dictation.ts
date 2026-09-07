import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DictationTarget, DictationTranscript, dictationErrorMessage } from "../../shared/dictation";
import type { DesktopApi } from "../../shared/ipc";

/**
 * How the current utterance was started.
 *
 * The distinction matters on release: letting go of the push-to-talk key must
 * end a burst it started, and must *not* end a hands-free session that happened
 * to be running when the key was touched.
 */
type DictationMode = "idle" | "hands-free" | "push";

export type DictationController = {
  /** False on a build with no speech helper — the microphone is hidden entirely. */
  available: boolean;
  listening: boolean;
  /** Set while a push-to-talk key is held, so the button can show it is momentary. */
  pushing: boolean;
  error: string | null;
  dismissError: () => void;
  /**
   * Point dictation at an input. Called by each composer as it gains focus.
   *
   * Deliberately not called on blur: clicking the microphone button itself
   * blurs the field, and forgetting the target at that moment would leave
   * nothing to dictate into.
   */
  focusTarget: (target: DictationTarget) => void;
  /** Forget an input that is going away — closing the side chat, or switching sections. */
  releaseTarget: (id: string) => void;
  /**
   * Nominate the input dictation falls back to when nothing else holds focus.
   *
   * Without this, closing the quick-start overlay left no target at all, and
   * ⌥Space did nothing until the user happened to click into a composer.
   */
  registerFallback: (target: DictationTarget) => void;
  /** True when this input is the one being dictated into right now. */
  isRecordingInto: (id: string) => boolean;
  /** Hands-free: start, and keep listening until asked to stop. */
  toggle: () => void;
  /** Push-to-talk: record while the key is held. */
  press: () => void;
  release: () => void;
  /** Abandon the recording and put the input back as it was. */
  discard: () => void;
  /**
   * Put back what the last discard wiped.
   *
   * Dictation writes through the field's own handle, which replaces its value
   * outright — the native undo stack does not survive it, so ⌘Z cannot bring a
   * discarded utterance back. A minute of speech is too much to lose to one
   * keystroke, so the wiped text is kept here until the next recording starts.
   */
  undoDiscard: () => void;
  /** True when this input has a discard that can still be undone. */
  canUndoDiscard: (id: string) => boolean;
  dismissDiscard: () => void;
  /**
   * Stop and let the last words land, before the input is cleared.
   *
   * Sending while the mic is live clears the composer under a still-running
   * task, and the next partial — which carries the whole utterance, not just
   * the new words — writes all of it straight back in.
   */
  settle: () => Promise<void>;
};

/**
 * Drives the native speech helper and keeps the focused input in step with it.
 *
 * One instance for the window, because there is one microphone. Which of the
 * composers on screen receives the words is decided by focus: each registers
 * itself through `focusTarget`, and the one that was active when recording
 * started keeps the transcript even if focus moves away mid-sentence.
 *
 * The transcript assembly — banking finalised words so a task restart cannot
 * erase them, and rebasing when the user edits mid-sentence — lives in
 * `DictationTranscript`, which is pure and tested. This hook is the wiring.
 */
export function useDictation(desktopApi: DesktopApi): DictationController {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mirrors `sessionTarget` for rendering; refs alone would not repaint the
  // input that is currently receiving speech.
  const [recordingInto, setRecordingInto] = useState<string | null>(null);
  /** The text the last discard wiped, until it is restored or superseded. */
  const [discarded, setDiscarded] = useState<{ targetId: string; text: string } | null>(null);
  const discardedTarget = useRef<DictationTarget | null>(null);

  const transcript = useRef(new DictationTranscript());
  const mode = useRef<DictationMode>("idle");

  /**
   * Renderer half of the dictation diagnostics.
   *
   * The helper traces what the engines did; this traces what we decided in
   * response — above all the manual-edit restarts, which are the one thing that
   * can drive the engines into a restart storm and which left no trace at all.
   * Same log file as the native traces (`panda-code-debug.log`), so a single
   * pass over it reads the whole loop in order.
   *
   * Lengths only, never transcript text. That constraint is not privacy theatre
   * for a local file — it is what keeps the trace cheap enough to leave on
   * permanently, and every dictation bug found so far was legible from counts,
   * generations and ordering alone.
   *
   * Read it with `pnpm trace:dictation`. The log rolls at 24 MB and ordinary
   * session traffic fills that within hours, so these survive hours, not days:
   * collect them the same day the problem happens.
   */
  const trace = useCallback(
    (event: string, details?: Record<string, unknown>): void => {
      void desktopApi.logEvent({ source: "renderer", event: `dictation:trace`, details: { event, ...details } });
    },
    [desktopApi],
  );

  /** Where a recording started now would go: the most recently focused input. */
  const activeTarget = useRef<DictationTarget | null>(null);

  /** Where the live recording is going. Pinned at start, so focus can move. */
  const sessionTarget = useRef<DictationTarget | null>(null);

  /** When the user pressed, and whether any text has landed since. Diagnostics only. */
  const pressedAt = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void desktopApi.dictationAvailable().then((supported) => {
      if (cancelled) return;
      setAvailable(supported);
      // Training the custom language model takes a few seconds the first time a
      // vocabulary version is seen. Do it now so the first press is instant.
      if (supported) void desktopApi.prepareDictation();
    });
    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  const finish = useCallback((): void => {
    mode.current = "idle";
    sessionTarget.current = null;
    pressedAt.current = null;
    setRecordingInto(null);
    setListening(false);
    setPushing(false);
  }, []);

  useEffect(() => {
    return desktopApi.onDictation((event) => {
      const target = sessionTarget.current;
      // A late event from an utterance that already ended, or one belonging to
      // an input that has since gone away, has nowhere to go.
      if (!target || event.targetId !== target.id) return;

      switch (event.type) {
        case "listening":
          setListening(true);
          setError(null);
          return;
        case "partial":
        case "segment": {
          if (transcript.current.absorbManualEdit(target.readText())) {
            // The task now in flight still carries the pre-edit transcript —
            // applying this event would restate everything the user just
            // corrected, appended right after it. Drop it and force a fresh
            // task so the next partial is relative to the rebased text.
            //
            // Traced because this is also how the field looks when a *second*
            // engine is writing into it: every event reads as a manual edit, and
            // the restarts it triggers become a storm. A run of these with no
            // user typing in between is that bug, not a user correction.
            trace("renderer.manual_edit_restart", {
              kind: event.type,
              eventLen: event.text.length,
              fieldLen: target.readText().length,
            });
            void desktopApi.restartDictation();
            return;
          }
          if (event.type === "segment") {
            // `provisional` rides through to the transcript rather than being
            // resolved here: this handler sees one event at a time, and telling a
            // real restart from a re-transcription needs the partials that follow.
            transcript.current.segment(event.text, event.provisional === true);
          } else {
            transcript.current.update(event.text);
          }
          target.writeText(transcript.current.render());
          // A later utterance has landed in the field: restoring the discarded
          // one would now clobber it, so stop offering that.
          if (discardedTarget.current) {
            discardedTarget.current = null;
            setDiscarded(null);
          }
          if (pressedAt.current !== null) {
            trace("renderer.first_text", { ms: Date.now() - pressedAt.current, kind: event.type });
            pressedAt.current = null;
          }
          return;
        }
        case "final":
        case "cancelled":
          finish();
          return;
        case "auth":
          if (event.status !== "granted") {
            setError(dictationErrorMessage(event.status));
            finish();
          }
          return;
        case "error":
          setError(dictationErrorMessage(event.code));
          finish();
          return;
        default:
          return;
      }
    });
  }, [desktopApi, finish, trace]);

  /** Where dictation goes when nothing has focus — the section composer. */
  const fallbackTarget = useRef<DictationTarget | null>(null);

  const focusTarget = useCallback((target: DictationTarget): void => {
    activeTarget.current = target;
  }, []);

  const registerFallback = useCallback((target: DictationTarget): void => {
    fallbackTarget.current = target;
    activeTarget.current ??= target;
  }, []);

  const releaseTarget = useCallback(
    (id: string): void => {
      if (activeTarget.current?.id === id) {
        // Hand back to the section composer rather than leaving nothing
        // selected — closing an overlay should not disable the microphone.
        activeTarget.current = fallbackTarget.current?.id === id ? null : fallbackTarget.current;
      }
      if (fallbackTarget.current?.id === id) fallbackTarget.current = null;
      // The field the text would go back into is gone.
      if (discardedTarget.current?.id === id) {
        discardedTarget.current = null;
        setDiscarded(null);
      }
      // The input being dictated into just disappeared — the side chat closed,
      // or the section changed. Abandon the utterance rather than let the words
      // land somewhere the user was not looking.
      if (sessionTarget.current?.id === id) {
        void desktopApi.cancelDictation();
        finish();
      }
    },
    [desktopApi, finish],
  );

  /** Returns whether a session was actually opened. */
  const begin = useCallback(
    (next: DictationMode): boolean => {
      const target = activeTarget.current;
      if (!available || !target || mode.current !== "idle") return false;
      mode.current = next;
      sessionTarget.current = target;
      setRecordingInto(target.id);
      setError(null);
      transcript.current.start(target.readText());
      // The press is the only moment the user's "it took ten seconds to start"
      // can be measured from. The helper's own traces begin at `analyzer.open`,
      // which is already downstream of the wait being complained about.
      pressedAt.current = Date.now();
      trace("renderer.begin", { mode: next, baseLen: target.readText().length });
      // Keep the caret where it was, so a word can be fixed by hand without
      // clicking back into the field first.
      target.focus();
      void desktopApi.startDictation({ targetId: target.id }).then((started) => {
        if (!started) {
          setError(dictationErrorMessage("missing_helper"));
          finish();
        }
      });
      return true;
    },
    [available, desktopApi, finish, trace],
  );

  const toggle = useCallback((): void => {
    if (mode.current === "idle") {
      begin("hands-free");
      return;
    }
    // Stops a push-to-talk burst too: the tap is unambiguous, and a stuck key
    // should not leave the microphone with no way to close it.
    void desktopApi.stopDictation();
    setPushing(false);
  }, [begin, desktopApi]);

  const press = useCallback((): void => {
    // Only once `begin` has accepted it. Marking the key as held before that
    // left the flag stuck when there was no input to dictate into.
    if (begin("push")) setPushing(true);
  }, [begin]);

  const release = useCallback((): void => {
    // Cleared unconditionally: whatever the session is doing, the key is up.
    setPushing(false);
    if (mode.current !== "push") return;
    void desktopApi.stopDictation();
  }, [desktopApi]);

  /**
   * Throw the recording away.
   *
   * Distinct from stopping: stop keeps the words so they can be read back and
   * corrected, discard puts the input back as it was. The way out when the
   * recogniser has heard the wrong thing entirely.
   */
  const discard = useCallback((): void => {
    if (mode.current === "idle") return;
    const target = sessionTarget.current;
    const wiped = target?.readText() ?? "";
    const restored = transcript.current.discarded;
    void desktopApi.cancelDictation();
    target?.writeText(restored);
    // Only worth offering back if speech actually reached the field — a discard
    // half a second after starting has nothing to undo.
    if (target && wiped !== restored) {
      discardedTarget.current = target;
      setDiscarded({ targetId: target.id, text: wiped });
      trace("renderer.discard", { wipedLen: wiped.length, keptLen: restored.length });
    }
    finish();
  }, [desktopApi, finish, trace]);

  const undoDiscard = useCallback((): void => {
    const stash = discarded;
    const target = discardedTarget.current;
    if (!stash || !target) return;
    // Straight back into the field, not through the transcript: this is the
    // text as it read on screen, which is what the user is asking for.
    target.writeText(stash.text);
    target.focus();
    discardedTarget.current = null;
    setDiscarded(null);
  }, [discarded]);

  const dismissDiscard = useCallback((): void => {
    discardedTarget.current = null;
    setDiscarded(null);
  }, []);

  const canUndoDiscard = useCallback((id: string): boolean => discarded?.targetId === id, [discarded]);

  const settle = useCallback(async (): Promise<void> => {
    if (mode.current === "idle") return;
    await desktopApi.stopDictation();
    // Give the final a moment to land so the last words are not clipped. The
    // helper flushes on the same timer.
    await new Promise((resolve) => setTimeout(resolve, 700));
    finish();
  }, [desktopApi, finish]);

  const dismissError = useCallback(() => setError(null), []);
  const isRecordingInto = useCallback((id: string): boolean => recordingInto === id, [recordingInto]);

  return useMemo(
    () => ({
      available,
      listening,
      pushing,
      error,
      dismissError,
      focusTarget,
      registerFallback,
      releaseTarget,
      isRecordingInto,
      toggle,
      press,
      release,
      discard,
      undoDiscard,
      canUndoDiscard,
      dismissDiscard,
      settle,
    }),
    [
      available,
      listening,
      pushing,
      error,
      dismissError,
      focusTarget,
      registerFallback,
      releaseTarget,
      isRecordingInto,
      toggle,
      press,
      release,
      discard,
      undoDiscard,
      canUndoDiscard,
      dismissDiscard,
      settle,
    ],
  );
}

/**
 * Registers one input with the controller for the life of the component.
 *
 * The target object is rebuilt only when its identity or accessors change, so a
 * composer can hand this straight to an `onFocus` without re-registering on
 * every keystroke.
 */
export function useDictationTarget(
  dictation: DictationController,
  id: string,
  readText: () => string,
  writeText: (text: string) => void,
  focus: () => void,
  /** Marks this the input dictation falls back to when nothing holds focus. */
  fallback = false,
): { onFocus: () => void; recording: boolean; undoable: boolean } {
  const readRef = useRef(readText);
  readRef.current = readText;
  const writeRef = useRef(writeText);
  writeRef.current = writeText;
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const target = useMemo<DictationTarget>(
    () => ({
      id,
      readText: () => readRef.current(),
      writeText: (text) => writeRef.current(text),
      focus: () => focusRef.current(),
    }),
    [id],
  );

  const { focusTarget, registerFallback, releaseTarget } = dictation;
  useEffect(() => {
    if (fallback) registerFallback(target);
    return () => releaseTarget(id);
  }, [fallback, id, registerFallback, releaseTarget, target]);

  return {
    onFocus: useCallback(() => focusTarget(target), [focusTarget, target]),
    recording: dictation.isRecordingInto(id),
    undoable: dictation.canUndoDiscard(id),
  };
}
