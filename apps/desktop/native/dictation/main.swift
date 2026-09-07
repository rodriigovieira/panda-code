import AVFoundation
import Foundation
import Speech

/// On-device dictation for the desktop composer.
///
/// A port of `apps/mobile/ios/Runner/Dictation.swift`. Same Apple speech stack,
/// same three knobs the keyboard's microphone key does not expose
/// (`contextualStrings`, `customizedLanguageModel`, `requiresOnDeviceRecognition`),
/// and — importantly — the same hard-won handling of how `SFSpeechRecognizer`
/// actually behaves over a long dictation: it ends tasks on its own, restarts
/// utterances mid-task without saying so, and fires callbacks after it is done.
/// Those three behaviours cost real instrumentation to find on iOS; the comments
/// explaining them are carried over rather than rediscovered here.
///
/// Electron cannot host this in-process, so it runs as a helper executable and
/// speaks newline-delimited JSON: commands in on stdin, events out on stdout.
/// That is the only meaningful difference from the iOS plugin — the Flutter
/// method channel became stdin, and the event channel became stdout.
///
/// macOS differences from the iOS original:
///   - No `AVAudioSession`; `AVAudioEngine` is driven directly.
///   - The microphone grant comes from `AVCaptureDevice`, not `AVAudioApplication`.
///   - Usage descriptions are linked into this binary's `__info_plist` section
///     (see `Info.plist` next door), because TCC reads them from the executable
///     that asks, not only from the host app bundle.
///
/// On macOS 26 this is the *fallback*. `DictationAnalyzer` runs the newer
/// `SpeechAnalyzer` model there, which is a straight accuracy win on this
/// composer's vocabulary; everything below is what macOS 14-25 still gets, and
/// it stays as-is because most of it exists to work around `SFSpeechRecognizer`
/// behaviour that only that API has.
final class DictationHelper {
  /// Apple degrades when `contextualStrings` is flooded - it is a bias list,
  /// not a dictionary. The miner already ranks terms, so we take the head.
  private static let maxContextualStrings = 100

  /// Locale dictation falls back to when nothing else resolves.
  ///
  /// Deliberately *not* `Locale.current`. The recogniser picks its acoustic and
  /// language model from this, and a Mac set to pt-BR will decode English
  /// speech through a Portuguese model - the failure mode is not a mangled
  /// project noun but whole clauses replaced by unrelated words, and no
  /// `contextualStrings` bias can reach across it. Most of this team speaks
  /// English tech vocabulary into machines that are not set to English, so the
  /// dictation language is its own setting rather than a consequence of the
  /// system one.
  private static let fallbackLocaleIdentifier = "en-US"

  private var recognizer: SFSpeechRecognizer?
  /// Identifier the current `recognizer` was actually built for - which may not
  /// be the one requested, if that locale has no recogniser on this machine.
  private var recognizerLocaleIdentifier: String?
  private let audioEngine = AVAudioEngine()

  /// The macOS 26 engine, once its model is installed for the chosen language.
  /// Untyped because the class is `@available(macOS 26.0, *)` and a stored
  /// property cannot be.
  private var analyzerStorage: AnyObject?

  /// Terms of the current session, kept so a `restart` can rebuild the analyzer
  /// with the same bias list.
  private var analyzerTerms: [String] = []

  @available(macOS 26.0, *)
  private var analyzer: DictationAnalyzer {
    if let existing = analyzerStorage as? DictationAnalyzer { return existing }
    let created = DictationAnalyzer(emit: { [weak self] payload in self?.emit(payload) })
    analyzerStorage = created
    return created
  }

  /// Is the analyzer engine installed and ready to take a session?
  ///
  /// Only ever consulted when *choosing* an engine at `start`. Reading it to
  /// route `stop`/`restart` is what put two recognisers on one microphone: it
  /// flips from false to true the moment the asynchronous `prepare` lands, so a
  /// session that began on the legacy engine would silently start routing its
  /// restarts to the analyzer while the legacy task kept running and emitting.
  private var analyzerReady: Bool {
    guard #available(macOS 26.0, *) else { return false }
    return (analyzerStorage as? DictationAnalyzer)?.isReady == true
  }

