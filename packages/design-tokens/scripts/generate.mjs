#!/usr/bin/env node
// Generates the platform token files from tokens.json.
//
//   apps/desktop/src/renderer/src/tokens.css   CSS custom properties (dark only —
//                                              the renderer is `color-scheme: dark`)
//   apps/mobile/lib/theme/panda_tokens.dart    Dart ThemeExtension with dark + light
//
// Run via `pnpm --filter @panda/design-tokens build`, or `pnpm build` at the root.
// No dependencies: plain Node, node:fs only.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "../..");

const tokens = JSON.parse(readFileSync(resolve(pkgRoot, "tokens.json"), "utf8"));
const { primitives, themes, scale, motion } = tokens;

const BANNER = (source) =>
  `DO NOT EDIT — generated from ${source} by packages/design-tokens/scripts/generate.mjs.\n` +
  `Change the JSON and re-run \`pnpm --filter @panda/design-tokens build\`.`;

/** The banner is multi-line, so every line needs its own `//` in Dart. */
const dartBanner = (source) =>
  BANNER(source)
    .split("\n")
    .map((line) => `// ${line}`)
    .join("\n");

/* ------------------------------------------------------------------ colour */

/** Resolve '$name', '$name/NN', '#rrggbb' or 'transparent' to {r,g,b,a}. */
export function resolveColor(value) {
  if (value == null) return null;
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  let alpha = 1;
  let ref = value;

  const slash = value.indexOf("/");
  if (slash !== -1) {
    ref = value.slice(0, slash);
    const pct = Number.parseFloat(value.slice(slash + 1));
    if (!Number.isFinite(pct)) throw new Error(`Bad alpha in "${value}"`);
    alpha = pct / 100;
  }

  let hex = ref;
  if (ref.startsWith("$")) {
    hex = primitives[ref.slice(1)];
    if (!hex) throw new Error(`Unknown primitive "${ref}"`);
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`Bad colour "${hex}" (from "${value}")`);

  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
    a: alpha,
  };
}

