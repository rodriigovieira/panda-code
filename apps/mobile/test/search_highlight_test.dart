import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/widgets/code_view.dart';
import 'package:panda_code_mobile/sessions/widgets/conversation_item_view.dart';
import 'package:panda_code_mobile/sessions/widgets/search_highlight.dart';

Widget _wrap(Widget child) => ProviderScope(
      child: MaterialApp(
        home: Scaffold(body: SingleChildScrollView(child: child)),
      ),
    );

void main() {
  group('highlightSpans', () {
    test('returns a single base span when there is no query', () {
      final spans = highlightSpans('hello world', null);
      expect(spans, hasLength(1));
      expect((spans.single as TextSpan).text, 'hello world');
      expect((spans.single as TextSpan).style?.backgroundColor, isNull);
    });

    test('splits and highlights every case-insensitive occurrence', () {
      final spans = highlightSpans('Foo foo FOO', 'foo')
          .cast<TextSpan>();
      final texts = spans.map((s) => s.text).toList();
      expect(texts, ['Foo', ' ', 'foo', ' ', 'FOO']);
      final highlighted =
          spans.where((s) => s.style?.backgroundColor != null).toList();
      expect(highlighted, hasLength(3));
      expect(highlighted.every((s) => s.style!.backgroundColor == highlightPassive),
          isTrue);
    });

    test('active flag uses the focused colour', () {
      final spans =
          highlightSpans('abc', 'abc', active: true).cast<TextSpan>();
      expect(spans.single.style?.backgroundColor, highlightActive);
    });

    test('leading and trailing text around a match are preserved', () {
      final texts = highlightSpans('a match here', 'match')
          .cast<TextSpan>()
          .map((s) => s.text)
          .toList();
      expect(texts, ['a ', 'match', ' here']);
    });
  });

  group('queryMatches', () {
    test('is case-insensitive and null-safe', () {
      expect(queryMatches('Hello World', 'world'), isTrue);
      expect(queryMatches(null, 'x'), isFalse);
      expect(queryMatches('text', null), isFalse);
      expect(queryMatches('text', ''), isFalse);
    });
  });

  testWidgets('a matching query auto-expands a tool card to reveal the hit',
      (tester) async {
    final item = ConversationItem.fromDecrypted({
      'id': 'stream:t1:tool',
      'kind': 'tool',
      'tool': {
        'name': 'Bash',
        'category': 'bash',
        'command': 'ls',
        'output': 'needle in the haystack',
        'status': 'success',
      },
    }, 1);

    // Without a query the success tool stays collapsed (no code body shown).
    await tester.pumpWidget(_wrap(ConversationItemView(item: item)));
    expect(find.byType(CodeView), findsNothing);

    // A query that hits the (collapsed) output forces the card open.
    await tester.pumpWidget(_wrap(
      ConversationItemView(item: item, highlightQuery: 'needle'),
    ));
    expect(find.byType(CodeView), findsWidgets);
  });
}
