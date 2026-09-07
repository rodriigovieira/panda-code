import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import 'dictation_service.dart';

/// Composer microphone.
///
/// Tap to dictate, tap again to finish. Partial transcripts land in the
/// composer live, so the text grows as you speak rather than appearing in one
/// lump at the end. Whatever was already typed is preserved — dictation appends.
class DictationButton extends ConsumerStatefulWidget {
  const DictationButton({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.enabled,
    required this.onNotice,
    required this.onListeningChanged,
  });

  final TextEditingController controller;

  /// The composer field's focus. Handed back after a tap so the keyboard stays
  /// up — you can dictate a sentence, then fix a word by hand without the
  /// keyboard having to be summoned again.
  final FocusNode focusNode;

  final bool enabled;

  /// Surfaces permission problems through the screen's existing snack bar.
  final void Function(String message, {bool isError}) onNotice;

  /// Lets the composer grow while the mic is live.
  final void Function(bool listening) onListeningChanged;

  @override
  ConsumerState<DictationButton> createState() => DictationButtonState();
}

class DictationButtonState extends ConsumerState<DictationButton>
    with TickerProviderStateMixin {
  StreamSubscription<DictationResult>? _subscription;
  bool _listening = false;

  /// Bounce feedback on every tap — start, stop, whichever — so the button
  /// visibly reacts before the mic session has actually come up or torn down.
  late final AnimationController _tapController = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 260),
  );
  late final Animation<double> _tapScale = TweenSequence<double>([
    TweenSequenceItem(
      weight: 35,
      tween: Tween(begin: 1.0, end: 0.8).chain(CurveTween(curve: Curves.easeOut)),
    ),
    TweenSequenceItem(
      weight: 65,
      tween:
          Tween(begin: 0.8, end: 1.0).chain(CurveTween(curve: Curves.easeOutBack)),
    ),
  ]).animate(_tapController);

  /// Sonar-style ring while live, so "recording" reads at a glance even
  /// before any text has appeared.
  late final AnimationController _pulseController = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );
  late final Animation<double> _pulse =
      CurvedAnimation(parent: _pulseController, curve: Curves.easeOut);

  /// The composer is rebuilt as `_base + _committed + _partial` on every
  /// update. Splitting it into three parts is what makes dictation survive a
  /// restart.
  ///
  /// iOS ends a recognition task on its own after roughly a minute, and each
  /// task numbers its transcript from zero. Treating the recogniser's string as
  /// the whole truth means that reset wipes everything said so far — the text
  /// visibly guts itself mid-sentence. So we bank finalised words ourselves and
  /// let only the in-flight guess churn.

  /// Composer text from before dictation started. Never touched.
  String _base = '';

  /// Words the recogniser has finalised. Append-only for the whole session,
  /// across any number of internal restarts.
  String _committed = '';

  /// The current guess. Rewritten freely — the recogniser revises earlier words
  /// as it hears more, and that is fine as long as it can only revise this part.
  String _partial = '';

  /// What we last wrote to the controller, so a manual edit can be told apart
  /// from our own write and preserved instead of clobbered.
  String _lastWritten = '';

  /// Resolved once. `ref` is unusable from `dispose`, and that is exactly when
  /// the microphone most needs releasing — leaving this session mid-utterance.
  late final DictationService _service;

  @override
  void initState() {
    super.initState();
    _service = ref.read(dictationServiceProvider);
    // Training the custom language model takes a few seconds the first time a
    // vocabulary version is seen. Do it now so the first tap is instant.
    unawaited(_service.prepare());
  }

  @override
  void dispose() {
    _subscription?.cancel();
    // The service outlives this widget, so make sure the mic is released.
    unawaited(_service.cancel());
    _tapController.dispose();
    _pulseController.dispose();
    super.dispose();
  }

  /// Every start/stop rides through here so the tap bounce, the haptic and
  /// the pulse ring all stay in lockstep with `_listening` regardless of
  /// which caller flipped it (a tap, or the stream simply ending).
  void _setListening(bool value) {
    HapticFeedback.mediumImpact();
    _tapController.forward(from: 0);
    if (value) {
      _pulseController.repeat();
    } else {
      _pulseController.stop();
      _pulseController.reset();
    }
    setState(() => _listening = value);
  }

  void _start() {
    _base = widget.controller.text;
    // Record before the trailing space is added below: `_lastWritten` stands
    // for what the field actually displays, and the field does not gain that
    // space until the next render. Skipping this left it at its default '',
    // so any non-empty starting text read as a "manual edit" on the very
    // first result and got dropped.
    _lastWritten = _base;
    if (_base.isNotEmpty && !_base.endsWith(' ')) _base = '$_base ';
    _committed = '';
    _partial = '';

    _service.trace.add('dart.start', baseLen: _base.length);
    _setListening(true);
    widget.onListeningChanged(true);
    _listen();
  }

  /// Subscribe to the session, banking each segment the recogniser finalises.
  void _listen() {
    _subscription?.cancel();
    _subscription = _service.start().listen(
      (result) {
        if (!mounted) return;
        if (_absorbManualEdit()) {
          // The task now in flight still carries the pre-edit transcript —
          // applying `result` here would restate everything the user just
          // corrected, appended right after it. Drop it and force a fresh
          // task so the next partial is relative to the rebased text instead.
          unawaited(_service.restart());
          return;
        }
        _service.trace.add(
          result.isFinal ? 'dart.segment' : 'dart.partial',
          textLen: result.text.length,
          baseLen: _base.length,
          committedLen: _committed.length,
          partialLen: _partial.length,
        );
        if (result.isFinal) {
          // Bank it. From here the recogniser can never take these words back.
          _committed = _join(_committed, result.text);
          _partial = '';
        } else {
          _partial = result.text;
        }
        _render();
      },
      onError: (Object error) {
        if (!mounted) return;
        _service.trace.add('dart.error', note: error.toString());
        _finish();
        widget.onNotice(_message(error), isError: true);
      },
      // The stream stays open across iOS's internal task rotations - native
      // owns that now - so it closing really does mean the session ended.
      onDone: () {
        if (mounted) _finish();
      },
    );
  }

  /// Fold anything typed by hand since our last write into the base, so the
  /// next render does not overwrite it. Lets the keyboard and the mic be used
  /// in the same breath. Returns whether an edit was found — the caller must
  /// then discard whatever recognition result triggered this check and
  /// restart the native task, or its stale, still-in-flight transcript will
  /// duplicate the words just rebased into `_base`.
  bool _absorbManualEdit() {
    final current = widget.controller.text;
    if (current == _lastWritten) return false;
    _service.trace.add('dart.absorb',
        textLen: current.length,
        baseLen: _base.length,
        committedLen: _committed.length,
        partialLen: _partial.length,
        note: 'lastWritten=${_lastWritten.length}');
    // Record before the trailing space is added below, and before `_base`
    // gains it — `_lastWritten` stands for what the field actually displays.
    // Otherwise, since the caller skips `_render()` this pass, it would stay
    // one space short of the field, and the very next event would read that
    // as "edited again", restarting the task on a loop.
    _lastWritten = current;
    _base = current;
    if (_base.isNotEmpty && !_base.endsWith(' ')) _base = '$_base ';
    _committed = '';
    _partial = '';
    return true;
  }

  void _render() {
    final text = _base + _join(_committed, _partial);
    _service.trace.add('dart.render',
        textLen: text.length,
        baseLen: _base.length,
        committedLen: _committed.length,
        partialLen: _partial.length);
    _lastWritten = text;
    widget.controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  static String _join(String a, String b) {
    if (a.isEmpty) return b;
    if (b.isEmpty) return a;
    return a.endsWith(' ') ? '$a$b' : '$a $b';
  }

  void _finish() {
    _service.trace.add('dart.finish',
        baseLen: _base.length,
        committedLen: _committed.length,
        partialLen: _partial.length);
    unawaited(_service.trace.flush());
    _subscription?.cancel();
    _subscription = null;
    if (!mounted) return;
    _setListening(false);
    widget.onListeningChanged(false);
  }

  /// Stop recording without sending. The transcript stays in the composer so
  /// it can be read back and corrected first.
  Future<void> _stop() async => _service.stop();

  /// Stop and wait for the recogniser to settle.
  ///
  /// Send calls this first. Sending while the mic is live clears the composer
  /// under a still-running task, and the next partial - which carries the whole
  /// utterance, not just the new words - writes all of it straight back in.
  Future<void> stopDictation() async {
    if (!_listening) return;
    await _service.stop();
    // Give the final a moment to land so the last words are not clipped.
    await Future<void>.delayed(const Duration(milliseconds: 700));
  }

  static String _message(Object error) {
    if (error is! DictationError) return 'Dictation failed.';
    switch (error) {
      case DictationError.speechDenied:
        return 'Allow Speech Recognition in Settings to dictate.';
      case DictationError.microphoneDenied:
        return 'Allow Microphone access in Settings to dictate.';
      case DictationError.unavailable:
        return 'Dictation is not available on this device.';
      case DictationError.failed:
        return 'Dictation failed.';
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    if (!_service.isSupported) {
      return const SizedBox.shrink();
    }

    // Keep the caret in the composer: a button tap would otherwise pull focus
    // and drop the keyboard mid-dictation.
    void onTap() {
      widget.focusNode.requestFocus();
      _listening ? _stop() : _start();
    }

    final button = IconButton.filled(
      onPressed: widget.enabled ? onTap : null,
      tooltip: _listening ? 'Stop recording' : 'Dictate prompt',
      icon: Icon(_listening ? Icons.stop_rounded : Icons.mic_none, size: 20),
      visualDensity: VisualDensity.compact,
      constraints: const BoxConstraints.tightFor(width: 36, height: 36),
      padding: EdgeInsets.zero,
      style: IconButton.styleFrom(
        // Brass while live so the recording state is unmistakable; quiet
        // otherwise, so it never competes with send.
        backgroundColor: _listening ? t.accent.solid : t.panelStrong,
        foregroundColor: _listening ? t.accent.on : t.subtle,
        disabledBackgroundColor: t.panelStrong,
        disabledForegroundColor: t.subtle,
        shape: RoundedRectangleBorder(borderRadius: t.radius.lgR),
      ),
    );

    return SizedBox(
      width: 36,
      height: 36,
      child: AnimatedBuilder(
        animation: Listenable.merge([_tapController, _pulseController]),
        builder: (context, child) => Stack(
          alignment: Alignment.center,
          clipBehavior: Clip.none,
          children: [
            if (_listening)
              IgnorePointer(
                child: Opacity(
                  opacity: (1 - _pulse.value).clamp(0.0, 1.0) * 0.5,
                  child: Transform.scale(
                    scale: 1 + _pulse.value * 1.1,
                    child: Container(
                      width: 36,
                      height: 36,
                      decoration:
                          BoxDecoration(color: t.accent.solid, shape: BoxShape.circle),
                    ),
                  ),
                ),
              ),
            Transform.scale(scale: _tapScale.value, child: child),
          ],
        ),
        child: button,
      ),
    );
  }
}
