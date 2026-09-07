import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../dictation/dictation_button.dart';
import '../sessions/widgets/markdown_view.dart';
import '../sessions/widgets/media_viewer_screen.dart';
import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import '../widgets/toast/panda_toast.dart';
import 'backlog_models.dart';

/// What the editor collects on save. Title is the only required field.
class BacklogDraft {
  BacklogDraft({
    required this.title,
    required this.summary,
    required this.description,
    required this.metadata,
    required this.column,
    this.onHold = false,
    this.verificationNotes = '',
    this.removeAttachmentIds = const [],
  });

  final String title;

  /// One-line TL;DR. Sent on every save, so editing a card on the phone keeps
  /// its summary in step with the description the same way an agent does.
  final String summary;
  final String description;
  final String metadata;
  final BacklogColumn column;

  /// Parked: kept, but not up for work now. Only ever true for a card that
  /// already exists — a card is not filed on hold.
  final bool onHold;

  final String verificationNotes;

  /// Attachments the phone can drop but not add — no image bytes ride this
  /// screen yet, only the ids of ones the user removed while editing.
  final List<String> removeAttachmentIds;
}

/// What [BacklogItemScreen] hands back when it pops. Null means the user
/// backed out with no changes.
class BacklogEditorResult {
  const BacklogEditorResult._(
      {this.draft, this.delete = false, this.createSession = false});

  factory BacklogEditorResult.save(BacklogDraft draft) =>
      BacklogEditorResult._(draft: draft);

  factory BacklogEditorResult.delete() =>
      const BacklogEditorResult._(delete: true);

  /// The card isn't saved — [draft] just carries the current field values
  /// through to seed a new session's composer.
  factory BacklogEditorResult.createSession(BacklogDraft draft) =>
      BacklogEditorResult._(draft: draft, createSession: true);

  final BacklogDraft? draft;
  final bool delete;
  final bool createSession;
}

/// Persists a save or delete from [result] against [cwd]'s board. Shared by
/// the board's own editor ([BacklogScreen]) and by opening a card straight
/// from a `#12` mention elsewhere in the app, so the two don't drift on what
/// an edit or a delete actually sends the relay.
///
/// Does nothing for "start a session from this": that result carries no board
/// change, only a prompt, and starting a session is a UI flow each caller
/// already owns (the board opens a sheet in place; a card tapped from a
/// transcript would need to leave it).
Future<void> persistBacklogEditorResult(
  WidgetRef ref, {
  required String cwd,
  required BacklogEditorResult result,
  BacklogItem? item,
}) async {
  if (result.createSession) return;
  final api = await ref.read(relayApiProvider.future);
  if (api == null) throw Exception('Not paired with a desktop.');

  if (result.delete) {
    if (item != null) await api.backlog(cwd, op: 'delete', id: item.id);
    return;
  }

  final draft = result.draft!;
  await api.backlog(
    cwd,
    op: item == null ? 'add' : 'update',
    id: item?.id,
    title: draft.title,
    summary: draft.summary,
    description: draft.description,
    metadata: draft.metadata,
    column: draft.column.wire,
    onHold: item == null ? null : draft.onHold,
    verificationNotes: item == null ? null : draft.verificationNotes,
    removeAttachmentIds: item == null || draft.removeAttachmentIds.isEmpty
        ? null
        : draft.removeAttachmentIds,
  );
}

/// Full-screen view + edit for one backlog card.
///
/// Replaces the old bottom-sheet editor: title/description/metadata read
/// better with the room a full screen gives them, and delete lives here now
/// instead of in a separate actions sheet.
class BacklogItemScreen extends StatefulWidget {
  const BacklogItemScreen(
      {super.key, required this.item, required this.column});

  /// Null when composing a new card.
  final BacklogItem? item;

  /// The column a new card starts in, or the card's current column when editing.
  final BacklogColumn column;

  @override
  State<BacklogItemScreen> createState() => _BacklogItemScreenState();
}

