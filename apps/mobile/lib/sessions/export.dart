import 'models.dart';

/// Rendering a session's transcript for humans. `/export` writes it to a file
/// (via the share sheet) or the clipboard. Mirrors the desktop's
/// `renderer/src/export.ts` so a transcript exported from the phone and one
/// exported from the Mac are the same document.

class ExportMeta {
  const ExportMeta({
    this.title,
    this.cwd,
    this.runtime,
    this.model,
    this.exportedAt,
  });

  final String? title;
  final String? cwd;
  final String? runtime;
  final String? model;
  final DateTime? exportedAt;
}

/// The item's own title is the best label we have (a tool's name, the runtime's
/// display name), so it wins; the kind is only the fallback.
String _speakerFor(ConversationItem item) {
  final title = item.title?.trim();
  if (title != null && title.isNotEmpty) return title;
  return switch (item.kind) {
    'user' => 'User',
    'assistant' => 'Assistant',
    'tool' => 'Tool',
    'agent' => 'Agent',
    'system' => 'System',
    _ => 'Note',
  };
}

/// A tool call's body on mobile lives in the structured [ToolData], not in
/// `body` — flatten it to the command/path/input the card shows, plus its
/// output, so the export isn't a list of empty tool headings.
String _bodyFor(ConversationItem item) {
  final tool = item.tool;
  if (tool == null) return item.body.trim();

  final parts = <String>[];
  final subject = tool.command ?? tool.filePath ?? tool.input;
  if (subject != null && subject.trim().isNotEmpty) {
    parts.add('```\n${subject.trim()}\n```');
  }
  final diff = tool.diff;
  if (diff != null && diff.trim().isNotEmpty) {
    parts.add('```diff\n${diff.trim()}\n```');
  }
  final output = tool.output;
  if (output != null && output.trim().isNotEmpty) {
    parts.add('```\n${output.trim()}\n```');
  }
  if (parts.isEmpty) return item.body.trim();
  return parts.join('\n\n');
}

/// Markers are UI chrome and the transcript's image attachments never come back
/// from the relay, so neither survives the flattening; an item with no text
/// left is dropped rather than exported as an empty heading.
bool _isRenderable(ConversationItem item) {
  if (item.kind == 'marker') return false;
  if (item.id.startsWith('local-thinking:')) return false;
  return _bodyFor(item).isNotEmpty;
}

String _twoDigits(int value) => value.toString().padLeft(2, '0');

String _formatStamp(DateTime at) =>
    '${at.year}-${_twoDigits(at.month)}-${_twoDigits(at.day)} '
    '${_twoDigits(at.hour)}:${_twoDigits(at.minute)}:${_twoDigits(at.second)}';

String _header(ExportMeta meta, List<ConversationItem> items) {
  final agent = [
    meta.runtime == 'codex' ? 'Codex' : 'Claude Code',
    if (meta.model != null && meta.model!.trim().isNotEmpty) meta.model!.trim(),
  ].join(' · ');
  final title = meta.title?.trim();
  final cwd = meta.cwd?.trim();
  final lines = <String>[
    '# ${title == null || title.isEmpty ? 'Panda Code session' : title}',
    '',
    '- Exported: ${_formatStamp(meta.exportedAt ?? DateTime.now())}',
    if (cwd != null && cwd.isNotEmpty) '- Workspace: $cwd',
    '- Agent: $agent',
    '- Items: ${items.length}',
    '',
    '---',
    '',
  ];
  return lines.join('\n');
}

/// Render conversation items to a Markdown transcript. Pass [header] to prepend
/// the section's title, workspace, and agent.
String serializeConversation(
  List<ConversationItem> items, {
  ExportMeta? header,
}) {
  final blocks = items
      .where(_isRenderable)
      .map((item) => '## ${_speakerFor(item)}\n${_bodyFor(item)}')
      .toList();
  final transcript = blocks.join('\n\n');
  if (header == null) return transcript;
  return '${_header(header, items)}$transcript\n';
}

/// First user prompt, normalized and clipped — the memorable half of the
/// filename.
String firstPromptSummary(List<ConversationItem> items) {
  final first = items
      .where((item) => item.kind == 'user' && item.body.trim().isNotEmpty)
      .firstOrNull;
  if (first == null) return '';
  final text = first.body.replaceAll(RegExp(r'\s+'), ' ').trim();
  return text.length > 50 ? '${text.substring(0, 49)}…' : text;
}

String slugify(String value) => value
    .toLowerCase()
    .replaceAll(RegExp(r'[^a-z0-9\s-]'), '')
    .replaceAll(RegExp(r'\s+'), '-')
    .replaceAll(RegExp(r'-+'), '-')
    .replaceAll(RegExp(r'^-|-$'), '');

/// `2026-07-30-143512-fix-the-relay-reconnect-loop.md` — the desktop's scheme,
/// which sorts chronologically and still says what the session was about.
String exportFilename(List<ConversationItem> items, {DateTime? now}) {
  final at = now ?? DateTime.now();
  final stamp = '${at.year}-${_twoDigits(at.month)}-${_twoDigits(at.day)}-'
      '${_twoDigits(at.hour)}${_twoDigits(at.minute)}${_twoDigits(at.second)}';
  final slug = slugify(firstPromptSummary(items));
  return slug.isEmpty ? 'conversation-$stamp.md' : '$stamp-$slug.md';
}

enum ExportTarget { share, clipboard }

class ExportCommand {
  const ExportCommand(this.target, {this.filename});

  final ExportTarget target;

  /// Explicit name from `/export <filename>`. On mobile there is no filesystem
  /// to write to directly, so this only renames the file handed to the share
  /// sheet.
  final String? filename;
}

/// Parse an `/export` composer line. Bare `/export` copies to the clipboard —
/// the common case, and it costs no sheet. `/export file` (or `save`, `share`)
/// opens the share sheet; anything else names the file.
ExportCommand? parseExportCommand(String input) {
  final trimmed = input.trim();
  if (!RegExp(r'^/export(\s|$)', caseSensitive: false).hasMatch(trimmed)) {
    return null;
  }
  final rest = trimmed
      .replaceFirst(RegExp(r'^/export\s*', caseSensitive: false), '')
      .trim();
  final keyword = rest.toLowerCase();
  if (keyword == 'clipboard' || keyword == 'copy' || rest.isEmpty) {
    return const ExportCommand(ExportTarget.clipboard);
  }
  if (keyword == 'file' || keyword == 'save' || keyword == 'share') {
    return const ExportCommand(ExportTarget.share);
  }
  final named = RegExp(r'\.[a-z0-9]+$', caseSensitive: false).hasMatch(rest)
      ? rest
      : '$rest.md';
  return ExportCommand(ExportTarget.share, filename: named);
}