  /// Is the renderer's idle `prepare` still running?
  ///
  /// The only thing that distinguishes "the analyzer is coming, give it a
  /// moment" from "this Mac will never have it". Without it, a press would have
  /// to either wait on every machine that has no analyzer at all, or wait on
  /// none — and the first adds a stall to every press on older hardware.
  private var analyzerPreparing = false

  /// Counts starts, stops and cancels, so an asynchronous start can tell whether
  /// the press it belongs to is still the current one.
  ///
  /// Choosing an engine is now allowed to await a nearly-ready analyzer, which
  /// opens a window the command loop did not previously have: a `stop` or
  /// `cancel` arriving during that wait would be handled against `sessionEngine
  /// == .idle` and then the resolved start would go on to open a session nobody
  /// asked for — a live microphone with no UI attached to it. The start captures
  /// this on the way in and abandons itself if it changed.
  private var sessionEpoch = 0

  /// Which engine owns the session currently in flight.
  ///
  /// Decided once, at `start`, and held until the session ends. Every later
  /// command follows this rather than re-deciding, so a `prepare` completing
  /// mid-session cannot hand the wheel to a second engine.
  private enum SessionEngine: String {
    case idle, analyzer, native
  }
  private var sessionEngine: SessionEngine = .idle

  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?

  /// True from `start` until the user stops. macOS ends a recognition task on
  /// its own after roughly a minute; while this is set, that ends only the
  /// *task*, not the session - a fresh task is opened over the same, still-
  /// running audio engine. Rotating here rather than in the renderer is
  /// deliberate: it keeps the audio path untouched across the seam.
  private var running = false

  /// Settings for the session, replayed onto each rotated task.
  private var contextualStrings: [String] = []
  private var addsPunctuation = true
  private var preferOnDevice = true

  /// The newest partial transcript of the current task. A task that times out
  /// reports an *error*, not a final, so anything said since the last final
  /// exists only here - banking it on rotation is what stops the transcript
  /// being gutted at the seam.
  private var latestPartial = ""

  /// Where `latestPartial` begins on the task's audio timeline. Compared against
  /// each new transcription's start to tell a revision from a new utterance.
  private var latestUtteranceStart: TimeInterval = 0

  /// Identifies the current task. A finished task can fire its callback more
  /// than once - typically a final, then an error - and acting on the second
  /// rotates a task that is already gone, leaving two live recognisers writing
  /// transcripts that both start from zero. The stale one then overwrites the
  /// banked text. Callbacks carry the generation they were opened with and
  /// anything stale is dropped.
  private var generation = 0

  /// Consecutive task failures that produced no transcript. A single failure is
  /// a normal rotation; a run of them means the recogniser is wedged and the
  /// session should surface an error instead of spinning.
  private var barrenRotations = 0
  private var lastRotationAt: TimeInterval = 0

  /// Prepared custom language model, if one was built successfully. Optional by
  /// design: every failure path here falls back to contextual strings alone.
  private var languageModel: SFSpeechLanguageModel.Configuration?

