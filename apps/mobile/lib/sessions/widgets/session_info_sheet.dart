import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../theme/panda_tokens.dart';
import '../../widgets/toast/panda_toast.dart';
import '../models.dart';
import 'cost_view.dart';

/// Bottom sheet with everything we know about a session: routing metadata, live
/// token accounting (decrypted from the runtime badge — the relay never sees
/// these numbers), and the section's lifetime cost fetched from the desktop's
/// usage ledger.
Future<void> showSessionInfoSheet(BuildContext context, SessionRow row) {
  return showModalBottomSheet(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _SessionInfoSheet(row: row),
  );
}

class _SessionInfoSheet extends ConsumerStatefulWidget {
  const _SessionInfoSheet({required this.row});

  final SessionRow row;

  @override
  ConsumerState<_SessionInfoSheet> createState() => _SessionInfoSheetState();
}

class _SessionInfoSheetState extends ConsumerState<_SessionInfoSheet> {
  UsageCostReport? _cost;
  String? _costError;
  bool _loadingCost = true;

  @override
  void initState() {
    super.initState();
    _loadCost();
  }

  Future<void> _loadCost() async {
    setState(() {
      _loadingCost = true;
      _costError = null;
    });
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final report = await api.fetchUsageCost(sessionId: widget.row.sessionId);
      if (!mounted) return;
      setState(() {
        _cost = report;
        _loadingCost = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _costError = '$error'.replaceFirst('Exception: ', '');
        _loadingCost = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    final theme = Theme.of(context);
    final runtime = row.runtime;
    final state = runtime?.agentState ?? row.agentState;
    final usage = runtime?.tokenUsage;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                row.title ?? 'Session',
                style: theme.textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 16),
              _Section(title: 'Status', children: [
                _InfoRow(label: 'State', value: _stateLabel(state)),
                _InfoRow(label: 'Session', value: _statusLabel(row.status)),
                _InfoRow(label: 'Mode', value: row.executionMode),
                _InfoRow(label: 'Messages', value: '${row.headSeq}'),
                _InfoRow(
                    label: 'Updated', value: _formatUpdated(row.updatedAt)),
              ]),
              if (row.cwd != null && row.cwd!.trim().isNotEmpty)
                _Section(title: 'Workspace', children: [
                  _InfoRow(
                    label: 'Path',
                    value: row.cwd!,
                    mono: true,
                    copyable: true,
                  ),
                ]),
              _Section(title: 'Identifiers', children: [
                _InfoRow(
                  label: 'Session ID',
                  value: row.sessionId,
                  mono: true,
                  copyable: true,
                ),
                if (runtime?.claudeSessionId != null)
                  _InfoRow(
                    label: 'Claude ID',
                    value: runtime!.claudeSessionId!,
                    mono: true,
                    copyable: true,
                  ),
              ]),
              _Section(title: 'Cost', children: [
                _CostSection(
                  report: _cost,
                  error: _costError,
                  loading: _loadingCost,
                  onRetry: _loadCost,
                ),
              ]),
              if (usage != null && !usage.isEmpty)
                _TokenSection(usage: usage)
              else
                _Section(title: 'Tokens on this thread', children: const [
                  _InfoRow(label: '', value: 'No token usage reported yet.'),
                ]),
            ],
          ),
        ),
      ),
    );
  }
}

/// Lifetime cost for the section, answered by the desktop's ledger. The desktop
/// has to be reachable, so an offline desktop says so rather than showing $0.00.
class _CostSection extends StatelessWidget {
  const _CostSection({
    required this.report,
    required this.error,
    required this.loading,
    required this.onRetry,
  });

  final UsageCostReport? report;
  final String? error;
  final bool loading;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return Padding(
        padding: EdgeInsets.symmetric(vertical: 12),
        child: Row(children: [
          SizedBox(
            width: 15,
            height: 15,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          SizedBox(width: 10),
          Text('Asking the desktop…',
              style: TextStyle(color: context.tokens.subtle, fontSize: 13)),
        ]),
      );
    }
    if (error != null) {
      return Row(
        children: [
          Expanded(
            child: Text(error!,
                style: TextStyle(
                    color: context.tokens.accent.text, fontSize: 12.5)),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      );
    }
    final value = report;
    if (value == null || value.isEmpty) {
      return Text(
        'No recorded usage for this session yet.',
        style: TextStyle(color: context.tokens.subtle, fontSize: 13),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        CostHeadline(label: 'Session cost', report: value),
        SizedBox(height: 12),
        CostClassRows(report: value),
        SizedBox(height: 12),
        CostModelRows(report: value),
        CostUnpricedNote(report: value),
        SizedBox(height: 2),
        Text(
          'Lifetime spend for this section, including any provider it was '
          'handed off from. Priced at published API rates.',
          style: TextStyle(color: context.tokens.subtle, fontSize: 11),
        ),
      ],
    );
  }
}

class _TokenSection extends StatelessWidget {
  const _TokenSection({required this.usage});

