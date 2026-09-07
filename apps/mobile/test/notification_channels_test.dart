import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/relay/relay_api.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/widgets/notification_channels_sheet.dart';
import 'package:panda_code_mobile/state/providers.dart';

const row = SessionRow(sessionId: 'test', title: 'Section', status: SessionStatus.idle,
  agentState: AgentState.waiting, executionMode: 'stream-json', headSeq: 0, updatedAt: 0, runtime: null);
class SettingsApi implements RelayApi {
  Map<String, bool> settings = {'desktop': false, 'agent': true};
  bool? subscribed;
  @override
  Future<Map<String, bool>> sessionNotificationChannels(String sessionId, {bool? desktop, bool? agent}) async {
    if (desktop != null) settings['desktop'] = desktop;
    if (agent != null) settings['agent'] = agent;
    return Map.of(settings);
  }
  @override
  Future<void> setSessionSubscription(String sessionId, {required bool subscribed}) async { this.subscribed = subscribed; }
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
Widget app(SettingsApi api, {bool online = true}) => ProviderScope(overrides: [
  relayApiProvider.overrideWith((ref) async => api),
  sessionRowProvider(row.sessionId).overrideWithValue(row),
  desktopOnlineProvider.overrideWithValue(online),
], child: MaterialApp(home: Scaffold(body: NotificationChannelsSheet(row: row))));

void main() {
  testWidgets('three independent channels, including agent attention with banners disabled', (tester) async {
    final api = SettingsApi();
    await tester.pumpWidget(app(api));
    await tester.pumpAndSettle();
    SwitchListTile tile(String label) => tester.widget<SwitchListTile>(find.ancestor(of: find.text(label), matching: find.byType(SwitchListTile)));
    expect(tile('Desktop notifications').value, false);
    expect(tile('Agent attention').value, true);
    expect(tile('Agent attention').onChanged, isNotNull);
    await tester.tap(find.text('Agent attention'));
    await tester.pumpAndSettle();
    expect(api.settings, {'desktop': false, 'agent': false});
    await tester.tap(find.text('Desktop notifications'));
    await tester.pumpAndSettle();
    expect(api.settings, {'desktop': true, 'agent': false});
    await tester.tap(find.text('Mobile notifications'));
    await tester.pumpAndSettle();
    expect(api.subscribed, true);
    expect(api.settings, {'desktop': true, 'agent': false});
  });
  testWidgets('offline Mac disables its controls but keeps mobile subscription editable', (tester) async {
    await tester.pumpWidget(app(SettingsApi(), online: false));
    await tester.pumpAndSettle();
    final switches = tester.widgetList<SwitchListTile>(find.byType(SwitchListTile)).toList();
    expect(switches[0].onChanged, isNotNull);
    expect(switches[1].onChanged, isNull);
    expect(switches[2].onChanged, isNull);
    expect(find.text('Connect your Mac to manage desktop channels.'), findsOneWidget);
  });
}
