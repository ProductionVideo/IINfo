/*
 * IINfo — global entry (Info.json "globalEntry": "global.js").
 *
 * Loaded once at IINA startup; the only context shared by every player window.
 * Owns the player registry and the A/B compare state, and routes ganged
 * transport. Never touches core/mpv (unavailable here) — every player-side read
 * or seek is a message to that window's main.js.
 *
 * IINA global-entry constraints, all found in live testing (see DECISIONS.md):
 *  - require() does not return module.exports        -> sync maths is inlined.
 *  - postMessage(null|number) misses user-opened windows; only a STRING target
 *    routes (vs PlayerCore.label), and onMessage gives us that label.
 *  - child->parent delivery is synchronous; posting back inside that call stack
 *    trips a force-unwrap in IINA and crashes -> every send is defer()'d.
 *  - a binding is only visible inside an onMessage callback if it is reachable
 *    from init code, and inline callback bodies lose their own targets -> the
 *    ENTIRE controller lives in ONE closure and handlers are registered by name.
 *
 * No state round-trips: A and B positions come from the ~4 Hz beats already in
 * the registry, so Set-as-sync / Re-sync / align never wait on a reply.
 *
 * Accuracy: frame-accurate stepped/paused comparison is the contract. Two mpv
 * instances can't be sample-locked in play, so ganged play is best-effort and
 * anything that stops or seeks debounces into alignBoth() — snap A to its exact
 * frame, snap B to that frame +/- the offset.
 */

const { console } = iina;
const G = iina.global;

console.log("IINfo: global entry loading (v0.4.0)");

/* ------------------------------------------------------------ sync maths
 * Inlined from lib/sync.js (IINA's require() won't return module.exports).
 * lib/sync.js is the npm-test target — KEEP THE TWO IN SYNC. */
var sync = (function () {
  var COMMON_RATES = [
    [24000, 1001], [30000, 1001], [60000, 1001], [48000, 1001], [120000, 1001],
    [24, 1], [25, 1], [30, 1], [48, 1], [50, 1], [60, 1], [100, 1], [120, 1],
  ];
  function rationalize(fps) {
    if (fps == null || !isFinite(fps) || fps <= 0) return null;
    for (var i = 0; i < COMMON_RATES.length; i++) {
      var n = COMMON_RATES[i][0], d = COMMON_RATES[i][1];
      if (Math.abs(fps - n / d) < 0.005) return { num: n, den: d, fps: n / d };
    }
    return { num: Math.round(fps * 1000), den: 1000, fps: fps };
  }
  function fpsNum(r) {
    if (r == null) return null;
    if (typeof r === "number") return isFinite(r) && r > 0 ? r : null;
    if (typeof r.fps === "number" && r.fps > 0) return r.fps;
    if (r.num && r.den) return r.num / r.den;
    return null;
  }
  function timeToFrame(t, r) {
    var f = fpsNum(r);
    if (t == null || !isFinite(t) || !f) return null;
    return Math.max(0, Math.floor(t * f + 1e-6));
  }
  function frameToTime(frame, r) {
    var f = fpsNum(r);
    if (frame == null || !isFinite(frame) || !f) return null;
    return (frame + 0.5) / f;
  }
  function computeOffset(aPos, bPos, rB) {
    var dt = (bPos || 0) - (aPos || 0);
    var f = fpsNum(rB);
    if (!f) return { offsetSec: dt, offsetFrames: null };
    var frames = Math.round(dt * f);
    return { offsetSec: frames / f, offsetFrames: frames };
  }
  function bumpOffsetFrames(offsetFrames, delta, rB) {
    var f = fpsNum(rB);
    var nf = (offsetFrames || 0) + delta;
    return { offsetFrames: nf, offsetSec: f ? nf / f : (offsetFrames || 0) };
  }
  function bumpOffsetSec(offsetSec, deltaSec) {
    return { offsetSec: (offsetSec || 0) + deltaSec, offsetFrames: null };
  }
  function targetForB(tA, offsetSec) {
    return Math.max(0, (tA || 0) + (offsetSec || 0));
  }
  function detectFpsMismatch(fpsA, fpsB) {
    var a = fpsNum(fpsA), b = fpsNum(fpsB);
    if (!a || !b) return false;
    return Math.abs(a - b) > 0.01;
  }
  function reconcileCompare(state, players) {
    var s = {};
    for (var k in state) if (state.hasOwnProperty(k)) s[k] = state[k];
    if (s.aId != null && !players[s.aId]) s.aId = null;
    if (s.bId != null && !players[s.bId]) s.bId = null;
    if (s.aId == null || s.bId == null) s.linked = false;
    return s;
  }
  return {
    rationalize: rationalize, fpsNum: fpsNum, timeToFrame: timeToFrame, frameToTime: frameToTime,
    computeOffset: computeOffset, bumpOffsetFrames: bumpOffsetFrames, bumpOffsetSec: bumpOffsetSec,
    targetForB: targetForB, detectFpsMismatch: detectFpsMismatch, reconcileCompare: reconcileCompare,
  };
})();

