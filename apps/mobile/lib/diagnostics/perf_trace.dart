import 'dart:async';

import 'package:flutter/foundation.dart';

/// Streams performance diagnostics to the relay so a "feels laggy" report can
/// be read instead of guessed at — same rationale and shape as
/// `DictationTrace` (see its doc comment): a jank stutter while scrolling
/// cannot be reproduced off-device, so this ships real frame timings and
/// hand-picked operation durations off the phone instead.
///
/// **No message content ever crosses this boundary.** Entries carry event
/// names, durations, item counts, and a route tag — enough to see which
/// screen was on-screen when a frame dropped, and whether it lines up with a
/// decrypt batch or a tile build.
///
/// Buffered and flushed on a timer, same as DictationTrace: a jank sample can
/// fire many times a second during a bad scroll, and a mutation per sample
/// would be its own performance bug.
class PerfTrace {
  PerfTrace({required this.send});

  /// Posts a batch to `traces:appendPerf`. Injected so this doesn't need to
  /// know about the relay client, and so tests can capture instead of send.
  final Future<void> Function(List<Map<String, Object?>> entries) send;

  static const _flushEvery = Duration(seconds: 2);
  static const _maxBuffered = 400;

  final _buffer = <Map<String, Object?>>[];
  Timer? _timer;
  int _seq = 0;
  bool _enabled = false;

  /// On by default in Settings (see AppSettings.perfDiagnostics) — unlike
  /// dictation diagnostics this carries no content, only durations/counts —
  /// but the sink drops everything until a listener flips this, same pattern.
  bool get enabled => _enabled;
  set enabled(bool value) {
    _enabled = value;
    if (!value) {
      _buffer.clear();
      _timer?.cancel();
      _timer = null;
    }
  }

  /// Record one event. Cheap and non-blocking; safe to call from a hot path
  /// (a frame-timings callback, a decrypt loop, a list-tile builder).
  void add(
    String event, {
    double? durationMs,
    String? route,
    int? count,
    String? note,
  }) {
    if (!_enabled) return;
    _buffer.add({
      'ts': DateTime.now().millisecondsSinceEpoch,
      'seq': _seq++,
      'event': event,
      if (durationMs != null) 'durationMs': durationMs,
      if (route != null) 'route': route,
      if (count != null) 'count': count,
      if (note != null) 'note': note,
    });

    // Never let a stuck flush grow the buffer without bound.
    if (_buffer.length > _maxBuffered) {
      _buffer.removeRange(0, _buffer.length - _maxBuffered);
    }
    _timer ??= Timer(_flushEvery, flush);
  }

  /// Time a synchronous operation and record it under [event], tagged with
  /// [count] (e.g. items decrypted) when given. Returns the operation's result.
  T time<T>(String event, T Function() operation, {int? count, String? route}) {
    if (!_enabled) return operation();
    final stopwatch = Stopwatch()..start();
    final result = operation();
    stopwatch.stop();
    add(event,
        durationMs: stopwatch.elapsedMicroseconds / 1000, count: count, route: route);
    return result;
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
      debugPrint('[perf] trace flush failed: $error');
    }
  }
}

/// The screen currently on top, so a jank sample from the frame-timings
/// callback (which fires outside the widget tree, with no BuildContext) can
/// still be attributed to what the user was looking at. Deliberately a bare
/// static rather than routed through Riverpod/Navigator: it only needs to be
/// "close enough," set with one line at the top of a screen's build().
class PerfRoute {
  PerfRoute._();

  static String current = 'unknown';

  static void mark(String name) => current = name;
}
