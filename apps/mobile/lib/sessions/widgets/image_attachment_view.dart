import 'package:flutter/material.dart';

import '../../theme/panda_tokens.dart';
import '../models.dart';

class ImageAttachmentStrip extends StatelessWidget {
  const ImageAttachmentStrip({
    super.key,
    required this.images,
    this.onRemove,
    this.compact = false,
  });

  final List<ConversationImage> images;
  final void Function(int index)? onRemove;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    if (images.isEmpty) return const SizedBox.shrink();
    final size = compact ? 58.0 : 86.0;

    return SizedBox(
      height: size,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: images.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final image = images[index];
          return Stack(
            clipBehavior: Clip.none,
            children: [
              Material(
                color: Colors.transparent,
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () => showImagePreview(context, image),
                  child: Ink(
                    width: size,
                    height: size,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: context.tokens.subtle),
                      image: DecorationImage(
                        image: MemoryImage(image.bytes),
                        fit: BoxFit.cover,
                      ),
                    ),
                  ),
                ),
              ),
              if (onRemove != null)
                Positioned(
                  top: -8,
                  right: -8,
                  child: IconButton.filled(
                    visualDensity: VisualDensity.compact,
                    iconSize: 14,
                    constraints:
                        const BoxConstraints.tightFor(width: 28, height: 28),
                    onPressed: () => onRemove!(index),
                    icon: const Icon(Icons.close),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

Future<void> showImagePreview(BuildContext context, ConversationImage image) {
  return showDialog<void>(
    context: context,
    builder: (context) => Dialog.fullscreen(
      backgroundColor: Colors.black,
      child: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      image.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: context.tokens.muted),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Close',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: Icon(Icons.close, color: context.tokens.text),
                  ),
                ],
              ),
            ),
            Expanded(
              child: InteractiveViewer(
                minScale: 0.5,
                maxScale: 5,
                child: Center(
                  child: Image.memory(image.bytes, fit: BoxFit.contain),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
