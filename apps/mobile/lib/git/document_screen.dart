import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../sessions/settings_store.dart';
import '../sessions/widgets/code_view.dart';
import '../sessions/widgets/markdown_view.dart';
import '../state/providers.dart';
import '../theme/panda_theme.dart';
import '../theme/panda_tokens.dart';
import '../widgets/toast/panda_toast.dart';
import 'git_status_models.dart';

const _markdownExtensions = {'md', 'markdown', 'mdown', 'mdx', 'mdc'};

/// Plain text the reader shows as source rather than pretending to render.
const _plainTextExtensions = {
  'txt', 'text', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'env', 'csv', 'diff', 'patch',
};

/// The point size [MarkdownView] renders at with no scaling — Material's
/// bodyMedium. The reader's own size is expressed against it.
const double _baseBodySize = 14;

/// How long the editor sits still before the file is written back.
const _autosaveDelay = Duration(milliseconds: 500);

/// The cheatsheet under the editor, same as the desktop's.
const _markdownHints =
    '# Heading · **bold** · *italic* · `code` · - list · > quote · [link](url)';

String _extension(String path) {
  final name = path.split('/').where((part) => part.isNotEmpty).lastOrNull ?? '';
  final dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.substring(dot + 1).toLowerCase();
}

bool isMarkdownPath(String path) => _markdownExtensions.contains(_extension(path));

/// Anything the reader will open — Markdown rendered, the rest as source.
bool isReadableDocPath(String path) {
  final extension = _extension(path);
  return _markdownExtensions.contains(extension) || _plainTextExtensions.contains(extension);
}

String docFileName(String path) =>
    path.split('/').where((part) => part.isNotEmpty).lastOrNull ?? 'document';

/// Open a document from wherever a file path is on screen.
Future<void> openDocument(BuildContext context, {required String cwd, required String path}) {
  return Navigator.of(context).push<void>(
    MaterialPageRoute(builder: (_) => DocumentScreen(cwd: cwd, path: path)),
  );
}

/// The in-app reader, phone side: a Markdown file from the Mac, rendered — and,
/// since the phone is where a typo gets noticed, editable.
///
/// The phone has always been able to *list* a workspace's files and had nowhere
/// to read one — "no way to open a file: the phone has nothing to open it in",
/// as the git screen put it. It does now, for the case that matters away from
/// the desk: an agent was asked for a document and wrote one.
///
/// Same renderer as a transcript message ([MarkdownView]), so a plan reads the
/// same here as the message announcing it. The file rides an encrypted
/// request/response through the relay like every other workspace read — nothing
/// is cached on the phone, and the desktop refuses any path outside the
/// workspace it was asked about. Edits ride the same channel back and are
/// written on a 500 ms idle timer, so there is no Save button to forget.
class DocumentScreen extends ConsumerStatefulWidget {
  const DocumentScreen({super.key, required this.cwd, required this.path});

  /// The workspace the read is scoped to. The desktop will not read outside it.
  final String cwd;

  /// Workspace-relative, or absolute inside the workspace.
  final String path;

  @override
  ConsumerState<DocumentScreen> createState() => _DocumentScreenState();
}

class _DocumentScreenState extends ConsumerState<DocumentScreen> {
  WorkspaceTextFile? _file;
  String? _error;
  bool _loading = true;

  /// Rendered or raw. A file with no Markdown to render opens on source,
  /// because reflowing a log as prose would only lie about it.
  late bool _source = !isMarkdownPath(widget.path);

  bool _editing = false;
  final _editor = TextEditingController();

