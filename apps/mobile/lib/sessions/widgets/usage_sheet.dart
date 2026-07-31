import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../relay/relay_api.dart';
import '../../state/providers.dart';
import '../../theme/panda_tokens.dart';
import '../models.dart';

/// Bottom sheet showing the account's plan-usage rate-limit windows. The numbers
/// are fetched by the paired desktop (only it holds the OAuth creds) and pushed
/// to the relay on its heartbeat; the phone just decrypts and renders them.
Future<void> showUsageSheet(BuildContext context) {
  return showModalBottomSheet(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => const _UsageSheet(),
  );
}

class _UsageSheet extends ConsumerStatefulWidget {
  const _UsageSheet();

  @override
  ConsumerState<_UsageSheet> createState() => _UsageSheetState();
}

class _UsageSheetState extends ConsumerState<_UsageSheet> {
  late Future<DeviceStatus?> _future;
  AgentRuntime _provider = AgentRuntime.claude;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<DeviceStatus?> _load() async {
    final api = await ref.read(relayApiProvider.future);
    return api?.deviceStatus();
  }

  void _refresh() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.speed, size: 20, color: context.tokens.muted),
                  const SizedBox(width: 10),
                  Text(
                    'Plan usage',
                    style: theme.textTheme.titleLarge
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.refresh, size: 20),
                    tooltip: 'Refresh',
                    onPressed: _refresh,
                  ),
                ],
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: SegmentedButton<AgentRuntime>(
                  segments: [
                    for (final runtime in AgentRuntime.values)
                      ButtonSegment(
                        value: runtime,
                        label: Text(agentRuntimeLabel(runtime)),
                      ),
                  ],
                  selected: {_provider},
                  showSelectedIcon: false,
                  onSelectionChanged: (selection) =>
                      setState(() => _provider = selection.first),
                ),
              ),
              const SizedBox(height: 16),
              FutureBuilder<DeviceStatus?>(
                future: _future,
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return const Padding(
                      padding: EdgeInsets.symmetric(vertical: 32),
                      child: Center(child: CircularProgressIndicator()),
                    );
                  }
                  final usage = snapshot.data?.usageFor(_provider);
                  if (usage == null || usage.windows.isEmpty) {
                    return _EmptyState(
                      online: snapshot.data?.online ?? false,
                      provider: _provider,
                    );
                  }
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final window in usage.windows)
                        _UsageRow(window: window),
                      if (usage.fetchedAt != null) ...[
                        SizedBox(height: 6),
                        Text(
                          'Updated ${_relative(usage.fetchedAt!)}',
                          style: TextStyle(
                              color: context.tokens.subtle, fontSize: 12),
                        ),
                      ],
                    ],
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.online, required this.provider});

  final bool online;
  final AgentRuntime provider;

  @override
  Widget build(BuildContext context) {
    final label = agentRuntimeLabel(provider);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Text(
        online
            ? '$label usage isn’t available yet. Your Mac reports it on its next '
                'check-in — try again in a moment.'
            : 'Your Mac is offline, so it can’t report plan usage right now.',
        style: TextStyle(color: context.tokens.subtle, fontSize: 13.5),
      ),
    );
  }
}

class _UsageRow extends StatelessWidget {
  const _UsageRow({required this.window});

  final UsageWindow window;

  @override
  Widget build(BuildContext context) {
    final pct = window.utilization.round();
    final Color barColor = window.utilization >= 90
        ? context.tokens.danger.text
        : window.utilization >= 70
            ? context.tokens.warn.text
            : context.tokens.run.text;
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  window.label,
                  style: TextStyle(
                      color: context.tokens.text,
                      fontSize: 14,
                      fontWeight: FontWeight.w600),
                ),
              ),
              Text(
                '$pct%',
                style: TextStyle(
                    color: barColor, fontSize: 14, fontWeight: FontWeight.w700),
              ),
            ],
          ),
          SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: (window.utilization / 100).clamp(0.02, 1.0),
              minHeight: 8,
              backgroundColor: context.tokens.panelHover,
              valueColor: AlwaysStoppedAnimation<Color>(barColor),
            ),
          ),
          if (window.resetsAt != null) ...[
            SizedBox(height: 6),
            Text(
              'Resets ${_relative(window.resetsAt!)}',
              style: TextStyle(color: context.tokens.subtle, fontSize: 12),
            ),
          ],
        ],
      ),
    );
  }
}

String _relative(DateTime when) {
  final now = DateTime.now();
  final diff = when.difference(now);
  final future = !diff.isNegative;
  final abs = diff.abs();
  String span;
  if (abs.inMinutes < 1) {
    return future ? 'in under a minute' : 'just now';
  } else if (abs.inMinutes < 60) {
    span = '${abs.inMinutes}m';
  } else if (abs.inHours < 24) {
    span = '${abs.inHours}h';
  } else {
    span = '${abs.inDays}d';
  }
  return future ? 'in $span' : '$span ago';
}
