import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/panda_tokens.dart';
import '../../widgets/panda_logo.dart';
import '../models.dart';
import 'image_attachment_view.dart';
import 'markdown_view.dart';
import 'search_highlight.dart';
import 'thinking_block.dart';
import 'tool_call_view.dart';

/// Routes a decrypted [ConversationItem] to the right presentation. This is the
/// heart of the chat UX: each kind renders distinctly instead of a generic bubble.
class ConversationItemView extends StatelessWidget {
  const ConversationItemView({
    super.key,
    required this.item,
    this.toolExpand,
    this.thinkingExpanded = false,
    this.highlightQuery,
    this.activeMatch = false,
    this.onRetrySend,
  });

  final ConversationItem item;

  /// Retry delivery of an optimistic user message that failed to send. Passed
  /// down to failed [_UserMessage] bubbles as a tap-to-retry action.
  final void Function(String id)? onRetrySend;

  /// Broadcasts an expand/collapse-all command as (epoch, expand) to tool cards.
  final ValueListenable<(int, bool)>? toolExpand;

  /// Whether "thinking" blocks start expanded (user preference).
  final bool thinkingExpanded;

  /// Active in-transcript search query; when set, matches inside this item are
  /// tinted. [activeMatch] flags the item the next/prev controls are parked on,
  /// which tints its matches with the stronger focused colour.
  final String? highlightQuery;
  final bool activeMatch;

  @override
  Widget build(BuildContext context) {
    // End-of-turn stats footer ("Worked for 15s · 1.5k tokens"), emitted by the
    // desktop stream parser as a system item anchored to the turn's final
    // assistant message. Rendered as a caption trailing that reply.
    if (isTurnSummaryItem(item)) {
      return _TurnSummary(body: item.body);
    }
    if (item.tool != null) {
      return ToolCallView(
        tool: item.tool!,
        fallbackBody: item.body,
        expandSignal: toolExpand,
        highlightQuery: highlightQuery,
        activeHighlight: activeMatch,
      );
    }
    if (item.thinking) {
      return ThinkingBlock(
        body: item.body,
        initiallyExpanded: thinkingExpanded,
        highlightQuery: highlightQuery,
        activeHighlight: activeMatch,
      );
    }
    return switch (item.kind) {
      'user' => _UserMessage(
          body: item.body,
          images: item.images,
          createdAt: item.createdAt,
          queued: item.queued,
          sendState: item.sendState,
          onRetry: item.sendState == SendState.failed && onRetrySend != null
              ? () => onRetrySend!(item.id)
              : null,
          highlightQuery: highlightQuery,
          activeMatch: activeMatch),
      'system' || 'marker' => _SystemMarker(
          text: item.title ?? item.body,
          highlightQuery: highlightQuery,
          activeMatch: activeMatch),
      _ => _AssistantMessage(
          body: item.body,
          createdAt: item.createdAt,
          highlightQuery: highlightQuery,
          activeMatch: activeMatch),
    };
  }
}

/// Long-press action sheet for a chat message: shows when it was sent (if known)
/// and offers copy.
Future<void> _showMessageActions(
    BuildContext context, String body, int? createdAt) async {
  await showModalBottomSheet(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (createdAt != null && createdAt > 0)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(_formatTimestamp(createdAt),
                    style: TextStyle(
                        color: context.tokens.subtle, fontSize: 12.5)),
              ),
            ),
          ListTile(
            leading: const Icon(Icons.copy),
            title: const Text('Copy message'),
            onTap: () async {
              await Clipboard.setData(ClipboardData(text: body));
              if (ctx.mounted) Navigator.of(ctx).pop();
            },
          ),
        ],
      ),
    ),
  );
}

String _formatTimestamp(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  final hh = d.hour.toString().padLeft(2, '0');
  final mm = d.minute.toString().padLeft(2, '0');
  final sameDay =
      d.year == now.year && d.month == now.month && d.day == now.day;
  if (sameDay) return 'Sent at $hh:$mm';
  return 'Sent ${d.year}-${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')} $hh:$mm';
}

class _UserMessage extends StatelessWidget {
  const _UserMessage({
    required this.body,
    required this.images,
    this.createdAt,
    this.queued = false,
    this.sendState = SendState.none,
    this.onRetry,
    this.highlightQuery,
    this.activeMatch = false,
  });

  final String body;
  final List<ConversationImage> images;
  final int? createdAt;
  final bool queued;
  final SendState sendState;

  /// Tap handler shown on a failed bubble (resends the message).
  final VoidCallback? onRetry;
  final String? highlightQuery;
  final bool activeMatch;

