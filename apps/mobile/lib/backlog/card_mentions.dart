import 'backlog_models.dart';

/// `#12` mentions in the composer — the board's half of the slash palette.
///
/// A card's number is how it is named everywhere a card is talked about rather
/// than opened: the user types `#12` into a prompt, the agent resolves it
/// through `backlog_list`, and the desktop turns it back into a link. Typing
/// the number from memory always worked; this is the part that means you do not
/// have to remember it.
///
/// Pure, and in its own file, for the same reason the slash catalogue is: the
/// matching rules are the whole feature and they should be testable without a
/// widget tree.

/// The query being typed after a `#`, or null when the text does not end in one.
///
/// Matched at the end of the text rather than at the cursor: that is where
/// typing happens, and a `#` edited into the middle of a finished sentence is
/// rare enough to leave to typing the number out. Nothing after a space and no
/// second `#`, so a colour or a heading pasted into the composer does not open
/// a menu.
String? cardMentionQuery(String value) {
  final match = RegExp(r'(?:^|\s)#([^\s#]{0,40})$').firstMatch(value);
  if (match == null) return null;
  return (match.group(1) ?? '').toLowerCase();
}

/// The cards a query names, best first, capped for a phone-sized list.
List<BacklogItem> filterCardMentions(String? query, List<BacklogItem> cards) {
  if (query == null) return const [];
  final matching = query.isEmpty
      ? cards
      : cards
          .where((card) =>
              '${card.number}' == query ||
              '${card.title} ${card.summary}'.toLowerCase().contains(query))
          .toList();
  return matching.take(8).toList();
}

/// Replace the `#query` being typed with the card's number.
///
/// Just `#12` goes into the prompt — not the title, not a link: it is what the
/// user typed, what the agent is told to resolve, and what the desktop renders
/// back as a link to the card. A trailing space so the sentence carries on.
String applyCardMention(String value, BacklogItem card) {
  final match = RegExp(r'(?:^|\s)#([^\s#]{0,40})$').firstMatch(value);
  if (match == null) return value;
  final head = value.substring(0, match.start);
  final separator = head.isEmpty || match.group(0)!.startsWith('#') ? '' : ' ';
  return '$head$separator#${card.number} ';
}

/// A bare `#12` in rendered prose — the other half of this file's job, and the
/// desktop's other half too (`CARD_REF_PATTERN` in `inline.tsx`). At most four
/// digits, nothing word-like on either side, so `#ff0000` (a colour), `#123456`
/// (a board with bigger problems than this), and `word#3` all stay text.
final RegExp cardRefPattern = RegExp(r'(?<![\w#])#(\d{1,4})(?![\w-])');

/// The synthetic href a rendered `#12` link carries, so a tap can be told
/// apart from an ordinary URL without a second scheme registered anywhere.
const String cardRefLinkPrefix = 'panda://backlog/';

/// The card number named by a `cardRefLinkPrefix` href, or null for anything
/// else (an external link the tap handler should leave alone).
int? cardNumberFromCardRefHref(String href) {
  if (!href.startsWith(cardRefLinkPrefix)) return null;
  return int.tryParse(href.substring(cardRefLinkPrefix.length));
}
