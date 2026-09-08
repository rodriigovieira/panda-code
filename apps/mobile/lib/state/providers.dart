import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../diagnostics/perf_trace.dart';
import '../dictation/dictation_service.dart';
import '../dictation/dictation_trace.dart';
import '../notifications/push_notifications.dart';
import '../pairing/pairing_payload.dart';
import '../pairing/pairing_store.dart';
import '../security/command_identity.dart';
import '../relay/relay_api.dart';
import '../relay/relay_client.dart';
import '../sessions/alias_store.dart';
import '../sessions/archive_store.dart';
import '../sessions/models.dart';
import '../sessions/pinned_store.dart';
import '../sessions/scratch_workspace_store.dart';
import '../sessions/settings_store.dart';
import '../sessions/workspace_order_store.dart';

final pairingStoreProvider = Provider<PairingStore>((ref) => PairingStore());

final settingsStoreProvider = Provider<SettingsStore>((ref) => SettingsStore());

/// On-device dictation. Single instance: it owns the audio engine and caches
/// the trained language model, so a second one would fight it for the mic.
final dictationServiceProvider = Provider<DictationService>((ref) {
  // Diagnostics go to the relay so a reproduction on the phone is readable on
  // the Mac. Off unless switched on in Settings; the sink drops everything
  // until then, and never carries transcript text.
  final trace = DictationTrace(send: (entries) async {
    final api = await ref.read(relayApiProvider.future);
    await api?.appendDictationTrace(entries);
  });
  ref.listen(
    settingsProvider
        .select((s) => s.valueOrNull?.dictationDiagnostics ?? false),
    (_, enabled) => trace.enabled = enabled,
    fireImmediately: true,
  );

  final service = DictationService(trace: trace);
  // The recognition language is a setting, not the phone's language: see
  // DictationLocale. Pushed on change so the next session picks it up.
  ref.listen(
    settingsProvider.select(
        (s) => s.valueOrNull?.dictationLocale ?? DictationLocale.fallback),
    (_, locale) => service.locale = locale,
    fireImmediately: true,
  );
  ref.onDispose(service.cancel);
  return service;
});

/// Device-local app settings (chat text scale, …). Loads on build, persists on
/// every change.
class SettingsController extends AsyncNotifier<AppSettings> {
  @override
  Future<AppSettings> build() async {
    final s = await ref.read(settingsStoreProvider).load();
    // Best-effort: the relay is shared with desktop, so pull its copy before a
    // local write can accidentally undo a mute/unmute made on the Mac.
    Future.microtask(_pullNotificationPrefs);
    return s;
  }

  Future<void> setChatTextScale(double scale) async {
    final clamped = SettingsStore.clampChatTextScale(scale);
    state = AsyncData((state.valueOrNull ?? const AppSettings())
        .copyWith(chatTextScale: clamped));
    await ref.read(settingsStoreProvider).saveChatTextScale(clamped);
  }

  Future<void> setDocFontSize(double size) async {
    final clamped = SettingsStore.clampDocFontSize(size);
    state = AsyncData((state.valueOrNull ?? const AppSettings())
        .copyWith(docFontSize: clamped));
    await ref.read(settingsStoreProvider).saveDocFontSize(clamped);
  }

  Future<void> setDictationDiagnostics(bool enabled) async {
    state = AsyncData((state.valueOrNull ?? const AppSettings())
        .copyWith(dictationDiagnostics: enabled));
    await ref.read(settingsStoreProvider).saveDictationDiagnostics(enabled);
  }

  Future<void> setPerfDiagnostics(bool enabled) async {
    state = AsyncData((state.valueOrNull ?? const AppSettings())
        .copyWith(perfDiagnostics: enabled));
    await ref.read(settingsStoreProvider).savePerfDiagnostics(enabled);
  }

  Future<void> setDictationLocale(String locale) async {
    final normalized = DictationLocale.normalize(locale);
    state = AsyncData((state.valueOrNull ?? const AppSettings())
        .copyWith(dictationLocale: normalized));
    await ref.read(settingsStoreProvider).saveDictationLocale(normalized);
  }

