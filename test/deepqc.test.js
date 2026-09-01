"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../lib/deepqc.js");

const OPTS = { freeze: true, black: true, outliers: true, range: "limited" };

function ss(obj) {
  const m = {};
  for (const k in obj) m["lavfi.signalstats." + k] = String(obj[k]);
  return m;
}

test("clean frames produce no events", () => {
  let st = D.initState();
  for (let t = 0; t < 5000; t += 100) {
    const r = D.analyze(ss({ YMIN: 16, YMAX: 235, YAVG: 120, BRNG: 0, TOUT: 0, VREP: 0 }), st, OPTS, t);
    st = r.state;
    assert.equal(r.events.length, 0);
  }
});

test("a sustained BRNG excursion becomes one range-error span", () => {
  let st = D.initState();
  const out = [];
  // 2 s of illegal levels, then clean
  for (let t = 0; t <= 4000; t += 100) {
    const bad = t >= 1000 && t < 3000;
    const r = D.analyze(ss({ YMAX: 235, BRNG: bad ? 0.2 : 0, TOUT: 0, VREP: 0 }), st, OPTS, t);
    st = r.state;
    out.push.apply(out, r.events);
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "range-error");
  assert.equal(out[0].source, "signalstats");
  assert.equal(out[0].category, "Colour");
  assert.equal(out[0].tMs, 1000);
  assert.ok(out[0].durMs >= 1800 && out[0].durMs <= 2000);
  assert.match(out[0].note, /BRNG 20\.0%/);
});

test("excursions less than 300 ms are ignored", () => {
  let st = D.initState();
  const out = [];
  for (let t = 0; t <= 2000; t += 100) {
    const bad = t >= 1000 && t < 1200;   // 200 ms
    const r = D.analyze(ss({ YMAX: 235, BRNG: bad ? 0.3 : 0 }), st, OPTS, t);
    st = r.state;
    out.push.apply(out, r.events);
  }
  assert.equal(out.length, 0);
});

test("two dirty stretches under 1 s apart merge into one span", () => {
  let st = D.initState();
  const out = [];
  for (let t = 0; t <= 5000; t += 100) {
    // dirty 500-1200, clean 1200-1800 (600 ms gap), dirty 1800-2500
    const bad = (t >= 500 && t < 1200) || (t >= 1800 && t < 2500);
    const r = D.analyze(ss({ YMAX: 235, BRNG: bad ? 0.1 : 0 }), st, OPTS, t);
    st = r.state;
    out.push.apply(out, r.events);
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].tMs, 500);
  assert.ok(out[0].durMs >= 1900);
});

test("gaps over 1 s split into separate spans", () => {
  let st = D.initState();
  const out = [];
  for (let t = 0; t <= 6000; t += 100) {
    const bad = (t >= 500 && t < 1200) || (t >= 3000 && t < 3800);
    const r = D.analyze(ss({ YMAX: 235, TOUT: bad ? 0.4 : 0 }), st, OPTS, t);
    st = r.state;
    out.push.apply(out, r.events);
  }
  const f = D.flush(st);
  out.push.apply(out, f.events);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, "noise");
  assert.equal(out[0].tMs, 500);
  assert.equal(out[1].tMs, 3000);
});

test("flush() closes a span still open at end of stream", () => {
  let st = D.initState();
  for (let t = 0; t <= 2000; t += 100) {
    st = D.analyze(ss({ YMAX: 235, VREP: 0.8 }), st, OPTS, t).state;
  }
  const r = D.flush(st);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, "line-repeat");
  assert.equal(r.events[0].tMs, 0);
  // a second flush has nothing left
  assert.equal(D.flush(r.state).events.length, 0);
});

test("range:off suppresses BRNG; outliers:false suppresses TOUT/VREP", () => {
  let st = D.initState();
  const out = [];
  for (let t = 0; t <= 3000; t += 100) {
    const r = D.analyze(ss({ YMAX: 235, BRNG: 0.5, TOUT: 0.5, VREP: 0.9 }), st,
      { range: "off", outliers: false, black: true, freeze: true }, t);
    st = r.state;
    out.push.apply(out, r.events);
  }
  out.push.apply(out, D.flush(st).events);
  assert.equal(out.length, 0);
});

test("sustained low YMAX -> a black-frame error span", () => {
  let st = D.initState();
  const out = [];
  for (let t = 0; t <= 3000; t += 100) {
    const dark = t >= 1000 && t < 2000;
    const r = D.analyze(ss({ YMAX: dark ? 6 : 200 }), st, OPTS, t);
    st = r.state;
    out.push.apply(out, r.events);
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "black-frame");
  assert.equal(out[0].severity, "error");
  assert.equal(out[0].tMs, 1000);
});

test("black honours blackDur (0.2 s dip below default 0.5 s is ignored)", () => {
  let st = D.initState();
  const out = [];
  for (let t = 0; t <= 2000; t += 100) {
    const dark = t >= 800 && t < 1000;
    const r = D.analyze(ss({ YMAX: dark ? 4 : 180 }), st, OPTS, t);
    st = r.state;
    out.push.apply(out, r.events);
  }
  assert.equal(out.length, 0);
});

test("10-bit luma range still detects black", () => {
  let st = D.initState();
  const out = [];
  for (let t = 0; t <= 2000; t += 100) {
    const r = D.analyze(ss({ YMAX: 20 }), st, OPTS, t);   // 20/1023 ~ black
    st = r.state;
    out.push.apply(out, r.events);
  }
  out.push.apply(out, D.flush(st).events);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "black-frame");
});

test("freeze_start emits once, then a corrected duration when freeze_end lands", () => {
  let st = D.initState();
  const a = D.analyze({ "lavfi.freezedetect.freeze_start": "2.0" }, st, OPTS, 2000);
  st = a.state;
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].type, "freeze");
  assert.equal(a.events[0].source, "freezedetect");
  assert.equal(a.events[0].tMs, 2000);
  assert.equal(a.events[0].durMs, 0);

  // re-seen across polls with no duration yet -> no duplicate
  const b = D.analyze({ "lavfi.freezedetect.freeze_start": "2.0" }, st, OPTS, 2500);
  st = b.state;
  assert.equal(b.events.length, 0);

  // freeze_end -> one corrected event at the same tMs
  const c = D.analyze({
    "lavfi.freezedetect.freeze_start": "2.0",
    "lavfi.freezedetect.freeze_duration": "3.5",
    "lavfi.freezedetect.freeze_end": "5.5",
  }, st, OPTS, 5500);
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].tMs, 2000);
  assert.equal(c.events[0].durMs, 3500);
  assert.match(c.events[0].note, /3\.5s/);
});

test("freeze:false suppresses freeze events", () => {
  const r = D.analyze({ "lavfi.freezedetect.freeze_start": "1.0" }, D.initState(),
    { freeze: false }, 1000);
  assert.equal(r.events.length, 0);
});

test("analyze never mutates the state it is given", () => {
  const st = D.initState();
  const snapshot = JSON.stringify(st);
  D.analyze(ss({ YMAX: 4, BRNG: 0.9 }), st, OPTS, 500);
  assert.equal(JSON.stringify(st), snapshot);
});

test("liveStats parses the signalstats readout", () => {
  assert.equal(D.liveStats({}), null);
  const s = D.liveStats(ss({ YMIN: 16, YMAX: 240, YAVG: 118.5, BRNG: 0.02, TOUT: 0.01 }));
  assert.deepEqual(s, { yMin: 16, yMax: 240, yAvg: 118.5, brng: 0.02, tout: 0.01, vrep: null });
});
