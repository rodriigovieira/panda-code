// DO NOT EDIT — generated from packages/design-tokens/tokens.json by packages/design-tokens/scripts/generate.mjs.
// Change the JSON and re-run `pnpm --filter @panda/design-tokens build`.
//
// Graphite & Brass — the shared Panda Code design system. Every colour, radius and
// control dimension in the mobile app comes from here; nothing hardcodes a hex.
//
// Reach these from any widget via the `context.tokens` extension at the bottom of
// this file:
//
//     final t = context.tokens;
//     Container(color: t.panel, ...)
//
// Semantics, so they stay consistent with desktop:
//   accent  brand + "this is selected". The ONLY accent. Never blue.
//   run     running / safe / approve      warn    needs you
//   danger  destructive / failed          info    working / informational
//
// ignore_for_file: use_named_constants

import 'package:flutter/material.dart';

/// Brand + selection colours. Every selected state derives from these.
@immutable
class AccentTokens {
  const AccentTokens({
    required this.solid,
    required this.on,
    required this.text,
    required this.textHi,
    required this.edge,
    required this.edgeStrong,
    required this.wash,
    required this.washStrong,
  });

  /// Filled-button background.
  final Color solid;

  /// Foreground on [solid].
  final Color on;

  /// Accent as text/icon colour. In light mode this is darkened for contrast —
  /// the raw brass fails AA on white, so never substitute [wash]'s hue here.
  final Color text;
  final Color textHi;

  /// Hairline on an accented element; [edgeStrong] is the focused/selected edge.
  final Color edge;
  final Color edgeStrong;

  /// Low-alpha fill for selected rows, chips and your own message bubbles.
  final Color wash;
  final Color washStrong;

  AccentTokens lerpTo(AccentTokens other, double t) => AccentTokens(
        solid: Color.lerp(solid, other.solid, t)!,
        on: Color.lerp(on, other.on, t)!,
        text: Color.lerp(text, other.text, t)!,
        textHi: Color.lerp(textHi, other.textHi, t)!,
        edge: Color.lerp(edge, other.edge, t)!,
        edgeStrong: Color.lerp(edgeStrong, other.edgeStrong, t)!,
        wash: Color.lerp(wash, other.wash, t)!,
        washStrong: Color.lerp(washStrong, other.washStrong, t)!,
      );

  AccentTokens copyWith({Color? solid, Color? on, Color? text, Color? textHi, Color? edge, Color? edgeStrong, Color? wash, Color? washStrong}) =>
      AccentTokens(
        solid: solid ?? this.solid,
        on: on ?? this.on,
        text: text ?? this.text,
        textHi: textHi ?? this.textHi,
        edge: edge ?? this.edge,
        edgeStrong: edgeStrong ?? this.edgeStrong,
        wash: wash ?? this.wash,
        washStrong: washStrong ?? this.washStrong,
      );
}

/// One semantic status. Used for state, never for decoration.
@immutable
class StatusTokens {
  const StatusTokens({
    required this.solid,
    required this.on,
    required this.text,
    required this.edge,
    required this.wash,
  });

  final Color solid;
  final Color on;
  final Color text;
  final Color edge;
  final Color wash;

  StatusTokens lerpTo(StatusTokens other, double t) => StatusTokens(
        solid: Color.lerp(solid, other.solid, t)!,
        on: Color.lerp(on, other.on, t)!,
        text: Color.lerp(text, other.text, t)!,
        edge: Color.lerp(edge, other.edge, t)!,
        wash: Color.lerp(wash, other.wash, t)!,
      );
}

/// The mobile radius scale — the desktop scale plus 2px.
@immutable
class RadiusTokens {
  const RadiusTokens({
    required this.sm,
    required this.md,
    required this.lg,
    required this.xl,
    required this.pill,
  });

  final double sm;
  final double md;
  final double lg;
  final double xl;
  final double pill;

  BorderRadius get smR => BorderRadius.circular(sm);
  BorderRadius get mdR => BorderRadius.circular(md);
  BorderRadius get lgR => BorderRadius.circular(lg);
  BorderRadius get xlR => BorderRadius.circular(xl);
  BorderRadius get pillR => BorderRadius.circular(pill);
}

/// Control metrics. [height] clears the 44pt iOS minimum; [iconGlyph] is the
/// app-bar icon size — desktop's 17px reads as decoration on a phone.
@immutable
class ControlTokens {
  const ControlTokens({
    required this.height,
    required this.heightSm,
    required this.borderWidth,
    required this.iconGlyph,
  });

