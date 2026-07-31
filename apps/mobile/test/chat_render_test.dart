import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/widgets/approval_bar.dart';
import 'package:panda_code_mobile/sessions/widgets/conversation_item_view.dart';
import 'package:panda_code_mobile/sessions/widgets/runtime_header.dart';
import 'package:panda_code_mobile/sessions/widgets/tool_call_view.dart';

Widget _wrap(Widget child) =>
    MaterialApp(home: Scaffold(body: SingleChildScrollView(child: child)));

SessionRow _row({required AgentState agent, String? latestCommand}) =>
    SessionRow(
      sessionId: 's1',
      title: 'Session',
      status: SessionStatus.running,
      agentState: agent,
      executionMode: 'stream-json',
      headSeq: 0,
      updatedAt: 0,
      runtime: RuntimeBadge(agentState: agent, latestCommand: latestCommand),
    );

void main() {
  testWidgets('tool call renders a ToolCallView with its name', (tester) async {
    final item = ConversationItem.fromDecrypted({
      'kind': 'tool',
      'tool': {
        'name': 'Bash',
        'category': 'bash',
        'command': 'ls',
        'status': 'success'
      },
    }, 1);
    await tester.pumpWidget(_wrap(ConversationItemView(item: item)));
    expect(find.byType(ToolCallView), findsOneWidget);
    expect(find.textContaining('Bash', findRichText: true), findsWidgets);
  });

  testWidgets(
      'tool call synthesized from the desktop wire shape renders as a card',
      (tester) async {
    // The desktop streams a tool call as kind:"tool" + title + markdown body,
    // with no structured `tool` object — the shape that used to dump raw.
    final item = ConversationItem.fromDecrypted({
      'id': 'stream:abc:tool',
      'kind': 'tool',
      'title': 'Read',
      'body': '/Users/me/project/main.dart',
    }, 1);
    expect(item.tool, isNotNull);
    expect(item.tool!.name, 'Read');
    expect(item.tool!.category, ToolCategory.read);
    expect(item.tool!.filePath, '/Users/me/project/main.dart');
    await tester.pumpWidget(_wrap(ConversationItemView(item: item)));
    expect(find.byType(ToolCallView), findsOneWidget);
  });

  test('mergeToolResults folds a tool_result into its tool_use', () {
    final call = ConversationItem.fromDecrypted({
      'id': 'stream:t1:tool',
      'kind': 'tool',
      'title': 'Bash',
      'body': 'ls -la',
    }, 1);
    final result = ConversationItem.fromDecrypted({
      'id': 'stream:t1:result',
      'kind': 'tool',
      'title': 'Tool result',
      'body': 'total 0\ndrwxr-xr-x',
    }, 2);
    final merged = mergeToolResults([call, result]);
    expect(merged, hasLength(1));
    expect(merged.single.tool!.command, 'ls -la');
    expect(merged.single.tool!.output, 'total 0\ndrwxr-xr-x');
    expect(merged.single.tool!.status, ToolStatus.success);
  });

  testWidgets('a sending user message shows a spinner and no retry affordance',
      (tester) async {
    const item = ConversationItem(
      id: 'local:1',
      kind: 'user',
      title: null,
      body: 'hello there',
      sequence: null,
      model: null,
      thinking: false,
      tool: null,
      sendState: SendState.sending,
    );
    await tester.pumpWidget(_wrap(ConversationItemView(item: item)));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.textContaining('tap to retry'), findsNothing);
  });

  testWidgets('a failed user message shows tap-to-retry and fires onRetrySend',
      (tester) async {
    const item = ConversationItem(
      id: 'local:2',
      kind: 'user',
      title: null,
      body: 'hello there',
      sequence: null,
      model: null,
      thinking: false,
      tool: null,
      sendState: SendState.failed,
    );
    String? retried;
    await tester.pumpWidget(_wrap(ConversationItemView(
      item: item,
      onRetrySend: (id) => retried = id,
    )));
    expect(find.textContaining('tap to retry'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    await tester.tap(find.textContaining('tap to retry'));
    expect(retried, 'local:2');
  });

  test('thinking is detected from the desktop system/"Thinking" shape', () {
    final item = ConversationItem.fromDecrypted({
      'kind': 'system',
      'title': 'Thinking',
      'body': 'Considering the options...',
    }, 1);
    expect(item.thinking, isTrue);
  });

  testWidgets(
      'runtime footer shows a working spinner, a cycling word and the '
      'latest command', (tester) async {
    // reduceMotion stops the word cycler so no periodic timer outlives the test.
    await tester.pumpWidget(_wrap(RuntimeFooter(
        reduceMotion: true,
        row: _row(agent: AgentState.working, latestCommand: 'pnpm test'))));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    // The cycling word renders with a trailing ellipsis, e.g. "Thinking…".
    expect(find.textContaining('…'), findsOneWidget);
    expect(find.textContaining('pnpm test'), findsOneWidget);
  });

  testWidgets('runtime footer defers to the approval bar when action is needed',
      (tester) async {
    await tester.pumpWidget(
        _wrap(RuntimeFooter(row: _row(agent: AgentState.needsAction))));
    // It collapses to nothing so the approval bar owns that moment.
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.textContaining('…'), findsNothing);
  });

  testWidgets('runtime footer shows a ready line while waiting',
      (tester) async {
    await tester
        .pumpWidget(_wrap(RuntimeFooter(row: _row(agent: AgentState.waiting))));
    expect(find.text('Ready'), findsOneWidget);
  });

  testWidgets('turn-summary item renders as a stats caption', (tester) async {
    final item = ConversationItem.fromDecrypted({
      'id': 'stream:msg-1:summary',
      'kind': 'system',
      'title': 'Turn summary',
      'body': 'Worked for 15s · 1.5k tokens',
    }, 1);
    expect(isTurnSummaryItem(item), isTrue);
    await tester.pumpWidget(_wrap(ConversationItemView(item: item)));
    expect(find.text('Worked for 15s · 1.5k tokens'), findsOneWidget);
  });

  testWidgets('approval bar fires approve callback', (tester) async {
    String? answeredOption;
    await tester.pumpWidget(_wrap(ApprovalBar(
      onAnswer: (optionId, text) async => answeredOption = optionId,
    )));
    await tester.tap(find.text('Approve'));
    await tester.pump();
    expect(answeredOption, 'accept');
    expect(find.text('Deny'), findsOneWidget);
  });

  testWidgets('approval bar preserves option order and sends free text',
      (tester) async {
    String? answeredOption;
    String? answeredText;
    const approval = PendingApproval(
      promptId: 'p1',
      kind: 'userInput',
      title: 'PIN de segurança',
      body: 'Selecione, na ordem, os quatro pares do seu PIN.',
      options: [
        ApprovalOption(id: 'option:0', label: '15'),
        ApprovalOption(id: 'option:1', label: '83'),
        ApprovalOption(id: 'option:2', label: '70'),
      ],
      allowsFreeText: true,
    );

    await tester.pumpWidget(_wrap(ApprovalBar(
      approval: approval,
      onAnswer: (optionId, text) async {
        answeredOption = optionId;
        answeredText = text;
      },
    )));

    expect(
        find.descendant(
            of: find.byType(Wrap),
            matching: find.byWidgetPredicate(
                (widget) => widget is Text && widget.data == '15')),
        findsOneWidget);
    expect(find.text('83'), findsOneWidget);
    expect(find.text('70'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '15837069');
    await tester.tap(find.byTooltip('Send answer'));
    await tester.pump();
    expect(answeredOption, isNull);
    expect(answeredText, '15837069');
  });
}
