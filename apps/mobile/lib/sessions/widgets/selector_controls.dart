import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/panda_tokens.dart';
import '../models.dart';

/// The model-selector grammar, shared with the desktop `ModelSelector`:
///
///   ordinal choices  -> [SelectorSlider]  (a ranked ramp: effort, model tier)
///   discrete choices -> [SelectorPills]   (unordered: permissions, provider)
///
/// The split is the whole point. A slider says "more of the same thing"; pills
/// say "a different thing". Using a slider for permissions would imply that
/// "Full access" is merely more of "Plan", which is not true and is exactly the
/// kind of wrong affordance that gets a destructive option picked by accident.
///
/// Mobile keeps the desktop anatomy and only changes ergonomics: the thumb grows
/// 15 -> 22px and the track gets a 30px touch band, because a fingertip is not a
/// cursor.

/// The Claude model tiers that form a genuine capability ramp, weakest first.
///
/// The full option list also carries variants (long-context, plan mode, "best
/// available") which are NOT points on this ramp — Opus 1M is not "more than"
/// Fable, it is a different shape of the same tier. Putting them on the slider
/// would invent an ordering that does not exist, so they live in a secondary
/// pill row. Mirrors the desktop selector's primary slider plus
/// `.selector-pills-secondary`.
const claudeModelRamp = <String>['', 'haiku', 'sonnet', 'opus', 'fable'];

/// The ordered ramp for [runtime], or empty when it has no meaningful ordering.
List<LaunchOption> modelRampFor(AgentRuntime runtime) {
  if (runtime == AgentRuntime.codex) return const [];
  final all = modelOptionsFor(runtime);
  return [
    for (final value in claudeModelRamp)
      ...all.where((option) => option.value == value),
  ];
}

/// Everything [modelRampFor] does not cover — long-context and plan variants.
List<LaunchOption> modelVariantsFor(AgentRuntime runtime) {
  final ramp = modelRampFor(runtime).map((o) => o.value).toSet();
  return modelOptionsFor(runtime)
      .where((o) => !ramp.contains(o.value))
      .toList();
}

/// A slider needs at least three stops to earn its space. Codex ships two
/// models, so it falls back to pills rather than pretending to be a ramp.
bool modelUsesSlider(AgentRuntime runtime) => modelRampFor(runtime).length >= 3;

/// Label + value header shared by both control types, so a slider row and a pill
/// row line up on the same grid.
class SelectorHeader extends StatelessWidget {
  const SelectorHeader({
    super.key,
    required this.label,
    required this.icon,
    required this.accent,
    this.value,
    this.badge,
    this.muted = false,
  });

  final String label;
  final IconData icon;
  final Color accent;
  final String? value;
  final String? badge;

