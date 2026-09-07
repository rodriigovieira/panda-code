import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import 'document_screen.dart';
import 'git_status_models.dart';

/// A workspace's git — status, commit history and file tree — view-only on the
/// phone. The same three reads the desktop's own git drawer offers (see
/// `App.tsx`), round-tripped read-only over the relay (see `relay_api.dart`'s
/// `gitStatus()`, `gitLog()` and `gitTree()`). No mutation path: the phone
/// looks, the Mac writes. Markdown and other text files do open, in the app's
/// own reader — see [DocumentScreen].
class GitStatusScreen extends ConsumerStatefulWidget {
  const GitStatusScreen(
      {super.key, required this.cwd, required this.workspaceName});

  final String cwd;
  final String workspaceName;

  @override
  ConsumerState<GitStatusScreen> createState() => _GitStatusScreenState();
}

class _GitStatusScreenState extends ConsumerState<GitStatusScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;

  /// Bumped by the app bar's refresh button. Each tab watches it and reloads,
  /// so one button refreshes whichever tab is actually on screen without this
  /// screen having to own three different loads.
  int _reloadTick = 0;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 4, vsync: this);
    _tabs.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Git'),
            Text(
              widget.workspaceName,
              style: TextStyle(fontSize: 12, color: context.tokens.subtle),
            ),
          ],
        ),
        actions: [
          IconButton(
            onPressed: () => setState(() => _reloadTick++),
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
        bottom: TabBar(
          controller: _tabs,
          tabs: const [
            Tab(text: 'Status'),
            Tab(text: 'History'),
            Tab(text: 'Actions'),
            Tab(text: 'Files'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [
          _GitStatusTab(cwd: widget.cwd, reloadTick: _reloadTick),
          _GitHistoryTab(cwd: widget.cwd, reloadTick: _reloadTick),
          _GitActionsTab(cwd: widget.cwd, reloadTick: _reloadTick),
          _GitFilesTab(cwd: widget.cwd, reloadTick: _reloadTick),
        ],
      ),
    );
  }
}

class _GitStatusTab extends ConsumerStatefulWidget {
  const _GitStatusTab({required this.cwd, required this.reloadTick});

  final String cwd;
  final int reloadTick;

  @override
  ConsumerState<_GitStatusTab> createState() => _GitStatusTabState();
}

class _GitStatusTabState extends ConsumerState<_GitStatusTab>
    with AutomaticKeepAliveClientMixin {
  WorkspaceGitStatus? _status;
  String? _error;
  bool _busy = false;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant _GitStatusTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.reloadTick != widget.reloadTick) _load();
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final status = await api.gitStatus(widget.cwd);
      if (!mounted) return;
      setState(() {
        _status = status;
        _busy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '$error'.replaceFirst('Exception: ', '');
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final status = _status;
    return Column(
      children: [
        if (_busy) const LinearProgressIndicator(minHeight: 2),
        if (_error != null) _ErrorBar(message: _error!, onRetry: _load),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: status == null
                ? (_busy
                    ? const Center(child: CircularProgressIndicator())
                    : ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        children: const [],
                      ))
                : _GitStatusBody(status: status),
          ),
        ),
      ],
    );
  }
}

/// Commits per page. Matches the desktop drawer's page size, so the same repo
/// reads the same way on both screens.
const int _gitLogPageSize = 50;

/// The workspace's commit history, a page at a time.
class _GitHistoryTab extends ConsumerStatefulWidget {
  const _GitHistoryTab({required this.cwd, required this.reloadTick});

  final String cwd;
  final int reloadTick;

  @override
  ConsumerState<_GitHistoryTab> createState() => _GitHistoryTabState();
}

