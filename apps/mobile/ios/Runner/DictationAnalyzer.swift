import AVFoundation
import Foundation
import Speech

/// Dictation on Apple's `SpeechAnalyzer` stack (iOS 26+).
///
/// This is not a refactor of `DictationPlugin` — it is a different speech model.
/// `SFSpeechRecognizer`'s on-device path runs a small model that Apple keeps for
/// compatibility; `SpeechTranscriber` runs the one the system dictation and Notes
/// transcription use, and it is markedly better on exactly what this composer
/// gets wrong: technical nouns, acronyms, and long unpunctuated thinking-aloud.
///
/// Three structural problems in the older path simply do not exist here, which
/// is why this file is so much shorter than `Dictation.swift`:
///
///   - **No one-minute task cap.** `SpeechAnalyzer` streams for as long as audio
///     is fed to it, so there is no rotation, no banking a partial across the
///     seam, and no wedged-recogniser watchdog.
///   - **No utterance restarts.** Results arrive as an append-only sequence of
///     finalized ranges plus one volatile tail. A pause cannot silently reset
///     the transcript to zero the way `bestTranscription.formattedString` did.
///   - **No server fallback to weigh.** It is on-device by construction, so
///     biasing the vocabulary costs nothing in general accuracy — unlike
///     `customizedLanguageModel`, which bought bias by forcing the weaker model.
///
/// The trade is that there is no `SFSpeechLanguageModel` equivalent: bias is
/// `contextualStrings` only. Given the above, that is a good trade.
///
/// Emits the same event vocabulary as `DictationPlugin` (`partial`, `segment`,
/// `final`, `error`, `trace`) so the Dart side is unchanged.
@available(iOS 26.0, *)
final class DictationAnalyzer {
  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
  }

  private let emit: ([String: Any]) -> Void

  /// Same reasoning as the legacy path: this is a bias list, not a dictionary,
  /// and flooding it measurably degrades general accuracy.
  private static let maxContextualStrings = 100

  private let audioEngine = AVAudioEngine()

  private var analyzer: SpeechAnalyzer?
  private var transcriber: SpeechTranscriber?
  private var resultsTask: Task<Void, Never>?

  /// Where the audio tap delivers converted buffers. Read from the audio
  /// thread, replaced on the main thread while the tap is installed — the same
  /// arrangement the legacy path uses for its request, and for the same reason:
  /// swapping the sink rather than the tap means no buffer is dropped at a seam.
  private var continuation: AsyncStream<AnalyzerInput>.Continuation?

  /// Format the analyzer wants, and the converter from the mic's format to it.
  /// The mic node's format is not negotiable — tapping with anything else is a
  /// hard crash — so the conversion happens in the tap.
  private var analyzerFormat: AVAudioFormat?
  private var converter: AVAudioConverter?

  private var running = false

  /// Identifies the current analyzer. `restart` throws one away mid-session and
  /// its results task may still deliver; anything from a previous generation is
  /// dropped rather than appended to a transcript it no longer describes.
  private var generation = 0

  /// Locale whose model is installed and reserved, if any.
  private(set) var readyLocale: Locale?

  var isReady: Bool { readyLocale != nil }

  // MARK: - Availability

  /// The locale `identifier` maps to, or nil if this device cannot transcribe it.
  ///
  /// Apple matches loosely (`en-GB` may resolve to a broader English), so the
  /// resolved locale is what everything downstream must use.
  static func supportedLocale(for identifier: String?) async -> Locale? {
    guard SpeechTranscriber.isAvailable else { return nil }
    let wanted = identifier?.trimmingCharacters(in: .whitespaces)
    let requested = (wanted?.isEmpty == false) ? wanted! : "en-US"
    return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: requested))
  }

  /// Ensure the locale's model is on the device.
  ///
  /// The first call for a language downloads a few hundred megabytes, so this is
  /// driven from the Dart side's idle `prepare()` rather than from the first tap
  /// of the microphone. Returns false for any failure, which is not fatal: the
  /// caller falls back to the `SFSpeechRecognizer` path.
  func prepare(locale identifier: String?) async -> Bool {
    guard let locale = await Self.supportedLocale(for: identifier) else { return false }
    if readyLocale == locale { return true }

    let probe = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    if await AssetInventory.status(forModules: [probe]) != .installed {
      do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
          trace("analyzer.download", note: locale.identifier(.bcp47))
          try await request.downloadAndInstall()
        }
      } catch {
        NSLog("[dictation] analyzer assets unavailable: \(error.localizedDescription)")
        return false
      }
    }

    // Reserving tells iOS not to evict this model to reclaim space. There is a
    // small cap on reservations; releasing the previous one keeps us inside it
    // when the user switches dictation language.
    if let previous = readyLocale, previous != locale {
      _ = await AssetInventory.release(reservedLocale: previous)
    }
    _ = try? await AssetInventory.reserve(locale: locale)

    readyLocale = locale
    trace("analyzer.ready", note: locale.identifier(.bcp47))
    return true
  }

  // MARK: - Session

  /// Begin listening. Throws if the audio path cannot be set up, in which case
  /// nothing is left running and the caller may fall back to the legacy engine.
  func start(contextualStrings: [String], locale identifier: String?) async throws {
    guard await prepare(locale: identifier), let locale = readyLocale else {
      throw DictationAnalyzerError.unavailable
    }

    teardown()

    let session = AVAudioSession.sharedInstance()
    // `.measurement` leaves the signal unprocessed. Unlike the legacy path this
    // model was trained on raw captured speech, so the system's AGC and noise
    // suppression would be working against it rather than for it.
    try session.setCategory(.record, mode: .measurement, options: .duckOthers)
    try session.setActive(true, options: .notifyOthersOnDeactivation)

    let terms = Array(contextualStrings.prefix(Self.maxContextualStrings))
    try await openAnalyzer(locale: locale, contextualStrings: terms)

    let input = audioEngine.inputNode
    // Always tap with the node's own format; a mismatch is a hard crash. The
    // analyzer's preferred format is reached by converting inside the tap.
    let inputFormat = input.outputFormat(forBus: 0)
    if let analyzerFormat, analyzerFormat != inputFormat {
      converter = AVAudioConverter(from: inputFormat, to: analyzerFormat)
      // A converter that resamples buffers internally must not carry state from
      // a previous session, or the first buffers decode as a click.
      converter?.reset()
    } else {
      converter = nil
    }

    // 1024 frames, matching the legacy path: at 48 kHz that is ~21 ms of audio
    // per buffer against ~85 ms for 4096, and every one of those milliseconds is
    // spent before the model has seen the speech at all. A larger buffer is the
    // reflex for a streaming consumer and it is the wrong reflex here.
    input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
      guard let self, let converted = self.convert(buffer) else { return }
      self.continuation?.yield(AnalyzerInput(buffer: converted))
    }

    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      teardown()
      throw error
    }

    running = true
  }

  /// Build a transcriber, an analyzer and the audio stream that feeds it.
  ///
  /// Split out because `restart` does exactly this again, over the still-running
  /// audio engine.
  private func openAnalyzer(locale: Locale, contextualStrings: [String]) async throws {
    generation += 1
    let mine = generation

    let transcriber = SpeechTranscriber(
      locale: locale,
      // `.etiquetteReplacements` is profanity masking. Left off deliberately —
      // this composer dictates prompts, and a masked word is a wrong word.
      transcriptionOptions: [],
      // Volatile results are the live guess the composer shows while speaking.
      // `.fastResults` asks for them sooner: this model is doing more work per
      // utterance than the old recogniser — the punctuation and the disfluency
      // cleanup are that work — and without this the extra latency is plainly
      // felt while dictating.
      reportingOptions: [.volatileResults, .fastResults],
      attributeOptions: [])
    self.transcriber = transcriber

    let context = AnalysisContext()
    context.contextualStrings = [.general: contextualStrings]

    let analyzer = SpeechAnalyzer(
      modules: [transcriber],
      options: SpeechAnalyzer.Options(
        priority: .userInitiated,
        // Keep the model resident between utterances. Loading it is what made
        // the first word of a push-to-talk burst go missing.
        modelRetention: .lingering))
    try await analyzer.setContext(context)
    self.analyzer = analyzer

    analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    try await analyzer.prepareToAnalyze(in: analyzerFormat)

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    self.continuation = continuation
    try await analyzer.start(inputSequence: stream)

    resultsTask = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          guard let self, mine == self.generation else { return }
          self.deliver(String(result.text.characters), isFinal: result.isFinal, generation: mine)
        }
      } catch {
        guard let self, mine == self.generation else { return }
        self.trace("analyzer.results_error", gen: mine, note: error.localizedDescription)
        self.emit(["type": "error", "message": "Speech recognition stopped responding."])
        self.teardown()
      }
    }

    trace("analyzer.open", gen: mine, note: locale.identifier(.bcp47))
  }

  /// Route one result to the Dart side.
  ///
  /// Finalized results are append-only and never revised, so they map onto the
  /// `segment` the composer banks. The volatile result is the tail that has not
  /// settled yet and covers only what came *after* the last finalized range —
  /// exactly the composer's churning `_partial`.
  private func deliver(_ text: String, isFinal: Bool, generation mine: Int) {
    if isFinal {
      guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
      trace("analyzer.segment", gen: mine, textLen: text.count)
      emit(["type": "segment", "text": text])
    } else {
      trace("analyzer.partial", gen: mine, textLen: text.count)
      emit(["type": "partial", "text": text])
    }
  }

  /// Resample the mic's buffer into the format the analyzer asked for.
  private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let converter, let target = analyzerFormat else { return buffer }

    let ratio = target.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1024
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
      return nil
    }

    var supplied = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      if supplied {
        // One input buffer per call. Asking for more would block the audio
        // thread waiting on a microphone that has not produced it yet.
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }

    if error != nil || output.frameLength == 0 { return nil }
    return output
  }

  /// Throw away the in-flight transcript and start a fresh analyzer, without
  /// ending the session.
  ///
  /// Called when the composer text changed out from under dictation. The
  /// volatile tail still narrates the pre-edit wording and would eventually
  /// finalize into a segment, restating what the user just corrected. Finalized
  /// segments already banked are the user's problem to keep — the Dart side
  /// rebases on the edited text, so only the unsettled tail must be dropped.
  ///
  /// The audio engine and its tap stay up across this; only the sink changes.
  func restart(contextualStrings: [String]) {
    guard running, let locale = readyLocale else { return }
    trace("analyzer.restart", gen: generation)

    let stale = analyzer
    continuation?.finish()
    continuation = nil
    resultsTask?.cancel()
    resultsTask = nil

    Task { [weak self] in
      await stale?.cancelAndFinishNow()
      guard let self, self.running else { return }
      let terms = Array(contextualStrings.prefix(Self.maxContextualStrings))
      do {
        try await self.openAnalyzer(locale: locale, contextualStrings: terms)
      } catch {
        self.trace("analyzer.restart_failed", note: error.localizedDescription)
        self.emit(["type": "error", "message": "Speech recognition stopped responding."])
        self.teardown()
      }
    }
  }

  /// Stop listening and let the analyzer finalize what it has heard.
  ///
  /// Unlike the legacy path this does not need a fixed grace period: closing the
  /// input stream and awaiting `finalizeAndFinishThroughEndOfInput` is a real
  /// signal that every last word has been emitted.
  func stop() {
    guard running else {
      emit(["type": "final", "text": ""])
      return
    }
    trace("analyzer.stop_requested", gen: generation)
    running = false

    audioEngine.stop()
    audioEngine.inputNode.removeTap(onBus: 0)
    continuation?.finish()
    continuation = nil

    let closing = analyzer
    Task { [weak self] in
      try? await closing?.finalizeAndFinishThroughEndOfInput()
      guard let self else { return }
      self.emit(["type": "final", "text": ""])
      self.teardown()
    }
  }

  /// Abandon the utterance; no final transcript is emitted.
  func cancel() {
    teardown()
  }

  func teardown() {
    trace("analyzer.teardown", gen: generation)
    running = false
    generation += 1

    resultsTask?.cancel()
    resultsTask = nil
    continuation?.finish()
    continuation = nil

    let stale = analyzer
    analyzer = nil
    transcriber = nil
    converter = nil
    Task { await stale?.cancelAndFinishNow() }

    if audioEngine.isRunning { audioEngine.stop() }
    audioEngine.inputNode.removeTap(onBus: 0)
    try? AVAudioSession.sharedInstance().setActive(
      false, options: .notifyOthersOnDeactivation)
  }

  /// Diagnostics. Counts and generations only — never transcript text — so it
  /// can cross the relay without breaking the E2E rule.
  private func trace(_ event: String, gen: Int? = nil, textLen: Int? = nil, note: String? = nil) {
    var payload: [String: Any] = ["type": "trace", "event": event]
    if let gen { payload["gen"] = gen }
    if let textLen { payload["textLen"] = textLen }
    if let note { payload["note"] = note }
    emit(payload)
  }
}

enum DictationAnalyzerError: Error {
  case unavailable
}
