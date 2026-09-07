import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../dictation/dictation_service.dart';

/// How long the app may stay in the background before Face ID is required
/// again on return. [immediate] re-locks the moment the app is left.
enum AutoLockDelay {
  immediate(0, 'Immediately'),
  after1min(60, 'After 1 minute'),
  after5min(300, 'After 5 minutes'),
  after15min(900, 'After 15 minutes'),
  after1hour(3600, 'After 1 hour');

  const AutoLockDelay(this.seconds, this.label);

  /// Grace period, in seconds, before a backgrounded app re-locks.
  final int seconds;

  /// Human-readable label shown in Settings.
  final String label;

  Duration get duration => Duration(seconds: seconds);

  static AutoLockDelay fromSeconds(int? seconds) {
    for (final d in AutoLockDelay.values) {
      if (d.seconds == seconds) return d;
    }
    return AutoLockDelay.immediate;
  }
}

/// App theme brightness preference (mapped to Flutter's ThemeMode in app.dart).
enum AppThemeMode {
  system('system', 'System'),
  light('light', 'Light'),
  dark('dark', 'Dark');

  const AppThemeMode(this.id, this.label);
  final String id;
  final String label;

  static AppThemeMode fromId(String? id) => AppThemeMode.values
      .firstWhere((m) => m.id == id, orElse: () => AppThemeMode.dark);
}

/// Device-local app preferences (not synced through the relay).
class AppSettings {
  /// Where the document reader starts: the transcript's 14pt body plus two.
  static const double defaultDocFontSize = 16;

  /// Brass — the shared design system's one accent. When [accentColor] equals this,
  /// the app uses the design tokens verbatim rather than deriving an override, so
  /// the default experience is exactly what was designed.
  static const int defaultAccentColor = 0xFFD0A85D;

  /// Multiplier applied to chat transcript text (1.0 = system default).
  final double chatTextScale;

  /// Base point size for the document reader's prose. Its own setting rather
  /// than the chat scale: a document is read at length, so it starts two points
  /// above the transcript's 14 and is adjusted from the reader itself.
  final double docFontSize;

  /// When true, Face ID (or the device passcode) is required to view the app.
  final bool appLockEnabled;

  /// When true, starting a full-access (bypass permissions) session requires
  /// a fresh Face ID (or passcode) confirmation. On by default.
  final bool bypassBiometricEnabled;

  /// Stream dictation diagnostics to the relay. Off by default. Carries event
  /// names and character counts only — never transcript text — and exists to
  /// debug the transcript-erasing bug from a real device.
  final bool dictationDiagnostics;

  /// Stream frame-jank samples and hand-picked operation timings (decrypt
  /// batches, tile builds) to the relay. On by default — unlike dictation
  /// diagnostics, this never carries transcript content, only durations and
  /// counts, and exists to debug "feels laggy" reports that can't be
  /// reproduced off-device.
  final bool perfDiagnostics;

  /// Language dictation decodes speech as, e.g. `en-US`. Deliberately not the
  /// phone's language — see [DictationLocale].
  final String dictationLocale;

  /// Grace period before a backgrounded app re-locks.
  final AutoLockDelay autoLockDelay;

  // Appearance.
  final AppThemeMode themeMode;

  /// ARGB. Cosmetic only — it repaints the accent group and nothing else. Status
  /// colours and surfaces come from the shared design system regardless, so this
  /// cannot change what "needs your approval" looks like. See panda_theme.dart.
  final int accentColor;
  final bool reduceMotion;
  final bool compactDensity;

  // Chat behavior.
  final bool showThinkingByDefault;

  /// Focus mode: show only prompts, replies, and the final answer; fold tool
  /// calls, thinking, and system activity into one expandable "Agent work" row.
  final bool focusMode;
  final bool autoScroll;
  final bool confirmBeforeStop;
  final String codeTheme; // flutter_highlight theme id, e.g. 'atom-one-dark'

  // Defaults for new sessions.
  final String defaultRuntime; // 'claude' | 'codex'
  final String defaultModel;
  final String defaultPermission;

  // Notification preferences (device-local; see note in Settings UI).
  final bool notificationsMuted;
  final bool notifyOnDone;
  final bool notifyOnNeedsApproval;
  final bool notifyOnError;

  const AppSettings({
    this.dictationDiagnostics = false,
    this.perfDiagnostics = true,
    this.dictationLocale = DictationLocale.fallback,
    this.chatTextScale = 1.0,
    this.docFontSize = defaultDocFontSize,
    this.appLockEnabled = true,
    this.bypassBiometricEnabled = true,
    this.autoLockDelay = AutoLockDelay.immediate,
    this.themeMode = AppThemeMode.dark,
    this.accentColor = defaultAccentColor,
    this.reduceMotion = false,
    this.compactDensity = false,
    this.showThinkingByDefault = false,
    this.focusMode = false,
    this.autoScroll = true,
    this.confirmBeforeStop = false,
    this.codeTheme = 'atom-one-dark',
    this.defaultRuntime = 'claude',
    this.defaultModel = '',
    this.defaultPermission = '',
    this.notificationsMuted = false,
    this.notifyOnDone = true,
    this.notifyOnNeedsApproval = true,
    this.notifyOnError = true,
  });