  /// Did the recogniser start a new utterance inside the same task?
  ///
  /// `bestTranscription.formattedString` is NOT cumulative for the life of a
  /// task. After a pause, the recogniser begins a fresh utterance and the string
  /// restarts from zero, dropping everything before it — with no `isFinal` and
  /// no error, so nothing in the rotation path ever fires. Telemetry on iOS
  /// caught it directly: a 140-character partial replaced by a 9-character one,
  /// same generation, nothing in between. Detecting it here is what stops a
  /// pause mid-sentence erasing the sentence.
  ///
  /// Decided from the audio timeline where the recogniser provides one, and only
  /// from the text where it does not.
  ///
  /// The text-only rule this replaces got it wrong in both directions, and both
  /// are visible to the user: a miss erases what they said, a false alarm banks
  /// the old text and then appends the new, duplicating it. The specific miss it
  /// shipped with was `!previous.hasPrefix(next)` — a new utterance that happens
  /// to open with the same characters as the old one ("So…") reads as a
  /// shortening revision, so nothing is banked. That erased 45 characters in a
  /// logged session, and the two strings alone cannot tell the cases apart.
  ///
  /// Segment timestamps can. A revision re-reports the same span of audio and
  /// keeps its first segment's timestamp; a new utterance begins after the pause
  /// that ended the last one, so its first segment starts materially later.
  ///
  /// **This deliberately still over-fires, and that is now safe.** Returning
  /// true only says the transcription moved to a later span of audio. Banking is
  /// the right response *only if the new utterance covers different speech*;
  /// when the recogniser re-transcribes words it already reported — same speech,
  /// later timeline anchor — banking the old copy and then appending the new one
  /// put both in the composer. Logged directly as `banked=186 next=185
  /// by=timestamp`, and the two near-identical halves both landed in the field.
  ///
  /// Neither the timestamps nor the lengths settle it here, and they cannot:
  /// this function is called at the seam and by design cannot see what the new
  /// utterance grows into. So it no longer tries. The bank it triggers is emitted
  /// as `provisional`, and `DictationTranscript` on the renderer side — which
  /// already owns banking and can revise after the fact — drops it once the
  /// following partial shows the two describe the same speech. A false alarm
  /// here now costs a duplicate that disappears a word later instead of one that
  /// stays.
  ///
  /// Which means the bias below is unchanged but the stakes are not: prefer
  /// firing. A miss still erases text that nothing else will save.
  private func isUtteranceRestart(
    previous: String, next: String,
    previousStart: TimeInterval, nextStart: TimeInterval, timestamped: Bool
  ) -> Bool {
    guard !previous.isEmpty else { return false }

    if timestamped {
      return nextStart > previousStart + Self.utteranceGapSeconds
    }

    // No timestamps (some on-device configurations report zero throughout), so
    // fall back to the shape of the text.

    // A revision never throws away most of the transcript; a restart always
    // does. Checked before the overlap test below, which cannot see this case:
    // a short new utterance that happens to be a prefix of the old text overlaps
    // it completely.
    if previous.count >= 20, next.count * 4 < previous.count { return true }

    // Otherwise ask whether the two strings still describe the same words. A
    // revision keeps one end anchored — "the backend" -> "the back end" shares a
    // prefix, "Ay, it is down" -> "Hey, it is down" shares a suffix. A fresh
    // utterance shares neither.
    guard previous.count >= 8 else { return false }
    let overlap = max(sharedPrefixCount(previous, next), sharedSuffixCount(previous, next))
    return overlap * 2 < min(previous.count, next.count)
  }

  /// How far into the audio a transcription must move before it counts as a new
  /// utterance rather than a revision of the current one. Comfortably longer
  /// than the shift a revision causes by dropping a leading word, comfortably
  /// shorter than the pause that ends an utterance.
  private static let utteranceGapSeconds: TimeInterval = 0.35

  private func sharedPrefixCount(_ a: String, _ b: String) -> Int {
    var count = 0
    var x = a.startIndex
    var y = b.startIndex
    while x < a.endIndex, y < b.endIndex, a[x] == b[y] {
      count += 1
      x = a.index(after: x)
      y = b.index(after: y)
    }
    return count
  }

  private func sharedSuffixCount(_ a: String, _ b: String) -> Int {
    var count = 0
    var x = a.endIndex
    var y = b.endIndex
    while x > a.startIndex, y > b.startIndex {
      x = a.index(before: x)
      y = b.index(before: y)
      guard a[x] == b[y] else { break }
      count += 1
    }
    return count
  }

  /// Build (or reuse) the recogniser for `identifier`.
  ///
  /// Falls back rather than failing: a locale with no recogniser installed on
  /// this machine drops to en-US, and only then to whatever the system is set
  /// to. Returning nil means there is no speech recognition at all.
  @discardableResult
  private func resolveRecognizer(for identifier: String?) -> SFSpeechRecognizer? {
    let wanted = identifier?.trimmingCharacters(in: .whitespaces)
    let requested = (wanted?.isEmpty == false ? wanted! : Self.fallbackLocaleIdentifier)
    if requested == recognizerLocaleIdentifier, recognizer != nil { return recognizer }

    let candidates = [requested, Self.fallbackLocaleIdentifier, Locale.current.identifier]
    for candidate in candidates {
      guard let built = SFSpeechRecognizer(locale: Locale(identifier: candidate)) else { continue }
      recognizer = built
      recognizerLocaleIdentifier = candidate
      if candidate != requested {
        trace("native.locale_fallback", note: "\(requested)->\(candidate)")
      }
      return built
    }

    recognizer = nil
    recognizerLocaleIdentifier = nil
    return nil
  }

  // MARK: - Command dispatch

