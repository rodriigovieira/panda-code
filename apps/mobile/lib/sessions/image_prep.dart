import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

/// Attachments are base64-encoded and sealed into a SINGLE relay command
/// document (`attachments: [...]` under one `payloadCipher`). Convex caps a
/// document at 1 MiB, and base64 inflates bytes ~4/3, so a raw photo or pasted
/// screenshot overflows the doc and the `commands:enqueue` mutation throws —
/// which is why attaching an image "just fails". We downscale + JPEG-compress
/// every attachment before it goes out.
///
/// Budget per image (~360 KB of JPEG): small enough that a couple of images
/// still share one document, large enough to stay legible and inside Claude's
/// 1568px vision sweet spot.
const int kMaxAttachmentBytes = 360 * 1024;

/// Total encoded budget across all attachments on one message. base64 of this
/// (~4/3) plus the message text stays comfortably under Convex's 1 MiB doc cap.
const int kMaxTotalAttachmentBytes = 640 * 1024;

/// Claude downscales anything larger than 1568px on the long edge anyway, so
/// there's no point shipping more resolution than that.
const int _maxEdge = 1568;

/// Downscale [raw] to <= 1568px on the long edge and re-encode as JPEG, dialing
/// quality (then dimensions) down until it fits [kMaxAttachmentBytes]. Runs on a
/// background isolate so a large decode never janks the composer.
///
/// Returns the original bytes unchanged if decoding fails (e.g. an unsupported
/// format) — better to attempt the send than to silently drop the image; the
/// caller still guards the total payload size before sending.
Future<Uint8List> prepareRelayImage(Uint8List raw) =>
    compute(_downscaleToJpeg, raw);

Uint8List _downscaleToJpeg(Uint8List raw) {
  final decoded = img.decodeImage(raw);
  if (decoded == null) return raw;

  var image = decoded;
  if (image.width > _maxEdge || image.height > _maxEdge) {
    image = image.width >= image.height
        ? img.copyResize(image, width: _maxEdge)
        : img.copyResize(image, height: _maxEdge);
  }

  var quality = 82;
  var out = Uint8List.fromList(img.encodeJpg(image, quality: quality));
  while (out.lengthInBytes > kMaxAttachmentBytes && quality > 35) {
    quality -= 12;
    out = Uint8List.fromList(img.encodeJpg(image, quality: quality));
  }

  // A dense image can still exceed the budget at low quality; shrink dimensions
  // and re-encode as a last resort.
  if (out.lengthInBytes > kMaxAttachmentBytes) {
    final smaller = image.width >= image.height
        ? img.copyResize(image, width: (image.width * 0.7).round())
        : img.copyResize(image, height: (image.height * 0.7).round());
    out = Uint8List.fromList(img.encodeJpg(smaller, quality: 70));
  }

  return out;
}