class _GitHistoryTabState extends ConsumerState<_GitHistoryTab>
    with AutomaticKeepAliveClientMixin {
  final List<WorkspaceGitCommit> _commits = [];
  int _page = 0;
  bool _hasMore = false;
  bool _busy = false;
  String? _error;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load(0);
  }

  @override
  void didUpdateWidget(covariant _GitHistoryTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.reloadTick != widget.reloadTick) _load(_page);
  }

  Future<void> _load(int page) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final log = await api.gitLog(widget.cwd,
          skip: page * _gitLogPageSize, limit: _gitLogPageSize);
      if (!mounted) return;
      setState(() {
        _page = page;
        _commits
          ..clear()
          ..addAll(log.commits);
        _hasMore = log.hasMore;
        _error = log.error;
        _busy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '$error'.replaceFirst('Exception: ', '');
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final tokens = context.tokens;
    return Column(
      children: [
        if (_busy) const LinearProgressIndicator(minHeight: 2),
        if (_error != null && _commits.isEmpty)
          _ErrorBar(message: _error!, onRetry: () => _load(_page)),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () => _load(_page),
            child: _commits.isEmpty
                ? (_busy
                    ? const Center(child: CircularProgressIndicator())
                    : ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.all(24),
                        children: [
                          const SizedBox(height: 36),
                          Text(
                            _error ?? 'No commits yet.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: tokens.subtle),
                          ),
                        ],
                      ))
                : ListView.builder(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                    itemCount: _commits.length + 1,
                    itemBuilder: (context, index) {
                      if (index < _commits.length) {
                        return _CommitRow(commit: _commits[index]);
                      }
                      return _HistoryPager(
                        page: _page,
                        hasMore: _hasMore,
                        busy: _busy,
                        onNewer: () => _load(_page - 1),
                        onOlder: () => _load(_page + 1),
                      );
                    },
                  ),
          ),
        ),
      ],
    );
  }
}

class _HistoryPager extends StatelessWidget {
  const _HistoryPager({
    required this.page,
    required this.hasMore,
    required this.busy,
    required this.onNewer,
    required this.onOlder,
  });

  final int page;
  final bool hasMore;
  final bool busy;
  final VoidCallback onNewer;
  final VoidCallback onOlder;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          TextButton.icon(
            onPressed: page == 0 || busy ? null : onNewer,
            icon: const Icon(Icons.arrow_upward, size: 15),
            label: const Text('Newer'),
          ),
          Text('page ${page + 1}',
              style: TextStyle(color: context.tokens.subtle, fontSize: 12)),
          TextButton.icon(
            onPressed: !hasMore || busy ? null : onOlder,
            icon: const Icon(Icons.arrow_downward, size: 15),
            label: const Text('Older'),
          ),
        ],
      ),
    );
  }
}

class _CommitRow extends StatelessWidget {
  const _CommitRow({required this.commit});

