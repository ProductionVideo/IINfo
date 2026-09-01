"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../ui/vcfit.js");

test("contain letterboxes a wider image (pillar/letterbox centred)", () => {
  // 16:9 image into a 4:3 box -> full width, vertical bars
  const r = F.contain(800, 600, 1920, 1080);
  assert.equal(Math.round(r.w), 800);
  assert.equal(Math.round(r.h), 450);
  assert.equal(Math.round(r.x), 0);
  assert.equal(Math.round(r.y), 75);
});

test("contain fits a taller image by height", () => {
  const r = F.contain(800, 600, 1000, 2000);
  assert.equal(Math.round(r.h), 600);
  assert.equal(Math.round(r.w), 300);
  assert.equal(Math.round(r.x), 250);
});

test("contain is safe with zero / missing dimensions", () => {
  assert.deepEqual(F.contain(0, 0, 100, 100), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(F.contain(800, 600, 0, 100), { x: 0, y: 0, w: 800, h: 600 });
});

test("sameSize / diffAllowed", () => {
  assert.equal(F.sameSize({ w: 1920, h: 1080 }, { w: 1920, h: 1080 }), true);
  assert.equal(F.sameSize({ w: 1920, h: 1080 }, { w: 3840, h: 2160 }), false);
  assert.equal(F.diffAllowed({ w: 100, h: 100 }, { w: 100, h: 100 }), true);
  assert.equal(F.diffAllowed({ w: 100, h: 100 }, { w: 100, h: 101 }), false);
  assert.equal(F.diffAllowed(null, { w: 1, h: 1 }), false);
});
