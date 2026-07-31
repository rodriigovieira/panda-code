import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../sessions/settings_store.dart';
import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import 'app_lock.dart';

/// Wraps the whole app (installed via [MaterialApp.builder], so it sits above the
/// navigator and covers every route). Two protections:
///
///  * a **privacy cover** that hides content whenever the app is inactive or
///    backgrounded, so the app-switcher snapshot never leaks the transcript;
///  * a **lock screen** that requires Face ID before the UI can be used.
///
/// Both only apply once the phone is paired — an unpaired app has nothing to
/// protect and shouldn't nag for Face ID.
class AppLockGate extends ConsumerStatefulWidget {
  const AppLockGate({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<AppLockGate> createState() => _AppLockGateState();
}

class _AppLockGateState extends ConsumerState<AppLockGate>
    with WidgetsBindingObserver {
  AppLifecycleState _lifecycle = AppLifecycleState.resumed;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    setState(() => _lifecycle = state);
    final controller = ref.read(appLockProvider.notifier);
    switch (state) {
      case AppLifecycleState.inactive:
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
        controller.onBackgrounded();
      case AppLifecycleState.resumed:
        controller.onResumed();
        _maybePrompt();
      case AppLifecycleState.detached:
        break;
    }
  }

  /// Kick off a Face ID prompt if we're locked and actually in the foreground.
  void _maybePrompt() {
    if (_lifecycle != AppLifecycleState.resumed) return;
    final lock = ref.read(appLockProvider);
    if (lock.locked && !lock.authInProgress) {
      ref.read(appLockProvider.notifier).authenticate(automatic: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final paired = ref.watch(pairingProvider).valueOrNull != null;
    if (!paired) return widget.child;

    final settings =
        ref.watch(settingsProvider).valueOrNull ?? const AppSettings();
    // Keep the controller in sync with the latest preferences.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        ref.read(appLockProvider.notifier).applySettings(settings);
      }
    });

    final lock = ref.watch(appLockProvider);

    // Auto-prompt as soon as we render locked in the foreground (e.g. cold
    // start), so Face ID appears without the user tapping first.
    if (settings.appLockEnabled && lock.locked && !lock.authInProgress) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _maybePrompt());
    }

    final showLock = settings.appLockEnabled && lock.locked;
    final showPrivacyCover = settings.appLockEnabled &&
        !showLock &&
        _lifecycle != AppLifecycleState.resumed;

    return Stack(
      children: [
        widget.child,
        if (showPrivacyCover) const _PrivacyCover(),
        if (showLock) LockScreen(authInProgress: lock.authInProgress),
      ],
    );
  }
}

/// Opaque branded cover shown while the app is inactive/backgrounded so the OS
/// snapshot doesn't reveal the underlying content.
class _PrivacyCover extends StatelessWidget {
  const _PrivacyCover();

  @override
  Widget build(BuildContext context) {
    return const _LockBackdrop(child: SizedBox.expand());
  }
}

/// Full-screen lock UI with a manual "Unlock with Face ID" action. Auto-prompts
/// are driven by [AppLockGate]; this is the fallback when the user cancels.
class LockScreen extends ConsumerWidget {
  const LockScreen({super.key, required this.authInProgress});

  final bool authInProgress;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    return _LockBackdrop(
      child: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.lock_outline,
                  size: 56, color: theme.colorScheme.primary),
              SizedBox(height: 20),
              Text('Panda Code is locked', style: theme.textTheme.titleLarge),
              const SizedBox(height: 8),
              Text(
                'Authenticate to continue.',
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: context.tokens.muted),
              ),
              const SizedBox(height: 28),
              FilledButton.icon(
                onPressed: authInProgress
                    ? null
                    : () => ref.read(appLockProvider.notifier).authenticate(),
                icon: authInProgress
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.face),
                label: Text(authInProgress ? 'Authenticating…' : 'Unlock'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Opaque backdrop shared by the privacy cover and the lock screen — its own
/// [Material] so it renders correctly above the navigator.
class _LockBackdrop extends StatelessWidget {
  const _LockBackdrop({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).scaffoldBackgroundColor,
      child: child,
    );
  }
}