  final WorkspaceGitCommit commit;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            commit.subject.isEmpty ? '(no message)' : commit.subject,
            style: TextStyle(color: tokens.text, fontSize: 13.5),
          ),
          const SizedBox(height: 3),
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 3,
            children: [
              Text(
                commit.shortHash,
                style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: tokens.accent.text),
              ),
              Text(commit.author,
                  style: TextStyle(color: tokens.subtle, fontSize: 11.5)),
              if (commit.date != null)
                Text(_relativeAge(commit.date!),
                    style: TextStyle(color: tokens.subtle, fontSize: 11.5)),
              ...commit.refs.map(
                (ref) => Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: tokens.accent.wash,
                    borderRadius: tokens.radius.pillR,
                  ),
                  child: Text(ref,
                      style:
                          TextStyle(color: tokens.accent.text, fontSize: 10.5)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

const int _workflowBatchSize = 10;

class _GitActionsTab extends ConsumerStatefulWidget {
  const _GitActionsTab({required this.cwd, required this.reloadTick});

  final String cwd;
  final int reloadTick;

  @override
  ConsumerState<_GitActionsTab> createState() => _GitActionsTabState();
}

class _GitActionsTabState extends ConsumerState<_GitActionsTab>
    with AutomaticKeepAliveClientMixin {
  List<WorkspaceWorkflowRun> _runs = const [];
  int _limit = _workflowBatchSize;
  bool _hasMore = false;
  bool _busy = false;
  String? _error;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant _GitActionsTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.reloadTick != widget.reloadTick) _load();
  }

  Future<void> _load({int? limit}) async {
    final requestedLimit = limit ?? _limit;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final workflows =
          await api.gitWorkflows(widget.cwd, limit: requestedLimit);
      if (!mounted) return;
      setState(() {
        _limit = requestedLimit;
        _runs = workflows.runs;
        _hasMore = workflows.hasMore;
        _error = workflows.error;
        _busy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '$error'.replaceFirst('Exception: ', '');
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final tokens = context.tokens;
    return Column(
      children: [
        if (_busy) const LinearProgressIndicator(minHeight: 2),
        if (_error != null && _runs.isNotEmpty)
          _ErrorBar(message: _error!, onRetry: _load),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: _runs.isEmpty
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(24),
                    children: [
                      const SizedBox(height: 36),
                      if (_busy)
                        const Center(child: CircularProgressIndicator())
                      else ...[
                        Text(
                          _error ?? 'No workflow runs yet.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: tokens.subtle),
                        ),
                        const SizedBox(height: 12),
                        Center(
                            child: TextButton(
                                onPressed: _load, child: const Text('Retry'))),
                      ],
                    ],
                  )
                : ListView.builder(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                    itemCount: _runs.length + (_hasMore ? 1 : 0),
                    itemBuilder: (context, index) {
                      if (index < _runs.length) {
                        return _WorkflowRunRow(run: _runs[index]);
                      }
                      return Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: Center(
                          child: OutlinedButton(
                            onPressed: _busy
                                ? null
                                : () =>
                                    _load(limit: _limit + _workflowBatchSize),
                            child: Text(_busy ? 'Loading…' : 'See 10 more'),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ),
      ],
    );
  }
}

class _WorkflowRunRow extends StatelessWidget {
  const _WorkflowRunRow({required this.run});

  final WorkspaceWorkflowRun run;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final active = run.status != 'completed';
    final success = run.conclusion == 'success';
    final failed = const {
      'failure',
      'timed_out',
      'cancelled',
      'action_required'
    }.contains(run.conclusion);
    final color = active
        ? tokens.warn.text
        : success
            ? tokens.run.text
            : failed
                ? tokens.danger.text
                : tokens.muted;
    final icon = active
        ? Icons.pending_outlined
        : success
            ? Icons.check_circle_outline
            : failed
                ? Icons.cancel_outlined
                : Icons.remove_circle_outline;
    final result = (active ? run.status : (run.conclusion ?? 'completed'))
        .replaceAll('_', ' ');

    return InkWell(
      borderRadius: tokens.radius.mdR,
      onTap: run.url.isEmpty
          ? null
          : () async {
              final uri = Uri.tryParse(run.url);
              if (uri != null) {
                await launchUrl(uri, mode: LaunchMode.externalApplication);
              }
            },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 9),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Icon(icon, color: color, size: 20),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    run.displayTitle.isEmpty ? run.name : run.displayTitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        color: tokens.text,
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 7,
                    runSpacing: 3,
                    children: [
                      Text(run.name,
                          style:
                              TextStyle(color: tokens.subtle, fontSize: 11.5)),
                      if (run.headBranch.isNotEmpty)
                        Text(run.headBranch,
                            style: TextStyle(
                                color: tokens.accent.text, fontSize: 11.5)),
                      if (run.createdAt != null)
                        Text(_relativeAge(run.createdAt!),
                            style: TextStyle(
                                color: tokens.subtle, fontSize: 11.5)),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(result, style: TextStyle(color: color, fontSize: 11.5)),
            if (run.url.isNotEmpty) ...[
              const SizedBox(width: 4),
              Icon(Icons.open_in_new, size: 14, color: tokens.subtle),
            ],
          ],
        ),
      ),
    );
  }
}

/// The workspace as a file tree, read one level at a time as folders are
/// expanded. Tapping a folder expands it; tapping a document opens it in the
/// reader. Everything else is still just "what is in here".
class _GitFilesTab extends ConsumerStatefulWidget {
  const _GitFilesTab({required this.cwd, required this.reloadTick});

  final String cwd;
  final int reloadTick;

  @override
  ConsumerState<_GitFilesTab> createState() => _GitFilesTabState();
}