  Future<void> setAppLockEnabled(bool enabled) async {
    state = AsyncData((state.valueOrNull ?? const AppSettings())
        .copyWith(appLockEnabled: enabled));
    await ref.read(settingsStoreProvider).saveAppLockEnabled(enabled);
  }

  Future<void> setAutoLockDelay(AutoLockDelay delay) async {
    state = AsyncData((state.valueOrNull ?? const AppSettings())
        .copyWith(autoLockDelay: delay));
    await ref.read(settingsStoreProvider).saveAutoLockDelay(delay);
  }

  Future<void> setBypassBiometricEnabled(bool enabled) async {
    state = AsyncData((state.valueOrNull ?? const AppSettings())
        .copyWith(bypassBiometricEnabled: enabled));
    await ref.read(settingsStoreProvider).saveBypassBiometricEnabled(enabled);
  }

  AppSettings get _current => state.valueOrNull ?? const AppSettings();

  Future<void> setThemeMode(AppThemeMode m) async {
    state = AsyncData(_current.copyWith(themeMode: m));
    await ref.read(settingsStoreProvider).saveThemeMode(m);
  }

  Future<void> setAccentColor(int argb) async {
    state = AsyncData(_current.copyWith(accentColor: argb));
    await ref.read(settingsStoreProvider).saveAccentColor(argb);
  }

  Future<void> setReduceMotion(bool v) async {
    state = AsyncData(_current.copyWith(reduceMotion: v));
    await ref.read(settingsStoreProvider).saveReduceMotion(v);
  }

  Future<void> setCompactDensity(bool v) async {
    state = AsyncData(_current.copyWith(compactDensity: v));
    await ref.read(settingsStoreProvider).saveCompactDensity(v);
  }

  Future<void> setShowThinking(bool v) async {
    state = AsyncData(_current.copyWith(showThinkingByDefault: v));
    await ref.read(settingsStoreProvider).saveShowThinking(v);
  }

  Future<void> setFocusMode(bool v) async {
    state = AsyncData(_current.copyWith(focusMode: v));
    await ref.read(settingsStoreProvider).saveFocusMode(v);
  }

  Future<void> setAutoScroll(bool v) async {
    state = AsyncData(_current.copyWith(autoScroll: v));
    await ref.read(settingsStoreProvider).saveAutoScroll(v);
  }

  Future<void> setConfirmBeforeStop(bool v) async {
    state = AsyncData(_current.copyWith(confirmBeforeStop: v));
    await ref.read(settingsStoreProvider).saveConfirmStop(v);
  }

  Future<void> setCodeTheme(String id) async {
    state = AsyncData(_current.copyWith(codeTheme: id));
    await ref.read(settingsStoreProvider).saveCodeTheme(id);
  }

  Future<void> setDefaultRuntime(String v) async {
    state = AsyncData(_current.copyWith(defaultRuntime: v));
    await ref.read(settingsStoreProvider).saveDefaultRuntime(v);
  }

  Future<void> setDefaultModel(String v) async {
    state = AsyncData(_current.copyWith(defaultModel: v));
    await ref.read(settingsStoreProvider).saveDefaultModel(v);
  }

  Future<void> setDefaultPermission(String v) async {
    state = AsyncData(_current.copyWith(defaultPermission: v));
    await ref.read(settingsStoreProvider).saveDefaultPermission(v);
  }

  Future<void> setNotificationsMuted(bool v) async {
    state = AsyncData(_current.copyWith(notificationsMuted: v));
    await ref.read(settingsStoreProvider).saveNotificationsMuted(v);
    await _pushNotificationPrefs();
  }

  Future<void> setNotifyOnDone(bool v) async {
    state = AsyncData(_current.copyWith(notifyOnDone: v));
    await ref.read(settingsStoreProvider).saveNotifyOnDone(v);
    await _pushNotificationPrefs();
  }

