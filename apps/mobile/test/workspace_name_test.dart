import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';

// The desktop labels the shared scratch workspace "No project" in its sidebar;
// mobile grouped the same sessions under the raw folder name ("scratch"). Keep
// the two surfaces reading the same.
void main() {
  group('workspaceDisplayName', () {
    test('labels the shared scratch workspace "No project"', () {
      expect(workspaceDisplayName('/Users/someone/.panda-code/scratch'),
          'No project');
      expect(workspaceDisplayName('/Users/someone/.panda-code/scratch/'),
          'No project');
    });

    test('a real project called "scratch" keeps its own name', () {
      expect(workspaceDisplayName('/Users/someone/code/scratch'), 'scratch');
    });

    test('other workspaces use the folder name', () {
      expect(workspaceDisplayName('/Users/someone/code/PandaPDV-mono'),
          'PandaPDV-mono');
    });

    test('empty path falls back', () {
      expect(workspaceDisplayName(null), 'Other');
      expect(workspaceDisplayName('   '), 'Other');
      expect(workspaceDisplayName('', fallback: 'Unknown'), 'Unknown');
    });
  });

  group('isScratchWorkspacePath', () {
    test('matches only the .panda-code/scratch folder', () {
      expect(isScratchWorkspacePath('/Users/someone/.panda-code/scratch'), true);
      expect(isScratchWorkspacePath('/Users/someone/.panda-code'), false);
      expect(isScratchWorkspacePath('/scratch'), false);
      expect(isScratchWorkspacePath(null), false);
    });
  });
}
