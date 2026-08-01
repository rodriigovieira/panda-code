import 'package:flutter/material.dart';

import '../../theme/panda_tokens.dart';
import '../models.dart';

/// Focus mode: a run of tool calls, thinking, and system activity folded into
/// one quiet row. Tap to unfold the real cards. Deliberately neutral — it must
/// recede behind the messages, so it uses the surface ladder and a hairline,
/// never the accent.
class WorkGroupView extends StatefulWidget {
  const WorkGroupView({
    super.key,
    required this.items,
    required this.running,
    required this.buildItem,
  });

  final List<ConversationItem> items;

  /// The turn is still going and this is the trailing group, so the header
  /// reports the live step instead of a finished count.
  final bool running;

  /// Renders one folded item with the transcript's normal presentation.
  final Widget Function(ConversationItem item) buildItem;

  @override
  State<WorkGroupView> createState() => _WorkGroupViewState();
}

class _WorkGroupViewState extends State<WorkGroupView> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final label = widget.running
        ? '${_lastStepLabel(widget.items)}…'
        : workGroupSummary(widget.items);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: tokens.panelSoft,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: tokens.lineSoft),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              child: Row(
                children: [
                  if (widget.running)
                    SizedBox(
                      width: 13,
                      height: 13,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.6,
                        color: tokens.run.text,
                      ),
                    )
                  else
                    Icon(Icons.handyman_outlined,
                        size: 16, color: tokens.subtle),
                  const SizedBox(width: 8),
                  Text(
                    'Agent work',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: widget.running ? tokens.run.text : tokens.muted,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11.5, color: tokens.subtle),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    _expanded ? 'Hide' : 'Details',
                    style: TextStyle(fontSize: 11.5, color: tokens.accent.text),
                  ),
                  Icon(_expanded ? Icons.expand_less : Icons.expand_more,
                      size: 16, color: tokens.subtle),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final item in widget.items) widget.buildItem(item),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// "6 steps · Read, Edit, Bash" — enough to know what happened without opening.
String workGroupSummary(List<ConversationItem> items) {
  final labels = <String>[];
  for (final item in items) {
    final label = _stepLabel(item);
    if (label.isNotEmpty && !labels.contains(label)) labels.add(label);
  }
  final steps = '${items.length} step${items.length == 1 ? '' : 's'}';
  if (labels.isEmpty) return steps;
  final shown =
      labels.length > 4 ? '${labels.take(4).join(', ')}…' : labels.join(', ');
  return '$steps · $shown';
}

String _stepLabel(ConversationItem item) {
  final tool = item.tool;
  if (tool != null) return tool.name.trim();
  if (item.thinking) return 'Thinking';
  return (item.title ?? '').trim().isEmpty ? 'Activity' : item.title!.trim();
}

String _lastStepLabel(List<ConversationItem> items) =>
    items.isEmpty ? 'Working' : _stepLabel(items.last);