  Future<void> setNotifyOnNeedsApproval(bool v) async {
    state = AsyncData(_current.copyWith(notifyOnNeedsApproval: v));
    await ref.read(settingsStoreProvider).saveNotifyOnNeedsApproval(v);
    await _pushNotificationPrefs();
  }

  Future<void> setNotifyOnError(bool v) async {
    state = AsyncData(_current.copyWith(notifyOnError: v));
    await ref.read(settingsStoreProvider).saveNotifyOnError(v);
    await _pushNotificationPrefs();
  }

  /// Mirror the current notification prefs to the relay (best-effort).
  Future<void> _pushNotificationPrefs() async {
    try {
      final api = await ref.read(relayApiProvider.future);
      final s = _current;
      await api?.setNotificationPrefs(
        muted: s.notificationsMuted,
        notifyOnDone: s.notifyOnDone,
        notifyOnNeedsApproval: s.notifyOnNeedsApproval,
        notifyOnError: s.notifyOnError,
      );
    } catch (_) {
      // Best-effort — the relay defaults to "notify" until this succeeds.
    }
  }

  Future<void> _pullNotificationPrefs() async {
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) return;
      final prefs = await api.getNotificationPrefs();
      final next = _current.copyWith(
        notificationsMuted: prefs['muted'] ?? false,
        notifyOnDone: prefs['notifyOnDone'] ?? true,
        notifyOnNeedsApproval: prefs['notifyOnNeedsApproval'] ?? true,
        notifyOnError: prefs['notifyOnError'] ?? true,
      );
      state = AsyncData(next);
      final store = ref.read(settingsStoreProvider);
      await Future.wait([
        store.saveNotificationsMuted(next.notificationsMuted),
        store.saveNotifyOnDone(next.notifyOnDone),
        store.saveNotifyOnNeedsApproval(next.notifyOnNeedsApproval),
        store.saveNotifyOnError(next.notifyOnError),
      ]);
    } catch (_) {
      // Offline: keep the device-local copy until the next app start.
    }
  }
}

final settingsProvider = AsyncNotifierProvider<SettingsController, AppSettings>(
  SettingsController.new,
);

final pinnedStoreProvider = Provider<PinnedStore>((ref) => PinnedStore());

/// Locally cached set of pinned session ids. New toggles are mirrored to the
/// relay so pins/stars sync with the desktop and other phones; the cache keeps
/// old local pins visible until each one is toggled.
class PinnedSessionsController extends AsyncNotifier<Set<String>> {
  @override
  Future<Set<String>> build() => ref.read(pinnedStoreProvider).load();

  Future<void> toggle(String sessionId) async {
    final current = {...(state.valueOrNull ?? const <String>{})};
    if (!current.remove(sessionId)) current.add(sessionId);
    state = AsyncData(current);
    await ref.read(pinnedStoreProvider).save(current);
  }

  Future<void> setPinned(String sessionId, bool pinned) async {
    final current = {...(state.valueOrNull ?? const <String>{})};
    if (pinned) {
      current.add(sessionId);
    } else {
      current.remove(sessionId);
    }
    state = AsyncData(current);
    await ref.read(pinnedStoreProvider).save(current);
    var mirrored = false;
    try {
      final api = await ref.read(relayApiProvider.future);
      await api?.setSessionStarred(sessionId, starred: pinned);
      mirrored = api != null;
    } catch (_) {
      // Best-effort; the local cache preserves the user's choice offline.
    }
    if (mirrored && pinned) {
      final latest = {...(state.valueOrNull ?? const <String>{})}
        ..remove(sessionId);
      state = AsyncData(latest);
      await ref.read(pinnedStoreProvider).save(latest);
    }
  }
}

final pinnedSessionsProvider =
    AsyncNotifierProvider<PinnedSessionsController, Set<String>>(
  PinnedSessionsController.new,
);

final archiveStoreProvider = Provider<ArchiveStore>((ref) => ArchiveStore());

