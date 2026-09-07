/**
 * Dictation protocol and transcript assembly.
 *
 * The recognition itself happens in `native/dictation/main.swift`, a helper
 * process the main process spawns. This module is the part that has to agree on
 * both sides of that pipe, plus the one piece of real logic that is not Apple's:
 * turning a stream of revisable guesses into composer text that never loses a
 * word. See `DictationTranscript`.
 *
 * The helper runs one of two engines behind the same protocol: `SpeechAnalyzer`
 * on macOS 26 (`native/dictation/Analyzer.swift`, the model system dictation
 * uses), and `SFSpeechRecognizer` below that or when the newer model cannot be
 * installed. Nothing on this side needs to know which — the events mean the
 * same thing either way.
 */

/**
 * An input dictation can type into.
 *
 * Registered by each composer as it gains focus, so "dictate" always means
 * "into the box I am looking at" without any of them having to know about the
 * others.
 */
export type DictationTarget = {
  /** Stable per input. Round-trips through the helper so late events can be placed. */
  id: string;
  readText: () => string;
  writeText: (text: string) => void;
  focus: () => void;
};

/** Commands written to the helper's stdin, one JSON object per line. */
export type DictationCommand =
  | { cmd: "authorize" }
  | { cmd: "prepare"; phrases: string[]; version: string; locale: string }
  | {
      cmd: "start";
      contextualStrings: string[];
      locale: string;
      onDevice: boolean;
      punctuation: boolean;
    }
  | { cmd: "stop" }
  | { cmd: "cancel" }
  | { cmd: "restart" }
  | { cmd: "quit" };

/**
 * Events read from the helper's stdout.
 *
 * `segment` is the load-bearing one: it means "bank this, it will never be
 * revised". It does *not* mean the session ended — the recogniser rotates tasks
 * roughly every minute and banks a segment at each seam while dictation carries
 * on. Only `final` ends a session.
 */
export type DictationEvent =
  | { type: "listening" }
  | { type: "partial"; text: string }
  /**
   * `provisional` marks a segment banked on *suspicion* rather than on a final:
   * the helper saw the transcription jump to a later span of audio and saved the
   * old utterance before it could be overwritten. It is right to bank it — no
   * final is ever coming for that text — but the helper cannot yet know whether
   * the new utterance covers new speech or re-transcribes the same words. Only
   * the renderer can, by watching what the new partial grows into, so a
   * provisional segment stays revocable there until that is settled.
   */
  | { type: "segment"; text: string; provisional?: boolean }
  | { type: "final"; text: string }
  | { type: "cancelled" }
  | { type: "prepared"; ok: boolean }
  | { type: "auth"; status: "granted" | "speech_denied" | "microphone_denied" }
  | { type: "error"; code?: string; message: string }
  | { type: "trace"; event: string; gen?: number; textLen?: number; note?: string };

/**
 * A helper event as the renderer receives it, tagged with the input that was
 * being dictated into when it was emitted.
 *
 * There is more than one composer on screen — a section's, the quick-start
 * overlay's, the side chat's — and dictation goes to whichever one has focus.
 * The tag is what stops words landing in a different box than the one they were
 * started in, if focus moves mid-sentence.
 */
export type DictationRendererEvent = Exclude<DictationEvent, { type: "trace" }> & { targetId: string };

/**
 * Languages dictation can be decoded as.
 *
 * Separate from the system language on purpose. Apple picks the acoustic and
 * language model from this locale, so a Mac set to Portuguese decodes English
 * speech through a Portuguese model — which does not mangle a word here and
 * there, it returns unrelated words for whole clauses. Most of this team speaks
 * English tech vocabulary on non-English machines, so the default is English
 * regardless of the system setting.
 */
export const DICTATION_LOCALES: Readonly<Record<string, string>> = {
  "en-US": "English (US)",
  "en-GB": "English (UK)",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  "es-ES": "Español",
  "fr-FR": "Français",
  "de-DE": "Deutsch",
  "it-IT": "Italiano",
};

export const DICTATION_FALLBACK_LOCALE = "en-US";