const toCss = (value) => {
  const c = resolveColor(value);
  if (!c) return "none";
  if (c.a === 0) return "transparent";
  if (c.a === 1) return `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  // Trim float noise: 0.028 stays, 0.130 becomes 0.13.
  const a = Number.parseFloat(c.a.toFixed(4));
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
};

const toDart = (value) => {
  const c = resolveColor(value);
  if (!c) return "null";
  const hex = [Math.round(c.a * 255), c.r, c.g, c.b]
    .map((n) => n.toString(16).padStart(2, "0").toUpperCase())
    .join("");
  return `Color(0x${hex})`;
};

/* ----------------------------------------------------------------- effects */

const gradientCss = (g) =>
  `linear-gradient(${g.angle}deg, ${g.stops.map(([c, at]) => `${toCss(c)} ${at}`).join(", ")})`;

const shadowCss = (s) =>
  s.layers
    .map((l) => {
      const parts = [l.inset ? "inset" : null, `${l.x}px`, `${l.y}px`, `${l.blur}px`];
      if (l.spread) parts.push(`${l.spread}px`);
      parts.push(toCss(l.color));
      return parts.filter(Boolean).join(" ");
    })
    .join(", ");

const effectCss = (e) => {
  if (!e) return "none";
  return e.type === "linearGradient" ? gradientCss(e) : shadowCss(e);
};

const gradientDart = (g) => {
  // CSS 180deg == top-to-bottom, which is Flutter's topCenter -> bottomCenter.
  const begin = g.angle === 180 ? "Alignment.topCenter" : "Alignment.centerLeft";
  const end = g.angle === 180 ? "Alignment.bottomCenter" : "Alignment.centerRight";
  const colors = g.stops.map(([c]) => toDart(c)).join(", ");
  const stops = g.stops.map(([, at]) => (Number.parseFloat(at) / 100).toFixed(3)).join(", ");
  return `LinearGradient(begin: ${begin}, end: ${end}, colors: [${colors}], stops: [${stops}])`;
};

// Flutter has no inset shadow, so inset layers are dropped in the Dart output. In
// dark mode the inner highlight is carried by panelSheen instead; in light mode
// every elevation layer is a real (outset) shadow, so nothing is lost there.
const shadowDart = (s) => {
  const layers = s.layers.filter((l) => !l.inset);
  if (layers.length === 0) return "<BoxShadow>[]";
  const parts = layers.map(
    (l) =>
      `BoxShadow(color: ${toDart(l.color)}, offset: Offset(${l.x}, ${l.y}), ` +
      `blurRadius: ${l.blur}, spreadRadius: ${l.spread ?? 0})`,
  );
  return `<BoxShadow>[${parts.join(", ")}]`;
};

/** Entries of an object, minus the `$comment*` documentation keys. */
const real = (obj) => Object.entries(obj).filter(([k]) => !k.startsWith("$"));

/* --------------------------------------------------------------------- CSS */

function buildCss() {
  const t = themes.dark;
  const s = scale.desktop;
  const L = [];
  const put = (name, value) => L.push(`  --${name}: ${value};`);

  L.push(`/* ${BANNER("packages/design-tokens/tokens.json")} */`);
  L.push("");
  L.push("/* Graphite & Brass — desktop (dark only; the renderer sets color-scheme: dark). */");
  L.push(":root {");

  L.push("  /* Surfaces: a five-step ladder plus `overlay` for anything that floats. */");
  for (const [k, v] of real(t.surface)) put(kebab(k), toCss(v));

  L.push("");
  L.push("  /* Hairlines: soft = internal division, base = component edge, hi = hover. */");
  for (const [k, v] of real(t.line)) put(kebab(k), toCss(v));

  L.push("");
  L.push("  /* Four text levels. If you need a fifth, the layout is wrong. */");
  for (const [k, v] of real(t.text)) put(kebab(k), toCss(v));

  L.push("");
  L.push("  /* The one accent. Every selected state derives from here. */");
  for (const [k, v] of real(t.accent)) put(`accent-${kebab(k)}`, toCss(v));

  L.push("");
  L.push("  /* Status colours are semantic only — never decorative. */");
  for (const [group, vals] of real(t.status)) {
    for (const [k, v] of real(vals)) put(`${group}-${kebab(k)}`, toCss(v));
  }

  L.push("");
  put("focus-ring", `0 0 0 3px ${toCss(t.focus.ring)}`);
  // The ring above is a box-shadow glow, which is the right treatment for a
  // bordered control that can also turn its border brass (inputs). It cannot be
  // the *global* focus treatment: any element that already owns a box-shadow
  // (filled buttons carry --elev-button) would have it clobbered. So the global
  // baseline is an outline, and these are its geometry.
  put("focus-ring-width", "2px");
  put("focus-ring-offset", "2px");

  L.push("");
  L.push("  /* Radii — the single biggest lever on personality. */");
  for (const [k, v] of real(s.radius)) put(`r-${k}`, v === 999 ? "999px" : `${v}px`);

  L.push("");
  L.push("  /* Two control heights, and one border width. */");
  put("ctl-h", `${s.control.height}px`);
  put("ctl-h-sm", `${s.control.heightSm}px`);
  put("bw", `${s.control.borderWidth}px`);
  put("icon-glyph", `${s.control.iconGlyph}px`);

  L.push("");
  L.push("  /* Motion: one curve, both durations under 200ms. */");
  put("motion-enter", `${motion.enter}ms`);
  put("motion-exit", `${motion.exit}ms`);
  put("motion-ease", motion.easing);

  L.push("");
  L.push("  /* Scrollbars: the same numbers the Flutter ScrollbarTheme reads. */");
  put("sb-w", `${s.scroll.width}px`);
  put("sb-inset", `${s.scroll.inset}px`);
  put("sb-radius", s.scroll.radius === 999 ? "999px" : `${s.scroll.radius}px`);
  put("sb-thumb", toCss(t.scroll.thumb));
  put("sb-thumb-hover", toCss(t.scroll.thumbHover));
  put("sb-track", toCss(t.scroll.track));

  L.push("");
  L.push("  /* Only floating surfaces get a real shadow; the rest use the ladder. */");
  put("elev-card", effectCss(t.effects.elevCard));
  put("elev-button", effectCss(t.effects.elevButton));
  put("elev-popover", effectCss(t.effects.elevPopover));
  put("panel-sheen", effectCss(t.effects.panelSheen));
  put("overlay-sheen", effectCss(t.effects.overlaySheen));

  L.push("");
  L.push("  /* ---- Back-compat aliases -------------------------------------------");
  L.push("     Scaffolding for the incremental styles.css migration. Blue is NO LONGER");
  L.push("     a selection colour — it is informational only — so `--blue` maps to");
  L.push("     --info-text and any rule still using it for 'active' must move to");
  L.push("     --accent-*. Delete this block once styles.css references none of them. */");
  put("accent", "var(--accent-text)");
  put("green", "var(--run-text)");
  put("red", "var(--danger-text)");
  put("yellow", "var(--warn-text)");
  put("blue", "var(--info-text)");

  L.push("}");
  L.push("");
  L.push("@media (prefers-reduced-motion: reduce) {");
  L.push("  :root {");
  L.push("    --motion-enter: 0ms;");
  L.push("    --motion-exit: 0ms;");
  L.push("  }");
  L.push("}");
  L.push("");
  return L.join("\n");
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/* -------------------------------------------------------------------- Dart */

function dartTheme(name, t, s) {
  const c = (v) => `const ${toDart(v)}`;
  const accent =
    `accent: AccentTokens(\n` +
    `      solid: ${toDart(t.accent.solid)},\n` +
    `      on: ${toDart(t.accent.on)},\n` +
    `      text: ${toDart(t.accent.text)},\n` +
    `      textHi: ${toDart(t.accent.textHi)},\n` +
    `      edge: ${toDart(t.accent.edge)},\n` +
    `      edgeStrong: ${toDart(t.accent.edgeStrong)},\n` +
    `      wash: ${toDart(t.accent.wash)},\n` +
    `      washStrong: ${toDart(t.accent.washStrong)},\n` +
    `    )`;

  const status = (key) => {
    const v = t.status[key];
    return (
      `${key}: StatusTokens(\n` +
      `      solid: ${toDart(v.solid)},\n` +
      `      on: ${toDart(v.on)},\n` +
      `      text: ${toDart(v.text)},\n` +
      `      edge: ${toDart(v.edge)},\n` +
      `      wash: ${toDart(v.wash)},\n` +
      `    )`
    );
  };

  const sheen = t.effects.panelSheen ? gradientDart(t.effects.panelSheen) : "null";
  const overlaySheen = t.effects.overlaySheen ? gradientDart(t.effects.overlaySheen) : "null";

  return `  /// ${name === "dark" ? "Dark" : "Light"} theme values.
  static const PandaTokens ${name} = PandaTokens(
    appBg: ${toDart(t.surface.appBg)},
    sidebar: ${toDart(t.surface.sidebar)},
    panelSoft: ${toDart(t.surface.panelSoft)},
    panel: ${toDart(t.surface.panel)},
    panelStrong: ${toDart(t.surface.panelStrong)},
    panelHover: ${toDart(t.surface.panelHover)},
    hoverWash: ${toDart(t.surface.hoverWash)},
    hoverWashStrong: ${toDart(t.surface.hoverWashStrong)},
    scrim: ${toDart(t.surface.scrim)},
    overlay: ${toDart(t.surface.overlay)},
    inputBg: ${toDart(t.surface.inputBg)},
    lineSoft: ${toDart(t.line.lineSoft)},
    line: ${toDart(t.line.line)},
    lineHi: ${toDart(t.line.lineHi)},
    text: ${toDart(t.text.text)},
    muted: ${toDart(t.text.muted)},
    subtle: ${toDart(t.text.subtle)},
    placeholder: ${toDart(t.text.placeholder)},
    ${accent},
    ${status("run")},
    ${status("warn")},
    ${status("danger")},
    ${status("info")},
    ${status("agent")},
    focusRing: ${toDart(t.focus.ring)},
    scroll: ScrollTokens(
      thumb: ${toDart(t.scroll.thumb)},
      thumbHover: ${toDart(t.scroll.thumbHover)},
      width: ${s.scroll.width},
      radius: ${s.scroll.radius},
    ),
    radius: RadiusTokens(
      sm: ${s.radius.sm},
      md: ${s.radius.md},
      lg: ${s.radius.lg},
      xl: ${s.radius.xl},
      pill: ${s.radius.pill},
    ),
    control: ControlTokens(
      height: ${s.control.height},
      heightSm: ${s.control.heightSm},
      borderWidth: ${s.control.borderWidth},
      iconGlyph: ${s.control.iconGlyph},
    ),
    panelSheen: ${sheen},
    overlaySheen: ${overlaySheen},
    cardElevation: ${shadowDart(t.effects.elevCard)},
    buttonElevation: ${shadowDart(t.effects.elevButton)},
    popoverElevation: ${shadowDart(t.effects.elevPopover)},
  );`;
}

function buildDart() {
  const s = scale.mobile;
  return `${dartBanner("packages/design-tokens/tokens.json")}
//
// Graphite & Brass — the shared Panda Code design system. Every colour, radius and
// control dimension in the mobile app comes from here; nothing hardcodes a hex.
//
// Reach these from any widget via the \`context.tokens\` extension at the bottom of
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

/// The design system, reachable as \`Theme.of(context).extension<PandaTokens>()\`
/// or more conveniently \`context.tokens\`.
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

${dartTheme("dark", themes.dark, s)}

${dartTheme("light", themes.light, s)}

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

  static const Duration enter = Duration(milliseconds: ${motion.enter});
  static const Duration exit = Duration(milliseconds: ${motion.exit});
  static const Curve easing = Cubic(0.32, 0.72, 0, 1);

  /// [enter], or [Duration.zero] when the user has asked for less motion.
  static Duration enterFor(BuildContext context) =>
      MediaQuery.of(context).disableAnimations ? Duration.zero : enter;

  static Duration exitFor(BuildContext context) =>
      MediaQuery.of(context).disableAnimations ? Duration.zero : exit;
}

/// Sugar so widgets can write \`context.tokens.panel\` instead of the full
/// \`Theme.of(context).extension<PandaTokens>()!\` dance.
extension PandaThemeX on BuildContext {
  PandaTokens get tokens => PandaTokens.of(this);
}
`;
}

/* --------------------------------------------------------------------- run */

function write(relPath, contents) {
  const abs = resolve(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, "utf8");
  console.log(`  ✓ ${relPath} (${contents.split("\n").length} lines)`);
}

// Only run the generator when invoked directly — contrast.test.mjs imports
// resolveColor from this module and must not trigger a write.
if (process.argv[1] && resolve(process.argv[1]) === resolve(here, "generate.mjs")) {
  console.log("design-tokens: generating platform files…");
  write("apps/desktop/src/renderer/src/tokens.css", buildCss());
  write("apps/mobile/lib/theme/panda_tokens.dart", buildDart());
  console.log("design-tokens: done.");
}

export { buildCss, buildDart, tokens };
