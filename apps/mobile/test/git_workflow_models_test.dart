import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/git/git_status_models.dart';

void main() {
  test('workflow runs decode from the encrypted desktop response', () {
    final result = WorkspaceWorkflowRuns.fromDecrypted({
      'limit': 10,
      'hasMore': true,
      'runs': [
        {
          'databaseId': 42,
          'name': 'CI',
          'displayTitle': 'Ship actions tab',
          'status': 'completed',
          'conclusion': 'success',
          'headBranch': 'main',
          'event': 'push',
          'createdAt': '2026-09-07T10:00:00Z',
          'updatedAt': '2026-09-07T10:01:00Z',
          'url': 'https://github.com/example/repo/actions/runs/42',
        },
      ],
    });

    expect(result.hasMore, isTrue);
    expect(result.limit, 10);
    expect(result.runs, hasLength(1));
    expect(result.runs.single.databaseId, 42);
    expect(result.runs.single.conclusion, 'success');
    expect(result.runs.single.createdAt, isNotNull);
  });
}