/// Locally cached set of archived session ids. New toggles are mirrored to the
/// relay so archiving syncs with the desktop and other phones — same shape as
/// [PinnedSessionsController].
class ArchivedSessionsController extends AsyncNotifier<Set<String>> {
  @override
  Future<Set<String>> build() => ref.read(archiveStoreProvider).load();

  /// [archived] is the state the user asked for, and the caller computes it from
  /// what the list actually SHOWS — the local cache unioned with the relay's
  /// `row.archived`. It must not be derived from this local set alone: the
  /// mirror step below deliberately empties the set once the relay owns the
  /// flag, so a session archived on the relay is absent here, and "Unarchive"
  /// used to write `archived: true` all over again and appear to do nothing.
  Future<void> setArchived(String sessionId, {required bool archived}) async {
    final current = {...(state.valueOrNull ?? const <String>{})};
    if (archived) {
      current.add(sessionId);
    } else {
      current.remove(sessionId);
    }
    state = AsyncData(current);
    await ref.read(archiveStoreProvider).save(current);
    var mirrored = false;
    try {
      final api = await ref.read(relayApiProvider.future);
      await api?.setSessionArchived(sessionId, archived: archived);
      mirrored = api != null;
    } catch (_) {
      // Best-effort; the local cache preserves the user's choice offline.
    }
    if (mirrored && archived) {
      final latest = {...(state.valueOrNull ?? const <String>{})}
        ..remove(sessionId);
      state = AsyncData(latest);
      await ref.read(archiveStoreProvider).save(latest);
    }
  }
}

final archivedSessionsProvider =
    AsyncNotifierProvider<ArchivedSessionsController, Set<String>>(
  ArchivedSessionsController.new,
);

final aliasStoreProvider = Provider<AliasStore>((ref) => AliasStore());

/// Device-local map of session id → custom title. Loads from secure storage on
/// build and persists on every rename. Aliases are not synced through the relay.
class SessionAliasesController extends AsyncNotifier<Map<String, String>> {
  @override
  Future<Map<String, String>> build() => ref.read(aliasStoreProvider).load();

  Future<void> setAlias(String sessionId, String? title) async {
    final current = {...(state.valueOrNull ?? const <String, String>{})};
    final trimmed = title?.trim() ?? '';
    if (trimmed.isEmpty) {
      current.remove(sessionId);
    } else {
      current[sessionId] = trimmed;
    }
    state = AsyncData(current);
    await ref.read(aliasStoreProvider).save(current);
  }
}

final sessionAliasesProvider =
    AsyncNotifierProvider<SessionAliasesController, Map<String, String>>(
  SessionAliasesController.new,
);

final workspaceOrderStoreProvider =
    Provider<WorkspaceOrderStore>((ref) => WorkspaceOrderStore());

/// Device-local manual order of workspace names. Freshly discovered workspaces
/// are prepended (position 1) and vanished ones dropped, so the list never
/// reshuffles on new session activity — the flicker fix. Drag-and-drop persists
/// through [reorder].
class WorkspaceOrderController extends AsyncNotifier<List<String>> {
  @override
  Future<List<String>> build() => ref.read(workspaceOrderStoreProvider).load();

  /// Reconcile the stored order with the workspaces that actually exist.
  /// [presentInDisplayOrder] is the current on-screen order, with any not-yet
  /// tracked workspaces already sorted to the front. New names are prepended and
  /// absent ones removed; persists only when something changed.
  Future<void> reconcile(List<String> presentInDisplayOrder) async {
    final current = state.valueOrNull;
    if (current == null) return;
    final present = presentInDisplayOrder.toSet();
    final tracked = current.toSet();
    final additions =
        presentInDisplayOrder.where((n) => !tracked.contains(n)).toList();
    final retained = current.where(present.contains).toList();
    final next = [...additions, ...retained];
    if (_sameOrder(next, current)) return;
    state = AsyncData(next);
    await ref.read(workspaceOrderStoreProvider).save(next);
  }

