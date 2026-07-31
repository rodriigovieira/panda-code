import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../theme/panda_tokens.dart';

import '../../state/providers.dart';
import 'panda_toast.dart';

/// Renders the live toast stack as floating cards pinned to the top of the
/// screen. Mounted once, above the app's content, so cards never cover the
/// bottom input/approval bars the way the old bottom SnackBars did.
///
/// Wrap the app's content with this in `MaterialApp.builder`.
class ToastOverlay extends ConsumerWidget {
  const ToastOverlay({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final reduceMotion =
        ref.watch(settingsProvider).valueOrNull?.reduceMotion ?? false;

    return Stack(
      children: [
        child,
        Positioned(
          top: 0,
          left: 0,
          right: 0,
          child: SafeArea(
            bottom: false,
            child: Align(
              alignment: Alignment.topCenter,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 520),
                child: _ToastStack(reduceMotion: reduceMotion),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _ToastStack extends StatelessWidget {
  const _ToastStack({required this.reduceMotion});

  final bool reduceMotion;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: ToastMessenger.instance,
      builder: (context, _) {
        // Newest on top, closest to the status bar and most visible.
        final entries = ToastMessenger.instance.entries.reversed.toList();
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final entry in entries)
              _ToastCard(
                key: ValueKey(entry.id),
                entry: entry,
                reduceMotion: reduceMotion,
                onDismiss: () => ToastMessenger.instance.dismiss(entry.id),
              ),
          ],
        );
      },
    );
  }
}

class _ToastCard extends StatefulWidget {
  const _ToastCard({
    super.key,
    required this.entry,
    required this.reduceMotion,
    required this.onDismiss,
  });

  final ToastEntry entry;
  final bool reduceMotion;
  final VoidCallback onDismiss;

  @override
  State<_ToastCard> createState() => _ToastCardState();
}

class _ToastCardState extends State<_ToastCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  Timer? _autoDismiss;
  bool _leaving = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: widget.reduceMotion
          ? Duration.zero
          : const Duration(milliseconds: 260),
      reverseDuration: widget.reduceMotion
          ? Duration.zero
          : const Duration(milliseconds: 200),
      value: widget.reduceMotion ? 1 : 0,
    );
    if (!widget.reduceMotion) _controller.forward();
    if (!widget.entry.isPersistent) {
      _autoDismiss = Timer(widget.entry.duration, _leave);
    }
  }

  /// Animate out, then ask the messenger to drop us.
  Future<void> _leave() async {
    if (_leaving) return;
    _leaving = true;
    _autoDismiss?.cancel();
    if (!widget.reduceMotion && mounted) {
      await _controller.reverse();
    }
    if (mounted) widget.onDismiss();
  }

  void _onActionPressed() {
    widget.entry.onAction?.call();
    _leave();
  }

  @override
  void dispose() {
    _autoDismiss?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final style = _ToastStyle.of(widget.entry.variant, Theme.of(context));

    final card = Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      child: Material(
        color: Colors.transparent,
        child: Container(
          decoration: BoxDecoration(
            color: style.background,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: style.border),
            boxShadow: [
              BoxShadow(
                color: context.tokens.lineSoft,
                blurRadius: 18,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(style.icon, size: 20, color: style.accent),
                const SizedBox(width: 10),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: Text(
                      widget.entry.message,
                      style: TextStyle(
                        color: style.foreground,
                        fontSize: 14,
                        height: 1.3,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
                if (widget.entry.actionLabel != null &&
                    widget.entry.onAction != null)
                  TextButton(
                    onPressed: _onActionPressed,
                    style: TextButton.styleFrom(
                      foregroundColor: style.accent,
                      visualDensity: VisualDensity.compact,
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      minimumSize: const Size(0, 32),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: Text(
                      widget.entry.actionLabel!,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  )
                else
                  IconButton(
                    tooltip: 'Dismiss',
                    onPressed: _leave,
                    visualDensity: VisualDensity.compact,
                    iconSize: 18,
                    padding: const EdgeInsets.all(4),
                    constraints: const BoxConstraints(),
                    icon: Icon(Icons.close,
                        color: style.foreground.withValues(alpha: 0.6)),
                  ),
              ],
            ),
          ),
        ),
      ),
    );

    final dismissible = Dismissible(
      key: ValueKey('toast-dismiss-${widget.entry.id}'),
      direction: DismissDirection.up,
      onDismissed: (_) {
        _autoDismiss?.cancel();
        widget.onDismiss();
      },
      child: card,
    );

    if (widget.reduceMotion) return dismissible;

    final curved = CurvedAnimation(
      parent: _controller,
      curve: Curves.easeOutCubic,
      reverseCurve: Curves.easeInCubic,
    );
    return SizeTransition(
      sizeFactor: curved,
      axisAlignment: -1,
      child: FadeTransition(
        opacity: curved,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, -0.18),
            end: Offset.zero,
          ).animate(curved),
          child: dismissible,
        ),
      ),
    );
  }
}

/// Resolves a variant to concrete colors + icon, adapting to light/dark theme.
class _ToastStyle {
  const _ToastStyle({
    required this.background,
    required this.border,
    required this.foreground,
    required this.accent,
    required this.icon,
  });

  final Color background;
  final Color border;
  final Color foreground;

  /// The variant's own colour — used for the icon and the leading edge, so the
  /// body text stays plain and only the signal is coloured.
  final Color accent;
  final IconData icon;

  /// Toasts float, so they sit on `overlay` rather than tinting the whole card
  /// with the variant colour. The variant now reads from the shared status groups —
  /// previously it carried its own four hexes, which is how a "success" toast ended
  /// up a different green from every other success signal in the app.
  static _ToastStyle of(ToastVariant variant, ThemeData theme) {
    final t = theme.extension<PandaTokens>() ?? PandaTokens.dark;
    final (StatusTokens status, IconData icon) = switch (variant) {
      ToastVariant.success => (t.run, Icons.check_circle),
      ToastVariant.error => (t.danger, Icons.error),
      ToastVariant.warning => (t.warn, Icons.warning_amber),
      ToastVariant.info => (t.info, Icons.info),
    };
    return _ToastStyle(
      background: Color.alphaBlend(status.wash, t.overlay),
      border: status.edge,
      foreground: t.text,
      accent: status.text,
      icon: icon,
    );
  }
}