  AppSettings copyWith({
    bool? dictationDiagnostics,
    bool? perfDiagnostics,
    String? dictationLocale,
    double? chatTextScale,
    double? docFontSize,
    bool? appLockEnabled,
    bool? bypassBiometricEnabled,
    AutoLockDelay? autoLockDelay,
    AppThemeMode? themeMode,
    int? accentColor,
    bool? reduceMotion,
    bool? compactDensity,
    bool? showThinkingByDefault,
    bool? focusMode,
    bool? autoScroll,
    bool? confirmBeforeStop,
    String? codeTheme,
    String? defaultRuntime,
    String? defaultModel,
    String? defaultPermission,
    bool? notificationsMuted,
    bool? notifyOnDone,
    bool? notifyOnNeedsApproval,
    bool? notifyOnError,
  }) =>
      AppSettings(
        chatTextScale: chatTextScale ?? this.chatTextScale,
        docFontSize: docFontSize ?? this.docFontSize,
        appLockEnabled: appLockEnabled ?? this.appLockEnabled,
        bypassBiometricEnabled:
            bypassBiometricEnabled ?? this.bypassBiometricEnabled,
        dictationDiagnostics:
            dictationDiagnostics ?? this.dictationDiagnostics,
        perfDiagnostics: perfDiagnostics ?? this.perfDiagnostics,
        dictationLocale: dictationLocale ?? this.dictationLocale,
        autoLockDelay: autoLockDelay ?? this.autoLockDelay,
        themeMode: themeMode ?? this.themeMode,
        accentColor: accentColor ?? this.accentColor,
        reduceMotion: reduceMotion ?? this.reduceMotion,
        compactDensity: compactDensity ?? this.compactDensity,
        showThinkingByDefault:
            showThinkingByDefault ?? this.showThinkingByDefault,
        focusMode: focusMode ?? this.focusMode,
        autoScroll: autoScroll ?? this.autoScroll,
        confirmBeforeStop: confirmBeforeStop ?? this.confirmBeforeStop,
        codeTheme: codeTheme ?? this.codeTheme,
        defaultRuntime: defaultRuntime ?? this.defaultRuntime,
        defaultModel: defaultModel ?? this.defaultModel,
        defaultPermission: defaultPermission ?? this.defaultPermission,
        notificationsMuted: notificationsMuted ?? this.notificationsMuted,
        notifyOnDone: notifyOnDone ?? this.notifyOnDone,
        notifyOnNeedsApproval:
            notifyOnNeedsApproval ?? this.notifyOnNeedsApproval,
        notifyOnError: notifyOnError ?? this.notifyOnError,
      );
}

class SettingsStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _kChatTextScale = 'pc.chatTextScale';
  static const _kDocFontSize = 'pc.docFontSize';
  static const _kAppLockEnabled = 'pc.appLockEnabled';
  static const _kBypassBiometricEnabled = 'pc.bypassBiometricEnabled';
  static const _kDictationDiagnostics = 'pc.dictationDiagnostics';
  static const _kPerfDiagnostics = 'pc.perfDiagnostics';
  static const _kDictationLocale = 'pc.dictationLocale';
  static const _kAutoLockDelay = 'pc.autoLockDelaySeconds';
  static const _kThemeMode = 'pc.themeMode';
  static const _kAccent = 'pc.accentColor';
  static const _kReduceMotion = 'pc.reduceMotion';
  static const _kCompactDensity = 'pc.compactDensity';
  static const _kShowThinking = 'pc.showThinking';
  static const _kFocusMode = 'pc.focusMode';
  static const _kAutoScroll = 'pc.autoScroll';
  static const _kConfirmStop = 'pc.confirmStop';
  static const _kCodeTheme = 'pc.codeTheme';
  static const _kDefaultRuntime = 'pc.defaultRuntime';
  static const _kDefaultModel = 'pc.defaultModel';
  static const _kDefaultPermission = 'pc.defaultPermission';
  static const _kNotifMuted = 'pc.notifMuted';
  static const _kNotifDone = 'pc.notifDone';
  static const _kNotifNeeds = 'pc.notifNeeds';
  static const _kNotifError = 'pc.notifError';

  /// Allowed chat text-scale bounds, shared with the settings UI.
  static const double minChatTextScale = 0.8;
  static const double maxChatTextScale = 1.6;

  static double clampChatTextScale(double v) =>
      v.clamp(minChatTextScale, maxChatTextScale);

  /// Allowed document text-size bounds, shared with the reader's adjuster.
  static const double minDocFontSize = 12;
  static const double maxDocFontSize = 26;

  static double clampDocFontSize(double v) =>
      v.roundToDouble().clamp(minDocFontSize, maxDocFontSize);

  Future<AppSettings> load() async {
    final all = await _storage.readAll();
    bool flag(String key, bool fallback) {
      final v = all[key];
      return v == null ? fallback : v == 'true';
    }

    final scale = double.tryParse(all[_kChatTextScale] ?? '');
    return AppSettings(
      chatTextScale: clampChatTextScale(scale ?? 1.0),
      docFontSize: clampDocFontSize(
          double.tryParse(all[_kDocFontSize] ?? '') ??
              AppSettings.defaultDocFontSize),
      // Default ON: the app is protected until the user opts out.
      appLockEnabled: flag(_kAppLockEnabled, true),
      // Default ON: full-access sessions require Face ID until opted out.
      bypassBiometricEnabled: flag(_kBypassBiometricEnabled, true),
      dictationDiagnostics: flag(_kDictationDiagnostics, false),
      perfDiagnostics: flag(_kPerfDiagnostics, true),
      dictationLocale: DictationLocale.normalize(all[_kDictationLocale]),
      autoLockDelay:
          AutoLockDelay.fromSeconds(int.tryParse(all[_kAutoLockDelay] ?? '')),
      themeMode: AppThemeMode.fromId(all[_kThemeMode]),
      accentColor:
          int.tryParse(all[_kAccent] ?? '') ?? AppSettings.defaultAccentColor,
      reduceMotion: flag(_kReduceMotion, false),
      compactDensity: flag(_kCompactDensity, false),
      showThinkingByDefault: flag(_kShowThinking, false),
      focusMode: flag(_kFocusMode, false),
      autoScroll: flag(_kAutoScroll, true),
      confirmBeforeStop: flag(_kConfirmStop, false),
      codeTheme: all[_kCodeTheme] ?? 'atom-one-dark',
      defaultRuntime: all[_kDefaultRuntime] ?? 'claude',
      defaultModel: all[_kDefaultModel] ?? '',
      defaultPermission: all[_kDefaultPermission] ?? '',
      notificationsMuted: flag(_kNotifMuted, false),
      notifyOnDone: flag(_kNotifDone, true),
      notifyOnNeedsApproval: flag(_kNotifNeeds, true),
      notifyOnError: flag(_kNotifError, true),
    );
  }

  Future<void> saveChatTextScale(double scale) => _storage.write(
      key: _kChatTextScale, value: clampChatTextScale(scale).toString());

  Future<void> saveDocFontSize(double size) => _storage.write(
      key: _kDocFontSize, value: clampDocFontSize(size).toString());

  Future<void> saveAppLockEnabled(bool enabled) =>
      _storage.write(key: _kAppLockEnabled, value: enabled.toString());

  Future<void> saveBypassBiometricEnabled(bool enabled) => _storage.write(
      key: _kBypassBiometricEnabled, value: enabled.toString());

  Future<void> saveDictationDiagnostics(bool enabled) =>
      _storage.write(key: _kDictationDiagnostics, value: enabled.toString());

  Future<void> savePerfDiagnostics(bool enabled) =>
      _storage.write(key: _kPerfDiagnostics, value: enabled.toString());

  Future<void> saveDictationLocale(String locale) => _storage.write(
      key: _kDictationLocale, value: DictationLocale.normalize(locale));

  Future<void> saveAutoLockDelay(AutoLockDelay delay) =>
      _storage.write(key: _kAutoLockDelay, value: delay.seconds.toString());

  Future<void> saveThemeMode(AppThemeMode mode) =>
      _storage.write(key: _kThemeMode, value: mode.id);

  Future<void> saveAccentColor(int argb) =>
      _storage.write(key: _kAccent, value: argb.toString());

  Future<void> saveReduceMotion(bool v) =>
      _storage.write(key: _kReduceMotion, value: v.toString());

  Future<void> saveCompactDensity(bool v) =>
      _storage.write(key: _kCompactDensity, value: v.toString());

  Future<void> saveShowThinking(bool v) =>
      _storage.write(key: _kShowThinking, value: v.toString());

  Future<void> saveFocusMode(bool v) =>
      _storage.write(key: _kFocusMode, value: v.toString());

  Future<void> saveAutoScroll(bool v) =>
      _storage.write(key: _kAutoScroll, value: v.toString());

  Future<void> saveConfirmStop(bool v) =>
      _storage.write(key: _kConfirmStop, value: v.toString());

  Future<void> saveCodeTheme(String id) =>
      _storage.write(key: _kCodeTheme, value: id);

  Future<void> saveDefaultRuntime(String v) =>
      _storage.write(key: _kDefaultRuntime, value: v);

  Future<void> saveDefaultModel(String v) =>
      _storage.write(key: _kDefaultModel, value: v);

  Future<void> saveDefaultPermission(String v) =>
      _storage.write(key: _kDefaultPermission, value: v);

  Future<void> saveNotificationsMuted(bool v) =>
      _storage.write(key: _kNotifMuted, value: v.toString());

  Future<void> saveNotifyOnDone(bool v) =>
      _storage.write(key: _kNotifDone, value: v.toString());

  Future<void> saveNotifyOnNeedsApproval(bool v) =>
      _storage.write(key: _kNotifNeeds, value: v.toString());

  Future<void> saveNotifyOnError(bool v) =>
      _storage.write(key: _kNotifError, value: v.toString());
}