  /// Move a workspace within the given [displayNames] (the exact on-screen
  /// order) and persist the result as the new canonical order.
  Future<void> reorder(
      List<String> displayNames, int oldIndex, int newIndex) async {
    final next = [...displayNames];
    if (oldIndex < 0 || oldIndex >= next.length) return;
    // ReorderableListView reports newIndex assuming the item is still present.
    if (newIndex > oldIndex) newIndex -= 1;
    if (newIndex < 0) newIndex = 0;
    if (newIndex >= next.length) newIndex = next.length - 1;
    if (oldIndex == newIndex) return;
    final moved = next.removeAt(oldIndex);
    next.insert(newIndex, moved);
    state = AsyncData(next);
    await ref.read(workspaceOrderStoreProvider).save(next);
  }

  static bool _sameOrder(List<String> a, List<String> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

final workspaceOrderProvider =
    AsyncNotifierProvider<WorkspaceOrderController, List<String>>(
  WorkspaceOrderController.new,
);

final scratchWorkspaceStoreProvider =
    Provider<ScratchWorkspaceStore>((ref) => ScratchWorkspaceStore());

/// The desktop's scratch ("No project") workspace path, remembered the first
/// time a live session with that `cwd` is seen. This is what lets the "No
/// project" group in the session list survive that session being archived,
/// deleted, or filtered out, and across app restarts — see
/// `session_list_screen.dart`'s `_groupByWorkspace` use of this provider.
class ScratchWorkspaceController extends AsyncNotifier<String?> {
  @override
  Future<String?> build() async {
    final stored = await ref.read(scratchWorkspaceStoreProvider).load();
    ref.listen<AsyncValue<List<SessionRow>>>(sessionsStreamProvider, (_, next) {
      final rows = next.valueOrNull;
      if (rows == null) return;
      for (final row in rows) {
        final cwd = row.cwd;
        if (cwd != null && isScratchWorkspacePath(cwd)) {
          _remember(cwd);
          return;
        }
      }
    }, fireImmediately: true);
    if (stored != null) return stored;
    // Nothing seen locally yet (fresh install, or a session in that folder
    // just hasn't come through this stream) — ask the desktop directly via
    // the `scratch-workspace` command so "No project" can still appear.
    unawaited(_resolveFresh());
    return null;
  }

  Future<void> _resolveFresh() async {
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) return;
      final path = await api.ensureScratchWorkspace();
      await _remember(path);
    } catch (_) {
      // Desktop offline, or it doesn't support this command yet — "No
      // project" simply stays absent until a live scratch session is seen
      // the ordinary way.
    }
  }

  Future<void> _remember(String path) async {
    if (state.valueOrNull == path) return;
    state = AsyncData(path);
    await ref.read(scratchWorkspaceStoreProvider).save(path);
  }
}

final scratchWorkspaceProvider =
    AsyncNotifierProvider<ScratchWorkspaceController, String?>(
  ScratchWorkspaceController.new,
);

/// Holds the paired credentials (null = not paired yet). Loads from secure
/// storage on build; drives which screen the app shows.
class PairingController extends AsyncNotifier<PairingCredentials?> {
  @override
  Future<PairingCredentials?> build() async {
    final creds = await ref.read(pairingStoreProvider).load();
    if (creds != null) {
      await RelayClient.ensureInitialized(creds.url);
      final migrated = await _enrollCommandIdentity(creds);
      if (migrated == null) return null;
      await PushNotifications.registerForPairing(migrated);
      return migrated;
    }
    return creds;
  }

