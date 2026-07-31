import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persisted pairing credentials. The E2E key lives in the OS secure enclave
/// (Keychain / Keystore) via flutter_secure_storage — never in plain prefs.
class PairingCredentials {
  final String url;
  final String deviceId;
  final String mobileId;
  final String mobileToken;
  final String keyBase64;

  const PairingCredentials({
    required this.url,
    required this.deviceId,
    required this.mobileId,
    required this.mobileToken,
    required this.keyBase64,
  });
}

class PairingStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _kUrl = 'pc.url';
  static const _kDeviceId = 'pc.deviceId';
  static const _kMobileId = 'pc.mobileId';
  static const _kMobileToken = 'pc.mobileToken';
  static const _kKey = 'pc.k';

  Future<PairingCredentials?> load() async {
    final all = await _storage.readAll();
    final url = all[_kUrl];
    final deviceId = all[_kDeviceId];
    final mobileId = all[_kMobileId];
    final token = all[_kMobileToken];
    final key = all[_kKey];
    if (url == null ||
        deviceId == null ||
        mobileId == null ||
        token == null ||
        key == null) {
      return null;
    }
    return PairingCredentials(
      url: url,
      deviceId: deviceId,
      mobileId: mobileId,
      mobileToken: token,
      keyBase64: key,
    );
  }

  Future<void> save(PairingCredentials c) async {
    await _storage.write(key: _kUrl, value: c.url);
    await _storage.write(key: _kDeviceId, value: c.deviceId);
    await _storage.write(key: _kMobileId, value: c.mobileId);
    await _storage.write(key: _kMobileToken, value: c.mobileToken);
    await _storage.write(key: _kKey, value: c.keyBase64);
  }

  Future<void> clear() => _storage.deleteAll();
}
