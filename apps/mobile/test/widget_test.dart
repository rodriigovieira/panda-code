import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/pairing/pairing_errors.dart';
import 'package:panda_code_mobile/sessions/models.dart';
import 'package:panda_code_mobile/sessions/session_launch_form.dart';

/// Plugin-free model tests. Widget rendering is covered in chat_render_test.dart;
/// device-only paths (secure storage, camera, Convex FFI) run as integration_test.
void main() {
  test('pairingErrorMessage maps one-time code failures to retry guidance', () {
    expect(
      pairingErrorMessage(Exception('ConvexError: PAIRING_ALREADY_USED')),
      contains('already used'),
    );
    expect(
      pairingErrorMessage(Exception('ConvexError: PAIRING_EXPIRED')),
      contains('expired'),
    );
    expect(
      pairingErrorMessage(Exception('ConvexError: PAIRING_NOT_FOUND')),
      contains('not found'),
    );
  });

  test('sessionStatusFrom / agentStateFrom map known + unknown', () {
    expect(sessionStatusFrom('running'), SessionStatus.running);
    expect(sessionStatusFrom('bogus'), SessionStatus.idle);
    expect(agentStateFrom('needs_action'), AgentState.needsAction);
    expect(agentStateFrom('bogus'), AgentState.exited);
  });

  test('ConversationItem parses thinking flag and plain fields', () {
    final item = ConversationItem.fromDecrypted(
      {'kind': 'assistant', 'body': 'hmm', 'thinking': true},
      3,
    );
    expect(item.thinking, isTrue);
    expect(item.tool, isNull);
    expect(item.sequence, 3);
  });

  test('ToolData.tryParse reads structured fields', () {
    final item = ConversationItem.fromDecrypted({
      'kind': 'tool',
      'tool': {
        'name': 'Bash',
        'category': 'bash',
        'status': 'error',
        'command': 'ls -la',
        'output': 'boom',
        'exitCode': 2,
      },
    }, 5);
    expect(item.tool, isNotNull);
    expect(item.tool!.category, ToolCategory.bash);
    expect(item.tool!.status, ToolStatus.error);
    expect(item.tool!.command, 'ls -la');
    expect(item.tool!.exitCode, 2);
  });

  test('ToolData category falls back to a name heuristic', () {
    final item = ConversationItem.fromDecrypted({
      'kind': 'tool',
      'tool': {'name': 'EditFile'},
    }, 1);
    expect(item.tool!.category, ToolCategory.edit);
  });

  test('RuntimeBadge parses ordered pending approval options', () {
    final badge = RuntimeBadge.fromDecrypted({
      'agentState': 'needs_action',
      'latestTool': 'Bash',
      'pendingPromptId': 'p_42',
      'pendingApproval': {
        'promptId': 'p_42',
        'kind': 'userInput',
        'title': 'PIN de segurança',
        'body': 'Selecione, na ordem, os quatro pares do seu PIN.',
        'options': [
          {'id': 'option:0', 'label': '15'},
          {'id': 'option:1', 'label': '83'},
          {'id': 'option:2', 'label': '70'},
        ],
        'allowsFreeText': true,
      },
    });
    expect(badge.agentState, AgentState.needsAction);
    expect(badge.pendingPromptId, 'p_42');
    expect(badge.pendingApproval!.promptId, 'p_42');
    expect(
        badge.pendingApproval!.options.map((o) => o.label), ['15', '83', '70']);
    expect(badge.pendingApproval!.allowsFreeText, isTrue);
  });

  test('SessionLaunchConfig serializes a desktop start payload', () {
    const config = SessionLaunchConfig(
      cwd: '/repo',
      runtime: AgentRuntime.codex,
      model: 'gpt-custom',
      effort: 'high',
      permissionMode: 'workspace-write',
    );

    expect(config.displayModel, 'gpt-custom');
    expect(config.toStartPayload('s1'), {
      'id': 's1',
      'cwd': '/repo',
      'runtime': 'codex',
      'model': 'gpt-custom',
      'effort': 'high',
      'permissionMode': 'workspace-write',
    });
  });

  test('ConversationImage serializes to an encrypted command payload shape',
      () {
    final image = ConversationImage(
      id: 'img-123',
      name: 'screen.png',
      mimeType: 'image/png',
      bytes: Uint8List.fromList([1, 2, 3]),
    );

    expect(image.toPayload(), {
      'id': 'img-123',
      'name': 'screen.png',
      'mimeType': 'image/png',
      'data': 'AQID',
    });
  });

  test('workspaceOptionsFromSessions keeps desktop-known paths only by recency',
      () {
    SessionRow row(String id, String? cwd, int updatedAt) => SessionRow(
          sessionId: id,
          title: null,
          cwd: cwd,
          status: SessionStatus.running,
          agentState: AgentState.waiting,
          executionMode: 'stream-json',
          headSeq: 0,
          updatedAt: updatedAt,
          runtime: null,
        );

    final workspaces = workspaceOptionsFromSessions([
      row('old-a', '/repo/a', 10),
      row('b', '/repo/b', 20),
      row('new-a', '/repo/a', 30),
      row('empty', ' ', 40),
      row('missing', null, 50),
    ]);

    expect(workspaces.map((w) => w.path), ['/repo/a', '/repo/b']);
    expect(workspaces.map((w) => w.name), ['a', 'b']);
  });

  group('session draft', () {
    test('carries its first prompt inside the start payload', () {
      final draft = const SessionDraft(
        workspacePath: '/repo/a',
        runtime: AgentRuntime.claude,
        permissionMode: 'bypassPermissions',
        prompt: '  fix the printer bug  ',
      );
      final config = draft.toConfig()!;

      final payload = config.toStartPayload(
        'session-1',
        prompt: draft.prompt,
        images: draft.images,
      );

      // One command starts the session AND runs its first turn: no window in
      // which the desktop holds a started-but-unprompted session.
      expect(payload['id'], 'session-1');
      expect(payload['cwd'], '/repo/a');
      expect(payload['prompt'], 'fix the printer bug');
      expect(payload.containsKey('attachments'), isFalse);
    });

    test('a bare start payload omits prompt and attachments', () {
      final payload = const SessionLaunchConfig(
        cwd: '/repo/a',
        runtime: AgentRuntime.codex,
      ).toStartPayload('session-2');

      expect(payload.containsKey('prompt'), isFalse);
      expect(payload.containsKey('attachments'), isFalse);
    });

    test('images ride along as attachments', () {
      final draft = SessionDraft(
        workspacePath: '/repo/a',
        images: [
          ConversationImage(
            id: 'img-1',
            name: 'shot.jpg',
            mimeType: 'image/jpeg',
            bytes: Uint8List.fromList([1, 2, 3]),
          ),
        ],
      );

      final payload = draft.toConfig()!.toStartPayload(
            'session-3',
            prompt: draft.prompt,
            images: draft.images,
          );

      expect(payload['attachments'], hasLength(1));
      expect((payload['attachments'] as List).first['id'], 'img-1');
    });

    test('a draft with no workspace cannot become a config', () {
      expect(const SessionDraft().toConfig(), isNull);
    });

    test('switching runtime resets model but keeps the typed prompt', () {
      final draft = const SessionDraft(
        workspacePath: '/repo/a',
        runtime: AgentRuntime.claude,
        model: 'opus',
        permissionMode: 'bypassPermissions',
        prompt: 'keep me',
      ).withRuntime(AgentRuntime.codex);

      expect(draft.runtime, AgentRuntime.codex);
      expect(draft.model, isEmpty);
      expect(draft.permissionMode, 'read-only');
      expect(draft.prompt, 'keep me');
      expect(draft.workspacePath, '/repo/a');
    });

    test('a typed custom model wins over the picked one', () {
      const draft = SessionDraft(
        workspacePath: '/repo/a',
        model: 'opus',
        customModel: ' claude-experimental ',
      );

      expect(draft.effectiveModel, 'claude-experimental');
      expect(draft.toConfig()!.model, 'claude-experimental');
    });
  });
}
