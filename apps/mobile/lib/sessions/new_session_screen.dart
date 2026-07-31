import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:pasteboard/pasteboard.dart';
import 'package:uuid/uuid.dart';

import '../security/biometric_auth.dart';
import '../state/providers.dart';
import '../theme/panda_tokens.dart';
import '../widgets/toast/panda_toast.dart';
import 'image_prep.dart';
import 'models.dart';
import 'session_launch_form.dart';
import 'session_view_screen.dart';
import 'settings_store.dart';
import 'widgets/image_attachment_view.dart';

/// Shows a fresh create-session bottom sheet.
///
/// The sheet edits a local draft; no relay row or desktop process is created
/// until the first prompt is sent.
Future<void> showNewSessionSheet(BuildContext context, WidgetRef ref) {
  ref.read(sessionDraftProvider.notifier).clear();
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: false,
    builder: (_) => const NewSessionScreen(),
  );
}

/// The draft sheet: a session that doesn't exist yet.
///
/// This used to be a bottom sheet that popped a launch config straight into a
/// `start` command, which meant tapping "+" spawned a real agent process on the
/// Mac before a single word was typed. Those sessions showed up on both surfaces
/// as running-with-an-empty-transcript, and the phone's composer read that as
/// "busy" and queued every message instead of sending it — so the session could
/// never be talked to at all.
///
/// Now nothing leaves the phone until you send. The draft lives in
/// [sessionDraftProvider] while this sheet is open, and a fresh visit starts
/// clean: no session, relay row, or process is created until the first send.
/// Sending forwards to the real session with [Navigator.pushReplacement], so
/// Back returns to the list rather than to a spent draft.
class NewSessionScreen extends ConsumerStatefulWidget {
  const NewSessionScreen({super.key});

  @override
  ConsumerState<NewSessionScreen> createState() => _NewSessionScreenState();
}

class _NewSessionScreenState extends ConsumerState<NewSessionScreen> {
  final _promptController = TextEditingController();
  final _customModelController = TextEditingController();
  final _imagePicker = ImagePicker();
  final _uuid = const Uuid();

  bool _starting = false;

  @override
  void initState() {
    super.initState();
    // Seed the controllers from the current draft, then keep the draft in step
    // as the user types.
    final draft = ref.read(sessionDraftProvider);
    _promptController.text = draft.prompt;
    _customModelController.text = draft.customModel;
    _promptController.addListener(() => _patch(prompt: _promptController.text));
    _customModelController
        .addListener(() => _patch(customModel: _customModelController.text));
  }

  @override
  void dispose() {
    _promptController.dispose();
    _customModelController.dispose();
    super.dispose();
  }

  SessionDraft get _draft => ref.read(sessionDraftProvider);

  void _patch({
    String? workspacePath,
    String? model,
    String? customModel,
    String? effort,
    String? permissionMode,
    String? prompt,
    List<ConversationImage>? images,
  }) {
    ref.read(sessionDraftProvider.notifier).update(
          _draft.copyWith(
            workspacePath: workspacePath,
            model: model,
            customModel: customModel,
            effort: effort,
            permissionMode: permissionMode,
            prompt: prompt,
            images: images,
          ),
        );
  }

  List<WorkspaceOption> _workspaces() {
    final rows = ref.watch(sessionsStreamProvider).valueOrNull ?? const [];
    return workspaceOptionsFromSessions(rows);
  }

  /// The draft's workspace, defaulting to the most recently active one so the
  /// common case ("new session, same project") needs no picking at all.
  WorkspaceOption? _resolveWorkspace(List<WorkspaceOption> workspaces) {
    final path = _draft.workspacePath;
    if (path != null) {
      for (final w in workspaces) {
        if (w.path == path) return w;
      }
    }
    return workspaces.isEmpty ? null : workspaces.first;
  }

  Future<void> _pickWorkspace(List<WorkspaceOption> workspaces) async {
    final picked = await showWorkspacePicker(
      context,
      workspaces: workspaces,
      selected: _resolveWorkspace(workspaces),
    );
    if (picked != null && mounted) _patch(workspacePath: picked.path);
  }

  void _setRuntime(AgentRuntime runtime) {
    if (_draft.runtime == runtime) return;
    _customModelController.clear();
    ref.read(sessionDraftProvider.notifier).update(_draft.withRuntime(runtime));
  }

