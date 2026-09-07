import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/widgets/tool_call_view.dart';

Widget _wrap(Widget child) =>
    MaterialApp(home: Scaffold(body: SingleChildScrollView(child: child)));

ToolData _tool({
  required String name,
  required String output,
  ToolStatus status = ToolStatus.success,
}) =>
    ToolData(name: name, category: ToolCategory.other, status: status, output: output);

void main() {
  group('browserMediaTarget', () {
    test('finds the path in a real browser_screenshot success message', () {
      final tool = _tool(
        name: 'browser_screenshot',
        output:
            'Captured `tab-1` (Example) to /Users/example/Library/Application Support/'
            'Panda Code/browser-shots/tab-1-1700000000000.png — read that path to see it. '
            'The page is 1512×982 CSS pixels at 2× — divide a pixel coordinate in the '
            'image by 2 to get a `browser_cursor` coordinate.',
      );
      final target = browserMediaTarget(tool);
      expect(target, isNotNull);
      expect(target!.isVideo, isFalse);
      expect(target.path, endsWith('tab-1-1700000000000.png'));
    });

    test('finds the path in a real browser_record stop message', () {
      final tool = _tool(
        name: 'browser_record',
        output: 'Recording stopped (asked to): 12 frames over 6s. '
            'Video at /Users/example/Library/Application Support/Panda Code/browser-shots/'
            'recording-tab-1-1700000000000/recording.mp4',
      );
      final target = browserMediaTarget(tool);
      expect(target, isNotNull);
      expect(target!.isVideo, isTrue);
      expect(target.path, endsWith('recording.mp4'));
    });

    test('a record "start" has no video yet, so no target', () {
      final tool = _tool(
        name: 'browser_record',
        output:
            'Recording `tab-1` at 2 fps. Call `browser_record` with action `stop` when '
            'you are done — it stops on its own after five minutes.',
      );
      expect(browserMediaTarget(tool), isNull);
    });

    test('an errored capture has nothing to view', () {
      final tool = _tool(
        name: 'browser_screenshot',
        output: 'Could not capture the tab: hidden panel.',
        status: ToolStatus.error,
      );
      expect(browserMediaTarget(tool), isNull);
    });

    test('an unrelated tool never matches, even with a similar-looking output', () {
      final tool = _tool(
        name: 'Read',
        output: 'to /tmp/whatever.png — read that path to see it.',
      );
      expect(browserMediaTarget(tool), isNull);
    });
  });

  testWidgets('ToolCallView shows a View screenshot button that fires onOpenMedia',
      (tester) async {
    final tool = _tool(
      name: 'browser_screenshot',
      output: 'Captured `tab-1` (Example) to /tmp/shots/tab-1-123.png — '
          'read that path to see it.',
    );
    String? tappedPath;
    bool? tappedIsVideo;
    await tester.pumpWidget(_wrap(ToolCallView(
      tool: tool,
      onOpenMedia: (path, isVideo) {
        tappedPath = path;
        tappedIsVideo = isVideo;
      },
    )));

    expect(find.text('View screenshot'), findsOneWidget);
    await tester.tap(find.text('View screenshot'));
    await tester.pump();

    expect(tappedPath, '/tmp/shots/tab-1-123.png');
    expect(tappedIsVideo, isFalse);
  });

  testWidgets('ToolCallView hides the button when onOpenMedia is not wired up',
      (tester) async {
    final tool = _tool(
      name: 'browser_screenshot',
      output: 'Captured `tab-1` (Example) to /tmp/shots/tab-1-123.png — '
          'read that path to see it.',
    );
    await tester.pumpWidget(_wrap(ToolCallView(tool: tool)));
    expect(find.text('View screenshot'), findsNothing);
  });
}
