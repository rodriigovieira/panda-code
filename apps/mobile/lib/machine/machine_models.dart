import 'package:flutter/foundation.dart';

/// The paired Mac's current state, phone side. Mirrors `MachineStats` in
/// `apps/desktop/src/shared/machine-stats.ts` — the same snapshot the desktop
/// drawer and the agents' `machine_status` tool read, fetched over a
/// `machine-stats` command round-trip (see `relay_api.dart`'s `machineStats()`).
///
/// Deliberately not cached on the phone: every number here is true for about a
/// second, so a stale copy would be worse than none.
@immutable
class MachineProcess {
  final int pid;
  final int ppid;
  final String name;
  final String? command;
  final double cpuPct;
  final int rssBytes;
  final double memPct;

  /// The Panda section this process belongs to, when the desktop could attribute
  /// it — that is what turns "node at 300%" into a section the user recognises.
  final String? sessionId;

  const MachineProcess({
    required this.pid,
    required this.ppid,
    required this.name,
    required this.cpuPct,
    required this.rssBytes,
    required this.memPct,
    this.command,
    this.sessionId,
  });

  static MachineProcess fromDecrypted(Map<String, dynamic> m) => MachineProcess(
        pid: (m['pid'] as num?)?.toInt() ?? 0,
        ppid: (m['ppid'] as num?)?.toInt() ?? 0,
        name: (m['name'] as String?) ?? '',
        command: m['command'] as String?,
        cpuPct: (m['cpuPct'] as num?)?.toDouble() ?? 0,
        rssBytes: (m['rssBytes'] as num?)?.toInt() ?? 0,
        memPct: (m['memPct'] as num?)?.toDouble() ?? 0,
        sessionId: m['sessionId'] as String?,
      );
}

enum MachinePressure { quiet, busy, loaded }

@immutable
class MachineStats {
  final DateTime? capturedAt;
  final String hostname;
  final String platform;
  final int uptimeSec;
  final int cpuCount;
  final List<double> loadAvg;
  final double? cpuPct;
  final int memTotalBytes;
  final int? memAvailableBytes;
  final double? memUsedPct;
  final int? memCompressedBytes;
  final int? swapUsedBytes;
  final int? swapTotalBytes;
  final double? diskUsedPct;
  final int? diskFreeBytes;
  final List<MachineProcess> topByCpu;
  final List<MachineProcess> topByMemory;
  final String? error;

  const MachineStats({
    required this.hostname,
    required this.platform,
    required this.uptimeSec,
    required this.cpuCount,
    required this.loadAvg,
    required this.memTotalBytes,
    required this.topByCpu,
    required this.topByMemory,
    this.capturedAt,
    this.cpuPct,
    this.memAvailableBytes,
    this.memUsedPct,
    this.memCompressedBytes,
    this.swapUsedBytes,
    this.swapTotalBytes,
    this.diskUsedPct,
    this.diskFreeBytes,
    this.error,
  });

  /// Same rule as the desktop's `machinePressure`: load per core AND memory
  /// headroom, because a box can be idle and still one build away from swapping.
  MachinePressure get pressure {
    final perCore = cpuCount > 0 ? load1 / cpuCount : load1;
    final used = memUsedPct ?? 0;
    if (perCore > 1.5 || used >= 92) return MachinePressure.loaded;
    if (perCore > 0.8 || used >= 80) return MachinePressure.busy;
    return MachinePressure.quiet;
  }

  double get load1 => loadAvg.isNotEmpty ? loadAvg.first : 0;

  double? get swapUsedPct =>
      swapUsedBytes != null && swapTotalBytes != null && swapTotalBytes! > 0
          ? (swapUsedBytes! / swapTotalBytes!) * 100
          : null;

  static List<MachineProcess> _processes(Object? raw) => raw is List
      ? raw
          .whereType<Map>()
          .map((e) => MachineProcess.fromDecrypted(Map<String, dynamic>.from(e)))
          .toList()
      : const [];

  static MachineStats fromDecrypted(Map<String, dynamic> m) {
    final load = m['loadAvg'];
    return MachineStats(
      capturedAt: DateTime.tryParse((m['capturedAt'] as String?) ?? ''),
      hostname: (m['hostname'] as String?) ?? 'This Mac',
      platform: (m['platform'] as String?) ?? '',
      uptimeSec: (m['uptimeSec'] as num?)?.toInt() ?? 0,
      cpuCount: (m['cpuCount'] as num?)?.toInt() ?? 1,
      loadAvg: load is List
          ? load.whereType<num>().map((n) => n.toDouble()).toList()
          : const [0, 0, 0],
      cpuPct: (m['cpuPct'] as num?)?.toDouble(),
      memTotalBytes: (m['memTotalBytes'] as num?)?.toInt() ?? 0,
      memAvailableBytes: (m['memAvailableBytes'] as num?)?.toInt(),
      memUsedPct: (m['memUsedPct'] as num?)?.toDouble(),
      memCompressedBytes: (m['memCompressedBytes'] as num?)?.toInt(),
      swapUsedBytes: (m['swapUsedBytes'] as num?)?.toInt(),
      swapTotalBytes: (m['swapTotalBytes'] as num?)?.toInt(),
      diskUsedPct: (m['diskUsedPct'] as num?)?.toDouble(),
      diskFreeBytes: (m['diskFreeBytes'] as num?)?.toInt(),
      topByCpu: _processes(m['topByCpu']),
      topByMemory: _processes(m['topByMemory']),
      error: m['error'] as String?,
    );
  }
}

/// Same ladder as the desktop's `formatBytes`, so a number read on the phone and
/// the same number read on the Mac are spelled identically.
String formatMachineBytes(int? bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return '$bytes B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  var value = bytes / 1024;
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value >= 10
      ? '${value.round()} ${units[unit]}'
      : '${value.toStringAsFixed(1)} ${units[unit]}';
}

String formatMachinePct(double? value) =>
    value == null ? '—' : '${value.round()}%';

String formatMachineUptime(int seconds) {
  final days = seconds ~/ 86400;
  final hours = (seconds % 86400) ~/ 3600;
  final minutes = (seconds % 3600) ~/ 60;
  if (days > 0) return '${days}d ${hours}h';
  if (hours > 0) return '${hours}h ${minutes}m';
  return '${minutes}m';
}
