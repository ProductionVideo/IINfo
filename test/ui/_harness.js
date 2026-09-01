"use strict";
/*
 * Shared plumbing for the headless-Chrome UI checks.
 *
 * These are NOT part of `npm test` — Chrome is a soft dependency. They protect
 * the web view's wiring and message handling (panel toggles, config push,
 * marker edits, scope controls, the compare overlay) against regressions the
 * pure unit tests can't see, by loading the real inspector.html / vcompare.html
 * with a stubbed `window.iina` and driving the DOM.
 *
 * Run them with `npm run check:ui`.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const UI = path.join(__dirname, "..", "..", "ui");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "iinfo-ui-"));

// Chrome / Chromium, in order of preference. Override with CHROME_BIN.
const CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
function findChrome() {
  for (const c of CANDIDATES) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { /* keep looking */ }
  }
  return null;
}

function read(name) { return fs.readFileSync(path.join(UI, name), "utf8"); }

// inline every <script src> / <link> the page references so it runs from a
// file:// temp path with no network and no relative-path resolution
function inlineInspector(shim, driver) {
  let page = read("inspector.html")
    .replace('<link rel="stylesheet" href="inspector.css" />', "<style>\n" + read("inspector.css") + "\n</style>")
    .replace('<script src="config.js"></script>', "<script>" + read("config.js") + "</script>")
    .replace('<script src="events.js"></script>', "<script>" + read("events.js") + "</script>")
    .replace('<script src="abtech.js"></script>', "<script>" + read("abtech.js") + "</script>")
    .replace('<script src="inspector.js"></script>',
      "<script>" + shim + "</script>\n<script>" + read("inspector.js") + "</script>\n<script>" + driver + "</script>");
  return page;
}

function inlineVCompare(shim, driver) {
  return read("vcompare.html")
    .replace('<script src="vcfit.js"></script>', "<script>" + shim + read("vcfit.js") + "</script>")
    .replace('<script src="vcompare.js"></script>',
      "<script>" + read("vcompare.js") + "</script>\n<script>" + driver + "</script>");
}

// write `page`, load it headless, pull the `RESULT {json}` the driver stamps
// into document.title back out
function render(chrome, name, page, budgetMs) {
  const htmlPath = path.join(OUT, name + ".html");
  fs.writeFileSync(htmlPath, page);
  const dom = execFileSync(chrome, [
    "--headless", "--disable-gpu", "--no-sandbox",
    "--virtual-time-budget=" + (budgetMs || 4000),
    "--dump-dom", "file://" + htmlPath,
  ], { encoding: "utf8", maxBuffer: 1e8 });
  const m = dom.match(/RESULT (\{[\s\S]*?\})<\/title>/);
  if (!m) throw new Error(name + ": no RESULT in page\n" + dom.slice(0, 2000));
  // --dump-dom HTML-encodes the title text we stashed the JSON in
  const json = m[1].replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  let res;
  try { res = JSON.parse(json); } catch (e) { throw new Error(name + ": bad RESULT json — " + json); }
  if (res.fatal) throw new Error(name + ": driver threw — " + res.fatal);
  if (res.errors && res.errors.length) throw new Error(name + ": console/page errors — " + JSON.stringify(res.errors));
  return res;
}

// a driver body: run `body`, always finish by stamping document.title
function driver(body, delayMs) {
  return `setTimeout(function () {
    var out = { errors: window.__errors || [], steps: [] };
    try { (function (out) { ${body} })(out); }
    catch (e) { out.fatal = String(e && e.stack || e); }
    document.title = "RESULT " + JSON.stringify(out);
  }, ${delayMs || 700});`;
}

const errorHook = `
window.__errors = [];
window.addEventListener("error", function (e) { window.__errors.push(String(e.message || e.error)); });
window.addEventListener("unhandledrejection", function (e) { window.__errors.push("promise: " + (e.reason && e.reason.message || e.reason)); });
`;

module.exports = { UI, OUT, findChrome, read, inlineInspector, inlineVCompare, render, driver, errorHook };