  /// True when the row is showing an inherited value the user has not touched.
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Row(
      children: [
        Container(
          width: 22,
          height: 22,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: accent.withValues(alpha: 0.16),
            borderRadius: t.radius.smR,
          ),
          child: Icon(icon, size: 13, color: accent),
        ),
        const SizedBox(width: 8),
        Text(
          label.toUpperCase(),
          style: TextStyle(
            color: t.muted,
            fontSize: 10.5,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.08 * 10.5,
          ),
        ),
        const Spacer(),
        if (value != null)
          Flexible(
            child: Text(
              value!,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.right,
              style: TextStyle(
                color: muted ? t.subtle : t.text,
                fontSize: 13.5,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        if (badge != null) ...[
          const SizedBox(width: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(
              color: accent.withValues(alpha: 0.20),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              badge!.toUpperCase(),
              style: TextStyle(
                color: accent,
                fontSize: 9,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.3,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// A discrete tick slider over an ordered list of [options].
///
/// Snaps to the nearest tick while dragging and fires a selection haptic on each
/// change, so you can feel the steps without watching the label.
class SelectorSlider extends StatefulWidget {
  const SelectorSlider({
    super.key,
    required this.options,
    required this.index,
    required this.accent,
    required this.onChanged,
    this.semanticLabel,
  });

  final List<LaunchOption> options;
  final int index;
  final Color accent;
  final ValueChanged<int> onChanged;
  final String? semanticLabel;

  @override
  State<SelectorSlider> createState() => _SelectorSliderState();
}

class _SelectorSliderState extends State<SelectorSlider> {
  static const double _thumb = 22;
  static const double _band = 30;

  bool _dragging = false;

  void _emit(int i) {
    final clamped = i.clamp(0, widget.options.length - 1);
    if (clamped == widget.index) return;
    HapticFeedback.selectionClick();
    widget.onChanged(clamped);
  }

  void _fromDx(double dx, double usable) {
    if (usable <= 0) return;
    final ratio = (dx / usable).clamp(0.0, 1.0);
    _emit((ratio * (widget.options.length - 1)).round());
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final last = widget.options.length - 1;
    final selected = widget.options[widget.index.clamp(0, last)];

    return Semantics(
      slider: true,
      label: widget.semanticLabel,
      value: selected.label,
      increasedValue:
          widget.index < last ? widget.options[widget.index + 1].label : null,
      decreasedValue:
          widget.index > 0 ? widget.options[widget.index - 1].label : null,
      onIncrease: widget.index < last ? () => _emit(widget.index + 1) : null,
      onDecrease: widget.index > 0 ? () => _emit(widget.index - 1) : null,
      child: ExcludeSemantics(
        child: LayoutBuilder(
          builder: (context, box) {
            // The thumb is centred on each tick, so the travel available to it is
            // the track minus one thumb width.
            final usable = box.maxWidth - _thumb;
            final ratio = last == 0 ? 0.0 : widget.index / last;
            final left = usable * ratio;

            return GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapDown: (d) =>
                  _fromDx(d.localPosition.dx - _thumb / 2, usable),
              onHorizontalDragStart: (_) => setState(() => _dragging = true),
              onHorizontalDragUpdate: (d) =>
                  _fromDx(d.localPosition.dx - _thumb / 2, usable),
              onHorizontalDragEnd: (_) => setState(() => _dragging = false),
              onHorizontalDragCancel: () => setState(() => _dragging = false),
              child: SizedBox(
                height: _band,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    // Rail
                    Positioned(
                      left: _thumb / 2,
                      right: _thumb / 2,
                      top: _band / 2 - 3,
                      child: Container(
                        height: 6,
                        decoration: BoxDecoration(
                          color: t.panelStrong,
                          borderRadius: BorderRadius.circular(999),
                        ),
                      ),
                    ),
                    // Filled portion
                    Positioned(
                      left: _thumb / 2,
                      top: _band / 2 - 3,
                      child: Container(
                        width: left,
                        height: 6,
                        decoration: BoxDecoration(
                          gradient: LinearGradient(colors: [
                            widget.accent.withValues(alpha: 0.55),
                            widget.accent,
                          ]),
                          borderRadius: BorderRadius.circular(999),
                        ),
                      ),
                    ),
                    // Ticks
                    for (var i = 0; i <= last; i++)
                      Positioned(
                        left: _thumb / 2 +
                            (last == 0 ? 0 : usable * (i / last)) -
                            1.5,
                        top: _band / 2 - 1.5,
                        child: Container(
                          width: 3,
                          height: 3,
                          decoration: BoxDecoration(
                            color: i <= widget.index
                                ? Colors.transparent
                                : t.subtle.withValues(alpha: 0.5),
                            shape: BoxShape.circle,
                          ),
                        ),
                      ),
                    // Thumb
                    AnimatedPositioned(
                      duration: PandaMotion.enterFor(context),
                      curve: PandaMotion.easing,
                      left: left,
                      top: (_band - _thumb) / 2,
                      child: Container(
                        width: _thumb,
                        height: _thumb,
                        decoration: BoxDecoration(
                          color: widget.accent,
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: widget.accent
                                  .withValues(alpha: _dragging ? 0.30 : 0.18),
                              blurRadius: 0,
                              spreadRadius: _dragging ? 6 : 4,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

/// A wrapping row of pills for discrete, unordered choices.
class SelectorPills extends StatelessWidget {
  const SelectorPills({
    super.key,
    required this.options,
    required this.value,
    required this.onChanged,
    this.accent,
    this.dangerValues = const <String>{},
  });

  final List<LaunchOption> options;
  final String? value;
  final ValueChanged<String> onChanged;
  final Color? accent;

  /// Options that grant unrestricted access. They take the danger colour rather
  /// than the accent, so "Full access" never looks like an ordinary selection.
  final Set<String> dangerValues;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final acc = accent ?? t.accent.text;
    return Wrap(
      spacing: 7,
      runSpacing: 7,
      children: [
        for (final option in options)
          _Pill(
            label: option.label,
            selected: option.value == value,
            accent: dangerValues.contains(option.value) ? t.danger.text : acc,
            onTap: () {
              HapticFeedback.selectionClick();
              onChanged(option.value);
            },
          ),
      ],
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({
    required this.label,
    required this.selected,
    required this.accent,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final Color accent;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: ExcludeSemantics(
        child: InkWell(
          borderRadius: t.radius.pillR,
          onTap: onTap,
          child: AnimatedContainer(
            duration: PandaMotion.enterFor(context),
            curve: PandaMotion.easing,
            height: t.control.heightSm,
            padding: const EdgeInsets.symmetric(horizontal: 13),
            decoration: BoxDecoration(
              color: selected ? accent.withValues(alpha: 0.16) : t.panelSoft,
              borderRadius: t.radius.pillR,
              border: Border.all(
                color: selected ? accent.withValues(alpha: 0.62) : t.line,
                width: t.control.borderWidth,
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (selected) ...[
                  Container(
                    width: 6,
                    height: 6,
                    decoration:
                        BoxDecoration(color: accent, shape: BoxShape.circle),
                  ),
                  const SizedBox(width: 6),
                ],
                Text(
                  label,
                  style: TextStyle(
                    color: selected ? t.text : t.muted,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One-line explanation under a control. Carries the selected option's hint, so
/// the sheet explains itself without a separate detail view.
class SelectorHint extends StatelessWidget {
  const SelectorHint(this.text, {super.key, this.tone});

  final String text;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    if (text.isEmpty) return const SizedBox.shrink();
    return Text(
      text,
      style: TextStyle(
        color: tone ?? context.tokens.subtle,
        fontSize: 11.5,
        height: 1.35,
      ),
    );
  }
}
