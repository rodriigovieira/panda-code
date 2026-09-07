import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/widgets/media_viewer_screen.dart';
import 'package:panda_code_mobile/state/providers.dart';

void main() {
  testWidgets('inline recording waits for Play and shows a retry when offline',
      (tester) async {
    var requests = 0;
    await tester.pumpWidget(ProviderScope(
      overrides: [
        relayApiProvider.overrideWith((ref) async {
          requests++;
          return null;
        })
      ],
      child: const MaterialApp(
          home: Scaffold(
              body: SizedBox(
        height: 240,
        child: MediaViewerScreen(
            sessionId: null,
            path: '/example/flow.mp4',
            isVideo: true,
            inline: true),
      ))),
    ));
    await tester.pumpAndSettle();
    expect(requests, 0);
    expect(find.text('Play recording'), findsOneWidget);
    await tester.runAsync(() async {
      await tester.tap(find.text('Play recording'));
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    expect(requests, 1);
    expect(find.text('Not paired with a desktop.'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
