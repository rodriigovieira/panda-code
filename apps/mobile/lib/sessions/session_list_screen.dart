import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../relay/relay_api.dart';
import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import '../widgets/panda_logo.dart';
import '../widgets/toast/panda_toast.dart';
import 'models.dart';
import 'new_session_screen.dart';
import 'session_view_screen.dart';
import 'settings_screen.dart';
import 'widgets/usage_sheet.dart';

/// Paired home: desktop presence + the list of Claude Code sessions running on
/// the Mac. Tapping one opens its live view.
class SessionListScreen extends ConsumerWidget {
  const SessionListScreen({super.key});

  /// Open a fresh draft sheet. Deliberately does NOT touch the relay: the old
  /// flow fired a `start` the moment the create sheet was dismissed, which left
  /// a running agent nobody had prompted. Now the session is born on send,
  /// inside [showNewSessionSheet]. Offline is not a reason to refuse the sheet
  /// either — composing a draft is a local act, and the composer says so.
  void _createSession(BuildContext context, WidgetRef ref) {
    showNewSessionSheet(context, ref);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statusAsync = ref.watch(deviceStatusProvider);
    final status = statusAsync.valueOrNull;
    final sessions = ref.watch(sessionsStreamProvider);
    // Aged locally as well as read off the relay — a Mac that died stops writing
    // the doc this subscription watches, so the flag alone never goes false.
    final online = ref.watch(desktopOnlineProvider);

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 12,
        title: PandaWordmark(
          subtitle: status?.name,
          subtitleTrailing: _ConnectionPill(
            statusAsync: statusAsync,
            online: online,
            onRetry: () {
              ref.invalidate(deviceStatusProvider);
              ref.invalidate(sessionsStreamProvider);
            },
          ),
        ),
        // One treatment for every app-bar action: a 24pt glyph in a 44pt target,
        // evenly spaced. The "+" used to be an IconButton.filledTonal, which gave
        // it a filled disc the other two did not have — it read as a stray blob
        // rather than a peer. Starting a session is now the FAB's job, so the
        // bar is left with two genuinely secondary actions.
        actions: [
          _BarAction(
            icon: Icons.speed,
            tooltip: 'Plan usage',
            onPressed: () => showUsageSheet(context),
          ),
          _BarAction(
            icon: Icons.settings_outlined,
            tooltip: 'Settings',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const SettingsScreen()),
            ),
          ),
          const SizedBox(width: 4),
        ],
      ),
      // The primary action gets the primary affordance. Extended rather than a
      // bare circle so the label says what it does — on a list of sessions a
      // lone "+" is ambiguous about what it adds.
      // Live even when the Mac is offline: the route only composes a draft, and
      // its composer is what explains that sending needs the desktop back.
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _createSession(context, ref),
        icon: const Icon(Icons.add, size: 22),
        label: const Text('New session'),
        tooltip: 'Compose a new session',
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(sessionsStreamProvider);
          ref.invalidate(deviceStatusProvider);
          await ref.read(sessionsStreamProvider.future);
        },
        child: sessions.when(
          loading: () => const _LoadingSkeleton(),
          error: (e, _) => ListView(
            children: [
              const SizedBox(height: 120),
              Center(
                  child: Text('Could not load sessions:\n$e',
                      textAlign: TextAlign.center)),
            ],
          ),
          data: (rows) => _SessionBody(
            rows: rows,
            online: online,
            onCreate: () => _createSession(context, ref),
          ),
        ),
      ),
    );
  }
}

/// The scrollable list: device header, a pinned section, then one collapsible
/// group per workspace (working directory). Group expansion is local UI state;
/// pins come from [pinnedSessionsProvider].
class _SessionBody extends ConsumerStatefulWidget {
  const _SessionBody({
    required this.rows,
    required this.online,
    required this.onCreate,
  });

  final List<SessionRow> rows;
  final bool online;
  final VoidCallback onCreate;

  @override
  ConsumerState<_SessionBody> createState() => _SessionBodyState();
}

bool _isNeedsApproval(SessionRow r) =>
    (r.runtime?.agentState ?? r.agentState) == AgentState.needsAction;

bool _isEnded(SessionRow r) =>
    r.status == SessionStatus.exited ||
    (r.runtime?.agentState ?? r.agentState) == AgentState.exited;

bool _isActive(SessionRow r) => !_isEnded(r);

/// Sessions shown per workspace before the "Show more" toggle, and how many
/// more each tap reveals — mirrors the desktop's workspace tile paging.
const int _initialVisibleSessions = 5;
const int _visibleSessionsStep = 10;

class _SessionBodyState extends ConsumerState<_SessionBody> {
  /// Workspace names the user has collapsed. Default is expanded.
  final Set<String> _collapsed = <String>{};

  /// How many sessions are currently expanded per workspace name. Absent means
  /// the default [_initialVisibleSessions].
  final Map<String, int> _visibleCounts = <String, int>{};
  final _searchController = TextEditingController();
  String _query = '';
  _StatusFilter _filter = _StatusFilter.all;
  _SortBy _sort = _SortBy.recent;
  bool _showArchived = false;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  bool _matches(SessionRow row, String q) {
    if (q.isEmpty) return true;
    final aliases = ref.read(sessionAliasesProvider).valueOrNull ??
        const <String, String>{};
    final haystack = [
      aliases[row.sessionId] ?? '',
      row.title ?? '',
      row.cwd ?? '',
      row.workspaceName,
      row.runtime?.latestCommand ?? '',
      row.runtime?.latestTool ?? '',
    ].join(' ').toLowerCase();
    return haystack.contains(q);
  }

