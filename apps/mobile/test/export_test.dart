import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/export.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/slash_commands.dart';

ConversationItem _item(
  String kind, {
  String id = 'i1',
  String? title,
  String body = '',
  ToolData? tool,
}) =>
    ConversationItem(
      id: id,
      kind: kind,
      title: title,
      body: body,
      sequence: null,
      model: null,
      thinking: false,
      tool: tool,
    );

void main() {
  group('serializeConversation', () {
    test('renders each item as a titled Markdown block, oldest first', () {
      final transcript = serializeConversation([
        _item('user', id: 'u1', body: 'make the build pass'),
        _item('assistant', id: 'a1', title: 'Claude', body: 'Running tests.'),
      ]);
      expect(
        transcript,
        '## User\nmake the build pass\n\n## Claude\nRunning tests.',
      );
    });

    test('flattens a tool card into its command and output', () {
      final transcript = serializeConversation([
        _item('tool',
            id: 't1',
            title: 'Bash',
            tool: const ToolData(
              name: 'Bash',
              category: ToolCategory.bash,
              status: ToolStatus.success,
              command: 'pnpm test',
              output: '204 passed',
            )),
      ]);
      expect(transcript, '## Bash\n```\npnpm test\n```\n\n```\n204 passed\n```');
    });

    test('skips markers, thinking placeholders, and empty bodies', () {
      final transcript = serializeConversation([
        _item('marker', id: 'm1', body: 'New session'),
        _item('user', id: 'u1', body: '   '),
        _item('assistant',
            id: 'local-thinking:x', title: 'Claude', body: 'Thinking...'),
        _item('assistant', id: 'a1', title: 'Claude', body: 'Done.'),
      ]);
      expect(transcript, '## Claude\nDone.');
    });

    test('writes a header with title, workspace, and agent', () {
      final transcript = serializeConversation(
        [_item('user', id: 'u1', body: 'hi')],
        header: ExportMeta(
          title: 'Relay reconnect',
          cwd: '/repo',
          runtime: 'claude',
          model: 'claude-opus-5',
          exportedAt: DateTime(2026, 7, 30, 14, 35, 12),
        ),
      );
      expect(transcript, contains('# Relay reconnect'));
      expect(transcript, contains('- Exported: 2026-07-30 14:35:12'));
      expect(transcript, contains('- Workspace: /repo'));
      expect(transcript, contains('- Agent: Claude Code · claude-opus-5'));
      expect(transcript, contains('- Items: 1'));
      expect(transcript, endsWith('\n'));
    });

    test('names Codex sections after their runtime', () {
      final transcript = serializeConversation(
        [_item('user', id: 'u1', body: 'hi')],
        header: const ExportMeta(runtime: 'codex'),
      );
      expect(transcript, contains('- Agent: Codex'));
      expect(transcript, contains('# Panda Code session'));
    });
  });

  group('exportFilename', () {
    final at = DateTime(2026, 7, 30, 14, 35, 12);

    test('stamps the time and slugs the first prompt', () {
      final name = exportFilename(
        [_item('user', id: 'u1', body: 'Fix the relay reconnect loop!')],
        now: at,
      );
      expect(name, '2026-07-30-143512-fix-the-relay-reconnect-loop.md');
    });

    test('falls back to a generic name when nothing can be slugged', () {
      expect(
        exportFilename([_item('assistant', id: 'a1', body: 'hello')], now: at),
        'conversation-2026-07-30-143512.md',
      );
      expect(
        exportFilename([_item('user', id: 'u1', body: '!!!')], now: at),
        'conversation-2026-07-30-143512.md',
      );
    });

    test('clips a long first prompt', () {
      final summary = firstPromptSummary([_item('user', body: 'w' * 200)]);
      expect(summary.length, 50);
      expect(summary.endsWith('…'), isTrue);
      expect(slugify(summary), 'w' * 49);
    });
  });

  group('parseExportCommand', () {
    test('ignores anything that is not an /export line', () {
      expect(parseExportCommand('please export this'), isNull);
      expect(parseExportCommand('/exports'), isNull);
      expect(parseExportCommand('/btw what changed?'), isNull);
    });

    test('defaults to the clipboard', () {
      expect(parseExportCommand('  /export  ')?.target, ExportTarget.clipboard);
      expect(parseExportCommand('/EXPORT')?.target, ExportTarget.clipboard);
      expect(parseExportCommand('/export')?.filename, isNull);
    });

    test('routes the clipboard keywords', () {
      expect(parseExportCommand('/export clipboard')?.target,
          ExportTarget.clipboard);
      expect(parseExportCommand('/export copy')?.target, ExportTarget.clipboard);
    });

    test('routes the share-sheet keywords', () {
      expect(parseExportCommand('/export file')?.target, ExportTarget.share);
      expect(parseExportCommand('/export SAVE')?.target, ExportTarget.share);
      expect(parseExportCommand('/export share')?.filename, isNull);
    });

    test('treats anything else as a filename, defaulting the extension', () {
      expect(parseExportCommand('/export notes.md')?.filename, 'notes.md');
      expect(parseExportCommand('/export run')?.filename, 'run.md');
    });
  });

  group('slash command palette', () {
    test('opens only on a bare leading slash word', () {
      expect(slashQueryOf('/'), '');
      expect(slashQueryOf('/exp'), 'exp');
      expect(slashQueryOf('/EXPORT'), 'export');
      expect(slashQueryOf('/export notes.md'), isNull);
      expect(slashQueryOf('hello /export'), isNull);
      expect(slashQueryOf(''), isNull);
    });

    test('lists everything for a bare slash and nothing when closed', () {
      expect(filterSlashCommands(''), composerSlashCommands);
      expect(filterSlashCommands(null), isEmpty);
    });

    test('filters by name and by keyword', () {
      expect(
        filterSlashCommands('exp').map((c) => c.id),
        containsAll(<String>['export', 'export-clipboard']),
      );
      expect(filterSlashCommands('history').map((c) => c.id), ['prompts']);
      expect(filterSlashCommands('side').map((c) => c.id), ['btw']);
      expect(filterSlashCommands('nothingmatches'), isEmpty);
    });
  });
}
