"use strict";
/*
 * IINfo — pure frame/time/offset/registry logic for A/B compare.
 *
 * No DOM, no `iina`, no timers. Loaded three ways:
 *   - main.js / global.js via IINA's node-style require("./lib/sync.js")
 *   - test/sync.test.js via `node --test`
 * so every rule here is unit-testable in isolation.
 */

/* ------------------------------------------------------------ frame rates */

// the broadcast rationals worth snapping to — everything else stays a float
var COMMON_RATES = [
  [24000, 1001], [30000, 1001], [60000, 1001], [48000, 1001], [120000, 1001],
  [24, 1], [25, 1], [30, 1], [48, 1], [50, 1], [60, 1], [100, 1], [120, 1],
];

// float fps -> { num, den, fps }. Recognises the drop-frame family exactly so
// frame maths doesn't drift; falls back to a milli-fps rational otherwise.
function rationalize(fps) {
  if (fps == null || !isFinite(fps) || fps <= 0) return null;
  for (var i = 0; i < COMMON_RATES.length; i++) {
    var n = COMMON_RATES[i][0], d = COMMON_RATES[i][1];
    if (Math.abs(fps - n / d) < 0.005) return { num: n, den: d, fps: n / d };
  }
  return { num: Math.round(fps * 1000), den: 1000, fps: fps };
}

// accept a float, a { fps }, or a { num, den } and return a usable float fps
function fpsNum(r) {
  if (r == null) return null;
  if (typeof r === "number") return isFinite(r) && r > 0 ? r : null;
  if (typeof r.fps === "number" && r.fps > 0) return r.fps;
  if (r.num && r.den) return r.num / r.den;
  return null;
}

/* ------------------------------------------------------------ frame <-> time */

// seconds -> index of the frame on screen at that instant. floor (+ float slack)
// so it is the exact inverse of frameToTime()'s frame-centre.
function timeToFrame(t, r) {
  var f = fpsNum(r);
  if (t == null || !isFinite(t) || !f) return null;
  return Math.max(0, Math.floor(t * f + 1e-6));
}

// frame index -> seconds at the frame *centre* (matches inspector.js doJump())
function frameToTime(frame, r) {
  var f = fpsNum(r);
  if (frame == null || !isFinite(frame) || !f) return null;
  return (frame + 0.5) / f;
}

/* ------------------------------------------------------------ A/B offset */

// offset such that: B position = A position + offset. Frame-quantised to B's
// grid when B's fps is known, otherwise a raw elapsed-time delta.
function computeOffset(aPos, bPos, rB) {
  var dt = (bPos || 0) - (aPos || 0);
  var f = fpsNum(rB);
  if (!f) return { offsetSec: dt, offsetFrames: null };
  var frames = Math.round(dt * f);
  return { offsetSec: frames / f, offsetFrames: frames };
}

// nudge a frame-mode offset by whole frames
function bumpOffsetFrames(offsetFrames, delta, rB) {
  var f = fpsNum(rB);
  var nf = (offsetFrames || 0) + delta;
  return { offsetFrames: nf, offsetSec: f ? nf / f : (offsetFrames || 0) };
}

// nudge an elapsed-mode offset by seconds (used when fps is unknown/mismatched;
// callers pass 1/fpsB for a "one frame" step)
function bumpOffsetSec(offsetSec, deltaSec) {
  return { offsetSec: (offsetSec || 0) + deltaSec, offsetFrames: null };
}

// where B should seek when A is being sent to absolute time tA
function targetForB(tA, offsetSec) {
  return Math.max(0, (tA || 0) + (offsetSec || 0));
}

function detectFpsMismatch(fpsA, fpsB) {
  var a = fpsNum(fpsA), b = fpsNum(fpsB);
  if (!a || !b) return false;
  return Math.abs(a - b) > 0.01;
}

// human label for the compare badge, e.g. "B +2f" or "B −1:00" (elapsed)
function offsetLabel(state) {
  if (!state) return "";
  var mode = state.mode || "frame-offset";
  if (mode === "frame-offset" && state.offsetFrames != null) {
    if (state.offsetFrames === 0) return "B ±0f";
    return "B " + (state.offsetFrames > 0 ? "+" : "−") + Math.abs(state.offsetFrames) + "f";
  }
  var s = state.offsetSec || 0;
  var sign = s < 0 ? "−" : "+";
  s = Math.abs(s);
  var m = Math.floor(s / 60), rem = s - m * 60;
  return "B " + sign + (m ? m + ":" + (rem < 10 ? "0" : "") : "") + rem.toFixed(2) + (m ? "" : "s");
}

/* ------------------------------------------------------------ player registry */

