import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/backlog/backlog_models.dart';
import 'package:panda_code_mobile/backlog/backlog_screen.dart';
import 'package:panda_code_mobile/relay/relay_api.dart';
import 'package:panda_code_mobile/state/providers.dart';
import 'package:panda_code_mobile/theme/panda_theme.dart';

class _BacklogApi implements RelayApi {
  Future<WorkspaceBacklog> Function() load = () async => const WorkspaceBacklog();

  @override
  dynamic noSuchMethod(Invocation invocation) {
    if (invocation.memberName == #backlog) return load();
    return super.noSuchMethod(invocation);
  }
}

void main() {
  testWidgets('failed load hides empty state, details expand, and retry recovers', (tester) async {
    final api = _BacklogApi();
    api.load = () async => throw Exception('Value is too large (1.14 MiB > maximum size 1 MiB)');
    await tester.pumpWidget(ProviderScope(
      overrides: [relayApiProvider.overrideWith((ref) async => api)],
      child: MaterialApp(
        theme: buildPandaTheme(brightness: Brightness.dark, density: VisualDensity.standard),
        home: const BacklogScreen(cwd: '/repo', workspaceName: 'Example'),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Nothing in backlog.'), findsNothing);
    expect(find.text('Backlog unavailable.'), findsOneWidget);
    expect(find.textContaining('Value is too large'), findsNothing);
    await tester.tap(find.text('Details'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Value is too large'), findsOneWidget);
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
    final pending = Completer<WorkspaceBacklog>();
    api.load = () => pending.future;
    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    pending.complete(const WorkspaceBacklog());
    await tester.pumpAndSettle();
    expect(find.text('Nothing in backlog.'), findsOneWidget);
    expect(find.text('Backlog unavailable.'), findsNothing);

    api.load = () async => throw Exception('offline');
    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pumpAndSettle();
    expect(find.text('Couldn’t update backlog. Showing the last loaded board.'), findsOneWidget);
    expect(find.text('Nothing in backlog.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