class _BacklogItemScreenState extends State<BacklogItemScreen> {
  late final TextEditingController _title =
      TextEditingController(text: widget.item?.title ?? '');
  late final TextEditingController _summary =
      TextEditingController(text: widget.item?.summary ?? '');
  late final TextEditingController _description =
      TextEditingController(text: widget.item?.description ?? '');
  late final TextEditingController _metadata =
      TextEditingController(text: widget.item?.metadata ?? '');
  late final TextEditingController _verificationNotes =
      TextEditingController(text: widget.item?.verificationNotes ?? '');
  late BacklogColumn _column = widget.column;
  late bool _onHold = widget.item?.onHold ?? false;
  final FocusNode _descriptionFocus = FocusNode();

  /// Attachments dropped while editing — applied on save, same as every other
  /// field here. Adding one is agent-only, through the desktop's MCP tool.
  final Set<String> _removedAttachmentIds = {};

  List<BacklogAttachment> get _visibleAttachments =>
      (widget.item?.attachments ?? [])
          .where((a) => !_removedAttachmentIds.contains(a.id))
          .toList();

  /// Whether the description shows as rendered Markdown or as its source.
  ///
  /// A new card opens straight into the editor — there is nothing to read yet —
  /// and an existing one opens rendered, because agents now write headings and
  /// lists in here and the card is opened to be read far more often than to be
  /// rewritten. Tapping the body is what switches, which is the desktop's
  /// gesture too.
  late bool _editingDescription = widget.item == null;

  bool get _isNew => widget.item == null;

  @override
  void dispose() {
    _title.dispose();
    _summary.dispose();
    _description.dispose();
    _metadata.dispose();
    _verificationNotes.dispose();
    _descriptionFocus.dispose();
    super.dispose();
  }

  void _save() {
    final title = _title.text.trim();
    if (title.isEmpty) {
      showToast('Give it a title first.', variant: ToastVariant.error);
      return;
    }
    Navigator.pop(
      context,
      BacklogEditorResult.save(BacklogDraft(
        title: title,
        summary: _summary.text.trim(),
        description: _description.text.trim(),
        metadata: _metadata.text.trim(),
        column: _column,
        onHold: _onHold,
        verificationNotes: _verificationNotes.text.trim(),
        removeAttachmentIds: _removedAttachmentIds.toList(),
      )),
    );
  }

  void _startSession() {
    final title = _title.text.trim();
    if (title.isEmpty) {
      showToast('Give it a title first.', variant: ToastVariant.error);
      return;
    }
    Navigator.pop(
      context,
      BacklogEditorResult.createSession(BacklogDraft(
        title: title,
        summary: _summary.text.trim(),
        description: _description.text.trim(),
        metadata: _metadata.text.trim(),
        column: _column,
      )),
    );
  }

