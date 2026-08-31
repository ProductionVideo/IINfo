"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../ui/events.js");

/* ------------------------------------------------------------------ create */

test("create fills defaults and generates an id", () => {
  const e = Q.create({ tMs: 1234.6 });
  assert.equal(e.tMs, 1235);              // rounded ms
  assert.match(e.id, /^qc_/);
  assert.equal(e.source, "manual");
  assert.equal(e.type, "marker");
  assert.equal(e.category, "Other");
  assert.equal(e.severity, "warning");
  assert.equal(e.note, "");
  assert.equal(e.resolved, false);
  assert.equal(e.frame, null);
  assert.equal(e.fps, null);
  assert.equal(e.tc, null);
  assert.equal(e.durMs, null);
  assert.equal(typeof e.ts, "number");
  assert.deepEqual(e.meta, {});
});

test("create derives tMs from frame + fps when tMs is absent", () => {
  const e = Q.create({ frame: 100, fps: 25 });
  assert.equal(e.tMs, Math.round((100 + 0.5) / 25 * 1000)); // 4020
});

test("create returns null without a usable position", () => {
  assert.equal(Q.create({ note: "no time" }), null);
  assert.equal(Q.create({}), null);
  assert.equal(Q.create(null), null);
});

test("create folds A/B convenience keys into meta", () => {
  const e = Q.create({ tMs: 0, abActive: true, aId: 7, bId: 9, meta: { x: 1 } });
  assert.deepEqual(e.meta, { x: 1, abActive: true, aId: "7", bId: "9" });
});

test("create clamps an unknown category / severity to the safe default", () => {
  const e = Q.create({ tMs: 0, category: "Nonsense", severity: "critical" });
  assert.equal(e.category, "Other");
  assert.equal(e.severity, "warning");
});

/* ------------------------------------------------------------------ update */

test("update is immutable and only touches whitelisted fields", () => {
  const a = Q.create({ tMs: 1000, category: "Video" });
  const b = Q.update(a, { note: "torn frame", severity: "error", tMs: 5, id: "hacked", resolved: true });
  assert.notEqual(a, b);
  assert.equal(a.note, "");                 // original untouched
  assert.equal(b.note, "torn frame");
  assert.equal(b.severity, "error");
  assert.equal(b.tMs, 1000);                // tMs not editable via update
  assert.equal(b.id, a.id);                 // id not editable
  assert.equal(b.resolved, false);          // resolved goes through withResolved
});

test("withResolved flips the flag without mutating", () => {
  const a = Q.create({ tMs: 0 });
  const b = Q.withResolved(a, true);
  assert.equal(a.resolved, false);
  assert.equal(b.resolved, true);
  assert.equal(Q.withResolved(b, false).resolved, false);
});

/* ------------------------------------------------------------------ sort / filter */

test("sort is chronological with a stable ts tiebreak", () => {
  const list = [
    { tMs: 300, ts: 1 }, { tMs: 100, ts: 5 }, { tMs: 100, ts: 2 }, { tMs: 200, ts: 9 },
  ];
  assert.deepEqual(Q.sort(list).map((e) => [e.tMs, e.ts]), [[100, 2], [100, 5], [200, 9], [300, 1]]);
  // does not mutate the input
  assert.equal(list[0].tMs, 300);
});

test("filter matches any subset of the query", () => {
  const list = [
    Q.create({ tMs: 0, source: "manual", category: "Audio", severity: "error", note: "hum" }),
    Q.create({ tMs: 10, source: "audio", category: "Audio", severity: "info", note: "clip at peak" }),
    Q.create({ tMs: 20, source: "manual", category: "Video", severity: "warning", note: "" }),
  ];
  assert.equal(Q.filter(list, { source: "manual" }).length, 2);
  assert.equal(Q.filter(list, { category: "Audio" }).length, 2);
  assert.equal(Q.filter(list, { severity: "error" }).length, 1);
  assert.equal(Q.filter(list, { text: "CLIP" }).length, 1);
  assert.equal(Q.filter(list, { source: "manual", category: "Audio" }).length, 1);
  assert.equal(Q.filter(list, {}).length, 3);
});

