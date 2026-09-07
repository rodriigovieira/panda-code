import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart' show Hmac, sha256;

import 'package:pinenacl/x25519.dart' show SecretBox, EncryptedMessage;

/// End-to-end envelope per docs/protocol.md §3.
///
/// Wire format for every `*Cipher` field:
///
///     base64( nonce(24) || secretbox(plaintext, nonce, k) )
///
/// Cipher = XSalsa20-Poly1305 (NaCl `crypto_secretbox`). `k` is the 32-byte
/// symmetric key exchanged out-of-band via the pairing QR. This MUST interoperate
/// byte-for-byte with the desktop's tweetnacl/libsodium implementation — see the
/// reconciliation vector in docs/crypto-vectors.json.
class E2ECodec {
  final SecretBox _box;
  final Uint8List _key;

  E2ECodec(Uint8List key) : _box = SecretBox(key), _key = Uint8List.fromList(key);

  /// Build a codec from the base64 key carried in the pairing QR (`k`).
  factory E2ECodec.fromBase64Key(String base64Key) =>
      E2ECodec(base64Decode(base64Key));

  /// Encrypt a JSON-serializable value → base64 envelope. Uses a fresh random
  /// nonce (pinenacl generates it); pass [nonce] only for deterministic tests.
  String seal(Object? value, {Uint8List? nonce}) {
    final plaintext = Uint8List.fromList(utf8.encode(jsonEncode(value)));
    final encrypted = _box.encrypt(plaintext, nonce: nonce);
    // `encrypted` is already nonce(24) || cipherText.
    return base64Encode(Uint8List.fromList(encrypted));
  }

  String sealCommand(Object? envelope, {Uint8List? nonce}) {
    final key = Hmac(sha256, _key).convert(utf8.encode('panda-code/command/v2')).bytes;
    return E2ECodec(Uint8List.fromList(key)).seal(envelope, nonce: nonce);
  }

  /// Decrypt a base64 envelope → decoded JSON value.
  dynamic open(String envelope) {
    final bytes = base64Decode(envelope);
    final message = EncryptedMessage.fromList(bytes);
    final plain = _box.decrypt(message);
    return jsonDecode(utf8.decode(plain));
  }

  /// Decrypt to a typed map (convenience for object payloads).
  Map<String, dynamic> openMap(String envelope) =>
      Map<String, dynamic>.from(open(envelope) as Map);
}