class _GitFilesTabState extends ConsumerState<_GitFilesTab>
    with AutomaticKeepAliveClientMixin {
  final Map<String, List<WorkspaceGitTreeEntry>> _levels = {};
  final Map<String, String> _errors = {};
  final Set<String> _expanded = {};
  final Set<String> _loading = {};
  String? _error;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load('');
  }

  @override
  void didUpdateWidget(covariant _GitFilesTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.reloadTick != widget.reloadTick) _refresh();
  }

  /// Drop every cached level but keep what was expanded, so a refresh lands
  /// the user back where they were rather than collapsed to the root.
  Future<void> _refresh() async {
    final open = _expanded.toList();
    setState(() {
      _levels.clear();
      _errors.clear();
    });
    await _load('');
    for (final path in open) {
      await _load(path);
    }
  }

  Future<void> _load(String path) async {
    setState(() {
      _loading.add(path);
      if (path.isEmpty) _error = null;
    });
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final tree = await api.gitTree(widget.cwd, path: path);
      if (!mounted) return;
      setState(() {
        _levels[path] = tree.entries;
        if (tree.error != null) {
          _errors[path] = tree.error!;
        } else {
          _errors.remove(path);
        }
        _loading.remove(path);
      });
    } catch (error) {
      if (!mounted) return;
      final message = '$error'.replaceFirst('Exception: ', '');
      setState(() {
        _errors[path] = message;
        if (path.isEmpty) _error = message;
        _loading.remove(path);
      });
    }
  }

  void _toggle(String path) {
    setState(() {
      if (_expanded.contains(path)) {
        _expanded.remove(path);
      } else {
        _expanded.add(path);
      }
    });
    if (!_levels.containsKey(path)) _load(path);
  }

  /// The expanded tree, flattened to rows — a `ListView` of a lazily-expanded
  /// tree is cheaper and scrolls better than nested `Column`s.
  List<Widget> _rows(String path, int depth) {
    final entries = _levels[path];
    if (entries == null) {
      if (_loading.contains(path)) {
        return [_TreeNote(depth: depth, text: 'Reading…')];
      }
      final error = _errors[path];
      return error == null ? const [] : [_TreeNote(depth: depth, text: error)];
    }

    final rows = <Widget>[];
    for (final entry in entries) {
      final open = _expanded.contains(entry.path);
      rows.add(
        _TreeRow(
          entry: entry,
          depth: depth,
          expanded: open,
          onTap: entry.isDirectory
              ? () => _toggle(entry.path)
              : isReadableDocPath(entry.name)
                  ? () =>
                      openDocument(context, cwd: widget.cwd, path: entry.path)
                  : null,
        ),
      );
      if (entry.isDirectory && open) {
        rows.addAll(_rows(entry.path, depth + 1));
      }
    }
    final error = _errors[path];
    if (error != null) rows.add(_TreeNote(depth: depth, text: error));
    return rows;
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final root = _levels[''];
    final rows = root == null ? const <Widget>[] : _rows('', 0);
    return Column(
      children: [
        if (_loading.isNotEmpty) const LinearProgressIndicator(minHeight: 2),
        if (_error != null && root == null)
          _ErrorBar(message: _error!, onRetry: _refresh),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _refresh,
            child: root == null
                ? (_loading.contains('')
                    ? const Center(child: CircularProgressIndicator())
                    : ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        children: const []))
                : ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(4, 8, 12, 24),
                    children: rows.isEmpty
                        ? [
                            const SizedBox(height: 36),
                            Text(
                              'This folder is empty.',
                              textAlign: TextAlign.center,
                              style: TextStyle(color: context.tokens.subtle),
                            ),
                          ]
                        : rows,
                  ),
          ),
        ),
      ],
    );
  }
}

class _TreeRow extends StatelessWidget {
  const _TreeRow(
      {required this.entry,
      required this.depth,
      required this.expanded,
      this.onTap});

  final WorkspaceGitTreeEntry entry;
  final int depth;
  final bool expanded;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final dim = entry.ignored;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: EdgeInsets.fromLTRB(8.0 + depth * 14, 6, 8, 6),
        child: Row(
          children: [
            SizedBox(
              width: 16,
              child: entry.isDirectory
                  ? Icon(
                      expanded
                          ? Icons.keyboard_arrow_down
                          : Icons.keyboard_arrow_right,
                      size: 16,
                      color: tokens.subtle,
                    )
                  : null,
            ),
            Icon(
              entry.isDirectory
                  ? (expanded ? Icons.folder_open : Icons.folder)
                  : isReadableDocPath(entry.name)
                      ? Icons.article_outlined
                      : Icons.insert_drive_file_outlined,
              size: 14,
              color: dim ? tokens.muted : tokens.subtle,
            ),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                entry.name,
                style: TextStyle(
                  color: dim ? tokens.muted : tokens.text,
                  fontSize: 13,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (!entry.isDirectory && entry.size != null) ...[
              const SizedBox(width: 6),
              Text(_formatBytes(entry.size!),
                  style: TextStyle(color: tokens.subtle, fontSize: 11)),
            ],
          ],
        ),
      ),
    );
  }
}

