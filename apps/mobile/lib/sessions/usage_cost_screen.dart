import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import 'models.dart';
import 'widgets/cost_view.dart';

/// Date windows the report can be scoped to. Mirrors the desktop's Settings →
/// Usage & cost presets so the two surfaces answer the same question the same
/// way. Weeks start on Monday; every range is inclusive of both endpoints.
enum UsageRangePreset {
  today('Today'),
  yesterday('Yesterday'),
  thisWeek('This week'),
  last7('Last 7 days'),
  thisMonth('This month'),
  last30('Last 30 days'),
  custom('Custom');

  const UsageRangePreset(this.label);
  final String label;
}

@immutable
class UsageRange {
  final DateTime from;
  final DateTime to;
  const UsageRange({required this.from, required this.to});
}

DateTime _startOfDay(DateTime value) =>
    DateTime(value.year, value.month, value.day);

DateTime _endOfDay(DateTime value) =>
    DateTime(value.year, value.month, value.day, 23, 59, 59, 999);

/// Resolve a preset against [now]. [custom] is only consulted for
/// [UsageRangePreset.custom], where reversed endpoints are swapped rather than
/// producing an empty window.
UsageRange resolveUsageRange(
  UsageRangePreset preset,
  DateTime now, {
  UsageRange? custom,
}) {
  switch (preset) {
    case UsageRangePreset.today:
      return UsageRange(from: _startOfDay(now), to: _endOfDay(now));
    case UsageRangePreset.yesterday:
      final yesterday = now.subtract(const Duration(days: 1));
      return UsageRange(from: _startOfDay(yesterday), to: _endOfDay(yesterday));
    case UsageRangePreset.thisWeek:
      // DateTime.weekday: Monday == 1.
      final offset = now.weekday - DateTime.monday;
      return UsageRange(
        from: _startOfDay(now.subtract(Duration(days: offset))),
        to: _endOfDay(now),
      );
    case UsageRangePreset.last7:
      return UsageRange(
        from: _startOfDay(now.subtract(const Duration(days: 6))),
        to: _endOfDay(now),
      );
    case UsageRangePreset.last30:
      return UsageRange(
        from: _startOfDay(now.subtract(const Duration(days: 29))),
        to: _endOfDay(now),
      );
    case UsageRangePreset.custom:
      if (custom != null) {
        final reversed = custom.from.isAfter(custom.to);
        final from = reversed ? custom.to : custom.from;
        final to = reversed ? custom.from : custom.to;
        return UsageRange(from: _startOfDay(from), to: _endOfDay(to));
      }
      return resolveUsageRange(UsageRangePreset.thisMonth, now);
    case UsageRangePreset.thisMonth:
      return UsageRange(
        from: DateTime(now.year, now.month, 1),
        to: _endOfDay(now),
      );
  }
}

String formatUsageRange(UsageRange range) {
  String day(DateTime d) =>
      '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
  final from = day(range.from);
  final to = day(range.to);
  return from == to ? from : '$from → $to';
}

/// Global token→dollar report across every section, for a date range. The ledger
/// lives on the desktop, so this is a command round-trip: the desktop has to be
/// running, and we say so plainly when it isn't.
class UsageCostScreen extends ConsumerStatefulWidget {
  const UsageCostScreen({super.key});

  @override
  ConsumerState<UsageCostScreen> createState() => _UsageCostScreenState();
}

class _UsageCostScreenState extends ConsumerState<UsageCostScreen> {
  UsageRangePreset _preset = UsageRangePreset.thisMonth;
  UsageRange? _custom;
  UsageCostReport? _report;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  UsageRange get _range =>
      resolveUsageRange(_preset, DateTime.now(), custom: _custom);

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final range = _range;
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final report = await api.fetchUsageCost(from: range.from, to: range.to);
      if (!mounted) return;
      setState(() {
        _report = report;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '$error'.replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  Future<void> _pickCustomRange() async {
    final now = DateTime.now();
    final initial = _custom ?? _range;
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 3),
      lastDate: _endOfDay(now),
      initialDateRange: DateTimeRange(start: initial.from, end: initial.to),
    );
    if (picked == null) return;
    setState(() {
      _preset = UsageRangePreset.custom;
      _custom = UsageRange(from: picked.start, to: picked.end);
    });
    await _load();
  }

  Future<void> _select(UsageRangePreset preset) async {
    if (preset == UsageRangePreset.custom) {
      await _pickCustomRange();
      return;
    }
    setState(() => _preset = preset);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final report = _report;
    return Scaffold(
      appBar: AppBar(
        title: Text('Usage & cost'),
        actions: [
          IconButton(
            onPressed: _loading ? null : _load,
            icon: Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final preset in UsageRangePreset.values)
                ChoiceChip(
                  label: Text(preset.label),
                  selected: _preset == preset,
                  onSelected: (_) => _select(preset),
                ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            formatUsageRange(_range),
            style: TextStyle(color: context.tokens.subtle, fontSize: 12),
          ),
          SizedBox(height: 16),
          if (_loading && report == null)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 40),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_error != null)
            _ErrorCard(message: _error!, onRetry: _load)
          else if (report == null || report.isEmpty)
            Padding(
              padding: EdgeInsets.symmetric(vertical: 32),
              child: Text(
                'No recorded usage in this range.',
                style: TextStyle(color: context.tokens.subtle),
              ),
            )
          else ...[
            CostHeadline(
              label: 'Spend in range',
              report: report,
              subtitle:
                  '${formatCostTokens(report.tokens.total)} tokens across '
                  '${report.sessionCount} '
                  '${report.sessionCount == 1 ? 'session' : 'sessions'}',
              trailing: _loading
                  ? SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : null,
            ),
            SizedBox(height: 18),
            const _Label('By token type'),
            CostClassRows(report: report),
            const SizedBox(height: 18),
            const _Label('By model'),
            CostModelRows(report: report),
            CostUnpricedNote(report: report),
            const SizedBox(height: 8),
            Text(
              'Priced at each provider’s published API rates — a what-if while '
              'you run on a subscription, and the real bill once you switch to '
              'API keys. Recorded by the desktop, so turns it never saw aren’t '
              'counted.',
              style: TextStyle(color: context.tokens.subtle, fontSize: 11.5),
            ),
          ],
        ],
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 2, bottom: 8),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          color: context.tokens.subtle,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}

class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: context.tokens.accent.wash,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: context.tokens.accent.edge),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(message,
                style: TextStyle(
                    color: context.tokens.accent.text, fontSize: 12.5)),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}
