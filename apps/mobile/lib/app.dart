import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'notifications/push_notifications.dart';
import 'pairing/pairing_screen.dart';
import 'security/app_lock_gate.dart';
import 'sessions/models.dart';
import 'sessions/session_list_screen.dart';
import 'sessions/session_view_screen.dart';
import 'sessions/settings_store.dart';
import 'state/providers.dart';
import 'theme/panda_theme.dart';
import 'widgets/toast/panda_toast.dart';
import 'widgets/toast/toast_overlay.dart';

final pandaCodeNavigatorKey = GlobalKey<NavigatorState>();

class PandaCodeApp extends ConsumerStatefulWidget {
  const PandaCodeApp({super.key});

  @override
  ConsumerState<PandaCodeApp> createState() => _PandaCodeAppState();
}

class _PandaCodeAppState extends ConsumerState<PandaCodeApp> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      PushNotifications.configureTapHandler(_openNotificationSession);
    });
  }

  Future<void> _openNotificationSession(PushNotificationTap tap) async {
    final sessionId = tap.sessionId.trim();
    if (sessionId.isEmpty) return;

    try {
      final creds = await ref.read(pairingProvider.future);
      if (!mounted || creds == null) return;

      final api = await ref.read(relayApiProvider.future);
      if (!mounted || api == null) return;

      final rows = await api.listSessions();
      if (!mounted) return;

      final row = _findSession(rows, sessionId);
      if (row == null) {
        showToast('Session no longer available', variant: ToastVariant.warning);
        return;
      }

      final aliases = await ref.read(sessionAliasesProvider.future);
      if (!mounted) return;

      final alias = aliases[row.sessionId];
      final display =
          alias != null && alias.isNotEmpty ? row.copyWith(title: alias) : row;
      pandaCodeNavigatorKey.currentState?.push(
        MaterialPageRoute(builder: (_) => SessionViewScreen(row: display)),
      );
    } on Object catch (error) {
      debugPrint('Notification session open failed: $error');
      showToast('Could not open session from notification.',
          variant: ToastVariant.error);
    }
  }

  SessionRow? _findSession(List<SessionRow> rows, String sessionId) {
    for (final row in rows) {
      if (row.sessionId == sessionId) return row;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final settings =
        ref.watch(settingsProvider).valueOrNull ?? const AppSettings();
    final density = settings.compactDensity
        ? VisualDensity.compact
        : VisualDensity.adaptivePlatformDensity;
    final motion =
        settings.reduceMotion ? const _NoAnimationPageTransitionsTheme() : null;
    // The accent setting no longer seeds the whole scheme — it repaints the accent
    // group only, leaving surfaces and status colours to the shared design system.
    // Left at its default it resolves to brass, so most users see the system as
    // designed. See _deriveAccent in panda_theme.dart.
    final accent = settings.accentColor == AppSettings.defaultAccentColor
        ? null
        : Color(settings.accentColor);

    ThemeData themed(Brightness b) => buildPandaTheme(
          brightness: b,
          density: density,
          pageTransitions: motion,
          accentOverride: accent,
        );

    return MaterialApp(
      navigatorKey: pandaCodeNavigatorKey,
      title: 'Panda Code',
      debugShowCheckedModeBanner: false,
      themeMode: switch (settings.themeMode) {
        AppThemeMode.system => ThemeMode.system,
        AppThemeMode.light => ThemeMode.light,
        AppThemeMode.dark => ThemeMode.dark,
      },
      theme: themed(Brightness.light),
      darkTheme: themed(Brightness.dark),
      // The lock gate wraps the navigator so it covers every pushed route.
      // The toast overlay sits below the gate (so a locked screen hides
      // toasts) but above all app content, floating cards at the top.
      builder: (context, child) => AppLockGate(
        child: ToastOverlay(child: child ?? const SizedBox.shrink()),
      ),
      home: const _Root(),
    );
  }
}

/// Disables route transition animations when "reduce motion" is on.
class _NoAnimationPageTransitionsTheme extends PageTransitionsTheme {
  const _NoAnimationPageTransitionsTheme();

  @override
  Widget buildTransitions<T>(
          route, context, animation, secondaryAnimation, Widget child) =>
      child;
}

/// Routes on pairing state: not paired → QR scan; paired → session list.
class _Root extends ConsumerWidget {
  const _Root();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pairing = ref.watch(pairingProvider);
    return pairing.when(
      loading: () =>
          const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (e, _) => Scaffold(body: Center(child: Text('Startup error: $e'))),
      data: (creds) =>
          creds == null ? const PairingScreen() : const SessionListScreen(),
    );
  }
}
