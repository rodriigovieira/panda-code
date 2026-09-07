import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Locally cached set of archived (hidden) session ids. The relay is the sync
/// source for new archive/unarchive changes (mirrors [PinnedStore]'s
/// contract); this cache preserves legacy/offline archives. Archiving never
/// stops or deletes the session on the Mac — it just hides clutter from the
/// main list, on both devices.
class ArchiveStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _key = 'pc.archivedSessions';

  Future<Set<String>> load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null || raw.isEmpty) return <String>{};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) return decoded.whereType<String>().toSet();
    } catch (_) {
      // Corrupt value — treat as empty.
    }
    return <String>{};
  }

  Future<void> save(Set<String> ids) async {
    await _storage.write(key: _key, value: jsonEncode(ids.toList()));
  }
}