  final double height;
  final double heightSm;
  final double borderWidth;
  final double iconGlyph;

  /// A square tap target at the full control height — use for icon buttons so
  /// they stay tappable even when the glyph inside is smaller.
  BoxConstraints get tapTarget =>
      BoxConstraints.tightFor(width: height, height: height);
}

@immutable
class ScrollTokens {
  const ScrollTokens({
    required this.thumb,
    required this.thumbHover,
    required this.width,
    required this.radius,
  });

  final Color thumb;
  final Color thumbHover;
  final double width;
  final double radius;

  ScrollTokens lerpTo(ScrollTokens other, double t) => ScrollTokens(
        thumb: Color.lerp(thumb, other.thumb, t)!,
        thumbHover: Color.lerp(thumbHover, other.thumbHover, t)!,
        width: other.width,
        radius: other.radius,
      );
}

/// The design system, reachable as `Theme.of(context).extension<PandaTokens>()`
/// or more conveniently `context.tokens`.
@immutable
class PandaTokens extends ThemeExtension<PandaTokens> {
  const PandaTokens({
    required this.appBg,
    required this.sidebar,
    required this.panelSoft,
    required this.panel,
    required this.panelStrong,
    required this.panelHover,
    required this.hoverWash,
    required this.hoverWashStrong,
    required this.scrim,
    required this.overlay,
    required this.inputBg,
    required this.lineSoft,
    required this.line,
    required this.lineHi,
    required this.text,
    required this.muted,
    required this.subtle,
    required this.placeholder,
    required this.accent,
    required this.run,
    required this.warn,
    required this.danger,
    required this.info,
    required this.agent,
    required this.focusRing,
    required this.scroll,
    required this.radius,
    required this.control,
    required this.panelSheen,
    required this.overlaySheen,
    required this.cardElevation,
    required this.buttonElevation,
    required this.popoverElevation,
  });

  /// Surfaces — a five-step ladder plus [overlay] for anything that floats.
  final Color appBg;
  final Color sidebar;
  final Color panelSoft;
  final Color panel;
  final Color panelStrong;

  /// Desktop uses this on hover; mobile uses it as the pressed/ripple colour.
  /// Same token, different trigger — which is why it is one token.
  final Color panelHover;

  /// The translucent counterpart to [panelHover], for controls with no
  /// background of their own — they tint whichever rung they sit on.
  final Color hoverWash;
  final Color hoverWashStrong;

  /// The one dim behind a modal — every barrier/scrim uses exactly this.
  final Color scrim;
  final Color overlay;
  final Color inputBg;

  /// Hairlines: [lineSoft] divides, [line] edges a component, [lineHi] is hover.
  final Color lineSoft;
  final Color line;
  final Color lineHi;

  /// Four text levels. A fifth means the layout is wrong.
  final Color text;
  final Color muted;
  final Color subtle;
  final Color placeholder;

  final AccentTokens accent;
  final StatusTokens run;
  final StatusTokens warn;
  final StatusTokens danger;
  final StatusTokens info;

  /// Entity identity — nested subagent cards, the Codex provider tag. Exempt from
  /// the one-accent rule because it labels *what a thing is*, never whether it is
  /// selected, so it can never be mistaken for the brass selection state.
  final StatusTokens agent;

  final Color focusRing;
  final ScrollTokens scroll;
  final RadiusTokens radius;
  final ControlTokens control;

  /// Inner top highlight that makes panels read as milled metal rather than flat
  /// rectangles. Null in light mode, where it would look like a rendering bug —
  /// [cardElevation] carries a real 1px shadow there instead.
  final Gradient? panelSheen;
  final Gradient? overlaySheen;

  final List<BoxShadow> cardElevation;
  final List<BoxShadow> buttonElevation;
  final List<BoxShadow> popoverElevation;

  /// The categorical series palette for charts — the ONE place a second colour is
  /// allowed. Fixed order so the same series keeps the same colour between runs.
  /// It is a data palette: nothing in it implies "selected".
  List<Color> get series =>
      [accent.text, info.text, run.text, subtle, warn.text];

