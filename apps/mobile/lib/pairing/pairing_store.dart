import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persisted pairing credentials use OS-backed Keychain / Keystore storage
/// via flutter_secure_storage, not plain preferences or hardware-isolated memory.
class PairingCredentials {
  final String url;
  final String deviceId;
  final String mobileId;
  final String mobileToken;
  final String keyBase64;
  final int? commandAuthVersion;

  const PairingCredentials({
    required this.url,
    required this.deviceId,
    required this.mobileId,
    required this.mobileToken,
    required this.keyBase64,
    this.commandAuthVersion,
  });
}

class PairingStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
      synchronizable: false,
    ),
  );

  static const _kUrl = 'pc.url';
  static const _kDeviceId = 'pc.deviceId';
  static const _kMobileId = 'pc.mobileId';
  static const _kMobileToken = 'pc.mobileToken';
  static const _kKey = 'pc.k';
  static const _kCommandAuthVersion = 'pc.commandAuthVersion';

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
      commandAuthVersion: int.tryParse(all[_kCommandAuthVersion] ?? ''),
    );
  }

  Future<void> save(PairingCredentials c) async {
    await _storage.write(key: _kUrl, value: c.url);
    await _storage.write(key: _kDeviceId, value: c.deviceId);
    await _storage.write(key: _kMobileId, value: c.mobileId);
    await _storage.write(key: _kMobileToken, value: c.mobileToken);
    await _storage.write(key: _kKey, value: c.keyBase64);
    if (c.commandAuthVersion != null) {
      await _storage.write(
          key: _kCommandAuthVersion, value: '${c.commandAuthVersion}');
    } else {
      await _storage.delete(key: _kCommandAuthVersion);
    }
  }

  Future<void> clear() => _storage.deleteAll();
}
