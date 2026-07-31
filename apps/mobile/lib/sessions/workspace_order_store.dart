import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Locally-persisted manual order of workspace names. Like pins and aliases,
/// this is a device-local preference (kept separate from session activity) so
/// workspaces hold their place instead of reshuffling to the top on every new
/// event. It is not synced through the relay.
class WorkspaceOrderStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _key = 'pc.workspaceOrder';

  Future<List<String>> load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null || raw.isEmpty) return const <String>[];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        return decoded.whereType<String>().toList();
      }
    } catch (_) {
      // Corrupt value — treat as empty rather than crashing the list.
    }
    return const <String>[];
  }

  Future<void> save(List<String> names) async {
    await _storage.write(key: _key, value: jsonEncode(names));
  }
}
