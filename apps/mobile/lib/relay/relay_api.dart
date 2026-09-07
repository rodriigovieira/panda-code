import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show listEquals;
import 'package:uuid/uuid.dart';

import '../backlog/backlog_models.dart';
import '../crypto/e2e.dart';
import '../diagnostics/perf_trace.dart';
import '../git/git_status_models.dart';
import '../machine/machine_models.dart';
import '../pairing/pairing_store.dart';
import '../schedule/schedule_models.dart';
import '../sessions/models.dart';
import 'relay_client.dart';

/// Typed, authenticated calls against the relay for a paired session. Every
/// content field is sealed/opened with the E2E codec; the relay only ever sees
/// ciphertext + the mobile token.
class RelayApi {
  final RelayClient client;
  final PairingCredentials creds;
  final E2ECodec codec;

  /// Where the session-list and history decrypt batches record their
  /// duration — see PerfTrace's doc comment. Defaults to a disabled sink so
  /// callers that don't wire one up (tests, anywhere perf diagnostics don't
  /// matter) pay nothing.
  final PerfTrace _perfTrace;

  /// Ciphertext -> decrypted plaintext, for the title/cwd fields `_toRow`
  /// opens on every `sessions:list` push. Title/cwd are sticky once resolved
  /// (`upsertSession` keeps the existing ciphertext when the arg is omitted),
  /// so the same ciphertext string recurs on nearly every push for a session
  /// that isn't being renamed — decrypting it again each time is pure waste.
  /// Bounded well above `SESSION_LIST_LIMIT + SESSION_LIST_PINNED_EXTRA`
  /// (150 + 50) so a full list round-trip never evicts anything mid-pass.
  final _openCache = <String, String?>{};
  static const _openCacheCap = 400;

  RelayApi({required this.client, required this.creds, PerfTrace? perfTrace})
      : codec = E2ECodec.fromBase64Key(creds.keyBase64),
        _perfTrace = perfTrace ?? PerfTrace(send: (_) async {});

  Map<String, dynamic> get _auth => {
        'mobileId': creds.mobileId,
        'token': creds.mobileToken,
      };

  // Diagnostics remain local. Older relays exposed these streams publicly;
  // production clients must not upload free-form diagnostics.
  Future<void> appendDictationTrace(List<Map<String, Object?>> entries) async {}
  Future<void> appendPerfTrace(List<Map<String, Object?>> entries) async {}

  Future<DeviceStatus> deviceStatus() async {
    return _toDeviceStatus(await client.query('devices:status', _auth));
  }

  /// Live desktop presence. Worth a subscription rather than a one-shot fetch:
  /// the Mac going away mid-turn is exactly when the phone is showing a spinner
  /// it can no longer trust, and this is the signal that says so.
  ///
  /// Note the relay computes `online` at query time, so it only re-fires when
  /// the device doc is written — i.e. on the next heartbeat, which is precisely
  /// what stops arriving when the desktop dies. [DeviceStatus.isOnlineAt] is the
  /// half that closes the loop: the phone ages the last heartbeat itself.
  Stream<DeviceStatus> watchDeviceStatus() {
    final controller = StreamController<DeviceStatus>();
    RelaySubscription? sub;
    controller.onListen = () async {
      sub = await client.subscribe(
        'devices:status',
        _auth,
        onData: (value) => controller.add(_toDeviceStatus(value)),
        onError: controller.addError,
      );
    };
    controller.onCancel = () => sub?.cancel();
    return controller.stream;
  }

  DeviceStatus _toDeviceStatus(Object? value) {
    final res = value as Map<String, dynamic>?;
    if (res == null) return const DeviceStatus(online: false, name: null);
    final usage = _tryUsage(res['usageCipher'] as String?);
    return DeviceStatus(
      online: res['online'] == true,
      name: res['name'] as String?,
      lastHeartbeatAt: (res['lastHeartbeatAt'] as num?)?.toInt(),
      usageClaude: usage.claude,
      usageCodex: usage.codex,
    );
  }

  /// The desktop pushes both providers in one cipher: `{claude, codex}`. Older
  /// desktop builds pushed a single snapshot (`{provider, windows, ...}`) — we
  /// still accept that shape and treat it as Claude.
  ({UsageSnapshot? claude, UsageSnapshot? codex}) _tryUsage(String? cipher) {
    if (cipher == null) return (claude: null, codex: null);
    try {
      final map = codec.openMap(cipher);
      if (map.containsKey('windows')) {
        return (claude: UsageSnapshot.fromDecrypted(map), codex: null);
      }
      return (
        claude: _snapshotFrom(map['claude']),
        codex: _snapshotFrom(map['codex']),
      );
    } catch (_) {
      return (claude: null, codex: null);
    }
  }

  UsageSnapshot? _snapshotFrom(Object? raw) {
    if (raw is! Map) return null;
    return UsageSnapshot.fromDecrypted(Map<String, dynamic>.from(raw));
  }

  /// Best-effort decrypt: a single corrupt field must not blank the whole row
  /// or the whole list. Returns null on failure so callers can degrade.
  /// Memoized by ciphertext — see `_openCache`.
  String? _tryOpen(String? cipher) {
    if (cipher == null) return null;
    if (_openCache.containsKey(cipher)) return _openCache[cipher];
    String? result;
    try {
      result = codec.open(cipher) as String;
    } catch (_) {
      result = null;
    }
    if (_openCache.length >= _openCacheCap) {
      _openCache.remove(_openCache.keys.first);
    }
    _openCache[cipher] = result;
    return result;
  }

