import { describe, expect, it } from "vitest";
import {
  DictationTranscript,
  dictationErrorMessage,
  normalizeDictationLocale,
  vocabularyVersion,
} from "./dictation";

describe("DictationTranscript", () => {
  it("appends to text that was already typed", () => {
    const transcript = new DictationTranscript();
    transcript.start("fix the");
    transcript.update("relay bridge");
    expect(transcript.render()).toBe("fix the relay bridge");
  });

  it("starts clean from an empty composer", () => {
    const transcript = new DictationTranscript();
    transcript.start("");
    transcript.update("hello");
    expect(transcript.render()).toBe("hello");
  });

  it("lets the recogniser revise the in-flight guess", () => {
    const transcript = new DictationTranscript();
    transcript.start("");
    transcript.update("the backend");
    transcript.update("the back end");
    expect(transcript.render()).toBe("the back end");
  });

  // The bug this whole three-part split exists for: the recogniser ends a task
  // about once a minute and the next one numbers its transcript from zero.
  it("keeps banked segments when the task restarts from zero", () => {
    const transcript = new DictationTranscript();
    transcript.start("");
    transcript.update("first sentence about convex");
    transcript.segment("first sentence about convex");
    // New task; its partials know nothing of what came before.
    transcript.update("second");
    expect(transcript.render()).toBe("first sentence about convex second");
    transcript.update("second sentence");
    expect(transcript.render()).toBe("first sentence about convex second sentence");
  });

  it("does not double-space across a segment boundary", () => {
    const transcript = new DictationTranscript();
    transcript.start("typed ");
    transcript.segment("one");
    transcript.segment("two");
    expect(transcript.render()).toBe("typed one two");
  });

  // A provisional segment is the helper saying "the transcription jumped to
  // later audio, so I banked the old utterance before it was overwritten — but I
  // could not tell whether the new one is different speech or the same speech
  // said again". Resolving that is this class's job.
  describe("provisional segments", () => {
    it("keeps the bank when the new utterance is genuinely different speech", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.update("the deploy finished at noon");
      transcript.segment("the deploy finished at noon", true);
      transcript.update("but the migration");
      transcript.update("but the migration is still running");
      expect(transcript.render()).toBe(
        "the deploy finished at noon but the migration is still running",
      );
    });

    it("drops the bank when the recogniser is re-transcribing the same speech", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.update("we have multiple dirty files in the project");
      transcript.segment("we have multiple dirty files in the project", true);
      // Same words again, from the top — this is what duplicated the text.
      transcript.update("we have multiple");
      transcript.update("we have multiple dirty files");
      transcript.update("we have multiple dirty files in the project");
      expect(transcript.render()).toBe("we have multiple dirty files in the project");
    });

    it("ignores case and punctuation when deciding that", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.segment("Hey, it is down.", true);
      transcript.update("hey it is down");
      expect(transcript.render()).toBe("hey it is down");
    });

    it("drops it when the re-transcription carries on past the seam", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.segment("check the relay logs", true);
      transcript.update("check the relay logs and the push queue");
      expect(transcript.render()).toBe("check the relay logs and the push queue");
    });

    // The erasure this replaced: a new utterance opening on the same word as the
    // one before it. Deciding early would throw away everything already said.
    it("does not drop it on a short prefix that happens to match", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.segment("so the backend is down", true);
      transcript.update("so");
      expect(transcript.render()).toBe("so the backend is down so");
      transcript.update("so I restarted it");
      expect(transcript.render()).toBe("so the backend is down so I restarted it");
    });

    it("renders the bank while the question is still open", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.segment("the first half", true);
      // Nothing said yet either way: show too much rather than risk erasure.
      expect(transcript.render()).toBe("the first half");
    });

    it("promotes it once a final segment lands on top", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.segment("banked on suspicion", true);
      transcript.segment("and then finalised");
      transcript.update("still going");
      expect(transcript.render()).toBe("banked on suspicion and then finalised still going");
    });

    it("promotes an older provisional when a second one arrives", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.segment("first utterance", true);
      transcript.segment("second utterance", true);
      transcript.update("third");
      expect(transcript.render()).toBe("first utterance second utterance third");
    });

    it("counts a pending bank as spoken, so stopping does not discard it", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.segment("only ever provisional", true);
      expect(transcript.spoken).toBe(true);
    });

    it("clears it when the user edits by hand, like every other part", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.segment("spoken words", true);
      transcript.render();
      expect(transcript.absorbManualEdit("typed instead")).toBe(true);
      transcript.update("and more");
      expect(transcript.render()).toBe("typed instead and more");
    });
  });

  describe("manual edits mid-dictation", () => {
    it("ignores its own writes", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.update("hello there");
      const rendered = transcript.render();
      expect(transcript.absorbManualEdit(rendered)).toBe(false);
    });

    it("rebases onto text the user corrected by hand", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.update("convicts query");
      transcript.render();

      // User fixes the mangled noun by hand.
      expect(transcript.absorbManualEdit("convex query")).toBe(true);
      // The stale task's next partial is dropped by the caller; the fresh task
      // reports only what is said from here.
      transcript.update("is slow");
      expect(transcript.render()).toBe("convex query is slow");
    });

    it("does not re-trigger on the space it adds while rebasing", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.update("draft");
      transcript.render();
      expect(transcript.absorbManualEdit("edited")).toBe(true);
      // Regression: `lastWritten` used to lag the field by the trailing space,
      // so every following event looked like another edit and restarted the
      // recognition task in a loop.
      expect(transcript.absorbManualEdit("edited")).toBe(false);
    });

    it("treats non-empty starting text as the base, not as an edit", () => {
      const transcript = new DictationTranscript();
      transcript.start("already typed");
      expect(transcript.absorbManualEdit("already typed")).toBe(false);
      transcript.update("and spoken");
      expect(transcript.render()).toBe("already typed and spoken");
    });
  });

  describe("discarding", () => {
    it("puts back exactly what was typed, with no leftover separator", () => {
      const transcript = new DictationTranscript();
      transcript.start("fix the");
      transcript.update("relay bridge");
      transcript.render();
      expect(transcript.discarded).toBe("fix the");
    });

    it("leaves an empty composer empty", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.segment("some words");
      expect(transcript.discarded).toBe("");
    });

    // Discarding drops the speech, not the typing — a correction made by hand
    // mid-dictation has to survive it.
    it("keeps a manual edit made mid-dictation", () => {
      const transcript = new DictationTranscript();
      transcript.start("");
      transcript.update("convicts");
      transcript.render();
      transcript.absorbManualEdit("convex query");
      transcript.update("is slow");
      expect(transcript.discarded).toBe("convex query");
    });
  });

  it("reports whether anything was actually spoken", () => {
    const transcript = new DictationTranscript();
    transcript.start("typed");
    expect(transcript.spoken).toBe(false);
    transcript.update("said");
    expect(transcript.spoken).toBe(true);
  });
});

