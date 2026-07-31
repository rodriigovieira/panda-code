import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/panda_tokens.dart';

/// One prompt to show in the /prompt history sheet. [queued] entries are still
/// waiting to steer the current turn; the rest were already sent this session.
class PromptEntry {
  final String text;
  final int imageCount;
  final int? timeMs; // logical time of a sent prompt; null while queued
  final bool queued;

  const PromptEntry({
    required this.text,
    required this.imageCount,
    required this.timeMs,
    required this.queued,
  });

  String get display {
    final trimmed = text.trim();
    if (trimmed.isNotEmpty) return trimmed;
    return '$imageCount image${imageCount == 1 ? '' : 's'}';
  }
}

/// The /prompt sheet: a read-only history of everything typed this session —
/// the latest prompt on top, earlier ones below, and anything still queued in
/// its own section. Nothing here touches the live session; it's a recall aid.
Future<void> showPromptSheet(
  BuildContext context, {
  required List<PromptEntry> sent,
  required List<PromptEntry> queued,
}) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Theme.of(context).colorScheme.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => _PromptSheet(sent: sent, queued: queued),
  );
}

class _PromptSheet extends StatelessWidget {
  const _PromptSheet({required this.sent, required this.queued});

  final List<PromptEntry> sent;
  final List<PromptEntry> queued;

  @override
  Widget build(BuildContext context) {
    final isEmpty = sent.isEmpty && queued.isEmpty;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      minChildSize: 0.35,
      maxChildSize: 0.95,
      builder: (context, sheetScroll) {
        return Column(
          children: [
            _header(context),
            Expanded(
              child: isEmpty
                  ? const _EmptyState()
                  : ListView(
                      controller: sheetScroll,
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                      children: [
                        if (queued.isNotEmpty) ...[
                          const _SectionLabel('Queued'),
                          for (var i = 0; i < queued.length; i++)
                            _PromptTile(
                              entry: queued[i],
                              badge: 'Queued #${i + 1}',
                            ),
                          const SizedBox(height: 8),
                        ],
                        if (sent.isNotEmpty) ...[
                          const _SectionLabel('Sent'),
                          for (var i = 0; i < sent.length; i++)
                            _PromptTile(
                              entry: sent[i],
                              badge: i == 0 ? 'Latest' : '#${sent.length - i}',
                              highlight: i == 0,
                            ),
                        ],
                      ],
                    ),
            ),
          ],
        );
      },
    );
  }

  Widget _header(BuildContext context) {
    final count = sent.isEmpty && queued.isEmpty
        ? 'Nothing sent yet'
        : '${sent.length} sent · ${queued.length} queued';
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
      child: Row(
        children: [
          Icon(Icons.forum_outlined, size: 18, color: context.tokens.muted),
          SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Prompts',
                    style:
                        TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                Text(
                  count,
                  style: TextStyle(fontSize: 12, color: context.tokens.subtle),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close),
            tooltip: 'Close',
            onPressed: () => Navigator.of(context).maybePop(),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 12, 0, 6),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.6,
          color: context.tokens.subtle,
        ),
      ),
    );
  }
}

class _PromptTile extends StatelessWidget {
  const _PromptTile({
    required this.entry,
    required this.badge,
    this.highlight = false,
  });

  final PromptEntry entry;
  final String badge;
  final bool highlight;

  String _time(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
    final h = d.hour.toString().padLeft(2, '0');
    final m = d.minute.toString().padLeft(2, '0');
    return '$h:$m';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accent = entry.queued
        ? context.tokens.accent.text
        : highlight
            ? theme.colorScheme.primary
            : context.tokens.muted;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      decoration: BoxDecoration(
        color:
            entry.queued ? context.tokens.warn.wash : context.tokens.panelHover,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: entry.queued
              ? context.tokens.accent.washStrong
              : context.tokens.panelHover,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  badge,
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                    color: accent,
                  ),
                ),
              ),
              if (entry.imageCount > 0) ...[
                SizedBox(width: 8),
                Icon(Icons.image_outlined,
                    size: 13, color: context.tokens.subtle),
                SizedBox(width: 3),
                Text(
                  '${entry.imageCount}',
                  style: TextStyle(fontSize: 11, color: context.tokens.subtle),
                ),
              ],
              const Spacer(),
              if (!entry.queued && entry.timeMs != null)
                Text(
                  _time(entry.timeMs!),
                  style: TextStyle(fontSize: 11, color: context.tokens.subtle),
                ),
              const SizedBox(width: 4),
              InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: () {
                  Clipboard.setData(ClipboardData(text: entry.text));
                  HapticFeedback.selectionClick();
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Prompt copied'),
                      duration: Duration(seconds: 1),
                    ),
                  );
                },
                child: Padding(
                  padding: const EdgeInsets.all(4),
                  child: Icon(Icons.copy_outlined,
                      size: 15, color: context.tokens.subtle),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          SelectableText(
            entry.display,
            style: const TextStyle(fontSize: 14, height: 1.4),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.forum_outlined, size: 40, color: context.tokens.subtle),
            SizedBox(height: 12),
            const Text('No prompts yet',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text(
              'Prompts you send in this session show up here — the latest on '
              'top, plus anything still queued.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: context.tokens.subtle),
            ),
          ],
        ),
      ),
    );
  }
}
