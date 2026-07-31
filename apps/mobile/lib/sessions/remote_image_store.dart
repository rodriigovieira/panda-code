import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'models.dart';

/// On-device cache of image attachments the user sent from this phone.
///
/// The relay never carries image bytes back to us: the desktop saves them to
/// its own disk and only forwards the message text (with file paths embedded),
/// so an image-only user message would otherwise reload as an empty bubble.
/// We keep our own copy keyed by the image's [ConversationImage.id] — the same
/// id the desktop uses as its saved-file stem — so we can re-hydrate thumbnails
/// by parsing those ids out of the round-tripped message body.
///
/// Device-local only (never synced through the relay). Each image is two files:
/// `<id>.bin` (raw bytes) and `<id>.json` (`{sessionId, name, mimeType}`).
class RemoteImageStore {
  RemoteImageStore._();

  /// Keep the cache bounded — evict the oldest images once we cross this many.
  /// Sent screenshots are modest, so this is generous; it just guards against
  /// unbounded growth over a device's lifetime.
  static const _maxImages = 400;

  static Directory? _dir;

  static Future<Directory> _directory() async {
    final cached = _dir;
    if (cached != null) return cached;
    final base = await getApplicationSupportDirectory();
    final dir = Directory('${base.path}/remote_images');
    if (!await dir.exists()) await dir.create(recursive: true);
    return _dir = dir;
  }

  /// Persist [image] for [sessionId]. Best-effort: failures are swallowed so a
  /// full disk never blocks a send.
  static Future<void> put(String sessionId, ConversationImage image) async {
    try {
      final dir = await _directory();
      await File('${dir.path}/${image.id}.bin')
          .writeAsBytes(image.bytes, flush: true);
      await File('${dir.path}/${image.id}.json').writeAsString(
        jsonEncode({
          'sessionId': sessionId,
          'name': image.name,
          'mimeType': image.mimeType,
        }),
      );
      unawaited(_prune(dir));
    } catch (_) {
      // Caching is a best-effort nicety, not a correctness requirement.
    }
  }

  /// Load every stored image for [sessionId], keyed by image id.
  static Future<Map<String, ConversationImage>> loadSession(
      String sessionId) async {
    final out = <String, ConversationImage>{};
    try {
      final dir = await _directory();
      await for (final entry in dir.list()) {
        if (entry is! File || !entry.path.endsWith('.json')) continue;
        try {
          final meta =
              jsonDecode(await entry.readAsString()) as Map<String, dynamic>;
          if (meta['sessionId'] != sessionId) continue;
          final id = entry.uri.pathSegments.last.replaceFirst('.json', '');
          final bin = File('${dir.path}/$id.bin');
          if (!await bin.exists()) continue;
          out[id] = ConversationImage(
            id: id,
            name: meta['name'] as String? ?? 'image',
            mimeType: meta['mimeType'] as String? ?? 'image/png',
            bytes: await bin.readAsBytes(),
          );
        } catch (_) {
          // Skip a corrupt/partial record rather than failing the whole load.
        }
      }
    } catch (_) {}
    return out;
  }

  /// Evict oldest images (by modified time) once the cache exceeds [_maxImages].
  static Future<void> _prune(Directory dir) async {
    try {
      final metas = <File>[];
      await for (final entry in dir.list()) {
        if (entry is File && entry.path.endsWith('.json')) metas.add(entry);
      }
      if (metas.length <= _maxImages) return;
      final stamped = <(DateTime, File)>[];
      for (final f in metas) {
        stamped.add((await f.lastModified(), f));
      }
      stamped.sort((a, b) => a.$1.compareTo(b.$1));
      for (final (_, meta) in stamped.take(metas.length - _maxImages)) {
        final id = meta.uri.pathSegments.last.replaceFirst('.json', '');
        await meta.delete().catchError((_) => meta);
        final bin = File('${dir.path}/$id.bin');
        if (await bin.exists()) await bin.delete().catchError((_) => bin);
      }
    } catch (_) {}
  }
}