  /// Complete pairing from a scanned QR payload: mint mobile credentials, claim
  /// the code on the relay, and persist. The E2E key never leaves the device.
  Future<void> pair(PairingPayload payload) async {
    final store = ref.read(pairingStoreProvider);
    final mobileId = const Uuid().v4();
    final token = _randomToken();
    final client = await RelayClient.ensureInitialized(payload.url);
    final identity = await CommandIdentity.loadOrCreate();
    final v3Claim = {
      'code': payload.code,
      'mobileId': mobileId,
      'token': token,
      'name': 'Panda Code Mobile',
      'commandAuthVersion': 3,
      'commandKeyId': identity.keyId,
      'commandPublicKey': identity.publicKeyBase64,
      'commandKeyProtection': identity.protection,
    };
    var commandAuthVersion = 3;
    try {
      await client.mutation('pairing:claimCode', v3Claim);
    } catch (error) {
      if (!_isLegacyRelay(error)) rethrow;
      commandAuthVersion = 0;
      await client.mutation('pairing:claimCode', {
        'code': payload.code,
        'mobileId': mobileId,
        'token': token,
        'name': 'Panda Code Mobile',
      });
    }
    final creds = PairingCredentials(
      url: payload.url,
      deviceId: payload.deviceId,
      mobileId: mobileId,
      mobileToken: token,
      keyBase64: payload.keyBase64,
      commandAuthVersion: commandAuthVersion == 3 ? 3 : null,
    );
    await store.save(creds);
    state = AsyncData(creds);
    await PushNotifications.registerForPairing(creds);
  }

  Future<PairingCredentials?> _enrollCommandIdentity(
      PairingCredentials creds) async {
    if (creds.commandAuthVersion == 3) return creds;
    final identity = await CommandIdentity.loadOrCreate();
    final client = await RelayClient.ensureInitialized(creds.url);
    try {
      await client.mutation('pairing:registerCommandIdentity', {
        'mobileId': creds.mobileId,
        'token': creds.mobileToken,
        'commandAuthVersion': 3,
        'commandKeyId': identity.keyId,
        'commandPublicKey': identity.publicKeyBase64,
        'commandKeyProtection': identity.protection,
      });
    } catch (error) {
      if (_isLegacyRelay(error)) return creds;
      if (error
          .toString()
          .contains('COMMAND_IDENTITY_CHANGED_REPAIR_REQUIRED')) {
        await PushNotifications.reset();
        await ref.read(pairingStoreProvider).clear();
        return null;
      }
      rethrow;
    }
    final migrated = PairingCredentials(
      url: creds.url,
      deviceId: creds.deviceId,
      mobileId: creds.mobileId,
      mobileToken: creds.mobileToken,
      keyBase64: creds.keyBase64,
      commandAuthVersion: 3,
    );
    await ref.read(pairingStoreProvider).save(migrated);
    return migrated;
  }

  bool _isLegacyRelay(Object error) {
    final message = error.toString().toLowerCase();
    return message.contains('could not find') ||
        message.contains('not a function') ||
        message.contains('extra field') ||
        message.contains('unexpected field');
  }

  Future<void> unpair() async {
    await PushNotifications.reset();
    await ref.read(pairingStoreProvider).clear();
    RelayClient.reset();
    state = const AsyncData(null);
  }

  String _randomToken() {
    final r = Random.secure();
    return base64UrlEncode(List<int>.generate(32, (_) => r.nextInt(256)));
  }
}

final pairingProvider =
    AsyncNotifierProvider<PairingController, PairingCredentials?>(
  PairingController.new,
);

/// Performance diagnostics (dropped frames + decrypt/build timings) to the
/// relay. On by default in Settings (see AppSettings.perfDiagnostics) — the
/// `send` closure reads relayApiProvider lazily on flush, same pattern as
/// dictationServiceProvider below, so there's no real circularity even though
/// RelayApi itself is what records into this.
final Provider<PerfTrace> perfTraceProvider = Provider<PerfTrace>((ref) {
  final trace = PerfTrace(send: (entries) async {
    final api = await ref.read(relayApiProvider.future);
    await api?.appendPerfTrace(entries);
  });
  ref.listen(
    settingsProvider.select((s) => s.valueOrNull?.perfDiagnostics ?? true),
    (_, enabled) => trace.enabled = enabled,
    fireImmediately: true,
  );
  return trace;
});