  Future<void> _confirmDelete() async {
    final item = widget.item;
    if (item == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this item?'),
        content: Text(item.title),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Delete')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    Navigator.pop(context, BacklogEditorResult.delete());
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;

    // The evidence an agent left behind: its notes, and whatever it captured.
    //
    // Built once and placed twice, because where it belongs depends on what the
    // card is for. On a card in Review this is the whole reason the screen is
    // open — the agent has handed the work back and the only question left is
    // whether the proof holds — so it goes above the description, where the
    // user's thumb already is. Anywhere else it is a footnote about a card that
    // is still being written, and it sits at the bottom with the metadata.
    final evidence = <Widget>[
      Text('VERIFICATION', style: _label(tokens)),
      const SizedBox(height: 6),
      TextField(
        controller: _verificationNotes,
        minLines: 2,
        maxLines: 6,
        style: TextStyle(color: tokens.text, fontSize: 14, height: 1.4),
        decoration: const InputDecoration(
            hintText: "What did this prove, and what didn't it?"),
      ),
      if (_visibleAttachments.isNotEmpty) ...[
        const SizedBox(height: 8),
        _AttachmentList(
          attachments: _visibleAttachments,
          onRemove: (id) => setState(() => _removedAttachmentIds.add(id)),
        ),
      ],
    ];
    final leadsWithEvidence = _column == BacklogColumn.review;

    return Scaffold(
      appBar: AppBar(
        // A card being edited is named by its number, since that is what the
        // user types to point an agent at it. A new one has none yet.
        title: Text(_isNew
            ? 'New item'
            : (widget.item?.ref.isNotEmpty ?? false)
                ? 'Edit ${widget.item!.ref}'
                : 'Edit item'),
        actions: [
          IconButton(
            onPressed: _startSession,
            icon: const Icon(Icons.rocket_launch_outlined),
            tooltip: 'Start a session from this item',
          ),
          if (!_isNew)
            IconButton(
              onPressed: _confirmDelete,
              icon: const Icon(Icons.delete_outline),
              tooltip: 'Delete',
            ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
          children: [
            Text('TITLE', style: _label(tokens)),
            const SizedBox(height: 6),
            TextField(
              controller: _title,
              autofocus: _isNew,
              textInputAction: TextInputAction.next,
              style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: tokens.text),
              decoration: const InputDecoration(hintText: 'Title'),
            ),
            const SizedBox(height: 20),
            Text('SUMMARY', style: _label(tokens)),
            const SizedBox(height: 6),
            TextField(
              controller: _summary,
              textInputAction: TextInputAction.next,
              style: TextStyle(color: tokens.text, fontSize: 14),
              decoration: const InputDecoration(
                  hintText: 'One line: what this is, in short'),
            ),
            const SizedBox(height: 20),
            if (leadsWithEvidence) ...[
              ...evidence,
              const SizedBox(height: 20),
            ],
            Row(
              children: [
                Text('DESCRIPTION', style: _label(tokens)),
                const Spacer(),
                if (!_isNew)
                  TextButton(
                    onPressed: () => setState(
                        () => _editingDescription = !_editingDescription),
                    child: Text(_editingDescription ? 'Preview' : 'Edit'),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            if (_editingDescription)
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _description,
                      focusNode: _descriptionFocus,
                      minLines: 6,
                      maxLines: 14,
                      style: TextStyle(
                          color: tokens.text, fontSize: 14, height: 1.4),
                      decoration: const InputDecoration(
                          hintText: 'Add more detail — Markdown works here…'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  DictationButton(
                    controller: _description,
                    focusNode: _descriptionFocus,
                    enabled: true,
                    onNotice: (message, {bool isError = false}) => showToast(
                      message,
                      variant: isError ? ToastVariant.error : ToastVariant.info,
                    ),
                    onListeningChanged: (_) {},
                  ),
                ],
              )
            else
              _DescriptionPreview(
                markdown: _description.text,
                onEdit: () => setState(() => _editingDescription = true),
              ),
            const SizedBox(height: 20),
            Text('METADATA', style: _label(tokens)),
            const SizedBox(height: 6),
            TextField(
              controller: _metadata,
              style: TextStyle(color: tokens.text, fontSize: 14),
              decoration: const InputDecoration(
                  hintText: 'Labels, estimate, links — anything'),
            ),
            if (!leadsWithEvidence) ...[
              const SizedBox(height: 20),
              ...evidence,
            ],
            const SizedBox(height: 20),
            Text('COLUMN', style: _label(tokens)),
            const SizedBox(height: 8),
            SegmentedButton<BacklogColumn>(
              // Pending is offered only on a card that is already in it: it is
              // an inbox automation writes to, and triage means moving a card
              // *out*. That keeps this at four segments — backlog, doing,
              // review, done — which is why they are labelled with
              // `shortLabel`: "In progress" spelled out ellipsises the row.
              segments: [
                for (final column in BacklogColumn.values)
                  if (column != BacklogColumn.pending ||
                      _column == BacklogColumn.pending)
                    ButtonSegment(
                        value: column, label: Text(column.shortLabel)),
              ],
              selected: {_column},
              showSelectedIcon: false,
              onSelectionChanged: (s) => setState(() => _column = s.first),
            ),
            // Under the columns rather than among them: holding a card is not a
            // fourth stage of the work, it is a card set aside from whichever
            // stage it is in — and it comes back to that same one. Not offered
            // on a new card: nothing is filed already parked.
            if (!_isNew) ...[
              const SizedBox(height: 8),
              SwitchListTile.adaptive(
                value: _onHold,
                onChanged: (value) => setState(() => _onHold = value),
                contentPadding: EdgeInsets.zero,
                title: Text(
                  'On hold',
                  style: TextStyle(color: tokens.text, fontSize: 14),
                ),
                subtitle: Text(
                  _onHold
                      ? 'Off the board until you take it off hold'
                      : 'Keep it, but take it off the board',
                  style: TextStyle(color: tokens.subtle, fontSize: 12),
                ),
              ),
            ],
            const SizedBox(height: 28),
            FilledButton(
              onPressed: _save,
              child: Text(_isNew ? 'Add to backlog' : 'Save'),
            ),
          ],
        ),
      ),
    );
  }

  TextStyle _label(PandaTokens tokens) => TextStyle(
        color: tokens.muted,
        fontSize: 11,
        fontWeight: FontWeight.w700,
        letterSpacing: 0.6,
      );
}

/// Inline evidence, using the same encrypted media fetch and cache as fullscreen.
/// Legacy attachments without a path retain their filename and remove action.
class _AttachmentList extends StatelessWidget {
  const _AttachmentList({required this.attachments, required this.onRemove});

  final List<BacklogAttachment> attachments;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Column(
      children: [
        for (final attachment in attachments)
          Padding(
            key: ValueKey(attachment.id),
            padding: const EdgeInsets.only(bottom: 12),
            child: Material(
              color: tokens.hoverWash,
              borderRadius: tokens.radius.smR,
              child: InkWell(
                borderRadius: tokens.radius.smR,
                onTap: attachment.path.isEmpty
                    ? null
                    : () => Navigator.of(context).push<void>(
                          MaterialPageRoute(
                            fullscreenDialog: true,
                            builder: (_) => MediaViewerScreen(
                              sessionId: null,
                              path: attachment.path,
                              isVideo: attachment.kind ==
                                  BacklogAttachmentKind.video,
                              title: attachment.name,
                            ),
                          ),
                        ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (attachment.path.isNotEmpty)
                      ClipRRect(
                        borderRadius: tokens.radius.smR,
                        child: SizedBox(
                          height: 240,
                          child: MediaViewerScreen(
                            key: ValueKey(attachment.path),
                            sessionId: null,
                            path: attachment.path,
                            isVideo:
                                attachment.kind == BacklogAttachmentKind.video,
                            inline: true,
                          ),
                        ),
                      ),
                    Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 8),
                      child: Row(
                        children: [
                          Icon(
                            attachment.kind == BacklogAttachmentKind.video
                                ? Icons.videocam_outlined
                                : Icons.image_outlined,
                            size: 16,
                            color: tokens.muted,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  attachment.name,
                                  style: TextStyle(
                                      color: tokens.text, fontSize: 13),
                                  overflow: TextOverflow.ellipsis,
                                ),
                                if (attachment.caption?.isNotEmpty ?? false)
                                  Text(
                                    attachment.caption!,
                                    style: TextStyle(
                                        color: tokens.subtle, fontSize: 11),
                                  ),
                              ],
                            ),
                          ),
                          if (attachment.path.isNotEmpty)
                            Icon(Icons.chevron_right,
                                size: 16, color: tokens.subtle),
                          IconButton(
                            onPressed: () => onRemove(attachment.id),
                            icon: const Icon(Icons.close, size: 16),
                            tooltip: 'Remove',
                            visualDensity: VisualDensity.compact,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// The description as it reads: Markdown, rendered with the same widget the
/// transcript uses, on a tap target that hands the field back to the editor.
///
/// Not selectable, unlike in a transcript: a long-press to select text here
/// would fight the tap that opens the editor, and the source is one tap away
/// for anyone who wants to copy it.
class _DescriptionPreview extends StatelessWidget {
  const _DescriptionPreview({required this.markdown, required this.onEdit});

  final String markdown;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final body = markdown.trim();
    return InkWell(
      onTap: onEdit,
      borderRadius: tokens.radius.smR,
      child: Container(
        width: double.infinity,
        constraints: const BoxConstraints(minHeight: 96),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        child: body.isEmpty
            ? Text(
                'Add more detail — Markdown works here…',
                style: TextStyle(color: tokens.subtle, fontSize: 14),
              )
            : MarkdownView(data: body, selectable: false),
      ),
    );
  }
}
