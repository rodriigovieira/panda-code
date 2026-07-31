import 'package:flutter/material.dart';

import '../../theme/panda_tokens.dart';
import 'markdown_view.dart';
import 'search_highlight.dart';

/// Assistant "thinking" — collapsed by default, dim, expandable. Keeps reasoning
/// available without dominating the transcript.
class ThinkingBlock extends StatefulWidget {
  const ThinkingBlock({
    super.key,
    required this.body,
    this.initiallyExpanded = false,
    this.highlightQuery,
    this.activeHighlight = false,
  });

  final String body;
  final bool initiallyExpanded;
  final String? highlightQuery;
  final bool activeHighlight;

  @override
  State<ThinkingBlock> createState() => _ThinkingBlockState();
}

class _ThinkingBlockState extends State<ThinkingBlock> {
  late bool _expanded = widget.initiallyExpanded;

  /// Reveal the reasoning when a search hit lands inside it (a collapsed block
  /// would otherwise hide the match).
  bool get _showExpanded =>
      _expanded || queryMatches(widget.body, widget.highlightQuery);

  @override
  Widget build(BuildContext context) {
    final showExpanded = _showExpanded;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 3),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: context.tokens.lineSoft),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Row(
              children: [
                Icon(Icons.psychology_outlined,
                    size: 15, color: context.tokens.subtle),
                SizedBox(width: 6),
                Text('Thinking',
                    style: TextStyle(
                        fontSize: 12,
                        color: context.tokens.subtle,
                        fontStyle: FontStyle.italic)),
                const Spacer(),
                Icon(showExpanded ? Icons.expand_less : Icons.expand_more,
                    size: 16, color: context.tokens.subtle),
              ],
            ),
          ),
          if (showExpanded)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: DefaultTextStyle.merge(
                style: TextStyle(color: context.tokens.subtle, fontSize: 13),
                child: Opacity(
                  opacity: 0.75,
                  child: MarkdownView(
                    data: widget.body,
                    highlightQuery: widget.highlightQuery,
                    activeHighlight: widget.activeHighlight,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