class _TreeNote extends StatelessWidget {
  const _TreeNote({required this.depth, required this.text});

  final int depth;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(8.0 + depth * 14 + 23, 4, 8, 4),
      child: Text(text,
          style: TextStyle(color: context.tokens.subtle, fontSize: 12)),
    );
  }
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

class _ErrorBar extends StatelessWidget {
  const _ErrorBar({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

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
            child: Text(message,
                style: TextStyle(color: tokens.danger.text, fontSize: 12)),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _GitStatusBody extends StatelessWidget {
  const _GitStatusBody({required this.status});

  final WorkspaceGitStatus status;

  @override
  Widget build(BuildContext context) {
    if (!status.isRepo) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(24),
        children: [
          const SizedBox(height: 36),
          Text(
            status.error ?? 'Not a git repository.',
            textAlign: TextAlign.center,
            style: TextStyle(color: context.tokens.subtle),
          ),
          if (status.folders.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(
              '${status.folders.length} sub-folder(s) found',
              textAlign: TextAlign.center,
              style: TextStyle(color: context.tokens.subtle, fontSize: 12),
            ),
          ],
        ],
      );
    }

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
      children: [
        _BranchHeader(status: status),
        if (status.remotes.isNotEmpty) ...[
          const SizedBox(height: 16),
          const _SectionLabel('Remotes'),
          const SizedBox(height: 8),
          ...status.remotes.map((r) => _RemoteRow(remote: r)),
        ],
        const SizedBox(height: 16),
        _SectionLabel('Changes', count: status.changes.length),
        const SizedBox(height: 8),
        if (status.changes.isEmpty)
          _EmptyHint(text: 'Working tree clean.')
        else
          ...status.changes.map((c) => _ChangeRow(change: c)),
        if (status.branches.length > 1) ...[
          const SizedBox(height: 16),
          _SectionLabel('Branches', count: status.branches.length),
          const SizedBox(height: 8),
          ...status.branches.map((b) => _BranchRow(branch: b)),
        ],
        if (status.worktrees.isNotEmpty) ...[
          const SizedBox(height: 16),
          _SectionLabel('Worktrees', count: status.worktrees.length),
          const SizedBox(height: 8),
          ...status.worktrees.map((w) => _WorktreeRow(worktree: w)),
        ],
        if (status.stashes.isNotEmpty) ...[
          const SizedBox(height: 16),
          _SectionLabel('Stashes', count: status.stashes.length),
          const SizedBox(height: 8),
          ...status.stashes.map((s) => _StashRow(text: s)),
        ],
      ],
    );
  }
}

class _BranchHeader extends StatelessWidget {
  const _BranchHeader({required this.status});

  final WorkspaceGitStatus status;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final ahead = status.ahead ?? 0;
    final behind = status.behind ?? 0;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: tokens.panel,
        borderRadius: tokens.radius.mdR,
        border: Border.all(color: tokens.lineSoft),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.call_split, size: 16, color: tokens.accent.text),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  status.branch ?? '(detached)',
                  style: TextStyle(
                      color: tokens.text,
                      fontSize: 15,
                      fontWeight: FontWeight.w700),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (ahead > 0)
                _CountBadge(
                    icon: Icons.arrow_upward, count: ahead, tone: tokens.warn),
              if (behind > 0) ...[
                const SizedBox(width: 6),
                _CountBadge(
                    icon: Icons.arrow_downward,
                    count: behind,
                    tone: tokens.warn),
              ],
            ],
          ),
          if (status.upstream != null) ...[
            const SizedBox(height: 4),
            Text(
              'tracking ${status.upstream}',
              style: TextStyle(color: tokens.subtle, fontSize: 12),
            ),
          ],
          if (status.lastFetchAt != null) ...[
            const SizedBox(height: 4),
            Text(
              'fetched ${_relativeAge(status.lastFetchAt!)}',
              style: TextStyle(color: tokens.subtle, fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }
}

class _CountBadge extends StatelessWidget {
  const _CountBadge(
      {required this.icon, required this.count, required this.tone});

  final IconData icon;
  final int count;
  final StatusTokens tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: tone.wash,
        borderRadius: context.tokens.radius.pillR,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 11, color: tone.text),
          const SizedBox(width: 2),
          Text('$count',
              style: TextStyle(
                  fontSize: 11, fontWeight: FontWeight.w600, color: tone.text)),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.label, {this.count});

  final String label;
  final int? count;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Row(
      children: [
        Text(
          label.toUpperCase(),
          style: TextStyle(
            color: tokens.muted,
            fontSize: 11,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.6,
          ),
        ),
        if (count != null) ...[
          const SizedBox(width: 6),
          Text('$count', style: TextStyle(color: tokens.subtle, fontSize: 11)),
        ],
      ],
    );
  }
}

