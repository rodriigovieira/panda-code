import AVFoundation
import Flutter
import Foundation
import Speech

/// On-device dictation for the composer.
///
/// This is the same Apple speech stack the keyboard's microphone key drives,
/// but reached directly so we can bias it toward the vocabulary this user
/// actually types. Three knobs the keyboard does not expose:
///
///   - `contextualStrings`: a short bias list of project nouns.
///   - `customizedLanguageModel`: an iOS 17 custom language model trained from
///     the user's own phrasing, which goes well beyond a bias list.
///   - `requiresOnDeviceRecognition`: keeps audio on the device and removes
///     Apple's roughly one-minute server-side session cap.
///
/// The vocabulary is mined locally by
/// `apps/mobile/scripts/mine_dictation_vocabulary.py`; nothing is uploaded.
///
/// On iOS 26 this is the *fallback*. `DictationAnalyzer` runs the newer
/// `SpeechAnalyzer` model there, which is a straight accuracy win on this
/// composer's vocabulary; everything below is what iOS 17-25 still gets, and it
/// stays as-is because most of it exists to work around `SFSpeechRecognizer`
/// behaviour that only that API has.
final class DictationPlugin: NSObject {
  private static let methodChannelName = "panda_code/dictation"
  private static let eventChannelName = "panda_code/dictation/events"

  /// Apple degrades when `contextualStrings` is flooded - it is a bias list,
  /// not a dictionary. The miner already ranks terms, so we take the head.
  private static let maxContextualStrings = 100

  /// Locale dictation falls back to when nothing else resolves.
  ///
  /// Deliberately *not* `Locale.current`. The recogniser picks its acoustic and
  /// language model from this, and a phone set to pt-BR will decode English
  /// speech through a Portuguese model - the failure mode is not a mangled
  /// project noun but whole clauses replaced by unrelated words, and no
  /// `contextualStrings` bias can reach across it. Most of this team speaks
  /// English tech vocabulary into phones that are not set to English, so the
  /// dictation language is its own setting rather than a consequence of the
  /// system one.
  private static let fallbackLocaleIdentifier = "en-US"

  private var recognizer: SFSpeechRecognizer?
  /// Identifier the current `recognizer` was actually built for - which may not
  /// be the one requested, if that locale has no recogniser on this device.
  private var recognizerLocaleIdentifier: String?

  /// The iOS 26 engine, once its model is installed for the chosen language.
  /// Untyped because the class is `@available(iOS 26.0, *)` and a stored
  /// property cannot be.
  private var analyzerStorage: AnyObject?

  /// Terms of the current session, kept so a `restart` can rebuild the analyzer
  /// with the same bias list.
  private var analyzerTerms: [String] = []

  @available(iOS 26.0, *)
  private var analyzer: DictationAnalyzer {
    if let existing = analyzerStorage as? DictationAnalyzer { return existing }
    let created = DictationAnalyzer(emit: { [weak self] payload in self?.emit(payload) })
    analyzerStorage = created
    return created
  }

  /// Is the analyzer engine installed and serving this session?
  private var analyzerActive: Bool {
    guard #available(iOS 26.0, *) else { return false }
    return (analyzerStorage as? DictationAnalyzer)?.isReady == true
  }

  private let audioEngine = AVAudioEngine()

  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var events: FlutterEventSink?

  /// True from `start` until the user stops. iOS ends a recognition task on its
  /// own after roughly a minute; while this is set, that ends only the *task*,
  /// not the session - a fresh task is opened over the same, still-running
  /// audio engine. Rotating here rather than in Dart is deliberate: restarting
  /// from Dart tore down the audio session and re-subscribed the event channel
  /// each time, and the old subscription's cancel raced the new one's sink.
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

