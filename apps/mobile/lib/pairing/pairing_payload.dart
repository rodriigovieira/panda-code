import 'dart:convert';

/// The QR payload the desktop renders (docs/protocol.md §2). The E2E key `k`
/// travels ONLY here — it is never sent to Convex.
class PairingPayload {
  final String url; // Convex deployment URL
  final String deviceId;
  final String code; // single-use pairing code
  final String keyBase64; // `k` — 32-byte E2E symmetric key, base64

  const PairingPayload({
    required this.url,
    required this.deviceId,
    required this.code,
    required this.keyBase64,
  });

  /// Parse a scanned QR string. Expected JSON: {url, deviceId, code, k}.
  static PairingPayload parse(String raw) {
    final json = jsonDecode(raw) as Map<String, dynamic>;
    final url = json['url'] as String?;
    final deviceId = json['deviceId'] as String?;
    final code = json['code'] as String?;
    final k = json['k'] as String?;
    if (url == null || deviceId == null || code == null || k == null) {
      throw const FormatException(
          'Invalid pairing QR: missing url/deviceId/code/k');
    }
    return PairingPayload(
        url: url, deviceId: deviceId, code: code, keyBase64: k);
  }
}