// pins live at true top level so the GC can't reclaim the handlers IINA holds
var PINS = [];

(function () {
  "use strict";

  var players = {};   // label -> { id, path, filename, w, h, fps, duration, pos, frame, paused, lastBeat }
  var compare = { aId: null, bId: null, linked: false, offsetFrames: 0, offsetSec: 0, mode: "frame-offset", fpsMismatch: false };
  var bcPending = false;
  var alignTimer = null;
  var BEAT_TTL = 20000;

  function onMsg(name, fn) { PINS.push(fn); G.onMessage(name, fn); }
  function defer(fn) { if (typeof setTimeout === "function") setTimeout(fn, 0); else fn(); }

  function rec(id) { return id == null ? null : (players[id] || null); }
  function fpsOf(id) { var p = rec(id); return p ? (p.fps || null) : null; }
  function ratA() { return sync.rationalize(fpsOf(compare.aId)); }
  function ratB() { return sync.rationalize(fpsOf(compare.bId)); }

  function summary() {
    return Object.keys(players).map(function (id) {
      var p = players[id];
      return {
        id: id, path: p.path || null, filename: p.filename || null,
        w: p.w || null, h: p.h || null, fps: p.fps || null,
        duration: p.duration || null, pos: p.pos != null ? p.pos : null, paused: !!p.paused,
        tech: p.tech || null,
      };
    });
  }

  function recomputeDerived() {
    compare.fpsMismatch = sync.detectFpsMismatch(fpsOf(compare.aId), fpsOf(compare.bId));
    compare.mode = (compare.fpsMismatch || !fpsOf(compare.bId)) ? "elapsed" : "frame-offset";
  }

  function liveDelta() {
    var a = rec(compare.aId), b = rec(compare.bId);
    if (!a || !b || a.pos == null || b.pos == null) return null;
    return b.pos - (a.pos + (compare.offsetSec || 0));
  }

  function toPlayer(id, name, data) {
    if (id == null) return;
    var label = String(id);
    if (label === "" || label === "null" || label === "undefined") return;
    defer(function () {
      try { G.postMessage(label, name, data); }
      catch (e) { console.log("IINfo global: send " + name + " -> " + label + " — " + e); }
    });
  }

  function broadcast() {
    if (bcPending) return;
    bcPending = true;
    defer(function () {
      bcPending = false;
      compare = sync.reconcileCompare(compare, players);
      recomputeDerived();
      var payload = { state: compare, players: summary(), delta: liveDelta() };
      Object.keys(players).forEach(function (id) { toPlayer(id, "iinfo/compare", payload); });
    });
  }

  /* ---- accuracy primitive: put A and B on exact frames, offset apart ----
   * Uses the positions already in the registry (from beats) — no round trip. */
  function alignBoth() {
    if (!compare.aId || !compare.bId) return;
    var a = rec(compare.aId), b = rec(compare.bId);
    if (!a || a.pos == null) { console.log("IINfo global: align — A position unknown"); return; }
    var ra = ratA(), rb = ratB();
    var aFrame = sync.timeToFrame(a.pos, ra);
    if (aFrame == null || !sync.fpsNum(rb)) {
      toAB({ action: "seek-abs", value: a.pos },
           { action: "seek-abs", value: Math.max(0, a.pos + (compare.offsetSec || 0)) });
      console.log("IINfo global: align (elapsed) A " + a.pos.toFixed(3) + "s");
      broadcast();
      return;
    }
    var aT = sync.frameToTime(aFrame, ra);
    var bFrame = Math.max(0, compare.mode === "frame-offset"
      ? aFrame + (compare.offsetFrames || 0)
      : sync.timeToFrame(aT + (compare.offsetSec || 0), rb));
    toAB({ action: "seek-abs", value: aT },
         { action: "seek-abs", value: sync.frameToTime(bFrame, rb) });
    console.log("IINfo global: align A#" + aFrame + " -> B#" + bFrame + " (off " + compare.offsetFrames + "f)");
    broadcast();
  }
  function scheduleAlign() {
    if (typeof setTimeout !== "function") { alignBoth(); return; }
    if (alignTimer) clearTimeout(alignTimer);
    alignTimer = setTimeout(function () { alignTimer = null; alignBoth(); }, 260);
  }

  /* ---- registry ---- */
  function onHello(data, playerID) {
    var id = String(playerID);
    var prev = players[id] || {};
    var pathChanged = !!(prev.path && data && data.path && prev.path !== data.path);
    players[id] = Object.assign({}, prev, data || {}, { id: id, lastBeat: Date.now() });
    toPlayer(id, "iinfo/you-are", { id: id });
    if (pathChanged && (id === compare.aId || id === compare.bId)) {
      compare.offsetFrames = 0; compare.offsetSec = 0;
      console.log("IINfo global: " + id + " changed file — offset reset");
    }
    console.log("IINfo global: hello " + id + " (" + (data && data.filename) + ")");
    broadcast();
  }
  function onBeat(data, playerID) {
    var id = String(playerID);
    var p = players[id];
    if (!p) {
      players[id] = Object.assign({ id: id }, data || {}, { lastBeat: Date.now() });
      toPlayer(id, "iinfo/you-are", { id: id });
      broadcast();
      return;
    }
    if (data) { p.pos = data.pos; p.frame = data.frame; p.paused = data.paused; }
    p.lastBeat = Date.now();
  }
  function onBye(data, playerID) {
    var id = String(playerID);
    if (players[id]) { delete players[id]; console.log("IINfo global: bye " + id); broadcast(); }
  }

  /* ---- compare commands ---- */
  function onCompareCmd(cmd) {
    if (!cmd || !cmd.op) return;
    var f = sync.fpsNum(ratB()) || 25;
    switch (cmd.op) {
      case "assign":
        if (cmd.slot === "A") compare.aId = cmd.id != null ? String(cmd.id) : null;
        else if (cmd.slot === "B") compare.bId = cmd.id != null ? String(cmd.id) : null;
        compare.offsetFrames = 0; compare.offsetSec = 0;
        break;
      case "swap": {
        var t = compare.aId; compare.aId = compare.bId; compare.bId = t;
        compare.offsetFrames = -(compare.offsetFrames || 0);
        compare.offsetSec = -(compare.offsetSec || 0);
        break;
      }
      case "link":    compare.linked = !!(compare.aId && compare.bId); break;
      case "unlink":  compare.linked = false; break;
      case "refresh": break;
      case "offset-frames":
        if (compare.mode === "elapsed") {
          compare.offsetSec = (compare.offsetSec || 0) + (cmd.delta || 0) / f;
        } else {
          compare.offsetFrames = (compare.offsetFrames || 0) + (cmd.delta || 0);
          compare.offsetSec = compare.offsetFrames / f;
        }
        if (compare.linked) scheduleAlign();
        break;
      case "offset-reset":
        compare.offsetFrames = 0; compare.offsetSec = 0;
        if (compare.linked) scheduleAlign();
        break;
      case "set-sync": {
        var a = rec(compare.aId), b = rec(compare.bId);
        if (a && b && a.pos != null && b.pos != null) {
          var o = sync.computeOffset(a.pos, b.pos, ratB());
          compare.offsetFrames = o.offsetFrames != null ? o.offsetFrames : 0;
          compare.offsetSec = o.offsetSec;
          console.log("IINfo global: set-sync = " + compare.offsetFrames + "f / " + compare.offsetSec.toFixed(3) + "s");
          alignBoth();
        } else {
          console.log("IINfo global: set-sync — A/B position not known yet");
        }
        break;
      }
      case "resync":
        alignBoth();
        return;
    }
    broadcast();
  }

  /* ---- ganged transport: explicit verbs only ---- */
  function toAB(aData, bData) {
    toPlayer(compare.aId, "iinfo/gang-exec", aData);
    if (String(compare.bId) !== String(compare.aId)) toPlayer(compare.bId, "iinfo/gang-exec", bData);
  }
  function relay(action, value) {
    toAB({ action: action, value: value }, { action: action, value: value });
  }
  function gangSeekAbs(T) {
    var ra = ratA(), rb = ratB();
    var aFrame = sync.timeToFrame(T, ra);
    if (aFrame == null || !sync.fpsNum(rb)) {
      toAB({ action: "seek-abs", value: T },
           { action: "seek-abs", value: Math.max(0, T + (compare.offsetSec || 0)) });
      return;
    }
    var aT = sync.frameToTime(aFrame, ra);
    var bFrame = Math.max(0, compare.mode === "frame-offset"
      ? aFrame + (compare.offsetFrames || 0)
      : sync.timeToFrame(aT + (compare.offsetSec || 0), rb));
    toAB({ action: "seek-abs", value: aT },
         { action: "seek-abs", value: sync.frameToTime(bFrame, rb) });
  }
  function onGang(cmd) {
    if (!cmd || !cmd.action || !compare.linked || !compare.aId || !compare.bId) return;
    var v = cmd.value;
    switch (cmd.action) {
      case "play":       relay("play"); break;
      // pause is the only move that needs a re-align: the two players drift while
      // playing. Everything else keeps them aligned by construction —
      // frame-step is exact + symmetric; gangSeekAbs snaps both to frames.
      case "pause":      relay("pause"); scheduleAlign(); break;
      case "frame-next": relay("frame-next"); break;
      case "frame-prev": relay("frame-prev"); break;
      case "frame-jump": if (typeof v === "number") relay("frame-jump", v); break;
      case "seek-rel":   if (typeof v === "number") relay("seek-rel", v); break;
      case "nudge":      if (typeof v === "number") relay("nudge", v); break;
      case "seek-start": relay("seek-start"); break;
      case "seek-end":   relay("seek-end"); break;
      case "screenshot": relay("screenshot"); break;
      case "mute":       relay("mute"); break;
      case "speed-mult": if (typeof v === "number") relay("speed-mult", v); break;
      case "seek-abs":   if (typeof v === "number") gangSeekAbs(v); break;
    }
  }

  onMsg("iinfo/hello", onHello);
  onMsg("iinfo/beat", onBeat);
  onMsg("iinfo/bye", onBye);
  onMsg("iinfo/compare-cmd", onCompareCmd);
  onMsg("iinfo/gang", onGang);

  function sweepStale() {
    var now = Date.now(), changed = false;
    Object.keys(players).forEach(function (id) {
      if (now - (players[id].lastBeat || 0) > BEAT_TTL) { delete players[id]; changed = true; }
    });
    if (changed) { console.log("IINfo global: swept stale player(s)"); broadcast(); }
  }
  try {
    if (typeof setInterval === "function") setInterval(sweepStale, 3000);
    else console.log("IINfo global: no setInterval — stale sweep disabled");
  } catch (e) { console.log("IINfo global: timer setup — " + e); }

  console.log("IINfo: global entry ready (" + PINS.length + " handlers)");
})();
