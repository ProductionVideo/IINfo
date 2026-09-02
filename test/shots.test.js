"use strict";
// shotStamp() / fsSafe() build QC-screenshot filenames in main.js. Pull them
// out of the source and eval them (same technique as test/scopes.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const mStamp = src.match(/function shotStamp\(tc, tMs\) \{[\s\S]*?\n\}/);
const mSafe = src.match(/function fsSafe\(s\) \{[\s\S]*?\n\}/);
assert.ok(mStamp, "could not find shotStamp() in main.js");
assert.ok(mSafe, "could not find fsSafe() in main.js");
// eslint-disable-next-line no-eval
const shotStamp = eval("(function () { " + mStamp[0] + "; return shotStamp; })()");
// eslint-disable-next-line no-eval
const fsSafe = eval("(function () { " + mSafe[0] + "; return fsSafe; })()");

test("shotStamp: SMPTE timecode -> HH.MM.SS;FF (dots between h/m/s, ; before frames)", () => {
  assert.equal(shotStamp("00:01:35:28"), "00.01.35;28");   // non-drop
  assert.equal(shotStamp("00:01:35;28"), "00.01.35;28");   // drop-frame
  assert.equal(shotStamp("01:23:45:12"), "01.23.45;12");
  assert.equal(shotStamp(" 10:00:00:00 "), "10.00.00;00"); // trimmed
});

test("shotStamp: no usable timecode -> milliseconds, never wall-clock", () => {
  assert.equal(shotStamp(null, 8250), "8250ms");
  assert.equal(shotStamp("--:--:--:--", 8250), "8250ms");
  assert.equal(shotStamp("", 0), "0ms");
  assert.equal(shotStamp(undefined, -5), "0ms");
});

test("fsSafe: strips path/reserved chars, collapses whitespace, caps length", () => {
  assert.equal(fsSafe("TESTING"), "TESTING");
  assert.equal(fsSafe("boom dip, L channel"), "boom dip, L channel");
  assert.equal(fsSafe("shot 3: bad/thing"), "shot 3 bad thing");
  assert.equal(fsSafe("a\\b*c?d\"e<f>g|h"), "a b c d e f g h");
  assert.equal(fsSafe("  lots   of   space  "), "lots of space");
  assert.equal(fsSafe(null), "");
  assert.equal(fsSafe(123), "123");
  assert.equal(fsSafe("x".repeat(200)).length, 60);
});
