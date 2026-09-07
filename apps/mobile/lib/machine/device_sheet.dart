import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import 'machine_models.dart';

/// "What is my Mac doing right now?" — opened by tapping the wordmark in the app
/// bar, which until now was the one thing up there that did nothing.
///
/// The numbers are read on the Mac (only it can see its own process table) and
/// round-tripped over a `machine-stats` command, so an unreachable desktop says
/// so instead of showing a blank dashboard. It polls while open and stops the
/// moment it closes: a process table every few seconds is exactly the kind of
/// background cost this sheet exists to make visible.
Future<void> showDeviceSheet(BuildContext context) {
  return showModalBottomSheet(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => const _DeviceSheet(),
  );
}

const _refreshEvery = Duration(seconds: 5);

class _DeviceSheet extends ConsumerStatefulWidget {
  const _DeviceSheet();

  @override
  ConsumerState<_DeviceSheet> createState() => _DeviceSheetState();
}

class _DeviceSheetState extends ConsumerState<_DeviceSheet> {
  MachineStats? _stats;
  String? _error;
  bool _loading = true;
  Timer? _timer;

  /// A round-trip can outlive the poll interval on the very machine this sheet
  /// is reporting on, so never let two of them be in flight at once — the tick
  /// that measures the load must not add to it.
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(_refreshEvery, (_) => _load(silent: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  /// `silent` is the polling path: it must not flash the spinner over numbers
  /// that are already on screen, and a single failed poll must not wipe them.
  Future<void> _load({bool silent = false}) async {
    if (_busy) return;
    _busy = true;
    if (!silent) setState(() => _loading = true);
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final stats = await api.machineStats();
      if (!mounted) return;
      setState(() {
        _stats = stats;
        _error = null;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      if (silent && _stats != null) return;
      setState(() {
        _error = '$error'.replaceFirst('Exception: ', '');
        _loading = false;
      });
    } finally {
      _busy = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final theme = Theme.of(context);
    final status = ref.watch(deviceStatusProvider).valueOrNull;
    final online = ref.watch(desktopOnlineProvider);
    final stats = _stats;
    final maxHeight = MediaQuery.of(context).size.height * 0.86;

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          stats?.hostname ?? status?.name ?? 'Your Mac',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleLarge
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _subtitle(stats, online: online),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: t.subtle, fontSize: 12.5),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: _loading ? null : () => _load(),
                    icon: _loading
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh),
                    iconSize: t.control.iconGlyph,
                    color: t.muted,
                    tooltip: 'Refresh',
                    constraints: t.control.tapTarget,
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Flexible(child: _body(context)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final t = context.tokens;
    final stats = _stats;

    if (stats == null) {
      if (_loading) {
        return const Padding(
          padding: EdgeInsets.symmetric(vertical: 40),
          child: Center(child: CircularProgressIndicator()),
        );
      }
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Text(
          _error ?? 'No answer from your Mac.',
          style: TextStyle(color: t.subtle, fontSize: 13.5),
        ),
      );
    }

    return ListView(
      shrinkWrap: true,
      padding: EdgeInsets.zero,
      children: [
        _Verdict(stats: stats),
        const SizedBox(height: 16),
        _Meter(
          label: 'CPU',
          icon: Icons.memory,
          pct: stats.cpuPct,
          detail:
              'load ${stats.loadAvg.map((v) => v.toStringAsFixed(1)).join(' · ')} across ${stats.cpuCount} cores',
        ),
        _Meter(
          label: 'Memory',
          icon: Icons.donut_large,
          pct: stats.memUsedPct,
          detail:
              '${formatMachineBytes(stats.memAvailableBytes)} available of ${formatMachineBytes(stats.memTotalBytes)}'
              '${stats.memCompressedBytes != null && stats.memCompressedBytes! > 0 ? ' · ${formatMachineBytes(stats.memCompressedBytes)} compressed' : ''}',
        ),
        if (stats.swapTotalBytes != null && stats.swapTotalBytes! > 0)
          _Meter(
            label: 'Swap',
            icon: Icons.swap_vert,
            pct: stats.swapUsedPct,
            detail:
                '${formatMachineBytes(stats.swapUsedBytes)} used of ${formatMachineBytes(stats.swapTotalBytes)}',
          ),
        if (stats.diskUsedPct != null)
          _Meter(
            label: 'Disk',
            icon: Icons.storage,
            pct: stats.diskUsedPct,
            detail: '${formatMachineBytes(stats.diskFreeBytes)} free',
          ),
        const SizedBox(height: 8),
        _ProcessSection(
          title: 'Heaviest by CPU',
          processes: stats.topByCpu,
          emphasiseCpu: true,
        ),
        const SizedBox(height: 16),
        _ProcessSection(
          title: 'Heaviest by memory',
          processes: stats.topByMemory,
          emphasiseCpu: false,
        ),
        if (stats.error != null) ...[
          const SizedBox(height: 12),
          Text(
            'Process list unavailable: ${stats.error}',
            style: TextStyle(color: t.subtle, fontSize: 12),
          ),
        ],
      ],
    );
  }
}

String _subtitle(MachineStats? stats, {required bool online}) {
  if (stats == null) return online ? 'Reading…' : 'Offline';
  return '${_pressureLabel(stats.pressure)} · up ${formatMachineUptime(stats.uptimeSec)} · ${stats.cpuCount} cores';
}

String _pressureLabel(MachinePressure pressure) => switch (pressure) {
      MachinePressure.quiet => 'Quiet',
      MachinePressure.busy => 'Busy',
      MachinePressure.loaded => 'Heavily loaded',
    };

class _Verdict extends StatelessWidget {
  const _Verdict({required this.stats});

  final MachineStats stats;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final status = switch (stats.pressure) {
      MachinePressure.quiet => t.run,
      MachinePressure.busy => t.warn,
      MachinePressure.loaded => t.danger,
    };
    final message = switch (stats.pressure) {
      MachinePressure.quiet => 'Quiet — plenty of room for more work.',
      MachinePressure.busy => 'Busy — there is room, but not for two builds.',
      MachinePressure.loaded =>
        'Saturated — anything heavy started now queues behind the work below.',
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: status.wash,
        border: Border.all(color: status.edge),
        borderRadius: t.radius.mdR,
      ),
      child: Text(
        message,
        style: TextStyle(color: status.text, fontSize: 13),
      ),
    );
  }
}

