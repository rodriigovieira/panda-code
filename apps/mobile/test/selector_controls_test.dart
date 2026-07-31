import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/widgets/selector_controls.dart';
import 'package:panda_code_mobile/theme/panda_theme.dart';

Widget _wrap(Widget child) => MaterialApp(
      theme: buildPandaTheme(
        brightness: Brightness.dark,
        density: VisualDensity.standard,
      ),
      home: Scaffold(body: Padding(padding: const EdgeInsets.all(20), child: child)),
    );

const _ramp = <LaunchOption>[
  LaunchOption(value: '', label: 'Default', hint: 'Runtime default'),
  LaunchOption(value: 'low', label: 'Low', hint: 'Fastest'),
  LaunchOption(value: 'medium', label: 'Medium', hint: 'Light'),
  LaunchOption(value: 'high', label: 'High', hint: 'Standard'),
  LaunchOption(value: 'max', label: 'Max', hint: 'Deepest'),
];

void main() {
  group('SelectorSlider', () {
    testWidgets('tapping the far right snaps to the last stop', (tester) async {
      var picked = -1;
      await tester.pumpWidget(_wrap(SelectorSlider(
        options: _ramp,
        index: 0,
        accent: const Color(0xFFD0A85D),
        onChanged: (i) => picked = i,
      )));

      final box = tester.getRect(find.byType(SelectorSlider));
      await tester.tapAt(Offset(box.right - 2, box.center.dy));
      await tester.pumpAndSettle();

      expect(picked, _ramp.length - 1);
    });

    testWidgets('tapping mid-track snaps to the nearest tick, not a raw ratio',
        (tester) async {
      var picked = -1;
      await tester.pumpWidget(_wrap(SelectorSlider(
        options: _ramp,
        index: 0,
        accent: const Color(0xFFD0A85D),
        onChanged: (i) => picked = i,
      )));

      final box = tester.getRect(find.byType(SelectorSlider));
      await tester.tapAt(box.center);
      await tester.pumpAndSettle();

      // 5 stops, centre of the track -> index 2. A continuous slider would have
      // produced a fractional value here; this control must quantise.
      expect(picked, 2);
    });

    testWidgets('does not fire when the tap lands on the current stop',
        (tester) async {
      var calls = 0;
      await tester.pumpWidget(_wrap(SelectorSlider(
        options: _ramp,
        index: 0,
        accent: const Color(0xFFD0A85D),
        onChanged: (_) => calls++,
      )));

      final box = tester.getRect(find.byType(SelectorSlider));
      await tester.tapAt(Offset(box.left + 2, box.center.dy));
      await tester.pumpAndSettle();

      expect(calls, 0, reason: 'no-op taps should not emit or buzz');
    });

    testWidgets('exposes slider semantics with the selected label',
        (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(_wrap(SelectorSlider(
        options: _ramp,
        index: 2,
        accent: const Color(0xFFD0A85D),
        semanticLabel: 'Effort',
        onChanged: (_) {},
      )));

      // VoiceOver has to announce the value and be able to step it, otherwise
      // the control is unusable without sight.
      expect(
        tester.getSemantics(find.byType(SelectorSlider)),
        matchesSemantics(
          isSlider: true,
          label: 'Effort',
          value: 'Medium',
          increasedValue: 'High',
          decreasedValue: 'Low',
          hasIncreaseAction: true,
          hasDecreaseAction: true,
        ),
      );
      handle.dispose();
    });
  });

  group('SelectorPills', () {
    testWidgets('reports the tapped option value', (tester) async {
      String? picked;
      await tester.pumpWidget(_wrap(SelectorPills(
        options: claudePermissionOptions,
        value: '',
        onChanged: (v) => picked = v,
      )));

      await tester.tap(find.text('Plan'));
      await tester.pumpAndSettle();

      expect(picked, 'plan');
    });

    testWidgets('full-access pills take the danger colour, not the accent',
        (tester) async {
      await tester.pumpWidget(_wrap(SelectorPills(
        options: claudePermissionOptions,
        value: 'bypassPermissions',
        dangerValues: fullAccessPermissionModes,
        onChanged: (_) {},
      )));

      // "Full access" must never look like one more notch along the ramp.
      final container = tester.widget<AnimatedContainer>(
        find
            .ancestor(
              of: find.text('Full access'),
              matching: find.byType(AnimatedContainer),
            )
            .first,
      );
      final decoration = container.decoration! as BoxDecoration;
      final border = decoration.border! as Border;
      expect(border.top.color.r, greaterThan(border.top.color.g),
          reason: 'selected full-access border should be red-dominant');
    });
  });
}
