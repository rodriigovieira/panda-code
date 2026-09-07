import { Mic, Undo2, X } from "lucide-react";
import type { ReactElement } from "react";
import type { DictationController } from "./dictation";

/**
 * The "your microphone is open" banner.
 *
 * Shared by every composer that can be dictated into — a section's, the
 * quick-start overlay's, the side chat's — so the recording state looks and
 * behaves the same wherever you are speaking.
 *
 * Renders nothing unless *this* input is the one recording: there is one
 * microphone, and the bar belongs above the box the words are landing in.
 */
export function DictationBar({
  dictation,
  recording,
  undoable = false,
  sendHint = "Enter sends",
}: {
  dictation: DictationController;
  recording: boolean;
  /** This input holds the text the last discard wiped, and can have it back. */
  undoable?: boolean;
  /** What Enter does here — "Enter sends" in a composer, "Enter asks" in the side chat. */
  sendHint?: string;
}): ReactElement | null {
  // Takes the bar's place once the recording is gone, in the same spot above the
  // box the words vanished from. Dictation replaces the field's value outright,
  // so this is the only way back — losing a long utterance to a mistaken Escape
  // used to be final.
  if (!recording && undoable) {
    return (
      <div className="dictation-bar dictation-bar--undo" role="status" aria-live="polite">
        <span className="dictation-bar-label">
          Recording discarded
          <span className="dictation-bar-hint">the text is still here until you speak again</span>
        </span>
        <button type="button" className="dictation-undo" onClick={dictation.undoDiscard}>
          <Undo2 size={12} aria-hidden="true" />
          Undo
        </button>
        <button type="button" className="dictation-undo-dismiss" onClick={dictation.dismissDiscard} aria-label="Dismiss">
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    );
  }
  if (!recording) return null;
  return (
    <div className="dictation-bar" role="status" aria-live="polite">
      {/* A four-bar level meter. Not wired to real input amplitude — it animates
          on a fixed loop — because its job is to say "the microphone is open",
          and a meter that sits flat through a quiet passage says the opposite. */}
      <span className="dictation-level" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="dictation-bar-label">
        Listening…
        <span className="dictation-bar-hint">
          {dictation.pushing ? "release ⌥Space to stop" : `⌘⇧D or click the mic to stop · ${sendHint}`}
        </span>
      </span>
      <button type="button" className="dictation-discard" onClick={dictation.discard} title="Discard (Esc)">
        Discard
      </button>
    </div>
  );
}

/**
 * The microphone button.
 *
 * Quiet when idle so it never competes with send; accent and animated while
 * live. Clicking it while recording stops and keeps the words — discarding is
 * the bar's job, and Escape's.
 */
export function DictationMicButton({
  dictation,
  recording,
  className = "",
}: {
  dictation: DictationController;
  recording: boolean;
  /** Extra classes — `composer-fab--beside` when it shares the corner with another button. */
  className?: string;
}): ReactElement | null {
  if (!dictation.available) return null;
  return (
    <button
      className={`composer-fab ${recording ? `composer-fab--recording${dictation.pushing ? " pushing" : ""}` : "composer-fab--mic"} ${className}`.trim()}
      type="button"
      onClick={dictation.toggle}
      aria-label={recording ? "Stop dictating" : "Dictate"}
      title={
        recording
          ? dictation.pushing
            ? "Listening — release ⌥Space to stop"
            : "Listening — click or ⌘⇧D to stop"
          : "Dictate (⌘⇧D) · hold ⌥Space to talk"
      }
    >
      <Mic size={16} aria-hidden="true" />
    </button>
  );
}
