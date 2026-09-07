import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import '../../backlog/card_mentions.dart';
import '../../theme/panda_tokens.dart';
import 'code_view.dart';
import 'search_highlight.dart';

/// Markdown with fenced code blocks routed to [CodeView] (highlight + hscroll).
/// Inline code keeps the default monospace chip.
///
/// When [highlightQuery] is set, every case-insensitive occurrence of it is
/// tinted — in prose via a custom inline syntax, in fenced code via [CodeView].
/// [activeHighlight] tints this view's matches with the stronger "focused" colour
/// (used for the message the search next/prev controls are currently parked on).
class MarkdownView extends StatelessWidget {
  const MarkdownView({
    super.key,
    required this.data,
    this.selectable = true,
    this.highlightQuery,
    this.activeHighlight = false,
    this.cardNumbers,
    this.onCardTap,
  });

  final String data;
  final bool selectable;
  final String? highlightQuery;
  final bool activeHighlight;

  /// The workspace board's card numbers, so a bare `#12` in [data] can become
  /// a link. Null or empty leaves every `#12` as plain text — the common case,
  /// since most bodies never mention a card and the board is a round-trip to
  /// the Mac nobody should pay for just to render a message.
  final Set<int>? cardNumbers;

  /// Where a tapped card link goes. Linking only happens when this and
  /// [cardNumbers] are both set.
  final void Function(int number)? onCardTap;

  @override
  Widget build(BuildContext context) {
    final base = Theme.of(context).textTheme.bodyMedium;
    final query = highlightQuery;
    final highlighting = query != null && query.isNotEmpty;
    final cards = cardNumbers;
    final onTap = onCardTap;
    final linkingCards = cards != null && cards.isNotEmpty && onTap != null;
    final customSyntaxes = <md.InlineSyntax>[
      // A literal-text inline syntax that wraps query hits in a <mark> element,
      // rendered by [_HighlightMarkBuilder]. Only added while searching, so the
      // normal render path is byte-for-byte unchanged.
      if (highlighting) _HighlightSyntax(query),
      if (linkingCards) _CardRefSyntax(cards),
    ];
    return MarkdownBody(
      data: data,
      selectable: selectable,
      // Agent output leans on single newlines for line structure. Strict
      // CommonMark folds those into spaces, which reflows a stanza into one
      // run-on paragraph; desktop renders the same text with `pre-wrap`, so
      // honour soft breaks here to keep both apps reading alike.
      softLineBreak: true,
      inlineSyntaxes: customSyntaxes.isEmpty ? null : customSyntaxes,
      // Desktop agents can now put a picture in a reply as `![caption](/abs/path)`,
      // and the file lives on the Mac. flutter_markdown's default builder would
      // hand that path to Image.file and paint a broken box on a phone that has
      // no such file, so show the caption instead — the one thing that does
      // travel over the relay. Remote images stay unrendered for the same reason
      // desktop refuses them: agent output should not make the app fetch a URL.
      sizedImageBuilder: (config) {
        final alt = config.alt;
        final title = config.title;
        final label = (alt != null && alt.trim().isNotEmpty)
            ? alt.trim()
            : (title != null && title.trim().isNotEmpty)
            ? title.trim()
            : config.uri.pathSegments.isNotEmpty
            ? config.uri.pathSegments.last
            : 'image';
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.image_outlined,
                  size: 14, color: context.tokens.muted),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  label,
                  style: base?.copyWith(
                    fontSize: 12.5,
                    color: context.tokens.muted,
                  ),
                ),
              ),
            ],
          ),
        );
      },
      // Always wired, regardless of card linking: a plain http(s) link (from
      // `[text](url)` or a bare autolinked URL — flutter_markdown's default
      // GFM extension set already turns both into an `<a>`) needs somewhere to
      // go too, and without this handler a tap on one did nothing at all.
      onTapLink: (text, href, title) {
        if (href == null) return;
        final number = cardNumberFromCardRefHref(href);
        if (number != null) {
          if (linkingCards) onTap(number);
          return;
        }
        final uri = Uri.tryParse(href);
        if (uri != null && (uri.scheme == 'http' || uri.scheme == 'https')) {
          launchUrl(uri, mode: LaunchMode.externalApplication);
        }
      },
      builders: {
        'code': _CodeElementBuilder(
          highlightQuery: highlighting ? query : null,
          activeHighlight: activeHighlight,
        ),
        if (highlighting)
          'mark': _HighlightMarkBuilder(active: activeHighlight),
      },
      styleSheet: MarkdownStyleSheet(
        p: base,
        code: TextStyle(fontFamily: 'monospace', fontSize: 12.5),
        codeblockDecoration:
            const BoxDecoration(), // block styling handled by CodeView
        blockquoteDecoration: BoxDecoration(
          color: context.tokens.lineSoft,
          borderRadius: BorderRadius.circular(4),
        ),
        // Wide data tables don't fit a phone's width. The default FlexColumnWidth
        // crushes every column to an equal slice, so many-column tables wrap to
        // one character per line. IntrinsicColumnWidth sizes each column to its
        // content and — per flutter_markdown's builder — puts the whole table in
        // a horizontal SingleChildScrollView, so it stays readable and swipes
        // sideways. Trim the roomy default cell padding and shrink the body font
        // a touch so more columns land on screen before you need to scroll.
        tableColumnWidth: const IntrinsicColumnWidth(),
        tableScrollbarThumbVisibility: true,
        tableCellsPadding:
            const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        tableHead: base?.copyWith(fontSize: 13, fontWeight: FontWeight.w600),
        tableBody: base?.copyWith(fontSize: 13),
      ),
    );
  }
}

