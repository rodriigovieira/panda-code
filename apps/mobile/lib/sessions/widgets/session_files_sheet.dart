import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../theme/panda_tokens.dart';
import '../../widgets/toast/panda_toast.dart';
import '../models.dart';

/// "Changed files" for a section — the phone half of the desktop drawer. The
/// answer is computed desktop-side (attribution from the section's transcript,
/// line counts from git) and fetched over a `session-files` command round-trip,
/// so an unreachable desktop says so instead of showing an empty list.
Future<void> showSessionFilesSheet(BuildContext context, SessionRow row) {
  return showModalBottomSheet(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _SessionFilesSheet(row: row),
  );
}

class _SessionFilesSheet extends ConsumerStatefulWidget {
  const _SessionFilesSheet({required this.row});

  final SessionRow row;

  @override
  ConsumerState<_SessionFilesSheet> createState() => _SessionFilesSheetState();
}

class _SessionFilesSheetState extends ConsumerState<_SessionFilesSheet> {
  SessionFileChanges? _changes;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final changes = await api.fetchSessionFiles(widget.row.sessionId);
      if (!mounted) return;
      setState(() {
        _changes = changes;
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
    final t = context.tokens;
    final theme = Theme.of(context);
    final changes = _changes;
    // Half the screen at rest, most of it when the list is long: a section that
    // touched forty files should not be read through a letterbox.
    final maxHeight = MediaQuery.of(context).size.height * 0.82;

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Changed files',
                          style: theme.textTheme.titleLarge
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _subtitle(changes),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: t.subtle, fontSize: 12.5),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: _loading ? null : _load,
                    icon: const Icon(Icons.refresh),
                    iconSize: t.control.iconGlyph,
                    color: t.muted,
                    tooltip: 'Refresh',
                    constraints: t.control.tapTarget,
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Flexible(child: _body(context)),
            ],
          ),
        ),
      ),
    );
  }

  String _subtitle(SessionFileChanges? changes) {
    final title = widget.row.title?.trim();
    final branch = changes?.branch;
    final parts = <String>[
      if (title != null && title.isNotEmpty) title,
      if (branch != null && branch.isNotEmpty) branch,
    ];
    return parts.isEmpty ? 'This section' : parts.join(' · ');
  }

  Widget _body(BuildContext context) {
    final t = context.tokens;
    if (_loading) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Row(
          children: [
            const SizedBox(
              width: 15,
              height: 15,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 10),
            Text('Asking the desktop…',
                style: TextStyle(color: t.subtle, fontSize: 13)),
          ],
        ),
      );
    }

    final error = _error;
    if (error != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Text(error,
                  style: TextStyle(color: t.danger.text, fontSize: 13)),
            ),
            TextButton(onPressed: _load, child: const Text('Retry')),
          ],
        ),
      );
    }

    final changes = _changes;
    if (changes == null || changes.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 20),
        child: Text(
          changes?.error ?? 'This section has not written to any files yet.',
          style: TextStyle(color: t.muted, fontSize: 13),
        ),
      );
    }

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _FilesSummary(changes: changes),
          const SizedBox(height: 14),
          for (final file in changes.files) _FileRow(file: file),
          if (changes.error != null) ...[
            const SizedBox(height: 10),
            Text('${changes.error} — line counts unavailable.',
                style: TextStyle(color: t.subtle, fontSize: 11.5)),
          ],
        ],
      ),
    );
  }
}

/// File count and the +/− totals, over a bar split by the add:remove ratio —
/// the same readout the desktop drawer opens with.
class _FilesSummary extends StatelessWidget {
  const _FilesSummary({required this.changes});

  final SessionFileChanges changes;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final total = changes.added + changes.removed;
    final addedShare = total == 0 ? 0.0 : changes.added / total;
    final count = changes.files.length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text('$count',
                style: TextStyle(
                    color: t.text, fontSize: 17, fontWeight: FontWeight.w700)),
            const SizedBox(width: 5),
            Text(count == 1 ? 'file' : 'files',
                style: TextStyle(color: t.muted, fontSize: 13)),
            const Spacer(),
            // Zeroes are not additions and deletions — mute them so the header
            // matches the empty track below it.
            Text('+${changes.added}',
                style: TextStyle(
                    color: total == 0 ? t.muted : t.run.text,
                    fontSize: 13,
                    fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text('−${changes.removed}',
                style: TextStyle(
                    color: total == 0 ? t.muted : t.danger.text,
                    fontSize: 13,
                    fontWeight: FontWeight.w600)),
          ],
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: t.radius.pillR,
          child: SizedBox(
            height: 4,
            child: total == 0
                ? ColoredBox(color: t.lineSoft, child: const SizedBox.expand())
                : Row(
                    children: [
                      Expanded(
                        flex: (addedShare * 1000).round().clamp(0, 1000),
                        child: ColoredBox(color: t.run.text),
                      ),
                      Expanded(
                        flex: (1000 - addedShare * 1000).round().clamp(0, 1000),
                        child: ColoredBox(color: t.danger.text),
                      ),
                    ],
                  ),
          ),
        ),
      ],
    );
  }
}

class _FileRow extends StatelessWidget {
  const _FileRow({required this.file});

  final SessionFileChange file;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final meta = _statusMeta(context, file.status);

    // A phone cannot open the file in an editor, so the useful action is the
    // path itself — tap to copy, which is what gets pasted back into a session.
    return InkWell(
      borderRadius: t.radius.smR,
      onTap: () async {
        await Clipboard.setData(ClipboardData(text: file.absolutePath));
        showToast('Copied path', variant: ToastVariant.success);
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 4),
        child: Row(
          children: [
            Container(
              width: 22,
              padding: const EdgeInsets.symmetric(vertical: 2),
              decoration: BoxDecoration(
                color: t.panelStrong,
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                meta.code,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: meta.color,
                  fontSize: 10.5,
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text.rich(
                TextSpan(children: [
                  if (file.directory.isNotEmpty)
                    TextSpan(
                      text: file.directory,
                      style: TextStyle(color: t.subtle),
                    ),
                  TextSpan(text: file.name),
                ]),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: file.exists ? t.text : t.subtle,
                  fontSize: 13,
                  decoration:
                      file.exists ? null : TextDecoration.lineThrough,
                ),
              ),
            ),
            const SizedBox(width: 10),
            if (file.binary)
              Text('binary', style: TextStyle(color: t.subtle, fontSize: 11.5))
            else ...[
              Text('+${file.added}',
                  style: TextStyle(color: t.run.text, fontSize: 12)),
              const SizedBox(width: 6),
              Text('−${file.removed}',
                  style: TextStyle(color: t.danger.text, fontSize: 12)),
            ],
          ],
        ),
      ),
    );
  }
}

typedef _StatusMeta = ({String code, String label, Color color});

/// Same codes, labels and tones as the desktop drawer — a file that reads "M"
/// there must not read "~" here.
_StatusMeta _statusMeta(BuildContext context, String status) {
  final t = context.tokens;
  return switch (status) {
    'added' => (code: 'A', label: 'Added', color: t.run.text),
    'untracked' => (code: 'U', label: 'New file', color: t.run.text),
    'deleted' => (code: 'D', label: 'Deleted', color: t.danger.text),
    'clean' => (code: '·', label: 'Matches HEAD', color: t.subtle),
    'missing' => (code: '?', label: 'Not on disk', color: t.subtle),
    _ => (code: 'M', label: 'Modified', color: t.warn.text),
  };
}
