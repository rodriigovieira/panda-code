import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DictationCommand,
  type DictationEvent,
  normalizeDictationLocale,
  vocabularyVersion,
} from "../shared/dictation";

/**
 * Supervises the native dictation helper.
 *
 * One helper process for the whole app, not one per input: it owns the
 * microphone, and two live recognisers would fight over it. Which input the
 * transcript belongs to is tracked here instead, so words started in one
 * composer cannot land in another.
 *
 * The helper is spawned on first use and kept alive afterwards — starting it
 * costs a process launch plus the recogniser warming up, which is long enough
 * to clip the first word of a push-to-talk burst.
 */
export class DictationHost {
  constructor(
    private readonly binaryPath: string,
    private readonly vocabularyPath: string,
    private readonly emit: (event: DictationEvent & { targetId: string }) => void,
    private readonly log: (event: string, details?: Record<string, unknown>) => void,
  ) {}

  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";

  /** Input the current utterance is being typed into — see `DictationTarget`. */
  private targetId: string | null = null;

  private vocabulary: { terms: string[]; phrases: string[] } | null = null;

  /** Locale the custom language model was last prepared for. */
  private preparedFor: string | null = null;

  get available(): boolean {
    return existsSync(this.binaryPath);
  }

  private loadVocabulary(): { terms: string[]; phrases: string[] } {
    if (this.vocabulary) return this.vocabulary;
    let loaded = { terms: [] as string[], phrases: [] as string[] };
    try {
      if (existsSync(this.vocabularyPath)) {
        const parsed = JSON.parse(readFileSync(this.vocabularyPath, "utf8")) as {
          terms?: unknown;
          phrases?: unknown;
        };
        const strings = (raw: unknown): string[] =>
          Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
        loaded = { terms: strings(parsed.terms), phrases: strings(parsed.phrases) };
      }
    } catch (error) {
      // Untuned dictation still works; a broken vocabulary must not break it.
      this.log("dictation:vocabulary-unreadable", { message: String(error) });
    }
    this.vocabulary = loaded;
    return loaded;
  }

  private ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.child && !this.child.killed) return this.child;
    if (!this.available) {
      this.log("dictation:helper-missing", { path: this.binaryPath });
      return null;
    }

    const child = spawn(this.binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.log("dictation:stderr", { chunk: chunk.trim() }));

    child.on("exit", (code, signal) => {
      this.log("dictation:helper-exit", { code, signal });
      this.child = null;
      // The recogniser is gone and the composer is mid-sentence. Say so rather
      // than leaving a microphone button lit against a dead process.
      if (this.targetId) {
        this.emit({ targetId: this.targetId, type: "error", code: "helper_exit", message: "Dictation stopped." });
        this.targetId = null;
      }
      this.preparedFor = null;
    });

    child.on("error", (error) => {
      this.log("dictation:helper-error", { message: error.message });
      this.child = null;
    });

    return child;
  }

  private send(command: DictationCommand): boolean {
    const child = this.ensureChild();
    if (!child) return false;
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line.trim()) continue;
      let event: DictationEvent;
      try {
        event = JSON.parse(line) as DictationEvent;
      } catch {
        this.log("dictation:unparsed", { line: line.slice(0, 200) });
        continue;
      }
      if (event.type === "trace") {
        // Diagnostics ride the same pipe as transcripts. They carry counts and
        // task generations only — never transcript text.
        this.log("dictation:trace", { ...event });
        continue;
      }
      // A late event from an utterance that already ended has nowhere to go.
      // Dropping it is what stops the tail of one session's speech landing in
      // whichever section the user switched to.
      if (!this.targetId) continue;
      this.emit({ ...event, targetId: this.targetId });
    }
  }

  /**
   * Warm the speech engine ahead of the first use.
   *
   * On macOS 26 this installs and reserves the `SpeechAnalyzer` model for the
   * language — a download the first time, which is exactly why it must not
   * happen inside the gap between pressing the shortcut and speaking. Older
   * systems instead train the custom language model, a few seconds the first
   * time a vocabulary version is seen and cached on disk by the helper after.
   *
   * Sent even with no phrases to train on: the analyzer needs this call
   * regardless, and it is what decides which of the two engines serves the
   * session.
   */
  prepare(locale: string): void {
    const resolved = normalizeDictationLocale(locale);
    if (this.preparedFor === resolved) return;
    const { phrases } = this.loadVocabulary();
    if (this.send({ cmd: "prepare", phrases, version: vocabularyVersion(phrases, resolved), locale: resolved })) {
      this.preparedFor = resolved;
    }
  }

  start(targetId: string, locale: string): boolean {
    const resolved = normalizeDictationLocale(locale);
    this.prepare(resolved);
    this.targetId = targetId;
    const { terms } = this.loadVocabulary();
    return this.send({
      cmd: "start",
      contextualStrings: terms,
      locale: resolved,
      onDevice: true,
      punctuation: true,
    });
  }

  /** Stop listening and let the recogniser flush its last words. */
  stop(): void {
    this.send({ cmd: "stop" });
  }

  /** Abandon the utterance; no final transcript is emitted. */
  cancel(): void {
    this.send({ cmd: "cancel" });
    this.targetId = null;
  }

  /**
   * Abandon the in-flight task and open a fresh one without ending the session.
   *
   * Called when the composer text changed out from under dictation: the current
   * task's next partial still narrates the pre-edit wording, so continuing it
   * would restate what the user just corrected.
   */
  restart(): void {
    this.send({ cmd: "restart" });
  }

  dispose(): void {
    if (!this.child) return;
    this.send({ cmd: "quit" });
    // Do not wait on it. The helper releases the microphone in its own quit
    // path, and a hung recogniser must not hold up app shutdown.
    this.child = null;
  }
}

/**
 * Where the helper and its vocabulary sit.
 *
 * Packaged they are unpacked resources next to the app; in development they are
 * still in the source tree, where `pnpm build` writes them.
 */
export function dictationResourcePaths(packaged: boolean, dirname: string, resourcesPath: string): {
  binary: string;
  vocabulary: string;
} {
  const root = packaged ? resourcesPath : join(dirname, "../../resources");
  return { binary: join(root, "panda-dictation"), vocabulary: join(root, "dictation-vocabulary.json") };
}
