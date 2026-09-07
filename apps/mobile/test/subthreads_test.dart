import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/subthreads.dart';

SessionRow row(
  String id, {
  String? parent,
  AgentState state = AgentState.waiting,
}) =>
    SessionRow(
      sessionId: id,
      title: id,
      status: SessionStatus.running,
      agentState: state,
      executionMode: 'stream-json',
      headSeq: 0,
      updatedAt: 0,
      runtime: null,
      parentSessionId: parent,
    );

void main() {
  group('subthreadRoots', () {
    test('treats a session with no parent as top-level', () {
      final rows = [row('a'), row('b', parent: 'a')];
      expect(subthreadRoots(rows).map((r) => r.sessionId), ['a']);
    });

    test('lifts a sub-thread whose parent is not in this list', () {
      // The parent is pinned, filtered out by a search, or simply not on this
      // phone: the child is still a running agent process and must be reachable.
      final rows = [row('b', parent: 'missing')];
      expect(subthreadRoots(rows).map((r) => r.sessionId), ['b']);
    });
  });

  group('layoutSubthreads', () {
    test('emits each root followed by its subtree, with depth', () {
      final rows = [
        row('a'),
        row('b', parent: 'a'),
        row('c', parent: 'b'),
        row('d'),
      ];

      final nodes = layoutSubthreads(rows);

      expect(nodes.map((n) => n.row.sessionId), ['a', 'b', 'c', 'd']);
      expect(nodes.map((n) => n.depth), [0, 1, 2, 0]);
    });

    test('folds a collapsed parent, and says what is hidden under it', () {
      final rows = [
        row('a'),
        row('b', parent: 'a', state: AgentState.working),
        row('c', parent: 'a'),
      ];

      final nodes = layoutSubthreads(rows, collapsed: {'a'});

      expect(nodes.map((n) => n.row.sessionId), ['a']);
      expect(nodes.single.childCount, 2);
      expect(nodes.single.runningChildCount, 1);
      expect(nodes.single.collapsed, isTrue);
    });

    test('pages by top-level rows, so a parent brings its sub-threads along', () {
      final rows = [
        row('a'),
        row('a1', parent: 'a'),
        row('a2', parent: 'a'),
        row('b'),
        row('c'),
      ];

      final nodes = layoutSubthreads(rows, maxRoots: 2);

      // Two pieces of work — not two rows.
      expect(nodes.map((n) => n.row.sessionId), ['a', 'a1', 'a2', 'b']);
    });

    test('stops at the depth cap rather than drawing a fourth level', () {
      final rows = [
        row('a'),
        row('b', parent: 'a'),
        row('c', parent: 'b'),
        row('d', parent: 'c'),
      ];

      final nodes = layoutSubthreads(rows);

      expect(nodes.map((n) => n.row.sessionId), ['a', 'b', 'c']);
      expect(nodes.every((n) => n.depth < maxSubthreadDepth), isTrue);
    });

    test('renders a cycle flat rather than losing the rows', () {
      final rows = [row('a', parent: 'b'), row('b', parent: 'a')];

      final nodes = layoutSubthreads(rows);

      // Both are reachable, each exactly once, and neither is nested under the
      // other — a looping link must never make a live session unreachable.
      expect(nodes.map((n) => n.row.sessionId), ['a', 'b']);
      expect(nodes.every((n) => n.depth == 0), isTrue);
    });
  });

  group('flattenSubtree', () {
    test('anchors a root plus its descendants even when the root is not a '
        'top-level row itself', () {
      // Mirrors a pinned session: it renders in a featured section by its own
      // id, not because `subthreadRoots` picked it — it may even (rarely)
      // have a parent of its own still present in `rows`.
      final rows = [row('a'), row('b', parent: 'a'), row('c', parent: 'b')];

      final nodes = flattenSubtree(rows, rows[0]);

      expect(nodes.map((n) => n.row.sessionId), ['a', 'b', 'c']);
      expect(nodes.map((n) => n.depth), [0, 1, 2]);
    });

    test('respects collapsed state and the depth cap like layoutSubthreads',
        () {
      final rows = [
        row('a'),
        row('b', parent: 'a', state: AgentState.working),
        row('c', parent: 'a'),
      ];

      final nodes = flattenSubtree(rows, rows[0], collapsed: {'a'});

      expect(nodes.map((n) => n.row.sessionId), ['a']);
      expect(nodes.single.childCount, 2);
      expect(nodes.single.runningChildCount, 1);
    });
  });

  group('subtreeIds', () {
    test('collects a root and every descendant beneath it, depth-uncapped',
        () {
      final rows = [
        row('a'),
        row('b', parent: 'a'),
        row('c', parent: 'b'),
        row('d', parent: 'c'),
        row('e'),
      ];

      expect(subtreeIds(rows, 'a'), {'a', 'b', 'c', 'd'});
    });

    test('a leaf with no children is just itself', () {
      final rows = [row('a'), row('b', parent: 'a')];

      expect(subtreeIds(rows, 'b'), {'b'});
    });
  });
}
