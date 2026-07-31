import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/crypto/e2e.dart';

/// E2E envelope tests (docs/protocol.md §3). The deterministic vector is the
/// cross-language reconciliation point — the desktop's tweetnacl implementation
/// MUST produce the identical envelope for the same key + nonce + plaintext, and
/// each side must open the other's. Prompt 4 wires that CI check; here we lock
/// the shape and prove round-tripping.
void main() {
  final key = Uint8List.fromList(List<int>.generate(32, (i) => i + 1));
  final nonce = Uint8List.fromList(List<int>.generate(24, (i) => 100 + i));

  test('seal → open round-trips (random nonce)', () {
    final codec = E2ECodec(key);
    final payload = {'data': 'olá 🐼', 'n': 42, 'nested': {'ok': true}};
    final envelope = codec.seal(payload);
    expect(codec.open(envelope), payload);
  });

  test('two seals of the same value differ (fresh nonce each time)', () {
    final codec = E2ECodec(key);
    expect(codec.seal('x') == codec.seal('x'), isFalse);
  });

  test('deterministic vector: nonce is the 24-byte prefix, opens cleanly', () {
    final codec = E2ECodec(key);
    final envelope = codec.seal({'hello': 'world'}, nonce: nonce);
    final bytes = base64Decode(envelope);
    expect(bytes.sublist(0, 24), nonce);
    expect(codec.open(envelope), {'hello': 'world'});
  });

  test('fromBase64Key matches raw-key codec', () {
    final a = E2ECodec(key);
    final b = E2ECodec.fromBase64Key(base64Encode(key));
    final envelope = a.seal({'v': 1}, nonce: nonce);
    expect(b.open(envelope), {'v': 1});
  });
}
