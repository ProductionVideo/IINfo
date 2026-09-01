"use strict";
// Guard: main.js inlines ui/events.js verbatim as the single QC event writer
// (`var qcevents`). markHere() and finalizeQC() both build events through it,
// so this copy drifting from ui/events.js would split the schema again (M3).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const E = require("../ui/events.js");

const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const m = src.match(/var qcevents = \(function \(\) \{[\s\S]*?\n\}\)\(\);/);
assert.ok(m, "could not find the inlined `var qcevents = (function () { ... })();` block in main.js");
// eslint-disable-next-line no-eval
const inlined = eval("(" + m[0].replace(/^var qcevents = /, "").replace(/;\s*$/, "") + ")");

// Date/Math.random make ids + ts non-deterministic — strip them for comparison.
function stable(ev) {
  const c = Object.assign({}, ev);
  delete c.id; delete c.ts;
  return c;
}

test("inlined qcevents.create matches ui/events.js over many capture contexts", () => {
  const ctxs = [
    { source: "manual", type: "marker", tMs: 5000, frame: 125, fps: 25, tc: "00:00:05:00" },
    { source: "manual", type: "marker", tMs: 5000, frame: 125, fps: 25, tc: "00:00:05:00",
      abActive: true, aId: 3, bId: 7 },
    { source: "signalstats", type: "range-error", tMs: 1234, durMs: 800, category: "Colour",
      severity: "warning", note: "BRNG 12%", meta: { auto: true, peak: 0.12 } },
    { source: "freezedetect", type: "freeze", tMs: 2000, durMs: 2000, category: "Video",
      meta: { auto: true } },
    { source: "video", type: "black-frame", frame: 240, fps: 24, category: "Video", severity: "error" },
    { source: "weird-future-source", type: "whatever", tMs: 10, category: "bogus", severity: "nope" },
  ];
  ctxs.forEach((ctx) => {
    assert.deepEqual(stable(inlined.create(ctx)), stable(E.create(ctx)),
      "create mismatch for " + JSON.stringify(ctx));
  });
});

test("inlined qcevents.serialize matches ui/events.js (envelope + normalisation)", () => {
  const list = [
    E.create({ source: "manual", type: "marker", tMs: 3000, frame: 72, fps: 24 }),
    E.create({ source: "signalstats", type: "noise", tMs: 900, durMs: 400, category: "Video" }),
  ];
  const media = { path: "/w/a.mov", filename: "a.mov", size: 1e8 };
  const strip = (s) => s.replace(/"saved": "[^"]*"/, '"saved": "X"');
  assert.equal(strip(inlined.serialize(list, media)), strip(E.serialize(list, media)));
});

test("inlined qcevents round-trips through deserialize like ui/events.js", () => {
  const list = [E.create({ source: "manual", type: "marker", tMs: 1000, frame: 24, fps: 24 })];
  const json = inlined.serialize(list, null);
  assert.deepEqual(inlined.deserialize(json).events.map(stable), E.deserialize(json).events.map(stable));
});

test("inlined qcevents.matches / filter behave identically (q.auto included)", () => {
  const list = [
    E.create({ source: "manual", type: "marker", tMs: 100 }),
    E.create({ source: "signalstats", type: "noise", tMs: 200 }),
  ];
  [{ auto: true }, { auto: false }, { source: "manual" }, { severity: "warning" }].forEach((q) => {
    assert.deepEqual(inlined.filter(list, q).map((e) => e.tMs), E.filter(list, q).map((e) => e.tMs));
  });
});