  RuntimeBadge? _tryRuntime(String? cipher) {
    if (cipher == null) return null;
    try {
      return RuntimeBadge.fromDecrypted(codec.openMap(cipher));
    } catch (_) {
      return null;
    }
  }

  SessionRow _toRow(Object? raw) {
    final m = Map<String, dynamic>.from(raw as Map);
    // `sessions:list` is now the lean routing/status shape: no `headSeq`, no
    // `runtimeCipher` (those moved to `sessionRuntime` to keep the list cheap).
    // The list renders coarse status from `agentState`; the open session view
    // overlays the live runtime badge from `watchRuntime`. Tolerate the fields
    // being absent so we don't crash on the new shape (or on stale desktops).
    return SessionRow(
      sessionId: m['sessionId'] as String,
      title: _tryOpen(m['titleCipher'] as String?),
      cwd: _tryOpen(m['cwdCipher'] as String?),
      status: sessionStatusFrom(m['status'] as String),
      agentState: agentStateFrom(m['agentState'] as String),
      executionMode: m['executionMode'] as String,
      headSeq: (m['headSeq'] as num?)?.toInt() ?? 0,
      updatedAt: (m['updatedAt'] as num?)?.toInt() ?? 0,
      lastPromptAt: (m['lastPromptAt'] as num?)?.toInt(),
      runtime: _tryRuntime(m['runtimeCipher'] as String?),
      parentSessionId: m['parentSessionId'] as String?,
      starred: m['starred'] == true,
      archived: m['archived'] == true,
      subscribed: m['subscribed'] == true,
    );
  }

  /// A single open session's live runtime snapshot from `sessions:runtime`
  /// (one `sessionRuntime` row). Cheap to re-fire: it tracks one session, not
  /// the whole list. `headSeq` doubles as the transcript "Messages" count.
  SessionRuntimeSnapshot _toRuntime(Object? raw) {
    final m = Map<String, dynamic>.from((raw as Map?) ?? const {});
    return SessionRuntimeSnapshot(
      headSeq: (m['headSeq'] as num?)?.toInt() ?? 0,
      badge: _tryRuntime(m['runtimeCipher'] as String?),
    );
  }

  /// Decrypt one event row into a [ConversationItem]. A decrypt failure yields a
  /// visible placeholder rather than throwing — one corrupt event shouldn't wipe
  /// the transcript.
  ConversationItem _toItem(Object? raw) {
    final m = Map<String, dynamic>.from(raw as Map);
    final seq = (m['seq'] as num).toInt();
    final createdAt = (m['createdAt'] as num?)?.toInt();
    try {
      return ConversationItem.fromDecrypted(
          codec.openMap(m['payloadCipher'] as String), seq,
          createdAt: createdAt);
    } catch (_) {
      return ConversationItem(
        id: 'undecryptable-$seq',
        kind: 'system',
        title: null,
        body: '⚠️ Couldn’t decrypt this message.',
        sequence: seq,
        model: null,
        thinking: false,
        tool: null,
        createdAt: createdAt,
      );
    }
  }

  List<SessionRow> _toRows(Object? value) {
    final raw = (value as List?) ?? const [];
    return _perfTrace.time('decrypt.list', () => raw.map(_toRow).toList(),
        count: raw.length);
  }

  Future<List<SessionRow>> listSessions() async =>
      _toRows(await client.query('sessions:list', _auth));

  /// Live session list (status + runtime update in real time).
  ///
  /// `sessions:list` re-fires (and Convex re-sends the FULL result) whenever
  /// ANY session in the window changes a low-churn field — with many parallel
  /// sessions running, that adds up to several pushes a second even though
  /// each individual session ticks rarely. Dirty-checking here against the
  /// last emitted list (post-decrypt, so a title/cwd rename still counts)
  /// stops that from cascading into every listener (Riverpod providers, the
  /// session-list rebuild) when the decrypted content is actually unchanged —
  /// same fix shape as the desktop's dirty-checked `setThreads`.
  Stream<List<SessionRow>> watchSessions() {
    final controller = StreamController<List<SessionRow>>();
    RelaySubscription? sub;
    List<SessionRow>? lastRows;
    controller.onListen = () async {
      sub = await client.subscribe(
        'sessions:list',
        _auth,
        onData: (value) {
          final rows = _toRows(value);
          if (lastRows != null && listEquals(lastRows, rows)) return;
          lastRows = rows;
          controller.add(rows);
        },
        onError: controller.addError,
      );
    };
    controller.onCancel = () => sub?.cancel();
    return controller.stream;
  }

  /// Live runtime badge for ONE session (drives the runtime header + approval
  /// bar in the open transcript). Subscribes to `sessions:runtime`, a single-row
  /// query, so the per-token runtime firehose only reaches the session on screen
  /// — never the whole list. Replaces reading `runtime` off the list rows.
  Stream<SessionRuntimeSnapshot> watchRuntime(String sessionId) {
    final controller = StreamController<SessionRuntimeSnapshot>();
    RelaySubscription? sub;
    controller.onListen = () async {
      sub = await client.subscribe(
        'sessions:runtime',
        {..._auth, 'sessionId': sessionId},
        onData: (value) => controller.add(_toRuntime(value)),
        onError: controller.addError,
      );
    };
    controller.onCancel = () => sub?.cancel();
    return controller.stream;
  }