  bool _passesFilter(SessionRow r) => switch (_filter) {
        _StatusFilter.all => true,
        _StatusFilter.active => _isActive(r),
        _StatusFilter.needsApproval => _isNeedsApproval(r),
        _StatusFilter.ended => _isEnded(r),
      };

  List<SessionRow> _sorted(Iterable<SessionRow> rows) {
    final list = rows.toList();
    int rank(SessionRow r) {
      if (_isNeedsApproval(r)) return 0;
      final s = r.runtime?.agentState ?? r.agentState;
      return switch (s) {
        AgentState.working => 1,
        AgentState.waiting => 2,
        AgentState.needsAction => 0,
        AgentState.exited => 3,
      };
    }

    switch (_sort) {
      case _SortBy.recent:
        // Sort by last prompt time, not last event. Otherwise two sessions
        // running at once trade the top slot on every streamed delta.
        list.sort((a, b) => b.orderKey.compareTo(a.orderKey));
      case _SortBy.name:
        list.sort((a, b) => (a.title ?? '')
            .toLowerCase()
            .compareTo((b.title ?? '').toLowerCase()));
      case _SortBy.status:
        list.sort((a, b) {
          final c = rank(a).compareTo(rank(b));
          return c != 0 ? c : b.orderKey.compareTo(a.orderKey);
        });
    }
    return list;
  }

