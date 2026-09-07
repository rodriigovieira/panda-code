import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

/// On-device cache of decrypted browser screenshots/recordings, keyed by the
/// relay's storage id (`RelayApi.requestMedia`'s answer).
///
/// The relay's blob is deleted an hour after upload (`MEDIA_BLOB_RETENTION_MS`
/// on the relay) — it exists only long enough for a phone mid-request to grab
/// it — so a second look at the same capture must come from here, not from
/// asking the desktop again. Same two-file shape as [RemoteImageStore]:
/// `<storageId>.bin` (raw bytes) + `<storageId>.json` (`{mimeType}`).
class RemoteMediaStore {
  RemoteMediaStore._();

  /// Recordings are much larger than the sent-attachment thumbnails
  /// [RemoteImageStore] caps at 400, so this cache stays smaller.
  static const _maxEntries = 60;

  static Directory? _dir;

  static Future<Directory> _directory() async {
    final cached = _dir;
    if (cached != null) return cached;
    final base = await getApplicationSupportDirectory();
    final dir = Directory('${base.path}/remote_media');
    if (!await dir.exists()) await dir.create(recursive: true);
    return _dir = dir;
  }

  /// Persist [bytes] under [storageId]. Best-effort: a full disk should not
  /// stop the viewer from showing what it already downloaded.
  static Future<void> put(String storageId, String mimeType, Uint8List bytes) async {
    try {
      final dir = await _directory();
      await File('${dir.path}/$storageId.bin').writeAsBytes(bytes, flush: true);
      await File('${dir.path}/$storageId.json').writeAsString(jsonEncode({'mimeType': mimeType}));
      unawaited(_prune(dir));
    } catch (_) {
      // Caching is a nicety, not a correctness requirement.
    }
  }

  /// Read a previously cached capture, or null if it was never fetched (or
  /// was pruned).
  static Future<({Uint8List bytes, String mimeType})?> get(String storageId) async {
    try {
      final dir = await _directory();
      final metaFile = File('${dir.path}/$storageId.json');
      final binFile = File('${dir.path}/$storageId.bin');
      if (!await metaFile.exists() || !await binFile.exists()) return null;
      final meta = jsonDecode(await metaFile.readAsString()) as Map<String, dynamic>;
      final mimeType = meta['mimeType'] as String? ?? 'application/octet-stream';
      return (bytes: await binFile.readAsBytes(), mimeType: mimeType);
    } catch (_) {
      return null;
    }
  }

  /// Evict oldest entries (by modified time) once the cache exceeds [_maxEntries].
  static Future<void> _prune(Directory dir) async {
    try {
      final metas = <File>[];
      await for (final entry in dir.list()) {
        if (entry is File && entry.path.endsWith('.json')) metas.add(entry);
      }
      if (metas.length <= _maxEntries) return;
      final stamped = <(DateTime, File)>[];
      for (final f in metas) {
        stamped.add((await f.lastModified(), f));
      }
      stamped.sort((a, b) => a.$1.compareTo(b.$1));
      for (final (_, meta) in stamped.take(metas.length - _maxEntries)) {
        final id = meta.uri.pathSegments.last.replaceFirst('.json', '');
        await meta.delete().catchError((_) => meta);
        final bin = File('${dir.path}/$id.bin');
        if (await bin.exists()) await bin.delete().catchError((_) => bin);
      }
    } catch (_) {}
  }
}
