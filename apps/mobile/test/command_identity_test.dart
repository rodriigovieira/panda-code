import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/security/command_identity.dart';

void main() {
  test('canonical payload sorts maps recursively without reordering arrays',
      () {
    final vector =
        (jsonDecode(File('../../docs/crypto-vectors.json').readAsStringSync())
            as Map)['commandSignatureVector'] as Map;
    final canonical = CommandIdentity.payloadCanonical(vector['payload']);
    expect(canonical, vector['payloadCanonical']);
    expect(CommandIdentity.payloadDigest(canonical), vector['payloadDigest']);
  });

  test('signing context has the cross-language fixed field order', () {
    expect(
      CommandIdentity.signingMessage(
        id: 'command-id',
        deviceId: 'device-id',
        mobileId: 'mobile-id',
        sessionId: null,
        type: 'stop',
        issuedAt: 1000,
        expiresAt: 2000,
        payloadDigest: 'abc',
      ),
      '["panda-code/command-auth/v3","command-id","device-id","mobile-id",null,"stop",1000,2000,"abc"]',
    );
  });
}