  @override
  Widget build(BuildContext context) {
    final allRows = widget.rows;
    final online = widget.online;
    final localPinned =
        ref.watch(pinnedSessionsProvider).valueOrNull ?? const <String>{};
    final pinned = {
      ...localPinned,
      ...allRows.where((r) => r.starred).map((r) => r.sessionId),
    };
    final archived =
        ref.watch(archivedSessionsProvider).valueOrNull ?? const {};
    final aliases = ref.watch(sessionAliasesProvider).valueOrNull ?? const {};
    final pinNotifier = ref.read(pinnedSessionsProvider.notifier);
    final archiveNotifier = ref.read(archivedSessionsProvider.notifier);

    final q = _query.trim().toLowerCase();
    final archivedRows =
        allRows.where((r) => archived.contains(r.sessionId)).toList();

    // Base = not archived, matches search + status filter.
    final base = allRows
        .where((r) => !archived.contains(r.sessionId))
        .where((r) => _matches(r, q))
        .where(_passesFilter)
        .toList();

    final workspaceOrder =
        ref.watch(workspaceOrderProvider).valueOrNull ?? const <String>[];

    final needsRows = _sorted(base.where(_isNeedsApproval));
    final needsIds = needsRows.map((r) => r.sessionId).toSet();
    final pinnedRows = _sorted(base.where((r) =>
        pinned.contains(r.sessionId) && !needsIds.contains(r.sessionId)));
    final pinnedIds = pinnedRows.map((r) => r.sessionId).toSet();
    final grouped = _groupByWorkspace(
        base.where((r) =>
            !needsIds.contains(r.sessionId) &&
            !pinnedIds.contains(r.sessionId)),
        workspaceOrder);

    // Commit newly discovered workspaces (to the front) and drop vanished ones
    // into the persisted order, after this frame settles. No-ops when unchanged,
    // so it converges in one extra pass rather than looping.
    final displayNames = grouped.keys.toList();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(workspaceOrderProvider.notifier).reconcile(displayNames);
    });

    Widget tile(SessionRow row, {bool highlight = false}) {
      final alias = aliases[row.sessionId];
      final display = (alias != null && alias.isNotEmpty)
          ? row.copyWith(title: alias)
          : row;
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: _SwipeableTile(
          key: ValueKey(row.sessionId),
          pinned: pinned.contains(row.sessionId),
          archived: archived.contains(row.sessionId),
          onTogglePin: () => pinNotifier.setPinned(
              row.sessionId, !pinned.contains(row.sessionId)),
          onToggleArchive: () => archiveNotifier.toggle(row.sessionId),
          child: _SessionTile(
            row: display,
            enabled: online,
            pinned: pinned.contains(row.sessionId),
            highlight: highlight,
            onLongPress: () => _showSessionSheet(row),
          ),
        ),
      );
    }

    final anyResults =
        needsRows.isNotEmpty || pinnedRows.isNotEmpty || grouped.isNotEmpty;

    return ListView(
      // Bottom pad clears the extended FAB so the last tile stays tappable.
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
      children: [
        if (!online) ...[
          _OfflineBanner(onRetry: () {
            ref.invalidate(deviceStatusProvider);
            ref.invalidate(sessionsStreamProvider);
          }),
        ],
        if (allRows.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: _EmptySessions(onCreate: online ? widget.onCreate : null),
          )
        else ...[
          const SizedBox(height: 12),
          _SearchField(
            controller: _searchController,
            onChanged: (v) => setState(() => _query = v),
            onClear: () => setState(() {
              _query = '';
              _searchController.clear();
            }),
          ),
          SizedBox(height: 10),
          _FilterBar(
            filter: _filter,
            sort: _sort,
            needsApprovalCount: allRows.where(_isNeedsApproval).length,
            onFilter: (f) => setState(() => _filter = f),
            onSort: (s) => setState(() => _sort = s),
          ),
          SizedBox(height: 12),
          if (!anyResults)
            _NoMatches(query: _query.trim().isEmpty ? null : _query.trim())
          else ...[
            if (needsRows.isNotEmpty) ...[
              _SectionHeader(
                  icon: Icons.priority_high,
                  label: 'Needs approval',
                  count: needsRows.length,
                  color: context.tokens.danger.text),
              const SizedBox(height: 8),
              ...needsRows.map((r) => tile(r, highlight: true)),
              const SizedBox(height: 6),
            ],
            if (pinnedRows.isNotEmpty) ...[
              const _SectionHeader(
                  icon: Icons.push_pin, label: 'Pinned', count: null),
              const SizedBox(height: 8),
              ...pinnedRows.map((r) => tile(r)),
              const SizedBox(height: 6),
            ],
            if (grouped.isNotEmpty)
              ReorderableListView(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                buildDefaultDragHandles: false,
                onReorder: (oldIndex, newIndex) {
                  HapticFeedback.selectionClick();
                  ref
                      .read(workspaceOrderProvider.notifier)
                      .reorder(grouped.keys.toList(), oldIndex, newIndex);
                },
                children: [
                  for (final (index, entry) in grouped.entries.indexed)
                    Column(
                      key: ValueKey('ws:${entry.key}'),
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _WorkspaceHeader(
                          name: entry.key,
                          count: entry.value.length,
                          collapsed: _collapsed.contains(entry.key),
                          dragIndex: index,
                          onTap: () => setState(() {
                            if (!_collapsed.remove(entry.key)) {
                              _collapsed.add(entry.key);
                            }
                          }),
                        ),
                        const SizedBox(height: 8),
                        // While searching/filtering, keep groups expanded so
                        // matches aren't hidden behind a collapsed header.
                        if (q.isNotEmpty ||
                            _filter != _StatusFilter.all ||
                            !_collapsed.contains(entry.key))
                          ..._workspaceTiles(entry.key, entry.value, tile),
                        const SizedBox(height: 6),
                      ],
                    ),
                ],
              ),
          ],
          if (archivedRows.isNotEmpty) ...[
            const SizedBox(height: 4),
            TextButton.icon(
              onPressed: () => setState(() => _showArchived = !_showArchived),
              icon: Icon(
                  _showArchived ? Icons.expand_less : Icons.archive_outlined,
                  size: 18),
              label: Text(_showArchived
                  ? 'Hide archived'
                  : 'Show archived (${archivedRows.length})'),
            ),
            if (_showArchived) ..._sorted(archivedRows).map((r) => tile(r)),
          ],
        ],
      ],
    );
  }

  /// Renders a workspace's session tiles, capped at [_initialVisibleSessions]
  /// with a "Show more"/"Show less" toggle — same paging as the desktop.
  List<Widget> _workspaceTiles(
    String workspace,
    List<SessionRow> rows,
    Widget Function(SessionRow) tile,
  ) {
    final total = rows.length;
    final stored = _visibleCounts[workspace] ?? _initialVisibleSessions;
    final visible = stored > total ? total : stored;
    final canShowMore = visible < total;
    final canShowLess = visible > _initialVisibleSessions;
    final moreCount = total - visible < _visibleSessionsStep
        ? total - visible
        : _visibleSessionsStep;
    return [
      ...rows.take(visible).map(tile),
      if (total > _initialVisibleSessions)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(
            children: [
              if (canShowMore)
                TextButton.icon(
                  onPressed: () => setState(() {
                    final next = visible + _visibleSessionsStep;
                    _visibleCounts[workspace] = next < total ? next : total;
                  }),
                  icon: const Icon(Icons.expand_more, size: 18),
                  label: Text('Show $moreCount more'),
                ),
              if (canShowLess)
                TextButton.icon(
                  onPressed: () => setState(() =>
                      _visibleCounts[workspace] = _initialVisibleSessions),
                  icon: const Icon(Icons.expand_less, size: 18),
                  label: const Text('Show less'),
                ),
            ],
          ),
        ),
    ];
  }

  /// Long-press actions for a session — mirrors the desktop's right-click menu:
  /// open, rename, pin, notifications, archive, and (for a live session) stop.
  void _showSessionSheet(SessionRow row) {
    HapticFeedback.selectionClick();
    final aliases = ref.read(sessionAliasesProvider).valueOrNull ??
        const <String, String>{};
    final localPinned =
        ref.read(pinnedSessionsProvider).valueOrNull ?? const <String>{};
    final pinned = row.starred || localPinned.contains(row.sessionId);
    final archived =
        (ref.read(archivedSessionsProvider).valueOrNull ?? const {})
            .contains(row.sessionId);
    final alias = aliases[row.sessionId];
    final displayTitle = (alias != null && alias.isNotEmpty)
        ? alias
        : (row.title ?? row.workspaceName);
    final isActive = _isActive(row);

    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 6),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  displayTitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(ctx)
                      .textTheme
                      .titleSmall
                      ?.copyWith(color: context.tokens.muted),
                ),
              ),
            ),
            ListTile(
              leading: const Icon(Icons.open_in_new),
              title: const Text('Open'),
              onTap: () {
                Navigator.of(ctx).pop();
                _openSession(row);
              },
            ),
            ListTile(
              leading: const Icon(Icons.drive_file_rename_outline),
              title: const Text('Rename'),
              subtitle: alias != null && alias.isNotEmpty
                  ? const Text('Reset to the original name')
                  : null,
              onTap: () {
                Navigator.of(ctx).pop();
                _renameSession(row, alias);
              },
            ),
            ListTile(
              leading: Icon(pinned ? Icons.push_pin : Icons.push_pin_outlined),
              title: Text(pinned ? 'Unpin' : 'Pin'),
              onTap: () {
                Navigator.of(ctx).pop();
                ref
                    .read(pinnedSessionsProvider.notifier)
                    .setPinned(row.sessionId, !pinned);
              },
            ),
            ListTile(
              leading: Icon(row.subscribed
                  ? Icons.notifications_off_outlined
                  : Icons.notifications_active_outlined),
              title: Text(row.subscribed
                  ? 'Unsubscribe from notifications'
                  : 'Subscribe to notifications'),
              onTap: () {
                Navigator.of(ctx).pop();
                _toggleSubscription(row);
              },
            ),
            ListTile(
              leading: Icon(
                  archived ? Icons.unarchive_outlined : Icons.archive_outlined),
              title: Text(archived ? 'Unarchive' : 'Archive'),
              onTap: () {
                Navigator.of(ctx).pop();
                ref
                    .read(archivedSessionsProvider.notifier)
                    .toggle(row.sessionId);
              },
            ),
            if (isActive)
              ListTile(
                leading: Icon(Icons.stop_circle_outlined,
                    color: context.tokens.danger.text),
                title: Text('Stop session',
                    style: TextStyle(color: context.tokens.danger.text)),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _stopSession(row);
                },
              ),
          ],
        ),
      ),
    );
  }

  void _openSession(SessionRow row) {
    final aliases = ref.read(sessionAliasesProvider).valueOrNull ??
        const <String, String>{};
    final alias = aliases[row.sessionId];
    final display =
        (alias != null && alias.isNotEmpty) ? row.copyWith(title: alias) : row;
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => SessionViewScreen(row: display)),
    );
  }

  Future<void> _renameSession(SessionRow row, String? currentAlias) async {
    final controller = TextEditingController(
        text: currentAlias ?? row.title ?? row.workspaceName);
    final result = await showDialog<String?>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rename session'),
        content: TextField(
          controller: controller,
          autofocus: true,
          textInputAction: TextInputAction.done,
          decoration: const InputDecoration(hintText: 'Session name'),
          onSubmitted: (v) => Navigator.of(ctx).pop(v),
        ),
        actions: [
          if (currentAlias != null && currentAlias.isNotEmpty)
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(''),
              child: const Text('Reset'),
            ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(null),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (result == null) return; // cancelled
    await ref
        .read(sessionAliasesProvider.notifier)
        .setAlias(row.sessionId, result);
  }

  Future<void> _stopSession(SessionRow row) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Stop session?'),
        content: Text(
            'This ends the agent running on your Mac. The transcript stays available.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: context.tokens.danger.text),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Stop'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw StateError('Relay is unavailable.');
      await api.stopSession(row.sessionId);
      showToast('Stopping session…', variant: ToastVariant.info);
    } catch (e) {
      showToast('Could not stop session: $e', variant: ToastVariant.error);
    }
  }

  Future<void> _toggleSubscription(SessionRow row) async {
    final next = !row.subscribed;
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) return;
      await api.setSessionSubscription(row.sessionId, subscribed: next);
      // sessions:list re-fires reactively with the new state; just confirm.
      showToast(
          next
              ? 'Subscribed — you’ll be notified about this session.'
              : 'Unsubscribed from this session.',
          variant: ToastVariant.success);
    } catch (_) {
      showToast('Could not update notifications. Try again.',
          variant: ToastVariant.error,
          actionLabel: 'Retry',
          onAction: () => _toggleSubscription(row));
    }
  }

  /// Groups rows by [SessionRow.workspaceName]. Within-group order follows the
  /// active sort. Group order honors the persisted manual [order] so workspaces
  /// hold their place instead of reshuffling to the top on every new event.
  /// Workspaces not yet in [order] (freshly created) sort to the front, newest
  /// activity first, until the reconcile pass commits them.
  Map<String, List<SessionRow>> _groupByWorkspace(
      Iterable<SessionRow> rows, List<String> order) {
    final groups = <String, List<SessionRow>>{};
    for (final row in rows) {
      groups.putIfAbsent(row.workspaceName, () => []).add(row);
    }
    for (final k in groups.keys) {
      groups[k] = _sorted(groups[k]!);
    }
    int recency(List<SessionRow> rs) =>
        rs.map((r) => r.orderKey).fold(0, (m, v) => v > m ? v : m);
    final rank = {for (var i = 0; i < order.length; i++) order[i]: i};
    final entries = groups.entries.toList()
      ..sort((a, b) {
        final ra = rank[a.key];
        final rb = rank[b.key];
        if (ra != null && rb != null) return ra.compareTo(rb);
        if (ra == null && rb == null) {
          return recency(b.value).compareTo(recency(a.value));
        }
        return ra == null ? -1 : 1;
      });
    return {for (final e in entries) e.key: e.value};
  }
}

