"use strict";
// Guard: main.js inlines lib/deepqc.js verbatim (IINA's require() can't be
// trusted to return module.exports). This makes sure the copy hasn't drifted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const D = require("../lib/deepqc.js");

const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const m = src.match(/var deepqc = \(function \(\) \{[\s\S]*?\n\}\)\(\);/);
assert.ok(m, "could not find the inlined `var deepqc = (function () { ... })();` block in main.js");
// eslint-disable-next-line no-eval
const inlined = eval("(" + m[0].replace(/^var deepqc = /, "").replace(/;\s*$/, "") + ")");

const OPTS = { freeze: true, black: true, outliers: true, range: "limited" };
function ss(o) { const r = {}; for (const k in o) r["lavfi.signalstats." + k] = String(o[k]); return r; }

// drive a whole scenario through both copies and compare the event stream
function run(impl) {
  let st = impl.initState();
  const out = [];
  for (let t = 0; t <= 6000; t += 100) {
    const bad = t >= 1000 && t < 3000;
    const dark = t >= 4000 && t < 5000;
    const meta = ss({ YMAX: dark ? 5 : 235, BRNG: bad ? 0.2 : 0, TOUT: bad ? 0.3 : 0, VREP: 0 });
    if (t === 2000) meta["lavfi.freezedetect.freeze_start"] = "2.0";
    const r = impl.analyze(meta, st, OPTS, t);
    st = r.state;
    out.push.apply(out, r.events);
  }
  out.push.apply(out, impl.flush(st).events);
  return out;
}

test("inlined deepqc matches lib/deepqc over a full scenario", () => {
  assert.deepEqual(run(inlined), run(D));
});

test("inlined deepqc.liveStats matches lib/deepqc", () => {
  const meta = ss({ YMIN: 16, YMAX: 240, YAVG: 118.5, BRNG: 0.02, TOUT: 0.01 });
  assert.deepEqual(inlined.liveStats(meta), D.liveStats(meta));
  assert.deepEqual(inlined.liveStats({}), D.liveStats({}));
});
