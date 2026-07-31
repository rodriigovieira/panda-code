import 'package:flutter/material.dart';

import '../../theme/panda_tokens.dart';
import 'search_highlight.dart';

/// Renders a unified diff string with per-line coloring (added / removed /
/// hunk header), monospace, horizontal scroll. Keeps file edits legible instead
/// of a wall of markdown.
class DiffView extends StatelessWidget {
  const DiffView({
    super.key,
    required this.diff,
    this.highlightQuery,
    this.activeHighlight = false,
  });

  final String diff;
  final String? highlightQuery;
  final bool activeHighlight;

  @override
  Widget build(BuildContext context) {
    final lines = diff.split('\n');
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: context.tokens.inputBg,
        borderRadius: context.tokens.radius.mdR,
        border: Border.all(
            color: context.tokens.lineSoft,
            width: context.tokens.control.borderWidth),
      ),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final line in lines)
                _DiffLine(
                  line: line,
                  highlightQuery: highlightQuery,
                  activeHighlight: activeHighlight,
                )
            ],
          ),
        ),
      ),
    );
  }
}

class _DiffLine extends StatelessWidget {
  const _DiffLine({
    required this.line,
    this.highlightQuery,
    this.activeHighlight = false,
  });

  final String line;
  final String? highlightQuery;
  final bool activeHighlight;

  @override
  Widget build(BuildContext context) {
    // Diff colours come from the run/danger groups so an addition is the same
    // green as every other "good" signal. They used to be dark-only literals,
    // which went muddy the moment the app was opened in light mode.
    final t = context.tokens;
    final (Color? bg, Color fg) = switch (line.isEmpty ? ' ' : line[0]) {
      '+' when !line.startsWith('+++') => (t.run.wash, t.run.text),
      '-' when !line.startsWith('---') => (t.danger.wash, t.danger.text),
      '@' when line.startsWith('@@') => (null, t.info.text),
      _ => (null, t.muted),
    };
    final text = line.isEmpty ? ' ' : line;
    final style = TextStyle(
        fontFamily: 'monospace', fontSize: 12.5, height: 1.35, color: fg);
    return Container(
      color: bg,
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Text.rich(
        TextSpan(
          children: highlightSpans(text, highlightQuery,
              baseStyle: style, active: activeHighlight),
        ),
      ),
    );
  }
}