  /// Did the recogniser start a new utterance inside the same task?
  ///
  /// `bestTranscription.formattedString` is NOT cumulative for the life of a
  /// task. After a pause, iOS begins a fresh utterance and the string restarts
  /// from zero, dropping everything before it — with no `isFinal` and no error,
  /// so nothing in the rotation path ever fires. Telemetry caught it directly:
  /// a 140-character partial replaced by a 9-character one, same generation,
  /// nothing in between. Detecting it here is what stops a pause mid-sentence
  /// erasing the sentence.
  ///
  /// Decided from the audio timeline where the recogniser provides one, and only
  /// from the text where it does not.
  ///
  /// The text-only rule this replaces got it wrong in both directions, and both
  /// are visible to the user: a miss erases what they said, a false alarm banks
  /// the old text and then appends the new, duplicating it. The specific miss it
  /// shipped with was `!previous.hasPrefix(next)` — a new utterance that happens
  /// to open with the same characters as the old one ("So…") reads as a
  /// shortening revision, so nothing is banked. Desktop telemetry caught it
  /// erasing 45 characters, and the two strings alone cannot tell the cases
  /// apart.
  ///
  /// Segment timestamps can. A revision re-reports the same span of audio and
  /// keeps its first segment's timestamp; a new utterance begins after the pause
  /// that ended the last one, so its first segment starts materially later.
  ///
  /// **Known gap — this over-corrects into duplication, and on this platform it
  /// is still unfixed.** Returning true only says the transcription moved to a
  /// later span of audio. Banking is right *only if the new utterance covers
  /// different speech*; when the recogniser re-transcribes words it already
  /// reported, banking the old copy and then appending the new one puts both in
  /// the composer. Observed on desktop, which ran the same logic: `banked=186
  /// next=185 by=timestamp`, two near-identical halves in the field. Near-equal
  /// lengths across a "restart" are the signature.
  ///
  /// **Desktop has since fixed it and this has not — the platforms are now
  /// knowingly out of step.** The detection here is deliberately unchanged,
  /// because the fix is not in the detection: desktop's helper now tags the bank
  /// it emits as `provisional`, and `DictationTranscript` drops it once the
  /// following partial shows the two describe the same speech
  /// (`apps/desktop/src/shared/dictation.ts`). Porting it means the same two
  /// steps here: emit the flag from the `segment` below, and teach the Dart
  /// transcript assembly to hold a provisional bank and revoke it. Until both
  /// land, the phone still duplicates.
  ///
  /// Otherwise kept in step with the desktop helper's copy on purpose — the two
  /// diverging silently is how one platform ends up with a fix the other lacks.
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

  /// Build (or reuse) the recogniser for `identifier`.
  ///
  /// Falls back rather than failing: a locale with no recogniser installed on
  /// this device drops to en-US, and only then to whatever the system is set
  /// to. Returning nil means the device has no speech recognition at all.
  @discardableResult
  private func resolveRecognizer(for identifier: String?) -> SFSpeechRecognizer? {
    let wanted = identifier?.trimmingCharacters(in: .whitespaces)
    let requested = (wanted?.isEmpty == false ? wanted! : Self.fallbackLocaleIdentifier)
    if requested == recognizerLocaleIdentifier, recognizer != nil { return recognizer }

    let candidates = [requested, Self.fallbackLocaleIdentifier, Locale.current.identifier]
    for candidate in candidates {
      guard let built = SFSpeechRecognizer(locale: Locale(identifier: candidate)) else {
        continue
      }
      recognizer = built
      recognizerLocaleIdentifier = candidate
      if candidate != requested {
        NSLog("[dictation] no recogniser for \(requested); using \(candidate)")
      }
      return built
    }

    recognizer = nil
    recognizerLocaleIdentifier = nil
    return nil
  }

  static func register(with registrar: FlutterPluginRegistrar) {
    let plugin = DictationPlugin()
    let methods = FlutterMethodChannel(
      name: methodChannelName, binaryMessenger: registrar.messenger())
    methods.setMethodCallHandler { call, result in
      plugin.handle(call, result: result)
    }
    FlutterEventChannel(name: eventChannelName, binaryMessenger: registrar.messenger())
      .setStreamHandler(plugin)
  }

  // MARK: - Method dispatch

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "authorize":
      authorize(result: result)
    case "prepare":
      let args = call.arguments as? [String: Any] ?? [:]
      let phrases = args["phrases"] as? [String] ?? []
      let version = args["version"] as? String ?? "1"
      let locale = args["locale"] as? String