class _EmptyHint extends StatelessWidget {
  const _EmptyHint({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Text(text,
          style: TextStyle(color: context.tokens.subtle, fontSize: 12.5)),
    );
  }
}

/// Same code→label mapping as the desktop's `gitStatusLabel` in `App.tsx`,
/// so a phone and a Mac describe the same porcelain code the same way.
String _changeLabel(String code) {
  const map = {
    'M': 'modified',
    'A': 'added',
    'D': 'deleted',
    'R': 'renamed',
    'C': 'copied',
    'U': 'unmerged',
    '?': 'untracked',
    '!': 'ignored',
  };
  final parts = code
      .split('')
      .where((c) => c != ' ')
      .map((c) => map[c] ?? c)
      .toSet()
      .toList();
  return parts.isEmpty ? 'unchanged' : parts.join(' / ');
}

class _ChangeRow extends StatelessWidget {
  const _ChangeRow({required this.change});

  final WorkspaceGitChange change;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Container(
            width: 44,
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
            child: Text(
              change.code.trim().isEmpty ? '·' : change.code,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 11,
                color: tokens.subtle,
              ),
            ),
          ),
          Expanded(
            child: Text(
              change.path,
              style: TextStyle(color: tokens.text, fontSize: 12.5),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            _changeLabel(change.code),
            style: TextStyle(color: tokens.subtle, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

class _RemoteRow extends StatelessWidget {
  const _RemoteRow({required this.remote});

  final WorkspaceGitRemote remote;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final ahead = remote.ahead ?? 0;
    final behind = remote.behind ?? 0;
    final String syncLabel;
    if (remote.ref == null) {
      syncLabel = 'branch not on this remote';
    } else if (ahead == 0 && behind == 0) {
      syncLabel = 'up to date';
    } else if (ahead > 0 && behind > 0) {
      syncLabel = 'diverged — $ahead ahead, $behind behind';
    } else if (ahead > 0) {
      syncLabel = '$ahead to push';
    } else {
      syncLabel = '$behind to pull';
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          if (remote.upstream)
            Icon(Icons.star, size: 12, color: tokens.accent.text),
          if (remote.upstream) const SizedBox(width: 4),
          Text(remote.name,
              style: TextStyle(
                  color: tokens.text,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              syncLabel,
              style: TextStyle(color: tokens.subtle, fontSize: 11.5),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class _BranchRow extends StatelessWidget {
  const _BranchRow({required this.branch});

  final WorkspaceGitBranch branch;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Icon(
            branch.current
                ? Icons.radio_button_checked
                : Icons.radio_button_unchecked,
            size: 13,
            color: branch.current ? tokens.accent.text : tokens.subtle,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              branch.name,
              style: TextStyle(
                color: branch.current ? tokens.text : tokens.muted,
                fontSize: 12.5,
                fontWeight: branch.current ? FontWeight.w600 : FontWeight.w400,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class _WorktreeRow extends StatelessWidget {
  const _WorktreeRow({required this.worktree});

  final WorkspaceGitWorktree worktree;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.folder_open, size: 13, color: tokens.subtle),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(worktree.path,
                    style: TextStyle(color: tokens.text, fontSize: 12.5),
                    overflow: TextOverflow.ellipsis),
                if (worktree.branch != null)
                  Text(worktree.branch!,
                      style: TextStyle(color: tokens.subtle, fontSize: 11)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StashRow extends StatelessWidget {
  const _StashRow({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Icon(Icons.inventory_2_outlined, size: 13, color: tokens.subtle),
          const SizedBox(width: 6),
          Expanded(
            child: Text(text,
                style: TextStyle(color: tokens.text, fontSize: 12.5),
                overflow: TextOverflow.ellipsis),
          ),
        ],
      ),
    );
  }
}

String _relativeAge(DateTime at) {
  final diff = DateTime.now().difference(at);
  if (diff.inSeconds < 60) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  return '${diff.inDays}d ago';
}