/// An app-bar action. Exists so every icon in the bar is provably the same
/// size in the same target — they had drifted apart, and a bar of mismatched
/// glyphs is the first thing that makes an app look assembled from parts.
class _BarAction extends StatelessWidget {
  const _BarAction({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return IconButton(
      icon: Icon(icon, size: t.control.iconGlyph),
      tooltip: tooltip,
      onPressed: onPressed,
      color: t.muted,
      constraints: t.control.tapTarget,
      padding: EdgeInsets.zero,
      visualDensity: VisualDensity.standard,
    );
  }
}

enum _StatusFilter { all, active, needsApproval, ended }

enum _SortBy { recent, name, status }

class _FilterBar extends StatelessWidget {
  const _FilterBar({
    required this.filter,
    required this.sort,
    required this.needsApprovalCount,
    required this.onFilter,
    required this.onSort,
  });

  final _StatusFilter filter;
  final _SortBy sort;
  final int needsApprovalCount;
  final ValueChanged<_StatusFilter> onFilter;
  final ValueChanged<_SortBy> onSort;

  String _sortLabel(_SortBy value) => switch (value) {
        _SortBy.recent => 'Most recent',
        _SortBy.name => 'Name',
        _SortBy.status => 'Status',
      };

  IconData _sortIcon(_SortBy value) => switch (value) {
        _SortBy.recent => Icons.schedule,
        _SortBy.name => Icons.sort_by_alpha,
        _SortBy.status => Icons.flag_outlined,
      };

