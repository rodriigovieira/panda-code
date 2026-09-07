// Runs the real conversation screen with deterministic relay data. Also usable
// as a simulator entrypoint: flutter run -t test/support/stale_runtime_app.dart.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:panda_code_mobile/relay/relay_api.dart';
import 'package:panda_code_mobile/dictation/dictation_service.dart';
import 'package:panda_code_mobile/relay/relay_client.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/session_view_screen.dart';
import 'package:panda_code_mobile/state/providers.dart';
import 'package:panda_code_mobile/theme/panda_theme.dart';

const idleRow = SessionRow(
  sessionId: 'stale-runtime-verification', title: 'Panda',
  status: SessionStatus.idle, agentState: AgentState.waiting,
  executionMode: 'stream-json', headSeq: 1, updatedAt: 100,
  lastPromptAt: 1, runtime: null,
);
const staleRuntime = SessionRuntimeSnapshot(headSeq: 1, badge: RuntimeBadge(
  agentState: AgentState.working, latestCommand: 'git push',
));

class _Dictation implements DictationService {
  @override
  bool get isSupported => true;
  @override
  Future<void> prepare() async {}
  @override
  Future<void> cancel() async {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Subscription implements RelaySubscription {
  @override
  void cancel() {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class StaleRuntimeApi implements RelayApi {
  final sent = <String>[];
  final queued = <String>[];
  @override
  dynamic noSuchMethod(Invocation invocation) {
    switch (invocation.memberName) {
      case #history:
        return Future.value(HistoryPage(items: [ConversationItem.fromDecrypted({
          'id': 'reply', 'kind': 'assistant',
          'body': 'This section is idle. The runtime badge still contains an old running command.',
        }, 1)], nextBeforeSeq: null, isDone: true));
      case #tailSession:
        return Future<RelaySubscription>.value(_Subscription());
      case #sendInput:
        sent.add(invocation.positionalArguments[1] as String);
        return Future.value('sent-command');
      case #queuePrompt:
        queued.add(invocation.positionalArguments[2] as String);
        return Future.value('queued-command');
    }
    return super.noSuchMethod(invocation);
  }
}

Widget staleRuntimeApp(StaleRuntimeApi api) => ProviderScope(
  overrides: [
    dictationServiceProvider.overrideWith((ref) => _Dictation()),
    relayApiProvider.overrideWith((ref) async => api),
    sessionsStreamProvider.overrideWith((ref) => Stream.value([idleRow])),
    sessionRuntimeProvider(idleRow.sessionId).overrideWith((ref) => Stream.value(staleRuntime)),
    desktopOnlineProvider.overrideWithValue(true),
    commandOutcomesProvider.overrideWith((ref) => Stream.value([])),
  ],
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildPandaTheme(brightness: Brightness.dark, density: VisualDensity.standard),
    home: const SessionViewScreen(row: idleRow),
  ),
);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(staleRuntimeApp(StaleRuntimeApi()));
}