export function normalizeDictationLocale(id: string | undefined): string {
  return id && id in DICTATION_LOCALES ? id : DICTATION_FALLBACK_LOCALE;
}

export function dictationErrorMessage(code: string | undefined): string {
  switch (code) {
    case "speech_denied":
      return "Allow Speech Recognition for Panda Code in System Settings → Privacy & Security.";
    case "microphone_denied":
      return "Allow Microphone access for Panda Code in System Settings → Privacy & Security.";
    case "unavailable":
      return "Speech recognition is unavailable on this Mac.";
    case "no_input":
      return "No microphone input is available.";
    case "missing_helper":
      return "Dictation helper is missing from this build.";
    default:
      return "Dictation failed.";
  }
}

/** Identifies a phrase set so the helper retrains the custom language model only when it changed. */
export function vocabularyVersion(phrases: readonly string[], locale: string): string {
  if (phrases.length === 0) return `empty-${locale}`;
  let hash = 0;
  for (const phrase of phrases) {
    for (let index = 0; index < phrase.length; index += 1) {
      hash = (Math.imul(hash, 31) + phrase.charCodeAt(index)) | 0;
    }
  }
  return `${(hash >>> 0).toString(16)}-${locale}`;
}

function join(a: string, b: string): string {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return a.endsWith(" ") ? `${a}${b}` : `${a} ${b}`;
}

/**
 * Strip everything that a re-transcription of the same speech is allowed to
 * change: case, punctuation and spacing. The recogniser routinely re-reports
 * identical words as "hey, it is down" then "Hey it is down", and a comparison
 * that counted those as different text would never recognise a duplicate.
 */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * How much of a new utterance must be on the table before it is allowed to
 * revoke a provisional bank.
 *
 * Every re-transcription starts as a one-word prefix of the text it is
 * repeating, and so does a genuine new utterance that happens to open with the
 * same word — "So…" following "So the backend is down" is the case that erased
 * 45 characters when the old text-only rule guessed early. Waiting for this many
 * comparable characters means roughly three words have agreed before anything is
 * dropped, which is long past where two unrelated utterances diverge.
 */
const RETRANSCRIPTION_MIN_CHARS = 12;

/**
 * Is `partial` re-transcribing speech that `banked` already covers?
 *
 * Containment either way counts. The recogniser re-reports the same span either
 * as a growing prefix of what it said before (the common case, while the new
 * utterance catches up) or as the whole of it plus more (when it re-transcribes
 * and then carries on past the seam).
 */
function isRetranscription(banked: string, partial: string): boolean {
  const previous = normalizeForCompare(banked);
  const next = normalizeForCompare(partial);
  if (next.length < RETRANSCRIPTION_MIN_CHARS) return false;
  if (previous.length === 0) return false;
  return previous.startsWith(next) || next.startsWith(previous);
}

/**
 * Assembles composer text from a stream of recognition results.
 *
 * The composer is rebuilt as `base + committed + partial` on every update.
 * Splitting it into three parts is what makes dictation survive a task restart.
 *
 * The recogniser ends a task on its own after roughly a minute, and each task
 * numbers its transcript from zero. Treating the recogniser's string as the
 * whole truth means that reset wipes everything said so far — the text visibly
 * guts itself mid-sentence. So finalised words are banked here and only the
 * in-flight guess is allowed to churn.
 */
export class DictationTranscript {
  /** Composer text from before dictation started. Never touched. */
  private base = "";

  /** Words the recogniser has finalised. Append-only across any number of internal restarts. */
  private committed = "";

  /**
   * An utterance banked on suspicion of a restart, still revocable.
   *
   * Sits between `committed` and `partial` in the rendered text and in time. It
   * is held here rather than folded straight into `committed` because the helper
   * that produced it could not tell a genuine new utterance from the recogniser
   * re-transcribing the words it just reported — banking the first is required
   * (nothing else will save that text), banking the second duplicates it. See
   * `isRetranscription`: once the following partial has said enough to settle
   * which happened, `update` either drops this or leaves it to be promoted.
   */
  private provisional = "";

