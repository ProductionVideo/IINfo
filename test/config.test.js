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
      markerSidecar: true, markerShot: true, drawerTab: "storage", experimental: true,
      scope: { type: "parade", layout: "bottom", size: "xl", corner: "bl", bright: 0.4, opacity: 0.5 },
    },
  });
  assert.equal(c.settings.theme, "phosphor");
  assert.equal(c.settings.textSize, "1.3");
  assert.equal(c.settings.markerShot, true);
  assert.equal(C.normalize({}).settings.markerShot, false);   // opt-in, off by default
  assert.equal(c.settings.scope.layout, "bottom");
  assert.equal(c.settings.scope.bright, 0.4);

  const bad = C.normalize({
    settings: {
      theme: "chartreuse", textSize: "huge", drawerTab: "bogus",
      scope: { type: "nope", layout: "sideways", size: "XXXL", corner: "middle", bright: 99, opacity: -3 },
    },
  });
  assert.equal(bad.settings.theme, "black");
  assert.equal(bad.settings.textSize, "1.15");
  assert.equal(bad.settings.drawerTab, "panels");
  assert.equal(bad.settings.scope.type, "off");
  assert.equal(bad.settings.scope.layout, "overlay");
  assert.equal(bad.settings.scope.bright, 0.8);   // clamped
  assert.equal(bad.settings.scope.opacity, 0.2);  // clamped
});

test("normalize is idempotent", () => {
  const samples = [
    {},
    { settings: { theme: "amber", scope: { type: "vectorscope" } } },
    { panels: { markers: true }, settings: { experimental: true } },
    { panelOrder: ["markers", "timecode"] },
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
