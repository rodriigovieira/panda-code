import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';

import 'panda_tokens.dart';

/// Builds the app's [ThemeData] from [PandaTokens] — the design system shared with
/// the desktop app.
///
/// This replaces the previous `colorSchemeSeed:` approach. Deriving the scheme from
/// a seed meant Material chose our surfaces and our status colours, so "needs your
/// approval" was whatever amber the algorithm produced that day and a card was
/// whatever grey it tinted. Building the scheme explicitly is what makes "shared
/// design system" true rather than aspirational: a `panel` here is the same pixel as
/// a `--panel` there.
///
/// Material 3 itself stays — sheets, ripples, navigation transitions and the density
/// system are all still Material. Only the colours, radii and control metrics are ours.
ThemeData buildPandaTheme({
  required Brightness brightness,
  required VisualDensity density,
  PageTransitionsTheme? pageTransitions,
  Color? accentOverride,
}) {
  var t = brightness == Brightness.dark ? PandaTokens.dark : PandaTokens.light;
  if (accentOverride != null) {
    t = t.copyWith(accent: _deriveAccent(accentOverride, t));
  }

  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
    visualDensity: density,
    pageTransitionsTheme: pageTransitions,
    colorScheme: _scheme(brightness, t),
    typography: _nudgedTypography(brightness),
    extensions: [t],
  );

  final themed = base.copyWith(
    scaffoldBackgroundColor: t.appBg,
    canvasColor: t.appBg,
    dividerColor: t.lineSoft,
    // Desktop spends this on hover; mobile spends it on press. Same token, and
    // that shared meaning is the point.
    splashColor: t.panelHover,
    highlightColor: t.panelHover,
    focusColor: t.focusRing,

    dividerTheme: DividerThemeData(
      color: t.lineSoft,
      thickness: t.control.borderWidth,
      space: t.control.borderWidth,
    ),

    appBarTheme: AppBarTheme(
      backgroundColor: t.sidebar,
      foregroundColor: t.text,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      shape: Border(
          bottom: BorderSide(color: t.lineSoft, width: t.control.borderWidth)),
      // App-bar icons are the primary navigation on a phone; at desktop's 17px
      // they read as decoration. See PandaTokens.control.iconGlyph.
      iconTheme: IconThemeData(color: t.muted, size: t.control.iconGlyph),
      actionsIconTheme:
          IconThemeData(color: t.muted, size: t.control.iconGlyph),
    ),

    iconTheme: IconThemeData(color: t.muted, size: t.control.iconGlyph),

    // Cards are the graphite ladder made visible: `panel` over `app-bg` with a
    // hairline. Elevation 0 because depth comes from the ladder, not a shadow.
    cardTheme: CardThemeData(
      color: t.panel,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: t.radius.lgR,
        side: BorderSide(color: t.lineSoft, width: t.control.borderWidth),
      ),
    ),

    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: t.overlay,
      surfaceTintColor: Colors.transparent,
      modalBackgroundColor: t.overlay,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(t.radius.xl)),
      ),
      showDragHandle: true,
      dragHandleColor: t.lineHi,
    ),

    dialogTheme: DialogThemeData(
      backgroundColor: t.overlay,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: t.radius.xlR),
      titleTextStyle: base.textTheme.titleMedium?.copyWith(color: t.text),
      contentTextStyle: base.textTheme.bodyMedium?.copyWith(color: t.muted),
    ),

    popupMenuTheme: PopupMenuThemeData(
      color: t.overlay,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: t.radius.lgR,
        side: BorderSide(color: t.line, width: t.control.borderWidth),
      ),
      textStyle: base.textTheme.bodyMedium?.copyWith(color: t.text),
    ),

    listTileTheme: ListTileThemeData(
      iconColor: t.muted,
      textColor: t.text,
      subtitleTextStyle: base.textTheme.bodySmall?.copyWith(color: t.subtle),
      selectedColor: t.accent.textHi,
      selectedTileColor: t.accent.wash,
      shape: RoundedRectangleBorder(borderRadius: t.radius.smR),
      minVerticalPadding: 10,
    ),

    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: t.inputBg,
      hintStyle: TextStyle(color: t.placeholder),
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      border: _inputBorder(t, t.line),
      enabledBorder: _inputBorder(t, t.line),
      focusedBorder: _inputBorder(t, t.accent.edgeStrong, width: 1.5),
      errorBorder: _inputBorder(t, t.danger.edge),
      focusedErrorBorder: _inputBorder(t, t.danger.text, width: 1.5),
      disabledBorder: _inputBorder(t, t.lineSoft),
      prefixIconColor: t.subtle,
      suffixIconColor: t.subtle,
    ),

    // Every tappable thing clears 44pt. Non-negotiable on iOS, and the reason
    // mobile is allowed to disagree with desktop's 34px.
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: t.accent.solid,
        foregroundColor: t.accent.on,
        minimumSize: Size(0, t.control.height),
        shape: RoundedRectangleBorder(borderRadius: t.radius.mdR),
        textStyle:
            base.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: t.text,
        backgroundColor: t.panelStrong,
        side: BorderSide(color: t.line, width: t.control.borderWidth),
        minimumSize: Size(0, t.control.height),
        shape: RoundedRectangleBorder(borderRadius: t.radius.mdR),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: t.accent.text,
        minimumSize: Size(0, t.control.height),
        shape: RoundedRectangleBorder(borderRadius: t.radius.mdR),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(
        foregroundColor: t.muted,
        minimumSize: Size(t.control.height, t.control.height),
        shape: const CircleBorder(),
      ),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: t.accent.solid,
      foregroundColor: t.accent.on,
      elevation: 4,
      shape: RoundedRectangleBorder(borderRadius: t.radius.pillR),
    ),

    chipTheme: ChipThemeData(
      backgroundColor: t.panelSoft,
      selectedColor: t.accent.wash,
      side: BorderSide(color: t.line, width: t.control.borderWidth),
      labelStyle: base.textTheme.labelMedium?.copyWith(color: t.muted),
      secondaryLabelStyle: base.textTheme.labelMedium?.copyWith(color: t.text),
      shape: RoundedRectangleBorder(borderRadius: t.radius.pillR),
      showCheckmark: false,
    ),

    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected)
              ? t.accent.washStrong
              : t.panelSoft,
        ),
        foregroundColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? t.accent.textHi : t.muted,
        ),
        side: WidgetStatePropertyAll(
          BorderSide(color: t.line, width: t.control.borderWidth),
        ),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: t.radius.pillR),
        ),
      ),
    ),

    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? t.accent.text : t.muted,
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected)
            ? t.accent.washStrong
            : t.panelSoft,
      ),
      trackOutlineColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? t.accent.edgeStrong : t.line,
      ),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected)
            ? t.accent.solid
            : Colors.transparent,
      ),
      checkColor: WidgetStatePropertyAll(t.accent.on),
      side: BorderSide(color: t.line, width: 1.5),
      shape: RoundedRectangleBorder(borderRadius: t.radius.smR),
    ),
    radioTheme: RadioThemeData(
      fillColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? t.accent.text : t.subtle,
      ),
    ),

    sliderTheme: SliderThemeData(
      activeTrackColor: t.accent.text,
      inactiveTrackColor: t.panelStrong,
      thumbColor: t.accent.text,
      overlayColor: t.accent.wash,
    ),

    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: t.info.text,
      linearTrackColor: t.panelStrong,
      circularTrackColor: Colors.transparent,
    ),

    // Thickness 5 on mobile vs 10 on desktop, but the same thumb colour and the
    // same pill radius, so a long transcript feels identical on both.
    scrollbarTheme: ScrollbarThemeData(
      thickness: WidgetStatePropertyAll(t.scroll.width),
      thumbColor: WidgetStatePropertyAll(t.scroll.thumb),
      radius: Radius.circular(t.scroll.radius),
      crossAxisMargin: 2,
    ),

    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(
        color: t.overlay,
        borderRadius: t.radius.smR,
        border: Border.all(color: t.line, width: t.control.borderWidth),
      ),
      textStyle: base.textTheme.bodySmall?.copyWith(color: t.text),
    ),

    snackBarTheme: SnackBarThemeData(
      backgroundColor: t.overlay,
      contentTextStyle: base.textTheme.bodyMedium?.copyWith(color: t.text),
      actionTextColor: t.accent.text,
      shape: RoundedRectangleBorder(borderRadius: t.radius.mdR),
      behavior: SnackBarBehavior.floating,
    ),

    textSelectionTheme: TextSelectionThemeData(
      cursorColor: t.accent.text,
      selectionColor: t.accent.washStrong,
      selectionHandleColor: t.accent.text,
    ),
  );

  // Colours only — the size nudge happens in _nudgedTypography, for the reason
  // documented there.
  return themed.copyWith(
    textTheme: themed.textTheme.apply(bodyColor: t.text, displayColor: t.text),
  );
}

