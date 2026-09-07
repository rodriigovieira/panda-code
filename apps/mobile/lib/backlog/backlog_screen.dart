import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../sessions/new_session_screen.dart';
import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import '../widgets/toast/panda_toast.dart';
import 'backlog_item_screen.dart';
import 'backlog_models.dart';

/// The workspace backlog on a phone.
///
/// The desktop shows its columns side by side; a phone cannot, so the columns
/// become tabs and "drag a card across" becomes "move to…" on the card. Same
/// board, same three fields — the only thing that changes is the gesture.
///
/// Pending is a tab only while it holds something, exactly as it is a column
/// only while it holds something on the desktop.
///
/// Every action is a round-trip to the Mac (the board is a file there, shared
/// with the agents working in that folder), so the screen holds no optimistic
/// state: it shows what the desktop last said the board is, and says plainly
/// when the desktop is not answering.
class BacklogScreen extends ConsumerStatefulWidget {
  const BacklogScreen({super.key, required this.cwd, required this.workspaceName});

  final String cwd;
  final String workspaceName;

  @override
  ConsumerState<BacklogScreen> createState() => _BacklogScreenState();
}

class _BacklogScreenState extends ConsumerState<BacklogScreen> with SingleTickerProviderStateMixin {
  /// The columns currently on screen. Not every column is always one of them:
  /// Pending is drawn only while it has something to triage, so the tab bar is
  /// rebuilt (controller and all) whenever that changes under us — an agent
  /// filing a review finding is enough to make the tab appear.
  List<BacklogColumn> _columns = const WorkspaceBacklog().visibleColumns();
  late TabController _tabs = TabController(length: _columns.length, vsync: this);
  WorkspaceBacklog? _board;
  String? _error;
  bool _busy = false;

  /// Whether parked cards are on screen. Off on every open, like the desktop:
  /// putting a card on hold is a request for the board to stop showing it.
  bool _showOnHold = false;

  /// Cards picked up by a long press, across every column/tab. Mirrors the
  /// desktop's ⌘-click selection: non-empty means the board is in "select
  /// mode" and a tap toggles instead of opening.
  final Set<String> _selected = {};

  bool get _selecting => _selected.isNotEmpty;

  /// Selected cards that still exist, in board order — one deleted out from
  /// under the selection (by anyone, from anywhere) drops out rather than
  /// being carried into a prompt as a gap.
  List<BacklogItem> get _selectedItems {
    final board = _board;
    if (board == null) return const [];
    return board.items.where((item) => _selected.contains(item.id)).toList();
  }

  void _toggleSelected(String id) {
    setState(() {
      if (!_selected.remove(id)) _selected.add(id);
    });
  }

  void _clearSelection() => setState(_selected.clear);

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  BacklogColumn get _currentColumn => _columns[_tabs.index.clamp(0, _columns.length - 1)];

  /// Bring the tab bar in line with the board.
  ///
  /// A `TabController` has a fixed length, so a column appearing or vanishing
  /// means a new one. The user's place is kept by column rather than by index —
  /// otherwise a Pending tab arriving on the left would slide the reader from
  /// Backlog into it mid-glance. Call inside `setState`.
  void _syncColumns() {
    final next = (_board ?? const WorkspaceBacklog()).visibleColumns(includeOnHold: _showOnHold);
    if (listEquals(next, _columns)) return;
    final current = _columns.isEmpty ? null : _currentColumn;
    final index = current == null ? 0 : next.indexOf(current);
    _columns = next;
    _tabs.dispose();
    _tabs = TabController(length: next.length, initialIndex: index < 0 ? 0 : index, vsync: this);
  }

  Future<void> _load() => _run(() => _call(op: 'list'), silent: true);

  /// Run one board operation, keeping the screen's busy/error state honest.
  /// [silent] is for the initial load and pull-to-refresh, where a toast on top
  /// of the error card would just say the same thing twice.
  Future<void> _run(Future<WorkspaceBacklog> Function() action, {bool silent = false}) async {
    setState(() {
      _busy = true;
      if (silent) _error = null;
    });
    try {
      final board = await action();
      if (!mounted) return;
      setState(() {
        _board = board;
        _error = null;
        _busy = false;
        _syncColumns();
      });
    } catch (error) {
      if (!mounted) return;
      final message = '$error'.replaceFirst('Exception: ', '');
      setState(() {
        _error = message;
        _busy = false;
      });
      if (!silent) showToast(message, variant: ToastVariant.error);
    }
  }

  Future<WorkspaceBacklog> _call({
    required String op,
    String? id,
    String? title,
    String? summary,
    String? description,
    String? metadata,
    String? column,
    bool? onHold,
  }) async {
    final api = await ref.read(relayApiProvider.future);
    if (api == null) throw Exception('Not paired with a desktop.');
    return api.backlog(
      widget.cwd,
      op: op,
      id: id,
      title: title,
      summary: summary,
      description: description,
      metadata: metadata,
      column: column,
      onHold: onHold,
    );
  }

