import '../theme/panda_tokens.dart';
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:pasteboard/pasteboard.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:uuid/uuid.dart';

import '../relay/relay_api.dart';
import '../relay/relay_client.dart';
import '../state/providers.dart';
import '../widgets/toast/panda_toast.dart';
import 'export.dart';
import 'image_prep.dart';
import 'models.dart';
import 'remote_image_store.dart';
import 'session_model_sheet.dart';
import 'scroll_position_store.dart';
import 'settings_store.dart';
import 'slash_commands.dart';
import 'widgets/approval_bar.dart';
import 'widgets/btw_sheet.dart';
import 'widgets/conversation_item_view.dart';
import 'widgets/image_attachment_view.dart';
import 'widgets/prompt_sheet.dart';
import 'widgets/runtime_header.dart';
import 'widgets/session_info_sheet.dart';
import 'widgets/slash_command_palette.dart';

/// Live session view: a real Claude Code transcript. Subscribes to the relay
/// TAIL (seq cursor) for conversation deltas and to the live session row for
/// runtime status + the approval gate.
class SessionViewScreen extends ConsumerStatefulWidget {
  const SessionViewScreen({super.key, required this.row});

  final SessionRow row;

  @override
  ConsumerState<SessionViewScreen> createState() => _SessionViewScreenState();
}

