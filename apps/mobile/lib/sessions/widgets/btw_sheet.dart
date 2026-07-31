import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../relay/relay_api.dart';
import '../../state/providers.dart';
import '../../theme/panda_tokens.dart';
import 'markdown_view.dart';

/// One /btw round-trip: the question the phone asked and the relay command id it
/// rode out on. The answer isn't stored here — it's resolved live from the
/// command's outcome (via [commandOutcomesProvider]) so a reconnect can't lose
/// it. A pending [commandId] (null) means the enqueue is still in flight.
class BtwTurn {
  final String question;
  final String? commandId;
  const BtwTurn({required this.question, this.commandId});

  BtwTurn withCommandId(String? id) =>
      BtwTurn(question: question, commandId: id);
}

/// The "By the way" side-chat sheet. Questions run in a forked, read-only aside
/// of the session on the desktop, so the main agent keeps working untouched.
/// Request/response (not live-streamed): a turn shows a spinner until its
/// command settles, then the answer.
Future<void> showBtwSheet(
  BuildContext context, {
  required ValueNotifier<List<BtwTurn>> turns,
  required Future<void> Function(String question) onAsk,
}) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Theme.of(context).colorScheme.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => _BtwSheet(turns: turns, onAsk: onAsk),
  );
}

class _BtwSheet extends ConsumerStatefulWidget {
  const _BtwSheet({required this.turns, required this.onAsk});

  final ValueNotifier<List<BtwTurn>> turns;
  final Future<void> Function(String question) onAsk;

  @override
  ConsumerState<_BtwSheet> createState() => _BtwSheetState();
}

class _BtwSheetState extends ConsumerState<_BtwSheet> {
  final _controller = TextEditingController();
  final _scrollController = ScrollController();
  bool _sending = false;

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _ask() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    _controller.clear();
    try {
      await widget.onAsk(text);
      HapticFeedback.selectionClick();
    } finally {
      if (mounted) setState(() => _sending = false);
      _scrollToBottom();
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    // Resolve each turn's answer from its command outcome.
    final outcomes = ref.watch(commandOutcomesProvider).valueOrNull ??
        const <CommandOutcome>[];
    final byId = {
      for (final o in outcomes)
        if (o.id != null) o.id!: o,
    };
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        builder: (context, sheetScroll) {
          return Column(
            children: [
              _header(context),
              Expanded(
                child: ValueListenableBuilder<List<BtwTurn>>(
                  valueListenable: widget.turns,
                  builder: (context, turns, _) {
                    if (turns.isEmpty) return const _EmptyState();
                    _scrollToBottom();
                    return ListView.builder(
                      controller: _scrollController,
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                      itemCount: turns.length,
                      itemBuilder: (context, index) => _TurnView(
                        turn: turns[index],
                        outcome: turns[index].commandId == null
                            ? null
                            : byId[turns[index].commandId],
                      ),
                    );
                  },
                ),
              ),
              _composer(context),
            ],
          );
        },
      ),
    );
  }

  Widget _header(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
      child: Row(
        children: [
          Icon(Icons.chat_bubble_outline,
              size: 18, color: context.tokens.muted),
          SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('By the way',
                    style:
                        TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                Text(
                  'A read-only aside — the main agent keeps working.',
                  style: TextStyle(fontSize: 12, color: context.tokens.subtle),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close),
            tooltip: 'Close',
            onPressed: () => Navigator.of(context).maybePop(),
          ),
        ],
      ),
    );
  }

  Widget _composer(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: context.tokens.panelHover),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: TextField(
              controller: _controller,
              minLines: 1,
              maxLines: 5,
              autofocus: true,
              textInputAction: TextInputAction.newline,
              onSubmitted: (_) => _ask(),
              decoration: const InputDecoration(
                hintText: 'Ask about this session…',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ),
          const SizedBox(width: 8),
          IconButton.filled(
            onPressed: _sending ? null : _ask,
            tooltip: 'Ask',
            icon: _sending
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.send),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.chat_bubble_outline,
                size: 40, color: context.tokens.subtle),
            SizedBox(height: 12),
            const Text('Ask about this session',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text(
              'Questions run in a forked side-session, so the main agent keeps '
              'working untouched.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: context.tokens.subtle),
            ),
          ],
        ),
      ),
    );
  }
}

class _TurnView extends StatelessWidget {
  const _TurnView({required this.turn, required this.outcome});

  final BtwTurn turn;
  final CommandOutcome? outcome;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Question bubble, right-aligned.
          Align(
            alignment: Alignment.centerRight,
            child: Container(
              constraints: const BoxConstraints(maxWidth: 320),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: theme.colorScheme.primary.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(turn.question,
                  style: TextStyle(fontSize: 14, color: context.tokens.text)),
            ),
          ),
          const SizedBox(height: 10),
          _answer(context),
        ],
      ),
    );
  }

  Widget _answer(BuildContext context) {
    final o = outcome;
    if (o == null || !o.settled) {
      return Row(
        children: [
          SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 10),
          Text('Thinking…',
              style: TextStyle(fontSize: 13, color: context.tokens.subtle)),
        ],
      );
    }
    if (o.failed) {
      return Text(
        o.message ?? 'The /btw question failed.',
        style: TextStyle(fontSize: 13.5, color: context.tokens.danger.text),
      );
    }
    final answer = (o.message ?? '').trim();
    if (answer.isEmpty) {
      return Text('(No answer was produced.)',
          style: TextStyle(fontSize: 13.5, color: context.tokens.subtle));
    }
    return MarkdownView(data: answer);
  }
}
