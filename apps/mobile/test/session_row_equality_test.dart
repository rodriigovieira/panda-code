import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';

SessionRow row(
  String id, {
  String? title,
  int updatedAt = 0,
  AgentState state = AgentState.waiting,
  bool starred = false,
}) =>
    SessionRow(
      sessionId: id,
      title: title ?? id,
      status: SessionStatus.running,
      agentState: state,
      executionMode: 'stream-json',
      headSeq: 0,
      updatedAt: updatedAt,
      runtime: null,
      starred: starred,
    );

void main() {
  group('SessionRow equality', () {
    // The dirty-check in RelayApi.watchSessions() relies on this: two
    // separately-decrypted rows with the same content must compare equal so
    // an unchanged `sessions:list` push can be skipped instead of cascading
    // into a full rebuild.
    test('two separately built rows with identical fields are equal', () {
      expect(row('a', title: 'Fix bug'), row('a', title: 'Fix bug'));
      expect(row('a', title: 'Fix bug').hashCode,
          row('a', title: 'Fix bug').hashCode);
    });

    test('a changed field breaks equality', () {
      expect(row('a', updatedAt: 1), isNot(row('a', updatedAt: 2)));
      expect(row('a', state: AgentState.working),
          isNot(row('a', state: AgentState.waiting)));
      expect(row('a', starred: true), isNot(row('a', starred: false)));
    });

    test('lists of equal rows compare equal element-wise', () {
      final a = [row('a'), row('b', updatedAt: 5)];
      final b = [row('a'), row('b', updatedAt: 5)];
      expect(listEquals(a, b), isTrue);

      final c = [row('a'), row('b', updatedAt: 6)];
      expect(listEquals(a, c), isFalse);
    });
  });
}