  func handle(_ command: [String: Any]) {
    switch command["cmd"] as? String ?? "" {
    case "authorize":
      authorize()
    case "prepare":
      let phrases = command["phrases"] as? [String] ?? []
      let version = command["version"] as? String ?? "1"
      let locale = command["locale"] as? String

      // Prefer the macOS 26 engine. Its first call for a language downloads the
      // model, which is why this runs from the renderer's idle prepare rather
      // than from the first press. Only if it cannot be had do we train the
      // custom language model the older recogniser needs.
      if #available(macOS 26.0, *) {
        analyzerPreparing = true
        Task { @MainActor in
          defer { self.analyzerPreparing = false }
          if await self.analyzer.prepare(locale: locale) {
            self.emit(["type": "prepared", "ok": true])
          } else {
            self.analyzerStorage = nil
            self.resolveRecognizer(for: locale)
            self.prepareLanguageModel(phrases: phrases, version: version)
          }
        }
      } else {
        resolveRecognizer(for: locale)
        prepareLanguageModel(phrases: phrases, version: version)
      }
    case "start":
      let terms = command["contextualStrings"] as? [String] ?? []
      let locale = command["locale"] as? String
      let onDevice = command["onDevice"] as? Bool ?? true
      let punctuation = command["punctuation"] as? Bool ?? true

      sessionEpoch += 1
      let epoch = sessionEpoch

      // Choosing the engine is asynchronous now, because it may wait out the
      // tail of a `prepare`. Everything that decides or claims happens inside
      // this task, in order, so the "decide once and hold" invariant is intact —
      // the wait is strictly *before* the decision, never a re-decision after
      // one. See `claimSession` and `awaitAnalyzerReadiness`.
      if #available(macOS 26.0, *) {
        Task { @MainActor in
          await self.awaitAnalyzerReadiness()
          // The press this belongs to was stopped or cancelled while we waited.
          // Claiming now would open a microphone with nothing attached to it.
          guard self.sessionEpoch == epoch else {
            self.trace("analyzer.start_abandoned", note: "epoch")
            return
          }

          // Whichever engine did not win must not be left holding the
          // microphone. Silencing the loser here is the belt to the
          // `sessionEngine` braces: even if routing were wrong again, only one
          // engine can be live.
          self.claimSession(self.analyzerReady ? .analyzer : .native)

          guard self.sessionEngine == .analyzer else {
            self.start(
              contextualStrings: terms, locale: locale, onDevice: onDevice,
              punctuation: punctuation)
            return
          }

          self.analyzerTerms = terms
          // The microphone grant is still this helper's business - the analyzer
          // taps the same input node, and touching it ungranted yields a silent
          // stream rather than a prompt.
          self.authorize { granted in
            guard granted else { return }
            Task { @MainActor in
              do {
                try await self.analyzer.start(contextualStrings: terms, locale: locale)
                self.emit(["type": "listening"])
              } catch {
                // The analyzer tears itself down on any failure, so the
                // microphone is free and the legacy engine can take the session
                // instead of the user seeing a dead button. An explicit handoff,
                // so the rest of the session routes to the engine that actually
                // has it.
                self.trace("analyzer.start_failed", note: error.localizedDescription)
                self.analyzerStorage = nil
                self.claimSession(.native)
                self.beginSession(
                  contextualStrings: terms, locale: locale, onDevice: onDevice,
                  punctuation: punctuation)
              }
            }
          }
        }
      } else {
        claimSession(.native)
        start(
          contextualStrings: terms, locale: locale, onDevice: onDevice,
          punctuation: punctuation)
      }
    case "stop":
      // Bumped before the engine check: a start still waiting on the analyzer
      // has not claimed anything yet, and this is what tells it to give up.
      sessionEpoch += 1
      if #available(macOS 26.0, *), sessionEngine == .analyzer {
        analyzer.stop()
      } else {
        stop()
      }
      sessionEngine = .idle
    case "cancel":
      sessionEpoch += 1
      if #available(macOS 26.0, *), sessionEngine == .analyzer {
        analyzer.cancel()
        emit(["type": "cancelled"])
      } else {
        cancel()
      }
      sessionEngine = .idle
    case "restart":
      if #available(macOS 26.0, *), sessionEngine == .analyzer {
        analyzer.restart(contextualStrings: analyzerTerms)
      } else {
        restartTask()
      }
    case "quit":
      if #available(macOS 26.0, *) {
        (analyzerStorage as? DictationAnalyzer)?.teardown()
      }
      teardown()
      // Give the analyzer's asynchronous teardown a moment to release the
      // microphone; exiting on top of it would leave the orange dot lit.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) }
    default:
      break
    }
  }

  // MARK: - Engine ownership

  /// Give `engine` the session, and make sure the other one is not still live.
  ///
  /// Both engines tap the same input node and emit the same event types on the
  /// same pipe, so two live at once is not a degraded mode — it is two
  /// independent transcripts of one utterance interleaving into the composer.
  /// That was the shipped behaviour whenever `prepare` landed after `start`:
  /// the legacy task kept running while every subsequent command routed to the
  /// analyzer, and nothing ever stopped it for the life of the process.
  ///
  /// The invariant had a cost: because the engine is chosen from readiness *at
  /// this instant* and then held, a press landing while `prepare` was still in
  /// flight spent the whole session on the weaker legacy engine even though the
  /// analyzer became ready moments later — a logged session claimed `native`
  /// with `ready=false` and saw `analyzer.ready` 351 ms afterwards, and that
  /// session went on to duplicate its text through the legacy engine's
  /// utterance-restart guessing.
  ///
  /// `awaitAnalyzerReadiness` pays that down the only way that does not
  /// reintroduce the two-engine bug: the *press* waits briefly, before anything
  /// is claimed. Re-deciding mid-session remains forbidden — that is precisely
  /// the bug this replaced.
  private func claimSession(_ engine: SessionEngine) {
    let analyzerLive: Bool = {
      guard #available(macOS 26.0, *) else { return false }
      return (analyzerStorage as? DictationAnalyzer)?.isRunning == true
    }()

    // A conflict here means the invariant broke somewhere upstream. Trace it
    // loudly: the symptom (duplicated, then truncated, text) is miserable to
    // diagnose from the outside, and this turns it into one grep.
    if (engine == .analyzer && running) || (engine == .native && analyzerLive) {
      trace(
        "engine.conflict", gen: generation,
        note: "claiming=\(engine.rawValue) native=\(running) analyzer=\(analyzerLive)")
    }

    switch engine {
    case .analyzer:
      if running { teardown() }
    case .native:
      if #available(macOS 26.0, *), analyzerLive {
        (analyzerStorage as? DictationAnalyzer)?.teardown()
      }
    case .idle:
      break
    }

    sessionEngine = engine
    trace("engine.claim", note: "\(engine.rawValue) ready=\(analyzerReady)")
  }

  /// Give a `prepare` that is nearly done the chance to finish before the engine
  /// is chosen.
  ///
  /// Only waits when one is actually in flight, which is what keeps it free: a
  /// Mac with no analyzer at all has `analyzerPreparing == false` by the time
  /// any press arrives, so it falls through instantly and dictation starts as
  /// fast as it ever did. The cost lands only on the narrow case it exists for —
  /// pressing during the first seconds after launch — and there a sixth of a
  /// second of extra latency buys the better engine for the whole session.
  ///
  /// Deliberately a poll rather than a continuation. `prepare` reports through
  /// `readyLocale`, and threading a waiter through it would mean owning
  /// cancellation and multiple-waiter cases for a path that runs once per launch
  /// and resolves in a few hundred milliseconds.
  @available(macOS 26.0, *)
  private func awaitAnalyzerReadiness() async {
    guard !analyzerReady, analyzerPreparing else { return }

    let started = Date().timeIntervalSinceReferenceDate
    let deadline = started + Self.analyzerReadyGraceSeconds
    while !analyzerReady, analyzerPreparing,
      Date().timeIntervalSinceReferenceDate < deadline
    {
      try? await Task.sleep(nanoseconds: 20_000_000)
    }

    let waited = Int((Date().timeIntervalSinceReferenceDate - started) * 1000)
    trace("analyzer.awaited", textLen: waited, note: "ready=\(analyzerReady)")
  }

  /// How long a press will wait for an in-flight `prepare` before giving up and
  /// taking the legacy engine.
  ///
  /// Longer than the 351 ms miss that motivated this, short enough that a press
  /// which does end up on the legacy engine has not visibly stalled. A `prepare`
  /// still running after this is downloading a model, not finishing one, and
  /// waiting on that would be a hang rather than a pause.
  private static let analyzerReadyGraceSeconds: TimeInterval = 0.6

  // MARK: - Permissions

  /// Dictation needs two separate grants: speech recognition and the mic.
  ///
  /// Reported rather than thrown: the renderer routes the user to the right
  /// System Settings pane, and a dead button with no explanation is the thing
  /// this avoids.
  private func authorize(then continuation: ((Bool) -> Void)? = nil) {
    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        self.emit(["type": "auth", "status": "speech_denied"])
        continuation?(false)
        return
      }
      AVCaptureDevice.requestAccess(for: .audio) { granted in
        self.emit(["type": "auth", "status": granted ? "granted" : "microphone_denied"])
        continuation?(granted)
      }
    }
  }

  // MARK: - Custom language model

  /// Build (once per vocabulary version) an on-device language model from the
  /// user's own sentences.
  ///
  /// Training is measured in seconds and the result is cached on disk, so the
  /// version string carries a hash of the phrase set - change the vocabulary
  /// and it retrains, otherwise it loads.
  private func prepareLanguageModel(phrases: [String], version: String) {
    guard !phrases.isEmpty else {
      emit(["type": "prepared", "ok": false])
      return
    }

    let identifier = "com.pandapdv.pandacode.dictation"
    let support = FileManager.default
      .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("PandaCodeDictation", isDirectory: true)
    let modelURL = support.appendingPathComponent("dictation-\(version).bin")

    Task {
      do {
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)

        if !FileManager.default.fileExists(atPath: modelURL.path) {
          // Drop stale versions so the directory does not accumulate models.
          let stale = (try? FileManager.default.contentsOfDirectory(
            at: support, includingPropertiesForKeys: nil)) ?? []
          for url in stale where url.lastPathComponent.hasPrefix("dictation-") {
            try? FileManager.default.removeItem(at: url)
          }

          let data = SFCustomLanguageModelData(
            locale: self.recognizer?.locale ?? Locale(identifier: Self.fallbackLocaleIdentifier),
            identifier: identifier,
            version: version
          ) {
            for phrase in phrases {
              SFCustomLanguageModelData.PhraseCount(phrase: phrase, count: 1)
            }
          }
          try await data.export(to: modelURL)
        }

        let configuration = SFSpeechLanguageModel.Configuration(languageModel: modelURL)
        try await SFSpeechLanguageModel.prepareCustomLanguageModel(
          for: modelURL, clientIdentifier: identifier, configuration: configuration)

        self.languageModel = configuration
        self.emit(["type": "prepared", "ok": true])
      } catch {
        // Non-fatal: dictation still runs with contextual strings only.
        self.trace("native.language_model_unavailable", note: error.localizedDescription)
        self.languageModel = nil
        self.emit(["type": "prepared", "ok": false])
      }
    }
  }

  // MARK: - Recognition

  private func start(
    contextualStrings: [String], locale: String?, onDevice: Bool, punctuation: Bool
  ) {
    // Ask first. Touching `audioEngine.inputNode` without the microphone grant
    // yields a silent stream that never produces a transcript, which reads as
    // "dictation is broken" rather than "dictation needs permission".
    authorize { granted in
      guard granted else { return }
      DispatchQueue.main.async {
        self.beginSession(
          contextualStrings: contextualStrings, locale: locale,
          onDevice: onDevice, punctuation: punctuation)
      }
    }
  }

  private func beginSession(
    contextualStrings: [String], locale: String?, onDevice: Bool, punctuation: Bool
  ) {
    // A locale change since `prepare` invalidates the custom language model:
    // it was exported for the old one and is rejected by the new recogniser.
    let previousLocale = recognizerLocaleIdentifier
    guard let recognizer = resolveRecognizer(for: locale), recognizer.isAvailable else {
      emit(["type": "error", "code": "unavailable", "message": "Speech recognition is unavailable."])
      return
    }

    if previousLocale != nil && previousLocale != recognizerLocaleIdentifier {
      languageModel = nil
    }

    // Starting twice would stack taps on the input node and crash.
    teardown()

    self.contextualStrings = Array(contextualStrings.prefix(Self.maxContextualStrings))
    self.addsPunctuation = punctuation
    self.preferOnDevice = onDevice
    self.barrenRotations = 0

    // The tap is installed once and feeds whichever request is current, so a
    // task rotation is invisible to the audio path - no gap, no dropped words.
    let input = audioEngine.inputNode
    // Always tap with the node's own format; a mismatch is a hard crash.
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0 else {
      emit(["type": "error", "code": "no_input", "message": "No microphone input is available."])
      return
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.request?.append(buffer)
    }

    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      teardown()
      emit(["type": "error", "code": "audio_engine", "message": error.localizedDescription])
      return
    }

    running = true
    emit(["type": "listening"])
    beginTask()
  }

  /// Open one recognition task over the already-running audio engine.
  private func beginTask() {
    guard let recognizer, running else { return }

    latestPartial = ""
    // Each task restarts the audio timeline its segments are stamped against.
    latestUtteranceStart = 0
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = addsPunctuation
    // Bias toward this user's project nouns. Truncated because an oversized
    // list measurably degrades general accuracy.
    request.contextualStrings = contextualStrings

    // A custom language model is only honoured on-device, so it forces the flag.
    if let languageModel {
      request.customizedLanguageModel = languageModel
      request.requiresOnDeviceRecognition = true
    } else {
      request.requiresOnDeviceRecognition = preferOnDevice && recognizer.supportsOnDeviceRecognition
    }
    self.request = request

    generation += 1
    let mine = generation
    trace(
      "native.task_start", gen: mine,
      note: "\(request.requiresOnDeviceRecognition ? "onDevice" : "server")"
        + " \(recognizerLocaleIdentifier ?? "?")")

    task = recognizer.recognitionTask(with: request) { [weak self] recognition, error in
      guard let self, mine == self.generation else { return }

      if let recognition {
        let text = recognition.bestTranscription.formattedString
        if recognition.isFinal {
          // End of an utterance - a pause, usually. Banked by the renderer and
          // never revised again. `segment` deliberately does not end the
          // session: only an explicit stop does, so a break mid-thought is safe.
          self.trace("native.final", gen: mine, textLen: text.count)
          self.rotate(banking: text.isEmpty ? self.latestPartial : text, clean: true)
        } else {
          let segments = recognition.bestTranscription.segments
          // Zero throughout in some on-device configurations, which is why this
          // is a capability check and not just a read of the first segment.
          let timestamped = segments.contains { $0.timestamp > 0 }
          let start = segments.first?.timestamp ?? 0

          if self.isUtteranceRestart(
            previous: self.latestPartial, next: text,
            previousStart: self.latestUtteranceStart, nextStart: start, timestamped: timestamped)
          {
            // Bank the old utterance before the new one overwrites it. This is
            // the only place it can be saved: no final is coming for it.
            //
            // Still unconditional, and still aimed the same way: NOT banking a
            // real restart erases text outright, which the user cannot recover.
            // But it is banked as *provisional* now, because this side cannot
            // tell a real restart from the recogniser re-transcribing the words
            // it just reported — both look like the transcription moving to a
            // later span of audio, and banking the second duplicated it (logged
            // as `banked=186 next=185 by=timestamp`). The renderer settles it:
            // it can see what the new utterance grows into, and revokes the bank
            // if the two turn out to describe the same speech.
            self.trace(
              "native.utterance_restart", gen: mine, textLen: self.latestPartial.count,
              note: "next=\(text.count) by=\(timestamped ? "timestamp" : "text")")
            self.emit(["type": "segment", "text": self.latestPartial, "provisional": true])
          }
          self.latestPartial = text
          self.latestUtteranceStart = start
          self.emit(["type": "partial", "text": text])
          self.trace("native.partial", gen: mine, textLen: text.count)
        }
        return
      }

      if let error {
        let ns = error as NSError
        self.trace(
          "native.error", gen: mine, textLen: self.latestPartial.count,
          note: "\(ns.domain):\(ns.code)")
        // A timed-out task reports an error rather than a clean final - the
        // ordinary end of a long utterance, not a failure. Bank the newest
        // partial: it holds everything said since the last final, and the next
        // task starts its transcript from zero, so discarding it here is
        // exactly the "it restarted and I lost what I said" bug.
        self.rotate(banking: self.latestPartial, clean: false)
      }
    }
  }

  /// Abandon the in-flight task and open a fresh one, discarding its transcript.
  ///
  /// Called when the renderer finds the composer text changed out from under
  /// dictation - a manual edit mid-utterance. The current task's transcript
  /// still narrates the pre-edit wording (partials are cumulative from the
  /// task's start), so it must not be banked or continued; only a fresh task
  /// gives the renderer a transcript relative to the new base.
  private func restartTask() {
    guard running else { return }
    rotate(banking: nil, clean: true)
  }

  /// End the current task and, if the user is still speaking, open the next one.
  private func rotate(banking text: String?, clean: Bool) {
    task = nil
    latestPartial = ""
    latestUtteranceStart = 0
    // `request` is deliberately left in place until `beginTask` replaces it:
    // the audio tap appends to whatever it points at, so nilling it here would
    // drop every buffer captured during the changeover - a clipped word at
    // each seam.

    trace("native.rotate", gen: generation, textLen: text?.count ?? 0, note: clean ? "clean" : "error")

    if let text, !text.isEmpty {
      barrenRotations = 0
      emit(["type": "segment", "text": text])
    } else if clean {
      // Silence. A pause is not a failure - the whole point of rotating is to
      // sit through one and keep listening.
      barrenRotations = 0
    } else {
      // Only a *rapid* run of empty errors means the recogniser is wedged.
      // Counting slow ones punished ordinary silence and tore the session down
      // mid-thought.
      let now = Date().timeIntervalSinceReferenceDate
      barrenRotations = (now - lastRotationAt) < 0.3 ? barrenRotations + 1 : 1
      lastRotationAt = now
    }

    guard running else { return }

    guard barrenRotations < 5 else {
      trace("native.wedged", gen: generation, note: "barren=\(barrenRotations)")
      emit(["type": "error", "code": "wedged", "message": "Speech recognition stopped responding."])
      teardown()
      return
    }

    beginTask()
  }

  /// Close the audio stream and let the recogniser flush a final transcript.
  private func stop() {
    // Clear first so the task ending below is not mistaken for a rotation.
    trace("native.stop_requested", gen: generation)
    guard running else {
      emit(["type": "final", "text": ""])
      return
    }
    running = false
    audioEngine.stop()
    audioEngine.inputNode.removeTap(onBus: 0)
    request?.endAudio()

    // The in-flight task still owes its last words; give it a moment to flush
    // before tearing the session down, then close the stream either way.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
      guard let self else { return }
      self.emit(["type": "final", "text": ""])
      self.teardown()
    }
  }

  /// Abandon the utterance without emitting a final transcript.
  private func cancel() {
    teardown()
    emit(["type": "cancelled"])
  }

  private func teardown() {
    trace("native.teardown", gen: generation)
    running = false
    task?.cancel()
    task = nil
    request = nil
    if audioEngine.isRunning { audioEngine.stop() }
    audioEngine.inputNode.removeTap(onBus: 0)
  }

  // MARK: - Wire

  /// Diagnostics. Carries counts and task generations only - never transcript
  /// text - so it is safe to log.
  private func trace(_ event: String, gen: Int? = nil, textLen: Int? = nil, note: String? = nil) {
    var payload: [String: Any] = ["type": "trace", "event": event]
    if let gen { payload["gen"] = gen }
    if let textLen { payload["textLen"] = textLen }
    if let note { payload["note"] = note }
    emit(payload)
  }

  private let out = FileHandle.standardOutput
  private let outLock = NSLock()

  private func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    outLock.lock()
    defer { outLock.unlock() }
    out.write(data)
    out.write(Data([0x0A]))
  }
}

// MARK: - stdin pump

let helper = DictationHelper()

/// Commands arrive as one JSON object per line. Reading on a background thread
/// keeps the main run loop free for the audio engine and recognition callbacks,
/// which is where every `SFSpeechRecognizer` callback expects to land.
DispatchQueue.global(qos: .userInitiated).async {
  var buffer = Data()
  while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty {
      // Parent closed the pipe. Releasing the microphone matters more than a
      // tidy exit — leaving it held would show the orange dot forever.
      DispatchQueue.main.async { helper.handle(["cmd": "quit"]) }
      return
    }
    buffer.append(chunk)
    while let newline = buffer.firstIndex(of: 0x0A) {
      let line = buffer.subdata(in: buffer.startIndex..<newline)
      buffer = buffer.subdata(in: buffer.index(after: newline)..<buffer.endIndex)
      guard
        !line.isEmpty,
        let parsed = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
      else { continue }
      DispatchQueue.main.async { helper.handle(parsed) }
    }
  }
}

RunLoop.main.run()