/// Matches literal occurrences of the search query in inline text (case-
/// insensitive) and emits a `<mark>` element around each hit. Registered first,
/// so it splits plain text before other inline syntaxes; it can't corrupt
/// markdown structure because the parser only runs inline syntaxes on text runs,
/// never on syntax tokens or code spans.
class _HighlightSyntax extends md.InlineSyntax {
  _HighlightSyntax(String query)
      : super(RegExp.escape(query), caseSensitive: false);

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    parser.addNode(md.Element.text('mark', match[0]!));
    return true;
  }
}

/// `#12` in prose becomes an `<a>` to that card when its number is on this
/// workspace's board — mirrors the desktop's `CardRefLink` in `inline.tsx`.
/// Off the board, [onMatch] still consumes the match (it must: the underlying
/// parser reruns unconsumed syntaxes at the same position forever) but emits
/// the matched text back unchanged, so an unrelated `#3` renders exactly as it
/// would with no custom syntax registered at all. A code span's backticks are
/// claimed by markdown's own `CodeSyntax` before the parser ever reaches a `#`
/// inside them, so this never fires there.
class _CardRefSyntax extends md.InlineSyntax {
  _CardRefSyntax(this.cardNumbers) : super(cardRefPattern.pattern);

  final Set<int> cardNumbers;

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final number = int.parse(match[1]!);
    if (cardNumbers.contains(number)) {
      parser.addNode(md.Element.text('a', match[0]!)
        ..attributes['href'] = '$cardRefLinkPrefix$number');
    } else {
      parser.addNode(md.Text(match[0]!));
    }
    return true;
  }
}

/// Renders a `<mark>` hit as an inline highlighted run. Returning a [Text.rich]
/// lets flutter_markdown merge it back into the surrounding paragraph's spans,
/// so text flow and wrapping are preserved (no [WidgetSpan] baseline shift).
class _HighlightMarkBuilder extends MarkdownElementBuilder {
  _HighlightMarkBuilder({required this.active});

  final bool active;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final base = parentStyle ?? preferredStyle ?? const TextStyle();
    return Text.rich(
      TextSpan(
        text: element.textContent,
        style: base.copyWith(
          backgroundColor: active ? highlightActive : highlightPassive,
          color: highlightTextColor,
        ),
      ),
    );
  }
}

class _CodeElementBuilder extends MarkdownElementBuilder {
  _CodeElementBuilder({this.highlightQuery, this.activeHighlight = false});

  final String? highlightQuery;
  final bool activeHighlight;

  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    final text = element.textContent;
    final className = element.attributes['class'];
    final isBlock = className != null || text.contains('\n');
    if (!isBlock) return null; // inline code → default rendering

    String? language;
    if (className != null && className.startsWith('language-')) {
      language = className.substring('language-'.length);
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: CodeView(
        code: text,
        language: language,
        highlightQuery: highlightQuery,
        activeHighlight: activeHighlight,
      ),
    );
  }
}
