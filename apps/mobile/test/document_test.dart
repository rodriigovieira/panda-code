import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/git/document_screen.dart';
import 'package:panda_code_mobile/git/git_status_models.dart';
import 'package:panda_code_mobile/sessions/settings_store.dart';

void main() {
  group('document paths', () {
    test('markdown is rendered, other text is not', () {
      expect(isMarkdownPath('docs/PLAN.md'), isTrue);
      expect(isMarkdownPath('notes.MARKDOWN'), isTrue);
      expect(isMarkdownPath('build.log'), isFalse);
    });

    test('the reader opens text, and refuses everything else', () {
      expect(isReadableDocPath('docs/plan.md'), isTrue);
      expect(isReadableDocPath('build.log'), isTrue);
      expect(isReadableDocPath('data.json'), isTrue);
      expect(isReadableDocPath('shot.png'), isFalse);
      expect(isReadableDocPath('Makefile'), isFalse);
      // A dotfile is a name, not an extension.
      expect(isReadableDocPath('.md'), isFalse);
    });

    test('names a file by its last segment', () {
      expect(docFileName('/repo/docs/plan.md'), 'plan.md');
      expect(docFileName('plan.md'), 'plan.md');
    });
  });

  group('WorkspaceTextFile.fromDecrypted', () {
    test('reads what the desktop sent', () {
      final file = WorkspaceTextFile.fromDecrypted({
        'path': '/repo/docs/plan.md',
        'name': 'plan.md',
        'content': '# Plan',
        'size': 6,
        'truncated': false,
      });

      expect(file.name, 'plan.md');
      expect(file.content, '# Plan');
      expect(file.size, 6);
      expect(file.truncated, isFalse);
      expect(file.error, isNull);
    });

    test('carries the desktop\'s refusal rather than showing an empty document', () {
      final file = WorkspaceTextFile.fromDecrypted({
        'path': '../../.ssh/id_rsa',
        'error': 'That file is outside the workspace',
      });

      expect(file.content, isEmpty);
      expect(file.error, 'That file is outside the workspace');
    });
  });

  group('reader text size', () {
    test('starts two points above the transcript body', () {
      expect(AppSettings.defaultDocFontSize, 16);
      expect(const AppSettings().docFontSize, 16);
    });

    test('the adjuster cannot leave the readable range', () {
      expect(SettingsStore.clampDocFontSize(4), SettingsStore.minDocFontSize);
      expect(SettingsStore.clampDocFontSize(99), SettingsStore.maxDocFontSize);
      expect(SettingsStore.clampDocFontSize(17.4), 17);
    });
  });
}