test("filter on resolved is an explicit boolean match", () => {
  const list = [
    Q.withResolved(Q.create({ tMs: 0 }), true),
    Q.create({ tMs: 1 }),
  ];
  assert.equal(Q.filter(list, { resolved: false }).length, 1);
  assert.equal(Q.filter(list, { resolved: true }).length, 1);
});

/* ------------------------------------------------------------------ prev / next */

test("prev / next find the nearest event strictly to one side", () => {
  const list = Q.sort([
    Q.create({ tMs: 1000 }), Q.create({ tMs: 2000 }), Q.create({ tMs: 3000 }),
  ]);
  assert.equal(Q.next(list, 1500).tMs, 2000);
  assert.equal(Q.prev(list, 1500).tMs, 1000);
  assert.equal(Q.next(list, 2000).tMs, 3000);  // strict — skips the one you're on
  assert.equal(Q.prev(list, 2000).tMs, 1000);
  assert.equal(Q.next(list, 3000), null);
  assert.equal(Q.prev(list, 1000), null);
});

test("prev / next respect the filter", () => {
  const list = [
    Q.create({ tMs: 1000, category: "Audio" }),
    Q.create({ tMs: 2000, category: "Video" }),
    Q.create({ tMs: 3000, category: "Audio" }),
  ];
  assert.equal(Q.next(list, 1500, { category: "Audio" }).tMs, 3000);
  assert.equal(Q.prev(list, 2500, { category: "Video" }).tMs, 2000);
});

/* ------------------------------------------------------------------ serialize */

test("serialize / deserialize round-trips the events", () => {
  const media = { path: "/v/a.mov", filename: "a.mov", size: 123, durationMs: 4000, fps: 25 };
  const list = [
    Q.create({ tMs: 2000, frame: 50, fps: 25, tc: "00:00:02:00", category: "Colour", note: 'has "quotes"' }),
    Q.withResolved(Q.create({ tMs: 500, source: "compare", type: "technical-difference", meta: { field: "range" } }), true),
  ];
  const round = Q.deserialize(Q.serialize(list, media));
  assert.deepEqual(round.media, media);
  assert.equal(round.events.length, 2);
  assert.equal(round.events[0].tMs, 500);                 // sorted on write
  assert.equal(round.events[1].note, 'has "quotes"');
  assert.equal(round.events[0].meta.field, "range");
  assert.equal(round.events[0].resolved, true);
});

test("deserialize tolerates junk and drops malformed events", () => {
  assert.equal(Q.deserialize("not json"), null);
  assert.equal(Q.deserialize('{"nope":1}'), null);
  const r = Q.deserialize(JSON.stringify({
    iinfo: "qc-markers", version: 1,
    events: [{ tMs: 100, note: "ok" }, { note: "no position" }, null, 42],
  }));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].note, "ok");
});

test("deserialize also accepts a bare events array", () => {
  const r = Q.deserialize(JSON.stringify([{ tMs: 10 }, { tMs: 20 }]));
  assert.equal(r.events.length, 2);
  assert.equal(r.media, null);
});

/* ------------------------------------------------------------------ exports */

test("toCSV quotes cells that need it (RFC 4180)", () => {
  const list = [Q.create({ tMs: 1000, tc: "00:00:01:00", frame: 25, category: "Audio", note: 'a, b "c"\nd' })];
  const csv = Q.toCSV(list);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "id,source,type,tc,frame,tMs,durMs,category,severity,resolved,note");
  assert.match(lines[1], /"a, b ""c""\nd"$/);
});

test("toReport is human-readable and counts unresolved", () => {
  const list = [
    Q.create({ tMs: 1000, tc: "00:00:01:00", frame: 25, category: "Video", severity: "error", note: "dropout" }),
    Q.withResolved(Q.create({ tMs: 2000, tc: "00:00:02:00", category: "Audio" }), true),
  ];
  const r = Q.toReport(list, { path: "/v/a.mov" });
  assert.match(r, /2 markers · 1 unresolved/);
  assert.match(r, /1\. \[ERROR\] 00:00:01:00  #25  Video/);
  assert.match(r, /dropout/);
  assert.match(r, /✓resolved/);
});