  Future<void> _showSortSheet(BuildContext context) async {
    final picked = await showModalBottomSheet<_SortBy>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) {
        final theme = Theme.of(sheetContext);
        final t = sheetContext.tokens;

        Widget option(_SortBy value) {
          final selected = sort == value;
          return ListTile(
            leading: Icon(_sortIcon(value),
                color: selected ? theme.colorScheme.primary : t.muted),
            title: Text(_sortLabel(value)),
            selected: selected,
            trailing: selected
                ? Icon(Icons.check_circle, color: theme.colorScheme.primary)
                : null,
            onTap: () => Navigator.of(sheetContext).pop(value),
          );
        }

        return SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    'Sort sessions',
                    style: theme.textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
              ),
              option(_SortBy.recent),
              option(_SortBy.name),
              option(_SortBy.status),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
    if (picked != null) onSort(picked);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    Widget chip(String label, _StatusFilter f, {int? badge}) => Padding(
          padding: const EdgeInsets.only(right: 7),
          child: FilterChip(
            label: badge != null && badge > 0
                ? Text('$label · $badge')
                : Text(label),
            selected: filter == f,
            visualDensity: VisualDensity.compact,
            onSelected: (_) => onFilter(f),
          ),
        );

    return Row(
      children: [
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            // Trailing pad so the last chip can scroll clear of the sort button
            // instead of dying under it — it was being sliced mid-word.
            padding: const EdgeInsets.only(right: 4),
            child: Row(
              children: [
                chip('All', _StatusFilter.all),
                chip('Active', _StatusFilter.active),
                chip('Needs approval', _StatusFilter.needsApproval,
                    badge: needsApprovalCount),
                chip('Ended', _StatusFilter.ended),
              ],
            ),
          ),
        ),
        // A hairline separates the scrolling set from the fixed control, so a
        // half-scrolled chip reads as "more to the left" rather than clipped.
        Container(
          width: t.control.borderWidth,
          height: 20,
          margin: const EdgeInsets.symmetric(horizontal: 6),
          color: t.lineSoft,
        ),
        IconButton(
          tooltip: 'Sort',
          icon: Icon(Icons.sort, size: 20, color: t.muted),
          onPressed: () => _showSortSheet(context),
        ),
      ],
    );
  }
}

/// Wraps a tile with swipe-to-pin (→) and swipe-to-archive (←). Uses
/// confirmDismiss to run the action without actually removing the widget.
class _SwipeableTile extends StatelessWidget {
  const _SwipeableTile({
    super.key,
    required this.child,
    required this.pinned,
    required this.archived,
    required this.onTogglePin,
    required this.onToggleArchive,
  });

  final Widget child;
  final bool pinned;
  final bool archived;
  final VoidCallback onTogglePin;
  final VoidCallback onToggleArchive;

  @override
  Widget build(BuildContext context) {
    return Dismissible(
      key: key ?? UniqueKey(),
      background: _swipeBg(
        color: context.tokens.accent.solid,
        onColor: context.tokens.accent.on,
        radius: context.tokens.radius.lg,
        icon: pinned ? Icons.push_pin_outlined : Icons.push_pin,
        label: pinned ? 'Unpin' : 'Pin',
        alignment: Alignment.centerLeft,
      ),
      secondaryBackground: _swipeBg(
        color: context.tokens.panelStrong,
        onColor: context.tokens.text,
        radius: context.tokens.radius.lg,
        icon: archived ? Icons.unarchive : Icons.archive,
        label: archived ? 'Unarchive' : 'Archive',
        alignment: Alignment.centerRight,
      ),
      confirmDismiss: (direction) async {
        if (direction == DismissDirection.startToEnd) {
          onTogglePin();
        } else {
          onToggleArchive();
        }
        return false; // keep the tile; the action already ran
      },
      child: child,
    );
  }