  final TokenUsage usage;

  @override
  Widget build(BuildContext context) {
    return _Section(
      title: 'Tokens on this thread',
      children: [
        Row(
          children: [
            Expanded(
                child: _TokenTile(
                    label: 'Input',
                    value: usage.inputTokens,
                    icon: Icons.south_east)),
            const SizedBox(width: 10),
            Expanded(
                child: _TokenTile(
                    label: 'Output',
                    value: usage.outputTokens,
                    icon: Icons.north_east)),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
                child: _TokenTile(
                    label: 'Cache read',
                    value: usage.cacheReadInputTokens,
                    icon: Icons.bolt)),
            const SizedBox(width: 10),
            Expanded(
                child: _TokenTile(
                    label: 'Cache write',
                    value: usage.cacheCreationInputTokens,
                    icon: Icons.save_outlined)),
          ],
        ),
        const SizedBox(height: 10),
        _TokenTile(
          label: 'Total',
          value: usage.total,
          icon: Icons.data_usage,
          emphasize: true,
        ),
      ],
    );
  }
}

class _TokenTile extends StatelessWidget {
  const _TokenTile({
    required this.label,
    required this.value,
    required this.icon,
    this.emphasize = false,
  });

  final String label;
  final int value;
  final IconData icon;
  final bool emphasize;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accent = theme.colorScheme.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: emphasize
            ? accent.withValues(alpha: 0.12)
            : context.tokens.panelHover,
        borderRadius: BorderRadius.circular(10),
        border:
            emphasize ? Border.all(color: accent.withValues(alpha: 0.4)) : null,
      ),
      child: Row(
        children: [
          Icon(icon,
              size: 16, color: emphasize ? accent : context.tokens.subtle),
          SizedBox(width: 10),
          Expanded(
            child: Text(label,
                style: TextStyle(
                    color: context.tokens.muted,
                    fontSize: 12.5,
                    fontWeight: emphasize ? FontWeight.w700 : FontWeight.w500)),
          ),
          SizedBox(width: 12),
          Text(
            _formatTokens(value),
            style: TextStyle(
              fontWeight: FontWeight.w700,
              fontSize: emphasize ? 16 : 14,
              color: emphasize ? accent : context.tokens.text,
            ),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title.toUpperCase(),
            style: TextStyle(
              color: context.tokens.subtle,
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.8,
            ),
          ),
          const SizedBox(height: 10),
          ...children,
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({
    required this.label,
    required this.value,
    this.mono = false,
    this.copyable = false,
  });

  final String label;
  final String value;
  final bool mono;
  final bool copyable;

  @override
  Widget build(BuildContext context) {
    final valueStyle = TextStyle(
      color: context.tokens.text,
      fontSize: 13.5,
      fontFamily: mono ? 'monospace' : null,
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (label.isNotEmpty)
            SizedBox(
              width: 92,
              child: Text(label,
                  style: TextStyle(color: context.tokens.subtle, fontSize: 13)),
            ),
          Expanded(child: Text(value, style: valueStyle)),
          if (copyable)
            InkWell(
              onTap: () async {
                await Clipboard.setData(ClipboardData(text: value));
                showToast('Copied $label', variant: ToastVariant.success);
              },
              child: Padding(
                padding: EdgeInsets.only(left: 8),
                child: Icon(Icons.copy, size: 15, color: context.tokens.subtle),
              ),
            ),
        ],
      ),
    );
  }
}

String _stateLabel(AgentState state) => switch (state) {
      AgentState.working => 'Working',
      AgentState.waiting => 'Waiting',
      AgentState.needsAction => 'Needs approval',
      AgentState.exited => 'Ended',
    };

String _statusLabel(SessionStatus status) => switch (status) {
      SessionStatus.idle => 'Idle',
      SessionStatus.running => 'Running',
      SessionStatus.exited => 'Exited',
      SessionStatus.error => 'Error',
    };

String _formatTokens(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
  return '$n';
}

String _formatUpdated(int updatedAt) {
  if (updatedAt <= 0) return 'just now';
  final d = DateTime.fromMillisecondsSinceEpoch(updatedAt);
  final elapsed = DateTime.now().difference(d);
  String rel;
  if (elapsed.inMinutes < 1) {
    rel = 'just now';
  } else if (elapsed.inHours < 1) {
    rel = '${elapsed.inMinutes}m ago';
  } else if (elapsed.inDays < 1) {
    rel = '${elapsed.inHours}h ago';
  } else {
    rel = '${elapsed.inDays}d ago';
  }
  final hh = d.hour.toString().padLeft(2, '0');
  final mm = d.minute.toString().padLeft(2, '0');
  return '$rel · ${d.year}-${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')} $hh:$mm';
}
