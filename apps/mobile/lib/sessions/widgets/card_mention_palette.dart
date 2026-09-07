import 'package:flutter/material.dart';

import '../../backlog/backlog_models.dart';
import '../../theme/panda_tokens.dart';

/// The list that appears above the composer the moment a message ends in a
/// `#` — the board's answer to the slash palette. Tapping a row drops `#12`
/// into the prompt, which is how a card is named to an agent.
class CardMentionPalette extends StatelessWidget {
  const CardMentionPalette({
    super.key,
    required this.cards,
    required this.onPick,
  });

  final List<BacklogItem> cards;
  final void Function(BacklogItem card) onPick;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: t.panelStrong,
        border: Border.all(color: t.lineSoft),
        borderRadius: t.radius.mdR,
      ),
      child: ClipRRect(
        borderRadius: t.radius.mdR,
        // Same cap as the slash palette: the keyboard already owns half the
        // screen, and the composer must stay reachable underneath it.
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 220),
          child: ListView.separated(
            shrinkWrap: true,
            padding: EdgeInsets.zero,
            itemCount: cards.length,
            separatorBuilder: (_, __) => Divider(height: 1, color: t.lineSoft),
            itemBuilder: (context, index) {
              final card = cards[index];
              return InkWell(
                onTap: () => onPick(card),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text.rich(
                              TextSpan(
                                children: [
                                  TextSpan(
                                    text: '${card.ref} ',
                                    style: TextStyle(color: t.accent.text),
                                  ),
                                  TextSpan(text: card.title),
                                ],
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontWeight: FontWeight.w600,
                                color: t.text,
                              ),
                            ),
                            if (card.summary.isNotEmpty) ...[
                              const SizedBox(height: 2),
                              Text(
                                card.summary,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 12, color: t.subtle),
                              ),
                            ],
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Text(
                        card.column.label,
                        style: TextStyle(
                          fontSize: 11,
                          fontStyle: FontStyle.italic,
                          color: t.subtle,
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