  /// [onColor] is the foreground for this specific action background — a swipe
  /// reveal is a saturated plane, so the label needs that colour's "on" pair
  /// rather than the theme's body text.
  Widget _swipeBg({
    required Color color,
    required Color onColor,
    required double radius,
    required IconData icon,
    required String label,
    required Alignment alignment,
  }) {
    return Container(
      alignment: alignment,
      padding: const EdgeInsets.symmetric(horizontal: 20),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 18, color: onColor),
          const SizedBox(width: 6),
          Text(label,
              style: TextStyle(color: onColor, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: context.tokens.panelStrong.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(10),
        border:
            Border.all(color: context.tokens.warn.edge.withValues(alpha: 0.5)),
      ),
      child: Row(
        children: [
          Icon(Icons.cloud_off, size: 20, color: context.tokens.warn.text),
          const SizedBox(width: 10),
          const Expanded(
            child: Text(
              'Your Mac is offline. Sessions can’t be reached right now.',
              style: TextStyle(fontSize: 13),
            ),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _SearchField extends StatelessWidget {
  const _SearchField({
    required this.controller,
    required this.onChanged,
    required this.onClear,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      onChanged: onChanged,
      textInputAction: TextInputAction.search,
      style: TextStyle(fontSize: 14),
      decoration: InputDecoration(
        hintText: 'Search sessions & workspaces',
        prefixIcon: const Icon(Icons.search, size: 20),
        suffixIcon: controller.text.isEmpty
            ? null
            : IconButton(
                icon: const Icon(Icons.close, size: 18),
                tooltip: 'Clear',
                onPressed: onClear,
              ),
        isDense: true,
        filled: true,
        fillColor: context.tokens.panelHover,
        contentPadding: const EdgeInsets.symmetric(vertical: 12),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
      ),
    );
  }
}

class _NoMatches extends StatelessWidget {
  const _NoMatches({this.query});

  final String? query;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 56),
      child: Column(
        children: [
          Icon(Icons.search_off, size: 40, color: context.tokens.subtle),
          SizedBox(height: 12),
          Text(
              query == null
                  ? 'No sessions match this filter'
                  : 'No sessions match “$query”',
              style: TextStyle(color: context.tokens.subtle)),
        ],
      ),
    );
  }
}

/// Pulsing placeholder cards shown while the first session list loads — reads as
/// "content is coming" rather than a bare spinner.
class _LoadingSkeleton extends StatefulWidget {
  const _LoadingSkeleton();

  @override
  State<_LoadingSkeleton> createState() => _LoadingSkeletonState();
}

class _LoadingSkeletonState extends State<_LoadingSkeleton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Widget _bar(double width, double height) => Container(
        width: width,
        height: height,
        decoration: BoxDecoration(
          color: context.tokens.text,
          borderRadius: BorderRadius.circular(6),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween(begin: 0.35, end: 0.7).animate(
        CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
      ),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          Container(
            height: 78,
            decoration: BoxDecoration(
              color: context.tokens.panelHover,
              borderRadius: BorderRadius.circular(8),
            ),
          ),
          const SizedBox(height: 24),
          _bar(120, 12),
          const SizedBox(height: 14),
          for (var i = 0; i < 4; i++) ...[
            Container(
              height: 74,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: context.tokens.panelHover,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _bar(14, 14),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _bar(double.infinity, 13),
                        const SizedBox(height: 10),
                        _bar(140, 10),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.icon,
    required this.label,
    required this.count,
    this.color,
  });

  final IconData icon;
  final String label;
  final int? count;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(left: 2, top: 4, bottom: 2),
      child: Row(
        children: [
          Icon(icon, size: 15, color: color ?? theme.colorScheme.primary),
          SizedBox(width: 8),
          Text(
            label.toUpperCase(),
            style: theme.textTheme.labelMedium?.copyWith(
              color: context.tokens.muted,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.6,
            ),
          ),
          if (count != null) ...[
            SizedBox(width: 8),
            Text('$count',
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: context.tokens.subtle)),
          ],
        ],
      ),
    );
  }
}

class _WorkspaceHeader extends StatelessWidget {
  const _WorkspaceHeader({
    required this.name,
    required this.count,
    required this.collapsed,
    required this.onTap,
    required this.dragIndex,
  });

  final String name;
  final int count;
  final bool collapsed;
  final VoidCallback onTap;

