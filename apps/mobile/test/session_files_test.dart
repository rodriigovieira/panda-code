import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';

void main() {
  group('SessionFileChanges.fromDecrypted', () {
    test('parses the desktop payload', () {
      final changes = SessionFileChanges.fromDecrypted({
        'isRepo': true,
        'root': '/Users/example/repo',
        'branch': 'main',
        'added': 12,
        'removed': 3,
        'files': [
          {
            'path': 'lib/sessions/models.dart',
            'absolutePath': '/Users/example/repo/lib/sessions/models.dart',
            'status': 'modified',
            'added': 12,
            'removed': 3,
            'exists': true,
          },
          {
            'path': 'assets/logo.png',
            'absolutePath': '/Users/example/repo/assets/logo.png',
            'status': 'added',
            'added': 0,
            'removed': 0,
            'binary': true,
            'exists': true,
          },
        ],
      });

      expect(changes.isRepo, isTrue);
      expect(changes.branch, 'main');
      expect(changes.added, 12);
      expect(changes.removed, 3);
      expect(changes.files, hasLength(2));
      expect(changes.files.first.directory, 'lib/sessions/');
      expect(changes.files.first.name, 'models.dart');
      expect(changes.files.last.binary, isTrue);
    });

    test('a file with no directory keeps an empty prefix', () {
      final file = SessionFileChange.fromDecrypted({
        'path': 'README.md',
        'absolutePath': '/Users/example/repo/README.md',
        'status': 'untracked',
      });

      expect(file.directory, '');
      expect(file.name, 'README.md');
      // Defaults: git said nothing about counts, and the file is on disk.
      expect(file.added, 0);
      expect(file.exists, isTrue);
    });

    test('a missing files list yields an empty, non-null report', () {
      final changes = SessionFileChanges.fromDecrypted({'isRepo': false});
      expect(changes.isEmpty, isTrue);
      expect(changes.files, isEmpty);
    });
  });
}
