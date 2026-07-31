import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../theme/panda_tokens.dart';
import '../models.dart';
import 'code_view.dart';
import 'diff_view.dart';
import 'search_highlight.dart';

/// A tool call rendered as a collapsible card: a header (icon + name + target +
/// status) always visible; the input/command/diff/output expandable. Long output
/// stays collapsed by default so a tool-heavy session stays scannable.
class ToolCallView extends StatefulWidget {
  const ToolCallView({
    super.key,
    required this.tool,
    this.fallbackBody,
    this.expandSignal,
    this.highlightQuery,
    this.activeHighlight = false,
  });

  final ToolData tool;

  /// Shown when the desktop sent no structured fields (older payloads).
  final String? fallbackBody;

  /// Expand/collapse-all command as (epoch, expand). When the epoch changes this
  /// card syncs its expansion to the broadcast value.
  final ValueListenable<(int, bool)>? expandSignal;

  /// Active search query; tints matches in the header and detail, and forces the
  /// card open when the match is inside the (normally collapsed) detail.
  final String? highlightQuery;
  final bool activeHighlight;

  @override
  State<ToolCallView> createState() => _ToolCallViewState();
}

class _ToolCallViewState extends State<ToolCallView> {
  late bool _expanded = widget.tool.status == ToolStatus.error;
  int _lastEpoch = 0;

  @override
  void initState() {
    super.initState();
    final signal = widget.expandSignal?.value;
    _lastEpoch = signal?.$1 ?? 0;
    // Tiles scroll out of the ListView and are rebuilt fresh when they return,
    // so honor the last expand-all/collapse-all command (epoch > 0) here —
    // otherwise a recycled tile ignores it and reverts to its default state.
    if (signal != null && signal.$1 > 0 && _hasDetail) {
      _expanded = signal.$2;
    }
    widget.expandSignal?.addListener(_onExpandSignal);
  }

  @override
  void didUpdateWidget(ToolCallView old) {
    super.didUpdateWidget(old);
    if (old.expandSignal != widget.expandSignal) {
      old.expandSignal?.removeListener(_onExpandSignal);
      widget.expandSignal?.addListener(_onExpandSignal);
    }
  }

  void _onExpandSignal() {
    final signal = widget.expandSignal;
    if (signal == null) return;
    final (epoch, expand) = signal.value;
    if (epoch == _lastEpoch) return;
    _lastEpoch = epoch;
    if (_hasDetail && _expanded != expand) {
      setState(() => _expanded = expand);
    }
  }

  @override
  void dispose() {
    widget.expandSignal?.removeListener(_onExpandSignal);
    super.dispose();
  }

  bool get _hasDetail =>
      widget.tool.command != null ||
      widget.tool.diff != null ||
      widget.tool.input != null ||
      (widget.tool.output != null && widget.tool.output!.isNotEmpty) ||
      (widget.fallbackBody != null && widget.fallbackBody!.trim().isNotEmpty);

  /// True when the search query hits inside the collapsible detail, so we force
  /// the card open to reveal the match (the header is always visible anyway).
  bool get _queryInDetail {
    final q = widget.highlightQuery;
    if (q == null || q.isEmpty) return false;
    final t = widget.tool;
    return queryMatches(t.command, q) ||
        queryMatches(t.input, q) ||
        queryMatches(t.output, q) ||
        queryMatches(t.diff, q) ||
        queryMatches(widget.fallbackBody, q);
  }

  bool get _showExpanded => (_expanded || _queryInDetail) && _hasDetail;

