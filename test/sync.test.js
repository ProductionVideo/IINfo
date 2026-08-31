"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../lib/sync.js");

test("rationalize snaps the drop-frame family exactly", () => {
  assert.deepEqual(S.rationalize(30000 / 1001), { num: 30000, den: 1001, fps: 30000 / 1001 });
  assert.deepEqual(S.rationalize(23.976), { num: 24000, den: 1001, fps: 24000 / 1001 });
  assert.deepEqual(S.rationalize(59.94), { num: 60000, den: 1001, fps: 60000 / 1001 });
  assert.deepEqual(S.rationalize(25), { num: 25, den: 1, fps: 25 });
  assert.equal(S.rationalize(0), null);
  assert.equal(S.rationalize(null), null);
});

test("rationalize keeps an odd rate as a milli-fps rational", () => {
  const r = S.rationalize(14.71);
  assert.equal(r.den, 1000);
  assert.ok(Math.abs(r.fps - 14.71) < 1e-9);
});

test("fpsNum accepts float / {fps} / {num,den}", () => {
  assert.equal(S.fpsNum(25), 25);
  assert.equal(S.fpsNum({ fps: 25 }), 25);
  assert.equal(S.fpsNum({ num: 30000, den: 1001 }), 30000 / 1001);
  assert.equal(S.fpsNum(0), null);
  assert.equal(S.fpsNum(null), null);
});

test("timeToFrame / frameToTime round-trip on the frame centre", () => {
  const r = S.rationalize(25);
  assert.equal(S.timeToFrame(4.0, r), 100);
  assert.equal(S.frameToTime(100, r), (100 + 0.5) / 25);
  // a time anywhere inside frame 100 maps back to 100
  assert.equal(S.timeToFrame(S.frameToTime(100, r), r), 100);
  assert.equal(S.timeToFrame(null, r), null);
  assert.equal(S.frameToTime(10, null), null);
});

test("timeToFrame is stable across 23.976", () => {
  const r = S.rationalize(24000 / 1001);
  for (let f = 0; f < 5000; f += 137) {
    assert.equal(S.timeToFrame(S.frameToTime(f, r), r), f);
  }
});

test("computeOffset is frame-quantised to B", () => {
  const rB = S.rationalize(25);
  // B is ~2 frames ahead of A
  const o = S.computeOffset(10.0, 10.08, rB);
  assert.equal(o.offsetFrames, 2);
  assert.equal(o.offsetSec, 2 / 25);
});

test("computeOffset falls back to raw seconds when B fps unknown", () => {
  const o = S.computeOffset(10, 10.5, null);
  assert.equal(o.offsetFrames, null);
  assert.equal(o.offsetSec, 0.5);
});

test("bumpOffsetFrames recomputes seconds from frames (no float drift)", () => {
  const rB = S.rationalize(30000 / 1001);
  let st = { offsetFrames: 0, offsetSec: 0 };
  for (let i = 0; i < 10; i++) st = S.bumpOffsetFrames(st.offsetFrames, 1, rB);
  assert.equal(st.offsetFrames, 10);
  assert.equal(st.offsetSec, 10 / (30000 / 1001));
  st = S.bumpOffsetFrames(st.offsetFrames, -25, rB);
  assert.equal(st.offsetFrames, -15);
});

test("bumpOffsetSec steps elapsed-mode by a raw delta", () => {
  const st = S.bumpOffsetSec(1.0, -1 / 25);
  assert.equal(st.offsetFrames, null);
  assert.ok(Math.abs(st.offsetSec - (1 - 1 / 25)) < 1e-12);
});

test("targetForB clamps at zero", () => {
  assert.equal(S.targetForB(10, 2), 12);
  assert.equal(S.targetForB(0.01, -1), 0);
});

test("detectFpsMismatch", () => {
  assert.equal(S.detectFpsMismatch(25, 25), false);
  assert.equal(S.detectFpsMismatch(23.976, 24000 / 1001), false);
  assert.equal(S.detectFpsMismatch(25, 29.97), true);
  assert.equal(S.detectFpsMismatch(25, null), false);
});

test("offsetLabel", () => {
  assert.equal(S.offsetLabel({ mode: "frame-offset", offsetFrames: 2 }), "B +2f");
  assert.equal(S.offsetLabel({ mode: "frame-offset", offsetFrames: -1 }), "B −1f");
  assert.equal(S.offsetLabel({ mode: "frame-offset", offsetFrames: 0 }), "B ±0f");
  assert.equal(S.offsetLabel({ mode: "elapsed", offsetSec: -1.5 }), "B −1.50s");
});

test("registryReduce: hello then beat merges, keeps identity", () => {
  let p = {};
  p = S.registryReduce(p, { type: "hello", id: "3", rec: { filename: "a.mov", fps: 25 }, now: 1000 });
  assert.equal(p["3"].filename, "a.mov");
  assert.equal(p["3"].lastBeat, 1000);
  p = S.registryReduce(p, { type: "beat", id: "3", rec: { pos: 5, paused: false }, now: 2000 });
  assert.equal(p["3"].filename, "a.mov"); // preserved
  assert.equal(p["3"].pos, 5);
  assert.equal(p["3"].lastBeat, 2000);
});

test("registryReduce: bye and sweep", () => {
  let p = {};
  p = S.registryReduce(p, { type: "hello", id: "1", rec: {}, now: 0 });
  p = S.registryReduce(p, { type: "hello", id: "2", rec: {}, now: 5000 });
  p = S.registryReduce(p, { type: "bye", id: "1" });
  assert.equal(p["1"], undefined);
  assert.equal(Object.keys(p).length, 1);
  p = S.registryReduce(p, { type: "sweep", now: 12000, ttl: 6000 });
  assert.equal(Object.keys(p).length, 0); // id 2 last beat 5000, now 12000 -> stale
});

test("registryReduce does not mutate its input", () => {
  const p0 = {};
  const p1 = S.registryReduce(p0, { type: "hello", id: "1", rec: {}, now: 0 });
  assert.equal(Object.keys(p0).length, 0);
  assert.notEqual(p0, p1);
});

test("reconcileCompare clears a slot whose player vanished and breaks the link", () => {
  const players = { "1": { id: "1" } };
  const s = S.reconcileCompare(
    { aId: "1", bId: "2", linked: true, offsetFrames: 3 },
    players
  );
  assert.equal(s.aId, "1");
  assert.equal(s.bId, null);
  assert.equal(s.linked, false);
  assert.equal(s.offsetFrames, 3); // offset is left intact
});

test("reconcileCompare keeps a healthy link", () => {
  const players = { "1": {}, "2": {} };
  const s = S.reconcileCompare({ aId: "1", bId: "2", linked: true }, players);
  assert.equal(s.linked, true);
});
