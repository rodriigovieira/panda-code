import 'models.dart';

/// Nesting rules for the session list, kept out of the widget layer.
///
/// A sub-thread is a session the agent (or the user) opened underneath another
/// one — the phone's half of the desktop sidebar's tree. The list has to answer
/// three questions cheaply and consistently: which rows are top-level, which
/// rows hang under them, and how deep each one is drawn. Doing that inline in
/// `build` is how the two surfaces drift apart, so it lives here and is tested
/// directly.

/// The deepest level drawn. Mirrors the desktop's `MAX_SUBTHREAD_DEPTH`: the
/// link writers enforce it, and this is the belt-and-braces for a tree that
/// arrived from an older desktop that did not.
const int maxSubthreadDepth = 3;

/// One row as the list will draw it: the session, how far to indent it, and
/// what is folded away underneath.
class SessionNode {
  final SessionRow row;

  /// 0 for a top-level session, 1 for its sub-threads, and so on.
  final int depth;

  /// Direct sub-threads, whether or not they are currently shown.
  final int childCount;

  /// How many of those are mid-turn — the reason a collapsed parent still
  /// deserves a badge: work you cannot see is happening under it.
  final int runningChildCount;

  /// True when this node has children and they are folded away.
  final bool collapsed;

  const SessionNode({
    required this.row,
    required this.depth,
    this.childCount = 0,
    this.runningChildCount = 0,
    this.collapsed = false,
  });

  bool get hasChildren => childCount > 0;
}

bool _isRunning(SessionRow row) =>
    row.agentState == AgentState.working;

/// The top-level rows of [rows], in the order given.
///
/// A row is top-level when it has no parent, or when its parent is not in this
/// list at all — a sub-thread whose parent is pinned, filtered out by a search,
/// or simply not on this phone yet must still be reachable. Orphaning it into
/// invisibility is the one outcome worth ruling out: it is a running agent
/// process either way.
/// A row is also top-level when its parent chain LOOPS. Nothing in the app can
/// write a cycle, but a hand-edited desktop `threads.json` can send one over the
/// wire — and with a cycle every row in it has a present parent, so a plain
/// "no parent" test makes all of them children of each other and the list simply
/// loses them. Rendering them flat is the failure worth having.
List<SessionRow> subthreadRoots(List<SessionRow> rows) {
  final byId = {for (final row in rows) row.sessionId: row};
  bool isRoot(SessionRow row) {
    final parent = row.parentSessionId;
    if (parent == null || !byId.containsKey(parent)) return true;
    final seen = <String>{row.sessionId};
    var current = parent;
    while (byId.containsKey(current)) {
      if (!seen.add(current)) return true;
      final next = byId[current]!.parentSessionId;
      if (next == null) return false;
      current = next;
    }
    return false;
  }

  return rows.where(isRoot).toList();
}

/// Flatten [rows] into render order: each root followed by its visible subtree.
///
/// [collapsed] holds the session ids whose children are folded away. [maxRoots]
/// pages the list by TOP-LEVEL rows — a parent brings its sub-threads with it,
/// so "show 5 more" reveals five more pieces of work rather than five more rows
/// that might all belong to the same one.
List<SessionNode> layoutSubthreads(
  List<SessionRow> rows, {
  Set<String> collapsed = const <String>{},
  int? maxRoots,
}) {
  final roots = subthreadRoots(rows);
  final rootIds = roots.map((row) => row.sessionId).toSet();
  final childrenByParent = _childrenByParent(rows, excludeAsChild: rootIds);

  final visibleRoots =
      maxRoots == null || maxRoots >= roots.length ? roots : roots.take(maxRoots);

  final nodes = <SessionNode>[];
  for (final root in visibleRoots) {
    nodes.addAll(_walkSubtree(root, 0, childrenByParent, collapsed));
  }
  return nodes;
}

/// `parentSessionId` → its direct children, restricted to rows present in
/// [rows]. [excludeAsChild] are ids that must never be filed as somebody's
/// child even if their `parentSessionId` says so — a row that renders at the
/// top (a root, or a session lifted out to a featured section) must not ALSO
/// render nested under something, since then two tiles share one session and
/// disagree about which is selected/expanded.
Map<String, List<SessionRow>> _childrenByParent(
  List<SessionRow> rows, {
  Set<String> excludeAsChild = const <String>{},
}) {
  final present = rows.map((row) => row.sessionId).toSet();
  final byParent = <String, List<SessionRow>>{};
  for (final row in rows) {
    final parent = row.parentSessionId;
    if (parent == null ||
        !present.contains(parent) ||
        excludeAsChild.contains(row.sessionId)) {
      continue;
    }
    byParent.putIfAbsent(parent, () => <SessionRow>[]).add(row);
  }
  return byParent;
}

// Iterative rather than recursive, and depth-capped: a `parentSessionId`
// cycle cannot be written by this app, but it CAN arrive over the wire from a
// desktop that was hand-edited, and a stack overflow in the session list is a
// phone that cannot be used at all.
List<SessionNode> _walkSubtree(
  SessionRow row,
  int depth,
  Map<String, List<SessionRow>> childrenByParent,
  Set<String> collapsed, {
  Set<String>? seen,
}) {
  seen ??= <String>{row.sessionId};
  final children = childrenByParent[row.sessionId] ?? const <SessionRow>[];
  final isCollapsed = collapsed.contains(row.sessionId);
  final nodes = <SessionNode>[
    SessionNode(
      row: row,
      depth: depth,
      childCount: children.length,
      runningChildCount: children.where(_isRunning).length,
      collapsed: isCollapsed && children.isNotEmpty,
    ),
  ];
  if (isCollapsed || depth + 1 >= maxSubthreadDepth) return nodes;
  for (final child in children) {
    if (!seen.add(child.sessionId)) continue;
    nodes.addAll(_walkSubtree(child, depth + 1, childrenByParent, collapsed,
        seen: seen));
  }
  return nodes;
}

/// [root] followed by its visible descendants within [rows], depth-capped and
/// respecting [collapsed] — the same rules as [layoutSubthreads], but rooted
/// at one explicit session rather than at every top-level row in [rows].
///
/// For a session that is lifted out of the workspace tree into a featured
/// section (needs-approval, pinned), this is what lets its children keep
/// rendering nested under it there — instead of only the parent row moving
/// while its children stay behind in the workspace list, indented but with
/// no visible parent, appearing to belong to whatever unrelated session
/// happens to render immediately before them.
List<SessionNode> flattenSubtree(
  List<SessionRow> rows,
  SessionRow root, {
  Set<String> collapsed = const <String>{},
}) {
  final childrenByParent = _childrenByParent(rows, excludeAsChild: {root.sessionId});
  return _walkSubtree(root, 0, childrenByParent, collapsed);
}

/// [root]'s id plus every id reachable by following `parentSessionId` edges
/// forward from it (its full transitive subtree). Depth-uncapped, unlike
/// rendering: a great-grandchild that is too deep to draw nested still must
/// not fall back to rendering as a flat top-level row elsewhere.
Set<String> subtreeIds(List<SessionRow> rows, String rootId) {
  final childrenByParent = _childrenByParent(rows);
  final ids = <String>{rootId};
  final queue = <String>[rootId];
  while (queue.isNotEmpty) {
    final id = queue.removeLast();
    for (final child in childrenByParent[id] ?? const <SessionRow>[]) {
      if (ids.add(child.sessionId)) queue.add(child.sessionId);
    }
  }
  return ids;
}
