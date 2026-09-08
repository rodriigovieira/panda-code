import 'dart:convert';

import 'package:crypto/crypto.dart' show sha256;
import 'package:flutter/services.dart';

const commandAuthDomain = 'panda-code/command-auth/v3';

class CommandIdentity {
  static const _channel = MethodChannel('panda_code/command_identity');

  final String keyId;
  final String publicKeyBase64;
  final String protection;

  const CommandIdentity({
    required this.keyId,
    required this.publicKeyBase64,
    required this.protection,
  });

  static Future<CommandIdentity> loadOrCreate() async {
    final value =
        await _channel.invokeMapMethod<String, dynamic>('loadOrCreate');
    if (value == null ||
        value['keyId'] is! String ||
        value['publicKey'] is! String ||
        value['protection'] is! String) {
      throw StateError('This device cannot create a command signing identity.');
    }
    return CommandIdentity(
      keyId: value['keyId'] as String,
      publicKeyBase64: value['publicKey'] as String,
      protection: value['protection'] as String,
    );
  }

  Future<String> sign(String message) async {
    final signature = await _channel.invokeMethod<String>('sign', {
      'keyId': keyId,
      'message': base64Encode(utf8.encode(message)),
      'reason': 'Authorize this command for your Mac',
    });
    if (signature == null || signature.isEmpty) {
      throw StateError('The command signature was not produced.');
    }
    return signature;
  }

  static String payloadCanonical(Object? value) => _canonicalJson(value);

  static String payloadDigest(String canonical) =>
      sha256.convert(utf8.encode(canonical)).toString();

  static String signingMessage({
    required String id,
    required String deviceId,
    required String mobileId,
    required String? sessionId,
    required String type,
    required int issuedAt,
    required int expiresAt,
    required String payloadDigest,
  }) =>
      jsonEncode([
        commandAuthDomain,
        id,
        deviceId,
        mobileId,
        sessionId,
        type,
        issuedAt,
        expiresAt,
        payloadDigest,
      ]);
}

String _canonicalJson(Object? value) {
  if (value == null || value is bool || value is String || value is num) {
    if (value is double && !value.isFinite) {
      throw ArgumentError('Command payload contains a non-finite number.');
    }
    return jsonEncode(value);
  }
  if (value is List) {
    return '[${value.map(_canonicalJson).join(',')}]';
  }
  if (value is Map) {
    final entries = value.entries
        .map((entry) => MapEntry(entry.key.toString(), entry.value))
        .toList()
      ..sort((a, b) => a.key.compareTo(b.key));
    return '{${entries.map((entry) => '${jsonEncode(entry.key)}:${_canonicalJson(entry.value)}').join(',')}}';
  }
  throw ArgumentError('Command payload is not JSON-compatible.');
}