/// Nudges the base type scale up ~3% (≈⅓–½px across the ramp) so the whole app
/// reads a touch larger. Proportional, so every style keeps its relative size;
/// still composes with the chat text-size preference.
///
/// This has to happen on [Typography], NOT on `theme.textTheme`. `ThemeData
/// .textTheme` is the *colour* theme (`white2021` / `black2021`) and carries no
/// font sizes at all — the sizes live in `typography.englishLike` and are merged
/// in further down. Calling `.apply(fontSizeFactor:)` on it therefore asserts in
/// debug ("fontSize != null || fontSizeFactor == 1.0") and, with assertions
/// compiled out, silently multiplies null by 1.03 and changes nothing.
///
/// The previous implementation did exactly that, so the nudge had never actually
/// taken effect. Scaling the geometry sets is what makes it real.
Typography _nudgedTypography(Brightness brightness) {
  const factor = 1.03;
  final base = Typography.material2021(
    platform: defaultTargetPlatform,
    colorScheme: brightness == Brightness.dark
        ? const ColorScheme.dark()
        : const ColorScheme.light(),
  );
  return base.copyWith(
    englishLike: base.englishLike.apply(fontSizeFactor: factor),
    dense: base.dense.apply(fontSizeFactor: factor),
    tall: base.tall.apply(fontSizeFactor: factor),
  );
}

