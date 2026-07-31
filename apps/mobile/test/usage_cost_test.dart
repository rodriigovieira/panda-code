import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/usage_cost_screen.dart';

// 2026-07-29 is a Wednesday. Same fixtures as the desktop's usage.test.ts so the
// two surfaces can't silently drift apart on what "this week" means.
final now = DateTime(2026, 7, 29, 14, 30);

String day(DateTime d) =>
    '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

void main() {
  group('resolveUsageRange', () {
    test('today covers only today', () {
      final range = resolveUsageRange(UsageRangePreset.today, now);
      expect(day(range.from), '2026-07-29');
      expect(day(range.to), '2026-07-29');
      expect(range.from.hour, 0);
      expect(range.to.hour, 23);
    });

    test('yesterday covers only yesterday', () {
      final range = resolveUsageRange(UsageRangePreset.yesterday, now);
      expect(day(range.from), '2026-07-28');
      expect(day(range.to), '2026-07-28');
    });

    test('this week starts on Monday', () {
      final range = resolveUsageRange(UsageRangePreset.thisWeek, now);
      expect(day(range.from), '2026-07-27');
      expect(day(range.to), '2026-07-29');
    });

    test('last 7 days is inclusive of today', () {
      final range = resolveUsageRange(UsageRangePreset.last7, now);
      expect(day(range.from), '2026-07-23');
    });

    test('this month starts on the first', () {
      final range = resolveUsageRange(UsageRangePreset.thisMonth, now);
      expect(day(range.from), '2026-07-01');
      expect(day(range.to), '2026-07-29');
    });

    test('last 30 days is inclusive of today', () {
      final range = resolveUsageRange(UsageRangePreset.last30, now);
      expect(day(range.from), '2026-06-30');
    });

    test('custom swaps reversed endpoints', () {
      final range = resolveUsageRange(
        UsageRangePreset.custom,
        now,
        custom: UsageRange(
          from: DateTime(2026, 5, 9),
          to: DateTime(2026, 5, 2),
        ),
      );
      expect(day(range.from), '2026-05-02');
      expect(day(range.to), '2026-05-09');
    });

    test('custom without a range falls back to this month', () {
      final range = resolveUsageRange(UsageRangePreset.custom, now);
      expect(day(range.from), '2026-07-01');
    });
  });

  group('formatUsd', () {
    test('keeps sub-cent amounts legible', () {
      expect(formatUsd(0), r'$0.00');
      expect(formatUsd(0.0034), r'$0.0034');
      expect(formatUsd(0.42), r'$0.420');
      expect(formatUsd(12.3456), r'$12.35');
      expect(formatUsd(4200), r'$4200');
    });
  });

  group('UsageCostReport.fromDecrypted', () {
    test('parses the desktop payload', () {
      final report = UsageCostReport.fromDecrypted({
        'tokens': {
          'inputTokens': 10,
          'outputTokens': 20,
          'cacheCreationInputTokens': 30,
          'cacheReadInputTokens': 40,
          'totalTokens': 100,
        },
        'cost': {'totalUsd': 1.5, 'outputUsd': 1.5, 'priced': true},
        'groups': [
          {
            'runtime': 'codex',
            'model': 'gpt-5-codex',
            'modelLabel': 'GPT-5 Codex',
            'rateSummary': r'$1.25 in · $10.00 out per Mtok',
            'tokens': {'totalTokens': 100},
            'cost': {'totalUsd': 1.5, 'priced': true},
          },
        ],
        'unpricedModels': ['mystery'],
        'sessionCount': 2,
      });

      expect(report.tokens.total, 100);
      expect(report.cost.totalUsd, 1.5);
      expect(report.groups.single.runtime, AgentRuntime.codex);
      expect(report.groups.single.modelLabel, 'GPT-5 Codex');
      expect(report.unpricedModels, ['mystery']);
      expect(report.sessionCount, 2);
      expect(report.isEmpty, isFalse);
    });

    test('degrades to an empty report on a missing payload', () {
      final report = UsageCostReport.fromDecrypted({});
      expect(report.isEmpty, isTrue);
      expect(report.groups, isEmpty);
    });
  });
}
