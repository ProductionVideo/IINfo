"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../ui/abtech.js");

function base() {
  return {
    container: "mov", vcodec: "prores", vdecoder: "prores",
    w: 3840, h: 2160, dw: 3840, dh: 2160, par: 1, dar: "16:9",
    pixfmt: "yuv422p10le", range: "limited", matrix: "bt.709",
    primaries: "bt.709", transfer: "bt.709", sigPeak: 1,
    fps: 25, duration: 272.4, frameCount: 6810, vbitrate: 178000000,
    acodec: "pcm_s24le", asr: 48000, ach: 2, alayout: "stereo",
    afmt: "s32", abitrate: 2300000,
  };
}
function rowFor(rows, key) { return rows.find((r) => r.key === key); }

test("identical tech -> zero differences", () => {
  const r = T.rows(base(), base());
  assert.equal(T.diffCount(r), 0);
  assert.ok(r.length > 15);
});

test("colour range limited vs full is the only difference", () => {
  const b = base(); b.range = "full";
  const r = T.rows(base(), b);
  assert.equal(T.diffCount(r), 1);
  assert.equal(rowFor(r, "range").differ, true);
  assert.equal(rowFor(r, "range").a, "limited");
  assert.equal(rowFor(r, "range").b, "full");
});

test("pixel format 8-bit vs 10-bit flags both the format and the depth rows", () => {
  const a = base(); a.pixfmt = "yuv420p";
  const b = base(); b.pixfmt = "yuv420p10le";
  const r = T.rows(a, b);
  assert.equal(rowFor(r, "pixfmt").differ, true);
  assert.equal(rowFor(r, "vdepth").a, "8-bit");
  assert.equal(rowFor(r, "vdepth").b, "10-bit");
  assert.equal(rowFor(r, "vdepth").differ, true);
});

test("fps within the tolerance is not a difference", () => {
  const b = base(); b.fps = 25.001;
  assert.equal(rowFor(T.rows(base(), b), "fps").differ, false);
  const c = base(); c.fps = 23.976;
  assert.equal(rowFor(T.rows(base(), c), "fps").differ, true);
});

test("video bitrate: small drift is tolerated, a real drop is flagged", () => {
  const near = base(); near.vbitrate = 176000000;
  assert.equal(rowFor(T.rows(base(), near), "vbitrate").differ, false);
  const far = base(); far.vbitrate = 140000000;
  assert.equal(rowFor(T.rows(base(), far), "vbitrate").differ, true);
  assert.equal(rowFor(T.rows(base(), far), "vbitrate").approx, true);
});

test("audio bit depth comes from the PCM codec name", () => {
  const a = base(); a.acodec = "pcm_s24le"; a.afmt = "s32";
  const b = base(); b.acodec = "pcm_s16le"; b.afmt = "s16";
  const r = T.rows(a, b);
  assert.equal(rowFor(r, "adepth").a, "24-bit");
  assert.equal(rowFor(r, "adepth").b, "16-bit");
  assert.equal(rowFor(r, "adepth").differ, true);
});

test("a value present on one side only counts as a difference", () => {
  const b = base(); delete b.transfer;
  const r = T.rows(base(), b);
  assert.equal(rowFor(r, "transfer").a, "bt.709");
  assert.equal(rowFor(r, "transfer").b, "—");
  assert.equal(rowFor(r, "transfer").differ, true);
});

test("rows() returns null when either side has no metadata", () => {
  assert.equal(T.rows(null, base()), null);
  assert.equal(T.rows(base(), {}), null);
  assert.equal(T.rows({}, {}), null);
});

test("duration formats as H:MM:SS", () => {
  const a = base(); a.duration = 3661;
  const b = base(); b.duration = 3661;
  assert.equal(rowFor(T.rows(a, b), "duration").a, "1:01:01");
});