class _SessionViewScreenState extends ConsumerState<SessionViewScreen>
    with WidgetsBindingObserver {
  final _items = <ConversationItem>[];
  // id -> index into [_items], kept in sync by [_sortItems]. Lets us coalesce
  // the many rows the relay appends for a single streaming message (each body
  // growth is a new seq under the same id) instead of rendering each partial.
  final _indexById = <String, int>{};
  final _promptController = TextEditingController();
  final _scrollController = ScrollController();
  final _imagePicker = ImagePicker();

  RelaySubscription? _sub;
  RelayApi? _api;
  final _attachedImages = <ConversationImage>[];
  // On-device cache of images we've sent from this phone, keyed by image id.
  // The relay never sends image bytes back, so we re-hydrate thumbnails from
  // here by parsing the ids out of round-tripped message bodies. Seeded from
  // disk on open (see [_attach]) and kept warm as new sends go out.
  final _storedImages = <String, ConversationImage>{};
  static const _uuid = Uuid();
  int _cursor =
      0; // highest seq we've appended (tail advances forward from here)
  bool _sending = false; // a send network call is currently in flight
  bool _autoFlushing = false; // guards the queued auto-flush against re-entry
  bool _approving = false;
  String? _error;

  // Optimistic-send ledger. Each locally-composed message is shown immediately
  // and recorded here (FIFO); when the server echoes it back on the tail we
  // reconcile 1:1 by canonical body, so the optimistic bubble is swapped for the
  // server copy without ever duplicating — even for identical repeated sends.
  final _pendingSends = <_PendingSend>[];

  // Transcript connection state, so the empty view can distinguish
  // "connecting", "connected but no messages", "timed out" and "errored"
  // instead of spinning forever.
  bool _connected = false;
  bool _timedOut = false;
  Timer? _loadTimeout;
  static const _connectTimeout = Duration(seconds: 12);
  static const _pageSize = 60;

  // History backfill (older messages before the initial page).
  int? _nextBeforeSeq;
  bool _historyDone = false;
  bool _loadingMore = false;

  // Scroll affordances.
  bool _atBottom = true;
  int _unseen = 0;
  // Restore the user's last read position on open; persist it (debounced) as
  // they scroll. Null once restored / when pinned to the bottom.
  double? _savedOffset;
  bool _restoredScroll = false;
  Timer? _saveScrollTimer;

  // Reconnect with backoff after a dropped tail / lifecycle resume.
  bool _reconnecting = false;
  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;

  // Haptics: fire once per transition into "needs approval".
  bool _wasNeedsApproval = false;

  // Cached chat-behavior settings (refreshed each build).
  bool _autoScroll = true;
  bool _showThinking = false;
  bool _confirmStop = false;
  bool _reduceMotion = false;

  // In-transcript search.
  bool _searching = false;
  String _transcriptQuery = '';
  final _searchController = TextEditingController();
  // Which filtered result the next/prev controls are parked on (index into the
  // visible list). One stable key per result lets us scroll it into view and
  // tint its matches with the "focused" colour.
  int _matchIndex = 0;
  final _matchKeys = <GlobalKey>[];

  // Broadcast expand/collapse-all to every ToolCallView: (epoch, expand).
  final _toolExpand = ValueNotifier<(int, bool)>((0, false));
  final _queuedMessages = <_QueuedPrompt>[];

  // /btw side-chat turns for this session. Persisted here (not in the sheet) so
  // the aside survives closing/reopening the sheet; answers resolve live from
  // the command outcomes stream.
  final _btwTurns = ValueNotifier<List<BtwTurn>>(const []);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scrollController.addListener(_onScroll);
    _attach();
  }

  /// Merge [incoming] into [_items], coalescing by id (a later, higher-seq copy
  /// of a streaming message supersedes its earlier partials) and re-sorting by
  /// logical time so a user message can't be stranded behind the reply it
  /// preceded. Keeps [_items] the canonical source for cursor/dedup/pagination.
  void _ingest(Iterable<ConversationItem> incoming) {
    for (final item in incoming) {
      final at = _indexById[item.id];
      if (at != null) {
        final existing = _items[at];
        if ((item.sequence ?? 0) >= (existing.sequence ?? 0)) {
          _items[at] = item;
        }
      } else {
        _indexById[item.id] = _items.length;
        _items.add(item);
      }
    }
    _sortItems();
  }

  void _sortItems() {
    _items.sort((a, b) {
      final byOrder = a.orderMs.compareTo(b.orderMs);
      if (byOrder != 0) return byOrder;
      return (a.sequence ?? 0).compareTo(b.sequence ?? 0);
    });
    _indexById.clear();
    for (var i = 0; i < _items.length; i++) {
      _indexById[_items[i].id] = i;
    }
  }

  /// If [item] is a user message that referenced images we sent from this
  /// device, re-attach the cached bytes (matched by id, parsed from the
  /// desktop's embedded file paths) and drop the now-redundant "Attached image
  /// file(s)" block from the displayed text. Server copies arrive imageless, so
  /// this is what makes their thumbnails survive a reload. No-op otherwise.
  ConversationItem _hydrate(ConversationItem item) {
    if (item.kind != 'user' || item.images.isNotEmpty) return item;
    final ids = _attachmentImageIds(item.body);
    if (ids.isEmpty) return item;
    final imgs = [
      for (final id in ids)
        if (_storedImages[id] != null) _storedImages[id]!,
    ];
    if (imgs.isEmpty) return item;
    return item.copyWith(images: imgs, body: _canonicalUserBody(item.body));
  }

  void _expandAllTools() =>
      _toolExpand.value = (_toolExpand.value.$1 + 1, true);
  void _collapseAllTools() =>
      _toolExpand.value = (_toolExpand.value.$1 + 1, false);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _connected) {
      // The Convex subscription can go stale in the background; re-tail from our
      // cursor so we catch anything missed while away.
      _resubscribe();
    }
  }

  Future<void> _attach() async {
    _loadTimeout?.cancel();
    _loadTimeout = Timer(_connectTimeout, () {
      if (mounted && !_connected && _error == null) {
        setState(() => _timedOut = true);
      }
    });

    try {
      final api = await ref.read(relayApiProvider.future);
      if (!mounted) return;
      if (api == null) {
        setState(() => _error = 'Relay is unavailable.');
        _loadTimeout?.cancel();
        return;
      }
      _api = api;

      // Warm the on-device image cache before rendering history so image-only
      // user messages hydrate their thumbnails on the first frame instead of
      // showing as empty bubbles.
      _storedImages
        ..clear()
        ..addAll(await RemoteImageStore.loadSession(widget.row.sessionId));

      // Load the NEWEST page first (the tail query is capped and ascending, so
      // relying on it alone would strand long sessions on their first 200
      // events). Then tail FORWARD from the newest seq we loaded.
      final page = await api.history(widget.row.sessionId, limit: _pageSize);
      // Where the user last left off (null = follow the live tail to bottom).
      final savedOffset = await ScrollPositionStore.read(widget.row.sessionId);
      if (!mounted) return;
      setState(() {
        _connected = true;
        _timedOut = false;
        _error = null;
        _reconnecting = false;
        _reconnectAttempt = 0;
        _loadTimeout?.cancel();
        _items.clear();
        _indexById.clear();
        _ingest(page.items.map(_hydrate));
        // Tail forward from the highest seq loaded (post-sort order is by
        // logical time, so the max seq isn't necessarily the last item).
        _cursor = page.items
            .fold(0, (a, e) => (e.sequence ?? 0) > a ? e.sequence! : a);
        _nextBeforeSeq = page.nextBeforeSeq;
        _historyDone = page.isDone || page.items.isEmpty;
        _savedOffset = savedOffset;
      });
      _restoreInitialScroll();
      await _subscribeTail();
    } catch (e) {
      if (!mounted) return;
      _loadTimeout?.cancel();
      _handleTailError('$e');
    }
  }

  Future<void> _subscribeTail() async {
    final api = _api;
    if (api == null) return;
    _sub?.cancel();
    _sub = await api.tailSession(
      widget.row.sessionId,
      _cursor,
      onItems: _onItems,
      onError: (message) => _handleTailError(message),
    );
  }

  /// Re-attach the tail from the current cursor (lifecycle resume / manual).
  Future<void> _resubscribe() async {
    if (_api == null) {
      await _attach();
      return;
    }
    setState(() => _reconnecting = true);
    try {
      await _subscribeTail();
      if (mounted) {
        setState(() {
          _reconnecting = false;
          _reconnectAttempt = 0;
        });
      }
    } catch (e) {
      _handleTailError('$e');
    }
  }

  void _handleTailError(String message) {
    if (!mounted) return;
    _loadTimeout?.cancel();
    // A rejected token means the pairing is gone — route back to pairing.
    if (_isAuthError(message)) {
      ref.read(pairingProvider.notifier).unpair();
      return;
    }
    if (_connected) {
      // We had data; keep showing it and quietly reconnect with backoff.
      _scheduleReconnect();
    } else {
      setState(() => _error = message);
    }
  }

  void _scheduleReconnect() {
    if (_reconnectTimer != null) return;
    _reconnectAttempt = (_reconnectAttempt + 1).clamp(1, 6);
    final delay =
        Duration(seconds: [1, 2, 4, 8, 15, 30][_reconnectAttempt - 1]);
    setState(() => _reconnecting = true);
    _reconnectTimer = Timer(delay, () async {
      _reconnectTimer = null;
      if (!mounted) return;
      try {
        await _subscribeTail();
        if (mounted) {
          setState(() {
            _reconnecting = false;
            _reconnectAttempt = 0;
          });
        }
      } catch (_) {
        _scheduleReconnect();
      }
    });
  }

  bool _isAuthError(String message) {
    final m = message.toLowerCase();
    return m.contains('mobile_not_found') ||
        m.contains('unauthorized') ||
        m.contains('invalid token') ||
        m.contains('forbidden');
  }

  void _onItems(List<ConversationItem> items) {
    if (!mounted) return;
    // The tail re-fires with the FULL result after our cursor (Convex returns
    // the whole query, not a diff), so drop sequences we already have. Hydrate
    // image-only user messages from the on-device cache as they arrive.
    final fresh =
        items.where((e) => (e.sequence ?? 0) > _cursor).map(_hydrate).toList();
    final atBottom = _isAtBottom();
    setState(() {
      _connected = true;
      _timedOut = false;
      _error = null;
      _reconnecting = false;
      _reconnectAttempt = 0;
      _loadTimeout?.cancel();
      if (fresh.isNotEmpty) {
        _reconcilePendingEchoes(fresh);
        // Count genuinely new messages (not streaming updates to ones already
        // shown) for the unseen badge before coalescing folds them in.
        final newlySeen = fresh
            .where((e) => e.kind != 'system' && !_indexById.containsKey(e.id))
            .length;
        _ingest(fresh);
        _cursor = fresh.fold(
            _cursor, (a, e) => (e.sequence ?? 0) > a ? e.sequence! : a);
        if (!atBottom) _unseen += newlySeen;
      }
    });
    // Follow the live tail with a jump (not an animation): streaming deltas
    // arrive faster than a 200ms animateTo can finish, so animating here is what
    // produced the "scroll stops, then snaps to the bottom" jank. Animation is
    // reserved for the user's own send in [_dispatch].
    if (fresh.isNotEmpty && atBottom && _autoScroll) _scrollToBottom();
  }

  Future<void> _loadEarlier() async {
    if (_loadingMore ||
        _historyDone ||
        _api == null ||
        _nextBeforeSeq == null) {
      return;
    }
    setState(() => _loadingMore = true);
    try {
      final page = await _api!.history(
        widget.row.sessionId,
        beforeSeq: _nextBeforeSeq,
        limit: _pageSize,
      );
      if (!mounted) return;
      // Preserve the visual scroll position across the prepend.
      final hadClients = _scrollController.hasClients;
      final oldMax =
          hadClients ? _scrollController.position.maxScrollExtent : 0.0;
      final oldOffset = hadClients ? _scrollController.offset : 0.0;
      setState(() {
        // Older events sort above the current head by logical time; _ingest
        // dedups any that overlap what we already hold.
        _ingest(page.items.map(_hydrate));
        _nextBeforeSeq = page.nextBeforeSeq;
        _historyDone = page.isDone;
        _loadingMore = false;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          final newMax = _scrollController.position.maxScrollExtent;
          _scrollController.jumpTo(oldOffset + (newMax - oldMax));
        }
      });
    } catch (e) {
      if (mounted) {
        setState(() => _loadingMore = false);
        _showSnack('Could not load earlier messages.',
            variant: ToastVariant.error);
      }
    }
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final atBottom = _isAtBottom();
    if (atBottom != _atBottom) {
      setState(() {
        _atBottom = atBottom;
        if (atBottom) _unseen = 0;
      });
    }
    if (_scrollController.position.pixels <= 140 &&
        !_loadingMore &&
        !_historyDone) {
      _loadEarlier();
    }
    _persistScrollDebounced();
  }

  /// Persist the read position ~half a second after scrolling settles, so we
  /// don't hammer secure storage on every frame. Clearing when pinned to the
  /// bottom means the next open follows the live tail instead of a stale spot.
  void _persistScrollDebounced() {
    _saveScrollTimer?.cancel();
    _saveScrollTimer = Timer(const Duration(milliseconds: 500), () {
      if (!_scrollController.hasClients) return;
      final id = widget.row.sessionId;
      if (_isAtBottom()) {
        ScrollPositionStore.clear(id);
      } else {
        ScrollPositionStore.write(id, _scrollController.offset);
      }
    });
  }

  Future<void> _retry() async {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _sub?.cancel();
    _sub = null;
    setState(() {
      _connected = false;
      _timedOut = false;
      _error = null;
      _reconnecting = false;
    });
    await _attach();
  }

  /// The raw feed with each tool_result folded into its tool_use, so tool calls
  /// render as single collapsible cards. Derived on read to keep [_items] the
  /// canonical source for cursor/dedup/pagination bookkeeping.
  List<ConversationItem> get _renderItems => mergeToolResults(_items);

  List<ConversationItem> get _visibleItems {
    final base = _renderItems;
    if (!_searching || _transcriptQuery.trim().isEmpty) return base;
    final q = _transcriptQuery.trim().toLowerCase();
    return base.where((item) {
      final tool = item.tool;
      final hay = [
        item.body,
        item.title ?? '',
        tool?.name ?? '',
        tool?.command ?? '',
        tool?.filePath ?? '',
        tool?.output ?? '',
      ].join(' ').toLowerCase();
      return hay.contains(q);
    }).toList();
  }

  /// Keep exactly one [GlobalKey] per visible result, reused by index across
  /// rebuilds so [_scrollToMatch] can target any result — including the live
  /// tail growing or the query narrowing the set.
  void _syncMatchKeys(int count) {
    if (_matchKeys.length < count) {
      _matchKeys
          .addAll(List.generate(count - _matchKeys.length, (_) => GlobalKey()));
    } else if (_matchKeys.length > count) {
      _matchKeys.removeRange(count, _matchKeys.length);
    }
  }

  void _onQueryChanged(String value) {
    setState(() {
      _transcriptQuery = value;
      _matchIndex = 0;
    });
    _scrollToMatch(0);
  }

  /// Step the focused match by [delta] (wrapping), then bring it into view.
  void _gotoMatch(int delta) {
    final n = _visibleItems.length;
    if (n == 0) return;
    setState(() => _matchIndex = ((_matchIndex + delta) % n + n) % n);
    _scrollToMatch(_matchIndex);
  }

  /// Scroll result [index] into view. Its key is usually already built (next/prev
  /// steps to a neighbour), so [Scrollable.ensureVisible] just works; for a far
  /// jump into an unbuilt result, approximate by proportion first, then fine-tune.
  void _scrollToMatch(int index) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || index < 0 || index >= _matchKeys.length) return;
      final ctx = _matchKeys[index].currentContext;
      if (ctx != null) {
        Scrollable.ensureVisible(
          ctx,
          alignment: 0.12,
          duration: Duration(milliseconds: _reduceMotion ? 0 : 250),
          curve: Curves.easeInOut,
        );
        return;
      }
      if (!_scrollController.hasClients) return;
      final n = _matchKeys.length;
      final frac = n <= 1 ? 0.0 : index / (n - 1);
      final max = _scrollController.position.maxScrollExtent;
      _scrollController.jumpTo((frac * max).clamp(0.0, max));
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || index >= _matchKeys.length) return;
        final c = _matchKeys[index].currentContext;
        if (c == null) return;
        Scrollable.ensureVisible(
          c,
          alignment: 0.12,
          duration: Duration(milliseconds: _reduceMotion ? 0 : 200),
          curve: Curves.easeOut,
        );
      });
    });
  }

  Widget _buildTranscript(double chatTextScale) {
    if (_items.isNotEmpty) {
      final visible = _visibleItems;
      final searching = _searching && _transcriptQuery.trim().isNotEmpty;
      final query = searching ? _transcriptQuery.trim() : null;
      // A leading slot for the "load earlier" affordance (hidden while filtering).
      final showHeader = !searching;
      if (searching) _syncMatchKeys(visible.length);
      final activeIndex =
          visible.isEmpty ? -1 : _matchIndex.clamp(0, visible.length - 1);
      return MediaQuery(
        // Scale only the transcript text, not the app chrome, so the user's
        // chat text-size preference applies here alone.
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(chatTextScale)),
        child: searching && visible.isEmpty
            ? _TranscriptNotice(
                icon: Icons.search_off,
                title: 'No matches',
                message: 'Nothing in this transcript matches '
                    '“${_transcriptQuery.trim()}”.',
              )
            : ListView.builder(
                controller: _scrollController,
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
                itemCount: visible.length + (showHeader ? 1 : 0),
                itemBuilder: (context, i) {
                  if (showHeader && i == 0) return _buildHistoryHeader();
                  final visibleIndex = i - (showHeader ? 1 : 0);
                  final item = visible[visibleIndex];
                  final previous =
                      visibleIndex > 0 ? visible[visibleIndex - 1] : null;
                  final row = Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (_needsRoleDivider(previous, item))
                        _RoleDivider(userSide: item.kind == 'user'),
                      ConversationItemView(
                        item: item,
                        toolExpand: _toolExpand,
                        thinkingExpanded: _showThinking,
                        highlightQuery: query,
                        activeMatch: searching && visibleIndex == activeIndex,
                        onRetrySend: _deliver,
                      ),
                    ],
                  );
                  // Attach a stable key per result so next/prev can scroll to it.
                  if (searching && visibleIndex < _matchKeys.length) {
                    return KeyedSubtree(
                        key: _matchKeys[visibleIndex], child: row);
                  }
                  return row;
                },
              ),
      );
    }
    // A mobile-issued `start` the desktop rejected never produces a session, so
    // the tail would spin then time out with a generic message. Surface the
    // real reason (e.g. "Workspace folder does not exist.") as soon as it lands.
    final startFailure = ref.watch(startFailureProvider(widget.row.sessionId));
    if (startFailure != null) {
      return _TranscriptNotice(
        icon: Icons.error_outline,
        iconColor: Theme.of(context).colorScheme.error,
        title: 'Couldn’t start this session',
        message: startFailure.message ??
            'Your Mac rejected the launch. Check the workspace path, then try '
                'again.',
      );
    }
    if (_error != null) {
      return _TranscriptNotice(
        icon: Icons.error_outline,
        iconColor: Theme.of(context).colorScheme.error,
        title: 'Could not load the transcript',
        message: _error,
        onRetry: _retry,
      );
    }
    if (_timedOut) {
      return _TranscriptNotice(
        icon: Icons.hourglass_empty,
        title: 'Taking longer than expected',
        message: 'Still waiting for this session. Check your connection to the '
            'Mac, then try again.',
        onRetry: _retry,
      );
    }
    if (!_connected) {
      return const _TranscriptLoading();
    }
    // Connected, but the session has produced no conversation yet.
    return const _TranscriptNotice(
      icon: Icons.chat_bubble_outline,
      title: 'No messages yet',
      message: 'This session has not produced any output yet. New messages '
          'will appear here as they stream in.',
    );
  }

  Widget _buildHistoryHeader() {
    if (_loadingMore) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 14),
        child: Center(
          child: SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    if (_historyDone) {
      return Padding(
        padding: EdgeInsets.only(top: 4, bottom: 12),
        child: Center(
          child: Text('Beginning of conversation',
              style: TextStyle(color: context.tokens.subtle, fontSize: 12)),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Center(
        child: TextButton.icon(
          onPressed: _loadEarlier,
          icon: const Icon(Icons.history, size: 16),
          label: const Text('Load earlier messages'),
        ),
      ),
    );
  }

  bool _isAtBottom() {
    if (!_scrollController.hasClients) return true;
    final p = _scrollController.position;
    return p.pixels >= p.maxScrollExtent - 80;
  }

  /// Pin to the bottom. Defaults to an instant [jumpTo] (used to follow the live
  /// tail, where animating each streaming delta fights the next one); pass
  /// [animated] for a one-off glide after the user's own action.
  void _scrollToBottom({bool animated = false}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      final max = _scrollController.position.maxScrollExtent;
      if (animated && !_reduceMotion) {
        _scrollController.animateTo(max,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      } else {
        _scrollController.jumpTo(max);
      }
    });
    if (_unseen != 0) setState(() => _unseen = 0);
  }

  /// On first open, land where the user left off if we saved a position;
  /// otherwise snap to the bottom to follow the live tail.
  void _restoreInitialScroll() {
    if (_restoredScroll) return;
    _restoredScroll = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      final max = _scrollController.position.maxScrollExtent;
      final saved = _savedOffset;
      if (saved != null && saved < max - 80) {
        _scrollController.jumpTo(saved.clamp(0.0, max));
      } else {
        _scrollController.jumpTo(max);
      }
    });
  }

  void _showSnack(String message,
      {ToastVariant variant = ToastVariant.info,
      String? actionLabel,
      VoidCallback? onAction}) {
    if (!mounted) return;
    showToast(message,
        variant: variant, actionLabel: actionLabel, onAction: onAction);
  }

  /// Intercept `/btw <question>` before it reaches the session. Opens the aside
  /// sheet and (if a question was typed) fires it off, so the main agent is
  /// never interrupted. Returns true when the input was a /btw command.
  bool _handleBtwCommand() {
    final text = _promptController.text.trim();
    if (!RegExp(r'^/btw(\s|$)', caseSensitive: false).hasMatch(text)) {
      return false;
    }
    final rest =
        text.replaceFirst(RegExp(r'^/btw\s*', caseSensitive: false), '').trim();
    _promptController.clear();
    _openBtwSheet();
    if (rest.isNotEmpty) unawaited(_askBtw(rest));
    return true;
  }

  void _openBtwSheet() =>
      showBtwSheet(context, turns: _btwTurns, onAsk: _askBtw);

  /// Intercept `/prompt` (or `/prompts`) before it reaches the session. Opens a
  /// read-only sheet listing every prompt sent this session plus anything still
  /// queued, so the command never lands as a real prompt. Returns true when the
  /// input was a /prompt command.
  bool _handlePromptCommand() {
    final text = _promptController.text.trim();
    if (!RegExp(r'^/prompts?(\s|$)', caseSensitive: false).hasMatch(text)) {
      return false;
    }
    _promptController.clear();
    _openPromptSheet();
    return true;
  }

  /// Intercept `/export` before it reaches the session. Renders the transcript
  /// to Markdown and copies it, or — for `/export file` and named exports —
  /// hands it to the share sheet (where "Save to Files", AirDrop and Mail
  /// live), the phone's equivalent of the desktop's save dialog. Returns true
  /// when the input was an /export command.
  bool _handleExportCommand() {
    final command = parseExportCommand(_promptController.text);
    if (command == null) return false;
    _promptController.clear();
    unawaited(_exportTranscript(command));
    return true;
  }

  Future<void> _exportTranscript(ExportCommand command) async {
    final items = _renderItems;
    if (items.isEmpty) {
      _showSnack('Nothing to export yet — this session has no conversation.',
          variant: ToastVariant.info);
      return;
    }

    final row = ref.read(sessionRowProvider(widget.row.sessionId)) ?? widget.row;
    final content = serializeConversation(
      items,
      header: ExportMeta(
        title: row.title,
        cwd: row.cwd,
        runtime: row.runtime?.runtime?.name,
        model: row.runtime?.model,
      ),
    );

    if (command.target == ExportTarget.clipboard) {
      await Clipboard.setData(ClipboardData(text: content));
      _showSnack('Conversation copied to clipboard',
          variant: ToastVariant.success);
      return;
    }

    try {
      // The share sheet takes a real file, so the transcript lands in the cache
      // directory first under the name the user will see in Files/Mail. The OS
      // reclaims it on its own schedule — nothing here needs it afterwards.
      final dir = await getTemporaryDirectory();
      final name = command.filename ?? exportFilename(items);
      final file = File('${dir.path}/$name');
      await file.writeAsString(content);
      if (!mounted) return;
      await Share.shareXFiles(
        [XFile(file.path, mimeType: 'text/markdown', name: name)],
        subject: row.title,
      );
    } catch (_) {
      _showSnack('Couldn’t export this conversation.',
          variant: ToastVariant.error);
    }
  }

  /// Fill the composer from the slash palette, running the command straight
  /// away when it takes no argument.
  void _pickSlashCommand(SlashCommand command) {
    _promptController.value = TextEditingValue(
      text: command.insertText,
      selection: TextSelection.collapsed(offset: command.insertText.length),
    );
    if (command.runImmediately) unawaited(_send());
  }

  void _openPromptSheet() {
    String normalize(String value) =>
        value.replaceAll(RegExp(r'\s+'), ' ').trim();
    // Sent prompts, newest first, with the optimistic echo collapsed against
    // its server copy.
    final rawSent = _items
        .where((it) => it.kind == 'user' && it.body.trim().isNotEmpty)
        .toList()
      ..sort((a, b) => b.orderMs.compareTo(a.orderMs));
    final sent = <PromptEntry>[];
    for (final it in rawSent) {
      if (sent.isNotEmpty && normalize(sent.last.text) == normalize(it.body)) {
        continue;
      }
      sent.add(PromptEntry(
        text: it.body,
        imageCount: it.images.length,
        timeMs: it.orderMs,
        queued: false,
      ));
    }
    final queued = _queuedMessages
        .map((q) => PromptEntry(
              text: q.text,
              imageCount: q.images.length,
              timeMs: null,
              queued: true,
            ))
        .toList();
    showPromptSheet(context, sent: sent, queued: queued);
  }

  /// Enqueue a /btw question and track its turn. The answer resolves live from
  /// the command's outcome (matched by the returned command id), so the sheet
  /// can render it even after a reconnect.
  Future<void> _askBtw(String question) async {
    final api = _api;
    final trimmed = question.trim();
    if (api == null || trimmed.isEmpty) return;
    final pending = BtwTurn(question: trimmed);
    _btwTurns.value = [..._btwTurns.value, pending];
    try {
      final commandId = await api.askBtw(widget.row.sessionId, trimmed);
      final list = [..._btwTurns.value];
      final i = list.indexOf(pending);
      if (i >= 0) list[i] = pending.withCommandId(commandId);
      _btwTurns.value = list;
    } catch (_) {
      final list = [..._btwTurns.value]..remove(pending);
      _btwTurns.value = list;
      _showSnack('Couldn’t send /btw. Check your connection.',
          variant: ToastVariant.error);
    }
  }

  Future<void> _send() async {
    if (_handleBtwCommand()) return;
    if (_handlePromptCommand()) return;
    if (_handleExportCommand()) return;
    final text = _promptController.text.trim();
    final images = List<ConversationImage>.from(_attachedImages);
    if ((text.isEmpty && images.isEmpty) || _api == null) return;
    // All attachments ride inside one sealed relay command doc, which Convex
    // caps at 1 MiB. Each image is already compressed under its own budget, but
    // several together can still overflow — reject with a clear message rather
    // than let the send fail silently.
    final totalBytes =
        images.fold<int>(0, (sum, image) => sum + image.bytes.lengthInBytes);
    if (totalBytes > kMaxTotalAttachmentBytes) {
      _showSnack('Too many images to send at once — remove one and try again.',
          variant: ToastVariant.error);
      return;
    }
    if (_isWorking()) {
      setState(() {
        _queuedMessages.add(
          _QueuedPrompt(
            id: DateTime.now().microsecondsSinceEpoch.toString(),
            text: text,
            images: images,
          ),
        );
        _promptController.clear();
        _attachedImages.clear();
      });
      HapticFeedback.selectionClick();
      _showSnack('Queued. Tap send now to steer the current turn.');
      return;
    }
    // Optimistic: clear the composer NOW and show the bubble before the network
    // round-trip. Reading the controller here (not inside _dispatch) means a
    // double-tap re-enters with empty text and no-ops.
    _promptController.clear();
    _attachedImages.clear();
    unawaited(_dispatch(text, images));
  }

  /// Show [text]/[images] as a "sending" user bubble immediately, record the
  /// send in [_pendingSends] for later reconciliation, then deliver it. The
  /// bubble appears in one frame regardless of network latency, so the scroll is
  /// consistent and there's no blocking spinner.
  Future<void> _dispatch(String text, List<ConversationImage> images) async {
    final now = DateTime.now();
    final localId = 'local:${now.microsecondsSinceEpoch}';
    final body = text.isEmpty ? 'Please inspect the attached image(s).' : text;
    // Keep a device-local copy of every attachment so this message re-renders
    // its thumbnails after a reload — the relay never sends the bytes back.
    for (final image in images) {
      _storedImages[image.id] = image;
      unawaited(RemoteImageStore.put(widget.row.sessionId, image));
    }
    setState(() {
      _pendingSends.add(_PendingSend(
        localId: localId,
        text: text,
        images: images,
        canonicalBody: _canonicalUserBody(body),
      ));
      _ingest([
        ConversationItem(
          id: localId,
          kind: 'user',
          title: null,
          body: body,
          sequence: null,
          model: null,
          thinking: false,
          tool: null,
          images: images,
          createdAt: now.millisecondsSinceEpoch,
          timestamp: now.millisecondsSinceEpoch,
          sendState: SendState.sending,
        ),
      ]);
    });
    _scrollToBottom(animated: true);
    await _deliver(localId);
  }

  /// Deliver the pending send identified by [localId] to the relay. On success
  /// the optimistic bubble drops its spinner (the server echo reconciles it away
  /// shortly after); on failure it flips to a tap-to-retry state.
  Future<void> _deliver(String localId) async {
    final at = _pendingSends.indexWhere((p) => p.localId == localId);
    if (at < 0 || _api == null) return;
    final pending = _pendingSends[at];
    pending.failed = false;
    setState(() => _sending = true);
    _setSendState(localId, SendState.sending);
    try {
      pending.commandId = await _api!.sendInput(
        widget.row.sessionId,
        pending.text,
        images: pending.images,
      );
      // Handed to the relay. Keep the bubble but drop the spinner; the tail echo
      // will later swap it for the canonical server copy via
      // _reconcilePendingEchoes — unless the desktop rejects the command, which
      // _applyCommandOutcomes turns back into a tap-to-retry bubble.
      _setSendState(localId, SendState.none);
    } catch (e) {
      if (!mounted) return;
      pending.failed = true;
      _setSendState(localId, SendState.failed);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Reconcile sent prompts against the desktop's verdict on them. A prompt the
  /// desktop refused (a section it couldn't restart, a workspace that moved) is
  /// never answered, so its bubble flips to tap-to-retry with the reason instead
  /// of sitting there looking delivered.
  void _applyCommandOutcomes(List<CommandOutcome> outcomes) {
    for (final outcome in outcomes) {
      if (outcome.type != 'input' || !outcome.failed || outcome.id == null) {
        continue;
      }
      final at = _pendingSends
          .indexWhere((p) => p.commandId == outcome.id && !p.failed);
      if (at < 0) continue;
      final pending = _pendingSends[at];
      pending.failed = true;
      _setSendState(pending.localId, SendState.failed);
      _showSnack(outcome.message ?? 'The Mac couldn’t deliver that message.',
          variant: ToastVariant.error);
    }
  }

  /// Update the [SendState] of the optimistic item [localId] in place (no
  /// remove/insert, so the ListView doesn't jump).
  void _setSendState(String localId, SendState state) {
    if (!mounted) return;
    final at = _indexById[localId];
    if (at == null) return;
    setState(() => _items[at] = _items[at].copyWith(sendState: state));
  }

  /// True when a turn is genuinely in flight, so a new prompt should queue
  /// behind it rather than interleave.
  ///
  /// A session that has never been prompted is NOT working, whatever its badge
  /// says. Desktop-materialized sections briefly report "working" before their
  /// first turn exists, and treating that as busy is what used to send every
  /// message into the local queue with nothing to flush behind — an unusable
  /// session. No prompt yet and no transcript means the composer sends.
  bool _isWorking() {
    final row = ref.read(sessionRowProvider(widget.row.sessionId));
    final state = row?.runtime?.agentState ?? widget.row.agentState;
    if (state != AgentState.working) return false;
    final promptedAt = row?.lastPromptAt ?? widget.row.lastPromptAt;
    if (promptedAt == null && _items.isEmpty) return false;
    return true;
  }

  /// Promote a queued message to a real send: drop it from the queue strip and
  /// dispatch it optimistically (so it becomes a user bubble). A failed delivery
  /// surfaces as a tap-to-retry bubble via [_dispatch], not a lost message.
  Future<void> _sendQueuedNow(_QueuedPrompt entry) async {
    if (_api == null) return;
    if (!_queuedMessages.any((item) => item.id == entry.id)) return;
    setState(() => _queuedMessages.removeWhere((item) => item.id == entry.id));
    await _dispatch(entry.text, entry.images);
  }

  void _removeQueuedMessage(String id) {
    setState(() => _queuedMessages.removeWhere((item) => item.id == id));
  }

  void _flushQueuedIfReady(SessionRow live, bool canInteract) {
    final state = live.runtime?.agentState ?? live.agentState;
    if (!canInteract ||
        state != AgentState.waiting ||
        _sending ||
        _autoFlushing ||
        _queuedMessages.isEmpty) {
      return;
    }
    final next = _queuedMessages.first;
    // _autoFlushing latches until the dispatch settles so the many rebuilds that
    // fire while state==waiting can't schedule this same entry twice.
    _autoFlushing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted ||
          _queuedMessages.isEmpty ||
          _queuedMessages.first.id != next.id) {
        _autoFlushing = false;
        return;
      }
      try {
        await _sendQueuedNow(next);
      } finally {
        if (mounted) _autoFlushing = false;
      }
    });
  }

  Future<void> _pickImages() async {
    if (_sending) return;
    try {
      // maxWidth/maxHeight + imageQuality make image_picker pre-shrink and
      // re-encode to JPEG natively (also sidesteps HEIC, which the `image`
      // package can't decode); prepareRelayImage then guarantees each stays
      // under the per-image budget so the sealed command doc fits Convex's cap.
      final picks = await _imagePicker.pickMultiImage(
        maxWidth: 3000,
        maxHeight: 3000,
        imageQuality: 90,
      );
      if (!mounted || picks.isEmpty) return;
      final images = <ConversationImage>[];
      for (final pick in picks) {
        final raw = await pick.readAsBytes();
        final bytes = await prepareRelayImage(raw);
        images.add(
          ConversationImage(
            id: _uuid.v4(),
            name: _jpgName(pick.name),
            mimeType: 'image/jpeg',
            bytes: bytes,
          ),
        );
      }
      if (mounted) {
        setState(() => _attachedImages.addAll(images));
      }
    } catch (e) {
      if (mounted) {
        _showSnack('Image attach failed', variant: ToastVariant.error);
      }
    }
  }

  /// Attach a photo taken right now. Same shrink/re-encode path as
  /// [_pickImages] — the camera hands back a full-resolution capture, so the
  /// size caps matter here even more than for library picks.
  Future<void> _takePhoto() async {
    if (_sending) return;
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
      final stamp = DateTime.now().millisecondsSinceEpoch;
      setState(() => _attachedImages.add(
            ConversationImage(
              id: _uuid.v4(),
              name: 'photo-$stamp.jpg',
              mimeType: 'image/jpeg',
              bytes: bytes,
            ),
          ));
    } catch (e) {
      if (mounted) {
        _showSnack('Camera capture failed', variant: ToastVariant.error);
      }
    }
  }

  /// Attach an image from the clipboard. Flutter's built-in [Clipboard] only
  /// reads text, so iOS/Android's paste menu can't offer image paste (it just
  /// shows "Scan Text"); [Pasteboard.image] reaches the native pasteboard.
  Future<void> _pasteImage() async {
    if (_sending) return;
    try {
      final raw = await Pasteboard.image;
      if (!mounted) return;
      if (raw == null || raw.isEmpty) {
        _showSnack('No image on the clipboard', variant: ToastVariant.info);
        return;
      }
      // Pasteboard hands back raw (often large) PNG bytes; compress before
      // attaching so the send doesn't overflow the relay command doc.
      final bytes = await prepareRelayImage(raw);
      if (!mounted) return;
      final stamp = DateTime.now().millisecondsSinceEpoch;
      setState(() => _attachedImages.add(
            ConversationImage(
              id: _uuid.v4(),
              name: 'pasted-$stamp.jpg',
              mimeType: 'image/jpeg',
              bytes: bytes,
            ),
          ));
    } catch (e) {
      if (mounted) _showSnack('Paste failed', variant: ToastVariant.error);
    }
  }

  /// Open the attach menu from the composer. Surfaces image attach/paste right
  /// where you type — the iOS text field's native paste menu can't offer image
  /// paste, so this is the only discoverable entry point for a copied screenshot.
  void _showAttachMenu() {
    if (_sending) return;
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

  /// Rewrite an arbitrary source filename to a `.jpg` stem — we always re-encode
  /// attachments to JPEG, and the desktop derives the extension from mimeType.
  String _jpgName(String name) {
    final dot = name.lastIndexOf('.');
    final stem = dot > 0 ? name.substring(0, dot) : name;
    return '${stem.isEmpty ? 'image' : stem}.jpg';
  }

  void _removeImage(int index) {
    setState(() => _attachedImages.removeAt(index));
  }

  /// Reconcile server-sourced user echoes against our optimistic ledger. For
  /// each incoming user message we consume the OLDEST pending send with a
  /// matching canonical body (FIFO, one-to-one) and drop its optimistic bubble,
  /// letting the server copy take its place. Matching one pending per echo — not
  /// by set membership — means two identical messages stay two messages and a
  /// canonicalization mismatch can't strand a permanent duplicate.
  void _reconcilePendingEchoes(List<ConversationItem> incoming) {
    if (_pendingSends.isEmpty) return;
    final removedLocalIds = <String>{};
    for (final item in incoming) {
      if (item.kind != 'user') continue;
      final canon = _canonicalUserBody(item.body);
      if (canon.isEmpty) continue;
      final i = _pendingSends
          .indexWhere((p) => !p.failed && p.canonicalBody == canon);
      if (i < 0) continue;
      removedLocalIds.add(_pendingSends.removeAt(i).localId);
    }
    if (removedLocalIds.isEmpty) return;
    _items.removeWhere((item) => removedLocalIds.contains(item.id));
    // Indices shift after removal; the following _ingest re-sorts and rebuilds
    // the id map, but rebuild now in case no fresh items follow.
    _sortItems();
  }

  Future<void> _stop() async {
    if (_confirmStop) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Stop this session?'),
          content: const Text(
              'The agent will be interrupted. You can start a new session anytime.'),
          actions: [
            TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('Cancel')),
            FilledButton(
                onPressed: () => Navigator.of(ctx).pop(true),
                child: const Text('Stop')),
          ],
        ),
      );
      if (ok != true) return;
    }
    _api?.stopSession(widget.row.sessionId);
  }

  /// The single "session actions" menu, as a bottom sheet. Subscribe rides an
  /// embedded switch (so its state reads at a glance and the sheet stays open
  /// when toggled); everything else is a tap-and-dismiss row.
  void _showActionsSheet(SessionRow live, bool canInteract) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      // Scroll-controlled + a scroll view so a tall list of actions (which grew
      // once "Switch model" landed) can scroll instead of being clipped by the
      // default half-height sheet.
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        top: false,
        child: Consumer(
          builder: (context, ref, _) {
            // Watch the live row so the switch flips in place after toggling.
            final current =
                ref.watch(sessionRowProvider(widget.row.sessionId)) ?? live;
            void run(VoidCallback action) {
              Navigator.of(sheetContext).pop();
              action();
            }

            return SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SwitchListTile(
                    secondary: Icon(current.subscribed
                        ? Icons.notifications_active_outlined
                        : Icons.notifications_off_outlined),
                    title: const Text('Notifications'),
                    subtitle: Text(current.subscribed
                        ? 'You’ll be notified about this session'
                        : 'Muted for this session'),
                    value: current.subscribed,
                    onChanged: (_) => _toggleSubscription(current),
                  ),
                  const Divider(height: 1),
                  if (canInteract)
                    ListTile(
                      leading: const Icon(Icons.tune),
                      title: const Text('Switch model'),
                      subtitle: Text(
                        launchOptionLabel(
                          modelOptionsFor(
                              current.runtime?.runtime ?? AgentRuntime.claude),
                          current.runtime?.model,
                          'Default',
                        ),
                      ),
                      onTap: () => run(() => _switchModel(current)),
                    ),
                  if (canInteract)
                    ListTile(
                      leading: const Icon(Icons.add_photo_alternate_outlined),
                      title: const Text('Attach image'),
                      onTap: () => run(_pickImages),
                    ),
                  if (canInteract)
                    ListTile(
                      leading: const Icon(Icons.photo_camera_outlined),
                      title: const Text('Take photo'),
                      subtitle: const Text('Capture with the camera'),
                      onTap: () => run(_takePhoto),
                    ),
                  if (canInteract)
                    ListTile(
                      leading: const Icon(Icons.content_paste_outlined),
                      title: const Text('Paste image'),
                      subtitle: const Text('From a copied screenshot'),
                      onTap: () => run(_pasteImage),
                    ),
                  ListTile(
                    leading: const Icon(Icons.search),
                    title: const Text('Search transcript'),
                    onTap: () => run(() => setState(() => _searching = true)),
                  ),
                  ListTile(
                    leading: const Icon(Icons.info_outline),
                    title: const Text('Session info'),
                    trailing: _sessionInfoTokenLabel(current) == null
                        ? null
                        : Text(
                            _sessionInfoTokenLabel(current)!,
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: 13,
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurface
                                  .withValues(alpha: 0.6),
                            ),
                          ),
                    onTap: () =>
                        run(() => showSessionInfoSheet(context, current)),
                  ),
                  ListTile(
                    leading: const Icon(Icons.unfold_more),
                    title: const Text('Expand all tools'),
                    onTap: () => run(_expandAllTools),
                  ),
                  ListTile(
                    leading: const Icon(Icons.unfold_less),
                    title: const Text('Collapse all tools'),
                    onTap: () => run(_collapseAllTools),
                  ),
                  ListTile(
                    leading: const Icon(Icons.copy_all),
                    title: const Text('Copy transcript'),
                    onTap: () => run(_copyTranscript),
                  ),
                  if (canInteract)
                    ListTile(
                      leading: Icon(Icons.stop_circle,
                          color: Theme.of(context).colorScheme.error),
                      title: const Text('Stop session'),
                      onTap: () => run(_stop),
                    ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  String? _sessionInfoTokenLabel(SessionRow row) {
    final usage = row.runtime?.tokenUsage;
    if (usage == null || usage.isEmpty) return null;
    final n = usage.total;
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M tokens';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k tokens';
    return '$n tokens';
  }

  /// Open the mid-session model/effort/permission selector and, on apply, tell
  /// the desktop to switch. The change lands on the next message (the desktop
  /// resumes the section with the new settings), so we message that clearly.
  Future<void> _switchModel(SessionRow live) async {
    if (_api == null) return;
    final runtime = live.runtime?.runtime ?? AgentRuntime.claude;
    final override = await showModelSwitchSheet(
      context,
      runtime: runtime,
      currentModel: live.runtime?.model,
    );
    if (override == null || !override.hasChanges || _api == null) return;
    HapticFeedback.selectionClick();
    try {
      await _api!.switchLaunch(
        widget.row.sessionId,
        runtime: override.runtime,
        model: override.model,
        effort: override.effort,
        permissionMode: override.permissionMode,
      );
      if (mounted) {
        final targetRuntime = override.runtime ?? runtime;
        final String label;
        if (override.runtime != null) {
          label = 'Switched to ${agentRuntimeLabel(override.runtime!)}';
        } else if (override.model != null) {
          label = 'Model set to '
              '${launchOptionLabel(modelOptionsFor(targetRuntime), override.model, 'Default')}';
        } else {
          label = 'Settings updated';
        }
        _showSnack('$label — applies to your next message',
            variant: ToastVariant.success);
      }
    } catch (_) {
      if (mounted) {
        _showSnack('Couldn’t switch model. Try again.',
            variant: ToastVariant.error, onAction: () => _switchModel(live));
      }
    }
  }

  Future<void> _toggleSubscription(SessionRow live) async {
    if (_api == null) return;
    final next = !live.subscribed;
    HapticFeedback.selectionClick();
    try {
      await _api!
          .setSessionSubscription(widget.row.sessionId, subscribed: next);
      // sessions:list re-fires reactively with the new state; just confirm.
      if (mounted) {
        _showSnack(
            next
                ? 'Subscribed — you’ll be notified about this session.'
                : 'Unsubscribed from this session.',
            variant: ToastVariant.success);
      }
    } catch (e) {
      if (mounted) {
        _showSnack('Could not update notifications. Try again.',
            variant: ToastVariant.error,
            actionLabel: 'Retry',
            onAction: () => _toggleSubscription(live));
      }
    }
  }

  Future<void> _respond(
    SessionRow live,
    String? optionId,
    String? text,
  ) async {
    if (_api == null || _approving) return;
    HapticFeedback.selectionClick();
    setState(() => _approving = true);
    try {
      final approval = live.runtime?.pendingApproval;
      final promptId = approval?.promptId ?? live.runtime?.pendingPromptId;
      if (promptId == null || promptId.isEmpty) {
        throw StateError('Approval is missing its prompt id.');
      }
      ApprovalOption? selected;
      for (final option in approval?.options ?? const <ApprovalOption>[]) {
        if (option.id == optionId) {
          selected = option;
          break;
        }
      }
      final deny = selected?.isDeny == true || optionId == 'decline';
      if (deny) {
        await _api!.deny(widget.row.sessionId,
            promptId: promptId, optionId: optionId, text: text);
      } else {
        await _api!.approve(widget.row.sessionId,
            promptId: promptId, optionId: optionId, text: text);
      }
    } catch (e) {
      if (mounted) {
        _showSnack('Could not answer. Try again.',
            variant: ToastVariant.error,
            actionLabel: 'Retry',
            onAction: () => _respond(live, optionId, text));
      }
    } finally {
      if (mounted) setState(() => _approving = false);
    }
  }

  Future<void> _copyTranscript() async {
    final buf = StringBuffer();
    for (final item in _renderItems) {
      final who = switch (item.kind) {
        'user' => 'You',
        'assistant' => 'Claude',
        'tool' => 'Tool',
        _ => item.kind,
      };
      final body = item.tool != null
          ? '[${item.tool!.name}] '
              '${item.tool!.command ?? item.tool!.filePath ?? item.tool!.input ?? ''}'
          : item.body;
      if (body.trim().isEmpty) continue;
      buf.writeln('$who: ${body.trim()}');
      buf.writeln();
    }
    await Clipboard.setData(ClipboardData(text: buf.toString()));
    _showSnack('Transcript copied', variant: ToastVariant.success);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _loadTimeout?.cancel();
    _reconnectTimer?.cancel();
    _saveScrollTimer?.cancel();
    _sub?.cancel();
    _scrollController.removeListener(_onScroll);
    _promptController.dispose();
    _scrollController.dispose();
    _searchController.dispose();
    _toolExpand.dispose();
    _btwTurns.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Prefer the live row (status/runtime updates in real time); fall back to the
    // one we navigated in with.
    final live =
        ref.watch(sessionRowProvider(widget.row.sessionId)) ?? widget.row;
    final online = ref.watch(desktopOnlineProvider);
    final settings =
        ref.watch(settingsProvider).valueOrNull ?? const AppSettings();
    final chatTextScale = settings.chatTextScale;
    _autoScroll = settings.autoScroll;
    _showThinking = settings.showThinkingByDefault;
    _confirmStop = settings.confirmBeforeStop;
    _reduceMotion = settings.reduceMotion;
    final needsApproval =
        (live.runtime?.agentState ?? live.agentState) == AgentState.needsAction;
    final canInteract = online && live.status != SessionStatus.exited;
    // Sending outlives the agent process: a prompt for a section whose process
    // has exited restarts that section on the Mac (the desktop composer works
    // the same way), so the only hard requirement is a reachable Mac.
    final canSend = online;
    _flushQueuedIfReady(live, canInteract);
    // The desktop's verdict on prompts already sent from this screen.
    ref.listen<AsyncValue<List<CommandOutcome>>>(
      commandOutcomesProvider,
      (_, next) => _applyCommandOutcomes(next.valueOrNull ?? const []),
    );

    // Haptic buzz the moment a session starts waiting on us.
    if (needsApproval && !_wasNeedsApproval) HapticFeedback.mediumImpact();
    _wasNeedsApproval = needsApproval;

    // The pending tool is the most recent tool call — preview it in the bar.
    ToolData? pendingTool;
    if (needsApproval) {
      for (final i in _renderItems.reversed) {
        if (i.tool != null &&
            (i.tool!.command != null ||
                i.tool!.filePath != null ||
                i.tool!.input != null)) {
          pendingTool = i.tool;
          break;
        }
      }
    }

    return Scaffold(
      appBar: AppBar(
        title: AnimatedSwitcher(
          duration: Duration(milliseconds: _reduceMotion ? 0 : 220),
          switchInCurve: Curves.easeOut,
          switchOutCurve: Curves.easeIn,
          transitionBuilder: (child, animation) => FadeTransition(
            opacity: animation,
            child: SlideTransition(
              position: Tween<Offset>(
                begin: const Offset(0, 0.15),
                end: Offset.zero,
              ).animate(animation),
              child: child,
            ),
          ),
          child: _searching
              ? TextField(
                  key: const ValueKey('search'),
                  controller: _searchController,
                  autofocus: true,
                  onChanged: _onQueryChanged,
                  textInputAction: TextInputAction.search,
                  onSubmitted: (_) => _gotoMatch(1),
                  style: const TextStyle(fontSize: 16),
                  decoration: const InputDecoration(
                    hintText: 'Search this transcript',
                    border: InputBorder.none,
                  ),
                )
              : Text(live.title ?? live.sessionId,
                  key: const ValueKey('title'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis),
        ),
        actions: _searching
            ? [
                IconButton(
                  icon: const Icon(Icons.close),
                  tooltip: 'Close search',
                  onPressed: () => setState(() {
                    _searching = false;
                    _transcriptQuery = '';
                    _matchIndex = 0;
                    _matchKeys.clear();
                    _searchController.clear();
                  }),
                ),
              ]
            : [
                IconButton(
                  icon: Icon(Icons.chat_bubble_outline),
                  tooltip: 'By the way (/btw)',
                  onPressed: _openBtwSheet,
                ),
                IconButton(
                  icon: Icon(Icons.more_vert),
                  tooltip: 'Session actions',
                  onPressed: () => _showActionsSheet(live, canInteract),
                ),
              ],
      ),
      body: Column(
        children: [
          if (_reconnecting) const _ReconnectingBanner(),
          if (_error != null && _items.isNotEmpty)
            Container(
              width: double.infinity,
              color: context.tokens.danger.wash,
              padding: const EdgeInsets.all(8),
              child: Row(
                children: [
                  Expanded(
                      child: Text(_error!,
                          style: TextStyle(color: context.tokens.text))),
                  IconButton(
                    icon:
                        Icon(Icons.close, size: 16, color: context.tokens.text),
                    onPressed: () => setState(() => _error = null),
                  ),
                ],
              ),
            ),
          if (_searching && _transcriptQuery.trim().isNotEmpty)
            Builder(builder: (context) {
              final total = _visibleItems.length;
              return _SearchResultsBar(
                current: total == 0 ? 0 : _matchIndex.clamp(0, total - 1) + 1,
                total: total,
                onPrev: () => _gotoMatch(-1),
                onNext: () => _gotoMatch(1),
              );
            }),
          Expanded(
            child: Stack(
              children: [
                // Tapping anywhere in the transcript (outside a control) drops
                // the keyboard, like tapping off a text field. Translucent so
                // the ListView still receives scroll drags and child taps win.
                Positioned.fill(
                  child: GestureDetector(
                    behavior: HitTestBehavior.translucent,
                    onTap: () => FocusScope.of(context).unfocus(),
                    child: _buildTranscript(chatTextScale),
                  ),
                ),
                if (!_atBottom && _items.isNotEmpty)
                  Positioned(
                    right: 12,
                    bottom: 12,
                    child: _JumpToBottomButton(
                      unseen: _unseen,
                      onTap: () => _scrollToBottom(animated: true),
                    ),
                  ),
              ],
            ),
          ),
          RuntimeFooter(
            row: live,
            reduceMotion: _reduceMotion,
            desktopOffline: !online,
          ),
          if (needsApproval)
            ApprovalBar(
              busy: _approving,
              tool: pendingTool,
              approval: live.runtime?.pendingApproval,
              onAnswer: (optionId, text) => _respond(live, optionId, text),
            )
          else
            _Composer(
              controller: _promptController,
              sending: _sending,
              enabled: canSend,
              queueing: (live.runtime?.agentState ?? live.agentState) ==
                  AgentState.working,
              queuedMessages: _queuedMessages,
              images: _attachedImages,
              hint: !canSend
                  ? 'Mac offline'
                  : ((live.runtime?.agentState ?? live.agentState) ==
                          AgentState.working
                      ? 'Queue a follow-up…'
                      : live.status == SessionStatus.exited
                          ? 'Restart with a follow-up…'
                          : 'Send a follow-up…'),
              onRemoveImage: _removeImage,
              onAttach: _showAttachMenu,
              onSend: _send,
              onSendQueuedNow: _sendQueuedNow,
              onRemoveQueued: _removeQueuedMessage,
              onPickSlashCommand: _pickSlashCommand,
            ),
        ],
      ),
    );
  }
}

/// A message shown optimistically and awaiting its server echo. [localId] keys
/// the optimistic [ConversationItem]; [canonicalBody] is what the server echo is
/// matched against; [text]/[images] are retained so a failed send can retry.
class _PendingSend {
  _PendingSend({
    required this.localId,
    required this.text,
    required this.images,
    required this.canonicalBody,
  });

  final String localId;
  final String text;
  final List<ConversationImage> images;
  final String canonicalBody;

  /// The relay command carrying this prompt. The enqueue succeeding only means
  /// the relay took it; the desktop's verdict arrives later on this id.
  String? commandId;

  /// True once delivery has failed and not yet been retried. Failed sends never
  /// reached the desktop, so no server echo is coming for them — keep them out
  /// of reconciliation (they'd otherwise be consumed by a later identical
  /// message's echo) while still retaining text/images for retry.
  bool failed = false;
}

class _QueuedPrompt {
  const _QueuedPrompt({
    required this.id,
    required this.text,
    required this.images,
  });

  final String id;
  final String text;
  final List<ConversationImage> images;

  String get preview {
    final trimmed = text.trim();
    if (trimmed.isNotEmpty) return trimmed;
    return '${images.length} image${images.length == 1 ? '' : 's'}';
  }
}

/// The find-in-transcript results strip: match count + previous/next steppers.
/// Sits under the app bar while searching so the result set stays scannable and
/// navigable without hunting through the filtered list by hand.
class _SearchResultsBar extends StatelessWidget {
  const _SearchResultsBar({
    required this.current,
    required this.total,
    required this.onPrev,
    required this.onNext,
  });

  final int current; // 1-based index of the focused match (0 when none)
  final int total;
  final VoidCallback onPrev;
  final VoidCallback onNext;

  @override
  Widget build(BuildContext context) {
    final enabled = total > 0;
    return Container(
      width: double.infinity,
      color: context.tokens.panelHover,
      padding: const EdgeInsets.only(left: 14, right: 4),
      child: Row(
        children: [
          Text(
            enabled
                ? '$current of $total ${total == 1 ? 'result' : 'results'}'
                : 'No results',
            style: TextStyle(fontSize: 12.5, color: context.tokens.muted),
          ),
          const Spacer(),
          IconButton(
            visualDensity: VisualDensity.compact,
            iconSize: 22,
            tooltip: 'Previous match',
            onPressed: enabled ? onPrev : null,
            icon: const Icon(Icons.keyboard_arrow_up),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            iconSize: 22,
            tooltip: 'Next match',
            onPressed: enabled ? onNext : null,
            icon: const Icon(Icons.keyboard_arrow_down),
          ),
        ],
      ),
    );
  }
}

class _ReconnectingBanner extends StatelessWidget {
  const _ReconnectingBanner();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: context.tokens.warn.wash,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Row(
        children: [
          SizedBox(
            width: 13,
            height: 13,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          SizedBox(width: 10),
          Text('Reconnecting…',
              style: TextStyle(fontSize: 12.5, color: context.tokens.text)),
        ],
      ),
    );
  }
}

class _JumpToBottomButton extends StatelessWidget {
  const _JumpToBottomButton({required this.unseen, required this.onTap});

  final int unseen;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final label =
        unseen > 0 ? '$unseen new message${unseen == 1 ? '' : 's'}' : null;
    return Material(
      color: theme.colorScheme.primary,
      borderRadius: BorderRadius.circular(999),
      elevation: 3,
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Padding(
          padding: EdgeInsets.symmetric(
              horizontal: label == null ? 10 : 14, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.arrow_downward, size: 16, color: Colors.black),
              if (label != null) ...[
                const SizedBox(width: 6),
                Text(label,
                    style: const TextStyle(
                        color: Colors.black,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _TranscriptLoading extends StatelessWidget {
  const _TranscriptLoading();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          SizedBox(height: 12),
          Text('Loading transcript…',
              style: TextStyle(color: context.tokens.subtle)),
        ],
      ),
    );
  }
}

/// Centered empty/error/timeout state with an optional retry action.
class _TranscriptNotice extends StatelessWidget {
  const _TranscriptNotice({
    required this.icon,
    required this.title,
    this.message,
    this.iconColor,
    this.onRetry,
  });

  final IconData icon;
  final String title;
  final String? message;
  final Color? iconColor;
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: iconColor ?? context.tokens.subtle),
            SizedBox(height: 14),
            Text(title,
                textAlign: TextAlign.center,
                style: theme.textTheme.titleMedium),
            if (message != null) ...[
              SizedBox(height: 8),
              Text(
                message!,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: context.tokens.subtle),
              ),
            ],
            if (onRetry != null) ...[
              const SizedBox(height: 18),
              FilledButton.tonalIcon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.sending,
    required this.enabled,
    required this.queueing,
    required this.queuedMessages,
    required this.images,
    required this.hint,
    required this.onRemoveImage,
    required this.onAttach,
    required this.onSend,
    required this.onSendQueuedNow,
    required this.onRemoveQueued,
    required this.onPickSlashCommand,
  });

  final TextEditingController controller;
  final bool sending;
  final bool enabled;
  final bool queueing;
  final List<_QueuedPrompt> queuedMessages;
  final List<ConversationImage> images;
  final String hint;
  final void Function(int index) onRemoveImage;
  final VoidCallback onAttach;
  final VoidCallback onSend;
  final void Function(_QueuedPrompt entry) onSendQueuedNow;
  final void Function(String id) onRemoveQueued;
  final void Function(SlashCommand command) onPickSlashCommand;

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
              // Opens the moment the message is a bare "/word" and closes as
              // soon as it isn't — the same rule the desktop palette follows.
              ValueListenableBuilder<TextEditingValue>(
                valueListenable: controller,
                builder: (context, value, _) {
                  final matches =
                      filterSlashCommands(slashQueryOf(value.text));
                  if (matches.isEmpty) return const SizedBox.shrink();
                  return SlashCommandPalette(
                    commands: matches,
                    onPick: onPickSlashCommand,
                  );
                },
              ),
              if (queuedMessages.isNotEmpty) ...[
                _QueuedMessageStrip(
                  queuedMessages: queuedMessages,
                  sending: sending,
                  onSendNow: onSendQueuedNow,
                  onRemove: onRemoveQueued,
                ),
                const SizedBox(height: 8),
              ],
              if (images.isNotEmpty) ...[
                ImageAttachmentStrip(
                    images: images, onRemove: onRemoveImage, compact: true),
                const SizedBox(height: 8),
              ],
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  // Attach/paste lives here because iOS's native text paste menu
                  // can't offer image paste — this is the discoverable entry point.
                  IconButton(
                    onPressed: enabled && !sending ? onAttach : null,
                    tooltip: 'Attach or paste image',
                    icon: const Icon(Icons.add_photo_alternate_outlined),
                    constraints: t.control.tapTarget,
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: TextField(
                      controller: controller,
                      enabled: enabled,
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
                  // No blocking spinner: the composer clears the instant you tap
                  // and the sent bubble carries its own "sending" affordance, so
                  // the button stays live and ready for the next message.
                  // Brass to send, amber to queue — the same two states the desktop
                  // composer FAB uses, so the colour tells you which one will happen
                  // before you commit to the tap.
                  IconButton.filled(
                    onPressed: enabled ? onSend : null,
                    tooltip: queueing ? 'Queue message' : 'Send message',
                    icon: Icon(queueing ? Icons.schedule_send : Icons.send),
                    constraints: t.control.tapTarget,
                    style: IconButton.styleFrom(
                      backgroundColor: queueing ? t.warn.solid : t.accent.solid,
                      foregroundColor: queueing ? t.warn.on : t.accent.on,
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

class _QueuedMessageStrip extends StatelessWidget {
  const _QueuedMessageStrip({
    required this.queuedMessages,
    required this.sending,
    required this.onSendNow,
    required this.onRemove,
  });

  final List<_QueuedPrompt> queuedMessages;
  final bool sending;
  final void Function(_QueuedPrompt entry) onSendNow;
  final void Function(String id) onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: context.tokens.warn.wash,
        border: Border.all(color: context.tokens.warn.edge),
        borderRadius: context.tokens.radius.mdR,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < queuedMessages.length; i++) ...[
            _QueuedMessageRow(
              index: i + 1,
              entry: queuedMessages[i],
              sending: sending,
              onSendNow: onSendNow,
              onRemove: onRemove,
            ),
            if (i != queuedMessages.length - 1)
              Divider(height: 8, color: context.tokens.lineSoft),
          ],
        ],
      ),
    );
  }
}

