"use strict";
/*
 * Headless-Chrome UI checks — `npm run check:ui`.
 *
 * Loads the real inspector.html / vcompare.html with a stubbed window.iina and
 * drives the DOM to catch web-view wiring regressions (panel toggles, config
 * push, marker edits, scope controls, the compare overlay) that the pure unit
 * tests can't see. Not part of `npm test` — Chrome is a soft dependency.
 *
 * Skips cleanly (exit 0) when no Chrome/Chromium is found; set CHROME_BIN to
 * point at one explicitly.
 */
const fs = require("fs");
const H = require("./_harness");

const CHECKS = [
  require("./markers.check.js"),
  require("./deepqc.check.js"),
  require("./scope.check.js"),
  require("./compare.check.js"),
  require("./vcompare.check.js"),
];

const chrome = H.findChrome();
if (!chrome) {
  console.log("check:ui — SKIP: no Chrome/Chromium found (set CHROME_BIN to run these)");
  process.exit(0);
}
console.log("check:ui — using " + chrome + "\n");

let failed = 0;
for (const c of CHECKS) {
  try {
    c.run(chrome);
    console.log("  ok   " + c.name);
  } catch (e) {
    failed++;
    console.log("  FAIL " + c.name + "\n       " + String(e.message || e).replace(/\n/g, "\n       "));
  }
}

try { fs.rmSync(H.OUT, { recursive: true, force: true }); } catch (e) { /* leave temp */ }

console.log("\n" + (failed ? failed + " check(s) failed" : "all " + CHECKS.length + " checks passed"));
process.exit(failed ? 1 : 0);
