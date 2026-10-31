import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// WCAG 2.x: normal-size text needs 4.5:1 against its background, in the light and the dark scheme.
const SHEETS = ["../sidepanel.css", "../../web/web.css"];
const MIN = 4.5;

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const tokens = (css) => Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));

// text colour on the surfaces it is really drawn on
const PAIRS = [
  ["ink", "surface"], ["ink", "bg"], ["ink", "surface-2"], ["ink", "accent-soft"],
  ["muted", "surface"], ["muted", "bg"], ["muted", "surface-2"], ["muted", "accent-soft"],
  ["accent", "surface"], ["accent", "bg"], ["accent", "accent-soft"], ["accent-ink", "accent"],
  ["ok", "surface"], ["ok", "ok-soft"], ["warn", "surface"], ["warn", "warn-soft"], ["err", "surface"], ["err", "err-soft"],
];

for (const sheet of SHEETS) {
  const css = readFileSync(new URL(sheet, import.meta.url), "utf8");
  const dark = css.indexOf("prefers-color-scheme: dark");
  const schemes = { light: tokens(css.slice(0, dark)), dark: tokens(css.slice(dark)) };
  for (const [scheme, t] of Object.entries(schemes)) {
    test(`${sheet} (${scheme}): every text and background pair reaches ${MIN}:1`, () => {
      const low = PAIRS.filter(([fg, bg]) => ratio(t[fg], t[bg]) < MIN)
        .map(([fg, bg]) => `${fg} on ${bg} = ${ratio(t[fg], t[bg]).toFixed(2)}`);
      assert.deepEqual(low, []);
    });
  }
}

test("the dark block really holds its own tokens (the test would pass on nothing otherwise)", () => {
  for (const sheet of SHEETS) {
    const css = readFileSync(new URL(sheet, import.meta.url), "utf8");
    const dark = css.indexOf("prefers-color-scheme: dark");
    assert.ok(dark > 0);
    assert.equal(tokens(css.slice(dark)).accent, "#5b8cff");
    assert.equal(tokens(css.slice(0, dark)).accent, "#1f5eff");
  }
});