  @override
  Widget build(BuildContext context) {
    final sending = sendState == SendState.sending;
    final failed = sendState == SendState.failed;
    // Nothing to show — no text, no images, no status chrome — would render as a
    // hollow blue bubble (e.g. a legacy image-only message whose cached bytes
    // are gone). Skip it rather than draw an empty box.
    if (body.trim().isEmpty &&
        images.isEmpty &&
        !queued &&
        sendState == SendState.none) {
      return const SizedBox.shrink();
    }
    final bubble = Align(
      alignment: Alignment.centerRight,
      child: GestureDetector(
        onLongPress: () => _showMessageActions(context, body, createdAt),
        onTap: failed ? onRetry : null,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.82),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: context.tokens.info.solid,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(14),
              topRight: Radius.circular(14),
              bottomLeft: Radius.circular(14),
              bottomRight: Radius.circular(4),
            ),
            border: failed
                ? Border.all(
                    color: Theme.of(context).colorScheme.error, width: 1)
                : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (body.trim().isNotEmpty)
                MarkdownView(
                  data: body,
                  selectable: false,
                  highlightQuery: highlightQuery,
                  activeHighlight: activeMatch,
                ),
              if (images.isNotEmpty) ...[
                if (body.trim().isNotEmpty) SizedBox(height: 8),
                ImageAttachmentStrip(images: images),
              ],
              if (queued) ...[
                SizedBox(height: 6),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.schedule,
                        size: 11, color: context.tokens.subtle),
                    SizedBox(width: 4),
                    Text('Queued',
                        style: TextStyle(
                            color: context.tokens.subtle, fontSize: 11)),
                  ],
                ),
              ],
              if (failed) ...[
                const SizedBox(height: 6),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.error_outline,
                        size: 12, color: Theme.of(context).colorScheme.error),
                    const SizedBox(width: 4),
                    Text('Not sent — tap to retry',
                        style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                            fontSize: 11)),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
    if (!sending) return bubble;
    // Sending: dim the bubble and float a small spinner at its trailing edge —
    // instant feedback without a blocking, full-width loading indicator.
    return Opacity(
      opacity: 0.6,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          const Padding(
            padding: EdgeInsets.only(bottom: 12, right: 6),
            child: SizedBox(
              width: 11,
              height: 11,
              child: CircularProgressIndicator(strokeWidth: 1.6),
            ),
          ),
          Flexible(child: bubble),
        ],
      ),
    );
  }
}

class _AssistantMessage extends StatelessWidget {
  const _AssistantMessage({
    required this.body,
    this.createdAt,
    this.highlightQuery,
    this.activeMatch = false,
  });

  final String body;
  final int? createdAt;
  final String? highlightQuery;
  final bool activeMatch;

  @override
  Widget build(BuildContext context) {
    if (body.trim().isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 1, right: 10),
            child: PandaLogo(size: 24),
          ),
          Expanded(
            child: GestureDetector(
              onLongPress: () => _showMessageActions(context, body, createdAt),
              child: MarkdownView(
                data: body,
                selectable: false,
                highlightQuery: highlightQuery,
                activeHighlight: activeMatch,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// End-of-turn stats caption (duration + tokens) trailing an assistant reply.
class _TurnSummary extends StatelessWidget {
  const _TurnSummary({required this.body});

  final String body;

  @override
  Widget build(BuildContext context) {
    if (body.trim().isEmpty) return const SizedBox.shrink();
    return Padding(
      // Align under the assistant message text (24px logo + 10px gap).
      padding: const EdgeInsets.only(left: 34, top: 2, bottom: 6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.speed, size: 12, color: context.tokens.subtle),
          SizedBox(width: 5),
          Flexible(
            child: Text(
              body,
              style: TextStyle(
                color: context.tokens.subtle,
                fontSize: 11.5,
                fontWeight: FontWeight.w500,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SystemMarker extends StatelessWidget {
  const _SystemMarker({
    required this.text,
    this.highlightQuery,
    this.activeMatch = false,
  });

  final String text;
  final String? highlightQuery;
  final bool activeMatch;

  @override
  Widget build(BuildContext context) {
    if (text.trim().isEmpty) return const SizedBox.shrink();
    final style = TextStyle(fontSize: 11.5, color: context.tokens.subtle);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(
            color: context.tokens.lineSoft,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Text.rich(
            TextSpan(
              children: highlightSpans(text, highlightQuery,
                  baseStyle: style, active: activeMatch),
            ),
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}