  /// Live tail: only events after [afterSeq]. Decrypts each delta.
  Future<RelaySubscription> tailSession(
    String sessionId,
    int afterSeq, {
    required void Function(List<ConversationItem> items) onItems,
    void Function(String message)? onError,
  }) {
    return client.subscribe(
      'sessions:tail',
      {..._auth, 'sessionId': sessionId, 'afterSeq': afterSeq},
      onData: (value) {
        final rows = (value as List?) ?? const [];
        onItems(_perfTrace.time(
            'decrypt.tail', () => rows.map(_toItem).toList(),
            count: rows.length));
      },
      onError: onError,
    );
  }

  /// One-shot history backfill, newest page first. Omit [beforeSeq] for the
  /// newest retained page, then pass the returned [HistoryPage.nextBeforeSeq] to
  /// walk backward. Events within a page are ascending so callers can prepend.
  Future<HistoryPage> history(
    String sessionId, {
    int? beforeSeq,
    int limit = 100,
  }) async {
    final res = await client.query('sessions:history', {
      ..._auth,
      'sessionId': sessionId,
      if (beforeSeq != null) 'beforeSeq': beforeSeq,
      'limit': limit,
    }) as Map<String, dynamic>;
    final raw = (res['events'] as List?) ?? const [];
    final events = _perfTrace.time(
        'decrypt.history', () => raw.map(_toItem).toList(),
        count: raw.length);
    return HistoryPage(
      items: events,
      nextBeforeSeq: (res['nextBeforeSeq'] as num?)?.toInt(),
      isDone: res['isDone'] == true,
    );
  }

  /// Start a session composed on the draft route. [prompt]/[images] are the
  /// draft's first turn and travel inside the SAME command as the launch config,
  /// so the desktop never holds a started-but-unprompted session. Returns the
  /// new session id; the command's own outcome is tracked via [watchCommands].
  Future<String> startSession(
    SessionLaunchConfig config, {
    String prompt = '',
    List<ConversationImage> images = const [],
  }) async {
    final sessionId = const Uuid().v4();
    // Tag the command with the session id (the desktop reads the id from the
    // payload, but stamping it here lets the phone correlate a failed `start`
    // back to the session it was trying to launch — see [watchCommands]).
    await _enqueue(
      'start',
      sessionId,
      config.toStartPayload(sessionId, prompt: prompt, images: images),
    );
    return sessionId;
  }

  /// Send a prompt. Returns the command id: enqueueing only means the relay
  /// took it, and the desktop can still refuse it (a section it can't restart),
  /// so the caller tracks the outcome rather than assuming delivery.
  Future<String> sendInput(
    String sessionId,
    String text, {
    List<ConversationImage> images = const [],
  }) =>
      _enqueue('input', sessionId, {
        'data': text,
        if (images.isNotEmpty)
          'attachments': images.map((image) => image.toPayload()).toList(),
      });

  /// Hold a prompt behind the session's active turn instead of sending it now.
  /// The desktop — not this phone — owns the queue from here: it survives the
  /// app being killed/reopened and flushes on its own once the turn ends. [id]
  /// is caller-chosen so the composer can optimistically show/remove/promote
  /// the entry before the round trip confirms it.
  Future<String> queuePrompt(
    String sessionId,
    String id,
    String text, {
    List<ConversationImage> images = const [],
  }) =>
      _enqueue('queue', sessionId, {
        'action': 'add',
        'id': id,
        'data': text,
        if (images.isNotEmpty)
          'attachments': images.map((image) => image.toPayload()).toList(),
      });

  /// Drop a queued prompt without sending it.
  Future<String> removeQueuedPrompt(String sessionId, String id) =>
      _enqueue('queue', sessionId, {'action': 'remove', 'id': id});

  /// Promote a queued prompt to a real send right now, steering the current
  /// turn instead of waiting for it to finish.
  Future<String> sendQueuedPromptNow(String sessionId, String id) =>
      _enqueue('queue', sessionId, {'action': 'send-now', 'id': id});

  Future<void> stopSession(String sessionId) =>
      _enqueue('stop', sessionId, null);

  /// Change the runtime/model/effort/permission of an already-running session.
  /// The desktop applies it to the section's next turn (resuming with the new
  /// settings). Only the fields the user changed are sent: a `null` field is
  /// omitted and left untouched desktop-side, while an empty string clears that
  /// setting back to the runtime default. Passing [runtime] switches provider
  /// (Claude ↔ Codex) — a fresh thread, since context can't cross providers.
  Future<void> switchLaunch(
    String sessionId, {
    AgentRuntime? runtime,
    String? model,
    String? effort,
    String? permissionMode,
  }) =>
      _enqueue('switch', sessionId, {
        if (runtime != null) 'runtime': agentRuntimeWireValue(runtime),
        if (model != null) 'model': model,
        if (effort != null) 'effort': effort,
        if (permissionMode != null) 'permissionMode': permissionMode,
      });

