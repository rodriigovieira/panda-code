import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Locally-persisted path of the desktop's scratch ("No project") workspace
/// folder. Remembered the first time a session with that `cwd` is seen, so
/// the "No project" group can keep rendering (empty) after that session ends,
/// is archived, or is filtered out — and across app restarts. Mirrors the
/// desktop's own `localStorage` cache of `ensureScratchWorkspace()`. Device-
/// local like pins/aliases/workspace order, not synced through the relay.
class ScratchWorkspaceStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _key = 'pc.scratchWorkspacePath';

  Future<String?> load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null || raw.trim().isEmpty) return null;
    return raw;
  }

  Future<void> save(String path) async {
    await _storage.write(key: _key, value: path);
  }
}
