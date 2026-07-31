import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Remembers, per session, how far the user had scrolled the transcript so
/// reopening a session lands where they left off instead of always snapping to
/// the bottom. Device-local only (never synced through the relay). Writes are
/// debounced by the caller; reads are best-effort.
class ScrollPositionStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static String _key(String sessionId) => 'scroll_offset_$sessionId';

  /// Saved pixel offset for [sessionId], or null if none / at bottom.
  static Future<double?> read(String sessionId) async {
    final raw = await _storage.read(key: _key(sessionId));
    return raw == null ? null : double.tryParse(raw);
  }

  static Future<void> write(String sessionId, double offset) =>
      _storage.write(key: _key(sessionId), value: offset.toStringAsFixed(1));

  /// Clears the saved offset — used when the user is pinned to the bottom, so
  /// the next open follows the live tail instead of restoring a stale position.
  static Future<void> clear(String sessionId) =>
      _storage.delete(key: _key(sessionId));
}
