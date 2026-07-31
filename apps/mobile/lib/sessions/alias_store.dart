import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Locally-persisted map of sessionId → custom title. Renaming is a device-local
/// view preference (like the desktop's manual thread titles) — it is not synced
/// through the relay, so no session content leaves the phone. The relay-provided
/// title still drives search/grouping fallbacks; this only overrides display.
class AliasStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _key = 'pc.sessionAliases';

  Future<Map<String, String>> load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null || raw.isEmpty) return <String, String>{};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        return decoded.map((k, v) => MapEntry('$k', '$v'))
          ..removeWhere((_, v) => v.trim().isEmpty);
      }
    } catch (_) {
      // Corrupt value — treat as empty rather than crashing the list.
    }
    return <String, String>{};
  }

  Future<void> save(Map<String, String> aliases) async {
    await _storage.write(key: _key, value: jsonEncode(aliases));
  }
}