  /// Dark theme values.
  static const PandaTokens dark = PandaTokens(
    appBg: Color(0xFF121315),
    sidebar: Color(0xFF17181B),
    panelSoft: Color(0xFF181A1E),
    panel: Color(0xFF1B1D21),
    panelStrong: Color(0xFF23262B),
    panelHover: Color(0xFF22252A),
    hoverWash: Color(0x0FFFFFFF),
    hoverWashStrong: Color(0x1AFFFFFF),
    scrim: Color(0x9E04060A),
    overlay: Color(0xFF1E2126),
    inputBg: Color(0xFF11151D),
    lineSoft: Color(0xFF262A31),
    line: Color(0xFF30343B),
    lineHi: Color(0xFF3D434C),
    text: Color(0xFFF0F2F4),
    muted: Color(0xFFA3ABB6),
    subtle: Color(0xFF727B88),
    placeholder: Color(0xFF5D6672),
    accent: AccentTokens(
      solid: Color(0xFF8F6B27),
      on: Color(0xFFFFF6E2),
      text: Color(0xFFD0A85D),
      textHi: Color(0xFFE7C98C),
      edge: Color(0x57D0A85D),
      edgeStrong: Color(0x9ED0A85D),
      wash: Color(0x21D0A85D),
      washStrong: Color(0x42D0A85D),
    ),
    run: StatusTokens(
      solid: Color(0xFF2F6948),
      on: Color(0xFFEAFFF2),
      text: Color(0xFF66C98B),
      edge: Color(0x4766C98B),
      wash: Color(0x2166C98B),
    ),
    warn: StatusTokens(
      solid: Color(0xFF6A5426),
      on: Color(0xFFF5E4BD),
      text: Color(0xFFDFB45F),
      edge: Color(0x47DFB45F),
      wash: Color(0x1FDFB45F),
    ),
    danger: StatusTokens(
      solid: Color(0xFF753641),
      on: Color(0xFFFFE4E8),
      text: Color(0xFFEF6A7A),
      edge: Color(0x47EF6A7A),
      wash: Color(0x1FEF6A7A),
    ),
    info: StatusTokens(
      solid: Color(0xFF2A5480),
      on: Color(0xFFEAF3FF),
      text: Color(0xFF7AB7FF),
      edge: Color(0x4D7AB7FF),
      wash: Color(0x217AB7FF),
    ),
    agent: StatusTokens(
      solid: Color(0xFF4C3475),
      on: Color(0xFFF3ECFF),
      text: Color(0xFFB78BFF),
      edge: Color(0x4DB78BFF),
      wash: Color(0x1FB78BFF),
    ),
    focusRing: Color(0x3DD0A85D),
    scroll: ScrollTokens(
      thumb: Color(0x578C97A6),
      thumbHover: Color(0x85A6B3C2),
      width: 5,
      radius: 999,
    ),
    radius: RadiusTokens(
      sm: 8,
      md: 10,
      lg: 14,
      xl: 18,
      pill: 999,
    ),
    control: ControlTokens(
      height: 44,
      heightSm: 32,
      borderWidth: 1,
      iconGlyph: 24,
    ),
    panelSheen: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x07FFFFFF), Color(0x00000000)], stops: [0.000, 0.420]),
    overlaySheen: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFF23262B), Color(0xFF1C1F24)], stops: [0.000, 1.000]),
    cardElevation: <BoxShadow>[],
    buttonElevation: <BoxShadow>[],
    popoverElevation: <BoxShadow>[BoxShadow(color: Color(0x8F04060A), offset: Offset(0, 20), blurRadius: 48, spreadRadius: 0)],
  );

  /// Light theme values.
  static const PandaTokens light = PandaTokens(
    appBg: Color(0xFFF4F5F7),
    sidebar: Color(0xFFECEEF1),
    panelSoft: Color(0xFFF8F9FA),
    panel: Color(0xFFFFFFFF),
    panelStrong: Color(0xFFE8EAEE),
    panelHover: Color(0xFFECEEF1),
    hoverWash: Color(0x0D000000),
    hoverWashStrong: Color(0x17000000),
    scrim: Color(0x5210141C),
    overlay: Color(0xFFFFFFFF),
    inputBg: Color(0xFFFFFFFF),
    lineSoft: Color(0xFFE6E8EC),
    line: Color(0xFFD9DCE1),
    lineHi: Color(0xFFC3C8D0),
    text: Color(0xFF16181C),
    muted: Color(0xFF5B636E),
    subtle: Color(0xFF7F8792),
    placeholder: Color(0xFF8E95A0),
    accent: AccentTokens(
      solid: Color(0xFF846520),
      on: Color(0xFFFFFAF0),
      text: Color(0xFF846520),
      textHi: Color(0xFF6D5316),
      edge: Color(0x4D846520),
      edgeStrong: Color(0x8C846520),
      wash: Color(0x29D0A85D),
      washStrong: Color(0x4DD0A85D),
    ),
    run: StatusTokens(
      solid: Color(0xFF226B45),
      on: Color(0xFFF2FFF8),
      text: Color(0xFF1D7A4C),
      edge: Color(0x471D7A4C),
      wash: Color(0x1A1D7A4C),
    ),
    warn: StatusTokens(
      solid: Color(0xFF7C5410),
      on: Color(0xFFFFFAF0),
      text: Color(0xFF95650B),
      edge: Color(0x4795650B),
      wash: Color(0x2EDFB45F),
    ),
    danger: StatusTokens(
      solid: Color(0xFFA3313F),
      on: Color(0xFFFFF3F4),
      text: Color(0xFFB03040),
      edge: Color(0x42B03040),
      wash: Color(0x17B03040),
    ),
    info: StatusTokens(
      solid: Color(0xFF1F5FA8),
      on: Color(0xFFF2F8FF),
      text: Color(0xFF1F66B8),
      edge: Color(0x421F66B8),
      wash: Color(0x1A1F66B8),
    ),
    agent: StatusTokens(
      solid: Color(0xFF4C3475),
      on: Color(0xFFF7F2FF),
      text: Color(0xFF63409F),
      edge: Color(0x4263409F),
      wash: Color(0x1A63409F),
    ),
    focusRing: Color(0x42846520),
    scroll: ScrollTokens(
      thumb: Color(0x4D5A6473),
      thumbHover: Color(0x7A5A6473),
      width: 5,
      radius: 999,
    ),
    radius: RadiusTokens(
      sm: 8,
      md: 10,
      lg: 14,
      xl: 18,
      pill: 999,
    ),
    control: ControlTokens(
      height: 44,
      heightSm: 32,
      borderWidth: 1,
      iconGlyph: 24,
    ),
    panelSheen: null,
    overlaySheen: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFFFFFFFF), Color(0xFFF7F8FA)], stops: [0.000, 1.000]),
    cardElevation: <BoxShadow>[BoxShadow(color: Color(0x0F10141C), offset: Offset(0, 1), blurRadius: 2, spreadRadius: 0)],
    buttonElevation: <BoxShadow>[BoxShadow(color: Color(0x1410141C), offset: Offset(0, 1), blurRadius: 2, spreadRadius: 0)],
    popoverElevation: <BoxShadow>[BoxShadow(color: Color(0x2910141C), offset: Offset(0, 14), blurRadius: 40, spreadRadius: 0)],
  );

  @override
  PandaTokens copyWith({
    Color? appBg,
    Color? sidebar,
    Color? panelSoft,
    Color? panel,
    Color? panelStrong,
    Color? panelHover,
    Color? hoverWash,
    Color? hoverWashStrong,
    Color? scrim,
    Color? overlay,
    Color? inputBg,
    Color? lineSoft,
    Color? line,
    Color? lineHi,
    Color? text,
    Color? muted,
    Color? subtle,
    Color? placeholder,
    AccentTokens? accent,
    StatusTokens? run,
    StatusTokens? warn,
    StatusTokens? danger,
    StatusTokens? info,
    StatusTokens? agent,
    Color? focusRing,
    ScrollTokens? scroll,
    RadiusTokens? radius,
    ControlTokens? control,
    Gradient? panelSheen,
    Gradient? overlaySheen,
    List<BoxShadow>? cardElevation,
    List<BoxShadow>? buttonElevation,
    List<BoxShadow>? popoverElevation,
  }) {
    return PandaTokens(
      appBg: appBg ?? this.appBg,
      sidebar: sidebar ?? this.sidebar,
      panelSoft: panelSoft ?? this.panelSoft,
      panel: panel ?? this.panel,
      panelStrong: panelStrong ?? this.panelStrong,
      panelHover: panelHover ?? this.panelHover,
      hoverWash: hoverWash ?? this.hoverWash,
      hoverWashStrong: hoverWashStrong ?? this.hoverWashStrong,
      scrim: scrim ?? this.scrim,
      overlay: overlay ?? this.overlay,
      inputBg: inputBg ?? this.inputBg,
      lineSoft: lineSoft ?? this.lineSoft,
      line: line ?? this.line,
      lineHi: lineHi ?? this.lineHi,
      text: text ?? this.text,
      muted: muted ?? this.muted,
      subtle: subtle ?? this.subtle,
      placeholder: placeholder ?? this.placeholder,
      accent: accent ?? this.accent,
      run: run ?? this.run,
      warn: warn ?? this.warn,
      danger: danger ?? this.danger,
      info: info ?? this.info,
      agent: agent ?? this.agent,
      focusRing: focusRing ?? this.focusRing,
      scroll: scroll ?? this.scroll,
      radius: radius ?? this.radius,
      control: control ?? this.control,
      panelSheen: panelSheen ?? this.panelSheen,
      overlaySheen: overlaySheen ?? this.overlaySheen,
      cardElevation: cardElevation ?? this.cardElevation,
      buttonElevation: buttonElevation ?? this.buttonElevation,
      popoverElevation: popoverElevation ?? this.popoverElevation,
    );
  }

  @override
  PandaTokens lerp(ThemeExtension<PandaTokens>? other, double t) {
    if (other is! PandaTokens) return this;
    return PandaTokens(
      appBg: Color.lerp(appBg, other.appBg, t)!,
      sidebar: Color.lerp(sidebar, other.sidebar, t)!,
      panelSoft: Color.lerp(panelSoft, other.panelSoft, t)!,
      panel: Color.lerp(panel, other.panel, t)!,
      panelStrong: Color.lerp(panelStrong, other.panelStrong, t)!,
      panelHover: Color.lerp(panelHover, other.panelHover, t)!,
      hoverWash: Color.lerp(hoverWash, other.hoverWash, t)!,
      hoverWashStrong: Color.lerp(hoverWashStrong, other.hoverWashStrong, t)!,
      scrim: Color.lerp(scrim, other.scrim, t)!,
      overlay: Color.lerp(overlay, other.overlay, t)!,
      inputBg: Color.lerp(inputBg, other.inputBg, t)!,
      lineSoft: Color.lerp(lineSoft, other.lineSoft, t)!,
      line: Color.lerp(line, other.line, t)!,
      lineHi: Color.lerp(lineHi, other.lineHi, t)!,
      text: Color.lerp(text, other.text, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      subtle: Color.lerp(subtle, other.subtle, t)!,
      placeholder: Color.lerp(placeholder, other.placeholder, t)!,
      accent: accent.lerpTo(other.accent, t),
      run: run.lerpTo(other.run, t),
      warn: warn.lerpTo(other.warn, t),
      danger: danger.lerpTo(other.danger, t),
      info: info.lerpTo(other.info, t),
      agent: agent.lerpTo(other.agent, t),
      focusRing: Color.lerp(focusRing, other.focusRing, t)!,
      scroll: scroll.lerpTo(other.scroll, t),
      // Metrics are identical across themes, so there is nothing to interpolate.
      radius: other.radius,
      control: other.control,
      panelSheen: t < 0.5 ? panelSheen : other.panelSheen,
      overlaySheen: Gradient.lerp(overlaySheen, other.overlaySheen, t),
      cardElevation: BoxShadow.lerpList(cardElevation, other.cardElevation, t)!,
      buttonElevation:
          BoxShadow.lerpList(buttonElevation, other.buttonElevation, t)!,
      popoverElevation:
          BoxShadow.lerpList(popoverElevation, other.popoverElevation, t)!,
    );
  }

  static PandaTokens of(BuildContext context) =>
      Theme.of(context).extension<PandaTokens>() ?? PandaTokens.dark;
}

/// Motion: one easing curve, both durations under 200ms, nothing bounces. Callers
/// must pass these through [MediaQuery.disableAnimations] so the OS "reduce
/// motion" setting and the in-app preference both collapse them to zero.
class PandaMotion {
  const PandaMotion._();

  static const Duration enter = Duration(milliseconds: 140);
  static const Duration exit = Duration(milliseconds: 100);
  static const Curve easing = Cubic(0.32, 0.72, 0, 1);

  /// [enter], or [Duration.zero] when the user has asked for less motion.
  static Duration enterFor(BuildContext context) =>
      MediaQuery.of(context).disableAnimations ? Duration.zero : enter;

  static Duration exitFor(BuildContext context) =>
      MediaQuery.of(context).disableAnimations ? Duration.zero : exit;
}

/// Sugar so widgets can write `context.tokens.panel` instead of the full
/// `Theme.of(context).extension<PandaTokens>()!` dance.
extension PandaThemeX on BuildContext {
  PandaTokens get tokens => PandaTokens.of(this);
}
