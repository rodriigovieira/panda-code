import 'package:flutter/material.dart';

/// Search-match highlight palette. [highlightActive] marks the single match the
/// user is currently parked on (via the next/prev controls); [highlightPassive]
/// marks every other occurrence so the whole result set stays visible at a glance.
///
/// Deliberately NOT design tokens, and the only such exemption outside syntax
/// highlighting: this is a highlighter pen, not a UI surface. It has to stay legible
/// over arbitrary content — body text, a dark diff, a light code block — so it is an
/// opaque amber with black text in both themes rather than something that adapts.
/// Swapping it for `warn.wash` would make it vanish against a dark diff hunk.
const Color highlightActive = Color(0xFFFFB300); // amber 600, opaque
const Color highlightPassive = Color(0x59FFD54F); // translucent amber
const Color highlightTextColor = Colors.black;

/// Case-insensitive "does this text contain the query" check, null-safe on both
/// sides so callers can pass optional fields and an absent/empty query directly.
bool queryMatches(String? text, String? query) {
  if (text == null || query == null || query.isEmpty) return false;
  return text.toLowerCase().contains(query.toLowerCase());
}

/// Splits [text] into spans, wrapping each case-insensitive occurrence of
/// [query] in a highlight background. With no query (or no match) it returns a
/// single [baseStyle] span, so callers can build spans unconditionally.
///
/// [active] selects the stronger [highlightActive] colour for the focused match.
List<InlineSpan> highlightSpans(
  String text,
  String? query, {
  TextStyle? baseStyle,
  bool active = false,
}) {
  if (query == null || query.isEmpty || text.isEmpty) {
    return [TextSpan(text: text, style: baseStyle)];
  }
  final lower = text.toLowerCase();
  final q = query.toLowerCase();
  final hlStyle = (baseStyle ?? const TextStyle()).copyWith(
    backgroundColor: active ? highlightActive : highlightPassive,
    color: highlightTextColor,
  );
  final spans = <InlineSpan>[];
  var start = 0;
  while (true) {
    final i = lower.indexOf(q, start);
    if (i < 0) {
      if (start < text.length) {
        spans.add(TextSpan(text: text.substring(start), style: baseStyle));
      }
      break;
    }
    if (i > start) {
      spans.add(TextSpan(text: text.substring(start, i), style: baseStyle));
    }
    spans.add(TextSpan(text: text.substring(i, i + q.length), style: hlStyle));
    start = i + q.length;
  }
  return spans;
}
