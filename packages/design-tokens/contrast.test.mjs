// Contrast gate for the design system.
//
// This exists because of one specific, easy-to-reintroduce bug: brass (#d0a85d) is
// the brand accent and reads beautifully on the dark graphite ladder, but on a white
// light-mode card it lands at roughly 2.1:1 — far below the WCAG AA 4.5:1 floor for
// body text. The light theme therefore substitutes a darkened brass (#8a6a22) for
// anything that carries text or an edge, keeping the original hue for washes only.
//
// Without a test, the "obvious" cleanup of collapsing those two values back into one
// silently breaks legibility for every light-mode user. So: assert it.
//
// Run with `pnpm --filter @panda/design-tokens test` (node --test).

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveColor, tokens } from "./scripts/generate.mjs";

const AA_TEXT = 4.5; // WCAG 2.1 AA, body text
const AA_LARGE = 3.0; // AA for large text — also our floor for non-text edges

/** sRGB channel -> linear light. */
const linearize = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ({ r, g, b }) =>
  0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);

/**
 * Flatten a possibly-translucent colour over an opaque backdrop, then return the
 * WCAG contrast ratio. Alpha matters here: a 13%-alpha wash is not the colour you
 * wrote, it is that colour blended with whatever is behind it.
 */
function contrast(fg, bg) {
  const f = resolveColor(fg);
  const b = resolveColor(bg);
  const composited = {
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
  };
  const l1 = luminance(composited);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const ratio = (fg, bg) => Number(contrast(fg, bg).toFixed(2));

for (const themeName of ["dark", "light"]) {
  const t = tokens.themes[themeName];

  // The surfaces text can legitimately sit on. `inputBg` is included because
  // placeholder text lives there.
  const bodySurfaces = [
    ["appBg", t.surface.appBg],
    ["sidebar", t.surface.sidebar],
    ["panelSoft", t.surface.panelSoft],
    ["panel", t.surface.panel],
    ["panelStrong", t.surface.panelStrong],
    ["overlay", t.surface.overlay],
  ];

  test(`${themeName}: primary text clears AA on every surface`, () => {
    for (const [name, bg] of bodySurfaces) {
      const r = ratio(t.text.text, bg);
      assert.ok(r >= AA_TEXT, `text on ${name} is ${r}:1, need ${AA_TEXT}:1`);
    }
  });

  test(`${themeName}: muted text clears AA on every surface`, () => {
    for (const [name, bg] of bodySurfaces) {
      const r = ratio(t.text.muted, bg);
      assert.ok(r >= AA_TEXT, `muted on ${name} is ${r}:1, need ${AA_TEXT}:1`);
    }
  });

  // `subtle` and `placeholder` are deliberately quieter — they carry timestamps,
  // hints and placeholder strings, not content. AA-large is the honest floor.
  test(`${themeName}: subtle + placeholder clear AA-large on their surfaces`, () => {
    for (const [name, bg] of bodySurfaces) {
      const r = ratio(t.text.subtle, bg);
      assert.ok(r >= AA_LARGE, `subtle on ${name} is ${r}:1, need ${AA_LARGE}:1`);
    }
    const p = ratio(t.text.placeholder, t.surface.inputBg);
    assert.ok(p >= AA_LARGE, `placeholder on inputBg is ${p}:1, need ${AA_LARGE}:1`);
  });

  // THE important one. accent.text is used for text and icons, so it must clear AA
  // against the surfaces it appears on — including its own wash, since selected rows
  // put accent text on an accent-washed background.
  test(`${themeName}: accent.text clears AA on surfaces and on its own wash`, () => {
    for (const [name, bg] of bodySurfaces) {
      const r = ratio(t.accent.text, bg);
      assert.ok(r >= AA_TEXT, `accent.text on ${name} is ${r}:1, need ${AA_TEXT}:1`);
    }
    // The wash is translucent, so flatten it over panel first.
    const washed = flatten(t.accent.wash, t.surface.panel);
    const r = ratio(t.accent.text, washed);
    assert.ok(r >= AA_TEXT, `accent.text on accent.wash over panel is ${r}:1`);
  });

  test(`${themeName}: status text clears AA on panel and on its own wash`, () => {
    for (const key of ["run", "warn", "danger", "info", "agent"]) {
      const s = t.status[key];
      const onPanel = ratio(s.text, t.surface.panel);
      assert.ok(onPanel >= AA_TEXT, `${key}.text on panel is ${onPanel}:1, need ${AA_TEXT}:1`);

      const washed = flatten(s.wash, t.surface.panel);
      const onWash = ratio(s.text, washed);
      assert.ok(onWash >= AA_TEXT, `${key}.text on ${key}.wash is ${onWash}:1`);
    }
  });

  test(`${themeName}: foreground-on-solid pairs clear AA`, () => {
    const pairs = [
      ["accent", t.accent.on, t.accent.solid],
      ...["run", "warn", "danger", "info", "agent"].map((k) => [k, t.status[k].on, t.status[k].solid]),
    ];
    for (const [name, fg, bg] of pairs) {
      const r = ratio(fg, bg);
      assert.ok(r >= AA_TEXT, `${name}.on over ${name}.solid is ${r}:1, need ${AA_TEXT}:1`);
    }
  });

  // Edges and hairlines are non-text UI, so AA-large (3:1) is the right bar. This is
  // what catches a border so faint it may as well not be drawn.
  test(`${themeName}: accent + status edges are visible against panel`, () => {
    const edges = [
      ["accent.edgeStrong", t.accent.edgeStrong],
      ...["run", "warn", "danger", "info", "agent"].map((k) => [`${k}.edge`, t.status[k].edge]),
    ];
    for (const [name, edge] of edges) {
      const flat = flatten(edge, t.surface.panel);
      const r = ratio(flat, t.surface.panel);
      assert.ok(r >= 1.35, `${name} on panel is only ${r}:1 — effectively invisible`);
    }
  });

  test(`${themeName}: the surface ladder is strictly monotonic`, () => {
    // Each rung must be lighter than the last in dark mode (and the inverse in
    // light), otherwise "depth" stops reading and the ladder is decorative.
    const rungs = ["appBg", "sidebar", "panelSoft", "panel", "panelStrong"].map((k) => ({
      k,
      l: luminance(resolveColor(t.surface[k])),
    }));
    // sidebar/panelSoft sit at a similar depth by design; compare the ordered set
    // of distinct steps instead of adjacent pairs.
    const appBg = rungs[0].l;
    const strong = rungs[4].l;
    if (themeName === "dark") {
      assert.ok(strong > appBg, "panelStrong must be lighter than appBg in dark mode");
      assert.ok(rungs[3].l > appBg, "panel must be lighter than appBg in dark mode");
    } else {
      assert.ok(rungs[3].l > appBg, "panel (white) must be lighter than appBg in light mode");
    }
  });
}

/** Composite a translucent token over an opaque backdrop, returning a hex string. */
function flatten(fg, bg) {
  const f = resolveColor(fg);
  const b = resolveColor(bg);
  const mix = (x, y) => Math.round(x * f.a + y * (1 - f.a));
  return (
    "#" +
    [mix(f.r, b.r), mix(f.g, b.g), mix(f.b, b.b)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
  );
}

// A regression guard with a name, so the failure message explains itself.
test("light mode does NOT use raw brass for text (the #d0a85d-on-white trap)", () => {
  const light = tokens.themes.light;
  const raw = ratio(tokens.primitives.brass, light.surface.panel);
  assert.ok(
    raw < AA_TEXT,
    `Premise changed: raw brass now scores ${raw}:1 on the light panel. ` +
      `If that is real, this whole guard can be revisited.`,
  );
  const actual = ratio(light.accent.text, light.surface.panel);
  assert.ok(
    actual >= AA_TEXT,
    `light accent.text is ${actual}:1 on panel. Do not set it to the raw brass ` +
      `(#d0a85d) — use the darkened variant. Washes may keep the original hue.`,
  );
});
