"use strict";
// scopeGraph() lives in main.js. Rather than duplicate it, pull it out of the
// source and eval it (same technique as test/global-inline.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const m = src.match(/const SCOPE_SIZES = \{[^}]*\};[\s\S]*?function scopeGraph\(cfg\) \{[\s\S]*?\n\}/);
assert.ok(m, "could not find SCOPE_SIZES + scopeGraph() in main.js");
// eslint-disable-next-line no-eval
const scopeGraph = eval('(function () { var SCOPE_LABEL = "iinfoscope"; ' + m[0] + '; return scopeGraph; })()');

test("off / missing config -> null", () => {
  assert.equal(scopeGraph(null), null);
  assert.equal(scopeGraph({ type: "off" }), null);
  assert.equal(scopeGraph({}), null);
  assert.equal(scopeGraph({ type: "nonsense" }), null);
});

test("each scope type selects the right lavfi filter + input format", () => {
  assert.match(scopeGraph({ type: "waveform" }), /format=yuv444p,waveform=mode=column:components=1/);
  assert.match(scopeGraph({ type: "parade" }), /format=gbrp,waveform=.*components=7.*display=parade/);
  assert.match(scopeGraph({ type: "vectorscope" }), /format=yuv444p,vectorscope=mode=color3/);
  assert.match(scopeGraph({ type: "histogram" }), /format=gbrp,histogram=/);
});

test("scopes get a solid background + a brightness-driven intensity", () => {
  const g = scopeGraph({ type: "waveform", bright: 0.3 });
  assert.match(g, /bgopacity=1/);
  assert.match(g, /intensity=0\.300/);
  // brightness clamps
  assert.match(scopeGraph({ type: "waveform", bright: 5 }), /intensity=0\.800/);
});

test("overlay layout — labelled split/overlay into a picture corner", () => {
  const g = scopeGraph({ type: "waveform", layout: "overlay", corner: "bl", size: "l" });
  assert.match(g, /^@iinfoscope:lavfi=\[split=2\[m\]\[s\];/);
  assert.match(g, /\[m\]\[sc\]overlay=x=18:y=H-h-18\]$/);
  assert.match(g, /scale=760:/);            // L box width
  assert.match(g, /drawbox=/);              // the frame
});

test("size scales the overlay box; XL / XXL exist", () => {
  assert.match(scopeGraph({ type: "waveform", size: "s" }), /scale=380:/);
  assert.match(scopeGraph({ type: "waveform", size: "xl" }), /scale=1000:/);
  assert.match(scopeGraph({ type: "waveform", size: "xxl" }), /scale=1320:/);
});

test("vectorscope overlay box is square", () => {
  assert.match(scopeGraph({ type: "vectorscope", size: "m" }), /scale=560:560,setsar=1/);
});

test("bottom / side layouts dock the scope in a padded strip (no stack format clash)", () => {
  const b = scopeGraph({ type: "waveform", layout: "bottom", size: "l" });
  assert.match(b, /\[m\]pad=w=iw:h=ceil\(ih\*1\.32/);
  assert.match(b, /scale2ref=w=main_w:h=main_h\*0\.2424/);   // 0.32 / 1.32
  assert.match(b, /overlay=x=\(W-w\)\/2:y=H-h\]$/);
  const r = scopeGraph({ type: "waveform", layout: "right", size: "m" });
  assert.match(r, /pad=w=ceil\(iw\*1\.24/);
  assert.match(r, /scale2ref=w=main_w\*0\.1935:h=main_h/);   // 0.24 / 1.24
  assert.match(r, /overlay=x=W-w:y=\(H-h\)\/2\]$/);
});

test("overlay opacity < 1 inserts a colorchannelmixer alpha step; docked ignores it", () => {
  assert.match(scopeGraph({ type: "waveform", opacity: 0.6 }), /colorchannelmixer=aa=0\.60/);
  assert.doesNotMatch(scopeGraph({ type: "waveform", opacity: 1 }), /colorchannelmixer/);
  assert.doesNotMatch(scopeGraph({ type: "waveform", layout: "bottom", opacity: 0.5 }), /colorchannelmixer/);
});
