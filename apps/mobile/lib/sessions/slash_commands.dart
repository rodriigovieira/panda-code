// The composer's slash-command palette — the same affordance the desktop shows
// when a message starts with "/". Typing "/" alone lists everything; typing
// more filters by name or keyword. Keeping the catalogue here (rather than
// inline in the screen) means the list and its filter stay testable.

class SlashCommand {
  const SlashCommand({
    required this.id,
    required this.label,
    required this.insertText,
    required this.description,
    required this.hint,
    required this.keywords,
    this.runImmediately = false,
  });

  final String id;
  final String label;

  /// What replaces the composer text when the command is picked. Commands that
  /// take an argument keep a trailing space so you can type straight on.
  final String insertText;
  final String description;
  final String hint;
  final List<String> keywords;

  /// Fire the command on pick instead of waiting for a send tap — only for
  /// commands that need no argument.
  final bool runImmediately;
}

const composerSlashCommands = <SlashCommand>[
  SlashCommand(
    id: 'btw',
    label: '/btw',
    insertText: '/btw ',
    description: 'Ask a side question about this session',
    hint: 'Runs separately from the main agent',
    keywords: ['btw', 'by', 'way', 'side', 'ask'],
  ),
  SlashCommand(
    id: 'export',
    label: '/export',
    insertText: '/export',
    description: 'Copy this conversation',
    hint: 'Add `file` or a filename for the share sheet',
    keywords: [
      'export',
      'copy',
      'save',
      'share',
      'download',
      'transcript',
      'markdown',
    ],
    runImmediately: true,
  ),
  SlashCommand(
    id: 'export-clipboard',
    label: '/export clipboard',
    insertText: '/export clipboard',
    description: 'Copy this conversation to the clipboard',
    hint: 'Markdown, ready to paste',
    keywords: ['export', 'clipboard', 'copy', 'paste'],
    runImmediately: true,
  ),
  SlashCommand(
    id: 'prompts',
    label: '/prompts',
    insertText: '/prompts',
    description: 'Show prompts sent and queued in this session',
    hint: 'Useful for reviewing what was asked',
    keywords: ['prompt', 'prompts', 'history', 'queue'],
    runImmediately: true,
  ),
];

/// The query behind a leading "/", or null when the palette should stay closed.
/// Only a bare `/word` opens it — once there's a space the user is typing an
/// argument, not choosing a command.
String? slashQueryOf(String value) {
  final match = RegExp(r'^/([a-z-]*)$', caseSensitive: false).firstMatch(value);
  if (match == null) return null;
  return (match.group(1) ?? '').toLowerCase();
}

List<SlashCommand> filterSlashCommands(
  String? query, {
  List<SlashCommand> commands = composerSlashCommands,
}) {
  if (query == null) return const [];
  if (query.isEmpty) return commands;
  return commands
      .where((command) => [
            command.label.replaceFirst('/', ''),
            ...command.keywords,
          ].any((keyword) => keyword.toLowerCase().contains(query)))
      .toList();
}
