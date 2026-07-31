import 'package:flutter/services.dart';
import 'package:local_auth/local_auth.dart';

/// Thin wrapper over [LocalAuthentication] that never throws: every entry point
/// resolves to a plain bool so the lock UI can stay simple.
class BiometricAuth {
  static final LocalAuthentication _auth = LocalAuthentication();

  /// Whether this device can authenticate the user at all — biometrics enrolled
  /// or a device passcode set. Used to decide if the lock feature is offerable.
  static Future<bool> isAvailable() async {
    try {
      return await _auth.isDeviceSupported();
    } on PlatformException {
      return false;
    }
  }

  /// Prompt for Face ID (falling back to the device passcode). Returns true only
  /// on a successful authentication; any failure or cancellation returns false.
  static Future<bool> authenticate() async {
    try {
      return await _auth.authenticate(
        localizedReason: 'Unlock Panda Code',
        options: const AuthenticationOptions(
          stickyAuth: true,
          // Allow the device passcode as a fallback so the user can never be
          // permanently locked out if Face ID fails.
          biometricOnly: false,
        ),
      );
    } on PlatformException {
      return false;
    }
  }
}
