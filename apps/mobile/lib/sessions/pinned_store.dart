import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Locally cached set of pinned session ids. The relay is the sync source for
/// new pin/star changes; this cache preserves legacy/offline pins.
class PinnedStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _key = 'pc.pinnedSessions';

  Future<Set<String>> load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null || raw.isEmpty) return <String>{};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        return decoded.whereType<String>().toSet();
      }
    } catch (_) {
      // Corrupt value — treat as empty rather than crashing the list.
    }
    return <String>{};
  }

  Future<void> save(Set<String> ids) async {
    await _storage.write(key: _key, value: jsonEncode(ids.toList()));
  }
}