  /// Index of this workspace within the reorderable list — drives the
  /// long-press drag handle so the order can be rearranged and persisted.
  final int dragIndex;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 6),
        child: Row(
          children: [
            Icon(
              collapsed ? Icons.chevron_right : Icons.expand_more,
              size: 18,
              color: context.tokens.subtle,
            ),
            SizedBox(width: 4),
            Icon(Icons.folder_outlined,
                size: 15, color: theme.colorScheme.primary),
            SizedBox(width: 8),
            Expanded(
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: context.tokens.muted,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.4,
                ),
              ),
            ),
            SizedBox(width: 8),
            Text('$count',
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: context.tokens.subtle)),
            ReorderableDragStartListener(
              index: dragIndex,
              child: Padding(
                padding: const EdgeInsets.only(left: 4),
                child: Icon(Icons.drag_handle,
                    size: 18, color: context.tokens.subtle),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Compact session row modeled on the desktop sidebar item: a status badge on
/// the left, the title in the middle, and the relative timestamp on the right.
/// Long-press opens the actions sheet (rename, pin, archive, stop, …).
class _SessionTile extends StatelessWidget {
  const _SessionTile({
    required this.row,
    required this.enabled,
    required this.pinned,
    required this.onLongPress,
    this.highlight = false,
  });

  final SessionRow row;
  final bool enabled;
  final bool pinned;
  final bool highlight;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final state = row.runtime?.agentState ?? row.agentState;

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      shape: highlight
          ? RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: BorderSide(color: context.tokens.danger.text, width: 1.2),
            )
          : null,
      child: InkWell(
        onTap: enabled
            ? () => Navigator.of(context).push(
                  MaterialPageRoute(
                      builder: (_) => SessionViewScreen(row: row)),
                )
            : null,
        onLongPress: onLongPress,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: [
              // `enabled` is the desktop's reachability: a row still claiming
              // "working" while the Mac is gone is stale, not live.
              _AgentBadge(
                status: row.status,
                agentState: state,
                desktopOffline: !enabled,
              ),
              SizedBox(width: 10),
              Expanded(
                child: Text(
                  _sessionTitle(row),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleSmall
                      ?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              if (pinned) ...[
                SizedBox(width: 6),
                Icon(Icons.push_pin,
                    size: 13, color: theme.colorScheme.primary),
              ],
              const SizedBox(width: 8),
              Text(
                _relativeUpdatedAt(row.updatedAt),
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: context.tokens.subtle),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmptySessions extends StatelessWidget {
  const _EmptySessions({required this.onCreate});

  final VoidCallback? onCreate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 64),
      child: Column(
        children: [
          const PandaLogo(size: 64),
          SizedBox(height: 16),
          Text('No sessions yet', style: theme.textTheme.titleMedium),
          SizedBox(height: 6),
          Text('Start one on your Mac or tap New below.',
              style: TextStyle(color: context.tokens.subtle, fontSize: 13)),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: onCreate,
            icon: const Icon(Icons.add),
            label: const Text('Create session'),
          ),
        ],
      ),
    );
  }
}

/// Icon-only status indicator at the left of a session tile. Dropping the text
/// label frees width for the title; color + glyph still say what's happening at
/// a glance — a spinner while working, a pulsing "!" when the agent needs you,
/// red for an error, a check when ready, a muted dot when ended. The full label
/// rides a tooltip for long-press / accessibility.
class _AgentBadge extends StatefulWidget {
  const _AgentBadge({
    required this.status,
    required this.agentState,
    this.desktopOffline = false,
  });

  final SessionStatus status;
  final AgentState agentState;

  /// The paired Mac is unreachable. Only the desktop ever writes a session's
  /// terminal state, so a force-quit leaves rows frozen mid-turn — spinning on
  /// them would promise work that stopped happening. Show the truth instead.
  final bool desktopOffline;

  @override
  State<_AgentBadge> createState() => _AgentBadgeState();
}

class _AgentBadgeState extends State<_AgentBadge>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 850),
  );

  // The "needs you" state pulses to pull the eye; everything else is static.
  bool get _needsAttention =>
      widget.status != SessionStatus.error &&
      !_stale &&
      widget.agentState == AgentState.needsAction;

  /// Mid-turn state we can no longer trust, because the Mac that would have
  /// finished it is gone. The relay demotes these rows within the minute; this
  /// is what the phone shows in the meantime.
  bool get _stale =>
      widget.desktopOffline &&
      (widget.agentState == AgentState.working ||
          widget.agentState == AgentState.needsAction);

  @override
  void initState() {
    super.initState();
    if (_needsAttention) _pulse.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(_AgentBadge old) {
    super.didUpdateWidget(old);
    if (_needsAttention && !_pulse.isAnimating) {
      _pulse.repeat(reverse: true);
    } else if (!_needsAttention && _pulse.isAnimating) {
      _pulse
        ..stop()
        ..value = 0;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final error = widget.status == SessionStatus.error;
    final (color, glyph) = _visual(t, error);

    Widget badge = Container(
      width: 28,
      height: 28,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        shape: BoxShape.circle,
      ),
      child: glyph,
    );

    // Honor the OS "reduce motion" setting for the attention pulse.
    if (_needsAttention && !MediaQuery.of(context).disableAnimations) {
      badge = ScaleTransition(
        scale: Tween<double>(begin: 0.86, end: 1.08).animate(
          CurvedAnimation(parent: _pulse, curve: Curves.easeInOut),
        ),
        child: badge,
      );
    }

    return Tooltip(
      message: error
          ? 'Error'
          : _stale
              ? 'Mac offline'
              : _stateLabel(widget.agentState),
      child: badge,
    );
  }

  /// The five states, in the shared design system's semantics — identical to the
  /// desktop `.agent-badge` rules: info = working, warn = wants you, run = ready for
  /// you, danger = failed, subtle = ended. These used to be Material defaults, which
  /// is how desktop ended up drawing "working" green while mobile drew it blue.
  (Color, Widget) _visual(PandaTokens t, bool error) {
    if (error) {
      return (
        t.danger.text,
        Icon(Icons.error_outline, size: 17, color: t.danger.text),
      );
    }
    if (_stale) {
      return (t.subtle, Icon(Icons.cloud_off_outlined, size: 16, color: t.subtle));
    }
    switch (widget.agentState) {
      case AgentState.working:
        final c = t.info.text;
        return (
          c,
          SizedBox(
            width: 15,
            height: 15,
            child: CircularProgressIndicator(strokeWidth: 2.2, color: c),
          ),
        );
      case AgentState.needsAction:
        final c = t.warn.text;
        return (c, Icon(Icons.priority_high, size: 18, color: c));
      case AgentState.waiting:
        final c = t.run.text; // "ready for you"
        return (c, Icon(Icons.check_rounded, size: 17, color: c));
      case AgentState.exited:
        final c = t.subtle;
        return (c, Icon(Icons.circle, size: 9, color: c));
    }
  }
}

