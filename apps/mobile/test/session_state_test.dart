import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/stale_runtime_app.dart';

void main() {
  testWidgets('idle section sends instead of queuing despite stale working runtime', (tester) async {
    FlutterSecureStorage.setMockInitialValues({});
    final api = StaleRuntimeApi();
    await tester.pumpWidget(staleRuntimeApp(api));
    await tester.pumpAndSettle();
    expect(find.text('Ready'), findsOneWidget);
    expect(find.byTooltip('Queue message'), findsNothing);
    await tester.enterText(find.byType(TextField), 'Please continue');
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Send message'));
    await tester.pumpAndSettle();
    expect(api.sent, ['Please continue']);
    expect(api.queued, isEmpty);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });
}
