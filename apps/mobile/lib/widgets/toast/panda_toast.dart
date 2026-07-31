import 'package:flutter/material.dart';

/// Severity of a toast — drives its accent color and leading icon, mirroring
/// the `richColors` variants Sonner uses in the admin-vite app.
enum ToastVariant { success, error, warning, info }

/// A single live toast. Immutable; the messenger swaps whole lists so the
/// overlay can diff by [id].
@immutable
class ToastEntry {
  const ToastEntry({
    required this.id,
    required this.message,
    required this.variant,
    required this.duration,
    this.actionLabel,
    this.onAction,
  });

  final int id;
  final String message;
  final ToastVariant variant;

  /// How long the card stays before auto-dismissing. `Duration.zero` keeps it
  /// up until the user dismisses it (used for critical, action-bearing errors).
  final Duration duration;

  final String? actionLabel;
  final VoidCallback? onAction;

  bool get isPersistent => duration == Duration.zero;
}

/// App-wide toast host. A single global instance owns the list of live toasts
/// so any layer — even a deep widget that only has a [BuildContext] — can raise
/// one via the top-level [showToast], with no provider wiring at the call site.
/// A single [ToastOverlay] listens and renders the stack.
class ToastMessenger extends ChangeNotifier {
  ToastMessenger._();
  static final ToastMessenger instance = ToastMessenger._();

  final List<ToastEntry> _entries = <ToastEntry>[];
  int _nextId = 0;

  /// Currently visible toasts, oldest first.
  List<ToastEntry> get entries => List.unmodifiable(_entries);

  /// At most this many cards stack at once; older ones drop off the top so the
  /// stack never grows tall enough to cover content itself.
  static const int _maxVisible = 3;

  ToastEntry show(
    String message, {
    ToastVariant variant = ToastVariant.info,
    String? actionLabel,
    VoidCallback? onAction,
    Duration? duration,
  }) {
    final entry = ToastEntry(
      id: _nextId++,
      message: message,
      variant: variant,
      // Action-bearing toasts linger so the user can reach the button; plain
      // ones use a shorter beat. A caller can still force either.
      duration: duration ??
          (onAction != null
              ? const Duration(seconds: 6)
              : const Duration(seconds: 4)),
      actionLabel: onAction != null ? actionLabel : null,
      onAction: onAction,
    );
    _entries.add(entry);
    while (_entries.length > _maxVisible) {
      _entries.removeAt(0);
    }
    notifyListeners();
    return entry;
  }

  void dismiss(int id) {
    final before = _entries.length;
    _entries.removeWhere((e) => e.id == id);
    if (_entries.length != before) notifyListeners();
  }

  void clear() {
    if (_entries.isEmpty) return;
    _entries.clear();
    notifyListeners();
  }
}

/// Raise a floating toast from anywhere. Drop-in replacement for the old
/// `ScaffoldMessenger.of(context).showSnackBar(...)` calls — no context needed.
///
/// ```dart
/// showToast('Transcript copied', variant: ToastVariant.success);
/// showToast('Send failed. Check your connection.',
///     variant: ToastVariant.error, actionLabel: 'Retry', onAction: _retry);
/// ```
ToastEntry showToast(
  String message, {
  ToastVariant variant = ToastVariant.info,
  String? actionLabel,
  VoidCallback? onAction,
  Duration? duration,
}) =>
    ToastMessenger.instance.show(
      message,
      variant: variant,
      actionLabel: actionLabel,
      onAction: onAction,
      duration: duration,
    );
