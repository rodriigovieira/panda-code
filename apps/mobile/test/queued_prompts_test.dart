import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/sessions/models.dart';

// The desktop owns the durable queue and mirrors it down inside the runtime
// payload (`SessionRuntimeEvent.queuedPrompts` in relayBridge.ts) — this is
// the mobile-side decode of that same shape. See relayBridge.queue.test.ts
// for the desktop half.
void main() {
  group('QueuedPromptSync.fromDecrypted', () {
    test('parses a full entry', () {
      final entry = QueuedPromptSync.fromDecrypted({
        'id': 'q1',
        'text': 'finish the refactor',
        'imageCount': 2,
        'queuedAt': 1000,
      });
      expect(entry.id, 'q1');
      expect(entry.text, 'finish the refactor');
      expect(entry.imageCount, 2);
      expect(entry.queuedAt, 1000);
    });

    test('tolerates missing fields rather than throwing', () {
      final entry = QueuedPromptSync.fromDecrypted({});
      expect(entry.id, '');
      expect(entry.text, '');
      expect(entry.imageCount, 0);
    });

    test('preview falls back to an image count when there is no text', () {
      final withText = QueuedPromptSync.fromDecrypted({'text': 'hello'});
      expect(withText.preview, 'hello');

      final imagesOnly = QueuedPromptSync.fromDecrypted({'imageCount': 1});
      expect(imagesOnly.preview, '1 image');

      final manyImages = QueuedPromptSync.fromDecrypted({'imageCount': 3});
      expect(manyImages.preview, '3 images');
    });
  });

  group('RuntimeBadge.fromDecrypted queuedPrompts', () {
    test('defaults to empty when the field is absent (older desktop builds)', () {
      final badge = RuntimeBadge.fromDecrypted({'agentState': 'working'});
      expect(badge.queuedPrompts, isEmpty);
    });

    test('decodes the list mirrored from the desktop', () {
      final badge = RuntimeBadge.fromDecrypted({
        'agentState': 'working',
        'queuedPrompts': [
          {'id': 'q1', 'text': 'first', 'imageCount': 0, 'queuedAt': 1},
          {'id': 'q2', 'text': 'second', 'imageCount': 1, 'queuedAt': 2},
        ],
      });
      expect(badge.queuedPrompts.map((q) => q.id), ['q1', 'q2']);
      expect(badge.queuedPrompts[1].imageCount, 1);
    });
  });
}
