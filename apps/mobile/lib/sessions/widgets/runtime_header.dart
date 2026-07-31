import '../../theme/panda_tokens.dart';
import 'dart:async';

import 'package:flutter/material.dart';

import '../models.dart';

/// Whimsical present-participles cycled while the agent works, the way Claude
/// Code's CLI teases a live spinner. Purely cosmetic — the spinner already
/// signals "busy"; the changing word just makes the wait feel alive.
const _workingWords = <String>[
  'Thinking',
  'Working',
  'Cooking',
  'Crunching',
  'Pondering',
  'Noodling',
  'Brewing',
  'Churning',
  'Percolating',
  'Conjuring',
  'Computing',
  'Reasoning',
  'Tinkering',
  'Wrangling',
  'Synthesizing',
  'Deliberating',
  'Simmering',
  'Puzzling',
  'Scheming',
  'Whirring',
];

/// Live agent status, docked just above the composer (moved down from under the
/// app bar) so the "what's it doing" signal sits next to where the user acts.
/// While working it shows a spinner and a cycling word; while waiting it shows a
/// slim ready line with cumulative token usage. Hidden when the session needs
/// approval (the approval bar takes over) or has exited.
class RuntimeFooter extends StatefulWidget {
  const RuntimeFooter({
    super.key,
    required this.row,
    this.reduceMotion = false,
    this.desktopOffline = false,
  });

  final SessionRow row;
  final bool reduceMotion;

  /// The paired Mac is unreachable. Only the desktop writes a session's terminal
  /// state, so a force-quit mid-turn leaves the row saying "working" with
  /// nothing behind it — a spinner here would be promising output that will
  /// never arrive.
  final bool desktopOffline;

  @override
  State<RuntimeFooter> createState() => _RuntimeFooterState();
}

class _RuntimeFooterState extends State<RuntimeFooter> {
  Timer? _timer;
  // Start on a per-mount pseudo-random word so two sessions don't march in
  // lockstep; DateTime is fine here (this is app code, not a workflow script).
  int _wordIndex = DateTime.now().microsecond % _workingWords.length;

  AgentState get _state =>
      widget.row.runtime?.agentState ?? widget.row.agentState;

  @override
  void initState() {
    super.initState();
    _syncTimer();
  }

  @override
  void didUpdateWidget(RuntimeFooter oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncTimer();
  }

  /// Run the word cycler only while working and motion is allowed.
  void _syncTimer() {
    final shouldRun = _state == AgentState.working &&
        !widget.desktopOffline &&
        !widget.reduceMotion;
    if (shouldRun && _timer == null) {
      _timer = Timer.periodic(const Duration(milliseconds: 2600), (_) {
        if (!mounted) return;
        setState(() => _wordIndex = (_wordIndex + 1) % _workingWords.length);
      });
    } else if (!shouldRun && _timer != null) {
      _timer!.cancel();
      _timer = null;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = _state;
    // Approval is surfaced by the approval bar; a finished session by the
    // composer's disabled hint. Nothing to add here in those states.
    if (state == AgentState.needsAction || state == AgentState.exited) {
      return const SizedBox.shrink();
    }

    final tokenLabel = _tokenLabel(widget.row);

    // The Mac went away mid-turn. Say so instead of spinning: nothing is
    // running, and the relay will settle the row to "ready" shortly.
    if (widget.desktopOffline && state == AgentState.working) {
      return _bar(
        color: context.tokens.warn.text,
        child: Row(
          children: [
            Icon(Icons.cloud_off_outlined,
                size: 14, color: context.tokens.warn.text),
            SizedBox(width: 9),
            Expanded(
              child: Text(
                'Mac offline — this turn stopped',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: context.tokens.warn.text,
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                ),
              ),
            ),
            if (tokenLabel != null) _TokenPill(label: tokenLabel),
          ],
        ),
      );
    }

    if (state == AgentState.working) {
      final detail = _detail(widget.row);
      return _bar(
        color: context.tokens.info.text,
        child: Row(
          children: [
            SizedBox(
              width: 13,
              height: 13,
              child: CircularProgressIndicator(
                  strokeWidth: 2, color: context.tokens.info.text),
            ),
            SizedBox(width: 9),
            AnimatedSwitcher(
              duration: Duration(milliseconds: widget.reduceMotion ? 0 : 240),
              transitionBuilder: (child, animation) => FadeTransition(
                opacity: animation,
                child: SlideTransition(
                  position: Tween<Offset>(
                    begin: const Offset(0, 0.35),
                    end: Offset.zero,
                  ).animate(animation),
                  child: child,
                ),
              ),
              child: Text(
                '${_workingWords[_wordIndex]}…',
                key: ValueKey(_wordIndex),
                style: TextStyle(
                  color: context.tokens.info.text,
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                ),
              ),
            ),
            if (detail != null) ...[
              SizedBox(width: 10),
              Expanded(
                child: Text(
                  detail,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      color: context.tokens.subtle,
                      fontSize: 12,
                      fontFamily: 'monospace'),
                ),
              ),
            ] else
              const Spacer(),
            if (tokenLabel != null) ...[
              const SizedBox(width: 8),
              _TokenPill(label: tokenLabel),
            ],
          ],
        ),
      );
    }

    // Waiting: a slim ready line, keeping cumulative usage glanceable.
    return _bar(
      color: context.tokens.subtle,
      child: Row(
        children: [
          Icon(Icons.circle, size: 8, color: context.tokens.subtle),
          SizedBox(width: 8),
          Text('Ready',
              style: TextStyle(color: context.tokens.muted, fontSize: 12.5)),
          const Spacer(),
          if (tokenLabel != null) _TokenPill(label: tokenLabel),
        ],
      ),
    );
  }

  Widget _bar({required Color color, required Widget child}) {
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        border: Border(top: BorderSide(color: context.tokens.lineSoft)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      child: child,
    );
  }

  String? _tokenLabel(SessionRow row) {
    final usage = row.runtime?.tokenUsage;
    if (usage == null || usage.isEmpty) return null;
    final n = usage.total;
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M tok';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k tok';
    return '$n tok';
  }

  String? _detail(SessionRow row) {
    final r = row.runtime;
    if (r == null) return null;
    if (r.latestCommand != null && r.latestCommand!.isNotEmpty) {
      return r.latestCommand;
    }
    if (r.latestTool != null && r.latestTool!.isNotEmpty) return r.latestTool;
    return null;
  }
}

class _TokenPill extends StatelessWidget {
  const _TokenPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: context.tokens.panelHover,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.data_usage, size: 11, color: context.tokens.subtle),
          SizedBox(width: 4),
          Text(label,
              style: TextStyle(color: context.tokens.muted, fontSize: 11)),
        ],
      ),
    );
  }
}
