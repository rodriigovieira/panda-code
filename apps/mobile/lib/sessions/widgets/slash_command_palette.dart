import 'package:flutter/material.dart';

import '../../theme/panda_tokens.dart';
import '../slash_commands.dart';

/// The list that appears above the composer the moment a message starts with
/// "/" — the desktop's command palette, sized for a thumb. Tapping a row either
/// runs the command or drops it into the composer ready for an argument.
class SlashCommandPalette extends StatelessWidget {
  const SlashCommandPalette({
    super.key,
    required this.commands,
    required this.onPick,
  });

  final List<SlashCommand> commands;
  final void Function(SlashCommand command) onPick;

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
        // The keyboard already takes half the screen; cap the palette so it
        // can never push the composer itself out of reach.
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 220),
          child: ListView.separated(
            shrinkWrap: true,
            padding: EdgeInsets.zero,
            itemCount: commands.length,
            separatorBuilder: (_, __) =>
                Divider(height: 1, color: t.lineSoft),
            itemBuilder: (context, index) {
              final command = commands[index];
              return InkWell(
                onTap: () => onPick(command),
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
                            Text(
                              command.label,
                              style: TextStyle(
                                fontWeight: FontWeight.w600,
                                color: t.accent.text,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              command.description,
                              style: TextStyle(fontSize: 12, color: t.subtle),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Flexible(
                        child: Text(
                          command.hint,
                          textAlign: TextAlign.right,
                          style: TextStyle(
                            fontSize: 11,
                            fontStyle: FontStyle.italic,
                            color: t.subtle,
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
      ),
    );
  }
}
