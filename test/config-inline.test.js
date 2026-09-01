"use strict";
// Guard: main.js inlines ui/config.js verbatim (IINA's require() can't be
// trusted to return module.exports). This makes sure the copy hasn't drifted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const C = require("../ui/config.js");

const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const m = src.match(/var iinfocfg = \(function \(\) \{[\s\S]*?\n\}\)\(\);/);
assert.ok(m, "could not find the inlined `var iinfocfg = (function () { ... })();` block in main.js");
// eslint-disable-next-line no-eval
const inlined = eval("(" + m[0].replace(/^var iinfocfg = /, "").replace(/;\s*$/, "") + ")");

test("inlined config constants match ui/config.js", () => {
  assert.deepEqual(inlined.PANEL_KEYS, C.PANEL_KEYS);
  assert.deepEqual(inlined.PANEL_DEF, C.PANEL_DEF);
  assert.deepEqual(inlined.THEMES, C.THEMES);
  assert.deepEqual(inlined.SCOPE_TYPES, C.SCOPE_TYPES);
  assert.equal(inlined.DEFAULT_MONO, C.DEFAULT_MONO);
});

test("inlined config.defaults() matches ui/config.js", () => {
  assert.deepEqual(inlined.defaults(), C.defaults());
  assert.deepEqual(inlined.scopeDefault(), C.scopeDefault());
  assert.deepEqual(inlined.deepqcDefault(), C.deepqcDefault());
  assert.deepEqual(inlined.settingsDefault(), C.settingsDefault());
});

test("inlined config.normalize() matches ui/config.js over many shapes", () => {
  const cases = [
    null, undefined, {}, "junk", 7,
    { settings: { theme: "amber", scope: { type: "parade", layout: "right", size: "xxl" } } },
    { settings: { experimental: true }, panels: { deepqc: true, markers: true } },
    { settings: { deepqc: { range: "full", brng: 0.02, tout: 0.09, vrep: 0.3 } } },
    { settings: { theme: "nope", textSize: "big", scope: { bright: 99, opacity: -1 } } },
    { panelOrder: ["markers", "ghost", "timecode", "markers"] },
    { win: { x: 10, y: 20, w: 900, h: 700 } },
  ];
  cases.forEach((raw) => {
    assert.deepEqual(inlined.normalize(raw), C.normalize(raw), "normalize mismatch for " + JSON.stringify(raw));
    assert.deepEqual(inlined.legacyWin(raw || {}), C.legacyWin(raw || {}));
  });
});

test("inlined normalizeScope / normalizeDeepqc match ui/config.js", () => {
  assert.deepEqual(inlined.normalizeScope({ type: "vectorscope", corner: "bad" }),
    C.normalizeScope({ type: "vectorscope", corner: "bad" }));
  assert.deepEqual(inlined.normalizeDeepqc({ freeze: false, blackDur: 3, brng: 0.01 }),
    C.normalizeDeepqc({ freeze: false, blackDur: 3, brng: 0.01 }));
});
