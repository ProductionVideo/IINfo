(function () {
  "use strict";
  var iina = window.iina;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function rgba(color, a) {
    var h = (color || "").trim();
    if (h.charAt(0) === "#") h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (h.length !== 6 || isNaN(n)) return "rgba(86,168,255," + a + ")";
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  // meter fill: theme accent almost all the way up, warn/bad only in the peak zone
  var METER_GRAD = null;
  function meterGradient() {
    if (METER_GRAD) return METER_GRAD;
    var a = cssVar("--accent", "#56a8ff"), w = cssVar("--warn", "#ffc94d"), b = cssVar("--bad", "#ff5f5f");
    METER_GRAD = "linear-gradient(to top,"
      + rgba(a, 0.14) + " 0%,"
      + rgba(a, 0.34) + " 40%,"
      + rgba(a, 0.7) + " 78%,"
      + rgba(a, 0.92) + " 88%,"
      + rgba(w, 0.95) + " 93%,"
      + rgba(b, 1) + " 100%)";
    return METER_GRAD;
  }

  /* ============================================================ formatting */
  function fmt(v, d) { return (v == null || !isFinite(v)) ? "—" : Number(v).toFixed(d == null ? 2 : d); }
  function fmtInt(v) { return (v == null || !isFinite(v)) ? "—" : String(Math.round(v)); }
  function orDash(v) { return (v == null || v === "") ? "—" : String(v); }
  function bytes(n) {
    if (n == null || !isFinite(n)) return "—";
    var u = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 2 : 0) + " " + u[i];
  }
  function bitrate(n) {
    if (n == null || !isFinite(n) || n <= 0) return "—";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + " Mb/s";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + " kb/s";
    return n.toFixed(0) + " b/s";
  }
  function clock(s) {
    if (s == null || !isFinite(s)) return "—";
    var neg = s < 0; s = Math.abs(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (neg ? "-" : "") + (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + sec.toFixed(3).padStart(6, "0");
  }
  function parseDb(v) {
    if (v == null) return -Infinity;
    if (typeof v === "string" && (v.indexOf("inf") >= 0 || v === "nan")) return -Infinity;
    var n = parseFloat(v);
    return isFinite(n) ? n : -Infinity;
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }

  /* ============================================================ ring buffer */
  function Ring(len) { this.len = len; this.buf = []; }
  Ring.prototype.push = function (v) { this.buf.push(v); while (this.buf.length > this.len) this.buf.shift(); };
  Ring.prototype.clear = function () { this.buf.length = 0; };

  var sparks = { avsync: new Ring(220), bitrate: new Ring(220), momentary: new Ring(220) };

  /* ============================================================ waveform buffer */
  var wave = {
    cols: [],          // ring of { mn:[perCh], mx:[perCh], rms:[perCh], clip:bool }
    max: 320,          // ~one column per analysis window; scrolls once full
    chNames: [],
    lastSig: "",       // dedupe: skip pushing a column when astats hasn't advanced
    mono: false,
  };
  function pushWaveColumn(raw) {
    if (!raw) return;
    // discover channels
    var chs = [];
    Object.keys(raw).forEach(function (k) {
      var m = k.match(/^lavfi\.astats\.(\d+)\.Max_level$/);
      if (m) chs.push(parseInt(m[1], 10));
    });
    chs.sort(function (a, b) { return a - b; });
    if (!chs.length) return;

    var sig = chs.map(function (c) {
      return raw["lavfi.astats." + c + ".Max_level"] + "/" + raw["lavfi.astats." + c + ".RMS_level"];
    }).join("|");
    if (sig === wave.lastSig) return;  // paused / no new analysis frame
    wave.lastSig = sig;

    var col = { mn: [], mx: [], rms: [], clip: false };
    chs.forEach(function (c) {
      var mn = num(raw["lavfi.astats." + c + ".Min_level"]);
      var mx = num(raw["lavfi.astats." + c + ".Max_level"]);
      var rdb = parseDb(raw["lavfi.astats." + c + ".RMS_level"]);
      var r = isFinite(rdb) ? Math.pow(10, rdb / 20) : 0;
      if (mn == null) mn = 0; if (mx == null) mx = 0;
      if (Math.max(Math.abs(mn), Math.abs(mx)) >= 0.999) col.clip = true;
      col.mn.push(mn); col.mx.push(mx); col.rms.push(r);
    });
    wave.chNames = chs.map(function (c) { return "ch" + c; });
    wave.cols.push(col);
    while (wave.cols.length > wave.max) wave.cols.shift();
  }
  function clearWave() { wave.cols.length = 0; wave.lastSig = ""; wave.chNames = []; }

  // trace a smooth polyline through pts (quadratic curves via midpoints)
  function smoothTo(ctx, pts) {
    if (!pts.length) return;
    ctx.lineTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length - 1; i++) {
      var mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }

  function drawWave(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var nCh = wave.chNames.length || 1;
    var groups = wave.mono ? 1 : nCh;
    var laneH = 52;
    var cssH = Math.max(laneH, groups * laneH);
    if (canvas.style.height !== cssH + "px") canvas.style.height = cssH + "px";
    var w = canvas.clientWidth, h = cssH;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var css = getComputedStyle(document.documentElement);
    var acc = css.getPropertyValue("--accent").trim() || "#56a8ff";
    var bad = css.getPropertyValue("--bad").trim() || "#ff5f5f";
    var faint = css.getPropertyValue("--faint").trim() || "#737a8a";
    ctx.clearRect(0, 0, w, h);

    var cols = wave.cols;
    var gH = h / groups;
    var colW = w / wave.max;
    var x0 = w - cols.length * colW;
    var AMP = gH * 0.42;

    for (var g = 0; g < groups; g++) {
      var laneTop = g * gH, midY = laneTop + gH / 2;

      // faint centre line + lane divider
      ctx.strokeStyle = rgba(faint, 0.22); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY); ctx.stroke();
      if (g > 0) { ctx.strokeStyle = rgba(faint, 0.28); ctx.beginPath(); ctx.moveTo(0, laneTop); ctx.lineTo(w, laneTop); ctx.stroke(); }

      if (cols.length > 1) {
        var top = [], bot = [], rTop = [], rBot = [];
        for (var i = 0; i < cols.length; i++) {
          var c = cols[i], mn, mx, rms;
          if (wave.mono) {
            mn = Math.min.apply(null, c.mn); mx = Math.max.apply(null, c.mx);
            rms = c.rms.reduce(function (s, v) { return s + v; }, 0) / c.rms.length;
          } else { mn = c.mn[g]; mx = c.mx[g]; rms = c.rms[g]; }
          var x = x0 + i * colW + colW / 2;
          top.push({ x: x, y: midY - mx * AMP });
          bot.push({ x: x, y: midY - mn * AMP });
          rTop.push({ x: x, y: midY - rms * AMP });
          rBot.push({ x: x, y: midY + rms * AMP });
        }

        // min/max envelope — soft blob
        var grad = ctx.createLinearGradient(0, midY - AMP, 0, midY + AMP);
        grad.addColorStop(0, rgba(acc, 0.05));
        grad.addColorStop(0.5, rgba(acc, 0.22));
        grad.addColorStop(1, rgba(acc, 0.05));
        ctx.beginPath();
        ctx.moveTo(top[0].x, top[0].y);
        smoothTo(ctx, top);
        for (var j = bot.length - 1; j >= 0; j--) ctx.lineTo(bot[j].x, bot[j].y);
        ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();

        // RMS body — brighter
        ctx.beginPath();
        ctx.moveTo(rTop[0].x, rTop[0].y);
        smoothTo(ctx, rTop);
        for (var k = rBot.length - 1; k >= 0; k--) ctx.lineTo(rBot[k].x, rBot[k].y);
        ctx.closePath();
        ctx.fillStyle = rgba(acc, 0.5); ctx.fill();

        // envelope outline
        ctx.strokeStyle = rgba(acc, 0.55); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(top[0].x, top[0].y); smoothTo(ctx, top); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bot[0].x, bot[0].y); smoothTo(ctx, bot); ctx.stroke();

        // clip flags — the only place red appears
        ctx.strokeStyle = rgba(bad, 0.92); ctx.lineWidth = 2;
        for (var m = 0; m < cols.length; m++) {
          if (!cols[m].clip) continue;
          var cx = x0 + m * colW + colW / 2;
          ctx.beginPath(); ctx.moveTo(cx, laneTop + 3); ctx.lineTo(cx, laneTop + gH - 3); ctx.stroke();
        }
      }

      // lane label
      ctx.fillStyle = rgba(faint, 0.95);
      ctx.font = '9px ' + (css.getPropertyValue("--mono") || "monospace");
      ctx.fillText(wave.mono ? "L+R+…" : (wave.chNames[g] || "ch"), 5, laneTop + 11);
    }
  }

  /* ============================================================ sparkline */
  function drawSpark(canvas, ring, opts) {
    opts = opts || {};
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var b = ring.buf;
    var vals = b.filter(function (x) { return x != null && isFinite(x); });
    if (vals.length < 2) return;
    var lo = opts.min != null ? opts.min : Math.min.apply(null, vals);
    var hi = opts.max != null ? opts.max : Math.max.apply(null, vals);
    if (opts.min == null) lo -= (hi - lo) * 0.1 || 1;
    if (opts.max == null) hi += (hi - lo) * 0.1 || 1;
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    var pad = 3;
    function X(i) { return pad + (w - 2 * pad) * (i / (ring.len - 1)); }
    function Y(v) { return h - pad - (h - 2 * pad) * ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)); }
    if (opts.zero != null && opts.zero >= lo && opts.zero <= hi) {
      ctx.strokeStyle = "rgba(150,150,160,.35)";
      ctx.beginPath(); ctx.moveTo(0, Y(opts.zero)); ctx.lineTo(w, Y(opts.zero)); ctx.stroke();
    }
    var start = ring.len - b.length;
    ctx.strokeStyle = opts.color || cssVar("--accent", "#56a8ff");
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    var started = false;
    for (var i = 0; i < b.length; i++) {
      if (b[i] == null || !isFinite(b[i])) { started = false; continue; }
      var px = X(start + i), py = Y(b[i]);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  /* ============================================================ meter model */
  var meterModel = {};
  function updateMeterModel(raw) {
    if (!raw) return;
    var now = performance.now();
    Object.keys(raw).forEach(function (k) {
      var m = k.match(/^lavfi\.astats\.(\d+)\.(RMS|Peak)_level$/);
      if (!m) return;
      var ch = parseInt(m[1], 10);
      if (!meterModel[ch]) meterModel[ch] = { rms: -100, peak: -100, hold: -100, holdAt: 0, rmsT: -100, peakT: -100 };
      var db = parseDb(raw[k]);
      if (m[2] === "RMS") meterModel[ch].rmsT = db;
      else {
        meterModel[ch].peakT = db;
        if (db > meterModel[ch].hold) { meterModel[ch].hold = db; meterModel[ch].holdAt = now; }
      }
    });
  }
  function animateMeters(dt, now) {
    Object.keys(meterModel).forEach(function (ch) {
      var m = meterModel[ch];
      m.rms += (m.rmsT - m.rms) * Math.min(1, dt * (m.rmsT > m.rms ? 24 : 10));
      m.peak += (m.peakT - m.peak) * Math.min(1, dt * (m.peakT > m.peak ? 34 : 7));
      if (now - m.holdAt > 1500) m.hold -= 14 * dt;
      if (m.hold < m.peak) m.hold = m.peak;
    });
  }

  /* ============================================================ KV panel factory */
  function KV(title, labels) {
    var p = el("div", "panel");
    var h = el("h2");
    var tt = el("span", null, title);
    var tag = el("span", "tag");
    h.appendChild(tt); h.appendChild(tag);
    p.appendChild(h);
    var body = el("div", "body");
    var dl = el("dl", "kv");
    var cells = {};
    labels.forEach(function (lb) {
      var dt = el("dt", null, lb);
      var dd = el("dd", null, "—");
      dl.appendChild(dt); dl.appendChild(dd);
      cells[lb] = { dt: dt, dd: dd };
    });
    body.appendChild(dl);
    p.appendChild(body);
    return {
      el: p, body: body, tag: tag, cells: cells,
      set: function (lb, val, cls) {
        var c = cells[lb]; if (!c) return;
        var s = (val == null || val === "") ? "—" : String(val);
        if (c.dd.textContent !== s) c.dd.textContent = s;   // don't clobber a selection when unchanged
        var cc = cls || "";
        if (c.dd.className !== cc) c.dd.className = cc;
      },
      row: function (lb, show) { var c = cells[lb]; if (c) { c.dt.hidden = !show; c.dd.hidden = !show; } },
    };
  }

  /* ============================================================ panels */
  var P = {};

  // -- Timecode --------------------------------------------------------------
  P.timecode = (function () {
    var k = KV("Timecode & Frames", ["Timecode (NDF)", "Timecode (DF)", "Position", "Duration", "Remaining", "Progress", "FPS", "FPS source"]);
    return { key: "timecode", title: "Timecode & Frames", def: true, el: k.el,
      update: function (d) {
        var t = d.time;
        k.tag.textContent = t.dropFrame ? "drop-frame" : "non-drop";
        k.set("Timecode (NDF)", t.timecodeNDF, "hl");
        k.set("Timecode (DF)", t.dropFrame ? t.timecode : "—", t.dropFrame ? "hl" : "dim");
        k.set("Position", clock(t.pos));
        k.set("Duration", clock(t.duration));
        k.set("Remaining", clock(t.remaining));
        k.set("Progress", t.percent != null ? fmt(t.percent, 1) + " %" : "—");
        k.set("FPS", t.fps != null ? fmt(t.fps, 6) : "—", "hl");
        k.set("FPS source", orDash(t.fpsSource), t.fpsSource === "container" ? "" : "warn");
      } };
  })();

  // -- Frame metadata ------------------------------------------------------
  P.frame = (function () {
    var k = KV("Frame Metadata", ["Picture type", "Keyframe", "Scan", "Field order", "Repeat flag", "GOP timecode", "Stream SMPTE TC"]);
    return { key: "frame", title: "Frame Metadata", def: false, el: k.el,
      update: function (d) {
        var fi = d.frameInfo;
        var pt = fi.pictureType ? String(fi.pictureType).toUpperCase() : null;
        k.tag.textContent = pt || "";
        k.tag.className = "tag badge" + (pt ? " " + pt[0] : "");
        k.set("Picture type", pt || "—", pt === "I" ? "good" : (pt === "B" ? "warn" : (pt ? "hl" : "")));
        k.set("Keyframe", fi.keyFrame == null ? "—" : (fi.keyFrame ? "yes" : "no"));
        k.set("Scan", fi.interlaced == null ? "—" : (fi.interlaced ? "interlaced" : "progressive"), fi.interlaced ? "warn" : (fi.interlaced === false ? "good" : ""));
        k.set("Field order", fi.interlaced ? (fi.tff ? "top field first" : "bottom field first") : "—");
        k.row("Field order", !!fi.interlaced);
        k.set("Repeat flag", fi.repeat == null ? "—" : String(fi.repeat), fi.repeat ? "warn" : "");
        k.set("GOP timecode", orDash(fi.gopTimecode));
        k.row("GOP timecode", !!fi.gopTimecode);
        k.set("Stream SMPTE TC", orDash(fi.smpteTimecode || fi.estimatedSmpte), "hl");
        k.row("Stream SMPTE TC", !!(fi.smpteTimecode || fi.estimatedSmpte));
      } };
  })();

  // -- Video signal ------------------------------------------------------
  P.signal = (function () {
    var k = KV("Video Signal / Color", ["Coded size", "Display size", "Aspect (DAR)", "Pixel aspect", "Pixel format",
      "Chroma", "Bit depth", "Chroma siting", "Color range", "Color matrix", "Primaries", "Transfer", "Signal peak", "Rotation", "3D / alpha"]);
    return { key: "signal", title: "Video Signal / Color", def: true, el: k.el,
      update: function (d) {
        var v = d.video;
        var chroma = v.pixelformat ? (/444/.test(v.pixelformat) ? "4:4:4" : /422/.test(v.pixelformat) ? "4:2:2" :
          /420/.test(v.pixelformat) ? "4:2:0" : /gray/.test(v.pixelformat) ? "monochrome" : "?") : "—";
        var bd = "—";
        if (v.pixelformat) {
          var mm = v.pixelformat.match(/p(\d+)(le|be)?$/) || v.pixelformat.match(/(10|12|14|16)/);
          bd = mm ? mm[1] + "-bit" : "8-bit";
        }
        var hdr = v.gamma && /pq|hlg|st2084|smpte2084|arib/i.test(v.gamma);
        k.tag.textContent = (v.w && v.h) ? v.w + "×" + v.h : "";
        k.tag.className = "tag";
        k.set("Coded size", (v.w && v.h) ? v.w + " × " + v.h : "—", "hl");
        k.set("Display size", (v.dw && v.dh) ? v.dw + " × " + v.dh : "—");
        k.set("Aspect (DAR)", orDash(v.aspectName || (v.aspect != null ? fmt(v.aspect, 3) : null)));
        k.set("Pixel aspect", v.par != null ? fmt(v.par, 4) : "—", (v.par != null && Math.abs(v.par - 1) > 0.001) ? "warn" : "");
        k.set("Pixel format", orDash(v.pixelformat));
        k.set("Chroma", chroma);
        k.set("Bit depth", bd, (bd !== "8-bit" && bd !== "—") ? "hl" : "");
        k.set("Chroma siting", orDash(v.chromaLocation));
        k.set("Color range", orDash(v.colorlevels), v.colorlevels === "full" ? "warn" : "");
        k.set("Color matrix", orDash(v.colormatrix));
        k.set("Primaries", orDash(v.primaries));
        k.set("Transfer", orDash(v.gamma), hdr ? "hl" : "");
        k.set("Signal peak", v.sigPeak != null ? fmt(v.sigPeak, 3) : "—", hdr ? "hl" : "");
        k.row("Signal peak", !!hdr);
        k.set("Rotation", v.rotate != null ? v.rotate + "°" : "0°", v.rotate ? "warn" : "");
        var td = [];
        if (v.stereoIn && v.stereoIn !== "mono") td.push("3D " + v.stereoIn);
        if (v.alpha && v.alpha !== "no") td.push("alpha " + v.alpha);
        k.set("3D / alpha", td.length ? td.join(" · ") : "—", td.length ? "warn" : "dim");
        k.row("3D / alpha", td.length > 0);
      } };
  })();

  // -- Codec & bitrate ------------------------------------------------------
  P.codec = (function () {
    var k = KV("Codec & Bitrate", ["Container", "File size", "Video codec", "Video decoder", "Hardware decode", "Video bitrate", "Audio codec", "Audio bitrate"]);
    var cap = el("div", "cap", "video bitrate (Mb/s)");
    var cv = el("canvas", "spark"); cv.id = "sp-bitrate";
    k.body.appendChild(cap); k.body.appendChild(cv);
    return { key: "codec", title: "Codec & Bitrate", def: false, el: k.el, canvas: cv,
      update: function (d) {
        var v = d.video, a = d.audio, f = d.file;
        k.set("Container", orDash(f.format));
        k.set("File size", bytes(f.size));
        k.set("Video codec", orDash(v.codec));
        k.set("Video decoder", orDash(v.decoder));
        k.set("Hardware decode", orDash(v.hwdec), (v.hwdec && v.hwdec !== "no") ? "good" : "dim");
        k.set("Video bitrate", bitrate(v.bitrate), "hl");
        k.set("Audio codec", orDash(a.codec));
        k.set("Audio bitrate", bitrate(a.bitrate));
      },
      tick: function () { drawSpark(cv, sparks.bitrate, { min: 0 }); } };
  })();

  // -- Sync & dropped frames ------------------------------------------------------
  P.sync = (function () {
    var k = KV("A/V Sync & Dropped Frames", ["A/V sync", "Dropped (decoder)", "Dropped (output)", "Mistimed frames", "Delayed frames", "Display refresh", "Est. filtered fps", "Demux cache"]);
    var cap = el("div", "cap", "A/V sync history — centre line = locked");
    var cv = el("canvas", "spark"); cv.id = "sp-avsync";
    k.body.appendChild(cap); k.body.appendChild(cv);
    return { key: "sync", title: "A/V Sync & Dropped Frames", def: false, el: k.el, canvas: cv,
      update: function (d) {
        var pf = d.perf;
        var av = pf.avsync, aa = av != null ? Math.abs(av) : null;
        k.tag.textContent = aa == null ? "" : ((av > 0 ? "+" : "") + fmt(av * 1000, 0) + " ms");
        k.set("A/V sync", av != null ? (av > 0 ? "+" : "") + fmt(av * 1000, 1) + " ms" : "—",
          aa == null ? "" : (aa > 0.1 ? "bad" : aa > 0.04 ? "warn" : "good"));
        k.set("Dropped (decoder)", fmtInt(pf.decDrop), pf.decDrop ? "bad" : "");
        k.set("Dropped (output)", fmtInt(pf.voDrop), pf.voDrop ? "bad" : "");
        k.set("Mistimed frames", fmtInt(pf.mistimed), pf.mistimed ? "warn" : "");
        k.set("Delayed frames", fmtInt(pf.delayed), pf.delayed ? "warn" : "");
        k.set("Display refresh", pf.displayFps != null ? fmt(pf.displayFps, 3) + " Hz" : "—");
        k.set("Est. filtered fps", pf.estVfFps != null ? fmt(pf.estVfFps, 3) : "—");
        k.set("Demux cache", pf.cacheDuration != null ? fmt(pf.cacheDuration, 1) + " s" : "—", pf.cacheUnderrun ? "bad" : "");
      },
      tick: function () { drawSpark(cv, sparks.avsync, { zero: 0, min: -0.15, max: 0.15 }); } };
  })();

  // -- Waveform ------------------------------------------------------
  P.waveform = (function () {
    var p = el("div", "panel");
    var h = el("h2");
    h.appendChild(el("span", null, "Audio Waveform"));
    var tag = el("span", "tag");
    h.appendChild(tag);
    p.appendChild(h);
    var body = el("div", "body");
    var cv = el("canvas", "wave"); cv.id = "wave";
    body.appendChild(cv);
    var note = el("div", "hint", "translucent = min/max envelope · solid = RMS");
    body.appendChild(note);
    p.appendChild(body);
    return { key: "waveform", title: "Audio Waveform", def: true, el: p, canvas: cv, note: note,
      update: function (d) {
        var m = d.meter || {};
        tag.textContent = wave.mono ? "summed" : "per channel";
        if (m.error) { note.textContent = "analysis filter error — " + m.error; note.className = "hint bad"; return; }
        if (!m.wanted) note.textContent = "enable to insert the analysis filter";
        else if (!m.fresh || !wave.cols.length) note.textContent = "waiting for audio — play the file";
        else note.textContent = "outline / soft fill = min–max · solid body = RMS · red = clip";
        note.className = "hint";
      },
      tick: function () { drawWave(cv); } };
  })();

  // -- Audio levels ------------------------------------------------------
  P.levels = (function () {
    var p = el("div", "panel");
    var h = el("h2"); h.appendChild(el("span", null, "Audio Levels")); var tag = el("span", "tag"); h.appendChild(tag);
    p.appendChild(h);
    var body = el("div", "body");
    var wrap = el("div", "meter-wrap");
    var scale = el("div", "scale");
    ["0", "-6", "-12", "-20", "-40", "-60"].forEach(function (s) { scale.appendChild(el("div", null, s)); });
    var meters = el("div", "meters");
    wrap.appendChild(scale); wrap.appendChild(meters);
    body.appendChild(wrap);
    var note = el("div", "hint", "");
    body.appendChild(note);
    p.appendChild(body);
    var built = 0;
    var MIN = -60, MAX = 0;
    function pct(db) { return Math.max(0, Math.min(1, (db - MIN) / (MAX - MIN))) * 100; }
    return { key: "levels", title: "Audio Levels", def: true, el: p, tag: tag, note: note,
      update: function (d) {
        var m = d.meter || {};
        tag.textContent = m.fresh ? "dBFS" : (m.wanted ? "starting…" : "off");
        var chs = Object.keys(meterModel).map(Number).sort(function (a, b) { return a - b; });
        if (chs.length !== built) {
          meters.innerHTML = ""; built = chs.length;
          chs.forEach(function (ch) {
            var col = el("div", "meter-col"); col.dataset.ch = ch;
            var track = el("div", "meter-track");
            track.appendChild(el("div", "meter-fill"));
            track.appendChild(el("div", "meter-peak"));
            track.appendChild(el("div", "meter-hold"));
            col.appendChild(track);
            col.appendChild(el("div", "meter-val", "-∞"));
            col.appendChild(el("div", "meter-label", "ch" + ch));
            meters.appendChild(col);
          });
        }
        if (d.meter && d.meter.error) { note.textContent = "analysis filter error — " + d.meter.error; note.className = "hint bad"; }
        else if (!chs.length) { note.textContent = m.wanted ? "waiting for audio — play the file" : "enable to insert the analysis filter"; note.className = "hint"; }
        else {
          var clip = chs.some(function (c) { return meterModel[c].peak > -0.1; });
          note.textContent = clip ? "⚠ peak ≥ 0 dBFS — clipping" : "bar = RMS · white tick = peak · red tick = peak-hold";
          note.className = clip ? "hint bad" : "hint";
        }
      },
      tick: function () {
        var grad = meterGradient();
        meters.querySelectorAll(".meter-col").forEach(function (col) {
          var m = meterModel[+col.dataset.ch]; if (!m) return;
          var track = col.querySelector(".meter-track");
          var fill = col.querySelector(".meter-fill");
          fill.style.height = pct(m.rms) + "%";
          // anchor the theme-tinted gradient to the full track so its stops map to dBFS
          if (fill._grad !== grad) { fill.style.backgroundImage = grad; fill._grad = grad; }
          fill.style.backgroundSize = "100% " + (track.clientHeight || 150) + "px";
          col.querySelector(".meter-peak").style.bottom = pct(m.peak) + "%";
          col.querySelector(".meter-hold").style.bottom = pct(m.hold) + "%";
          var v = col.querySelector(".meter-val");
          v.textContent = m.peak <= MIN ? "-∞" : m.peak.toFixed(1);
          v.className = "meter-val" + (m.peak > -0.1 ? " clip" : "");
        });
      } };
  })();

  // -- EBU R128 ------------------------------------------------------
  P.loudness = (function () {
    var k = KV("EBU R128 Loudness", ["Momentary (M)", "Short-term (S)", "Integrated (I)", "Loudness range", "True peak", "Target"]);
    var cap = el("div", "cap", "momentary loudness (LUFS)");
    var cv = el("canvas", "spark"); cv.id = "sp-mom";
    k.body.appendChild(cap); k.body.appendChild(cv);
    return { key: "loudness", title: "EBU R128 Loudness", def: false, el: k.el, canvas: cv,
      update: function (d) {
        var r = d.meter.raw || {};
        var M = num(r["lavfi.r128.M"]), S = num(r["lavfi.r128.S"]), I = num(r["lavfi.r128.I"]), LRA = num(r["lavfi.r128.LRA"]);
        var tp = -Infinity;
        Object.keys(r).forEach(function (key) {
          if (/^lavfi\.r128\.true_peaks?(_ch\d+)?$/.test(key)) { var n = parseFloat(r[key]); if (isFinite(n)) tp = Math.max(tp, n); }
        });
        k.tag.textContent = I != null ? fmt(I, 1) + " LUFS" : "";
        k.set("Momentary (M)", M != null ? fmt(M, 1) + " LUFS" : "—");
        k.set("Short-term (S)", S != null ? fmt(S, 1) + " LUFS" : "—");
        k.set("Integrated (I)", I != null ? fmt(I, 1) + " LUFS" : "—", "hl");
        k.set("Loudness range", LRA != null ? fmt(LRA, 1) + " LU" : "—");
        k.set("True peak", isFinite(tp) ? fmt(tp, 1) + " dBTP" : "—", (isFinite(tp) && tp > -1) ? "bad" : "");
        k.set("Target", "-23 LUFS EBU · -24 ATSC", "dim");
      },
      tick: function () { drawSpark(cv, sparks.momentary, { zero: -23, color: cssVar("--warn", "#ffc94d") }); } };
  })();

  // -- Audio format ------------------------------------------------------
  P.audiofmt = (function () {
    var k = KV("Audio Format", ["Sample rate", "Channels", "Layout", "Sample format", "Codec", "Track title", "Track language"]);
    return { key: "audiofmt", title: "Audio Format", def: false, el: k.el,
      update: function (d) {
        var a = d.audio;
        k.set("Sample rate", a.sampleRate != null ? (a.sampleRate / 1000).toFixed(1) + " kHz" : "—");
        k.set("Channels", a.channelCount != null ? String(a.channelCount) : "—");
        k.set("Layout", orDash(a.hrChannels || a.channels));
        k.set("Sample format", orDash(a.format));
        k.set("Codec", orDash(a.codec));
        k.set("Track title", orDash(a.trackTitle));
        k.set("Track language", orDash(a.trackLang));
      } };
  })();

  // -- A/B Compare ------------------------------------------------------
  function cmpOffsetLabel(s) {
    if (!s) return "";
    if ((s.mode || "frame-offset") === "frame-offset" && s.offsetFrames != null) {
      if (!s.offsetFrames) return "B ±0f";
      return "B " + (s.offsetFrames > 0 ? "+" : "−") + Math.abs(s.offsetFrames) + "f";
    }
    var v = s.offsetSec || 0, sign = v < 0 ? "−" : "+";
    return "B " + sign + Math.abs(v).toFixed(2) + "s";
  }
  P.compare = (function () {
    var p = el("div", "panel");
    var h = el("h2");
    h.appendChild(el("span", null, "A/B Compare"));
    var badges = el("span", "tag cmp-badges");
    h.appendChild(badges);
    p.appendChild(h);
    var body = el("div", "body");

    var unavail = el("div", "hint",
      "Compare needs the IINfo global entry — quit and reopen IINA after updating the plugin.");
    body.appendChild(unavail);

    var wrap = el("div", "cmp");

    function cmd(o) { try { iina.postMessage("iinfo-compare-cmd", o); } catch (e) {} }
    function myId() { return state.compare && state.compare.myId; }

    function slotRow(slot) {
      var row = el("div", "cmp-slot");
      row.appendChild(el("span", "cmp-tag", slot));
      var sel = el("select", "cmp-sel");
      sel.addEventListener("change", function () { cmd({ op: "assign", slot: slot, id: sel.value || null }); });
      row.appendChild(sel);
      var use = el("button", "btn xs", "this window");
      use.addEventListener("click", function () { if (myId()) cmd({ op: "assign", slot: slot, id: myId() }); });
      row.appendChild(use);
      return { row: row, sel: sel, use: use };
    }
    var A = slotRow("A"), B = slotRow("B");
    wrap.appendChild(A.row); wrap.appendChild(B.row);

    var r1 = el("div", "cmp-row");
    [["Swap", "swap"], ["Unlink", "unlink"], ["Refresh", "refresh"]].forEach(function (o) {
      var b = el("button", "btn xs", o[0]);
      b.addEventListener("click", function () { cmd({ op: o[1] }); });
      r1.appendChild(b);
    });
    wrap.appendChild(r1);

    var offRow = el("div", "cmp-row");
    var offVal = el("span", "cmp-off mono", "B ±0f");
    offRow.appendChild(offVal);
    [["−5f", -5], ["−1f", -1], ["+1f", 1], ["+5f", 5]].forEach(function (o) {
      var b = el("button", "btn xs mono", o[0]);
      b.addEventListener("click", function () { cmd({ op: "offset-frames", delta: o[1] }); });
      offRow.appendChild(b);
    });
    wrap.appendChild(offRow);

    var syncRow = el("div", "cmp-row");
    var bSync = el("button", "btn xs", "Set current as sync");
    bSync.title = "Take B's current distance from A as the zero offset";
    bSync.addEventListener("click", function () { cmd({ op: "set-sync" }); });
    var bReset = el("button", "btn xs", "Reset");
    bReset.title = "Zero the offset — B lines back up with A";
    bReset.addEventListener("click", function () { cmd({ op: "offset-reset" }); });
    syncRow.appendChild(bSync);
    syncRow.appendChild(bReset);
    wrap.appendChild(syncRow);

    var linkRow = el("div", "cmp-row");
    var linkLab = el("label", "cmp-link");
    var linkCb = el("input"); linkCb.type = "checkbox";
    linkCb.addEventListener("change", function () { cmd({ op: linkCb.checked ? "link" : "unlink" }); });
    linkLab.appendChild(linkCb);
    linkLab.appendChild(el("span", null, "Link transport"));
    linkRow.appendChild(linkLab);
    var deltaVal = el("span", "cmp-delta mono", "");
    linkRow.appendChild(deltaVal);
    wrap.appendChild(linkRow);

    body.appendChild(wrap);
    p.appendChild(body);

    function optLabel(pl) {
      var name = pl.filename || (pl.path ? String(pl.path).split("/").pop() : ("player " + pl.id));
      var bits = [];
      if (pl.w && pl.h) bits.push(pl.w + "×" + pl.h);
      if (pl.fps) bits.push(Number(pl.fps).toFixed(3));
      return name + (bits.length ? "  ·  " + bits.join(" · ") : "");
    }
    function fillSel(sel, players, current) {
      var sig = players.map(function (x) { return x.id + ":" + optLabel(x); }).join("|") + "=" + (current || "");
      if (sel._sig === sig) return;
      sel._sig = sig;
      sel.textContent = "";
      var none = el("option", null, "— none —"); none.value = ""; sel.appendChild(none);
      players.forEach(function (pl) {
        var o = el("option", null, optLabel(pl));
        o.value = pl.id;
        if (String(pl.id) === String(current)) o.selected = true;
        sel.appendChild(o);
      });
      if (current == null || current === "") none.selected = true;
    }

    return {
      key: "compare", title: "A/B Compare", def: false, el: p,
      update: function (d) {
        var c = d.compare;
        if (!c || !c.state) { unavail.hidden = false; wrap.hidden = true; badges.textContent = ""; return; }
        unavail.hidden = true; wrap.hidden = false;
        var s = c.state, players = c.players || [];

        fillSel(A.sel, players, s.aId);
        fillSel(B.sel, players, s.bId);
        A.use.hidden = !c.myId || String(c.myId) === String(s.aId);
        B.use.hidden = !c.myId || String(c.myId) === String(s.bId);

        offVal.textContent = cmpOffsetLabel(s);
        if (linkCb.checked !== !!s.linked) linkCb.checked = !!s.linked;

        var paired = !!(s.aId && s.bId);

        // B's live distance from the sync point (A + offset)
        var fpsB = null;
        players.forEach(function (pl) { if (String(pl.id) === String(s.bId)) fpsB = pl.fps; });
        var dl = c.delta;
        var offGrid = paired && dl != null && Math.abs(dl) > (fpsB ? 1.5 / fpsB : 0.05);
        if (dl == null || !paired) { deltaVal.textContent = ""; deltaVal.className = "cmp-delta mono"; }
        else if (Math.abs(dl) < (fpsB ? 0.5 / fpsB : 0.02)) {
          deltaVal.textContent = "B in sync"; deltaVal.className = "cmp-delta mono good";
        } else {
          var fr = fpsB ? Math.round(dl * fpsB) : null;
          deltaVal.textContent = "B " + (dl >= 0 ? "+" : "−")
            + (fr != null ? Math.abs(fr) + "f off" : Math.abs(dl).toFixed(2) + "s off");
          deltaVal.className = "cmp-delta mono" + (offGrid ? " bad" : "");
        }

        var bd = [];
        if (s.linked) bd.push(["LINKED", "good"]);
        else if (paired) bd.push(["READY", ""]);
        if (paired) bd.push([cmpOffsetLabel(s), ""]);
        if (s.fpsMismatch) bd.push(["FPS MISMATCH", "warn"]);
        if (offGrid) bd.push(["OUT OF SYNC", "bad"]);
        var sig = bd.map(function (x) { return x.join(""); }).join("|");
        if (badges._sig !== sig) {
          badges._sig = sig; badges.textContent = "";
          bd.forEach(function (x) { badges.appendChild(el("span", "chip" + (x[1] ? " " + x[1] : ""), x[0])); });
        }
      },
    };
  })();

  var ORDER = ["compare", "timecode", "frame", "signal", "codec", "sync", "waveform", "levels", "loudness", "audiofmt"];

  /* ---- display settings (persisted with the panel config) ---- */
  var THEMES = [
    ["black", "Black (OLED)"], ["dark", "Dark"], ["graphite", "Graphite"],
    ["midnight", "Midnight Blue"], ["phosphor", "Green Phosphor"], ["amber", "Amber CRT"],
    ["highcontrast", "High contrast"], ["light", "Light"], ["auto", "Auto (follow macOS)"],
  ];
  var DEFAULT_MONO = '"Courier New", Courier, ui-monospace, monospace';
  var FONTS = [
    ['"Courier New", Courier, ui-monospace, monospace', "Courier"],
    ['ui-monospace, Menlo, Monaco, monospace', "System mono"],
    ['ui-monospace, "SF Mono", Menlo, monospace', "SF Mono"],
    ["Menlo, monospace", "Menlo"],
    ["Monaco, monospace", "Monaco"],
    ['"PT Mono", monospace', "PT Mono"],
    ['"Andale Mono", monospace', "Andale Mono"],
    ['Courier, monospace', "Courier (plain)"],
    ['"JetBrains Mono", ui-monospace, monospace', "JetBrains Mono †"],
    ['"IBM Plex Mono", ui-monospace, monospace', "IBM Plex Mono †"],
    ['"Fira Code", ui-monospace, monospace', "Fira Code †"],
    ['"Cascadia Code", "Cascadia Mono", ui-monospace, monospace', "Cascadia Code †"],
    ['"Roboto Mono", ui-monospace, monospace', "Roboto Mono †"],
    ['Hack, ui-monospace, monospace', "Hack †"],
    ['"Source Code Pro", ui-monospace, monospace', "Source Code Pro †"],
  ];
  var SIZES = [["1", "Small"], ["1.15", "Normal"], ["1.3", "Large"], ["1.5", "XL"], ["1.75", "XXL"], ["2.1", "Huge"]];

  var state = {
    panels: {}, data: null, gen: null, win: null, compare: null,
    settings: { theme: "black", monoFont: DEFAULT_MONO, textSize: "1.15" },
  };
  ORDER.forEach(function (kk) { state.panels[kk] = P[kk].def; });

  var mqLight = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

  function applySettings() {
    var s = state.settings;
    var theme = s.theme === "auto"
      ? (mqLight && mqLight.matches ? "light" : "dark")
      : s.theme;
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty("--mono", s.monoFont || DEFAULT_MONO);
    var z = parseFloat(s.textSize) || 1;
    document.documentElement.style.zoom = z;
    METER_GRAD = null;   // recompute the theme-tinted meter gradient on next tick
  }
  if (mqLight) {
    var onScheme = function () { if (state.settings.theme === "auto") applySettings(); };
    if (mqLight.addEventListener) mqLight.addEventListener("change", onScheme);
    else if (mqLight.addListener) mqLight.addListener(onScheme);
  }

  /* ============================================================ mount */
  var mainEl = $("main");
  ORDER.forEach(function (kk) { mainEl.appendChild(P[kk].el); });

  function applyVisibility() {
    ORDER.forEach(function (kk) { P[kk].el.hidden = !state.panels[kk]; });
  }

  function selectRow(labelText, pairs, current, onChange) {
    var row = el("label", "set-row");
    row.appendChild(el("span", "set-label", labelText));
    var sel = el("select");
    pairs.forEach(function (p) {
      var o = el("option", null, p[1]); o.value = p[0];
      if (p[0] === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () { onChange(sel.value); });
    row.appendChild(sel);
    return row;
  }

  function buildDrawer() {
    var dr = $("drawer");
    dr.innerHTML = "";

    var pgroup = el("div", "drawer-group");
    pgroup.appendChild(el("div", "drawer-head", "Panels"));
    var pwrap = el("div", "drawer-panels");
    ORDER.forEach(function (kk) {
      var lab = el("label");
      var cb = el("input"); cb.type = "checkbox"; cb.checked = !!state.panels[kk];
      cb.addEventListener("change", function () {
        state.panels[kk] = cb.checked;
        applyVisibility(); pushConfig();
        if (state.data) applyData();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(P[kk].title));
      pwrap.appendChild(lab);
    });
    pgroup.appendChild(pwrap);
    dr.appendChild(pgroup);

    var dgroup = el("div", "drawer-group");
    dgroup.appendChild(el("div", "drawer-head", "Display"));
    dgroup.appendChild(selectRow("Theme", THEMES, state.settings.theme, function (v) {
      state.settings.theme = v; applySettings(); pushConfig();
    }));
    dgroup.appendChild(selectRow("Readout font", FONTS, state.settings.monoFont, function (v) {
      state.settings.monoFont = v; applySettings(); pushConfig();
    }));
    dgroup.appendChild(selectRow("Text size", SIZES, state.settings.textSize, function (v) {
      state.settings.textSize = v; applySettings(); pushConfig();
    }));
    var waveRow = el("label", "set-row");
    var wcb = el("input"); wcb.type = "checkbox"; wcb.checked = !!wave.mono;
    wcb.addEventListener("change", function () { wave.mono = wcb.checked; pushConfig(); });
    waveRow.appendChild(wcb);
    waveRow.appendChild(el("span", "set-label", "Sum waveform channels"));
    dgroup.appendChild(waveRow);
    dgroup.appendChild(el("div", "drawer-note", "† falls back to a system monospace unless the font is installed"));
    dr.appendChild(dgroup);
  }

  function pushConfig() {
    if (!awake) return;   // stay silent while IINA is backgrounded
    iina.postMessage("iinfo-config", {
      panels: state.panels,
      wave: { mono: wave.mono },
      settings: state.settings,
      win: state.win,
    });
  }
  function applyConfig(cfg) {
    if (cfg && cfg.panels) ORDER.forEach(function (kk) { if (kk in cfg.panels) state.panels[kk] = !!cfg.panels[kk]; });
    if (cfg && cfg.wave && typeof cfg.wave.mono === "boolean") wave.mono = cfg.wave.mono;
    if (cfg && cfg.settings) {
      if (cfg.settings.theme) state.settings.theme = cfg.settings.theme;
      if (typeof cfg.settings.monoFont === "string") state.settings.monoFont = cfg.settings.monoFont;
      if (cfg.settings.textSize) state.settings.textSize = String(cfg.settings.textSize);
    }
    if (cfg && cfg.win) state.win = cfg.win;
    applySettings();
    buildDrawer(); applyVisibility();
    if (state.data) applyData();
  }

  // true while our timers run at full speed (i.e. IINA is foregrounded). When
  // macOS backgrounds IINA, WebKit throttles setTimeout and this flips false —
  // the poll loop and geometry reporter then stay silent to avoid the crash in
  // IINA's message hub when it delivers to a collected callback.
  var awake = true, lastTick = performance.now();

  /* ---- report the window's size + position so the plugin can restore it ---- */
  var geomTimer = null;
  function currentGeom() {
    return {
      x: window.screenX, y: window.screenY,
      w: window.outerWidth || window.innerWidth,
      h: window.outerHeight || (window.innerHeight + 28),
    };
  }
  function geomChanged(a, b) {
    return !a || Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2 ||
           Math.abs(a.w - b.w) > 2 || Math.abs(a.h - b.h) > 2;
  }
  function maybeReportGeom(immediate) {
    var g = currentGeom();
    if (!(g.w > 100 && g.h > 100)) return;      // headless / not realised yet
    if (!geomChanged(state.win, g)) return;
    state.win = g;
    if (immediate) { clearTimeout(geomTimer); pushConfig(); return; }
    clearTimeout(geomTimer);
    geomTimer = setTimeout(pushConfig, 700);    // debounce drag/resize
  }
  window.addEventListener("resize", function () { maybeReportGeom(false); });
  // catch window moves (there's no move event); skipped while IINA is backgrounded
  setInterval(function () { if (awake) maybeReportGeom(false); }, 2000);
  window.addEventListener("pagehide", function () { maybeReportGeom(true); });

  /* ---- essentials: stable structure, diff-updated so a selection survives ---- */
  var tcVal = $("ess-tc-val"), tcParts = null, curTC = "";
  function renderTC(tc) {
    if (tc === curTC) return;          // unchanged (e.g. paused) — leave the DOM & any selection alone
    curTC = tc;
    var bits = tc.split(/([:;])/);     // ["HH",":","MM",":","SS",";","FF"]
    if (!tcParts || tcParts.length !== bits.length) {
      tcVal.textContent = "";
      tcParts = bits.map(function (b) {
        var isSep = b === ":" || b === ";";
        var sp = el("span", isSep ? "sep" : null, b);
        tcVal.appendChild(sp);
        return sp;
      });
    } else {
      bits.forEach(function (b, i) { if (tcParts[i].textContent !== b) tcParts[i].textContent = b; });
    }
  }
  var frVal = $("ess-frame-val"), curFrame = "";
  function renderFrame(s) { if (s !== curFrame) { curFrame = s; frVal.textContent = s; } }
  var emSig = "";
  function renderMeta(chips) {
    var sig = chips.map(function (c) { return c[0] + "|" + c[1]; }).join(",");
    if (sig === emSig) return;
    emSig = sig;
    var em = $("ess-meta"); em.textContent = "";
    chips.forEach(function (c) { em.appendChild(el("span", "chip" + (c[1] ? " " + c[1] : ""), c[0])); });
  }

  /* ============================================================ data in */
  function applyData() {
    var d = state.data; if (!d) return;
    var t = d.time;

    renderTC((t.dropFrame ? t.timecode : t.timecodeNDF) || "--:--:--:--");
    renderFrame("frame " + fmtInt(t.frame) + (t.frameCount ? " / " + fmtInt(t.frameCount) : ""));

    var chips = [];
    if (t.fps != null) chips.push([fmt(t.fps, 3) + " fps", ""]);
    if (d.perf.avsync != null) {
      var a = d.perf.avsync, aa = Math.abs(a);
      chips.push(["sync " + (a > 0 ? "+" : "") + fmt(a * 1000, 0) + "ms", aa > 0.1 ? "bad" : aa > 0.04 ? "warn" : ""]);
    }
    if (d.perf.decDrop || d.perf.voDrop) chips.push(["drop " + fmtInt(d.perf.decDrop) + "/" + fmtInt(d.perf.voDrop), "bad"]);
    var pk = -Infinity;
    Object.keys(meterModel).forEach(function (c) { pk = Math.max(pk, meterModel[c].peakT); });
    if (isFinite(pk)) chips.push(["peak " + fmt(pk, 1) + " dBFS", pk > -0.1 ? "bad" : pk > -3 ? "warn" : ""]);
    renderMeta(chips);

    // header
    $("fname").textContent = d.file.name || "—";
    $("fname").title = d.file.path || "";
    var st = $("state");
    var idle = d.file.name == null;
    if (idle) { st.textContent = "idle"; st.className = "chip"; }
    else if (d.file.paused) { st.textContent = "PAUSED"; st.className = "chip paused"; }
    else { st.textContent = "PLAYING"; st.className = "chip playing"; }
    var sp = $("speed");
    if (d.file.speed != null && Math.abs(d.file.speed - 1) > 0.001) { sp.hidden = false; sp.textContent = fmt(d.file.speed, 2) + "×"; }
    else sp.hidden = true;

    // play / pause button — state-driven icon + colour
    var pp = $("b-pause");
    var ppState = idle ? "idle" : (d.file.paused ? "paused" : "playing");
    if (pp.getAttribute("data-state") !== ppState) {
      pp.setAttribute("data-state", ppState);
      pp.innerHTML = ICONS[ppState === "playing" ? "pause" : "play"];
    }

    // scrub bar
    if (!scrubbing && t.duration) {
      var frac = t.pos != null ? Math.max(0, Math.min(1, t.pos / t.duration)) : 0;
      $("scrub-fill").style.width = (frac * 100) + "%";
      $("scrub-head").style.left = (frac * 100) + "%";
      var cacheAhead = (d.perf && d.perf.cacheDuration) || 0;
      var cf = t.pos != null ? Math.min(1, (t.pos + cacheAhead) / t.duration) : 0;
      $("scrub-cache").style.width = (cf * 100) + "%";
    }

    document.body.classList.toggle("ganged", ganged());

    ORDER.forEach(function (kk) {
      if (!state.panels[kk]) return;
      try { P[kk].update(d); } catch (e) { /* keep other panels alive */ }
    });
  }

  iina.onMessage("iinfo-config", function (msg) {
    if (msg && msg.config) applyConfig(msg.config);
    else { applySettings(); }
    pushConfig();
  });
  function resetForNewFile() {
    clearWave();
    meterModel = {};
    sparks.avsync.clear();
    sparks.bitrate.clear();
    sparks.momentary.clear();
  }

  var lastBeat = 0;
  iina.onMessage("iinfo-data", function (d) {
    var now = performance.now();
    // a new clip -> drop all history so the waveform / meters / sparklines don't
    // freeze on the previous file's last frame
    if (d.file && d.file.gen !== state.gen) {
      state.gen = d.file.gen;
      resetForNewFile();
    }
    state.data = d;
    state.compare = d.compare || null;
    lastBeat = now;

    // the plugin only marks metering `fresh` once the data provably belongs to
    // this clip, so we never advance the meters / waveform on stale metadata
    var m = d.meter || {};
    var live = m.fresh ? (m.raw || {}) : null;
    if (live) {
      updateMeterModel(live);
      if (live["lavfi.r128.M"] != null) sparks.momentary.push(parseFloat(live["lavfi.r128.M"]));
      if (d.file && !d.file.paused) pushWaveColumn(live);
    }
    if (d.video && d.video.bitrate != null) sparks.bitrate.push(d.video.bitrate / 1e6);
    if (d.perf && d.perf.avsync != null) sparks.avsync.push(d.perf.avsync);
    applyData();
  });

  /* ============================================================ loops */
  // main.js keeps this page loaded only while the inspector is open (blank.html
  // otherwise). We poll ~25 Hz — BUT when macOS backgrounds IINA, WebKit clamps
  // our timers, so the real gap between ticks balloons. That is exactly when
  // IINA crashes delivering a message to a collected callback, so when we detect
  // the throttle we go completely silent until we're running full-speed again.
  function pollLoop() {
    var now = performance.now();
    awake = (now - lastTick) < 400;   // our own timer isn't being throttled
    lastTick = now;
    if (awake) { try { iina.postMessage("iinfo-poll"); } catch (e) {} }
    setTimeout(pollLoop, 40);
  }
  setTimeout(pollLoop, 0);
  setInterval(function () { document.body.classList.toggle("stale", performance.now() - lastBeat > 1500); }, 400);
  window.addEventListener("pagehide", function () {
    try { iina.postMessage("iinfo-closing"); } catch (e) {}
  });

  var prevT = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.1, (now - prevT) / 1000); prevT = now;
    animateMeters(dt, now);
    ORDER.forEach(function (kk) {
      if (!state.panels[kk]) return;
      var pn = P[kk];
      if (pn.tick) { try { pn.tick(); } catch (e) {} }
    });
  }
  requestAnimationFrame(frame);

  /* ============================================================ controls */
  var ICONS = {
    start: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2.5v14H6zM20 5v14L9 12z"/></svg>',
    end:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 5H18v14h-2.5zM4 5l11 7-11 7z"/></svg>',
    stepback: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h2v14H7zM19 5v14l-9-7z"/></svg>',
    stepfwd:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 5h2v14h-2zM5 5l9 7-9 7z"/></svg>',
    play:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5h4v15H7zM13 4.5h4v15h-4z"/></svg>',
    camera:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3l-1.5 2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.5L15 3zm3 5.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/></svg>',
    gear:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4c0-.6-.05-1.2-.14-1.75l2-1.55-2-3.46-2.36.95c-.9-.76-1.94-1.35-3.08-1.7L15 1h-4l-.42 2.24c-1.14.35-2.18.94-3.08 1.7L5.14 4 3.14 7.45l2 1.55C5.05 9.55 5 10.15 5 12s.05 1.2.14 1.75l-2 1.55 2 3.46 2.36-.95c.9.76 1.94 1.35 3.08 1.7L11 23h4l.42-2.24c1.14-.35 2.18-.94 3.08-1.7l2.36.95 2-3.46-2-1.55c.09-.55.14-1.15.14-1.75z"/></svg>',
    copy:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 1H4a2 2 0 0 0-2 2v13h2V3h11zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/></svg>',
  };
  document.querySelectorAll("[data-icon]").forEach(function (b) {
    var ic = ICONS[b.getAttribute("data-icon")];
    if (ic) b.insertAdjacentHTML("afterbegin", ic);
  });
  $("b-pause").innerHTML = ICONS.play;

  // when A and B are linked, transport verbs fan out to both players via the
  // global entry; otherwise they hit this window's own player as before
  function ganged() {
    return !!(state.compare && state.compare.state && state.compare.state.linked);
  }
  function act(type, value) {
    if (!ganged()) { iina.postMessage("iinfo-action", { type: type, value: value }); return; }
    // resolve state-dependent verbs to an explicit one here, from what we know of
    // our own player, so both windows always land in the SAME state
    if (type === "toggle-pause") {
      var paused = state.data && state.data.file && state.data.file.paused;
      iina.postMessage("iinfo-gang", { action: paused ? "play" : "pause" });
      return;
    }
    iina.postMessage("iinfo-gang", { action: type, value: value });
  }
  $("b-start").addEventListener("click", function () { act("seek-start"); });
  $("b-end").addEventListener("click", function () { act("seek-end"); });
  $("b-prev").addEventListener("click", function () { act("frame-prev"); });
  $("b-next").addEventListener("click", function () { act("frame-next"); });
  $("b-pause").addEventListener("click", function () { act("toggle-pause"); });
  $("b-shot").addEventListener("click", function () { act("screenshot"); });
  $("b-gear").addEventListener("click", function () { $("drawer").classList.toggle("open"); });

  $("jump-group").addEventListener("click", function (e) {
    var b = e.target.closest("[data-jump]"); if (!b) return;
    var tok = b.getAttribute("data-jump");
    var m = tok.match(/^([+-])(\d+(?:\.\d+)?)(f|s)$/);
    if (!m) return;
    var sign = m[1] === "-" ? -1 : 1, val = parseFloat(m[2]) * sign;
    if (m[3] === "f") act("frame-jump", val);
    else act("nudge", val);
  });

  /* ---- Go field: absolute seeks + relative maths (see the input's title) ---- */
  // parse a magnitude token (no leading sign) to seconds, in ctx {fps, duration}
  function goUnit(tok, ctx) {
    tok = tok.trim(); var m;
    if ((m = tok.match(/^(\d+(?:\.\d+)?)\s*%$/))) return ctx.duration ? (parseFloat(m[1]) / 100) * ctx.duration : null;
    if ((m = tok.match(/^#\s*(\d+(?:\.\d+)?)$/))) return ctx.fps ? parseFloat(m[1]) / ctx.fps : null;
    if ((m = tok.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3})|[:;](\d{1,3}))?$/))) {
      var h = +(m[1] || 0), mi = +m[2], s = +m[3], sub = 0;
      if (m[4] != null) sub = parseFloat("0." + m[4]);
      else if (m[5] != null && ctx.fps) sub = (+m[5]) / ctx.fps;
      return h * 3600 + mi * 60 + s + sub;
    }
    if ((m = tok.match(/^(\d+(?:\.\d+)?)\s*s?$/))) return parseFloat(m[1]);
    return null;
  }
  function parseGo(input, ctx) {
    input = input.trim().replace(/\s+/g, " ");
    if (!input) return null;
    var m, v;
    if ((m = input.match(/^([+-])\s*(.+)$/))) {          // relative to current
      v = goUnit(m[2], ctx);
      return v == null ? null : ctx.pos + (m[1] === "-" ? -v : v);
    }
    if ((m = input.match(/^(.+?)\s*([+-])\s*(.+)$/))) {  // base ± delta
      var base = goUnit(m[1], ctx), delta = goUnit(m[3], ctx);
      if (base != null && delta != null) return base + (m[2] === "-" ? -delta : delta);
    }
    v = goUnit(input, ctx);                              // absolute
    return v;
  }
  function doJump() {
    var j = $("jump"), raw = j.value; if (!raw.trim()) return;
    var t = state.data && state.data.time;
    var ctx = { pos: (t && t.pos) || 0, fps: (t && t.fps) || null, duration: (t && t.duration) || null };
    var target = parseGo(raw, ctx);
    if (target == null || !isFinite(target)) {
      j.classList.add("bad"); setTimeout(function () { j.classList.remove("bad"); }, 500);
      return;
    }
    target = Math.max(0, target);
    if (ctx.duration) target = Math.min(target, ctx.duration - (ctx.fps ? 0.5 / ctx.fps : 0.01));
    if (ctx.fps) target = (Math.round(target * ctx.fps) + 0.5) / ctx.fps;   // land on a frame
    act("seek-abs", target);
    // optimistic local update so hammering Enter compounds off the new point
    if (t) { t.pos = target; if (t.fps) t.frame = Math.round(target * t.fps); }
  }
  $("b-jump").addEventListener("click", doJump);
  $("jump").addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") doJump(); });

  function fillJump(val) { var j = $("jump"); j.value = val; j.focus(); j.select(); }

  /* ---- copy / send the current timecode or frame ---- */
  function copyText(s) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(s); return true; } } catch (e) {}
    try {
      var ta = el("textarea"); ta.value = s;
      ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      return true;
    } catch (e) { return false; }
  }
  function flash(node, txt) {
    var o = node.textContent; node.textContent = txt;
    setTimeout(function () { node.textContent = o; }, 900);
  }
  function frameStr() {
    var t = state.data && state.data.time;
    return (t && t.frame != null) ? String(Math.round(t.frame)) : "";
  }
  $("ess-tc").parentNode.addEventListener("click", function (e) {
    var b = e.target.closest("[data-ess]"); if (!b) return;
    var a = b.getAttribute("data-ess");
    if (a === "copy-tc") { copyText(curTC); flash(b, "copied"); }
    else if (a === "go-tc") { fillJump(curTC); }
    else if (a === "copy-fr" && frameStr()) { copyText(frameStr()); flash(b, "copied"); }
    else if (a === "go-fr" && frameStr()) { fillJump("#" + frameStr()); }
  });

  /* ---- keyboard: keep IINA's core playback controls working while this
     window is focused (the web view is a separate process, so we relay them) ---- */
  var KEYS = {
    " ":          ["toggle-pause"], "k": ["toggle-pause"],
    "ArrowLeft":  ["seek-rel", -5], "ArrowRight": ["seek-rel", 5],
    "j":          ["seek-rel", -10], "l": ["seek-rel", 10],
    ",":          ["frame-prev"],   ".": ["frame-next"],
    "m":          ["mute"],
    "[":          ["speed-mult", 1 / 1.25], "]": ["speed-mult", 1.25],
    "Home":       ["seek-start"],   "End": ["seek-end"],
  };
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;          // leave modified combos for IINA / macOS
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.shiftKey) {
      if (e.key === "ArrowLeft")  { e.preventDefault(); act("frame-prev"); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); act("frame-next"); return; }
      if (e.key === "J" || e.key === "j") { e.preventDefault(); act("nudge", -10); return; }
      if (e.key === "L" || e.key === "l") { e.preventDefault(); act("nudge", 10); return; }
      if (e.key === "C" || e.key === "c") { e.preventDefault(); if (frameStr()) copyText(frameStr()); return; }
      return;
    }
    if (e.key === "c") { e.preventDefault(); if (curTC) copyText(curTC); return; }
    var a = KEYS[e.key];
    if (!a) return;
    e.preventDefault();
    act(a[0], a[1]);
  });

  /* ---- scrub bar ---- */
  var scrub = $("scrub"), scrubbing = false, lastSeek = 0;
  // WKWebView reports pointer clientX scaled by the page `zoom` (our text-size
  // setting) but getBoundingClientRect() unscaled — divide clientX back down so
  // the two are in the same space, else the mapping drifts along the bar.
  function pageZoom() {
    var z = parseFloat(document.documentElement.style.zoom);
    if (!(z > 0)) z = parseFloat(getComputedStyle(document.documentElement).zoom);
    return (z > 0 && isFinite(z)) ? z : 1;
  }
  function scrubX(clientX) { return clientX / pageZoom() - scrub.getBoundingClientRect().left; }
  function scrubFrac(clientX) {
    var w = scrub.getBoundingClientRect().width;
    return Math.max(0, Math.min(1, scrubX(clientX) / w));
  }
  function scrubSeek(clientX, force) {
    var d = state.data; if (!d || !d.time || d.time.duration == null) return;
    var frac = scrubFrac(clientX);
    var now = performance.now();
    if (!force && now - lastSeek < 70) return;
    lastSeek = now;
    act("seek-abs", frac * d.time.duration);
  }
  function scrubTip(clientX) {
    var d = state.data; if (!d || !d.time || d.time.duration == null) return;
    var frac = scrubFrac(clientX), t = frac * d.time.duration;
    var tip = $("scrub-tip");
    tip.textContent = clock(t);
    var w = scrub.getBoundingClientRect().width;
    tip.style.left = Math.max(20, Math.min(w - 20, scrubX(clientX))) + "px";
  }
  // move the fill + head to the cursor immediately — applyData() freezes them
  // while dragging (waiting for the real position), which otherwise leaves the
  // head far behind the pointer
  function paintScrub(frac) {
    $("scrub-fill").style.width = (frac * 100) + "%";
    $("scrub-head").style.left = (frac * 100) + "%";
  }
  scrub.addEventListener("pointerdown", function (e) {
    scrubbing = true; scrub.classList.add("dragging");
    try { scrub.setPointerCapture(e.pointerId); } catch (err) {}
    paintScrub(scrubFrac(e.clientX));
    scrubSeek(e.clientX, true); scrubTip(e.clientX);
  });
  scrub.addEventListener("pointermove", function (e) {
    scrubTip(e.clientX);
    if (scrubbing) { paintScrub(scrubFrac(e.clientX)); scrubSeek(e.clientX, false); }
  });
  function endScrub(e) {
    if (!scrubbing) return;
    scrubbing = false; scrub.classList.remove("dragging");
    scrubSeek(e.clientX, true);
  }
  scrub.addEventListener("pointerup", endScrub);
  scrub.addEventListener("pointercancel", function () { scrubbing = false; scrub.classList.remove("dragging"); });

  /* report */
  function buildReport() {
    var d = state.data; if (!d) return "No data yet.";
    var v = d.video, a = d.audio, pf = d.perf, r = d.meter.raw || {}, L = [];
    L.push("IINfo QC report — " + new Date().toISOString());
    L.push("File: " + orDash(d.file.path));
    L.push("");
    L.push("[Timecode] " + ((d.time.dropFrame ? d.time.timecode : d.time.timecodeNDF) || "—") +
      "  frame " + fmtInt(d.time.frame) + " / " + fmtInt(d.time.frameCount));
    L.push("  fps " + fmt(d.time.fps, 6) + " (" + orDash(d.time.fpsSource) + ")  " + (d.time.dropFrame ? "DROP-FRAME" : "non-drop"));
    L.push("  position " + clock(d.time.pos) + " / " + clock(d.time.duration));
    L.push("");
    L.push("[Frame] type=" + orDash(d.frameInfo.pictureType) + " keyframe=" + d.frameInfo.keyFrame +
      " interlaced=" + d.frameInfo.interlaced + " tff=" + d.frameInfo.tff + " repeat=" + d.frameInfo.repeat);
    L.push("");
    L.push("[Video] " + v.w + "x" + v.h + " coded / " + v.dw + "x" + v.dh + " display  PAR " + fmt(v.par, 4) + "  DAR " + orDash(v.aspectName));
    L.push("  pixfmt=" + orDash(v.pixelformat) + " range=" + orDash(v.colorlevels) + " matrix=" + orDash(v.colormatrix));
    L.push("  primaries=" + orDash(v.primaries) + " transfer=" + orDash(v.gamma) + " sig-peak=" + orDash(v.sigPeak) + " rotate=" + orDash(v.rotate));
    L.push("  codec=" + orDash(v.codec) + " decoder=" + orDash(v.decoder) + " hwdec=" + orDash(v.hwdec) + " bitrate=" + bitrate(v.bitrate));
    L.push("");
    L.push("[Audio] " + orDash(a.codec) + "  " + orDash(a.sampleRate) + " Hz  " + orDash(a.channelCount) + "ch (" +
      orDash(a.hrChannels || a.channels) + ")  " + orDash(a.format) + "  bitrate=" + bitrate(a.bitrate));
    if (r["lavfi.r128.I"] != null)
      L.push("  R128: I=" + r["lavfi.r128.I"] + " LUFS  S=" + r["lavfi.r128.S"] + "  M=" + r["lavfi.r128.M"] + "  LRA=" + r["lavfi.r128.LRA"] + "  TP=" + orDash(r["lavfi.r128.true_peak"]));
    L.push("");
    L.push("[Sync] avsync=" + fmt(pf.avsync * 1000, 1) + " ms  drop dec/out=" + fmtInt(pf.decDrop) + "/" + fmtInt(pf.voDrop) +
      "  mistimed=" + fmtInt(pf.mistimed) + "  delayed=" + fmtInt(pf.delayed));
    L.push("  display=" + fmt(pf.displayFps, 3) + " Hz  est-vf-fps=" + fmt(pf.estVfFps, 3));
    return L.join("\n");
  }
  $("b-copy").addEventListener("click", function () {
    $("report-text").value = buildReport();
    $("report").showModal(); $("report-text").select();
  });
  $("report-close").addEventListener("click", function () { $("report").close(); });
  $("report-copy").addEventListener("click", function () {
    $("report-text").select();
    try { if (navigator.clipboard) navigator.clipboard.writeText($("report-text").value); else document.execCommand("copy"); }
    catch (e) { try { document.execCommand("copy"); } catch (e2) {} }
  });

  applySettings(); buildDrawer(); applyVisibility();
  iina.postMessage("iinfo-ready");
})();
