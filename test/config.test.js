"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../ui/config.js");

test("defaults() is fully populated and self-consistent", () => {
  const d = C.defaults();
  assert.deepEqual(Object.keys(d).sort(), ["panelOrder", "panels", "settings", "wave"]);
  assert.deepEqual(d.panelOrder, C.PANEL_KEYS);
  C.PANEL_KEYS.forEach((k) => assert.equal(typeof d.panels[k], "boolean"));
  assert.equal(d.settings.scope.type, "off");
  assert.equal(d.settings.deepqc.range, "limited");
});

test("defaults() returns fresh copies (no shared references)", () => {
  const a = C.defaults(), b = C.defaults();
  a.settings.scope.type = "waveform";
  a.panels.markers = true;
  assert.equal(b.settings.scope.type, "off");
  assert.equal(b.panels.markers, C.PANEL_DEF.markers);
});

test("normalize(null / garbage) === defaults()", () => {
  assert.deepEqual(C.normalize(null), C.defaults());
  assert.deepEqual(C.normalize("nope"), C.defaults());
  assert.deepEqual(C.normalize(42), C.defaults());
  assert.deepEqual(C.normalize({}), C.defaults());
});

test("normalize keeps valid settings and rejects invalid ones", () => {
  const c = C.normalize({
    settings: {
      theme: "phosphor", textSize: 1.3, monoFont: "Menlo, monospace",
      markerSidecar: true, drawerTab: "storage", experimental: true,
      scope: { type: "parade", layout: "bottom", size: "xl", corner: "bl", bright: 0.4, opacity: 0.5 },
      deepqc: { freeze: false, range: "full", brng: 0.02, tout: 0.1, vrep: 0.9, freezeDur: 4, blackDur: 1 },
    },
  });
  assert.equal(c.settings.theme, "phosphor");
  assert.equal(c.settings.textSize, "1.3");
  assert.equal(c.settings.scope.layout, "bottom");
  assert.equal(c.settings.scope.bright, 0.4);
  assert.equal(c.settings.deepqc.freeze, false);
  assert.equal(c.settings.deepqc.range, "full");
  assert.equal(c.settings.deepqc.brng, 0.02);

  const bad = C.normalize({
    settings: {
      theme: "chartreuse", textSize: "huge", drawerTab: "bogus",
      scope: { type: "nope", layout: "sideways", size: "XXXL", corner: "middle", bright: 99, opacity: -3 },
      deepqc: { range: "sorta", brng: "x" },
    },
  });
  assert.equal(bad.settings.theme, "black");
  assert.equal(bad.settings.textSize, "1.15");
  assert.equal(bad.settings.drawerTab, "panels");
  assert.equal(bad.settings.scope.type, "off");
  assert.equal(bad.settings.scope.layout, "overlay");
  assert.equal(bad.settings.scope.bright, 0.8);   // clamped
  assert.equal(bad.settings.scope.opacity, 0.2);  // clamped
  assert.equal(bad.settings.deepqc.range, "limited");
  assert.equal(bad.settings.deepqc.brng, 0.05);   // default for non-number
});

test("normalize: brng/tout/vrep survive a round-trip (the pre-config.js drift)", () => {
  // main.js normalizeDeep carried these; the web view's applyConfig silently
  // dropped them, so a user-tuned threshold was lost on the next config push.
  const tuned = { brng: 0.033, tout: 0.077, vrep: 0.42 };
  const once = C.normalizeDeepqc(tuned);
  const twice = C.normalizeDeepqc(once);
  assert.deepEqual(once, twice);
  assert.equal(twice.brng, 0.033);
  assert.equal(twice.tout, 0.077);
  assert.equal(twice.vrep, 0.42);
});

test("normalize is idempotent", () => {
  const samples = [
    {},
    { settings: { theme: "amber", scope: { type: "vectorscope" } } },
    { panels: { markers: true, deepqc: true }, settings: { experimental: true } },
    { panelOrder: ["markers", "timecode"], settings: { deepqc: { range: "off" } } },
  ];
  samples.forEach((s) => {
    const a = C.normalize(s);
    assert.deepEqual(C.normalize(a), a);
  });
});

test("panel order: dedupes, drops unknown keys, appends the rest canonically", () => {
  const o = C.normalizeOrder(["markers", "markers", "ghost", "timecode"]);
  assert.deepEqual(o.slice(0, 2), ["markers", "timecode"]);
  assert.deepEqual(o.slice().sort(), C.PANEL_KEYS.slice().sort());
  assert.equal(o.length, C.PANEL_KEYS.length);
});

test("deepqc panel forced off unless experimental is on", () => {
  assert.equal(C.normalize({ panels: { deepqc: true } }).panels.deepqc, false);
  assert.equal(C.normalize({ panels: { deepqc: true }, settings: { experimental: true } }).panels.deepqc, true);
});

test("legacyWin migrates a geometry blob out of the old config shape", () => {
  assert.deepEqual(C.legacyWin({ win: { x: 40, y: 60, w: 520, h: 880 } }), { x: 40, y: 60, w: 520, h: 880 });
  assert.equal(C.legacyWin({ win: { w: 10, h: 10 } }), null);
  assert.equal(C.legacyWin({}), null);
  assert.equal(C.legacyWin(null), null);
});

test("normalize does not carry a `win` key (geometry is per-window, not shared)", () => {
  const c = C.normalize({ win: { x: 1, y: 2, w: 900, h: 700 } });
  assert.equal("win" in c, false);
});
