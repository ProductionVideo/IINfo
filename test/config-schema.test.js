"use strict";
// Guard: ui/config.js declares the canonical panel keys + default visibility.
// ui/inspector.js builds the panels and carries its own `def:` on each. If the
// two drift, a panel gets the wrong out-of-box visibility on one side only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const C = require("../ui/config.js");

const src = fs.readFileSync(path.join(__dirname, "../ui/inspector.js"), "utf8");

// ORDER = ["timecode", "frame", ...]
const orderMatch = src.match(/var ORDER = (\[[^\]]*\]);/);
assert.ok(orderMatch, "could not find `var ORDER = [...]` in inspector.js");
const order = JSON.parse(orderMatch[1].replace(/'/g, '"'));

test("config.PANEL_KEYS matches inspector.js ORDER exactly", () => {
  assert.deepEqual(C.PANEL_KEYS, order);
});

// each panel: `P.<key> = (function () { ... return { key: "<key>", title: "...", def: <bool>, ...`
test("config.PANEL_DEF matches each inspector.js P.<key>.def", () => {
  order.forEach((key) => {
    const re = new RegExp("key:\\s*\"" + key + "\"[\\s\\S]{0,80}?def:\\s*(true|false)");
    const m = src.match(re);
    assert.ok(m, "no `def:` found for panel " + key + " in inspector.js");
    const def = m[1] === "true";
    assert.equal(C.PANEL_DEF[key], def, "PANEL_DEF." + key + " should be " + def);
  });
});

test("config.PANEL_DEF has an entry for every key and nothing extra", () => {
  assert.deepEqual(Object.keys(C.PANEL_DEF).sort(), C.PANEL_KEYS.slice().sort());
});
