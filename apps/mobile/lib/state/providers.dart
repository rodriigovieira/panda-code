import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../notifications/push_notifications.dart';
import '../pairing/pairing_payload.dart';
import '../pairing/pairing_store.dart';
import '../relay/relay_api.dart';
import '../relay/relay_client.dart';
import '../sessions/alias_store.dart';
import '../sessions/archive_store.dart';
import '../sessions/models.dart';
import '../sessions/pinned_store.dart';
import '../sessions/settings_store.dart';
import '../sessions/workspace_order_store.dart';

final pairingStoreProvider = Provider<PairingStore>((ref) => PairingStore());

final settingsStoreProvider = Provider<SettingsStore>((ref) => SettingsStore());

/// Device-local app settings (chat text scale, …). Loads on build, persists on
/// every change.
class SettingsController extends AsyncNotifier<AppSettings> {
  @override
  Future<AppSettings> build() async {
    final s = await ref.read(settingsStoreProvider).load();
    // Best-effort: mirror stored notification prefs to the relay once it's
    // available (covers re-pair / reinstall where the relay row is fresh).
    Future.microtask(_pushNotificationPrefs);
    return s;
  }

  Future<void> setChatTextScale(double scale) async {
    final clamped = SettingsStore.clampChatTextScale(scale);
    state = AsyncData((state.valueOrNull ?? const AppSettings())
        .copyWith(chatTextScale: clamped));
    await ref.read(settingsStoreProvider).saveChatTextScale(clamped);
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

/// Device-local set of archived (hidden) session ids.
class ArchivedSessionsController extends AsyncNotifier<Set<String>> {
  @override
  Future<Set<String>> build() => ref.read(archiveStoreProvider).load();

  Future<void> toggle(String sessionId) async {
    final current = {...(state.valueOrNull ?? const <String>{})};
    if (!current.remove(sessionId)) current.add(sessionId);
    state = AsyncData(current);
    await ref.read(archiveStoreProvider).save(current);
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

/// Holds the paired credentials (null = not paired yet). Loads from secure
/// storage on build; drives which screen the app shows.
class PairingController extends AsyncNotifier<PairingCredentials?> {
  @override
  Future<PairingCredentials?> build() async {
    final creds = await ref.read(pairingStoreProvider).load();
    if (creds != null) {
      await RelayClient.ensureInitialized(creds.url);
      await PushNotifications.registerForPairing(creds);
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
    await client.mutation('pairing:claimCode', {
      'code': payload.code,
      'mobileId': mobileId,
      'token': token,
      'name': 'Panda Code Mobile',
    });
    final creds = PairingCredentials(
      url: payload.url,
      deviceId: payload.deviceId,
      mobileId: mobileId,
      mobileToken: token,
      keyBase64: payload.keyBase64,
    );
    await store.save(creds);
    state = AsyncData(creds);
    await PushNotifications.registerForPairing(creds);
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

/// The authenticated relay API — available only once paired.
final relayApiProvider = FutureProvider<RelayApi?>((ref) async {
  final creds = ref.watch(pairingProvider).valueOrNull;
  if (creds == null) return null;
  final client = await RelayClient.ensureInitialized(creds.url);
  return RelayApi(client: client, creds: creds);
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