  Future<void> _pickImages() async {
    if (_starting) return;
    try {
      final picks = await _imagePicker.pickMultiImage(
        maxWidth: 3000,
        maxHeight: 3000,
        imageQuality: 90,
      );
      if (!mounted || picks.isEmpty) return;
      final added = <ConversationImage>[];
      for (final pick in picks) {
        final bytes = await prepareRelayImage(await pick.readAsBytes());
        added.add(ConversationImage(
          id: _uuid.v4(),
          name: _jpgName(pick.name),
          mimeType: 'image/jpeg',
          bytes: bytes,
        ));
      }
      if (mounted) _patch(images: [..._draft.images, ...added]);
    } catch (e) {
      if (mounted) {
        showToast('Image attach failed', variant: ToastVariant.error);
      }
    }
  }

  Future<void> _takePhoto() async {
    if (_starting) return;
    try {
      final shot = await _imagePicker.pickImage(
        source: ImageSource.camera,
        maxWidth: 3000,
        maxHeight: 3000,
        imageQuality: 90,
      );
      if (!mounted || shot == null) return;
      final bytes = await prepareRelayImage(await shot.readAsBytes());
      if (!mounted) return;
      _patch(images: [..._draft.images, _named(bytes, 'photo')]);
    } catch (e) {
      if (mounted) {
        showToast('Camera capture failed', variant: ToastVariant.error);
      }
    }
  }

  Future<void> _pasteImage() async {
    if (_starting) return;
    try {
      final raw = await Pasteboard.image;
      if (!mounted) return;
      if (raw == null || raw.isEmpty) {
        showToast('No image on the clipboard', variant: ToastVariant.info);
        return;
      }
      final bytes = await prepareRelayImage(raw);
      if (!mounted) return;
      _patch(images: [..._draft.images, _named(bytes, 'pasted')]);
    } catch (e) {
      if (mounted) showToast('Paste failed', variant: ToastVariant.error);
    }
  }

  ConversationImage _named(Uint8List bytes, String stem) => ConversationImage(
        id: _uuid.v4(),
        name: '$stem-${DateTime.now().millisecondsSinceEpoch}.jpg',
        mimeType: 'image/jpeg',
        bytes: bytes,
      );

  String _jpgName(String name) {
    final dot = name.lastIndexOf('.');
    final stem = dot > 0 ? name.substring(0, dot) : name;
    return '${stem.isEmpty ? 'image' : stem}.jpg';
  }