/// The authenticated relay API — available only once paired.
final FutureProvider<RelayApi?> relayApiProvider =
    FutureProvider<RelayApi?>((ref) async {
  final creds = ref.watch(pairingProvider).valueOrNull;
  if (creds == null) return null;
  final client = await RelayClient.ensureInitialized(creds.url);
  return RelayApi(
      client: client, creds: creds, perfTrace: ref.read(perfTraceProvider));
});

/// Live desktop presence (+ the usage snapshot it carries). A subscription, not
/// a one-shot: when the Mac disappears mid-turn every screen showing "working"
/// is showing a lie, and this is what tells them.
final deviceStatusProvider = StreamProvider<DeviceStatus?>((ref) async* {
  final api = await ref.watch(relayApiProvider.future);
  if (api == null) {
    yield null;
    return;
  }
  yield* api.watchDeviceStatus();
});

/// Ticks so heartbeat freshness is re-evaluated without a relay write. Only the
/// desktop writes the device doc, so a Mac that died produces no further
/// updates — without a local clock the phone would sit on the last "online"
/// forever. Cheap: one setState-equivalent per tick, no network.
final _presenceClockProvider = StreamProvider<DateTime>((ref) async* {
  yield DateTime.now();
  yield* Stream.periodic(
    const Duration(seconds: 10),
    (_) => DateTime.now(),
  );
});

/// Is the paired Mac reachable right now? Combines the relay's flag with local
/// aging of the last heartbeat (see [DeviceStatus.isOnlineAt]). Everything that
/// gates on "can the desktop act" should read this rather than `status.online`.
final desktopOnlineProvider = Provider<bool>((ref) {
  final status = ref.watch(deviceStatusProvider).valueOrNull;
  final now = ref.watch(_presenceClockProvider).valueOrNull ?? DateTime.now();
  return status?.isOnlineAt(now) ?? false;
});

/// Live session list (status + runtime update in real time via the tail sub).
final sessionsStreamProvider = StreamProvider<List<SessionRow>>((ref) async* {
  final api = await ref.watch(relayApiProvider.future);
  if (api == null) {
    yield const [];
    return;
  }
  yield* api.watchSessions();
});

/// Live runtime badge for a single OPEN session (`sessions:runtime`, one row).
/// The list no longer carries the runtime blob — this per-session subscription
/// is what keeps the runtime header/approval bar live while keeping the
/// all-sessions `list` query off the per-token firehose. Only sessions with an
/// active listener (i.e. on screen) hold a subscription.
final sessionRuntimeProvider =
    StreamProvider.family<SessionRuntimeSnapshot?, String>(
        (ref, sessionId) async* {
  final api = await ref.watch(relayApiProvider.future);
  if (api == null) {
    yield null;
    return;
  }
  yield* api.watchRuntime(sessionId);
});

/// The live row for a single session (drives the runtime header + approval bar).
/// Merges the lean list row with the live runtime snapshot so downstream widgets
/// keep reading `row.runtime` unchanged.
final sessionRowProvider =
    Provider.family<SessionRow?, String>((ref, sessionId) {
  final rows = ref.watch(sessionsStreamProvider).valueOrNull ?? const [];
  SessionRow? base;
  for (final r in rows) {
    if (r.sessionId == sessionId) {
      base = r;
      break;
    }
  }
  if (base == null) return null;
  final runtime = ref.watch(sessionRuntimeProvider(sessionId)).valueOrNull;
  return base.withRuntime(runtime);
});

/// Session ids whose agent just finished a turn (working -> waiting or
/// needs_action) while nobody was watching — mirrors the desktop sidebar's
/// "just ended" dot. Diffs consecutive [sessionsStreamProvider] emissions
/// (the one stream that reaches every row, not just the one on screen) rather
/// than reading a single snapshot, since a transition is what matters, not a
/// static state. Ephemeral and in-memory only, exactly like the desktop: nothing
/// here is synced through the relay.
final attentionSessionIdsProvider =
    NotifierProvider<AttentionController, Set<String>>(AttentionController.new);

