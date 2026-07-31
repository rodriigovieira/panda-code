import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../pairing/pairing_store.dart';
import '../relay/relay_client.dart';

class PushNotificationTap {
  const PushNotificationTap({required this.sessionId, this.type});

  final String sessionId;
  final String? type;

  static PushNotificationTap? fromPayload(Object? raw) {
    if (raw is! Map) return null;
    final payload = Map<Object?, Object?>.from(raw);
    final sessionId = payload['sessionId'];
    if (sessionId is! String || sessionId.trim().isEmpty) return null;
    final type = payload['type'];
    return PushNotificationTap(
      sessionId: sessionId,
      type: type is String ? type : null,
    );
  }
}

class PushNotifications {
  static const _channel = MethodChannel('panda_code/apns');
  static Future<void> Function(PushNotificationTap tap)? _onTap;

  static Future<void> configureTapHandler(
    Future<void> Function(PushNotificationTap tap) onTap,
  ) async {
    _onTap = onTap;
    _channel.setMethodCallHandler((call) async {
      if (call.method != 'notificationTapped') {
        throw MissingPluginException('Unknown APNs method ${call.method}');
      }
      await _handleTapPayload(call.arguments);
    });

    if (!Platform.isIOS) return;
    try {
      await _handleTapPayload(
        await _channel.invokeMethod<Object?>('takePendingNotificationTap'),
      );
    } on Object catch (error) {
      debugPrint('APNs pending notification read skipped: $error');
    }
  }

  static Future<void> registerForPairing(PairingCredentials creds) async {
    if (!Platform.isIOS) return;

    try {
      final apnsToken = await _channel.invokeMethod<String>('register');
      if (apnsToken == null || apnsToken.isEmpty) return;
      await _registerToken(creds, apnsToken);
    } on Object catch (error) {
      debugPrint('APNs registration skipped: $error');
    }
  }

  static Future<void> reset() async {
    // APNs tokens are app/device scoped. Nothing local needs to be torn down
    // when a relay pairing is cleared.
  }

  static Future<void> _registerToken(
    PairingCredentials creds,
    String pushToken,
  ) async {
    try {
      final client = await RelayClient.ensureInitialized(creds.url);
      await client.mutation('notifications:registerPushToken', {
        'mobileId': creds.mobileId,
        'token': creds.mobileToken,
        'pushToken': pushToken,
        'platform': 'ios',
      });
    } on Object catch (error) {
      debugPrint('APNs token registration failed: $error');
    }
  }

  static Future<void> _handleTapPayload(Object? payload) async {
    final tap = PushNotificationTap.fromPayload(payload);
    if (tap == null) return;
    await _onTap?.call(tap);
  }
}
