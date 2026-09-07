import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import 'schedule_models.dart';

/// A workspace's scheduled tasks, view-only on the phone (V1).
///
/// Creating or editing a job is desktop/agent-only for now — see
/// `relay_api.dart`'s `schedule()` — so unlike `BacklogScreen` this screen has
/// no editor sheet and no FAB, just a list of what is scheduled and by whom,
/// with pull-to-refresh.
class ScheduledTasksScreen extends ConsumerStatefulWidget {
  const ScheduledTasksScreen({super.key, required this.cwd, required this.workspaceName});

  final String cwd;
  final String workspaceName;

  @override
  ConsumerState<ScheduledTasksScreen> createState() => _ScheduledTasksScreenState();
}

class _ScheduledTasksScreenState extends ConsumerState<ScheduledTasksScreen> {
  WorkspaceSchedule? _schedule;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final schedule = await api.schedule(widget.cwd);
      if (!mounted) return;
      setState(() {
        _schedule = schedule;
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
    final schedule = _schedule;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Scheduled tasks'),
            Text(
              widget.workspaceName,
              style: TextStyle(fontSize: 12, color: context.tokens.subtle),
            ),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _busy ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: Column(
        children: [
          if (_busy) const LinearProgressIndicator(minHeight: 2),
          if (_error != null) _ErrorBar(message: _error!, onRetry: _load),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: _ScheduleList(
                items: schedule?.items ?? const [],
                loading: schedule == null && _busy,
              ),
            ),
          ),
        ],
      ),
    );
  }
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
            child: Text(message, style: TextStyle(color: tokens.danger.text, fontSize: 12)),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _ScheduleList extends StatelessWidget {
  const _ScheduleList({required this.items, required this.loading});

  final List<ScheduledTask> items;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (items.isEmpty) {
      // Always scrollable so pull-to-refresh still works on an empty schedule.
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 60, horizontal: 24),
            child: Text(
              'Nothing scheduled. Jobs fire only while the Mac and Panda Code are running.',
              textAlign: TextAlign.center,
              style: TextStyle(color: context.tokens.subtle),
            ),
          ),
        ],
      );
    }

    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) => _TaskCard(item: items[index]),
    );
  }
}

class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.item});

  final ScheduledTask item;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: tokens.panel,
        borderRadius: tokens.radius.mdR,
        border: Border.all(color: tokens.lineSoft),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            item.title,
            style: TextStyle(color: tokens.text, fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            item.prompt,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: tokens.muted, fontSize: 12.5, height: 1.4),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              _CadenceChip(item: item),
              const SizedBox(width: 8),
              _AuthorChip(item: item),
            ],
          ),
        ],
      ),
    );
  }
}

class _CadenceChip extends StatelessWidget {
  const _CadenceChip({required this.item});

  final ScheduledTask item;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final enabled = item.enabled;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: enabled ? tokens.accent.wash : tokens.hoverWash,
        borderRadius: tokens.radius.pillR,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.schedule,
            size: 12,
            color: enabled ? tokens.accent.text : tokens.subtle,
          ),
          const SizedBox(width: 4),
          Text(
            enabled ? item.frequency.describe() : 'disabled',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: enabled ? tokens.accent.text : tokens.subtle,
            ),
          ),
        ],
      ),
    );
  }
}

class _AuthorChip extends StatelessWidget {
  const _AuthorChip({required this.item});

  final ScheduledTask item;

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
            style: TextStyle(fontSize: 11, color: agent ? tokens.agent.text : tokens.subtle),
          ),
        ],
      ),
    );
  }
}
