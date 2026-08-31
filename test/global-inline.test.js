"use strict";
// Guard: global.js inlines lib/sync.js verbatim (IINA's require() can't be
// trusted to return module.exports). This makes sure the copy hasn't drifted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const S = require("../lib/sync.js");

const src = fs.readFileSync(path.join(__dirname, "../global.js"), "utf8");
const m = src.match(/var sync = \(function \(\) \{[\s\S]*?\n\}\)\(\);/);
assert.ok(m, "could not find the inlined `var sync = (function () { ... })();` block in global.js");
// eslint-disable-next-line no-eval
const inlined = eval("(" + m[0].replace(/^var sync = /, "").replace(/;\s*$/, "") + ")");

const cases = [
  ["fpsNum", [{ num: 30000, den: 1001 }]],
  ["rationalize", [23.976]],
  ["timeToFrame", [4.0, S.rationalize(25)]],
  ["frameToTime", [100, S.rationalize(25)]],
  ["computeOffset", [10.0, 10.08, 25]],
  ["computeOffset", [10, 10.5, null]],
  ["bumpOffsetFrames", [3, 2, 30000 / 1001]],
  ["bumpOffsetSec", [1.0, -0.04]],
  ["targetForB", [10, -20]],
  ["detectFpsMismatch", [25, 29.97]],
  ["reconcileCompare", [{ aId: "1", bId: "2", linked: true }, { "1": {} }]],
];

for (const [fn, args] of cases) {
  test(`global.js inline sync.${fn}(${JSON.stringify(args)}) matches lib/sync`, () => {
    assert.ok(typeof inlined[fn] === "function", `inline copy is missing ${fn}`);
    assert.deepEqual(inlined[fn].apply(null, args), S[fn].apply(null, args));
  });
}
