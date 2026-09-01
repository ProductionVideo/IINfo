"use strict";
/*
 * IINfo — Deep-QC bridge: turns the @iinfoqc analysis filter's per-frame lavfi
 * metadata into QC events.
 *
 * Pure: no DOM, no `iina`, no timers, no I/O. Loaded two ways:
 *   - inlined verbatim into main.js as `var deepqc = (function () { … })();`
 *     (IINA's require() can't be trusted to return module.exports) — the copy is
 *     drift-guarded by test/deepqc-inline.test.js
 *   - require()d by test/deepqc.test.js
 *
 * analyze(meta, state, opts, posMs) -> { events, state }
 *   meta  — the vf-metadata/iinfoqc dict (flat "lavfi.*" -> string)
 *   state — prior serialisable analyser state (start with initState())
 *   opts  — { freeze, black, outliers, range, brng, tout, vrep, freezeDur, blackDur }
 *   posMs — integer playback position of this sample, in ms
 * Emitted events are PARTIAL — { source, type, tMs, durMs, category, severity,
 * note, meta } — main.js finalises them (id / ts / frame / tc).
 *
 * flush(state) closes any spans still open (call on pause / file end / teardown).
 * liveStats(meta) is a small readout helper for the panel.
 */
var deepqc = (function () {
  "use strict";

  var MERGE_GAP = 1000;   // ms — a clean gap shorter than this keeps one span

  function n(v, dflt) { return typeof v === "number" && isFinite(v) ? v : dflt; }
  function fnum(s) { var x = parseFloat(s); return isFinite(x) ? x : null; }
  function sfnum(m, k) { return fnum(m["lavfi.signalstats." + k]); }

  // signalstats reports luma in the source's native range; infer the ceiling so
  // the black test works for 8 / 10 / 12-bit without a format-conversion cost
  function lumaScale(ymax) {
    if (ymax == null) return 255;
    if (ymax > 1023) return 4095;
    if (ymax > 255) return 1023;
    return 255;
  }

  // span-tracked metrics: value normalised so "dirty" == value > threshold
  var METRICS = {
    brng: {
      source: "signalstats", type: "range-error", category: "Colour", severity: "warning",
      read: function (m) { return sfnum(m, "BRNG"); },
      thr: function (o) { return n(o.brng, 0.05); },
      minDur: function () { return 300; },
      active: function (o) { return (o.range || "limited") === "limited"; },
      note: function (pk) { return "broadcast-range violation (BRNG " + (pk * 100).toFixed(1) + "%)"; },
    },
    tout: {
      source: "signalstats", type: "noise", category: "Video", severity: "warning",
      read: function (m) { return sfnum(m, "TOUT"); },
      thr: function (o) { return n(o.tout, 0.05); },
      minDur: function () { return 300; },
      active: function (o) { return o.outliers !== false; },
      note: function (pk) { return "temporal outliers (TOUT " + pk.toFixed(3) + ")"; },
    },
    vrep: {
      source: "signalstats", type: "line-repeat", category: "Video", severity: "warning",
      read: function (m) { return sfnum(m, "VREP"); },
      thr: function (o) { return n(o.vrep, 0.5); },
      minDur: function () { return 300; },
      active: function (o) { return o.outliers !== false; },
      note: function (pk) { return "vertical line repetition (VREP " + pk.toFixed(3) + ")"; },
    },
    black: {
      source: "video", type: "black-frame", category: "Video", severity: "error",
      read: function (m) {
        var y = sfnum(m, "YMAX");
        return y == null ? null : 1 - y / lumaScale(y);
      },
      thr: function (o) { return 1 - n(o.blackLevel, 24) / 255; },
      minDur: function (o) { return Math.max(150, Math.round(n(o.blackDur, 0.5) * 1000)); },
      active: function (o) { return o.black !== false; },
      note: function (pk, durMs) {
        return "black frames" + (durMs ? " (" + (durMs / 1000).toFixed(1) + "s)" : "");
      },
    },
  };
  var METRIC_KEYS = ["brng", "tout", "vrep", "black"];

  function blankSpan() { return { start: null, last: null, peak: 0 }; }

  function initState() {
    return { seenFreeze: {}, seenBlack: {}, spans: { brng: blankSpan(), tout: blankSpan(), vrep: blankSpan(), black: blankSpan() } };
  }

  function cloneState(s) {
    s = s || {};
    var out = { seenFreeze: {}, seenBlack: {}, spans: {} }, k;
    for (k in (s.seenFreeze || {})) if (Object.prototype.hasOwnProperty.call(s.seenFreeze, k)) out.seenFreeze[k] = s.seenFreeze[k];
    for (k in (s.seenBlack || {})) if (Object.prototype.hasOwnProperty.call(s.seenBlack, k)) out.seenBlack[k] = s.seenBlack[k];
    var src = s.spans || {};
    for (var i = 0; i < METRIC_KEYS.length; i++) {
      var m = METRIC_KEYS[i], sp = src[m] || {};
      out.spans[m] = { start: sp.start != null ? sp.start : null, last: sp.last != null ? sp.last : null, peak: sp.peak || 0 };
    }
    return out;
  }

  // advance one span by a sample -> { sp, span|null } where span = {tMs,durMs,peak}
  function stepSpan(sp, v, thr, minDur, posMs) {
    var out = { start: sp.start, last: sp.last, peak: sp.peak };
    // a backward seek abandons an in-progress span (it was mid-measurement)
    if (out.start != null && posMs < out.start) out = blankSpan();

    var span = null;
    var dirty = v != null && v > thr;
    if (dirty) {
      if (out.start == null) { out.start = posMs; out.last = posMs; out.peak = v; }
      else if (posMs - out.last > MERGE_GAP) {
        if (out.last - out.start >= minDur) span = { tMs: out.start, durMs: out.last - out.start, peak: out.peak };
        out = { start: posMs, last: posMs, peak: v };
      } else {
        out.last = posMs;
        if (v > out.peak) out.peak = v;
      }
    } else if (out.start != null && posMs - out.last > MERGE_GAP) {
      if (out.last - out.start >= minDur) span = { tMs: out.start, durMs: out.last - out.start, peak: out.peak };
      out = blankSpan();
    }
    return { sp: out, span: span };
  }

  function spanEvent(m, e) {
    var d = METRICS[m];
    return {
      source: d.source, type: d.type,
      tMs: Math.max(0, Math.round(e.tMs)),
      durMs: Math.max(0, Math.round(e.durMs)),
      category: d.category, severity: d.severity,
      note: d.note(e.peak, Math.max(0, Math.round(e.durMs))),
      meta: { auto: true, peak: e.peak },
    };
  }

  function analyze(meta, state, opts, posMs) {
    meta = meta || {};
    opts = opts || {};
    posMs = Math.max(0, Math.round(posMs || 0));
    var st = cloneState(state);
    var events = [];

    // ---- freeze (freezedetect emits sparsely; mpv keeps the last dict, so we
    //      re-see the same freeze_start across polls — dedup on its value)
    if (opts.freeze !== false) {
      var fs = fnum(meta["lavfi.freezedetect.freeze_start"]);
      if (fs != null) {
        var fd = fnum(meta["lavfi.freezedetect.freeze_duration"]);
        var fdMs = fd != null ? Math.round(fd * 1000) : 0;
        var fkey = Math.round(fs * 1000);
        if (st.seenFreeze[fkey] == null || fdMs > st.seenFreeze[fkey]) {
          st.seenFreeze[fkey] = fdMs;
          events.push({
            source: "freezedetect", type: "freeze",
            tMs: Math.max(0, Math.round(fs * 1000)), durMs: fdMs,
            category: "Video", severity: "warning",
            note: fdMs ? "frozen frames (" + (fdMs / 1000).toFixed(1) + "s)" : "frozen frames",
            meta: { auto: true },
          });
        }
      }
    }

    // ---- signalstats + luma-black spans
    for (var i = 0; i < METRIC_KEYS.length; i++) {
      var m = METRIC_KEYS[i], d = METRICS[m];
      if (!d.active(opts)) { st.spans[m] = blankSpan(); continue; }
      var r = stepSpan(st.spans[m], d.read(meta), d.thr(opts), d.minDur(opts), posMs);
      st.spans[m] = r.sp;
      if (r.span) events.push(spanEvent(m, r.span));
    }

    return { events: events, state: st };
  }

  // close any spans still open — call on pause / end-of-file / teardown
  function flush(state) {
    var st = cloneState(state);
    var events = [];
    for (var i = 0; i < METRIC_KEYS.length; i++) {
      var m = METRIC_KEYS[i], sp = st.spans[m];
      if (sp && sp.start != null && sp.last != null && sp.last - sp.start >= METRICS[m].minDur({})) {
        events.push(spanEvent(m, { tMs: sp.start, durMs: sp.last - sp.start, peak: sp.peak }));
      }
      st.spans[m] = blankSpan();
    }
    return { events: events, state: st };
  }

  function liveStats(meta) {
    if (!meta) return null;
    function g(k) { return sfnum(meta, k); }
    var ymin = g("YMIN"), ymax = g("YMAX"), yavg = g("YAVG");
    var brng = g("BRNG"), tout = g("TOUT"), vrep = g("VREP");
    if (ymin == null && ymax == null && brng == null && tout == null) return null;
    return { yMin: ymin, yMax: ymax, yAvg: yavg, brng: brng, tout: tout, vrep: vrep };
  }

  return { initState: initState, analyze: analyze, flush: flush, liveStats: liveStats };
})();

if (typeof module !== "undefined" && module.exports) module.exports = deepqc;