  void _showAttachMenu() {
    if (_starting) return;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.add_photo_alternate_outlined),
              title: const Text('Attach image'),
              subtitle: const Text('Choose from your photos'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                _pickImages();
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Take photo'),
              subtitle: const Text('Capture with the camera'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                _takePhoto();
              },
            ),
            ListTile(
              leading: const Icon(Icons.content_paste_outlined),
              title: const Text('Paste image'),
              subtitle: const Text('From a copied screenshot'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                _pasteImage();
              },
            ),
          ],
        ),
      ),
    );
  }

  void _removeImage(int index) {
    final next = [..._draft.images]..removeAt(index);
    _patch(images: next);
  }

  /// Commit the draft: one `start` command carrying the launch config AND the
  /// first prompt, then replace this route with the live session.
  Future<void> _start(List<WorkspaceOption> workspaces) async {
    if (_starting) return;
    final workspace = _resolveWorkspace(workspaces);
    if (workspace == null) return;
    final draft = _draft.copyWith(workspacePath: workspace.path);
    final prompt = draft.prompt.trim();
    if (prompt.isEmpty && draft.images.isEmpty) {
      showToast('Type a first message to start the session',
          variant: ToastVariant.info);
      return;
    }
    final totalBytes = draft.images
        .fold<int>(0, (sum, image) => sum + image.bytes.lengthInBytes);
    if (totalBytes > kMaxTotalAttachmentBytes) {
      showToast('Too many images to send at once — remove one and try again.',
          variant: ToastVariant.error);
      return;
    }
    if (!ref.read(desktopOnlineProvider)) {
      showToast('Your Mac is offline.', variant: ToastVariant.warning);
      return;
    }

    // Starting a full-access session bypasses every permission check on the
    // desktop, so require a fresh Face ID (or passcode) confirmation first.
    if (isFullAccessPermissionMode(draft.permissionMode)) {
      final ok = await BiometricAuth.authenticate();
      if (!ok) {
        showToast('Face ID required to start a full-access session',
            variant: ToastVariant.error);
        return;
      }
    }
    if (!mounted) return;

    final config = draft.toConfig();
    if (config == null) return;
    setState(() => _starting = true);
    final navigator = Navigator.of(context);
    try {
      final api = await ref.read(relayApiProvider.future);
      if (api == null) throw StateError('Relay is unavailable.');
      final sessionId = await api.startSession(
        config,
        prompt: prompt,
        images: draft.images,
      );
      ref.invalidate(sessionsStreamProvider);
      // The draft became a session; a re-entry should be a clean slate.
      ref.read(sessionDraftProvider.notifier).clear();
      if (!mounted) return;
      // Replace, not push: Back from the live session belongs on the list, not
      // on a draft that has already been spent.
      navigator.pushReplacement(
        MaterialPageRoute(
          builder: (_) => SessionViewScreen(
            row: SessionRow(
              sessionId: sessionId,
              title: '${agentRuntimeLabel(config.runtime)} · ${workspace.name}',
              cwd: config.cwd,
              status: SessionStatus.idle,
              // A prompt rode along with the start, so this session really is
              // about to work — unlike the old bare `start`, where claiming
              // "working" was the lie that wedged the composer.
              agentState: AgentState.working,
              executionMode: 'stream-json',
              headSeq: 0,
              updatedAt: DateTime.now().millisecondsSinceEpoch,
              lastPromptAt: DateTime.now().millisecondsSinceEpoch,
              runtime: RuntimeBadge(
                agentState: AgentState.working,
                latestCommand:
                    config.runtime == AgentRuntime.codex ? 'codex' : 'claude',
              ),
            ),
          ),
        ),
      );
    } catch (e) {
      if (mounted) {
        setState(() => _starting = false);
        showToast('Could not start session: $e', variant: ToastVariant.error);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final theme = Theme.of(context);
    final t = context.tokens;
    final draft = ref.watch(sessionDraftProvider);
    final workspaces = _workspaces();
    final workspace = _resolveWorkspace(workspaces);
    final settings =
        ref.watch(settingsProvider).valueOrNull ?? const AppSettings();
    final online = ref.watch(desktopOnlineProvider);
    final canStart = workspace != null &&
        online &&
        !_starting &&
        (draft.prompt.trim().isNotEmpty || draft.images.isNotEmpty);

    // A draft that has never been touched adopts the user's defaults. Done here
    // rather than in initState so it also covers the first frame after the
    // settings load resolves.
    if (draft.permissionMode.isEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        if (ref.read(sessionDraftProvider).permissionMode.isNotEmpty) return;
        ref.read(sessionDraftProvider.notifier).update(
              draftFromDefaults(
                SessionDefaults(
                  runtime: settings.defaultRuntime == 'codex'
                      ? AgentRuntime.codex
                      : AgentRuntime.claude,
                  model: settings.defaultModel,
                  permissionMode: settings.defaultPermission,
                ),
                workspace?.path,
              ).copyWith(prompt: _promptController.text),
            );
      });
    }

    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: FractionallySizedBox(
        heightFactor: 0.92,
        alignment: Alignment.bottomCenter,
        child: Material(
          color: t.overlay,
          surfaceTintColor: Colors.transparent,
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: t.overlaySheen,
              border: Border(
                top: BorderSide(
                  color: t.lineSoft,
                  width: t.control.borderWidth,
                ),
              ),
              boxShadow: t.popoverElevation,
            ),
            child: Column(
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
                    children: [
                      Row(
                        children: [
                          Container(
                            width: 36,
                            height: 4,
                            decoration: BoxDecoration(
                              color: t.lineHi,
                              borderRadius: t.radius.pillR,
                            ),
                          ),
                          const Spacer(),
                          if (draft.hasContent)
                            IconButton(
                              tooltip: 'Discard draft',
                              onPressed: _starting
                                  ? null
                                  : () {
                                      ref
                                          .read(sessionDraftProvider.notifier)
                                          .clear();
                                      _promptController.clear();
                                      _customModelController.clear();
                                    },
                              icon: const Icon(Icons.delete_outline),
                            ),
                          IconButton(
                            tooltip: 'Close',
                            onPressed: _starting
                                ? null
                                : () => Navigator.of(context).pop(),
                            icon: const Icon(Icons.close),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            width: 40,
                            height: 40,
                            decoration: BoxDecoration(
                              color: t.accent.wash,
                              borderRadius: t.radius.mdR,
                              border: Border.all(
                                color: t.accent.edge,
                                width: t.control.borderWidth,
                              ),
                            ),
                            child:
                                Icon(Icons.add, size: 22, color: t.accent.text),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'New session',
                                  style: theme.textTheme.titleLarge
                                      ?.copyWith(fontWeight: FontWeight.w700),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  workspace == null
                                      ? 'No workspace available'
                                      : workspace.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodySmall
                                      ?.copyWith(color: t.subtle),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      if (!online) ...[
                        const SizedBox(height: 14),
                        _OfflineNotice(textColor: t.warn.text),
                      ],
                      const SizedBox(height: 18),
                      SessionLaunchForm(
                        workspaces: workspaces,
                        workspace: workspace,
                        runtime: draft.runtime,
                        model: draft.model,
                        effort: draft.effort,
                        permissionMode: draft.permissionMode,
                        customModelController: _customModelController,
                        onPickWorkspace: () => _pickWorkspace(workspaces),
                        onRuntimeChanged: _setRuntime,
                        onModelChanged: (value) =>
                            _patch(model: value, customModel: ''),
                        onEffortChanged: (value) => _patch(effort: value),
                        onPermissionChanged: (value) =>
                            _patch(permissionMode: value),
                      ),
                    ],
                  ),
                ),
                _DraftComposer(
                  controller: _promptController,
                  images: draft.images,
                  enabled: !_starting,
                  starting: _starting,
                  canStart: canStart,
                  hint: online
                      ? 'What should it work on?'
                      : 'Your Mac is offline',
                  onAttach: _showAttachMenu,
                  onRemoveImage: _removeImage,
                  onStart: () => _start(workspaces),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _OfflineNotice extends StatelessWidget {
  const _OfflineNotice({required this.textColor});

  final Color textColor;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: t.warn.wash,
        borderRadius: t.radius.mdR,
        border: Border.all(color: t.warn.edge, width: t.control.borderWidth),
      ),
      child: Row(
        children: [
          Icon(Icons.cloud_off_outlined, size: 18, color: textColor),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              'Your Mac is offline',
              style: TextStyle(color: textColor, fontSize: 12.5),
            ),
          ),
        ],
      ),
    );
  }
}

