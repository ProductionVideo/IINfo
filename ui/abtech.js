/*
 * IINfo — A/B technical comparison model.
 *
 * Pure data logic: no DOM, no `iina`. Loaded as a plain <script> in the inspector
 * web view (window.ABTech) and require()d by node --test. Given the per-file
 * technical metadata for the A and B windows (main.js gMeta().tech), it produces
 * a labelled, formatted, difference-flagged table.
 *
 * Interesting mismatches could later become QC events (source "compare", type
 * "technical-difference", meta { field, a, b }) — ui/events.js already accepts
 * that shape. Not built yet.
 */
(function (root) {
  "use strict";

  var FIELDS = [
    { key: "container",  label: "Container",       kind: "text" },
    { key: "vcodec",     label: "Video codec",     kind: "text" },
    { key: "res",        label: "Resolution",      kind: "res" },
    { key: "dar",        label: "Aspect (DAR)",    kind: "text" },
    { key: "par",        label: "Pixel aspect",    kind: "par" },
    { key: "fps",        label: "Frame rate",      kind: "fps" },
    { key: "duration",   label: "Duration",        kind: "dur" },
    { key: "frameCount", label: "Frame count",     kind: "int" },
    { key: "pixfmt",     label: "Pixel format",    kind: "text" },
    { key: "vdepth",     label: "Bit depth",       kind: "vdepth" },
    { key: "range",      label: "Colour range",    kind: "text" },
    { key: "matrix",     label: "Colour matrix",   kind: "text" },
    { key: "primaries",  label: "Primaries",       kind: "text" },
    { key: "transfer",   label: "Transfer",        kind: "text" },
    { key: "vbitrate",   label: "Video bitrate",   kind: "bitrate" },
    { key: "acodec",     label: "Audio codec",     kind: "text" },
    { key: "asr",        label: "Sample rate",     kind: "sr" },
    { key: "ach",        label: "Audio channels",  kind: "int" },
    { key: "alayout",    label: "Channel layout",  kind: "text" },
    { key: "adepth",     label: "Audio bit depth", kind: "adepth" },
    { key: "abitrate",   label: "Audio bitrate",   kind: "bitrate" },
  ];

  var BITRATE_TOL = 0.10;   // mpv's bitrate is a rolling estimate
  var FPS_TOL = 0.01;

  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }
  function nil() { return { v: null, d: "—" }; }

  function hms(s) {
    s = Math.max(0, Math.round(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(x).padStart(2, "0");
  }
  function mbps(b) {
    return b >= 1e6 ? (b / 1e6).toFixed(1) + " Mb/s" : (b / 1e3).toFixed(0) + " kb/s";
  }
  function pixDepth(pf) {
    if (!pf) return null;
    var s = String(pf).toLowerCase();
    var m = s.match(/p(\d{1,2})(le|be)?$/);
    if (m) return m[1] + "-bit";
    m = s.match(/(10|12|14|16)/);
    return m ? m[1] + "-bit" : "8-bit";
  }
  function audioDepth(afmt, acodec) {
    var c = String(acodec || "").toLowerCase();
    var cm = c.match(/pcm_([fsu])(\d{1,2})/);
    if (cm) return cm[2] + (cm[1] === "f" ? "-bit float" : "-bit");
    var f = String(afmt || "").toLowerCase();
    if (!f) return null;
    if (f.indexOf("flt") >= 0 || f.indexOf("f32") >= 0) return "32-bit float";
    if (f.indexOf("dbl") >= 0 || f.indexOf("f64") >= 0) return "64-bit float";
    var fm = f.match(/(\d{2})/);
    return fm ? fm[1] + "-bit" : null;
  }

  // -> { v: <comparison key | null>, d: <display string>, approx?: bool }
  function fieldVal(f, t) {
    if (!t) return nil();
    switch (f.kind) {
      case "res":
        return (t.w && t.h) ? { v: t.w + "x" + t.h, d: t.w + " × " + t.h } : nil();
      case "fps": {
        var fp = num(t.fps);
        return fp ? { v: Math.round(fp / FPS_TOL) * FPS_TOL, d: fp.toFixed(3) } : nil();
      }
      case "dur": {
        var d = num(t.duration);
        return d ? { v: Math.round(d), d: hms(d) } : nil();
      }
      case "par": {
        var p = num(t.par);
        return p ? { v: Math.round(p * 1000) / 1000, d: p.toFixed(3) } : nil();
      }
      case "sr": {
        var sr = num(t.asr);
        return sr ? { v: sr, d: (sr / 1000).toFixed(1) + " kHz" } : nil();
      }
      case "int": {
        var x = num(t[f.key]);
        return x != null ? { v: Math.round(x), d: String(Math.round(x)) } : nil();
      }
      case "bitrate": {
        var b = num(t[f.key]);
        return b > 0 ? { v: b, d: mbps(b), approx: true } : nil();
      }
      case "vdepth": {
        var vd = pixDepth(t.pixfmt);
        return vd ? { v: vd, d: vd } : nil();
      }
      case "adepth": {
        var ad = audioDepth(t.afmt, t.acodec);
        return ad ? { v: ad, d: ad } : nil();
      }
      default: {
        var val = t[f.key];
        return (val != null && val !== "")
          ? { v: String(val).toLowerCase(), d: String(val) }
          : nil();
      }
    }
  }

  function differs(a, b) {
    if (a.v == null && b.v == null) return false;
    if (a.v == null || b.v == null) return true;
    if (a.approx && b.approx && typeof a.v === "number" && typeof b.v === "number") {
      var hi = Math.max(a.v, b.v);
      return hi > 0 && Math.abs(a.v - b.v) / hi > BITRATE_TOL;
    }
    return a.v !== b.v;
  }

  function isEmpty(t) {
    if (!t || typeof t !== "object") return true;
    for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k) && t[k] != null && t[k] !== "") return false;
    return true;
  }

  function rows(aTech, bTech) {
    if (isEmpty(aTech) || isEmpty(bTech)) return null;
    return FIELDS.map(function (f) {
      var a = fieldVal(f, aTech), b = fieldVal(f, bTech);
      return {
        key: f.key, label: f.label,
        a: a.d, b: b.d,
        differ: differs(a, b),
        approx: !!(a.approx || b.approx),
      };
    });
  }

  function diffCount(rowList) {
    return (rowList || []).reduce(function (n, r) { return n + (r.differ ? 1 : 0); }, 0);
  }

  var API = { FIELDS: FIELDS, rows: rows, diffCount: diffCount };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.ABTech = API;
})(typeof self !== "undefined" ? self : this);
