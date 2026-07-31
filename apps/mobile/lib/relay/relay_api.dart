import 'dart:async';

import 'package:uuid/uuid.dart';

import '../crypto/e2e.dart';
import '../pairing/pairing_store.dart';
import '../sessions/models.dart';
import 'relay_client.dart';

/// Typed, authenticated calls against the relay for a paired session. Every
/// content field is sealed/opened with the E2E codec; the relay only ever sees
/// ciphertext + the mobile token.
class RelayApi {
  final RelayClient client;
  final PairingCredentials creds;
  final E2ECodec codec;

  RelayApi({required this.client, required this.creds})
      : codec = E2ECodec.fromBase64Key(creds.keyBase64);

  Map<String, dynamic> get _auth => {
        'mobileId': creds.mobileId,
        'token': creds.mobileToken,
      };

  /// Desktop presence + plan-usage snapshot — drives enabling/disabling actions
  /// and the usage sheet. Usage is pushed by the desktop on its heartbeat (only
  /// the desktop holds the creds to fetch it), so it may be null until then.
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
  String? _tryOpen(String? cipher) {
    if (cipher == null) return null;
    try {
      return codec.open(cipher) as String;
    } catch (_) {
      return null;
    }
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
      starred: m['starred'] == true,
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

  List<SessionRow> _toRows(Object? value) =>
      ((value as List?) ?? const []).map(_toRow).toList();

  Future<List<SessionRow>> listSessions() async =>
      _toRows(await client.query('sessions:list', _auth));

  /// Live session list (status + runtime update in real time).
  Stream<List<SessionRow>> watchSessions() {
    final controller = StreamController<List<SessionRow>>();
    RelaySubscription? sub;
    controller.onListen = () async {
      sub = await client.subscribe(
        'sessions:list',
        _auth,
        onData: (value) => controller.add(_toRows(value)),
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
        onItems(rows.map(_toItem).toList());
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
    final events = ((res['events'] as List?) ?? const []).map(_toItem).toList();
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
    final id = await client.mutation('commands:enqueue', {
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
    final commandId = await client.mutation('commands:enqueue', {
      ..._auth,
      if (sessionId != null) 'sessionId': sessionId,
      'type': 'usage-cost',
      'payloadCipher': codec.seal({
        if (sessionId != null) 'sessionId': sessionId,
        if (from != null) 'fromIso': from.toUtc().toIso8601String(),
        if (to != null) 'toIso': to.toUtc().toIso8601String(),
      }),
    }) as String;

    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 350));
      final rows = (await client.query('commands:watchMine', _auth) as List?) ??
          const [];
      for (final raw in rows.whereType<Map>()) {
        final m = Map<String, dynamic>.from(raw);
        if (m['_id'] != commandId) continue;
        final status = m['status'] as String?;
        if (status != 'done' && status != 'error') break;
        final cipher = m['resultCipher'] as String?;
        if (status == 'error' || cipher == null) {
          throw Exception(_usageCostError(cipher));
        }
        final decoded = codec.openMap(cipher);
        final report = decoded['report'];
        if (report is! Map) {
          throw Exception('The desktop sent an unreadable report.');
        }
        return UsageCostReport.fromDecrypted(Map<String, dynamic>.from(report));
      }
    }
    throw Exception('The desktop didn\'t answer. Is Panda Code running?');
  }

  String _usageCostError(String? cipher) {
    if (cipher == null) return 'The desktop couldn\'t read its usage ledger.';
    try {
      final message = codec.openMap(cipher)['message'];
      if (message is String && message.trim().isNotEmpty) return message;
    } catch (_) {
      // Fall through to the generic message.
    }
    return 'The desktop couldn\'t read its usage ledger.';
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

  /// Enqueue a command and return its relay doc id, so a caller that cares can
  /// follow the desktop's verdict on it through [watchCommands].
  Future<String> _enqueue(
      String type, String? sessionId, Object? payload) async {
    final id = await client.mutation('commands:enqueue', {
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
