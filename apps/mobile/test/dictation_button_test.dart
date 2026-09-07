import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/dictation/dictation_button.dart';
import 'package:panda_code_mobile/dictation/dictation_service.dart';
import 'package:panda_code_mobile/state/providers.dart';
import 'package:panda_code_mobile/theme/panda_theme.dart';

/// Stands in for the native channel so the recogniser's lifecycle — including
/// the mid-session restart iOS performs on its own — can be driven by hand.
class FakeDictationService extends DictationService {
  final segments = <StreamController<DictationResult>>[];
  int stopCalls = 0;
  int restartCalls = 0;

  @override
  bool get isSupported => true;

  @override
  Future<void> prepare() async {}

  @override
  Stream<DictationResult> start() {
    final controller = StreamController<DictationResult>();
    segments.add(controller);
    return controller.stream;
  }

  @override
  Future<void> stop() async => stopCalls++;

  @override
  Future<void> restart() async => restartCalls++;

  @override
  Future<void> cancel() async {}

  StreamController<DictationResult> get current => segments.last;
}

void main() {
  late FakeDictationService service;
  late TextEditingController controller;
  late List<bool> listeningStates;
  late GlobalKey<DictationButtonState> micKey;

  Future<void> pumpButton(WidgetTester tester) async {
    service = FakeDictationService();
    controller = TextEditingController();
    listeningStates = <bool>[];
    micKey = GlobalKey<DictationButtonState>();
    await tester.pumpWidget(ProviderScope(
      overrides: [dictationServiceProvider.overrideWithValue(service)],
      child: MaterialApp(
        theme: buildPandaTheme(
          brightness: Brightness.dark,
          density: VisualDensity.standard,
        ),
        home: Scaffold(
          body: Column(children: [
            TextField(controller: controller),
            DictationButton(
              key: micKey,
              controller: controller,
              focusNode: FocusNode(),
              enabled: true,
              onNotice: (_, {bool isError = false}) {},
              onListeningChanged: (listening) => listeningStates.add(listening),
            ),
          ]),
        ),
      ),
    ));
    await tester.pump();
  }

  Future<void> tapMic(WidgetTester tester) async {
    await tester.tap(find.byType(IconButton));
    await tester.pump();
  }

  testWidgets('partials rewrite only the in-flight tail', (tester) async {
    await pumpButton(tester);
    await tapMic(tester);

    service.current.add(const DictationResult(text: 'deploy the', isFinal: false));
    await tester.pump();
    expect(controller.text, 'deploy the');

    // The recogniser revises what it already said — allowed, it is not final.
    service.current.add(const DictationResult(text: 'deploy the backend', isFinal: false));
    await tester.pump();
    expect(controller.text, 'deploy the backend');
  });

  testWidgets('banked segments survive an iOS task rotation', (tester) async {
    await pumpButton(tester);
    await tapMic(tester);

    // iOS ends a recognition task on its own after ~1 minute. Native rotates
    // over the same audio engine and reports the closed task as a finalised
    // segment, so the Dart stream stays open across the boundary.
    service.current
        .add(const DictationResult(text: 'commit and push', isFinal: true));
    await tester.pump();
    expect(controller.text, 'commit and push');

    // The next task starts its transcript from zero. This is the regression:
    // taking that fresh string as the whole truth gutted everything said so far.
    service.current.add(const DictationResult(text: 'then', isFinal: false));
    await tester.pump();
    expect(controller.text, 'commit and push then');

    service.current
        .add(const DictationResult(text: 'then deploy', isFinal: false));
    await tester.pump();
    expect(controller.text, 'commit and push then deploy');
    expect(service.segments, hasLength(1),
        reason: 'rotation is native-side; Dart keeps one stream');
  });

  testWidgets('several rotations accumulate rather than replace', (tester) async {
    await pumpButton(tester);
    await tapMic(tester);

    for (final segment in ['first part', 'second part', 'third part']) {
      service.current.add(DictationResult(text: segment, isFinal: true));
      await tester.pump();
    }

    expect(controller.text, 'first part second part third part');
  });

  testWidgets('dictation appends to text already typed', (tester) async {
    await pumpButton(tester);
    controller.text = 'fix the';
    await tapMic(tester);

    service.current.add(const DictationResult(text: 'admin app', isFinal: true));
    await tester.pump();
    expect(controller.text, 'fix the admin app');
  });

  testWidgets('typing mid-dictation is preserved, not clobbered', (tester) async {
    await pumpButton(tester);
    await tapMic(tester);

    service.current.add(const DictationResult(text: 'run the', isFinal: true));
    await tester.pump();

    // User grabs the keyboard and edits by hand while the mic is still live.
    controller.text = 'run the e2e';

    // The task that was already listening does not know about the edit — its
    // next partial still narrates the whole utterance from that task's own
    // start ("run the"), not just what's new. Applying it here would restate
    // the very words the user just corrected, right after them: the
    // duplication regression. It must be dropped, and a fresh task started so
    // future partials are relative to the edited text instead.
    service.current.add(const DictationResult(text: 'run the', isFinal: false));
    await tester.pump();

    expect(controller.text, 'run the e2e',
        reason: 'a stale same-task partial must be dropped, not appended');
    expect(service.restartCalls, 1,
        reason: 'edited text needs a fresh task so future partials are '
            'relative to it, not to the pre-edit utterance');

    // The restarted task's first partial is relative to the new base.
    service.current.add(const DictationResult(text: 'suite', isFinal: false));
    await tester.pump();

    expect(controller.text, 'run the e2e suite');
  });

  testWidgets('stopDictation is a no-op when not recording', (tester) async {
    await pumpButton(tester);
    final state = micKey.currentState!;

    await state.stopDictation();

    expect(service.stopCalls, 0, reason: 'nothing to stop');
    expect(listeningStates, isEmpty);
  });

  testWidgets('stopDictation stops a live recogniser before send clears the '
      'composer', (tester) async {
    await pumpButton(tester);
    await tapMic(tester);
    service.current.add(const DictationResult(text: 'ship it', isFinal: false));
    await tester.pump();

    // Send must await this. Clearing the composer under a live task makes the
    // next partial - which carries the whole utterance - refill the field.
    final pending = micKey.currentState!.stopDictation();
    await tester.pump();
    expect(service.stopCalls, 1);

    await service.current.close();
    await tester.pumpAndSettle(const Duration(milliseconds: 800));
    await pending;

    expect(listeningStates, [true, false]);
  });

  testWidgets('stopping ends the session instead of reopening', (tester) async {
    await pumpButton(tester);
    await tapMic(tester);
    service.current.add(const DictationResult(text: 'done', isFinal: true));
    await tester.pump();

    await tapMic(tester); // stop
    await service.current.close();
    await tester.pump();

    expect(service.segments, hasLength(1), reason: 'stop must not restart');
    expect(controller.text, 'done');
    // The composer grows on start and shrinks on stop — and an iOS-internal
    // restart in between must not flicker it.
    expect(listeningStates, [true, false]);
  });
}
