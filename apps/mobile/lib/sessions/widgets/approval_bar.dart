import 'package:flutter/material.dart';

import '../../theme/panda_tokens.dart';
import '../models.dart';

/// The couch-approval affordance: when the agent pauses on a tool-permission
/// prompt (agentState == needs_action), this bar lets you approve/deny from the
/// phone. Arguably the whole point of the mobile app. When we know which [tool]
/// is pending, it previews the command/target so you can decide without hunting.
class ApprovalBar extends StatefulWidget {
  const ApprovalBar({
    super.key,
    required this.onAnswer,
    this.busy = false,
    this.label,
    this.tool,
    this.approval,
  });

  final Future<void> Function(String? optionId, String? text) onAnswer;
  final bool busy;
  final String? label;
  final ToolData? tool;
  final PendingApproval? approval;

  @override
  State<ApprovalBar> createState() => _ApprovalBarState();
}

class _ApprovalBarState extends State<ApprovalBar> {
  final _textController = TextEditingController();

  @override
  void didUpdateWidget(covariant ApprovalBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldApproval = oldWidget.approval;
    final approval = widget.approval;
    if (oldApproval?.promptId != approval?.promptId ||
        oldApproval?.questionIndex != approval?.questionIndex) {
      _textController.clear();
    }
  }

  @override
  void dispose() {
    _textController.dispose();
    super.dispose();
  }

  Future<void> _answer(String? optionId, [String? text]) async {
    if (widget.busy) return;
    await widget.onAnswer(optionId, text?.trim());
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final approval = widget.approval;
    final preview = _preview(widget.tool);
    final options = approval?.options ?? const <ApprovalOption>[];
    final freeText = approval?.allowsFreeText == true;
    final count = approval?.questionCount ?? 1;
    final index = approval?.questionIndex ?? 0;
    // The amber "needs you" surface, with a 2px warn edge so the bar reads as a
    // state change rather than just another toolbar. This used to be a hardcoded
    // #3A2A2A, which meant it ignored the theme entirely.
    return Material(
      color: t.warn.wash,
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: t.warn.edge, width: 2)),
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (preview != null) ...[
                  Row(
                    children: [
                      Icon(Icons.terminal, size: 14, color: t.warn.text),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          widget.tool?.name ?? 'Tool',
                          style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: t.muted),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: t.inputBg,
                      borderRadius: t.radius.mdR,
                      border: Border.all(
                          color: t.line, width: t.control.borderWidth),
                    ),
                    child: Text(
                      preview,
                      maxLines: 4,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 12,
                          color: t.muted),
                    ),
                  ),
                  const SizedBox(height: 8),
                ],
                if (approval != null) ...[
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          approval.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                              color: t.text),
                        ),
                      ),
                      if (count > 1)
                        Text(
                          '${index + 1} of $count',
                          style: TextStyle(fontSize: 12, color: t.subtle),
                        ),
                    ],
                  ),
                  if (approval.body.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      approval.body,
                      maxLines: 4,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, color: t.muted),
                    ),
                  ],
                  if (approval.reason?.isNotEmpty == true) ...[
                    const SizedBox(height: 4),
                    Text(
                      approval.reason!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: t.subtle),
                    ),
                  ],
                  const SizedBox(height: 8),
                ],
                Row(
                  children: [
                    Icon(Icons.pending_actions, color: t.warn.text, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        widget.label ?? 'Waiting for your approval',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 13, color: t.text),
                      ),
                    ),
                    if (widget.busy) ...[
                      const SizedBox(width: 8),
                      const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2)),
                    ],
                  ],
                ),
                const SizedBox(height: 10),
                if (options.isNotEmpty)
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final option in options)
                        option.isDeny
                            ? OutlinedButton(
                                onPressed: widget.busy
                                    ? null
                                    : () => _answer(option.id),
                                child: Text(option.label),
                              )
                            : FilledButton(
                                onPressed: widget.busy
                                    ? null
                                    : () => _answer(option.id),
                                style: FilledButton.styleFrom(
                                    backgroundColor: t.run.solid,
                                    foregroundColor: t.run.on),
                                child: Text(option.label),
                              ),
                    ],
                  )
                else
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      // Deny is deliberately neutral rather than red — denying is
                      // not destructive, it is simply the other answer.
                      OutlinedButton(
                        onPressed:
                            widget.busy ? null : () => _answer('decline'),
                        child: const Text('Deny'),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        onPressed: widget.busy ? null : () => _answer('accept'),
                        style: FilledButton.styleFrom(
                            backgroundColor: t.run.solid,
                            foregroundColor: t.run.on),
                        child: const Text('Approve'),
                      ),
                    ],
                  ),
                if (freeText) ...[
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _textController,
                          enabled: !widget.busy,
                          obscureText: approval?.kind == 'userInput' &&
                              approval?.title.toLowerCase().contains('pin') ==
                                  true,
                          decoration: const InputDecoration(
                            border: OutlineInputBorder(),
                            isDense: true,
                          ),
                          textInputAction: TextInputAction.send,
                          onSubmitted: (value) {
                            if (value.trim().isNotEmpty) {
                              _answer(null, value);
                            }
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filled(
                        onPressed: widget.busy
                            ? null
                            : () {
                                final text = _textController.text.trim();
                                if (text.isNotEmpty) _answer(null, text);
                              },
                        tooltip: 'Send answer',
                        icon: const Icon(Icons.arrow_upward),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  String? _preview(ToolData? t) {
    if (t == null) return null;
    return t.command ?? t.diff ?? t.filePath ?? t.input;
  }
}
