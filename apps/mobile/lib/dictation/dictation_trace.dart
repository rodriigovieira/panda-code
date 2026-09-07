import 'dart:async';

import 'package:flutter/foundation.dart';

/// Streams dictation diagnostics to the relay so the transcript-erasing bug can
/// be read instead of guessed at.
///
/// **No transcript text leaves the device.** Entries carry event names, the
/// native recogniser's task generation, and character counts — enough to see
/// the moment banked text drops to zero, and whether two task generations were
/// live when it happened, which is what three rounds of off-device reasoning
/// could not establish.
///
/// Buffered and flushed on a timer: dictation emits partials several times a
/// second and a mutation per partial would be its own performance bug.
class DictationTrace {
  DictationTrace({required this.send});

  /// Posts a batch to `traces:append`. Injected so the service does not need to
  /// know about the relay client, and so tests can capture instead of send.
  final Future<void> Function(List<Map<String, Object?>> entries) send;

  static const _flushEvery = Duration(seconds: 2);
  static const _maxBuffered = 200;

  final _buffer = <Map<String, Object?>>[];
  Timer? _timer;
  int _seq = 0;
  bool _enabled = false;

  /// Off by default. Diagnostics are opt-in from Settings, so a normal install
  /// sends nothing at all.
  bool get enabled => _enabled;
  set enabled(bool value) {
    _enabled = value;
    if (!value) {
      _buffer.clear();
      _timer?.cancel();
      _timer = null;
    }
  }

  /// Record one event. Cheap and non-blocking; safe to call from a hot path.
  void add(
    String event, {
    int? gen,
    int? baseLen,
    int? committedLen,
    int? partialLen,
    int? textLen,
    String? note,
  }) {
    if (!_enabled) return;
    _buffer.add({
      'ts': DateTime.now().millisecondsSinceEpoch,
      'seq': _seq++,
      'event': event,
      if (gen != null) 'gen': gen,
      if (baseLen != null) 'baseLen': baseLen,
      if (committedLen != null) 'committedLen': committedLen,
      if (partialLen != null) 'partialLen': partialLen,
      if (textLen != null) 'textLen': textLen,
      if (note != null) 'note': note,
    });

    // Never let a stuck flush grow the buffer without bound.
    if (_buffer.length > _maxBuffered) {
      _buffer.removeRange(0, _buffer.length - _maxBuffered);
    }
    _timer ??= Timer(_flushEvery, flush);
  }

  /// Send whatever has accumulated. Failures are dropped: diagnostics must
  /// never break the feature they are diagnosing.
  Future<void> flush() async {
    _timer?.cancel();
    _timer = null;
    if (_buffer.isEmpty) return;

    final batch = List<Map<String, Object?>>.from(_buffer);
    _buffer.clear();
    try {
      await send(batch);
    } catch (error) {
      debugPrint('[dictation] trace flush failed: $error');
    }
  }
}
