import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:highlight/highlight.dart' show highlight, Node;

import '../../state/providers.dart';
import '../../theme/panda_tokens.dart';
import '../../widgets/toast/panda_toast.dart';
import 'code_themes.dart';
import 'search_highlight.dart';

const _mono = 'monospace';

/// Monospace code with optional syntax highlighting, in a horizontal scroll so
/// long lines / terminal output don't wrap or clip. Code is the dominant content
/// in a coding session, so this is a first-class widget, not a markdown detail.
/// The highlight theme follows the user's code-theme setting.
class CodeView extends ConsumerWidget {
  const CodeView({
    super.key,
    required this.code,
    this.language,
    this.maxLines,
    this.highlightQuery,
    this.activeHighlight = false,
  });

  final String code;
  final String? language;

  /// When set, collapses tall output to this many lines with a fade (used for
  /// long tool output). Null = show all.
  final int? maxLines;

  /// When set, occurrences are tinted on top of syntax highlighting so search
  /// matches inside code / tool output are visible. [activeHighlight] uses the
  /// stronger focused colour.
  final String? highlightQuery;
  final bool activeHighlight;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeId =
        ref.watch(settingsProvider).valueOrNull?.codeTheme ?? 'atom-one-dark';
    final codeTheme = codeThemeById(themeId);
    final trimmed = code.replaceAll(RegExp(r'\s+$'), '');
    final query = highlightQuery;
    final searching = query != null && query.isNotEmpty;
    final lang =
        (language == null || language!.isEmpty) ? 'plaintext' : language!;
    const textStyle = TextStyle(fontFamily: _mono, fontSize: 12.5, height: 1.4);
    Widget highlighted = searching
        ? _SearchHighlightView(
            source: trimmed.isEmpty ? ' ' : trimmed,
            language: lang,
            theme: codeTheme.theme,
            query: query,
            active: activeHighlight,
            textStyle: textStyle,
          )
        : HighlightView(
            trimmed.isEmpty ? ' ' : trimmed,
            language: lang,
            theme: codeTheme.theme,
            padding: const EdgeInsets.all(12),
            textStyle: textStyle,
          );

    // Never clip a match out of view: a search hit past [maxLines] would be
    // unreachable, so show the whole block while it's the reason we're visible.
    final effectiveMaxLines =
        searching && queryMatches(trimmed, query) ? null : maxLines;
    if (effectiveMaxLines != null) {
      highlighted = ConstrainedBox(
        constraints: BoxConstraints(maxHeight: effectiveMaxLines * 18.0 + 24),
        child: ClipRect(child: highlighted),
      );
    }

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: codeTheme.background,
        borderRadius: BorderRadius.circular(8),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _CodeToolbar(code: trimmed, language: language),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: highlighted,
          ),
        ],
      ),
    );
  }
}

/// A drop-in equivalent of `flutter_highlight`'s `HighlightView` that also tints
/// occurrences of [query] on top of syntax highlighting. It mirrors that widget's
/// node-to-span conversion, splitting each highlighted text leaf on the query so
/// search matches show through the syntax colours. Used only while searching.
class _SearchHighlightView extends StatelessWidget {
  const _SearchHighlightView({
    required this.source,
    required this.language,
    required this.theme,
    required this.query,
    required this.active,
    required this.textStyle,
  });

  final String source;
  final String language;
  final Map<String, TextStyle> theme;
  final String query;
  final bool active;
  final TextStyle textStyle;

  static const _defaultFontColor = Color(0xff000000);
  static const _defaultBackgroundColor = Color(0xffffffff);

  List<TextSpan> _convert(List<Node> nodes) {
    final spans = <TextSpan>[];
    var currentSpans = spans;
    final stack = <List<TextSpan>>[];

    void traverse(Node node) {
      if (node.value != null) {
        final base = node.className == null ? null : theme[node.className!];
        currentSpans.addAll(
          highlightSpans(node.value!, query, baseStyle: base, active: active)
              .cast<TextSpan>(),
        );
      } else if (node.children != null) {
        final tmp = <TextSpan>[];
        currentSpans
            .add(TextSpan(children: tmp, style: theme[node.className!]));
        stack.add(currentSpans);
        currentSpans = tmp;
        for (final n in node.children!) {
          traverse(n);
          if (n == node.children!.last) {
            currentSpans = stack.isEmpty ? spans : stack.removeLast();
          }
        }
      }
    }

    for (final node in nodes) {
      traverse(node);
    }
    return spans;
  }

  @override
  Widget build(BuildContext context) {
    final rootStyle = TextStyle(
      fontFamily: _mono,
      color: theme['root']?.color ?? _defaultFontColor,
    ).merge(textStyle);
    return Container(
      color: theme['root']?.backgroundColor ?? _defaultBackgroundColor,
      padding: const EdgeInsets.all(12),
      child: RichText(
        text: TextSpan(
          style: rootStyle,
          children:
              _convert(highlight.parse(source, language: language).nodes!),
        ),
      ),
    );
  }
}

class _CodeToolbar extends StatelessWidget {
  const _CodeToolbar({required this.code, required this.language});

  final String code;
  final String? language;

  @override
  Widget build(BuildContext context) {
    final label = (language == null || language!.isEmpty) ? 'text' : language!;
    return Container(
      height: 34,
      padding: const EdgeInsets.only(left: 12, right: 4),
      decoration: BoxDecoration(
        color: Color(0xFF21252B),
        border: Border(bottom: BorderSide(color: context.tokens.lineSoft)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  color: context.tokens.subtle,
                  fontSize: 11,
                  fontFamily: _mono),
            ),
          ),
          IconButton(
            tooltip: 'Copy',
            visualDensity: VisualDensity.compact,
            iconSize: 16,
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: code));
              showToast('Copied code', variant: ToastVariant.success);
            },
            icon: Icon(Icons.copy, color: context.tokens.muted),
          ),
        ],
      ),
    );
  }
}
