import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:video_player/video_player.dart';

import '../../state/providers.dart';
import '../remote_media_store.dart';

/// A capture's own filename (plus its immediate parent, for a recording's
/// `recording-<tab>-<ts>/recording.mp4` shape) is unique enough to key the
/// on-device cache without carrying the whole absolute path as a filename.
String _cacheKey(String path) {
  final segments = path.split('/').where((s) => s.isNotEmpty).toList();
  final tail = segments.length >= 2
      ? segments.sublist(segments.length - 2).join('_')
      : (segments.isEmpty ? path : segments.last);
  return tail.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
}

/// Open the phone's viewer for a `browser_screenshot`/`browser_record`
/// capture, fetching it from the desktop (via the relay) if it isn't already
/// cached on this device.
Future<void> openBrowserMedia(
  BuildContext context, {
  required String sessionId,
  required String path,
  required bool isVideo,
}) {
  return Navigator.of(context).push<void>(
    MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) =>
          MediaViewerScreen(sessionId: sessionId, path: path, isVideo: isVideo),
    ),
  );
}

class MediaViewerScreen extends ConsumerStatefulWidget {
  const MediaViewerScreen({
    super.key,
    required this.sessionId,
    required this.path,
    required this.isVideo,
    this.title,
    this.inline = false,
  });

  /// Null for media that belongs to no session — a backlog card's evidence.
  /// The desktop reads the file by [path] either way; the id only scopes the
  /// command row on the relay.
  final String? sessionId;
  final String path;
  final bool isVideo;

  /// Bar title. Falls back to the generic "Screenshot"/"Recording" the
  /// browser-capture flow has always shown.
  final String? title;

  /// Embedded evidence preview; videos load only when explicitly played.
  final bool inline;

  @override
  ConsumerState<MediaViewerScreen> createState() => _MediaViewerScreenState();
}

class _MediaViewerScreenState extends ConsumerState<MediaViewerScreen> {
  bool _loading = true;
  bool _started = false;
  String? _error;
  Uint8List? _bytes;

  /// What the desktop said the bytes are. Only consulted for a video's
  /// temp-file suffix — AVPlayer sniffs by extension, and a `.mov` written as
  /// `.mp4` plays by luck rather than by contract.
  String _mimeType = '';

  @override
  void initState() {
    super.initState();
    if (!widget.inline || !widget.isVideo) _load();
  }

  Future<void> _load() async {
    setState(() {
      _started = true;
      _loading = true;
      _error = null;
    });
    final key = _cacheKey(widget.path);
    try {
      final cached = await RemoteMediaStore.get(key);
      if (cached != null) {
        if (!mounted) return;
        setState(() {
          _bytes = cached.bytes;
          _mimeType = cached.mimeType;
          _loading = false;
        });
        return;
      }

      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final requested =
          await api.requestMedia(widget.sessionId, path: widget.path);
      final bytes = await api.fetchMedia(requested.storageId);
      unawaited(RemoteMediaStore.put(key, requested.mimeType, bytes));
      if (!mounted) return;
      setState(() {
        _bytes = bytes;
        _mimeType = requested.mimeType;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '$error'.replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final content = Center(
      child: !_started && widget.inline && widget.isVideo
          ? TextButton.icon(
              onPressed: _load,
              icon: const Icon(Icons.play_circle_outline, size: 40),
              label: const Text('Play recording'),
            )
          : _loading
              ? const CircularProgressIndicator(color: Colors.white)
              : _error != null
                  ? _ErrorState(message: _error!, onRetry: _load)
                  : widget.isVideo
                      ? _VideoView(
                          bytes: _bytes!, suffix: _videoSuffix(_mimeType))
                      : Image.memory(
                          _bytes!,
                          fit: BoxFit.contain,
                          errorBuilder: (_, __, ___) => _ErrorState(
                            message: 'Unable to display this image.',
                            onRetry: _load,
                          ),
                        ),
    );
    if (widget.inline) {
      return ColoredBox(color: Colors.black, child: content);
    }
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title:
            Text(widget.title ?? (widget.isVideo ? 'Recording' : 'Screenshot')),
      ),
      body: SafeArea(
        child: widget.isVideo || _loading || _error != null
            ? content
            : InteractiveViewer(minScale: 1, maxScale: 6, child: content),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, color: Colors.white70, size: 32),
          const SizedBox(height: 12),
          Text(message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white70)),
          const SizedBox(height: 16),
          OutlinedButton(
            onPressed: onRetry,
            style: OutlinedButton.styleFrom(foregroundColor: Colors.white),
            child: const Text('Try again'),
          ),
        ],
      ),
    );
  }
}

String _videoSuffix(String mimeType) => switch (mimeType) {
      'video/quicktime' => '.mov',
      'video/webm' => '.webm',
      _ => '.mp4',
    };

class _VideoView extends StatefulWidget {
  const _VideoView({required this.bytes, this.suffix = '.mp4'});

  final Uint8List bytes;
  final String suffix;

  @override
  State<_VideoView> createState() => _VideoViewState();
}

class _VideoViewState extends State<_VideoView> {
  VideoPlayerController? _controller;
  String? _error;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      final dir = await getTemporaryDirectory();
      final file = File(
          '${dir.path}/panda-media-${DateTime.now().microsecondsSinceEpoch}${widget.suffix}');
      await file.writeAsBytes(widget.bytes, flush: true);
      final controller = VideoPlayerController.file(file);
      await controller.initialize();
      if (!mounted) {
        await controller.dispose();
        return;
      }
      setState(() => _controller = controller);
      await controller.play();
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = '$error');
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (_error != null) {
      return _ErrorState(
          message: _error!,
          onRetry: () {
            setState(() => _error = null);
            _init();
          });
    }
    if (controller == null || !controller.value.isInitialized) {
      return const CircularProgressIndicator(color: Colors.white);
    }
    return AspectRatio(
      aspectRatio: controller.value.aspectRatio,
      child: GestureDetector(
        onTap: () => setState(
          () => controller.value.isPlaying
              ? controller.pause()
              : controller.play(),
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            VideoPlayer(controller),
            if (!controller.value.isPlaying)
              Container(
                decoration: const BoxDecoration(
                    color: Colors.black38, shape: BoxShape.circle),
                padding: const EdgeInsets.all(12),
                child:
                    const Icon(Icons.play_arrow, color: Colors.white, size: 40),
              ),
          ],
        ),
      ),
    );
  }
}