/// The draft's composer. Same shape as the session composer, but its action
/// starts the session rather than sending into one — and it can never "queue",
/// because there is no turn in flight to queue behind.
class _DraftComposer extends StatelessWidget {
  const _DraftComposer({
    required this.controller,
    required this.images,
    required this.enabled,
    required this.starting,
    required this.canStart,
    required this.hint,
    required this.onAttach,
    required this.onRemoveImage,
    required this.onStart,
  });

  final TextEditingController controller;
  final List<ConversationImage> images;
  final bool enabled;
  final bool starting;
  final bool canStart;
  final String hint;
  final VoidCallback onAttach;
  final void Function(int index) onRemoveImage;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return SafeArea(
      top: false,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: t.panel,
          border: Border(
              top: BorderSide(color: t.lineSoft, width: t.control.borderWidth)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (images.isNotEmpty) ...[
                ImageAttachmentStrip(
                    images: images, onRemove: onRemoveImage, compact: true),
                const SizedBox(height: 8),
              ],
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  IconButton(
                    onPressed: enabled ? onAttach : null,
                    tooltip: 'Attach or paste image',
                    icon: const Icon(Icons.add_photo_alternate_outlined),
                    constraints: t.control.tapTarget,
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: TextField(
                      controller: controller,
                      enabled: enabled,
                      autofocus: true,
                      minLines: 1,
                      maxLines: 6,
                      keyboardType: TextInputType.multiline,
                      textInputAction: TextInputAction.newline,
                      decoration: InputDecoration(
                        hintText: hint,
                        border: const OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: canStart ? onStart : null,
                    tooltip: 'Start session',
                    icon: starting
                        ? SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                                strokeWidth: 2, color: t.accent.on),
                          )
                        : const Icon(Icons.arrow_upward),
                    constraints: t.control.tapTarget,
                    style: IconButton.styleFrom(
                      backgroundColor: t.accent.solid,
                      foregroundColor: t.accent.on,
                      disabledBackgroundColor: t.panelStrong,
                      disabledForegroundColor: t.subtle,
                      shape: RoundedRectangleBorder(borderRadius: t.radius.lgR),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