OutlineInputBorder _inputBorder(PandaTokens t, Color color, {double? width}) =>
    OutlineInputBorder(
      borderRadius: t.radius.mdR,
      borderSide:
          BorderSide(color: color, width: width ?? t.control.borderWidth),
    );

ColorScheme _scheme(Brightness brightness, PandaTokens t) => ColorScheme(
      brightness: brightness,
      primary: t.accent.solid,
      onPrimary: t.accent.on,
      primaryContainer: t.accent.wash,
      onPrimaryContainer: t.accent.textHi,
      // Secondary intentionally mirrors primary: the system has ONE accent, so a
      // distinct secondary would just be a second accent by another name.
      secondary: t.accent.solid,
      onSecondary: t.accent.on,
      secondaryContainer: t.accent.wash,
      onSecondaryContainer: t.accent.textHi,
      tertiary: t.info.text,
      onTertiary: t.info.on,
      tertiaryContainer: t.info.wash,
      onTertiaryContainer: t.info.text,
      error: t.danger.text,
      onError: t.danger.on,
      errorContainer: t.danger.wash,
      onErrorContainer: t.danger.text,
      surface: t.appBg,
      onSurface: t.text,
      onSurfaceVariant: t.muted,
      surfaceContainerLowest: t.appBg,
      surfaceContainerLow: t.panelSoft,
      surfaceContainer: t.panel,
      surfaceContainerHigh: t.panelStrong,
      surfaceContainerHighest: t.panelStrong,
      surfaceTint: Colors.transparent,
      outline: t.line,
      outlineVariant: t.lineSoft,
      shadow: const Color(0xFF000000),
      scrim: const Color(0xCC06080B),
      inverseSurface: t.text,
      onInverseSurface: t.appBg,
    );

/// Rebuilds the accent group around a user-picked colour.
///
/// The accent setting predates the design system, where it seeded the *entire*
/// Material scheme — surfaces, status colours and all. It can't do that any more:
/// under a shared system, "needs your approval" has to be the same amber on both
/// platforms regardless of anyone's colour preference. So the setting survives, but
/// demoted — it repaints the accent group only, and never touches a status colour,
/// a surface or a hairline.
///
/// Any user-chosen hue can fail contrast, so the text variants are clamped: the
/// lightness is walked until the colour clears AA against the panel it sits on. The
/// picked hue is preserved exactly in the fills, where contrast is not at stake.
///
// TODO(design): confirm with the user whether this override should survive at all,
// or whether the accent becomes fixed brass. Until then it is kept, because
// silently deleting a user-facing setting is worse than keeping a scoped one.
AccentTokens _deriveAccent(Color seed, PandaTokens t) {
  final onDark = t.appBg.computeLuminance() < 0.5;
  final text = _clampForContrast(seed, t.panel, 4.5, lighten: onDark);
  return AccentTokens(
    // A filled button needs its label to survive, so the solid is derived from the
    // clamped text colour rather than the raw pick.
    solid: _clampForContrast(seed, t.accent.on, 4.5, lighten: false),
    on: t.accent.on,
    text: text,
    textHi: _shiftLightness(text, onDark ? 0.10 : -0.10),
    edge: seed.withValues(alpha: 0.34),
    edgeStrong: seed.withValues(alpha: 0.62),
    wash: seed.withValues(alpha: 0.13),
    washStrong: seed.withValues(alpha: 0.26),
  );
}

/// Walks [c]'s lightness until it clears [target] contrast against [against].
Color _clampForContrast(
  Color c,
  Color against,
  double target, {
  required bool lighten,
}) {
  var hsl = HSLColor.fromColor(c);
  for (var i = 0; i < 40; i++) {
    if (_contrast(hsl.toColor(), against) >= target) break;
    final next = (hsl.lightness + (lighten ? 0.025 : -0.025)).clamp(0.0, 1.0);
    if (next == hsl.lightness) break; // hit the rail; nothing more to give
    hsl = hsl.withLightness(next);
  }
  return hsl.toColor();
}

Color _shiftLightness(Color c, double delta) {
  final hsl = HSLColor.fromColor(c);
  return hsl.withLightness((hsl.lightness + delta).clamp(0.0, 1.0)).toColor();
}

double _contrast(Color a, Color b) {
  final la = a.computeLuminance();
  final lb = b.computeLuminance();
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