describe("vocabularyVersion", () => {
  it("is stable for the same phrases and locale", () => {
    expect(vocabularyVersion(["a", "b"], "en-US")).toBe(vocabularyVersion(["a", "b"], "en-US"));
  });

  it("changes when the vocabulary changes, so the model retrains", () => {
    expect(vocabularyVersion(["a", "b"], "en-US")).not.toBe(vocabularyVersion(["a", "c"], "en-US"));
  });

  // The trained model is exported per-locale and is rejected by a recogniser
  // built for a different one.
  it("changes with the locale", () => {
    expect(vocabularyVersion(["a"], "en-US")).not.toBe(vocabularyVersion(["a"], "pt-BR"));
  });
});

describe("normalizeDictationLocale", () => {
  it("keeps a supported locale", () => {
    expect(normalizeDictationLocale("pt-BR")).toBe("pt-BR");
  });

  it("falls back to English rather than the system language", () => {
    expect(normalizeDictationLocale(undefined)).toBe("en-US");
    expect(normalizeDictationLocale("kl-GL")).toBe("en-US");
  });
});

describe("dictationErrorMessage", () => {
  it("routes permission failures to the right settings pane", () => {
    expect(dictationErrorMessage("microphone_denied")).toMatch(/Microphone/);
    expect(dictationErrorMessage("speech_denied")).toMatch(/Speech Recognition/);
  });

  it("has a fallback for unknown codes", () => {
    expect(dictationErrorMessage("something-new")).toBe("Dictation failed.");
  });
});