  Future<void> _compose({BacklogItem? item}) async {
    final result = await Navigator.of(context).push<BacklogEditorResult>(
      MaterialPageRoute(
        builder: (_) => BacklogItemScreen(item: item, column: item?.column ?? _currentColumn),
      ),
    );
    if (result == null) return;

    if (result.delete) {
      if (item != null) await _run(() => _call(op: 'delete', id: item.id));
      return;
    }

    final draft = result.draft!;

    if (result.createSession) {
      if (!mounted) return;
      await showNewSessionSheet(
        context,
        ref,
        workspacePath: widget.cwd,
        prompt: _sessionPrompt([(title: draft.title, description: draft.description)]),
      );
      return;
    }

    await _run(() => _call(
          op: item == null ? 'add' : 'update',
          id: item?.id,
          title: draft.title,
          summary: draft.summary,
          description: draft.description,
          metadata: draft.metadata,
          column: draft.column.wire,
          // Only on an edit: `add` has no notion of filing a card already parked.
          onHold: item == null ? null : draft.onHold,
        ));
  }

  Future<void> _move(BacklogItem item, BacklogColumn column) =>
      _run(() => _call(op: 'update', id: item.id, column: column.wire));

  /// Park a card, or bring it back. The column is left alone on purpose: a card
  /// comes off hold into the same place it was set aside from.
  Future<void> _setHold(BacklogItem item, bool onHold) =>
      _run(() => _call(op: 'update', id: item.id, onHold: onHold));

