import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../sessions/settings_store.dart';
import 'biometric_auth.dart';

/// Runtime state of the app lock. [locked] gates the whole UI behind Face ID;
/// [authInProgress] suppresses duplicate prompts while one is on screen.
class AppLockState {
  final bool locked;
  final bool authInProgress;

  const AppLockState({this.locked = true, this.authInProgress = false});

  AppLockState copyWith({bool? locked, bool? authInProgress}) => AppLockState(
        locked: locked ?? this.locked,
        authInProgress: authInProgress ?? this.authInProgress,
      );
}

/// Owns whether the app is currently locked. The lifecycle transitions are fed
/// in by [AppLockGate]; settings changes are pushed in via [applySettings].
class AppLockController extends Notifier<AppLockState> {
  bool _enabled = true;
  Duration _grace = Duration.zero;

  /// When the app was last backgrounded — used to measure the grace period.
  DateTime? _backgroundedAt;

  /// Whether the one automatic prompt for the current lock episode has fired.
  /// Prevents the gate re-triggering Face ID on every rebuild (which would trap
  /// the user if they cancel). Reset whenever a fresh lock episode begins.
  bool _autoPromptConsumed = false;

  @override
  AppLockState build() {
    // Start locked at cold start; [applySettings] unlocks immediately if the
    // user has the feature turned off.
    return const AppLockState(locked: true);
  }

  /// Mirror the current preferences into the controller. Turning the feature off
  /// unlocks right away; turning it on does not force a lock mid-session.
  void applySettings(AppSettings settings) {
    _enabled = settings.appLockEnabled;
    _grace = settings.autoLockDelay.duration;
    if (!_enabled && state.locked) {
      state = state.copyWith(locked: false);
    }
  }

  /// App went to the background — remember when, so [onResumed] can compare
  /// against the configured grace period.
  ///
  /// The Face ID prompt itself resigns the app active (inactive → resumed), so
  /// while an auth is in flight we must NOT record a timestamp — otherwise the
  /// prompt's own resume would immediately re-lock and loop forever.
  void onBackgrounded() {
    if (state.authInProgress) return;
    _backgroundedAt ??= DateTime.now();
  }

  /// App returned to the foreground — re-lock if enabled and the grace period
  /// has elapsed since it was backgrounded. Ignored while a prompt is showing,
  /// since that transition is the prompt dismissing rather than a real return.
  void onResumed() {
    if (state.authInProgress) return;
    final backgroundedAt = _backgroundedAt;
    _backgroundedAt = null;
    if (!_enabled || state.locked) return;
    if (backgroundedAt == null) return;
    if (DateTime.now().difference(backgroundedAt) >= _grace) {
      _autoPromptConsumed = false; // fresh lock episode → allow one auto-prompt
      state = state.copyWith(locked: true);
    }
  }

  /// Prompt for Face ID and unlock on success. No-ops if unlocked or a prompt
  /// is already showing.
  ///
  /// [automatic] marks a gate-driven prompt (cold start / return from
  /// background); only one such prompt fires per lock episode so a cancelled
  /// prompt doesn't immediately re-appear. Manual taps (automatic == false)
  /// always prompt.
  Future<void> authenticate({bool automatic = false}) async {
    if (!state.locked || state.authInProgress) return;
    if (automatic && _autoPromptConsumed) return;
    if (automatic) _autoPromptConsumed = true;
    state = state.copyWith(authInProgress: true);
    try {
      final ok = await BiometricAuth.authenticate();
      state = state.copyWith(locked: !ok, authInProgress: false);
    } catch (_) {
      state = state.copyWith(authInProgress: false);
    }
  }
}

final appLockProvider =
    NotifierProvider<AppLockController, AppLockState>(AppLockController.new);
