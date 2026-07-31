import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/security/app_lock.dart';
import 'package:panda_code_mobile/sessions/settings_store.dart';

void main() {
  group('AutoLockDelay', () {
    test('immediate is the default fallback for unknown values', () {
      expect(AutoLockDelay.fromSeconds(null), AutoLockDelay.immediate);
      expect(AutoLockDelay.fromSeconds(42), AutoLockDelay.immediate);
      expect(AutoLockDelay.immediate.seconds, 0);
    });

    test('known second values round-trip to their enum', () {
      expect(AutoLockDelay.fromSeconds(300), AutoLockDelay.after5min);
      expect(AutoLockDelay.fromSeconds(3600), AutoLockDelay.after1hour);
    });
  });

  group('AppLockController', () {
    ProviderContainer container() {
      final c = ProviderContainer();
      addTearDown(c.dispose);
      return c;
    }

    test('starts locked at cold start', () {
      final c = container();
      expect(c.read(appLockProvider).locked, isTrue);
    });

    test('disabling the feature unlocks immediately', () {
      final c = container();
      c.read(appLockProvider.notifier).applySettings(
            const AppSettings(appLockEnabled: false),
          );
      expect(c.read(appLockProvider).locked, isFalse);
    });

    test('re-enabling does not force a lock mid-session', () {
      final c = container();
      final ctrl = c.read(appLockProvider.notifier);
      ctrl.applySettings(const AppSettings(appLockEnabled: false));
      expect(c.read(appLockProvider).locked, isFalse);
      // Turning it back on should not re-lock until the app is backgrounded.
      ctrl.applySettings(const AppSettings(appLockEnabled: true));
      expect(c.read(appLockProvider).locked, isFalse);
    });

    test('immediate delay re-locks when returning from background', () {
      final c = container();
      final ctrl = c.read(appLockProvider.notifier);
      // Get to an unlocked, enabled state.
      ctrl.applySettings(const AppSettings(appLockEnabled: false));
      ctrl.applySettings(const AppSettings(
        appLockEnabled: true,
        autoLockDelay: AutoLockDelay.immediate,
      ));
      expect(c.read(appLockProvider).locked, isFalse);

      ctrl.onBackgrounded();
      ctrl.onResumed();
      expect(c.read(appLockProvider).locked, isTrue);
    });
  });
}
