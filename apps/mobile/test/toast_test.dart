import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/widgets/toast/panda_toast.dart';
import 'package:panda_code_mobile/widgets/toast/toast_overlay.dart';

/// Mounts the overlay host over an empty screen, the same way `app.dart` wires
/// it into `MaterialApp.builder`.
Widget _host() => const ProviderScope(
      child: MaterialApp(
        home: ToastOverlay(child: Scaffold(body: SizedBox.expand())),
      ),
    );

void main() {
  tearDown(ToastMessenger.instance.clear);

  testWidgets('showToast surfaces a floating card with the message',
      (tester) async {
    await tester.pumpWidget(_host());

    showToast('Transcript copied', variant: ToastVariant.success);
    await tester.pump(); // register the entry
    await tester.pumpAndSettle(); // play the enter animation

    expect(find.text('Transcript copied'), findsOneWidget);
  });

  testWidgets('an action toast shows its button and fires the callback',
      (tester) async {
    await tester.pumpWidget(_host());
    var retried = false;

    showToast('Send failed. Check your connection.',
        variant: ToastVariant.error,
        actionLabel: 'Retry',
        onAction: () => retried = true);
    await tester.pump();
    await tester.pumpAndSettle();

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    expect(retried, isTrue);
    // Tapping the action also dismisses the card.
    expect(find.text('Send failed. Check your connection.'), findsNothing);
  });

  testWidgets('a toast auto-dismisses after its duration', (tester) async {
    await tester.pumpWidget(_host());

    showToast('Copied code',
        variant: ToastVariant.success,
        duration: const Duration(seconds: 2));
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.text('Copied code'), findsOneWidget);

    await tester.pump(const Duration(seconds: 2)); // duration elapses
    await tester.pumpAndSettle(); // play the exit animation
    expect(find.text('Copied code'), findsNothing);
  });

  testWidgets('the stack caps at three cards, dropping the oldest',
      (tester) async {
    await tester.pumpWidget(_host());

    for (final n in ['one', 'two', 'three', 'four']) {
      showToast(n, duration: Duration.zero); // persist so none auto-dismiss
    }
    await tester.pump();
    await tester.pumpAndSettle();

    expect(find.text('one'), findsNothing); // evicted
    expect(find.text('two'), findsOneWidget);
    expect(find.text('three'), findsOneWidget);
    expect(find.text('four'), findsOneWidget);
  });
}
