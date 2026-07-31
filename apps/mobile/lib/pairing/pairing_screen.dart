import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import '../widgets/panda_logo.dart';
import 'pairing_errors.dart';
import 'pairing_payload.dart';

/// Scan the QR the desktop shows (Panda Code → Pair a phone) to establish the
/// E2E key and mobile credentials. Includes a manual-paste fallback for dev.
class PairingScreen extends ConsumerStatefulWidget {
  const PairingScreen({super.key});

  @override
  ConsumerState<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends ConsumerState<PairingScreen> {
  bool _handled = false;
  String? _error;

  Future<void> _submit(String raw) async {
    if (_handled) return;
    setState(() {
      _handled = true;
      _error = null;
    });
    try {
      final payload = PairingPayload.parse(raw);
      await ref.read(pairingProvider.notifier).pair(payload);
      // On success the root widget swaps to the session list automatically.
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _handled = false;
        _error = pairingErrorMessage(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final pairing = ref.watch(pairingProvider);
    final busy = _handled || pairing.isLoading;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 12,
        title: const PandaWordmark(subtitle: 'Pair with your Mac'),
      ),
      body: Column(
        children: [
          Expanded(
            child: Stack(
              alignment: Alignment.center,
              children: [
                MobileScanner(
                  onDetect: (capture) {
                    for (final barcode in capture.barcodes) {
                      final raw = barcode.rawValue;
                      if (raw != null && raw.isNotEmpty) {
                        _submit(raw);
                        break;
                      }
                    }
                  },
                ),
                if (busy) const CircularProgressIndicator(),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_error != null) ...[
                  Text(_error!,
                      style: TextStyle(color: context.tokens.danger.text)),
                  const SizedBox(height: 8),
                ],
                const Text(
                    'Point the camera at the QR on your Mac, or paste it:'),
                const SizedBox(height: 8),
                _ManualPaste(onSubmit: busy ? null : _submit),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ManualPaste extends StatefulWidget {
  const _ManualPaste({required this.onSubmit});

  final Future<void> Function(String raw)? onSubmit;

  @override
  State<_ManualPaste> createState() => _ManualPasteState();
}

class _ManualPasteState extends State<_ManualPaste> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: TextField(
            controller: _controller,
            decoration: const InputDecoration(
              hintText: 'Paste pairing JSON',
              border: OutlineInputBorder(),
              isDense: true,
            ),
          ),
        ),
        const SizedBox(width: 8),
        FilledButton(
          onPressed: widget.onSubmit == null
              ? null
              : () => widget.onSubmit!(_controller.text.trim()),
          child: const Text('Pair'),
        ),
      ],
    );
  }
}
