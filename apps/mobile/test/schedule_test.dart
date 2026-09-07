import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/schedule/schedule_models.dart';

void main() {
  group('ScheduleFrequency.fromDecrypted', () {
    test('parses hourly, daily, and once shapes', () {
      final hourly = ScheduleFrequency.fromDecrypted({'type': 'hourly', 'everyHours': 3});
      expect(hourly, isA<HourlyFrequency>());
      expect((hourly as HourlyFrequency).everyHours, 3);

      final daily = ScheduleFrequency.fromDecrypted({'type': 'daily', 'time': '09:30'});
      expect(daily, isA<DailyFrequency>());
      expect((daily as DailyFrequency).time, '09:30');

      final once = ScheduleFrequency.fromDecrypted({'type': 'once', 'at': '2026-08-05T10:00:00.000Z'});
      expect(once, isA<OnceFrequency>());
      expect((once as OnceFrequency).at, isNotNull);
    });

    test('falls back to a daily frequency for an unknown shape', () {
      final parsed = ScheduleFrequency.fromDecrypted({'type': 'weekly'});
      expect(parsed, isA<DailyFrequency>());
    });
  });

  group('ScheduleFrequency.describe', () {
    test('reads naturally for each type', () {
      expect(const HourlyFrequency(1).describe(), 'every hour');
      expect(const HourlyFrequency(3).describe(), 'every 3 hours');
      expect(const DailyFrequency('09:00').describe(), 'daily at 09:00');
    });
  });

  group('WorkspaceSchedule.fromDecrypted', () {
    Map<String, dynamic> schedule(List<Map<String, dynamic>> items) =>
        {'cwd': '/repo', 'items': items};

    test('reads a schedule and its tasks', () {
      final parsed = WorkspaceSchedule.fromDecrypted(schedule([
        {
          'id': 'a',
          'title': 'Nightly check',
          'prompt': 'Summarize today\'s changes.',
          'frequency': {'type': 'daily', 'time': '09:00'},
          'enabled': true,
        },
      ]));

      expect(parsed.cwd, '/repo');
      expect(parsed.items.single.title, 'Nightly check');
      expect(parsed.items.single.prompt, 'Summarize today\'s changes.');
      expect(parsed.items.single.enabled, isTrue);
    });

    test('drops rows with no id or no title', () {
      final parsed = WorkspaceSchedule.fromDecrypted(schedule([
        {'id': '', 'title': 'No id', 'prompt': 'x', 'frequency': {'type': 'hourly', 'everyHours': 1}},
        {'id': 'b', 'title': '', 'prompt': 'x', 'frequency': {'type': 'hourly', 'everyHours': 1}},
        {'id': 'c', 'title': 'Keep', 'prompt': 'x', 'frequency': {'type': 'hourly', 'everyHours': 1}},
      ]));
      expect(parsed.items.map((i) => i.title), ['Keep']);
    });

    test('carries who scheduled the task', () {
      final parsed = WorkspaceSchedule.fromDecrypted(schedule([
        {
          'id': 'a',
          'title': 'Agent job',
          'prompt': 'x',
          'frequency': {'type': 'hourly', 'everyHours': 1},
          'createdBy': 'agent',
          'createdBySection': 'Relay work',
        },
        {'id': 'b', 'title': 'My job', 'prompt': 'x', 'frequency': {'type': 'hourly', 'everyHours': 1}},
      ]));

      expect(parsed.items.first.byAgent, isTrue);
      expect(parsed.items.first.section, 'Relay work');
      expect(parsed.items.last.byAgent, isFalse);
    });

    test('survives a schedule with nothing on it', () {
      final parsed = WorkspaceSchedule.fromDecrypted({'cwd': '/repo', 'items': []});
      expect(parsed.isEmpty, isTrue);
    });

    test('survives garbage without throwing', () {
      final parsed = WorkspaceSchedule.fromDecrypted({});
      expect(parsed.items, isEmpty);
    });
  });
}