  Future<void> _delete(BacklogItem item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this item?'),
        content: Text(item.title),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Delete')),
        ],
      ),
    );
    if (confirmed != true) return;
    await _run(() => _call(op: 'delete', id: item.id));
  }

  void _openActions(BacklogItem item) {
    showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.rocket_launch_outlined),
              title: const Text('Start a session from this'),
              onTap: () {
                Navigator.pop(sheetContext);
                _startSession(item);
              },
            ),
            for (final column in BacklogColumn.values)
              // Never "move to Pending": it is automation's inbox, and the only
              // move a person makes there is out of it.
              if (column != item.column && column != BacklogColumn.pending)
                ListTile(
                  leading: const Icon(Icons.arrow_forward),
                  title: Text('Move to ${column.label}'),
                  onTap: () {
                    Navigator.pop(sheetContext);
                    _move(item, column);
                  },
                ),
            ListTile(
              leading: Icon(item.onHold ? Icons.play_arrow_outlined : Icons.pause_outlined),
              title: Text(item.onHold ? 'Take off hold' : 'Put on hold'),
              subtitle: Text(
                item.onHold
                    ? 'Back on the board, in ${item.column.label}'
                    : 'Kept, but off the board until you want it',
              ),
              onTap: () {
                Navigator.pop(sheetContext);
                _setHold(item, !item.onHold);
              },
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline),
              title: const Text('Delete'),
              onTap: () {
                Navigator.pop(sheetContext);
                _delete(item);
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _startSession(BacklogItem item) => _startSessionFrom([item]);

  Future<void> _startSessionFrom(List<BacklogItem> items) async {
    if (items.isEmpty) return;
    _clearSelection();
    await showNewSessionSheet(
      context,
      ref,
      workspacePath: widget.cwd,
      prompt: _sessionPrompt(items.map((item) => (title: item.title, description: item.description))),
    );
  }

  @override
  Widget build(BuildContext context) {
    final board = _board;
    final selecting = _selecting;
    return Scaffold(
      appBar: AppBar(
        leading: selecting
            ? IconButton(
                onPressed: _clearSelection,
                icon: const Icon(Icons.close),
                tooltip: 'Cancel selection',
              )
            : null,
        title: selecting
            ? Text('${_selected.length} selected')
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Backlog'),
                  Text(
                    widget.workspaceName,
                    style: TextStyle(fontSize: 12, color: context.tokens.subtle),
                  ),
                ],
              ),
        actions: selecting
            ? [
                IconButton(
                  onPressed: () => _startSessionFrom(_selectedItems),
                  icon: const Icon(Icons.rocket_launch_outlined),
                  tooltip: 'Start a session from ${_selected.length} card${_selected.length == 1 ? '' : 's'}',
                ),
              ]
            : [
                // Only when there is something behind it — a switch that reveals
                // nothing is a question the user has to answer every time.
                if ((board?.onHold.length ?? 0) > 0)
                  IconButton(
                    onPressed: () => setState(() {
                      _showOnHold = !_showOnHold;
                      // A Pending holding only parked cards appears and
                      // disappears with this switch.
                      _syncColumns();
                    }),
                    isSelected: _showOnHold,
                    icon: const Icon(Icons.pause_circle_outline),
                    selectedIcon: const Icon(Icons.pause_circle_filled),
                    tooltip: _showOnHold ? 'Hide cards on hold' : 'Show ${board!.onHold.length} on hold',
                  ),
                IconButton(
                  onPressed: _busy ? null : _load,
                  icon: const Icon(Icons.refresh),
                  tooltip: 'Refresh',
                ),
              ],
        bottom: TabBar(
          controller: _tabs,
          // Rebuilds the FAB's target column as the user swipes between tabs.
          onTap: (_) => setState(() {}),
          // Scrollable: four labels with counts overflow a phone's width, and a
          // squeezed "In progress (12)" is unreadable.
          isScrollable: _columns.length > 3,
          tabAlignment: _columns.length > 3 ? TabAlignment.start : null,
          tabs: [
            for (final column in _columns)
              Tab(
                text: board == null
                    ? column.label
                    : '${column.label} (${board.inColumn(column, includeOnHold: _showOnHold).length})',
              ),
          ],
        ),
      ),
      floatingActionButton: selecting
          ? null
          : FloatingActionButton(
              onPressed: _busy ? null : () => _compose(),
              tooltip: 'Add to ${_currentColumn.label}',
              child: const Icon(Icons.add),
            ),
      body: Column(
        children: [
          if (_busy) const LinearProgressIndicator(minHeight: 2),
          if (_error != null)
            _ErrorBar(message: _error!, hasBoard: board != null, onRetry: _busy ? null : _load),
          Expanded(
            child: TabBarView(
              controller: _tabs,
              children: [
                for (final column in _columns)
                  RefreshIndicator(
                    onRefresh: _load,
                    child: _ColumnList(
                      items: board?.inColumn(column, includeOnHold: _showOnHold) ?? const [],
                      loading: board == null && _busy,
                      unavailable: board == null && _error != null,
                      column: column,
                      selected: _selected,
                      // A tap while a selection is up toggles instead of opening,
                      // the way a long press starts one; a long press always
                      // toggles, so picking up a second card doesn't reopen the
                      // first.
                      onOpen: (item) =>
                          selecting ? _toggleSelected(item.id) : _compose(item: item),
                      onLongPress: (item) => _toggleSelected(item.id),
                      onActions: _openActions,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorBar extends StatelessWidget {
  const _ErrorBar({required this.message, required this.hasBoard, required this.onRetry});

  final String message;
  final bool hasBoard;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      width: double.infinity,
      color: tokens.danger.wash,
      padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  hasBoard ? 'Couldn’t update backlog. Showing the last loaded board.' : 'Couldn’t load backlog. Try again.',
                  style: TextStyle(color: tokens.danger.text, fontSize: 12),
                ),
                TextButton(
                  onPressed: () => showDialog<void>(
                    context: context,
                    builder: (context) => AlertDialog(
                      title: const Text('Backlog error details'),
                      content: SingleChildScrollView(child: SelectableText(message)),
                      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Close'))],
                    ),
                  ),
                  child: const Text('Details'),
                ),
              ],
            ),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _ColumnList extends StatelessWidget {
  const _ColumnList({
    required this.items,
    required this.loading,
    required this.unavailable,
    required this.column,
    required this.selected,
    required this.onOpen,
    required this.onLongPress,
    required this.onActions,
  });

  final List<BacklogItem> items;
  final bool loading;
  final bool unavailable;
  final BacklogColumn column;
  final Set<String> selected;
  final void Function(BacklogItem) onOpen;
  final void Function(BacklogItem) onLongPress;
  final void Function(BacklogItem) onActions;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (items.isEmpty) {
      // Always scrollable so pull-to-refresh still works on an empty column.
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 60, horizontal: 24),
            child: Text(
              unavailable
                  ? 'Backlog unavailable.'
                  : 'Nothing in ${column.label.toLowerCase()}.',
              textAlign: TextAlign.center,
              style: TextStyle(color: context.tokens.subtle),
            ),
          ),
        ],
      );
    }

    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) => _Card(
        item: items[index],
        isSelected: selected.contains(items[index].id),
        onOpen: () => onOpen(items[index]),
        onLongPress: () => onLongPress(items[index]),
        onActions: () => onActions(items[index]),
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({
    required this.item,
    required this.isSelected,
    required this.onOpen,
    required this.onLongPress,
    required this.onActions,
  });

  final BacklogItem item;
  final bool isSelected;
  final VoidCallback onOpen;
  final VoidCallback onLongPress;
  final VoidCallback onActions;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    // Parked cards read as set-aside rather than as work: dimmed, on the softer
    // surface, still fully legible and still tappable.
    return Opacity(
      opacity: item.onHold ? 0.72 : 1,
      child: Material(
        color: isSelected ? tokens.agent.wash : (item.onHold ? tokens.panelSoft : tokens.panel),
        borderRadius: tokens.radius.mdR,
        child: InkWell(
          onTap: onOpen,
          onLongPress: onLongPress,
          borderRadius: tokens.radius.mdR,
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
            decoration: BoxDecoration(
              borderRadius: tokens.radius.mdR,
              border: Border.all(color: isSelected ? tokens.agent.text : tokens.lineSoft, width: isSelected ? 1.5 : 1),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // The number leads the title, the way it does on the Mac:
                      // it is how the card is named in a prompt (`#12`), so it
                      // has to be readable from the board without opening a card.
                      Text.rich(
                        TextSpan(
                          children: [
                            if (item.ref.isNotEmpty)
                              TextSpan(
                                text: '${item.ref} ',
                                style: TextStyle(color: tokens.subtle, fontWeight: FontWeight.w600),
                              ),
                            TextSpan(text: item.title),
                          ],
                        ),
                        style: TextStyle(
                            color: tokens.text, fontSize: 14, fontWeight: FontWeight.w600),
                      ),
                      // The TL;DR when there is one, and the description only as
                      // a fallback for cards filed before the field existed. The
                      // description is Markdown now, so two clipped lines of it
                      // can open on a heading's `##`; the summary is one plain
                      // line by construction.
                      if (_preview(item).isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          _preview(item),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: tokens.muted, fontSize: 12.5, height: 1.35),
                        ),
                      ],
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          // Leads the row: it is the reason this card is on screen
                          // at all, and the reason it usually is not.
                          if (item.onHold) ...[
                            const _HoldChip(),
                            const SizedBox(width: 8),
                          ],
                          _AuthorChip(item: item),
                          if (item.metadata.isNotEmpty) ...[
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                item.metadata,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(color: tokens.subtle, fontSize: 11),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                ),
                // A checkmark once picked up, in place of the actions button:
                // "move or delete" doesn't apply to a card that's part of a
                // multi-card selection, and the check is the tap that drops it
                // back out again.
                IconButton(
                  onPressed: isSelected ? onLongPress : onActions,
                  icon: Icon(isSelected ? Icons.check_circle : Icons.more_vert),
                  iconSize: 20,
                  color: isSelected ? tokens.agent.text : null,
                  tooltip: isSelected ? 'Deselect' : 'Move or delete',
                  visualDensity: VisualDensity.compact,
                  constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The "on hold" marker, sized like the author chip it sits beside.
class _HoldChip extends StatelessWidget {
  const _HoldChip();

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: tokens.hoverWash,
        borderRadius: tokens.radius.pillR,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.pause, size: 12, color: tokens.subtle),
          const SizedBox(width: 4),
          Text(
            'On hold',
            style: TextStyle(fontSize: 11, color: tokens.subtle),
          ),
        ],
      ),
    );
  }
}

class _AuthorChip extends StatelessWidget {
  const _AuthorChip({required this.item});

  final BacklogItem item;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final agent = item.byAgent;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: agent ? tokens.agent.wash : tokens.hoverWash,
        borderRadius: tokens.radius.pillR,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            agent ? Icons.smart_toy_outlined : Icons.person_outline,
            size: 12,
            color: agent ? tokens.agent.text : tokens.subtle,
          ),
          const SizedBox(width: 4),
          Text(
            agent ? (item.section ?? 'agent') : 'you',
            style: TextStyle(
              fontSize: 11,
              color: agent ? tokens.agent.text : tokens.subtle,
            ),
          ),
        ],
      ),
    );
  }
}

/// The line under a card's title: its TL;DR, or the opening of its description
/// for a card that has none. Markdown markers are stripped from the fallback so
/// a clipped preview never shows a bare `##` or `- `.
String _preview(BacklogItem item) {
  if (item.summary.isNotEmpty) return item.summary;
  return item.description
      .replaceAll(RegExp(r'^\s*(#{1,6}\s+|[-*]\s+|>\s?)', multiLine: true), '')
      .replaceAll(RegExp(r'[`*_]'), '')
      .trim();
}

/// The text a new session's composer is seeded with when it's started from
/// one or more backlog items. One card reads as if the user typed it
/// themselves — title, blank line, body. Several need a boundary, or the next
/// card's title reads as a line of the previous one's description; a rule
/// between blocks is the least opinionated one available. Mirrors
/// `backlogSessionPrompt` in the desktop's shared/backlog.ts.
String _sessionPrompt(Iterable<({String title, String description})> items) {
  return items
      .map((item) => item.description.trim().isEmpty
          ? item.title
          : '${item.title}\n\n${item.description.trim()}')
      .join('\n\n---\n\n');
}