  /// The autosave's state: what is waiting to go, the idle timer, and what the
  /// Mac already has.
  Timer? _saveTimer;
  String? _pending;
  String _savedContent = '';
  int? _savedAt;
  String? _saveError;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _saveTimer?.cancel();
    // Last chance: the screen can be popped with an edit still in the timer.
    // Deliberately not awaited — the request outlives this widget.
    unawaited(_flushPending());
    _editor.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final file = await api.readFile(widget.cwd, path: widget.path);
      if (!mounted) return;
      setState(() {
        _file = file;
        _savedContent = file.content;
        _pending = null;
        _loading = false;
      });
      if (!_editing) _editor.text = file.content;
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '$error'.replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  /// Write whatever is waiting, now. Called by the idle timer, by leaving edit
  /// mode, and on dispose.
  Future<void> _flushPending() async {
    _saveTimer?.cancel();
    _saveTimer = null;
    final pending = _pending;
    _pending = null;
    if (pending == null || pending == _savedContent) return;
    if (mounted) setState(() => _saving = true);
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw Exception('Not paired with a desktop.');
      final savedAt =
          await api.writeFile(widget.cwd, path: widget.path, content: pending);
      _savedContent = pending;
      if (!mounted) return;
      setState(() {
        _savedAt = savedAt;
        _saveError = null;
        _saving = false;
        final file = _file;
        if (file != null) {
          _file = WorkspaceTextFile(
            path: file.path,
            name: file.name,
            content: pending,
            size: pending.length,
            truncated: file.truncated,
          );
        }
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saveError = '$error'.replaceFirst('Exception: ', '');
        _saving = false;
      });
    }
  }

  void _onEdited(String text) {
    _pending = text;
    _saveTimer?.cancel();
    _saveTimer = Timer(_autosaveDelay, () => unawaited(_flushPending()));
  }

  void _setEditing(bool editing) {
    if (editing == _editing) return;
    if (!editing) unawaited(_flushPending());
    setState(() {
      _editing = editing;
      if (editing) {
        _editor.text = _file?.content ?? '';
        _source = false;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final file = _file;
    final markdown = isMarkdownPath(widget.path);
    final content = file?.content ?? '';
    final fontSize = ref.watch(settingsProvider).valueOrNull?.docFontSize ??
        AppSettings.defaultDocFontSize;
    // A truncated read only holds the head of the file; saving that back would
    // delete the tail, so those documents stay read-only here.
    final editable =
        markdown && file != null && file.error == null && !file.truncated;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(docFileName(widget.path)),
            Text(
              widget.path,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11, color: tokens.subtle),
            ),
          ],
        ),
        actions: [
          if (editable)
            IconButton(
              onPressed: () => _setEditing(!_editing),
              isSelected: _editing,
              icon: Icon(_editing ? Icons.check : Icons.edit_outlined),
              tooltip: _editing ? 'Done editing' : 'Edit, saved as you type',
            ),
          if (markdown && !_editing)
            IconButton(
              onPressed: () => setState(() => _source = !_source),
              isSelected: _source,
              icon: const Icon(Icons.code),
              tooltip: _source ? 'Show it rendered' : 'Show the source',
            ),
          _TextSizeButton(
            size: fontSize,
            onChanged: (v) =>
                ref.read(settingsProvider.notifier).setDocFontSize(v),
          ),
          PopupMenuButton<String>(
            tooltip: 'More',
            onSelected: (choice) async {
              if (choice == 'copy') {
                await Clipboard.setData(ClipboardData(text: content));
                showToast('Copied', variant: ToastVariant.success);
              } else if (choice == 'reload') {
                await _load();
              }
            },
            itemBuilder: (_) => [
              PopupMenuItem(
                value: 'copy',
                enabled: content.isNotEmpty,
                child: const Text('Copy the text'),
              ),
              const PopupMenuItem(
                value: 'reload',
                child: Text('Reload from the Mac'),
              ),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: _editing
                ? _Editor(
                    controller: _editor,
                    fontSize: fontSize,
                    onChanged: _onEdited,
                  )
                : RefreshIndicator(
                    onRefresh: _load,
                    child: ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 48),
                      children: [
                        if (_error != null)
                          _Note(text: _error!)
                        else if (file == null)
                          const SizedBox.shrink()
                        else if (file.error != null)
                          _Note(text: file.error!)
                        else if (content.trim().isEmpty)
                          const _Note(text: 'This file is empty.')
                        else if (_source || !markdown)
                          CodeView(code: content, language: markdown ? 'markdown' : null)
                        else
                          // The reader's own text size, applied to the same
                          // renderer a transcript message uses: scaling the
                          // 14pt body rather than restyling every block keeps
                          // headings, code and tables in proportion. Stacked
                          // on the ambient scaler (app base bump + OS
                          // accessibility) rather than replacing it.
                          MediaQuery(
                            data: MediaQuery.of(context).copyWith(
                              textScaler: scaleTextScaler(
                                  MediaQuery.textScalerOf(context),
                                  fontSize / _baseBodySize),
                            ),
                            child: MarkdownView(data: content),
                          ),
                        if (file?.truncated == true)
                          const _Note(
                            text: 'Showing the beginning of the file — the rest is past what the phone asks for.',
                          ),
                      ],
                    ),
                  ),
          ),
          if (_editing)
            _SaveBar(
              saving: _saving,
              savedAt: _savedAt,
              error: _saveError,
            ),
        ],
      ),
    );
  }
}