class AttentionController extends Notifier<Set<String>> {
  // Filters out subagent blips that bounce back to "working" within a beat,
  // same rationale as the desktop's FINISH_SETTLE_MS.
  static const _settleDelay = Duration(seconds: 4);

  final Map<String, AgentState> _prevState = {};
  final Map<String, Timer> _settleTimers = {};
  bool _seeded = false;

  @override
  Set<String> build() {
    ref.listen<AsyncValue<List<SessionRow>>>(sessionsStreamProvider, (_, next) {
      final rows = next.valueOrNull;
      if (rows != null) _onRows(rows);
    });
    ref.onDispose(() {
      for (final timer in _settleTimers.values) {
        timer.cancel();
      }
    });
    return const <String>{};
  }

  void _onRows(List<SessionRow> rows) {
    final liveIds = <String>{};
    final resumedIds = <String>[];

    for (final row in rows) {
      final id = row.sessionId;
      liveIds.add(id);
      final current = row.agentState;
      final prior = _prevState[id];
      _prevState[id] = current;

      if (current == AgentState.working) {
        _settleTimers.remove(id)?.cancel();
        resumedIds.add(id);
        continue;
      }
      if (current == AgentState.exited) {
        _settleTimers.remove(id)?.cancel();
        continue;
      }

      final justFinished =
          current == AgentState.waiting || current == AgentState.needsAction;
      if (_seeded &&
          prior == AgentState.working &&
          justFinished &&
          !_settleTimers.containsKey(id)) {
        _settleTimers[id] = Timer(_settleDelay, () {
          _settleTimers.remove(id);
          if (!state.contains(id)) {
            state = {...state, id};
          }
        });
      }
    }

    _prevState.removeWhere((id, _) => !liveIds.contains(id));

    // First emission just seeds prior state — nothing has "just" transitioned.
    if (!_seeded) {
      _seeded = true;
      return;
    }

    if (state.isEmpty) return;
    final next = state
        .where((id) => liveIds.contains(id) && !resumedIds.contains(id))
        .toSet();
    if (next.length != state.length) {
      state = next;
    }
  }

  /// The user looked: drop the marker for [sessionId].
  void clear(String sessionId) {
    if (!state.contains(sessionId)) return;
    state = {...state}..remove(sessionId);
  }
}

/// The in-flight session draft: everything the New Session route has collected
/// but not yet committed. Held here rather than in the route's State so composer
/// and picker widgets can share one source of truth while the route is open.
///
/// Deliberately memory-only (no secure-storage write): a draft is a few seconds
/// of intent, not a preference, and it should not outlive the app. Cleared when
/// a fresh New Session route opens and when the draft becomes a real session.
final sessionDraftProvider =
    NotifierProvider<SessionDraftController, SessionDraft>(
        SessionDraftController.new);

class SessionDraftController extends Notifier<SessionDraft> {
  @override
  SessionDraft build() => const SessionDraft();

  void update(SessionDraft draft) => state = draft;

  void clear() => state = const SessionDraft();
}

/// Live outcomes of the commands this phone has issued (for surfacing failures
/// that never produce a session, e.g. a rejected `start`).
final commandOutcomesProvider =
    StreamProvider<List<CommandOutcome>>((ref) async* {
  final api = await ref.watch(relayApiProvider.future);
  if (api == null) {
    yield const [];
    return;
  }
  yield* api.watchCommands();
});

/// The failed `start` command for [sessionId], if the desktop rejected the
/// launch. Non-null means the session will never materialize, so the view can
/// explain why (e.g. missing workspace) instead of spinning forever.
final startFailureProvider =
    Provider.family<CommandOutcome?, String>((ref, sessionId) {
  final outcomes = ref.watch(commandOutcomesProvider).valueOrNull ?? const [];
  for (final c in outcomes) {
    if (c.type == 'start' && c.sessionId == sessionId && c.failed) return c;
  }
  return null;
});