  @override
  Widget build(BuildContext context) {
    final t = widget.tool;
    final query = widget.highlightQuery;
    final active = widget.activeHighlight;
    final showExpanded = _showExpanded;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: context.tokens.panelHover,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: context.tokens.lineSoft),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: _hasDetail
                ? () => setState(() => _expanded = !_expanded)
                : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(
                children: [
                  Icon(_iconFor(t.category),
                      size: 18, color: context.tokens.muted),
                  SizedBox(width: 8),
                  Expanded(
                    child: RichText(
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      text: TextSpan(
                        style: DefaultTextStyle.of(context).style,
                        children: [
                          ...highlightSpans(
                            t.name,
                            query,
                            baseStyle: TextStyle(fontWeight: FontWeight.w600),
                            active: active,
                          ),
                          if (_target(t) != null)
                            ...highlightSpans(
                              '  ${_target(t)}',
                              query,
                              baseStyle: TextStyle(
                                color: context.tokens.subtle,
                                fontFamily: 'monospace',
                                fontSize: 12,
                              ),
                              active: active,
                            ),
                        ],
                      ),
                    ),
                  ),
                  _StatusChip(status: t.status, exitCode: t.exitCode),
                  if (_hasDetail)
                    Icon(showExpanded ? Icons.expand_less : Icons.expand_more,
                        size: 18, color: context.tokens.subtle),
                ],
              ),
            ),
          ),
          if (showExpanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (t.command != null)
                    _ToolDetailSection(
                      label: 'Command',
                      child: _ToolBody(
                        body: t.command!,
                        defaultLanguage: 'bash',
                        highlightQuery: query,
                        activeHighlight: active,
                      ),
                    ),
                  if (t.input != null && t.command == null)
                    _ToolDetailSection(
                      label: 'Input',
                      child: _ToolBody(
                        body: t.input!,
                        highlightQuery: query,
                        activeHighlight: active,
                      ),
                    ),
                  if (t.diff != null)
                    _ToolDetailSection(
                      label: 'Diff',
                      child: DiffView(
                        diff: t.diff!,
                        highlightQuery: query,
                        activeHighlight: active,
                      ),
                    ),
                  if (t.output != null && t.output!.isNotEmpty)
                    _ToolDetailSection(
                      label: 'Output',
                      child: _ToolBody(
                        body: t.output!,
                        maxLines: 20,
                        highlightQuery: query,
                        activeHighlight: active,
                      ),
                    ),
                  if (!_hasStructuredDetail && widget.fallbackBody != null)
                    _ToolDetailSection(
                      label: 'Details',
                      child: _ToolBody(
                        body: widget.fallbackBody!,
                        maxLines: 20,
                        highlightQuery: query,
                        activeHighlight: active,
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  bool get _hasStructuredDetail =>
      widget.tool.command != null ||
      widget.tool.diff != null ||
      widget.tool.input != null ||
      (widget.tool.output != null && widget.tool.output!.isNotEmpty);

  /// A one-line, scannable summary shown next to the tool name in the collapsed
  /// header (mirrors the desktop's inline preview): the file path when there is
  /// one, else the first meaningful line of the command / input / output.
  String? _target(ToolData t) {
    if (t.filePath != null && t.filePath!.trim().isNotEmpty) {
      return t.filePath!.trim();
    }
    final source = t.command ?? t.input ?? t.output;
    if (source == null) return null;
    final line = source
        .split('\n')
        .map((l) => l.trim())
        .firstWhere((l) => l.isNotEmpty, orElse: () => '');
    if (line.isEmpty) return null;
    // Strip a fence opener so a JSON-wrapped arg doesn't preview as "```json".
    if (line.startsWith('```')) return null;
    return line.length > 100 ? '${line.substring(0, 99)}…' : line;
  }

  IconData _iconFor(ToolCategory c) => switch (c) {
        ToolCategory.bash => Icons.terminal,
        ToolCategory.edit => Icons.edit_document,
        ToolCategory.read => Icons.description_outlined,
        ToolCategory.search => Icons.search,
        ToolCategory.web => Icons.public,
        ToolCategory.task => Icons.smart_toy_outlined,
        ToolCategory.other => Icons.build_outlined,
      };
}

class _ToolDetailSection extends StatelessWidget {
  const _ToolDetailSection({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 5),
            child: Text(
              label,
              style: TextStyle(
                color: context.tokens.subtle,
                fontSize: 11,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.2,
              ),
            ),
          ),
          child,
        ],
      ),
    );
  }
}

/// Renders a tool call's command/input/output. The desktop pre-formats these as
/// markdown-ish text and wraps structured args in a single ```lang fenced block;
/// this strips that fence so the code highlights cleanly instead of showing the
/// literal backticks, and falls back to plain monospace for raw terminal text.
class _ToolBody extends StatelessWidget {
  const _ToolBody({
    required this.body,
    this.defaultLanguage,
    this.maxLines,
    this.highlightQuery,
    this.activeHighlight = false,
  });

  final String body;
  final String? defaultLanguage;
  final int? maxLines;
  final String? highlightQuery;
  final bool activeHighlight;

  @override
  Widget build(BuildContext context) {
    final (code, language) = _unfence(body);
    return CodeView(
      code: code,
      language: language ?? defaultLanguage,
      maxLines: maxLines,
      highlightQuery: highlightQuery,
      activeHighlight: activeHighlight,
    );
  }

  /// Unwraps a body that is a single fenced code block into (code, language).
  /// Anything else is returned as-is with no language.
  static (String, String?) _unfence(String body) {
    final match =
        RegExp(r'^```([\w+-]*)\n([\s\S]*?)\n?```$').firstMatch(body.trim());
    if (match == null) return (body, null);
    final lang = (match.group(1) ?? '').trim();
    return (match.group(2) ?? '', lang.isEmpty ? null : lang);
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status, required this.exitCode});

  final ToolStatus status;
  final int? exitCode;

  @override
  Widget build(BuildContext context) {
    final (Color color, Widget child) = switch (status) {
      ToolStatus.running => (
          context.tokens.info.text,
          SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      ToolStatus.success => (
          context.tokens.run.text,
          Icon(Icons.check, size: 14, color: context.tokens.text)
        ),
      ToolStatus.error => (
          context.tokens.danger.text,
          Text(exitCode == null ? '!' : '$exitCode',
              style: TextStyle(fontSize: 11, color: context.tokens.text)),
        ),
      ToolStatus.unknown => (Colors.transparent, const SizedBox.shrink()),
    };
    if (status == ToolStatus.unknown) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.only(left: 6, right: 2),
      width: 20,
      height: 20,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      child: child,
    );
  }
}