class _QueuedMessageRow extends StatelessWidget {
  const _QueuedMessageRow({
    required this.index,
    required this.entry,
    required this.sending,
    required this.onSendNow,
    required this.onRemove,
  });

  final int index;
  final _QueuedPrompt entry;
  final bool sending;
  final void Function(_QueuedPrompt entry) onSendNow;
  final void Function(String id) onRemove;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 22,
          height: 22,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: context.tokens.lineSoft,
          ),
          child: Text('$index',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600)),
        ),
        SizedBox(width: 8),
        Expanded(
          child: Text(
            entry.preview,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12.5, color: context.tokens.muted),
          ),
        ),
        if (entry.images.isNotEmpty) ...[
          SizedBox(width: 6),
          Icon(Icons.image_outlined, size: 15, color: context.tokens.subtle),
        ],
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: 'Send now',
          onPressed: sending ? null : () => onSendNow(entry),
          icon: const Icon(Icons.flash_on, size: 18),
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: 'Remove queued message',
          onPressed: () => onRemove(entry.id),
          icon: const Icon(Icons.close, size: 18),
        ),
      ],
    );
  }
}

bool _needsRoleDivider(ConversationItem? previous, ConversationItem current) {
  final before = _messageLane(previous);
  final after = _messageLane(current);
  return before != null && after != null && before != after;
}