  /// Ask a /btw side question about [sessionId]. The desktop forks the session's
  /// live context into a read-only aside and rides the answer back through the
  /// command result. Returns the command id so the caller can await its outcome
  /// via [watchCommands]. Follow-up questions reuse the same aside desktop-side.
  Future<String> askBtw(String sessionId, String question) async {
    final id = await _enqueueCommand({
      ..._auth,
      'sessionId': sessionId,
      'type': 'btw',
      'payloadCipher': codec.seal({'question': question}),
    });
    return id as String;
  }

  /// Ask the desktop for a token→dollar report. The usage ledger lives only on
  /// the desktop (it is the only thing that observes every turn), so this is a
  /// command round-trip rather than a relay query: enqueue, then poll this
  /// phone's own command rows until ours settles and decrypt the report out of
  /// the result. Pass [sessionId] for one section, or [from]/[to] for a range.
  ///
  /// Throws when the desktop is offline or slow enough to miss the window — the
  /// caller surfaces that rather than showing a misleading $0.00.
  Future<UsageCostReport> fetchUsageCost({
    String? sessionId,
    DateTime? from,
    DateTime? to,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      if (sessionId != null) 'sessionId': sessionId,
      'type': 'usage-cost',
      'payloadCipher': codec.seal({
        if (sessionId != null) 'sessionId': sessionId,
        if (from != null) 'fromIso': from.toUtc().toIso8601String(),
        if (to != null) 'toIso': to.toUtc().toIso8601String(),
      }),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read its usage ledger.',
    );
    final report = decoded['report'];
    if (report is! Map) {
      throw Exception('The desktop sent an unreadable report.');
    }
    return UsageCostReport.fromDecrypted(Map<String, dynamic>.from(report));
  }

  /// Ask the desktop what this section changed on disk. Same round-trip shape as
  /// [fetchUsageCost] and for the same reason: attribution comes from the
  /// section's transcript and the line counts from git, and only the desktop can
  /// see either — the relay never learns a path.
  Future<SessionFileChanges> fetchSessionFiles(
    String sessionId, {
    Duration timeout = const Duration(seconds: 25),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'sessionId': sessionId,
      'type': 'session-files',
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read this section\'s changes.',
    );
    final changes = decoded['changes'];
    if (changes is! Map) {
      throw Exception('The desktop sent an unreadable file list.');
    }
    return SessionFileChanges.fromDecrypted(Map<String, dynamic>.from(changes));
  }

  /// Read or edit a workspace's kanban board.
  ///
  /// The board is a file on the Mac — the desktop UI and the agents working in
  /// that folder write to the same one — so there is no board on the relay to
  /// subscribe to. Every operation is the same round-trip and answers with the
  /// WHOLE board, which is also why the phone never merges a local edit: the
  /// answer is the truth, including anything an agent changed meanwhile.
  ///
  /// [op] is `list`, `add`, `update`, `move` or `delete`. The workspace path
  /// travels inside the sealed payload; the relay never learns it.
  Future<WorkspaceBacklog> backlog(
    String cwd, {
    String op = 'list',
    String? id,
    String? title,
    String? summary,
    String? description,
    String? metadata,
    String? column,
    bool? onHold,
    int? index,
    String? verificationNotes,
    // The phone can drop an attachment but not add one — no image bytes ride
    // this channel yet, only the id `BacklogAttachment` carries.
    List<String>? removeAttachmentIds,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'backlog',
      'payloadCipher': codec.seal({
        'cwd': cwd,
        'op': op,
        if (id != null) 'id': id,
        if (title != null) 'title': title,
        // Omitted rather than sent empty when the caller has no opinion: the
        // desktop leaves a field it was not given alone, so a partial edit
        // cannot wipe a TL;DR an agent wrote since this screen loaded.
        if (summary != null) 'summary': summary,
        if (description != null) 'description': description,
        if (metadata != null) 'metadata': metadata,
        if (column != null) 'column': column,
        if (onHold != null) 'onHold': onHold,
        if (index != null) 'index': index,
        if (verificationNotes != null) 'verificationNotes': verificationNotes,
        if (removeAttachmentIds != null)
          'removeAttachmentIds': removeAttachmentIds,
      }),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read this workspace\'s backlog.',
    );
    final board = decoded['backlog'];
    if (board is! Map) {
      throw Exception('The desktop sent an unreadable backlog.');
    }
    return WorkspaceBacklog.fromDecrypted(Map<String, dynamic>.from(board));
  }

