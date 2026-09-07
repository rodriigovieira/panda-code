import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Remembers, per session, how far the user had scrolled the transcript so
/// reopening a session lands where they left off instead of always snapping to
/// the bottom. Device-local only (never synced through the relay). Writes are
/// debounced by the caller; reads are best-effort.
///
/// The offset is measured **from the bottom** of the transcript, which is what
/// the reversed list scrolls in. That also makes it survive history loading:
/// an offset measured from the top means something different the moment an
/// older page is prepended, whereas the distance back from the newest message
/// is stable no matter how much history arrives later.
class ScrollPositionStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// Deliberately not the old `scroll_offset_` key: those values were measured
  /// from the top, so restoring one here would land somewhere arbitrary.
  /// Renaming retires them instead of misreading them.
  static String _key(String sessionId) => 'scroll_from_bottom_$sessionId';

  /// Saved distance from the bottom for [sessionId], or null if none / at bottom.
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
