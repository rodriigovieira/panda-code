import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/widgets/prompt_sheet.dart';

void main() {
  testWidgets('long prompts show 500 characters until View more is tapped',
      (tester) async {
    final prompt = '${List.filled(500, 'a').join()}hidden tail';

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showPromptSheet(
                context,
                sent: [
                  PromptEntry(
                    text: prompt,
                    imageCount: 0,
                    timeMs: 1,
                    queued: false,
                  ),
                ],
                queued: const [],
              ),
              child: const Text('Open prompts'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open prompts'));
    await tester.pumpAndSettle();

    expect(find.text(List.filled(500, 'a').join()), findsOneWidget);
    expect(find.text(prompt), findsNothing);
    expect(find.text('View more'), findsOneWidget);

    await tester.ensureVisible(find.text('View more'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('View more'));
    await tester.pumpAndSettle();

    expect(find.text(prompt), findsOneWidget);
    expect(find.text('View less'), findsOneWidget);
  });

  testWidgets('prompts at the 500-character limit have no disclosure',
      (tester) async {
    final prompt = List.filled(500, 'b').join();

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showPromptSheet(
                context,
                sent: [
                  PromptEntry(
                    text: prompt,
                    imageCount: 0,
                    timeMs: 1,
                    queued: false,
                  ),
                ],
                queued: const [],
              ),
              child: const Text('Open prompts'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open prompts'));
    await tester.pumpAndSettle();

    expect(find.text(prompt), findsOneWidget);
    expect(find.text('View more'), findsNothing);
  });
}