  /// Read a workspace's scheduled tasks. View-only in V1 — no `op`, unlike
  /// [backlog] — creating or editing a job is desktop/agent-only for now.
  Future<WorkspaceSchedule> schedule(
    String cwd, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'schedule',
      'payloadCipher': codec.seal({'cwd': cwd}),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read this workspace\'s schedule.',
    );
    final schedule = decoded['schedule'];
    if (schedule is! Map) {
      throw Exception('The desktop sent an unreadable schedule.');
    }
    return WorkspaceSchedule.fromDecrypted(Map<String, dynamic>.from(schedule));
  }

  /// Read a workspace's git status — branch, ahead/behind, changed files,
  /// stashes, worktrees, branches. Read-only, same request/response shape as
  /// [schedule]: only the desktop can see the working tree, so the phone
  /// never caches this, it just asks again.
  Future<WorkspaceGitStatus> gitStatus(
    String cwd, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'git-status',
      'payloadCipher': codec.seal({'cwd': cwd}),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read this workspace\'s git status.',
    );
    final status = decoded['status'];
    if (status is! Map) {
      throw Exception('The desktop sent an unreadable git status.');
    }
    return WorkspaceGitStatus.fromDecrypted(Map<String, dynamic>.from(status));
  }

  /// One page of a workspace's commit history, newest first.
  ///
  /// Rides the same `git-status` command as [gitStatus], discriminated by
  /// `view` in the (encrypted) payload: it is the same read-only look at the
  /// same trusted workspace, and the relay only ever sees ciphertext, so it
  /// does not need a command kind of its own.
  Future<WorkspaceGitLog> gitLog(
    String cwd, {
    int skip = 0,
    int limit = 50,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'git-status',
      'payloadCipher':
          codec.seal({'cwd': cwd, 'view': 'log', 'skip': skip, 'limit': limit}),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read this workspace\'s history.',
    );
    final log = decoded['log'];
    if (log is! Map) {
      throw Exception('The desktop sent an unreadable commit history.');
    }
    return WorkspaceGitLog.fromDecrypted(Map<String, dynamic>.from(log));
  }

  /// Latest GitHub Actions runs, queried by the desktop through its existing
  /// authenticated `gh` CLI. The payload and response stay encrypted while
  /// crossing the relay, just like the rest of the Git view.
  Future<WorkspaceWorkflowRuns> gitWorkflows(
    String cwd, {
    int limit = 10,
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'git-status',
      'payloadCipher':
          codec.seal({'cwd': cwd, 'view': 'actions', 'limit': limit}),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read GitHub Actions.',
    );
    final workflows = decoded['workflows'];
    if (workflows is! Map) {
      throw Exception('The desktop sent an unreadable workflow list.');
    }
    return WorkspaceWorkflowRuns.fromDecrypted(
        Map<String, dynamic>.from(workflows));
  }

  /// One directory of a workspace's file tree. [path] is workspace-relative;
  /// empty means the root. Read a level at a time, as folders are expanded.
  Future<WorkspaceGitTree> gitTree(
    String cwd, {
    String path = '',
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'git-status',
      'payloadCipher': codec.seal({'cwd': cwd, 'view': 'tree', 'path': path}),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read this folder.',
    );
    final tree = decoded['tree'];
    if (tree is! Map) {
      throw Exception('The desktop sent an unreadable file tree.');
    }
    return WorkspaceGitTree.fromDecrypted(Map<String, dynamic>.from(tree));
  }

  /// One text file out of a workspace, for the in-app reader.
  ///
  /// [path] is workspace-relative, or absolute inside the workspace; the
  /// desktop refuses anything that resolves outside it, so this can only ever
  /// read from a folder already trusted for remote access. Rides the same
  /// `git-status` command as [gitTree], for the same reasons.
  ///
  /// [maxBytes] is deliberately small next to the desktop's own cap: the file
  /// travels encrypted through the relay, and this reader is for documents.
  Future<WorkspaceTextFile> readFile(
    String cwd, {
    required String path,
    int maxBytes = 256 * 1024,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'git-status',
      'payloadCipher': codec.seal(
          {'cwd': cwd, 'view': 'file', 'path': path, 'maxBytes': maxBytes}),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read this file.',
    );
    final file = decoded['file'];
    if (file is! Map) {
      throw Exception('The desktop sent an unreadable file.');
    }
    return WorkspaceTextFile.fromDecrypted(Map<String, dynamic>.from(file));
  }

  /// Save an edited document back to the Mac.
  ///
  /// The one write in this family, and it carries the same rules as [readFile]:
  /// the path is workspace-relative (or absolute inside it), the desktop refuses
  /// anything that resolves outside a workspace already trusted for remote
  /// access, and it overwrites an existing text file rather than creating one —
  /// so a phone can fix a line in a document, not plant a file on the Mac.
  ///
  /// Answers with the epoch-ms the write landed, which is what the reader shows
  /// as its "Saved" line.
  Future<int> writeFile(
    String cwd, {
    required String path,
    required String content,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'git-status',
      'payloadCipher': codec.seal(
          {'cwd': cwd, 'view': 'write', 'path': path, 'content': content}),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t save this file.',
    );
    final saved = decoded['saved'];
    if (saved is! Map) {
      throw Exception('The desktop sent an unreadable save result.');
    }
    final error = saved['error'];
    if (error is String && error.isNotEmpty) throw Exception(error);
    final savedAt = saved['savedAt'];
    return savedAt is num
        ? savedAt.toInt()
        : DateTime.now().millisecondsSinceEpoch;
  }

  /// Read the paired Mac's current state — load, memory, swap, disk and the
  /// heaviest processes, with the section each one belongs to where the desktop
  /// could tell. Same request/response shape as [gitStatus].
  ///
  /// Asked for only while the device sheet is open. These numbers move every
  /// second, so pushing them on the desktop's heartbeat would rewrite the device
  /// document — and wake every phone's `devices:status` subscription — five
  /// times a minute, which is exactly why plan usage was moved off that path.
  Future<MachineStats> machineStats({
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'machine-stats',
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t read this machine\'s state.',
    );
    final stats = decoded['stats'];
    if (stats is! Map) {
      throw Exception('The desktop sent an unreadable machine snapshot.');
    }
    return MachineStats.fromDecrypted(Map<String, dynamic>.from(stats));
  }

  /// Ask the desktop for its shared "no project" scratch folder path,
  /// creating it on disk if this is the first time anything has asked. Same
  /// request/response shape as [machineStats]; unlike a workspace-scoped
  /// command, this one needs no `cwd` — it's the one folder every phone and
  /// the desktop agree on for sessions started without a project.
  Future<String> ensureScratchWorkspace({
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'scratch-workspace',
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t resolve its scratch workspace.',
    );
    final path = decoded['path'];
    if (path is! String || path.isEmpty) {
      throw Exception('The desktop sent an unreadable scratch workspace path.');
    }
    return path;
  }

  /// Ask the desktop to read one capture off its own disk and upload it —
  /// still ciphertext — to Convex file storage. [path] is exactly what a
  /// `browser_screenshot`/`browser_record` tool result printed (see
  /// [session_view_screen.dart]'s path-extraction regex) or what a backlog
  /// attachment record carries; the desktop refuses anything outside its own
  /// capture directories.
  ///
  /// [sessionId] is null for media that belongs to no session — a backlog
  /// card's evidence: the desktop's dispatcher never reads it for this
  /// command, it only scopes the row on the relay.
  ///
  /// Answers with a storage id and content type, NOT the bytes: the file is
  /// too large to ride `resultCipher` the way every other command's answer
  /// does (Convex's 1 MiB document cap, the same one `image_prep.dart` fights
  /// on attachments). Pass the storage id to [fetchMedia] for the bytes.
  Future<({String storageId, String mimeType})> requestMedia(
    String? sessionId, {
    required String path,
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      if (sessionId != null) 'sessionId': sessionId,
      'type': 'media',
      'payloadCipher': codec.seal({'path': path}),
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t fetch this capture.',
    );
    final storageId = decoded['storageId'];
    final mimeType = decoded['mimeType'];
    if (storageId is! String ||
        storageId.isEmpty ||
        mimeType is! String ||
        mimeType.isEmpty) {
      throw Exception('The desktop sent an unreadable capture.');
    }
    return (storageId: storageId, mimeType: mimeType);
  }

  /// Download and decrypt the blob [requestMedia] uploaded. A plain query +
  /// HTTPS GET, not a command round-trip: `media:url` is gated on this
  /// phone's paired device owning the storage id (see `media.ts`), so the URL
  /// itself needs no separate secret, and the ciphertext is meaningless
  /// without the pairing key this codec already holds.
  ///
  /// Not cached here — callers that want repeat views without re-downloading
  /// should go through a disk cache keyed by [storageId] (mirrors
  /// `RemoteImageStore`'s pattern for sent attachments).
  Future<Uint8List> fetchMedia(String storageId) async {
    final url = await client
        .query('media:url', {..._auth, 'storageId': storageId}) as String?;
    if (url == null) {
      throw Exception(
          'That capture is no longer available — it may have expired.');
    }
    final request = await HttpClient().getUrl(Uri.parse(url));
    final response = await request.close();
    if (response.statusCode != 200) {
      throw Exception(
          'Could not download the capture (HTTP ${response.statusCode}).');
    }
    final envelope = await response.transform(utf8.decoder).join();
    final opened = codec.openMap(envelope);
    final dataBase64 = opened['dataBase64'];
    if (dataBase64 is! String) {
      throw Exception('The desktop sent an unreadable capture.');
    }
    return base64Decode(dataBase64);
  }

  /// Wait for [commandId] to settle, then open its result. Shared by every
  /// request/response command (the board, and anything added after it) so they
  /// all fail the same way: the desktop's own sentence when it sealed one, and
  /// "is Panda Code running?" when it never answered.
  ///
  /// Subscribes to the ONE command being waited on rather than polling
  /// `commands:watchMine` every 350 ms. That poll re-read this phone's last ten
  /// commands — each with its full result, a whole kanban board or process list
  /// — sixty times per request, and was on its own 40% of all relay bandwidth.
  /// Here the read set is a single row and it re-fires once per transition.
  Future<Map<String, dynamic>> _awaitCommandResult(
    String commandId, {
    required Duration timeout,
    required String fallbackError,
  }) async {
    final completer = Completer<Map<String, dynamic>>();
    RelaySubscription? sub;
    Timer? timer;

    void settle(void Function() complete) {
      if (completer.isCompleted) return;
      timer?.cancel();
      sub?.cancel();
      complete();
    }

    void onValue(dynamic value) {
      if (value is! Map) return; // Not visible yet, or not ours.
      final m = Map<String, dynamic>.from(value);
      final status = m['status'] as String?;
      if (status != 'done' && status != 'error') return;
      final cipher = m['resultCipher'] as String?;
      if (status == 'error' || cipher == null) {
        settle(() => completer
            .completeError(Exception(_commandError(cipher, fallbackError))));
        return;
      }
      Map<String, dynamic> decoded;
      try {
        decoded = codec.openMap(cipher);
      } catch (error) {
        settle(() => completer.completeError(Exception(fallbackError)));
        return;
      }
      // Read once, then free it: an unconsumed board would otherwise sit on the
      // relay for a week being re-read by the retention sweep.
      unawaited(client.mutation('commands:consumeResult',
          {..._auth, 'commandId': commandId}).catchError((_) => null));
      settle(() => completer.complete(decoded));
    }

    timer = Timer(timeout, () {
      settle(() => completer.completeError(
          Exception('The desktop didn\'t answer. Is Panda Code running?')));
    });

    sub = await client.subscribe(
      'commands:result',
      {..._auth, 'commandId': commandId},
      onData: onValue,
      onError: (message) =>
          settle(() => completer.completeError(Exception(fallbackError))),
    );
    // The command may have settled while the subscription was being set up.
    if (completer.isCompleted) sub.cancel();

    return completer.future;
  }

  /// Force the desktop to re-fetch plan usage rather than serve what it already
  /// cached — the same "force" path its own Refresh button takes, bypassing the
  /// periodic cache floor (but not an active rate-limit cooldown). A command
  /// round-trip for the same reason as [fetchUsageCost]: only the desktop holds
  /// the creds the fetch needs.
  Future<({UsageSnapshot? claude, UsageSnapshot? codex})> refreshUsage({
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final commandId = await _enqueueCommand({
      ..._auth,
      'type': 'usage-refresh',
    }) as String;

    final decoded = await _awaitCommandResult(
      commandId,
      timeout: timeout,
      fallbackError: 'The desktop couldn\'t refresh plan usage.',
    );
    final bundle = decoded['bundle'];
    if (bundle is! Map) {
      throw Exception('The desktop couldn\'t refresh plan usage.');
    }
    final map = Map<String, dynamic>.from(bundle);
    return (
      claude: _snapshotFrom(map['claude']),
      codex: _snapshotFrom(map['codex'])
    );
  }

  /// The desktop's own explanation for a failed command, when it sealed one.
  /// A missing or undecryptable result falls back to [fallback] rather than
  /// surfacing a decrypt error the operator can do nothing with.
  String _commandError(String? cipher, String fallback) {
    if (cipher == null) return fallback;
    try {
      final message = codec.openMap(cipher)['message'];
      if (message is String && message.trim().isNotEmpty) return message;
    } catch (_) {
      // Fall through to the generic message.
    }
    return fallback;
  }

  /// Decrypt one `commands:watchMine` row into a [CommandOutcome]. A decrypt
  /// failure still yields the status (which is plaintext on the relay), just
  /// without the human message.
  CommandOutcome _toOutcome(Object? raw) {
    final m = Map<String, dynamic>.from(raw as Map);
    String? message;
    final cipher = m['resultCipher'] as String?;
    if (cipher != null) {
      try {
        final decoded = codec.openMap(cipher);
        final msg = decoded['message'];
        if (msg is String) message = msg;
      } catch (_) {
        // Leave message null — the status alone still lets the UI react.
      }
    }
    return CommandOutcome(
      id: m['_id'] as String?,
      sessionId: m['sessionId'] as String?,
      type: m['type'] as String,
      status: m['status'] as String,
      message: message,
    );
  }

  /// Live view of this phone's recently issued commands and their outcome
  /// (pending → claimed → done/error). Lets the UI explain *why* a command —
  /// especially a `start` the desktop rejected (missing workspace, bad
  /// payload) — didn't take, instead of spinning on an empty session forever.
  Stream<List<CommandOutcome>> watchCommands() {
    final controller = StreamController<List<CommandOutcome>>();
    RelaySubscription? sub;
    controller.onListen = () async {
      sub = await client.subscribe(
        'commands:watchMine',
        _auth,
        onData: (value) => controller
            .add(((value as List?) ?? const []).map(_toOutcome).toList()),
        onError: controller.addError,
      );
    };
    controller.onCancel = () => sub?.cancel();
    return controller.stream;
  }

  Future<void> approve(
    String sessionId, {
    required String promptId,
    String? optionId,
    String? text,
  }) =>
      _enqueue('approve', sessionId, {
        'promptId': promptId,
        if (optionId != null) 'optionId': optionId,
        if (text != null) 'text': text,
      });

  Future<void> deny(
    String sessionId, {
    required String promptId,
    String? optionId,
    String? text,
  }) =>
      _enqueue('deny', sessionId, {
        'promptId': promptId,
        if (optionId != null) 'optionId': optionId,
        if (text != null) 'text': text,
      });

  /// Push this phone's notification preferences to the relay so it can gate
  /// APNs delivery. Best-effort; callers ignore failures.
  Future<Map<String, bool>> getNotificationPrefs() async {
    final value = await client.query(
        'notifications:getNotificationPrefs', _auth) as Map<String, dynamic>;
    return value.map((key, value) => MapEntry(key, value == true));
  }

  Future<void> setNotificationPrefs({
    bool? muted,
    bool? notifyOnDone,
    bool? notifyOnNeedsApproval,
    bool? notifyOnError,
  }) async {
    await client.mutation('notifications:setNotificationPrefs', {
      ..._auth,
      if (muted != null) 'muted': muted,
      if (notifyOnDone != null) 'notifyOnDone': notifyOnDone,
      if (notifyOnNeedsApproval != null)
        'notifyOnNeedsApproval': notifyOnNeedsApproval,
      if (notifyOnError != null) 'notifyOnError': notifyOnError,
    });
  }

  /// The Mac persists local delivery channels; payload and result are sealed.
  Future<Map<String, bool>> sessionNotificationChannels(
    String sessionId, {
    bool? desktop,
    bool? agent,
  }) async {
    final id = await _enqueue('notification-settings', sessionId, {
      'op': desktop == null && agent == null ? 'get' : 'set',
      if (desktop != null) 'desktop': desktop,
      if (agent != null) 'agent': agent,
    });
    final result = await _awaitCommandResult(
      id,
      timeout: const Duration(seconds: 20),
      fallbackError: 'Could not read notification settings from the Mac.',
    );
    final settings = result['settings'];
    if (settings is! Map ||
        settings['desktop'] is! bool ||
        settings['agent'] is! bool) {
      throw Exception(
          'Update Panda Code on the Mac to manage notification channels.');
    }
    return {
      'desktop': settings['desktop'] as bool,
      'agent': settings['agent'] as bool
    };
  }

  /// Subscribe or unsubscribe this phone to a session's push notifications.
  /// Writes an override on the relay; `sessions:list` reflects the new state
  /// reactively, so callers don't need to update local state.
  Future<void> setSessionSubscription(
    String sessionId, {
    required bool subscribed,
  }) async {
    await client.mutation('notifications:setSessionSubscription', {
      ..._auth,
      'sessionId': sessionId,
      'subscribed': subscribed,
    });
  }

  Future<void> setSessionStarred(
    String sessionId, {
    required bool starred,
  }) async {
    await client.mutation('sessions:setStarredByMobile', {
      ..._auth,
      'sessionId': sessionId,
      'starred': starred,
    });
  }

  Future<void> setSessionArchived(
    String sessionId, {
    required bool archived,
  }) async {
    await client.mutation('sessions:setArchivedByMobile', {
      ..._auth,
      'sessionId': sessionId,
      'archived': archived,
    });
  }

  /// All command producers use one authenticated, destination-bound envelope.
  Future<dynamic> _enqueueCommand(Map<String, dynamic> args) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final oldPayload = args['payloadCipher'];
    final envelope = {
      'v': 2,
      'domain': 'panda-code/command/v2',
      'id': const Uuid().v4(),
      'deviceId': creds.deviceId,
      'mobileId': creds.mobileId,
      'sessionId': args['sessionId'],
      'type': args['type'],
      'issuedAt': now,
      'expiresAt': now + 5 * 60 * 1000,
      'payload': oldPayload is String ? codec.open(oldPayload) : null,
    };
    return client.mutation('commands:enqueue', {
      ...args,
      ..._auth,
      'payloadCipher': codec.sealCommand(envelope),
    });
  }

  /// Enqueue a command and return its relay doc id, so a caller that cares can
  /// follow the desktop's verdict on it through [watchCommands].
  Future<String> _enqueue(
      String type, String? sessionId, Object? payload) async {
    final id = await _enqueueCommand({
      ..._auth,
      if (sessionId != null) 'sessionId': sessionId,
      'type': type,
      if (payload != null) 'payloadCipher': codec.seal(payload),
    });
    return id as String;
  }
}

