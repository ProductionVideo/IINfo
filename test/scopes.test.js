"use strict";
// scopeGraph() lives in main.js. Rather than duplicate it, pull it out of the
// source and eval it (same technique as test/global-inline.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const m = src.match(/function scopeGraph\(cfg\) \{[\s\S]*?\n\}/);
assert.ok(m, "could not find scopeGraph() in main.js");
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
  assert.match(scopeGraph({ type: "histogram" }), /format=gbrp,histogram,/);
});

test("graph is a labelled 1-in/1-out split/overlay", () => {
  const g = scopeGraph({ type: "waveform" });
  assert.match(g, /^@iinfoscope:lavfi=\[split=2\[m\]\[s\];/);
  assert.match(g, /\[m\]\[sc\]overlay=/);
  assert.match(g, /\]$/);
});

test("size changes the scope box width", () => {
  assert.match(scopeGraph({ type: "waveform", size: "s" }), /scale=320:/);
  assert.match(scopeGraph({ type: "waveform", size: "m" }), /scale=480:/);
  assert.match(scopeGraph({ type: "waveform", size: "l" }), /scale=680:/);
  assert.match(scopeGraph({ type: "waveform", size: "bogus" }), /scale=480:/);  // default M
});

test("vectorscope box is square, others are landscape", () => {
  assert.match(scopeGraph({ type: "vectorscope", size: "m" }), /scale=480:480/);
  assert.match(scopeGraph({ type: "waveform", size: "m" }), /scale=480:298/);   // 480 * 0.62
});

test("corner picks the overlay anchor", () => {
  assert.match(scopeGraph({ type: "waveform", corner: "tl" }), /overlay=x=16:y=16\]$/);
  assert.match(scopeGraph({ type: "waveform", corner: "tr" }), /overlay=x=W-w-16:y=16\]$/);
  assert.match(scopeGraph({ type: "waveform", corner: "bl" }), /overlay=x=16:y=H-h-16\]$/);
  assert.match(scopeGraph({ type: "waveform", corner: "br" }), /overlay=x=W-w-16:y=H-h-16\]$/);
});

test("opacity below 1 inserts a colorchannelmixer alpha step", () => {
  assert.match(scopeGraph({ type: "waveform", opacity: 0.6 }), /format=rgba,colorchannelmixer=aa=0\.60\[sc\]/);
  assert.doesNotMatch(scopeGraph({ type: "waveform", opacity: 1 }), /colorchannelmixer/);
  assert.doesNotMatch(scopeGraph({ type: "waveform" }), /colorchannelmixer/);
});