  /**
   * The current guess. Rewritten freely — the recogniser revises earlier words
   * as it hears more, and that is fine as long as it can only revise this part.
   */
  private partial = "";

  /**
   * What was last written to the composer, so a manual edit can be told apart
   * from our own write and preserved instead of clobbered.
   */
  private lastWritten = "";

  /**
   * The composer exactly as it was before dictation started, with no trailing
   * space added. Discarding a recording puts this back — an aborted utterance
   * should leave no trace, including the separator it would have needed.
   */
  private initial = "";

  /** Begin a session on top of whatever is already typed. */
  start(existing: string): void {
    this.initial = existing;
    this.base = existing;
    // Record before the trailing space is added below: `lastWritten` stands for
    // what the field actually displays, and it does not gain that space until
    // the next render. Leaving it empty made any non-empty starting text read
    // as a "manual edit" on the very first result, and it got dropped.
    this.lastWritten = existing;
    if (this.base.length > 0 && !this.base.endsWith(" ")) this.base = `${this.base} `;
    this.committed = "";
    this.provisional = "";
    this.partial = "";
  }

  /**
   * Fold anything typed by hand since our last write into the base, so the next
   * render does not overwrite it. Lets the keyboard and the mic be used in the
   * same breath.
   *
   * Returns whether an edit was found — the caller must then discard whatever
   * recognition result triggered this check and restart the helper's task, or
   * its stale, still-in-flight transcript will duplicate the words just rebased
   * into the base.
   */
  absorbManualEdit(current: string): boolean {
    if (current === this.lastWritten) return false;
    // Record before the trailing space is added below, and before `base` gains
    // it — `lastWritten` stands for what the field actually displays. Otherwise,
    // since the caller skips the render this pass, it would stay one space short
    // of the field and the very next event would read as "edited again",
    // restarting the task on a loop.
    this.lastWritten = current;
    this.base = current;
    if (this.base.length > 0 && !this.base.endsWith(" ")) this.base = `${this.base} `;
    this.committed = "";
    this.provisional = "";
    this.partial = "";
    return true;
  }

  /**
   * Bank a segment.
   *
   * A plain segment is final: the recogniser can never take those words back, so
   * it settles any provisional bank ahead of it on the way in — if that text had
   * been a duplicate, the partial that followed would already have revoked it.
   *
   * A `provisional` segment is the suspected-restart case and stays revocable.
   * Two in a row promote the older one: the recogniser has moved on twice, so
   * whatever the first one held is no longer in play for re-transcription.
   */
  segment(text: string, provisional = false): void {
    if (provisional) {
      this.committed = join(this.committed, this.provisional);
      this.provisional = text;
      this.partial = "";
      return;
    }
    this.committed = join(this.committed, join(this.provisional, text));
    this.provisional = "";
    this.partial = "";
  }

  /**
   * Replace the in-flight guess, and use it to settle any provisional bank.
   *
   * This is the only place with enough information to tell the two restart cases
   * apart, because it is the only one that sees what the new utterance grows
   * into. Until it can, the provisional text keeps rendering: an erasure is
   * unrecoverable and a duplicate that collapses a word later is not, so the
   * uncertain window is spent showing too much rather than too little.
   */
  update(text: string): void {
    this.partial = text;
    if (this.provisional.length > 0 && isRetranscription(this.provisional, text)) {
      this.provisional = "";
    }
  }

  /** The composer text as it should now read. */
  render(): string {
    const text = this.base + join(this.committed, join(this.provisional, this.partial));
    this.lastWritten = text;
    return text;
  }

  /** True once anything has been transcribed — used to decide whether a stop produced text at all. */
  get spoken(): boolean {
    return this.committed.length > 0 || this.provisional.length > 0 || this.partial.length > 0;
  }

  /**
   * What the composer should read if this recording is thrown away.
   *
   * Not simply the starting text: a manual edit mid-dictation rebases the base,
   * and discarding must keep the typing while dropping only the speech.
   */
  get discarded(): string {
    return this.base === this.initial ? this.initial : this.base.trimEnd();
  }
}
