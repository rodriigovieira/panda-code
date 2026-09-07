import 'package:flutter/foundation.dart';

/// The workspace's scheduled tasks, phone side. Mirrors `shared/schedule.ts`
/// on the desktop: a job that opens a new section with a prompt on an hourly
/// interval, daily at a time, or once at a future date.
///
/// View-only on the phone for now — see `relay_api.dart`'s `schedule()` — so
/// unlike the backlog this model never round-trips a mutation, only a read.
sealed class ScheduleFrequency {
  const ScheduleFrequency();

  static ScheduleFrequency fromDecrypted(Map<String, dynamic> m) {
    switch (m['type']) {
      case 'hourly':
        final hours = m['everyHours'];
        return HourlyFrequency(hours is num ? hours.toInt() : 1);
      case 'daily':
        return DailyFrequency((m['time'] as String?) ?? '00:00');
      case 'once':
        final at = m['at'] as String?;
        return OnceFrequency(at != null ? DateTime.tryParse(at)?.toLocal() : null);
      default:
        // An unknown shape means a newer desktop; showing it as "off" beats
        // guessing a cadence that is not what it actually does.
        return const DailyFrequency('00:00');
    }
  }

  /// The same phrasing the desktop's `describeFrequency` produces.
  String describe() {
    final self = this;
    return switch (self) {
      HourlyFrequency(everyHours: 1) => 'every hour',
      HourlyFrequency(:final everyHours) => 'every $everyHours hours',
      DailyFrequency(:final time) => 'daily at $time',
      OnceFrequency(at: final at?) => 'once on ${_formatLocal(at)}',
      OnceFrequency() => 'once',
    };
  }

  static String _formatLocal(DateTime at) {
    String pad(int n) => n.toString().padLeft(2, '0');
    return '${at.year}-${pad(at.month)}-${pad(at.day)} ${pad(at.hour)}:${pad(at.minute)}';
  }
}

class HourlyFrequency extends ScheduleFrequency {
  const HourlyFrequency(this.everyHours);
  final int everyHours;
}

class DailyFrequency extends ScheduleFrequency {
  const DailyFrequency(this.time);
  final String time;
}

class OnceFrequency extends ScheduleFrequency {
  const OnceFrequency(this.at);
  final DateTime? at;
}

@immutable
class ScheduledTask {
  final String id;
  final String title;
  final String prompt;
  final ScheduleFrequency frequency;
  final bool enabled;
  final DateTime? nextRunAt;
  final DateTime? lastRunAt;
  final bool byAgent;
  final String? section;

  const ScheduledTask({
    required this.id,
    required this.title,
    required this.prompt,
    required this.frequency,
    this.enabled = true,
    this.nextRunAt,
    this.lastRunAt,
    this.byAgent = false,
    this.section,
  });

  static DateTime? _time(Object? value) =>
      value is String ? DateTime.tryParse(value)?.toLocal() : null;

  static ScheduledTask fromDecrypted(Map<String, dynamic> m) {
    final frequency = m['frequency'];
    return ScheduledTask(
      id: (m['id'] as String?) ?? '',
      title: (m['title'] as String?) ?? '',
      prompt: (m['prompt'] as String?) ?? '',
      frequency: ScheduleFrequency.fromDecrypted(
        frequency is Map ? Map<String, dynamic>.from(frequency) : const {},
      ),
      enabled: m['enabled'] != false,
      nextRunAt: _time(m['nextRunAt']),
      lastRunAt: _time(m['lastRunAt']),
      byAgent: m['createdBy'] == 'agent',
      section: m['createdBySection'] as String?,
    );
  }
}

@immutable
class WorkspaceSchedule {
  final String cwd;
  final List<ScheduledTask> items;

  const WorkspaceSchedule({this.cwd = '', this.items = const []});

  bool get isEmpty => items.isEmpty;

  static WorkspaceSchedule fromDecrypted(Map<String, dynamic> m) {
    final items = m['items'];
    return WorkspaceSchedule(
      cwd: m['cwd'] is String ? m['cwd'] as String : '',
      items: (items is List ? items : const [])
          .whereType<Map>()
          .map((raw) => ScheduledTask.fromDecrypted(Map<String, dynamic>.from(raw)))
          .where((item) => item.id.isNotEmpty && item.title.isNotEmpty)
          .toList(),
    );
  }
}