// players: plain id->rec object (JSON-friendly). ev is one of:
//   { type:"hello"|"beat", id, rec, now }
//   { type:"bye", id }
//   { type:"sweep", now, ttl }
function registryReduce(players, ev) {
  var next = {}, k;
  for (k in players) if (players.hasOwnProperty(k)) next[k] = players[k];

  if (ev.type === "hello" || ev.type === "beat") {
    var prev = next[ev.id] || {};
    var merged = { id: ev.id };
    for (k in prev) if (prev.hasOwnProperty(k)) merged[k] = prev[k];
    var rec = ev.rec || {};
    for (k in rec) if (rec.hasOwnProperty(k)) merged[k] = rec[k];
    merged.lastBeat = ev.now;
    next[ev.id] = merged;
  } else if (ev.type === "bye") {
    delete next[ev.id];
  } else if (ev.type === "sweep") {
    var ttl = ev.ttl || 6000;
    for (k in next) {
      if (next.hasOwnProperty(k) && ev.now - (next[k].lastBeat || 0) > ttl) delete next[k];
    }
  }
  return next;
}

/* ------------------------------------------------------------ auto compare */

// pull a version number out of a filename: "SHOW_v012.mov" -> 12,
// "cut_003.mov" -> 3. A leading "v" wins; otherwise a trailing number group.
// Convenience hint only — returns null when there's nothing obvious.
function parseVersion(name) {
  if (!name || typeof name !== "string") return null;
  var m = name.match(/(?:^|[^a-z0-9])v(\d{1,4})(?:[^0-9]|$)/i);
  if (m) return parseInt(m[1], 10);
  m = name.match(/(?:^|[ _\-])(\d{2,4})(?:\.[a-z0-9]+)?$/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

// choose which two open players to compare and which is A / B.
//   players: id->rec map (as registryReduce produces).
//   -> { aId, bId, picked:[id,id], note:"version order"|"open order" }
//      or { error:"..." } when fewer than two eligible videos are open.
// Eligible = has a path, real dimensions and a duration (excludes audio-only /
// not-yet-loaded windows). More than two open -> the two most recently opened
// (highest `seq`, set by the global entry on first hello). A/B order: lower
// version number is A when both filenames carry one; otherwise earlier-opened.
function pickAutoCompare(players, opts) {
  var list = [];
  for (var k in players) {
    if (!players.hasOwnProperty(k)) continue;
    var p = players[k];
    if (p && p.path && p.w > 0 && p.h > 0 && p.duration > 0) list.push(p);
  }
  if (list.length < 2) return { error: "need two open videos" };

  function seqOf(p) { return typeof p.seq === "number" ? p.seq : -1; }
  function idNum(p) { var n = parseInt(p.id, 10); return isFinite(n) ? n : 0; }
  list.sort(function (a, b) { return (seqOf(b) - seqOf(a)) || (idNum(a) - idNum(b)); });

  var x = list[0], y = list[1];   // the two most-recently-opened eligible players
  var vx = parseVersion(x.filename), vy = parseVersion(y.filename);
  var a, b, note;
  if (vx != null && vy != null && vx !== vy) {
    a = vx < vy ? x : y; b = a === x ? y : x; note = "version order";
  } else {
    a = seqOf(x) <= seqOf(y) ? x : y; b = a === x ? y : x; note = "open order";
  }
  return { aId: String(a.id), bId: String(b.id), picked: [String(x.id), String(y.id)], note: note };
}

// drop A/B references to players that no longer exist; break the link if either
// slot is empty. Returns a new compare state.
function reconcileCompare(state, players) {
  var s = {};
  for (var k in state) if (state.hasOwnProperty(k)) s[k] = state[k];
  if (s.aId != null && !players[s.aId]) s.aId = null;
  if (s.bId != null && !players[s.bId]) s.bId = null;
  if (s.aId == null || s.bId == null) s.linked = false;
  return s;
}

var API = {
  COMMON_RATES: COMMON_RATES,
  rationalize: rationalize,
  fpsNum: fpsNum,
  timeToFrame: timeToFrame,
  frameToTime: frameToTime,
  computeOffset: computeOffset,
  bumpOffsetFrames: bumpOffsetFrames,
  bumpOffsetSec: bumpOffsetSec,
  targetForB: targetForB,
  detectFpsMismatch: detectFpsMismatch,
  offsetLabel: offsetLabel,
  registryReduce: registryReduce,
  reconcileCompare: reconcileCompare,
  parseVersion: parseVersion,
  pickAutoCompare: pickAutoCompare,
};

if (typeof module !== "undefined" && module.exports) module.exports = API;