      // Prefer the iOS 26 engine. Its first call for a language downloads the
      // model, which is why this runs from Dart's idle prepare rather than from
      // the first tap. Only if it cannot be had do we train the custom language
      // model the older recogniser needs.
      if #available(iOS 26.0, *) {
        Task { @MainActor in
          if await self.analyzer.prepare(locale: locale) {
            result(true)
          } else {
            self.analyzerStorage = nil
            self.resolveRecognizer(for: locale)
            self.prepareLanguageModel(phrases: phrases, version: version, result: result)
          }
        }
      } else {
        resolveRecognizer(for: locale)
        prepareLanguageModel(phrases: phrases, version: version, result: result)
      }
    case "start":
      let args = call.arguments as? [String: Any] ?? [:]
      let terms = args["contextualStrings"] as? [String] ?? []
      let locale = args["locale"] as? String
      let onDevice = args["onDevice"] as? Bool ?? true
      let punctuation = args["punctuation"] as? Bool ?? true

      if #available(iOS 26.0, *), analyzerActive {
        analyzerTerms = terms
        Task { @MainActor in
          do {
            try await self.analyzer.start(contextualStrings: terms, locale: locale)
            result(nil)
          } catch {
            // The analyzer tears itself down on any failure, so the microphone
            // is free and the legacy engine can take the session instead of the
            // user seeing a dead button.
            NSLog("[dictation] analyzer start failed: \(error.localizedDescription)")
            self.analyzerStorage = nil
            self.start(
              contextualStrings: terms, locale: locale, onDevice: onDevice,
              punctuation: punctuation, result: result)
          }
        }
      } else {
        start(
          contextualStrings: terms, locale: locale, onDevice: onDevice,
          punctuation: punctuation, result: result)
      }
    case "stop":
      if #available(iOS 26.0, *), analyzerActive {
        analyzer.stop()
        result(nil)
      } else {
        stop(result: result)
      }
    case "cancel":
      if #available(iOS 26.0, *), analyzerActive {
        analyzer.cancel()
        result(nil)
      } else {
        cancel(result: result)
      }
    case "restart":
      if #available(iOS 26.0, *), analyzerActive {
        analyzer.restart(contextualStrings: analyzerTerms)
        result(nil)
      } else {
        restart(result: result)
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  // MARK: - Permissions

  /// Dictation needs two separate grants: speech recognition and the mic.
  ///
  /// `requestAuthorization`/`requestRecordPermission` are the right calls the
  /// first time, but both still round-trip to a system daemon even once the
  /// user has already decided — on the order of a second, right on the tap
  /// that is supposed to start recording *now*. Every grant already has a
  /// synchronous status read; once that says granted there is nothing left to
  /// ask, so skip straight to it.
  private func authorize(result: @escaping FlutterResult) {
    if SFSpeechRecognizer.authorizationStatus() == .authorized,
      AVAudioApplication.shared.recordPermission == .granted
    {
      result("granted")
      return
    }

    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        DispatchQueue.main.async { result("speech_denied") }
        return
      }
      AVAudioApplication.requestRecordPermission { granted in
        DispatchQueue.main.async { result(granted ? "granted" : "microphone_denied") }
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
  private func prepareLanguageModel(
    phrases: [String], version: String, result: @escaping FlutterResult
  ) {
    guard !phrases.isEmpty else {
      result(false)
      return
    }

    let identifier = "com.pandapdv.pandacode.dictation"
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let modelURL = support.appendingPathComponent("dictation-\(version).bin")

    Task {
      do {
        try FileManager.default.createDirectory(
          at: support, withIntermediateDirectories: true)

        if !FileManager.default.fileExists(atPath: modelURL.path) {
          // Drop stale versions so the container does not accumulate models.
          let stale = (try? FileManager.default.contentsOfDirectory(
            at: support, includingPropertiesForKeys: nil)) ?? []
          for url in stale where url.lastPathComponent.hasPrefix("dictation-") {
            try? FileManager.default.removeItem(at: url)
          }

          let data = SFCustomLanguageModelData(
            locale: self.recognizer?.locale ?? Locale(identifier: "en-US"),
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
        DispatchQueue.main.async { result(true) }
      } catch {
        // Non-fatal: dictation still runs with contextual strings only.
        NSLog("[dictation] custom language model unavailable: \(error.localizedDescription)")
        self.languageModel = nil
        DispatchQueue.main.async { result(false) }
      }
    }
  }

  // MARK: - Recognition

  private func start(
    contextualStrings: [String], locale: String?, onDevice: Bool, punctuation: Bool,
    result: @escaping FlutterResult
  ) {
    // A locale change since `prepare` invalidates the custom language model:
    // it was exported for the old one and is rejected by the new recogniser.
    let previousLocale = recognizerLocaleIdentifier
    guard let recognizer = resolveRecognizer(for: locale), recognizer.isAvailable else {
      result(FlutterError(
        code: "unavailable", message: "Speech recognition is unavailable.", details: nil))
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

    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: .duckOthers)
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      result(FlutterError(
        code: "audio_session", message: error.localizedDescription, details: nil))
      return
    }

    // The tap is installed once and feeds whichever request is current, so a
    // task rotation is invisible to the audio path - no gap, no dropped words.
    let input = audioEngine.inputNode
    // Always tap with the node's own format; a mismatch is a hard crash.
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.request?.append(buffer)
    }

    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      teardown()
      result(FlutterError(
        code: "audio_engine", message: error.localizedDescription, details: nil))
      return
    }

    running = true
    beginTask()
    result(nil)
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
      request.requiresOnDeviceRecognition =
        preferOnDevice && recognizer.supportsOnDeviceRecognition
    }
    self.request = request

    generation += 1
    let mine = generation
    trace("native.task_start", gen: mine,
          note: "\(request.requiresOnDeviceRecognition ? "onDevice" : "server")"
            + " \(recognizerLocaleIdentifier ?? "?")")

    task = recognizer.recognitionTask(with: request) { [weak self] recognition, error in
      guard let self, mine == self.generation else { return }

      if let recognition {
        let text = recognition.bestTranscription.formattedString
        if recognition.isFinal {
          // End of an utterance - a pause, usually. Banked by Dart and never
          // revised again. `segment` deliberately does not end the session:
          // only an explicit stop does, so a break mid-thought is safe.
          self.trace("native.final", gen: mine, textLen: text.count)
          self.rotate(banking: text.isEmpty ? self.latestPartial : text,
                      clean: true)
        } else {
          let segments = recognition.bestTranscription.segments
          // Zero throughout in some on-device configurations, which is why this
          // is a capability check and not just a read of the first segment.
          let timestamped = segments.contains { $0.timestamp > 0 }
          let start = segments.first?.timestamp ?? 0

          if self.isUtteranceRestart(
            previous: self.latestPartial, next: text,
            previousStart: self.latestUtteranceStart, nextStart: start,
            timestamped: timestamped)
          {
            // Bank the old utterance before the new one overwrites it. This is
            // the only place it can be saved: no final is coming for it.
            //
            // Unconditional on purpose: banking a false restart duplicates the
            // text, not banking a real one erases it, and the user can delete a
            // duplicate but cannot recover an erasure.
            self.trace("native.utterance_restart", gen: mine,
                       textLen: self.latestPartial.count,
                       note: "next=\(text.count) by=\(timestamped ? "timestamp" : "text")")
            self.emit(["type": "segment", "text": self.latestPartial])
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
        self.trace("native.error", gen: mine, textLen: self.latestPartial.count,
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
  /// Called when the Dart side finds the composer text changed out from under
  /// dictation - a manual edit mid-utterance. The current task's transcript
  /// still narrates the pre-edit wording (SFSpeechRecognizer partials are
  /// cumulative from the task's start), so it must not be banked or continued;
  /// only a fresh task gives Dart a transcript relative to the new base.
  private func restart(result: @escaping FlutterResult) {
    guard running else {
      result(nil)
      return
    }
    rotate(banking: nil, clean: true)
    result(nil)
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

    trace("native.rotate", gen: generation, textLen: text?.count ?? 0,
          note: clean ? "clean" : "error")

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
      emit(["type": "error", "message": "Speech recognition stopped responding."])
      teardown()
      return
    }

    beginTask()
  }

  /// Close the audio stream and let the recogniser flush a final transcript.
  private func stop(result: @escaping FlutterResult) {
    // Clear first so the task ending below is not mistaken for a rotation.
    trace("native.stop_requested", gen: generation)
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
    result(nil)
  }

  /// Abandon the utterance without emitting a final transcript.
  private func cancel(result: @escaping FlutterResult) {
    teardown()
    result(nil)
  }

  private func teardown() {
    trace("native.teardown", gen: generation)
    running = false
    task?.cancel()
    task = nil
    request = nil
    if audioEngine.isRunning { audioEngine.stop() }
    audioEngine.inputNode.removeTap(onBus: 0)
    try? AVAudioSession.sharedInstance().setActive(
      false, options: .notifyOthersOnDeactivation)
  }

  /// Diagnostics. Carries counts and task generations only - never transcript
  /// text - so it can cross the relay without breaking the E2E rule.
  private func trace(_ event: String, gen: Int? = nil, textLen: Int? = nil, note: String? = nil) {
    var payload: [String: Any] = ["type": "trace", "event": event]
    if let gen { payload["gen"] = gen }
    if let textLen { payload["textLen"] = textLen }
    if let note { payload["note"] = note }
    emit(payload)
  }

  private func emit(_ payload: [String: Any]) {
    DispatchQueue.main.async { self.events?(payload) }
  }
}

// MARK: - Event stream

extension DictationPlugin: FlutterStreamHandler {
  func onListen(
    withArguments arguments: Any?, eventSink: @escaping FlutterEventSink
  ) -> FlutterError? {
    events = eventSink
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    events = nil
    return nil
  }
}