/// Compact connection status pill shown beside the device name. Green when the
/// Mac is online; amber when the Mac is offline; red when we can't reach the
/// relay at all. Tapping a warning/error pill explains what's wrong and offers
/// a retry — the healthy/connecting pills are inert.
class _ConnectionPill extends StatelessWidget {
  const _ConnectionPill({
    required this.statusAsync,
    required this.online,
    required this.onRetry,
  });

  final AsyncValue<DeviceStatus?> statusAsync;
  /// Heartbeat-aged presence, not the raw `status.online` flag.
  final bool online;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final (color, label, detail) = _resolve(context);
    // When everything is healthy the dot alone carries it — the word "Online" is
    // the one thing the colour already says, and dropping it stops the device name
    // beside it from wrapping onto a second line. Degraded states keep their label,
    // because amber on its own does not tell you *which* thing is offline.
    final healthy = detail == null;
    final pill = Container(
      // A bare status dot sits inline with 11px subtitle text, so it has to be
      // sized for that, not for a standalone control. At 22px it read as a
      // floating blob next to the device name.
      width: healthy ? 14 : null,
      height: healthy ? 14 : 22,
      alignment: Alignment.center,
      padding:
          healthy ? EdgeInsets.zero : const EdgeInsets.symmetric(horizontal: 9),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.5), width: 0.8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: healthy ? 8 : 7,
            height: healthy ? 8 : 7,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          if (!healthy) ...[
            const SizedBox(width: 5),
            Text(label,
                style: TextStyle(
                    color: color, fontSize: 10.5, fontWeight: FontWeight.w700)),
            const SizedBox(width: 3),
            Icon(Icons.info_outline, size: 12, color: color),
          ],
        ],
      ),
    );
    // The label still reaches assistive tech and long-press even when unpainted.
    if (healthy) {
      return Tooltip(
        message: label,
        child: Semantics(label: label, child: pill),
      );
    }
    return InkWell(
      borderRadius: BorderRadius.circular(999),
      onTap: () => _showDetail(context, label, detail, color),
      child: pill,
    );
  }

  /// (color, short label, tap-to-explain detail or null when healthy).
  (Color, String, String?) _resolve(BuildContext context) {
    final t = context.tokens;
    if (statusAsync.isLoading && !statusAsync.hasValue) {
      return (t.subtle, 'Connecting', null);
    }
    if (statusAsync.hasError) {
      return (
        t.danger.text,
        'Disconnected',
        'Panda Code couldn’t reach the relay.\n\n${statusAsync.error}',
      );
    }
    final status = statusAsync.valueOrNull;
    if (status == null) {
      return (
        t.danger.text,
        'Disconnected',
        'Panda Code can’t reach the relay right now. Check your phone’s '
            'internet connection, then retry.',
      );
    }
    if (online) {
      return (t.run.text, 'Online', null);
    }
    return (
      t.warn.text,
      'Mac offline',
      'Your Mac isn’t connected to the relay right now.\n\nOpen Panda Code '
          '(or Claude Code) on your Mac and make sure it has internet — your '
          'sessions will reconnect automatically.',
    );
  }

  void _showDetail(
      BuildContext context, String title, String detail, Color color) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: Icon(Icons.info_outline, color: color),
        title: Text(title),
        content: Text(detail),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Close'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              onRetry();
            },
            child: const Text('Retry'),
          ),
        ],
      ),
    );
  }
}

/// The label shown for a session tile. Prefer the synchronized title (AI- or
/// prompt-derived on the desktop); never fall back to the raw session id — a
/// human-readable placeholder reads far better while the title is loading or
/// for runtimes that don't emit one yet.
String _sessionTitle(SessionRow row) {
  final title = row.title?.trim();
  if (title != null && title.isNotEmpty) return title;
  return 'Untitled session';
}

String _stateLabel(AgentState state) => switch (state) {
      AgentState.working => 'Working',
      AgentState.waiting => 'Ready',
      AgentState.needsAction => 'Needs approval',
      AgentState.exited => 'Ended',
    };

String _relativeUpdatedAt(int updatedAt) {
  if (updatedAt <= 0) return 'just now';
  final elapsed =
      DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(updatedAt));
  if (elapsed.inMinutes < 1) return 'just now';
  if (elapsed.inHours < 1) return '${elapsed.inMinutes}m ago';
  if (elapsed.inDays < 1) return '${elapsed.inHours}h ago';
  return '${elapsed.inDays}d ago';
}