String? _messageLane(ConversationItem? item) {
  if (item == null) return null;
  if (item.kind == 'user') return 'user';
  if (item.tool != null || item.thinking || item.kind == 'assistant') {
    return 'assistant';
  }
  return null;
}

class _RoleDivider extends StatelessWidget {
  const _RoleDivider({required this.userSide});

  final bool userSide;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 12, 2, 8),
      child: Row(
        children: [
          Expanded(child: Divider(color: context.tokens.lineSoft, height: 1)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(userSide ? Icons.person_outline : Icons.auto_awesome,
                    size: 13, color: context.tokens.subtle),
                SizedBox(width: 5),
                Text(
                  userSide ? 'You' : 'Model',
                  style: TextStyle(
                    color: context.tokens.subtle,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          Expanded(child: Divider(color: context.tokens.lineSoft, height: 1)),
        ],
      ),
    );
  }
}

String _canonicalUserBody(String value) {
  return value
      .replaceAll(
        RegExp(r'\n*Attached image files?:\s*\n+(?:\s*-\s+\/[^\n]+\n?)+',
            caseSensitive: false),
        '',
      )
      .trim();
}

/// The desktop saves each remote image as `<id><ext>` under its `remote-images/`
/// directory and lists those paths in the round-tripped message body. Pull the
/// `<id>` stems back out so we can re-hydrate the bytes from the local cache.
List<String> _attachmentImageIds(String body) =>
    _remoteImagePathPattern.allMatches(body).map((m) => m.group(1)!).toList();

final _remoteImagePathPattern =
    RegExp(r'remote-images/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+');