class _Meter extends StatelessWidget {
  const _Meter({
    required this.label,
    required this.icon,
    required this.pct,
    required this.detail,
  });

  final String label;
  final IconData icon;
  final double? pct;
  final String detail;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final value = pct;
    final color = value == null
        ? t.muted
        : value >= 90
            ? t.danger.text
            : value >= 75
                ? t.warn.text
                : t.run.text;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 14, color: t.subtle),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  label,
                  style: TextStyle(
                      color: t.text, fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
              ),
              Text(
                formatMachinePct(value),
                style: TextStyle(
                    color: color, fontSize: 13.5, fontWeight: FontWeight.w700),
              ),
            ],
          ),
          const SizedBox(height: 7),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: ((value ?? 0) / 100).clamp(0.0, 1.0),
              minHeight: 6,
              backgroundColor: t.panelHover,
              valueColor: AlwaysStoppedAnimation<Color>(color),
            ),
          ),
          const SizedBox(height: 5),
          Text(detail, style: TextStyle(color: t.subtle, fontSize: 11.5)),
        ],
      ),
    );
  }
}

class _ProcessSection extends ConsumerWidget {
  const _ProcessSection({
    required this.title,
    required this.processes,
    required this.emphasiseCpu,
  });

  final String title;
  final List<MachineProcess> processes;
  final bool emphasiseCpu;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    // The desktop attributes a pid to a section id; the title lives on this side,
    // in the session list the phone already has.
    final titles = <String, String?>{
      for (final row in ref.watch(sessionsStreamProvider).valueOrNull ?? const [])
        row.sessionId: row.title,
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title.toUpperCase(),
          style: TextStyle(
            color: t.subtle,
            fontSize: 11,
            letterSpacing: 0.6,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 6),
        if (processes.isEmpty)
          Text('No processes reported.',
              style: TextStyle(color: t.subtle, fontSize: 12.5))
        else
          for (final row in processes.take(8))
            _ProcessRow(
              process: row,
              emphasiseCpu: emphasiseCpu,
              sectionTitle:
                  row.sessionId == null ? null : titles[row.sessionId!],
            ),
      ],
    );
  }
}

class _ProcessRow extends StatelessWidget {
  const _ProcessRow({
    required this.process,
    required this.emphasiseCpu,
    this.sectionTitle,
  });

  final MachineProcess process;
  final bool emphasiseCpu;
  final String? sectionTitle;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final strong = TextStyle(
        color: t.text, fontSize: 12.5, fontFeatures: const [FontFeature.tabularFigures()]);
    final weak = TextStyle(
        color: t.subtle, fontSize: 12.5, fontFeatures: const [FontFeature.tabularFigures()]);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  process.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: t.text, fontSize: 13),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 56,
                child: Text('${process.cpuPct.toStringAsFixed(1)}%',
                    textAlign: TextAlign.right,
                    style: emphasiseCpu ? strong : weak),
              ),
              SizedBox(
                width: 64,
                child: Text(formatMachineBytes(process.rssBytes),
                    textAlign: TextAlign.right,
                    style: emphasiseCpu ? weak : strong),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Row(
            children: [
              Text('pid ${process.pid}',
                  style: TextStyle(color: t.subtle, fontSize: 10.5)),
              if (sectionTitle != null) ...[
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    sectionTitle!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: t.accent.text, fontSize: 10.5),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