class DeviceStatus {
  final bool online;
  final String? name;

  /// Relay clock, milliseconds. Null on older relays.
  final int? lastHeartbeatAt;
  final UsageSnapshot? usageClaude;
  final UsageSnapshot? usageCodex;
  const DeviceStatus({
    required this.online,
    required this.name,
    this.lastHeartbeatAt,
    this.usageClaude,
    this.usageCodex,
  });

  /// The desktop heartbeats every ~12s; three misses and we call it gone. The
  /// relay's own `online` flag can only go stale in the optimistic direction
  /// (nothing writes the doc once the Mac is gone, so the subscription never
  /// re-fires), so age the heartbeat here too and take the pessimistic answer.
  static const staleAfter = Duration(seconds: 40);

  bool isOnlineAt(DateTime now) {
    if (!online) return false;
    final beat = lastHeartbeatAt;
    if (beat == null) return true; // older relay: nothing better to go on
    return now.millisecondsSinceEpoch - beat < staleAfter.inMilliseconds;
  }

  UsageSnapshot? usageFor(AgentRuntime runtime) =>
      runtime == AgentRuntime.codex ? usageCodex : usageClaude;
}

/// The relay-side outcome of a command this phone enqueued. [sessionId] is set
/// for session-scoped commands (including `start`, which stamps it so a failed
/// launch can be traced back to its session). [message] is the decrypted,
/// human-readable result the desktop reported (e.g. "Workspace folder does not
/// exist."), when present.
class CommandOutcome {
  final String? id; // the relay command doc id — lets callers match a result
  final String? sessionId;
  final String type; // start | input | stop | approve | deny | btw
  final String status; // pending | claimed | done | error
  final String? message;
  const CommandOutcome({
    this.id,
    required this.sessionId,
    required this.type,
    required this.status,
    this.message,
  });

  bool get failed => status == 'error';
  bool get done => status == 'done';
  bool get settled => status == 'done' || status == 'error';
}