/// The editing pane: the Markdown source, plainly. No live highlight here —
/// a phone keyboard plus a rewriting text field is where caret bugs live, and
/// the rendered view is one tap away.
class _Editor extends StatelessWidget {
  const _Editor({
    required this.controller,
    required this.fontSize,
    required this.onChanged,
  });

  final TextEditingController controller;
  final double fontSize;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: TextField(
        controller: controller,
        onChanged: onChanged,
        autofocus: true,
        maxLines: null,
        expands: true,
        keyboardType: TextInputType.multiline,
        textCapitalization: TextCapitalization.sentences,
        style: TextStyle(fontSize: fontSize, height: 1.5, color: tokens.text),
        decoration: InputDecoration(
          border: InputBorder.none,
          isDense: true,
          hintText: 'Write in Markdown…',
          hintStyle: TextStyle(color: tokens.subtle, fontSize: fontSize),
        ),
      ),
    );
  }
}

/// The Markdown cheatsheet and what the last write did — the editor's only
/// chrome, since there is nothing to press.
class _SaveBar extends StatelessWidget {
  const _SaveBar({required this.saving, required this.savedAt, required this.error});

  final bool saving;
  final int? savedAt;
  final String? error;

  String _label() {
    if (error != null) return error!;
    if (saving) return 'Saving…';
    final at = savedAt;
    if (at == null) return 'Saves as you type';
    final time = DateTime.fromMillisecondsSinceEpoch(at);
    String two(int v) => v.toString().padLeft(2, '0');
    return 'Saved ${two(time.hour)}:${two(time.minute)}:${two(time.second)}';
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final failed = error != null;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: tokens.line)),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                _markdownHints,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11, color: tokens.subtle),
              ),
            ),
            const SizedBox(width: 12),
            if (failed) ...[
              Icon(Icons.error_outline, size: 13, color: tokens.danger.text),
              const SizedBox(width: 4),
            ],
            Text(
              _label(),
              style: TextStyle(
                fontSize: 11,
                color: failed ? tokens.danger.text : tokens.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The text-size adjuster. Lives in a popup rather than as two more app-bar
/// icons: it is reached rarely and set once, and the title already has to share
/// that row with the path.
class _TextSizeButton extends StatefulWidget {
  const _TextSizeButton({required this.size, required this.onChanged});

  final double size;
  final ValueChanged<double> onChanged;

  @override
  State<_TextSizeButton> createState() => _TextSizeButtonState();
}

class _TextSizeButtonState extends State<_TextSizeButton> {
  late double _size = widget.size;

  @override
  void didUpdateWidget(covariant _TextSizeButton old) {
    super.didUpdateWidget(old);
    if (widget.size != old.size) _size = widget.size;
  }

  /// The popup is its own route, so it does not rebuild when the setting does:
  /// the number it shows comes from here, and the tap writes the setting.
  void _step(double delta, StateSetter setLocal) {
    final next = SettingsStore.clampDocFontSize(_size + delta);
    if (next == _size) return;
    setState(() => _size = next);
    setLocal(() {});
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<void>(
      tooltip: 'Text size',
      icon: const Icon(Icons.format_size),
      itemBuilder: (_) => [
        PopupMenuItem<void>(
          enabled: false,
          child: StatefulBuilder(
            builder: (context, setLocal) => Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  onPressed: _size <= SettingsStore.minDocFontSize
                      ? null
                      : () => _step(-1, setLocal),
                  icon: const Icon(Icons.remove),
                  tooltip: 'Smaller text',
                ),
                SizedBox(
                  width: 34,
                  child: Text(
                    '${_size.round()}',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: context.tokens.text),
                  ),
                ),
                IconButton(
                  onPressed: _size >= SettingsStore.maxDocFontSize
                      ? null
                      : () => _step(1, setLocal),
                  icon: const Icon(Icons.add),
                  tooltip: 'Larger text',
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Note extends StatelessWidget {
  const _Note({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: TextStyle(color: context.tokens.subtle, fontSize: 13),
        ),
      );
}
