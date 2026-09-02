/*
 * IINfo — real-time video QC inspector for IINA
 * Main entry: runs in each player window's context.
 *
 * Responsibilities:
 *   - own the standalone inspector window (open / close / toggle)
 *   - collect mpv properties on demand and push a single data frame to the webview
 *   - manage a labelled lavfi audio filter (@iinfo) for level + loudness metering,
 *     added only while an audio panel is enabled
 *   - persist the webview's panel/settings config via iina.preferences
 *
 * This file cannot be split (IINA's require() won't return module.exports), so
 * pure logic lives in ui/*.js and is inlined below with drift-guard tests:
 *   ui/config.js  -> var iinfocfg   (config defaults / normalisation)
 *   ui/events.js  -> var qcevents   (the single QC event writer / serialiser)
 *
 * Section map (grep the banners):
 *   helpers · audio filter · video scopes · transport · QC markers
 *   · data collection · window setup · wiring · A/B compare (global)
 *
 * RULE: every mpv read goes through num/str/flag/native (all `alive`-gated).
 * No mpv access outside those four, and none at all on a teardown path.
 */

const { console, core, event, mpv, menu, standaloneWindow, preferences, file, utils, overlay } = iina;

console.log("IINfo: main entry loading (v1.0.0)");

// iina.global is present only when Info.json declares a "globalEntry". Every
// A/B-compare code path below is a guarded no-op without it, so single-player
// behaviour is untouched. All frame/offset maths lives in the global entry.
const G = iina.global || null;

const AF_LABEL = "iinfo";
// asetnsamples forces a predictable ~21 ms analysis window (1024 @ 48k) regardless
// of codec frame size, so the scrolling waveform advances at a steady rate.
// astats (reset=1) -> per-window min/max/RMS/peak for the meters + waveform envelope.
// ebur128 -> momentary / short-term / integrated loudness + true peak.
const AF_GRAPH =
  "@" + AF_LABEL +
  ":lavfi=[asetnsamples=n=1024:p=0,astats=metadata=1:reset=1,ebur128=metadata=1:peak=true]";

/* ---- inlined ui/config.js — canonical plugin configuration ----
 * IINA's require() can't be trusted to return module.exports, so the ONE
 * source of truth for every persisted setting is copied in verbatim.
 * test/config-inline.test.js drift-guards this against ui/config.js. */
var iinfocfg = (function () {
  "use strict";

  // canonical panel keys + default visibility. MUST stay in step with
  // ui/inspector.js `P.<key>.def` — test/config-schema.test.js diffs the two.
  var PANEL_KEYS = ["timecode", "frame", "signal", "scope", "codec", "sync",
                    "compare", "abtech", "markers", "waveform",
                    "levels", "loudness", "audiofmt"];
  var PANEL_DEF = {
    timecode: true, frame: false, signal: true, scope: false, codec: false,
    sync: false, compare: false, abtech: false, markers: false,
    waveform: true, levels: true, loudness: false, audiofmt: false,
  };

  var DEFAULT_MONO = '"Courier New", Courier, ui-monospace, monospace';
  var THEMES = ["black", "dark", "graphite", "midnight", "phosphor", "amber",
                "highcontrast", "light", "auto"];
  var TEXT_SIZES = ["1", "1.15", "1.3", "1.5", "1.75", "2.1"];
  var DRAWER_TABS = ["panels", "appearance", "storage", "actions"];

  var SCOPE_TYPES = ["off", "waveform", "parade", "vectorscope", "histogram"];
  var SCOPE_LAYOUTS = ["overlay", "bottom", "right"];
  var SCOPE_SIZES = ["s", "m", "l", "xl", "xxl"];
  var SCOPE_CORNERS = ["tl", "tr", "bl", "br"];

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function bool(v, d) { return typeof v === "boolean" ? v : d; }
  function pick(v, allowed, d) { return allowed.indexOf(v) >= 0 ? v : d; }

  /* ---- sub-object defaults (functions so callers get fresh copies) ---- */

  function scopeDefault() {
    return { type: "off", layout: "overlay", size: "l", corner: "tr", bright: 0.18, opacity: 1 };
  }
  function settingsDefault() {
    return {
      theme: "black", monoFont: DEFAULT_MONO, textSize: "1.15",
      markerSidecar: false, markerShot: false, drawerTab: "panels", abtechDiffOnly: false,
      experimental: false,
      scope: scopeDefault(),
    };
  }
  function defaults() {
    var panels = {};
    for (var i = 0; i < PANEL_KEYS.length; i++) panels[PANEL_KEYS[i]] = PANEL_DEF[PANEL_KEYS[i]];
    return {
      panels: panels,
      panelOrder: PANEL_KEYS.slice(),
      wave: { mono: false },
      settings: settingsDefault(),
    };
  }

  /* ---- normalisers ---- */

  function normalizeScope(s) {
    s = (s && typeof s === "object") ? s : {};
    return {
      type: pick(s.type, SCOPE_TYPES, "off"),
      layout: pick(s.layout, SCOPE_LAYOUTS, "overlay"),
      size: pick(s.size, SCOPE_SIZES, "l"),
      corner: pick(s.corner, SCOPE_CORNERS, "tr"),
      bright: clamp(num(s.bright, 0.18), 0.03, 0.8),
      opacity: clamp(num(s.opacity, 1), 0.2, 1),
    };
  }


  function normalizeSettings(s) {
    s = (s && typeof s === "object") ? s : {};
    return {
      theme: pick(s.theme, THEMES, "black"),
      monoFont: typeof s.monoFont === "string" && s.monoFont ? s.monoFont : DEFAULT_MONO,
      textSize: pick(String(s.textSize), TEXT_SIZES, "1.15"),
      markerSidecar: bool(s.markerSidecar, false),
      markerShot: bool(s.markerShot, false),
      drawerTab: pick(s.drawerTab, DRAWER_TABS, "panels"),
      abtechDiffOnly: bool(s.abtechDiffOnly, false),
      experimental: bool(s.experimental, false),
      scope: normalizeScope(s.scope),
    };
  }

  function normalizePanels(p) {
    p = (p && typeof p === "object") ? p : {};
    var out = {};
    for (var i = 0; i < PANEL_KEYS.length; i++) {
      var k = PANEL_KEYS[i];
      out[k] = typeof p[k] === "boolean" ? p[k] : PANEL_DEF[k];
    }
    return out;
  }

  // effective panel order: caller's saved order (known keys, de-duped) then any
  // canonical key it was missing, appended in canonical order.
  function normalizeOrder(ord) {
    var seen = {}, out = [];
    (Array.isArray(ord) ? ord : []).forEach(function (k) {
      if (PANEL_KEYS.indexOf(k) >= 0 && !seen[k]) { seen[k] = 1; out.push(k); }
    });
    for (var i = 0; i < PANEL_KEYS.length; i++) if (!seen[PANEL_KEYS[i]]) out.push(PANEL_KEYS[i]);
    return out;
  }

  // Accept anything a prior version may have stored (or nothing) and return the
  // full canonical shape. `raw` is the parsed preferences["config"] blob.
  function normalize(raw) {
    raw = (raw && typeof raw === "object") ? raw : {};
    var cfg = {
      panels: normalizePanels(raw.panels),
      panelOrder: normalizeOrder(raw.panelOrder),
      wave: { mono: bool(raw.wave && raw.wave.mono, false) },
      settings: normalizeSettings(raw.settings),
    };
    return cfg;
  }

  // Migration hook for callers that need the legacy per-window geometry that
  // used to live inside the config blob. Returns {x,y,w,h} or null; never throws.
  function legacyWin(raw) {
    var w = raw && raw.win;
    if (w && isNum(w.w) && isNum(w.h) && w.w > 100 && w.h > 100) {
      return { x: num(w.x, 0), y: num(w.y, 0), w: w.w, h: w.h };
    }
    return null;
  }

  var API = {
    PANEL_KEYS: PANEL_KEYS, PANEL_DEF: PANEL_DEF,
    THEMES: THEMES, TEXT_SIZES: TEXT_SIZES, DRAWER_TABS: DRAWER_TABS,
    SCOPE_TYPES: SCOPE_TYPES, SCOPE_LAYOUTS: SCOPE_LAYOUTS, SCOPE_SIZES: SCOPE_SIZES,
    SCOPE_CORNERS: SCOPE_CORNERS,
    DEFAULT_MONO: DEFAULT_MONO,
    defaults: defaults, scopeDefault: scopeDefault, settingsDefault: settingsDefault,
    normalize: normalize, normalizeScope: normalizeScope,
    normalizeSettings: normalizeSettings, normalizePanels: normalizePanels,
    normalizeOrder: normalizeOrder,
    legacyWin: legacyWin,
  };
  return API;
})();
/* ---- end inlined ui/config.js ---- */

/* ---- inlined ui/events.js — the QC event writer + serialiser ----
 * One place builds and normalises a QC event shape; markHere() goes through
 * qcevents.create(). test/events-inline.test.js guards the copy against drift. */
var qcevents = (function () {
  "use strict";

  var SOURCES = ["manual", "audio", "video", "decode", "sync", "compare", "signalstats", "freezedetect"];
  var CATEGORIES = ["Video", "Audio", "Sync", "Colour", "Performance", "Content", "Other"];
  var SEVERITIES = ["info", "warning", "error"];

  var EDITABLE = ["note", "category", "severity", "durMs", "type"];

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function str(v) { return v == null ? "" : String(v); }

  function idFor() {
    return "qc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  }

  function pickCategory(v) {
    return CATEGORIES.indexOf(v) >= 0 ? v : "Other";
  }
  function pickSeverity(v) {
    return SEVERITIES.indexOf(v) >= 0 ? v : "warning";
  }

  // build a normalized event. `raw` may be a capture context (create) or a
  // persisted record (deserialize) — existing id / ts / resolved are kept.
  function norm(raw) {
    if (!raw || typeof raw !== "object") return null;

    var tMs = raw.tMs;
    if (!isNum(tMs) && isNum(raw.frame) && isNum(raw.fps) && raw.fps > 0) tMs = (raw.frame + 0.5) / raw.fps * 1000;
    if (!isNum(tMs)) return null;
    tMs = Math.max(0, Math.round(tMs));

    var meta = (raw.meta && typeof raw.meta === "object") ? shallow(raw.meta) : {};
    if (raw.abActive != null) meta.abActive = !!raw.abActive;
    if (raw.aId != null) meta.aId = String(raw.aId);
    if (raw.bId != null) meta.bId = String(raw.bId);

    return {
      id: raw.id ? String(raw.id) : idFor(),
      source: SOURCES.indexOf(raw.source) >= 0 ? raw.source : (raw.source ? String(raw.source) : "manual"),
      type: raw.type ? String(raw.type) : "marker",
      tMs: tMs,
      frame: isNum(raw.frame) ? Math.round(raw.frame) : null,
      fps: isNum(raw.fps) && raw.fps > 0 ? raw.fps : null,
      tc: raw.tc ? String(raw.tc) : null,
      durMs: isNum(raw.durMs) && raw.durMs >= 0 ? Math.round(raw.durMs) : null,
      category: pickCategory(raw.category),
      severity: pickSeverity(raw.severity),
      note: str(raw.note),
      resolved: !!raw.resolved,
      ts: isNum(raw.ts) ? raw.ts : Date.now(),
      ref: raw.ref != null ? raw.ref : null,
      meta: meta,
    };
  }

  function shallow(o) {
    var r = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
    return r;
  }

  function create(ctx) { return norm(ctx || {}); }

  function update(ev, patch) {
    var next = shallow(ev);
    next.meta = shallow(ev.meta || {});
    patch = patch || {};
    EDITABLE.forEach(function (k) {
      if (!(k in patch)) return;
      if (k === "category") next.category = pickCategory(patch.category);
      else if (k === "severity") next.severity = pickSeverity(patch.severity);
      else if (k === "durMs") next.durMs = isNum(patch.durMs) && patch.durMs >= 0 ? Math.round(patch.durMs) : null;
      else if (k === "type") next.type = patch.type ? String(patch.type) : "marker";
      else if (k === "note") next.note = str(patch.note);
    });
    return next;
  }

  function withResolved(ev, b) {
    var next = shallow(ev);
    next.meta = shallow(ev.meta || {});
    next.resolved = !!b;
    return next;
  }

  function sort(list) {
    return (list || []).slice().sort(function (a, b) {
      return (a.tMs - b.tMs) || ((a.ts || 0) - (b.ts || 0));
    });
  }

  function matches(ev, q) {
    if (!q) return true;
    if (q.source != null && ev.source !== q.source) return false;
    if (q.auto != null && (ev.source !== "manual") !== !!q.auto) return false;
    if (q.category != null && ev.category !== q.category) return false;
    if (q.severity != null && ev.severity !== q.severity) return false;
    if (q.resolved != null && !!ev.resolved !== !!q.resolved) return false;
    if (q.text) {
      var hay = (ev.note + " " + ev.category + " " + (ev.tc || "")).toLowerCase();
      if (hay.indexOf(String(q.text).toLowerCase()) < 0) return false;
    }
    return true;
  }

  function filter(list, q) {
    return (list || []).filter(function (ev) { return matches(ev, q); });
  }

  function prev(list, tMs, q) {
    var best = null;
    (list || []).forEach(function (ev) {
      if (ev.tMs >= tMs || !matches(ev, q)) return;
      if (!best || ev.tMs > best.tMs || (ev.tMs === best.tMs && (ev.ts || 0) > (best.ts || 0))) best = ev;
    });
    return best;
  }

  function next(list, tMs, q) {
    var best = null;
    (list || []).forEach(function (ev) {
      if (ev.tMs <= tMs || !matches(ev, q)) return;
      if (!best || ev.tMs < best.tMs || (ev.tMs === best.tMs && (ev.ts || 0) < (best.ts || 0))) best = ev;
    });
    return best;
  }

  function serialize(list, media) {
    return JSON.stringify({
      iinfo: "qc-markers",
      version: 1,
      media: media || null,
      saved: new Date().toISOString(),
      events: sort(list).map(norm).filter(Boolean),
    }, null, 2);
  }

  function deserialize(strIn) {
    var o;
    try { o = JSON.parse(strIn); } catch (e) { return null; }
    if (Array.isArray(o)) return { media: null, events: o.map(norm).filter(Boolean) };
    if (!o || typeof o !== "object" || !Array.isArray(o.events)) return null;
    return { media: o.media || null, events: o.events.map(norm).filter(Boolean) };
  }

  var CSV_COLS = ["id", "source", "type", "tc", "frame", "tMs", "durMs", "category", "severity", "resolved", "note"];
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(list) {
    var rows = [CSV_COLS.join(",")];
    sort(list).forEach(function (ev) {
      rows.push(CSV_COLS.map(function (c) { return csvCell(ev[c]); }).join(","));
    });
    return rows.join("\r\n");
  }

  function mdCell(v) {
    return String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  }
  // Markdown. opts.embed -> drop the h1 + media/date preamble (for the bigger report).
  function toReport(list, media, opts) {
    opts = opts || {};
    var s = sort(list);
    var unresolved = s.filter(function (e) { return !e.resolved; }).length;
    var L = [];
    if (!opts.embed) {
      L.push("# IINfo QC markers");
      L.push("");
      L.push("- **Media:** " + (media && (media.path || media.filename) ? "`" + (media.path || media.filename) + "`" : "—"));
      L.push("- **Generated:** " + new Date().toISOString());
      L.push("");
    }
    L.push("**" + s.length + " marker" + (s.length === 1 ? "" : "s") + " · " + unresolved + " unresolved**");
    L.push("");
    if (!s.length) { L.push("_No markers._"); return L.join("\n"); }
    L.push("| # | Severity | Timecode | Frame | Category | Source | Dur | Status | Note |");
    L.push("|--:|----------|----------|------:|----------|--------|-----|--------|------|");
    s.forEach(function (ev, i) {
      L.push("| " + [
        i + 1,
        ev.severity.toUpperCase(),
        "`" + (ev.tc || (ev.tMs / 1000).toFixed(3) + "s") + "`",
        ev.frame != null ? "#" + ev.frame : "—",
        ev.category,
        ev.source !== "manual" ? ev.source : "manual",
        ev.durMs ? (ev.durMs / 1000).toFixed(2) + "s" : "—",
        ev.resolved ? "✓ resolved" : "open",
        ev.note ? mdCell(ev.note) : "—",
      ].join(" | ") + " |");
    });
    return L.join("\n");
  }

  var API = {
    SOURCES: SOURCES, CATEGORIES: CATEGORIES, SEVERITIES: SEVERITIES,
    idFor: idFor,
    create: create, update: update, withResolved: withResolved,
    sort: sort, filter: filter, prev: prev, next: next,
    serialize: serialize, deserialize: deserialize,
    toCSV: toCSV, toReport: toReport,
  };

  return API;
})();
/* ---- end inlined ui/events.js ---- */

let wantWindow = false;    // user intent: opened via toggle and not yet closed. NOT tied to focus.
let afActive = false;      // is our audio filter currently in the chain?
let afWanted = false;      // does the webview want metering right now?
let lastConfig = null;     // last config object received from the webview (for persistence)
let lastContact = 0;       // Date.now() of the last message from the webview
let fileGen = 0;           // bumped on every file load; lets the webview reset its buffers
let lastBeatSent = 0;      // Date.now() of the last iinfo/beat to the global entry
let alive = true;          // false once mpv is tearing down — STOP calling into it
                           // (a timer callback hitting a freed mpv handle segfaults,
                           //  and native crashes aren't catchable by try/catch)

/* QC markers — the web view owns the canonical list while the inspector is open
 * and pushes it up serialized; here we just load it on file change, persist what
 * the web view sends, and capture a minimal marker for the ⌥⇧M menu path. */
let qcList = [];           // marker events for the current media
let qcMedia = null;        // { path, filename, size, durationMs, fps } identity block
let qcGen = 0;             // bumped whenever qcList is (re)loaded from disk
let qcLoadedGen = -1;      // fileGen we last loaded markers for
let qcNeedsId = false;     // loaded before path was known — retry once it lands
let qcNeedsSize = false;   // loaded before file-size was known — re-key once it lands
let qcSidecarError = false; // last sidecar write fell back to the data dir
let qcSaveTimer = null;
let qcPendingBody = null;

/* ------------------------------------------------------------------ helpers */

// every mpv read goes through these — one `alive` gate keeps a stray timer /
// poll from calling into a freed mpv handle during window teardown (segfault)
function num(name) {
  if (!alive) return null;
  try { const v = mpv.getNumber(name); return typeof v === "number" && isFinite(v) ? v : null; }
  catch (e) { return null; }
}
function str(name) {
  if (!alive) return null;
  try { const v = mpv.getString(name); return v == null || v === "" ? null : v; }
  catch (e) { return null; }
}
function flag(name) {
  if (!alive) return null;
  try { const v = mpv.getFlag(name); return typeof v === "boolean" ? v : null; }
  catch (e) { return null; }
}
function native(name) {
  if (!alive) return null;
  try { const v = mpv.getNative(name); return v == null ? null : v; }
  catch (e) { return null; }
}

function pad(n, w) { n = String(Math.abs(Math.trunc(n))); while (n.length < (w || 2)) n = "0" + n; return n; }

function isDropFrameRate(fps) {
  if (!fps) return false;
  // only the 30000/1001 family is drop-frame; 23.976 and 24000/1001 never are
  return Math.abs(fps - 30000 / 1001) < 0.02 ||
         Math.abs(fps - 60000 / 1001) < 0.02;
}

/* SMPTE timecode from an absolute frame index. Andrew Duncan drop-frame algorithm. */
function framesToTimecode(frameNumber, fps) {
  if (frameNumber == null || !fps || !isFinite(fps)) return "--:--:--:--";
  const df = isDropFrameRate(fps);
  const nominal = Math.round(fps);            // 30 or 60 for DF rates
  const sep = df ? ";" : ":";

  if (df) {
    const dropPerMin = Math.round(fps * 0.066666); // 2 @29.97, 4 @59.94
    const framesPer10Min = Math.round(fps * 60 * 10);
    const framesPerMin = nominal * 60;
    let f = frameNumber;
    const d = Math.floor(f / framesPer10Min);
    const m = f % framesPer10Min;
    if (m > dropPerMin) {
      f += dropPerMin * 9 * d + dropPerMin * Math.floor((m - dropPerMin) / framesPerMin);
    } else {
      f += dropPerMin * 9 * d;
    }
    frameNumber = f;
  }

  const ff = frameNumber % nominal;
  const ss = Math.floor(frameNumber / nominal) % 60;
  const mm = Math.floor(frameNumber / (nominal * 60)) % 60;
  const hh = Math.floor(frameNumber / (nominal * 3600)) % 24;
  return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + sep + pad(ff);
}

/* ---- screenshots ------------------------------------------------------
 * mpv writes the frame itself (screenshot-to-file, "video" = clean, full-res),
 * so this bypasses the plugin file sandbox — the grab lands next to the media
 * file. Callers: the toolbar / ⌥⇧S button (shotNow), the per-marker camera
 * button in the web view (shotAtMarker — seeks to the frame first), and
 * markHere() when the "screenshot each marker" opt-in is on. */

// { dir, leaf } for the current LOCAL media file (leaf keeps its extension —
// the screenshot is named "<leaf> …"), or null for a stream / no path
function mediaFile() {
  const p = str("path");
  if (!p || p.indexOf("://") >= 0) return null;
  const slash = p.lastIndexOf("/");
  return {
    dir: slash >= 0 ? p.slice(0, slash) : ".",
    leaf: slash >= 0 ? p.slice(slash + 1) : p,
  };
}
// a filename-safe fragment: strip control chars + the path/Windows-reserved
// set, collapse whitespace, cap the length
function fsSafe(s) {
  return String(s == null ? "" : s)
    .replace(/[\x00-\x1f\/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 60);
}
// position through the media as a filename-clean timecode — "HH.MM.SS;FF"
// (dots between h/m/s, ";" before frames). Falls back to milliseconds when
// there's no timecode. NEVER wall-clock time.
function shotStamp(tc, tMs) {
  if (tc) {
    const p = String(tc).trim().split(/[:;]/);
    if (p.length === 4 && p.every((x) => /^\d+$/.test(x))) {
      return p[0] + "." + p[1] + "." + p[2] + ";" + p[3];
    }
  }
  return Math.max(0, Math.round(tMs || 0)) + "ms";
}

// the current playhead as { tc, tMs } — same tc rules markHere() uses
function nowStamp() {
  const t = num("time-pos");
  const fps = num("container-fps") || num("estimated-vf-fps");
  let frame = num("estimated-frame-number");
  if (frame == null && fps && t != null) frame = Math.round(t * fps);
  const tc = framesToTimecode(frame, fps);
  return { tc: tc && tc.indexOf("-") < 0 ? tc : null, tMs: t != null ? Math.round(t * 1000) : 0 };
}

// the toolbar / ⌥⇧S screenshot — beside the media file like a marker grab, or
// mpv's own screenshot dir when the media has no local path (a stream)
function shotNow() {
  if (!alive) return;
  if (!mediaFile()) {
    try { mpv.command("screenshot", ["video"]); core.osd("IINfo: screenshot saved"); } catch (e) {}
    return;
  }
  const s = nowStamp();
  grabShot(null, s.tc, s.tMs);
}

let shotPending = null;    // a marker screenshot waiting on core.seekTo() to land
let shotTimer = null;

// write a screenshot of the CURRENT frame beside the media. note "" ->
// "<clip.ext> <stamp>.png"; note set -> "<clip.ext> - <note> <stamp>.png".
// Never overwrites.
function grabShot(note, tc, tMs) {
  if (!alive) return;
  const mf = mediaFile();
  if (!mf) { core.osd("IINfo: screenshot needs a local video file"); return; }
  const n = fsSafe(note), stamp = shotStamp(tc, tMs);
  const name = n ? mf.leaf + " - " + n + " " + stamp : mf.leaf + " " + stamp;
  let target = mf.dir + "/" + name + ".png";
  try {
    for (let k = 2; k < 200 && file.exists(target); k++) target = mf.dir + "/" + name + " (" + k + ").png";
  } catch (e) {}
  try {
    mpv.command("screenshot-to-file", [target, "video"]);
    core.osd("IINfo: screenshot → " + target.split("/").pop());
  } catch (e) {
    console.log("IINfo: screenshot-to-file — " + e);
    core.osd("IINfo: screenshot failed");
  }
}

// per-marker button: land on the marked frame, then grab it
function shotAtMarker(m) {
  if (!alive || !m) return;
  const tMs = typeof m.tMs === "number" ? m.tMs : null;
  const now = num("time-pos");
  if (tMs == null || (now != null && Math.abs(now * 1000 - tMs) < 60)) {
    grabShot(m.note, m.tc, tMs);
    return;
  }
  shotPending = { note: m.note, tc: m.tc || null, tMs: tMs };
  if (shotTimer) clearTimeout(shotTimer);
  shotTimer = setTimeout(fireShotPending, 1500);   // fallback if playback-restart never comes
  try { core.seekTo(tMs / 1000); } catch (e) {}
}
function fireShotPending() {
  if (shotTimer) { clearTimeout(shotTimer); shotTimer = null; }
  const p = shotPending; shotPending = null;
  if (p) grabShot(p.note, p.tc, p.tMs);
}

/* ------------------------------------------------------------ audio filter
 *
 * The whole lifecycle is driven from tickFilter(), which runs on every poll
 * (~30 Hz). Nothing about it is gated on an event firing at the right moment —
 * so a close -> open, a mid-stream track switch, mpv dropping the filter, or an
 * `af add` that failed because the audio wasn't ready yet all self-heal on the
 * next poll.
 */

let armedGen = -1;         // fileGen the current @iinfo instance was installed for
let freshGen = -1;         // fileGen whose live metadata has diverged from the install snapshot
let installedAt = 0;       // Date.now() the current @iinfo instance was added
let staleSnap = "{}";      // af-metadata captured right after install
let afError = "";          // last `af add` failure message, surfaced to the UI

function filterPresent() {
  const list = native("af");
  if (!Array.isArray(list)) return false;
  return list.some((f) => f && (f.label === AF_LABEL || f.label === "@" + AF_LABEL));
}

function snapshotMeta() {
  try { return JSON.stringify(native("af-metadata/" + AF_LABEL) || {}); }
  catch (e) { return "{}"; }
}

function tryRemove() {
  if (!alive) return;
  try { mpv.command("af", ["remove", "@" + AF_LABEL]); } catch (e) {}
}
function tryAdd() {
  if (!alive) return false;
  try {
    mpv.command("af", ["add", AF_GRAPH]);
    afActive = true;
    afError = "";
    installedAt = Date.now();
    armedGen = fileGen;
    freshGen = -1;
    staleSnap = snapshotMeta();
    return true;
  } catch (e) {
    afActive = false;
    afError = String(e);
    return false;
  }
}

// call once per poll, before reading af-metadata
function tickFilter() {
  if (!wantWindow || !afWanted) {
    if (filterPresent()) tryRemove();
    afActive = false; armedGen = -1;
    return;
  }
  const present = filterPresent();
  if (armedGen !== fileGen) {
    // clip changed (or first arm): tear any carried-over instance down this
    // poll, install a fresh one the next -> no synchronous remove/add race
    if (present) { tryRemove(); afActive = false; return; }
    tryAdd();
    return;
  }
  // armed for the current clip
  if (!present) { tryAdd(); return; }   // mpv dropped it — put it back
  afActive = true;
}

// pull the filter out without forgetting that the webview wants it — so it
// comes back on its own once the window is open again
function teardownFilter() {
  if (filterPresent()) tryRemove();
  afActive = false;
  armedGen = -1;
}

/* ------------------------------------------------------------ video scopes
 *
 * A labelled @iinfoscope video filter, composited into a corner of the picture
 * (split + <scope> + overlay). Lifecycle is poll-driven exactly like the audio
 * filter: tickScope() (in collect() and the 1 Hz watchdog) reconciles the
 * running instance against scopeCfg + fileGen, so a config change, a clip
 * change, or mpv dropping the filter all self-heal. Its consumer is the video
 * itself, so — unlike the audio filter — it is NOT gated on the inspector window.
 */

const SCOPE_LABEL = "iinfoscope";
const SCOPE_TYPES = ["off", "waveform", "parade", "vectorscope", "histogram"];
const SCOPE_SIZES = { s: 380, m: 560, l: 760, xl: 1000, xxl: 1320 };
let scopeArmedSig = null;   // the graph string the running instance was built for
let scopeArmedGen = -1;
let scopeError = "";

// pure: build the mpv `vf add` argument for a scope config, or null for "off"
function scopeGraph(cfg) {
  if (!cfg || !cfg.type || cfg.type === "off") return null;
  const b = Math.max(0.03, Math.min(0.8, typeof cfg.bright === "number" ? cfg.bright : 0.18)).toFixed(3);
  let pre, inner, ratio;   // ratio = box height / width
  switch (cfg.type) {
    case "waveform":
      pre = "format=yuv444p";
      inner = "waveform=mode=column:components=1:filter=lowpass:graticule=green:flags=numbers+dots:intensity=" + b + ":bgopacity=1";
      ratio = 0.82; break;
    case "parade":
      pre = "format=gbrp";
      inner = "waveform=mode=column:components=7:filter=lowpass:display=parade:graticule=green:flags=numbers:intensity=" + b + ":bgopacity=1";
      ratio = 0.82; break;
    case "vectorscope":
      pre = "format=yuv444p";
      inner = "vectorscope=mode=color3:graticule=green:flags=name:intensity=" + Math.min(1, b * 3).toFixed(3) + ":bgopacity=1";
      ratio = 1; break;
    case "histogram":
      pre = "format=gbrp";
      inner = "histogram=fgopacity=0.9:bgopacity=1";
      ratio = 0.75; break;
    default: return null;
  }
  const layout = cfg.layout || "overlay";
  const scope = pre + "," + inner;

  if (layout === "bottom" || layout === "right") {
    // dock the scope in its own strip — the picture keeps its format, the scope
    // is scaled (scale2ref) into the space `pad` adds, so hstack/vstack format
    // clashes are avoided entirely
    const frac = { s: 0.16, m: 0.24, l: 0.32, xl: 0.42, xxl: 0.55 }[cfg.size] || 0.32;
    const strip = (frac / (1 + frac)).toFixed(4);   // strip / padded-frame
    if (layout === "bottom") {
      return "@" + SCOPE_LABEL + ":lavfi=[split=2[m][s];" +
        "[s]scale=1280:-2," + scope + ",setsar=1[sc0];" +
        "[m]pad=w=iw:h=ceil(ih*" + (1 + frac).toFixed(4) + "/2)*2:x=0:y=0:color=black[mp];" +
        "[sc0][mp]scale2ref=w=main_w:h=main_h*" + strip + "[scr][mpr];" +
        "[mpr][scr]overlay=x=(W-w)/2:y=H-h]";
    }
    return "@" + SCOPE_LABEL + ":lavfi=[split=2[m][s];" +
      "[s]scale=900:-2," + scope + ",setsar=1[sc0];" +
      "[m]pad=w=ceil(iw*" + (1 + frac).toFixed(4) + "/2)*2:h=ih:x=0:y=0:color=black[mp];" +
      "[sc0][mp]scale2ref=w=main_w*" + strip + ":h=main_h[scr][mpr];" +
      "[mpr][scr]overlay=x=W-w:y=(H-h)/2]";
  }

  // overlay in a picture corner
  const boxW = SCOPE_SIZES[cfg.size] || SCOPE_SIZES.l;
  const boxH = Math.round(boxW * ratio);
  let chain = "[s]scale=960:-2," + scope + ",scale=" + boxW + ":" + boxH + ",setsar=1," +
    "drawbox=x=0:y=0:w=iw:h=ih:color=0x666666@0.9:t=2";
  const opa = (typeof cfg.opacity === "number" && cfg.opacity < 1) ? Math.max(0.2, Math.min(1, cfg.opacity)) : null;
  if (opa != null) chain += ",format=rgba,colorchannelmixer=aa=" + opa.toFixed(2);
  chain += "[sc]";
  const n = 18;
  const pos = {
    tl: "x=" + n + ":y=" + n,
    tr: "x=W-w-" + n + ":y=" + n,
    bl: "x=" + n + ":y=H-h-" + n,
    br: "x=W-w-" + n + ":y=H-h-" + n,
  }[cfg.corner] || ("x=W-w-" + n + ":y=" + n);
  return "@" + SCOPE_LABEL + ":lavfi=[split=2[m][s];" + chain + ";[m][sc]overlay=" + pos + "]";
}

// live scope config (defaults from the inlined ui/config.js; the web view owns
// it while the inspector is open, persisted in the shared "config" blob)
let scopeCfg = iinfocfg.scopeDefault();

function scopePresent() {
  const list = native("vf");
  if (!Array.isArray(list)) return false;
  return list.some((f) => f && (f.label === SCOPE_LABEL || f.label === "@" + SCOPE_LABEL));
}
function scopeRemove() {
  if (!alive) return;
  try { mpv.command("vf", ["remove", "@" + SCOPE_LABEL]); } catch (e) {}
  scopeArmedSig = null; scopeArmedGen = -1;
}
function tickScope() {
  if (!alive) return;
  const sig = scopeGraph(scopeCfg);
  if (!sig) { if (scopePresent()) scopeRemove(); return; }
  const present = scopePresent();
  if (present && scopeArmedSig === sig && scopeArmedGen === fileGen) return;
  if (present) {                       // config / clip changed — drop now, re-add next tick
    scopeRemove();
    return;
  }
  try {
    mpv.command("vf", ["add", sig]);
    scopeArmedSig = sig; scopeArmedGen = fileGen; scopeError = "";
  } catch (e) {
    scopeError = String(e); scopeArmedSig = null;
    console.log("IINfo: scope `vf add` — " + e);
  }
}
function persistScopeCfg() {
  try {
    lastConfig = lastConfig || {};
    lastConfig.settings = lastConfig.settings || {};
    lastConfig.settings.scope = scopeCfg;
    preferences.set("config", JSON.stringify(lastConfig));
    preferences.sync();
  } catch (e) {}
}
function setScope(patch) {
  scopeCfg = Object.assign({}, scopeCfg, patch || {});
  tickScope();
  if (wantWindow) { try { standaloneWindow.postMessage("iinfo-scope-set", { scope: scopeCfg }); } catch (e) {} }
  else persistScopeCfg();
}
function cycleScope() {
  const i = SCOPE_TYPES.indexOf(scopeCfg.type);
  setScope({ type: SCOPE_TYPES[(i + 1) % SCOPE_TYPES.length] });
  core.osd("IINfo scope: " + scopeCfg.type);
}

/* ---------------------------------------------------------------- transport
 *
 * One place that turns a transport verb into an mpv/core call. Used by the
 * webview's own controls (iinfo-action) AND, when this window is ganged as A or
 * B, by the global entry (iinfo/gang-exec). Same code either way.
 */
function runAction(type, value) {
  if (!alive) return;
  const fr = () => num("container-fps") || num("estimated-vf-fps");
  try {
    switch (type) {
      case "frame-next":     mpv.command("frame-step", []); break;
      case "frame-prev":     mpv.command("frame-back-step", []); break;
      case "frame-jump": {
        const n = Math.round(value || 0), f = num("estimated-frame-number"), rate = fr();
        if (n === 0) break;
        if (f != null && rate) core.seekTo((Math.max(0, f + n) + 0.5) / rate);
        else if (rate) core.seek(n / rate, true);
        break;
      }
      case "toggle-pause":   flag("pause") ? core.resume() : core.pause(); break;
      case "play":           core.resume(); break;
      case "pause":          core.pause(); break;
      case "screenshot":     shotNow(); break;
      case "marker-shot":    shotAtMarker(value); break;
      case "seek-abs":       if (typeof value === "number") core.seekTo(value); break;
      case "seek-rel":       if (typeof value === "number") core.seek(value, false); break;
      case "nudge":          if (typeof value === "number") core.seek(value, true); break;
      case "seek-start":     core.seekTo(0); break;
      case "seek-end":       { const d = num("duration"); if (d) core.seekTo(Math.max(0, d - 0.05)); break; }
      case "mute":           mpv.command("cycle", ["mute"]); break;
      case "speed-mult":     if (typeof value === "number") mpv.command("multiply", ["speed", String(value)]); break;
    }
  } catch (e) { console.log("IINfo action error: " + e); }
}

/* -------------------------------------------------------------- QC markers */

function djb2Hex(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return ("0000000" + h.toString(16)).slice(-8);
}
function localMediaPath() {
  const p = str("path");
  return p && p.indexOf("://") < 0 ? p : null;   // sidecars only make sense for local files
}
function sidecarPath() {
  const p = localMediaPath();
  return p ? p + ".iinfo.json" : null;
}
function wantSidecar() {
  return !!(lastConfig && lastConfig.settings && lastConfig.settings.markerSidecar);
}
function safeExists(p) { try { return !!p && file.exists(p); } catch (e) { return false; } }

function qcIdentity() {
  const path = str("path");
  const filename = str("filename") || (path ? path.split("/").pop() : null);
  if (!path && !filename) return null;
  const dur = num("duration");
  const size = num("file-size");
  const fps = num("container-fps") || num("estimated-vf-fps");
  return {
    path: path || null,
    filename: filename || null,
    size: size != null ? Math.round(size) : null,
    durationMs: dur != null ? Math.round(dur * 1000) : null,
    fps: fps || null,
  };
}
function qcFingerprint(id) {
  return djb2Hex((id.filename || "?") + "|" + (id.size != null ? id.size : "?"));
}
function dataMarkerFile(id) { return "@data/qc-" + qcFingerprint(id) + ".json"; }
function markerFile(id) {
  const side = sidecarPath();
  if (side && (wantSidecar() || safeExists(side))) return side;
  return dataMarkerFile(id);
}

// one serialiser — same envelope + normalisation the web view writes
function serializeMarkers() {
  return qcevents.serialize(qcList, qcMedia || null);
}

function loadMarkers() {
  if (!alive) return;
  const id = qcIdentity();
  qcMedia = id;
  qcSidecarError = false;
  qcNeedsSize = !!(id && id.size == null);
  let list = [];
  if (id) {
    const f = markerFile(id);
    try {
      if (file.exists(f)) {
        const parsed = JSON.parse(file.read(f) || "null");
        const evs = parsed && Array.isArray(parsed.events) ? parsed.events
          : (Array.isArray(parsed) ? parsed : []);
        list = evs.filter((e) => e && typeof e === "object" && typeof e.tMs === "number");
      }
    } catch (e) { console.log("IINfo: marker load — " + e); }
  }
  qcList = list;
  qcGen++;
  qcLoadedGen = fileGen;
  qcNeedsId = !id;                 // path wasn't ready — retry when it appears
  // callers push a fresh frame (file-loaded handler / next poll / markHere)
}
function maybeLoadMarkers() {
  if (!alive) return;
  if (qcLoadedGen !== fileGen) loadMarkers();
  else if (qcNeedsId && str("path") != null) loadMarkers();
  else if (qcNeedsSize && num("file-size") != null) loadMarkers();
}

function persistMarkers(body) {
  qcPendingBody = body != null ? body : serializeMarkers();
  if (qcSaveTimer) return;
  qcSaveTimer = setTimeout(flushMarkers, 800);
}
function flushMarkersNow() {
  if (qcSaveTimer) { clearTimeout(qcSaveTimer); qcSaveTimer = null; }
  if (qcPendingBody != null) flushMarkers();
}
function flushMarkers() {
  qcSaveTimer = null;
  const body = qcPendingBody; qcPendingBody = null;
  if (body == null) return;
  const id = qcMedia || qcIdentity();
  if (!id) return;
  const target = markerFile(id);
  try {
    file.write(target, body);
    qcSidecarError = false;
  } catch (e) {
    console.log("IINfo: marker save (" + target + ") — " + e);
    if (target.indexOf("@data") !== 0) {
      try { file.write(dataMarkerFile(id), body); qcSidecarError = true; }
      catch (e2) { console.log("IINfo: marker save fallback — " + e2); }
    }
  }
}

// ⌥⇧M — capture a marker at the current frame even with the inspector closed.
// Goes through the same writer (qcevents.create) as every other QC event.
function markHere() {
  if (!alive) return;
  const t = num("time-pos");
  if (t == null) { core.osd("IINfo: no media to mark"); return; }
  const fps = num("container-fps") || num("estimated-vf-fps");
  let frame = num("estimated-frame-number");
  if (frame == null && fps) frame = Math.round(t * fps);
  const tc = framesToTimecode(frame, fps);
  const cmp = lastCompare && lastCompare.state;
  const paired = !!(cmp && cmp.aId && cmp.bId);
  const ev = qcevents.create({
    source: "manual", type: "marker",
    tMs: Math.round(t * 1000),
    frame: frame,
    fps: fps,
    tc: tc && tc.indexOf("-") < 0 ? tc : null,
    category: "Other", severity: "warning", note: "",
    abActive: paired ? !!cmp.linked : undefined,
    aId: paired ? cmp.aId : undefined,
    bId: paired ? cmp.bId : undefined,
  });
  if (!qcMedia) qcMedia = qcIdentity();
  qcList = qcList.concat([ev]);
  qcGen++;
  persistMarkers(serializeMarkers());
  // opt-in: a screenshot beside the media for every new marker (Tools ▸ Storage)
  if (lastConfig && lastConfig.settings && lastConfig.settings.markerShot) {
    try { grabShot(null, ev.tc, ev.tMs); } catch (e) {}
  }
  core.osd("IINfo: QC marker " + (ev.tc || (ev.tMs / 1000).toFixed(2) + "s"));
  if (wantWindow) { try { standaloneWindow.postMessage("iinfo-data", collect()); } catch (e) {} }
}

/* --------------------------------------------------------- data collection */

function collect() {
  const fps = num("container-fps") || num("estimated-vf-fps");
  const t = num("time-pos");
  const dur = num("duration");

  let frame = num("estimated-frame-number");
  if (frame == null && t != null && fps) frame = Math.round(t * fps);
  let frameCount = num("estimated-frame-count");
  if (frameCount == null && dur != null && fps) frameCount = Math.round(dur * fps);

  tickFilter();
  tickScope();

  const vp = native("video-params") || {};
  const ap = native("audio-params") || {};
  const fi = native("video-frame-info") || {};
  const cacheState = native("demuxer-cache-state") || {};

  // metering: only expose data once it provably belongs to the current clip —
  // it's non-empty, it has been >250 ms since the filter was installed, and it
  // has diverged from the snapshot taken at install time. Guards against mpv
  // handing back the previous file's af-metadata after a close/open.
  let meterFresh = false;
  let afMeta = {};
  const hasName = !!str("filename");
  if (afActive && hasName && armedGen === fileGen) {
    const live = native("af-metadata/" + AF_LABEL) || {};
    const liveStr = JSON.stringify(live);
    const nonEmpty = liveStr !== "{}" && Object.keys(live).length > 0;
    if (freshGen === fileGen && nonEmpty) {
      meterFresh = true; afMeta = live;
    } else if (nonEmpty && Date.now() - installedAt > 250 && (staleSnap === "{}" || liveStr !== staleSnap)) {
      meterFresh = true; freshGen = fileGen; afMeta = live;
    }
  }

  return {
    now: Date.now(),

    /* transport / header */
    file: {
      gen: fileGen,
      name: str("filename"),
      path: str("path"),
      format: str("file-format"),
      size: num("file-size"),
      paused: flag("pause"),
      speed: num("speed"),
    },

    /* timecode & frames */
    time: {
      pos: t,
      duration: dur,
      remaining: (dur != null && t != null) ? Math.max(0, dur - t) : null,
      percent: num("percent-pos"),
      fps: fps,
      fpsSource: num("container-fps") ? "container" : (num("estimated-vf-fps") ? "vf-estimate" : null),
      frame: frame,
      frameCount: frameCount,
      dropFrame: isDropFrameRate(fps),
      timecode: framesToTimecode(frame, fps),
      timecodeNDF: frame != null && fps
        ? (function () {
            const nfps = Math.round(fps);
            const ff = frame % nfps, ss = Math.floor(frame / nfps) % 60,
                  mm = Math.floor(frame / (nfps * 60)) % 60, hh = Math.floor(frame / (nfps * 3600)) % 24;
            return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ":" + pad(ff);
          })()
        : null,
    },

    /* current frame metadata */
    frameInfo: {
      pictureType: fi["picture-type"] || null,
      keyFrame: typeof fi["key-frame"] === "boolean" ? fi["key-frame"] : null,
      interlaced: typeof fi["interlaced"] === "boolean" ? fi["interlaced"] : null,
      tff: typeof fi["tff"] === "boolean" ? fi["tff"] : null,
      repeat: typeof fi["repeat"] === "boolean" ? fi["repeat"]
              : (typeof fi["repeat-pict"] === "number" ? fi["repeat-pict"] : null),
      gopTimecode: fi["gop-timecode"] || null,
      smpteTimecode: fi["smpte-timecode"] || null,
      estimatedSmpte: fi["estimated-smpte-timecode"] || null,
      raw: fi,
    },

    /* video signal */
    video: {
      w: vp.w, h: vp.h, dw: vp.dw, dh: vp.dh,
      aspect: vp.aspect, aspectName: vp["aspect-name"], par: vp.par,
      pixelformat: vp.pixelformat,
      colormatrix: vp.colormatrix, colorlevels: vp.colorlevels,
      primaries: vp.primaries, gamma: vp.gamma, sigPeak: vp["sig-peak"],
      chromaLocation: vp["chroma-location"],
      rotate: vp.rotate, stereoIn: vp["stereo-in"], alpha: vp.alpha,
      codec: str("video-codec"),
      decoder: (function () {
        const ct = native("current-tracks/video"); return ct ? (ct["decoder-desc"] || ct.codec) : null;
      })(),
      hwdec: str("hwdec-current"),
      bitrate: num("video-bitrate"),
    },

    /* audio format */
    audio: {
      sampleRate: ap["samplerate"] || num("audio-params/samplerate"),
      channelCount: ap["channel-count"] || num("audio-params/channel-count"),
      channels: ap["channels"] || null,
      hrChannels: ap["hr-channels"] || null,
      format: ap["format"] || null,
      codec: str("audio-codec-name") || str("audio-codec"),
      bitrate: num("audio-bitrate"),
      trackTitle: (function () {
        const ct = native("current-tracks/audio"); return ct ? ct.title : null;
      })(),
      trackLang: (function () {
        const ct = native("current-tracks/audio"); return ct ? ct.lang : null;
      })(),
    },

    /* sync & performance */
    perf: {
      avsync: num("avsync"),
      decDrop: num("decoder-frame-drop-count"),
      voDrop: num("frame-drop-count"),
      mistimed: num("mistimed-frame-count"),
      delayed: num("vo-delayed-frame-count"),
      displayFps: num("display-fps") || num("estimated-display-fps"),
      estVfFps: num("estimated-vf-fps"),
      cacheDuration: cacheState["cache-duration"] != null ? cacheState["cache-duration"] : num("demuxer-cache-duration"),
      cacheUnderrun: cacheState["underrun"] === true,
    },

    /* metering — `fresh` is false until the data provably belongs to this clip */
    meter: {
      active: afActive,
      wanted: afWanted,
      fresh: meterFresh,
      error: (afWanted && !afActive) ? (afError || "") : "",
      raw: afMeta,
    },

    /* A/B compare — null unless the global entry is loaded and has broadcast */
    compare: lastCompare
      ? { state: lastCompare.state, players: lastCompare.players, myId: myId }
      : null,

    /* QC markers for the current media */
    markers: {
      list: qcList,
      media: qcMedia,
      gen: qcGen,
      sidecar: wantSidecar(),
      sidecarError: qcSidecarError,
    },

    /* video scope filter */
    scope: { cfg: scopeCfg, active: scopePresent(), error: scopeError },
  };
}

/* ------------------------------------------------------------ window setup */

// The webview (ui/inspector.html) is only loaded while the inspector is open —
// openWindow() loads it, closeWindow() swaps in ui/blank.html. That keeps nothing
// of ours running (or posting messages to IINA) while the window is closed, which
// is when IINA was crashing after long idle periods.
//
// IMPORTANT: standaloneWindow.loadFile() clears every registered message listener,
// so wireMessages() must run *after* each loadFile(), not once at plugin start.
let webviewLoaded = false;

// Every standalone-window message callback is held here so JavaScriptCore's GC
// can't collect it. IINA's message hub calls `callback.value` with no nil-check;
// once the JSManagedValue is collected the next webview message is a SIGTRAP
// (the "idle crash", and it recurs under the heavier A/B message traffic).
// loadFile() clears IINA's listener list, so wireMessages() re-runs on every
// open — reset the array first so stale closures don't pile up.
const WIN_PINS = [];
function onWin(name, fn) { WIN_PINS.push(fn); standaloneWindow.onMessage(name, fn); }

function wireMessages() {
  WIN_PINS.length = 0;

  onWin("iinfo-ready", () => {
    alive = true;   // recover if a transient window-will-close parked us
    lastContact = Date.now();
    maybeLoadMarkers();
    standaloneWindow.postMessage("iinfo-config", { config: lastConfig });
    standaloneWindow.postMessage("iinfo-data", collect());
  });

  onWin("iinfo-poll", () => {
    lastContact = Date.now();
    // while an inspector is open, beat a few times a second so the global
    // registry (and the other window's compare readout) stays responsive
    if (G && Date.now() - lastBeatSent > 250) { lastBeatSent = Date.now(); gBeat(); }
    maybeLoadMarkers();
    standaloneWindow.postMessage("iinfo-data", collect());
  });

  // sent from pagehide — the user closed the window with the red title-bar button
  onWin("iinfo-closing", () => {
    flushMarkersNow();
    if (!wantWindow) return;
    wantWindow = false;
    teardownFilter();
    try { standaloneWindow.loadFile("ui/blank.html"); webviewLoaded = false; } catch (e) {}
    console.log("IINfo: inspector closed (from window)");
  });

  onWin("iinfo-config", (cfg) => {
    const wasSidecar = wantSidecar();
    // geometry is per-window state — pull it out and store it under its own key,
    // never into the shared "config" blob (see loadGeomMap / DECISIONS)
    if (cfg && cfg.win) saveGeom(cfg.win);
    lastConfig = iinfocfg.normalize(cfg);   // one validator, same as the web view
    // preferences.set alone only persists to disk when a prefs page closes —
    // sync() forces the flush so panel visibility + display settings survive a restart
    try { preferences.set("config", JSON.stringify(lastConfig)); preferences.sync(); } catch (e) {}
    // enable metering whenever an audio panel wants it
    const pnl = lastConfig.panels;
    afWanted = !!(pnl.levels || pnl.loudness || pnl.waveform);
    // marker storage location toggled -> write the current list to the new place
    if (wantSidecar() !== wasSidecar && qcList.length) persistMarkers(serializeMarkers());
    // the webview owns the scope config while it's open
    scopeCfg = iinfocfg.normalizeScope(lastConfig.settings.scope); tickScope();
  });

  onWin("iinfo-action", (a) => {
    if (!a || !a.type) return;
    runAction(a.type, a.value);
    // push a fresh frame right after an action so the UI updates immediately
    standaloneWindow.postMessage("iinfo-data", collect());
  });

  // A/B compare: the webview drives it, main.js just relays to the global entry.
  // "iinfo-gang" = a transport verb to fan out to both A and B; "iinfo-compare-cmd"
  // = assign / swap / offset / sync control.
  onWin("iinfo-gang", (cmd) => {
    lastContact = Date.now();
    if (G && cmd && cmd.action) { try { G.postMessage("iinfo/gang", cmd); } catch (e) {} }
  });
  onWin("iinfo-compare-cmd", (cmd) => {
    lastContact = Date.now();
    if (G && cmd && cmd.op) { try { G.postMessage("iinfo/compare-cmd", cmd); } catch (e) {} }
  });

  // QC markers: the web view is canonical while it's open — it hands us the whole
  // serialized list on every change and we write it straight to disk.
  onWin("iinfo-markers", (m) => {
    lastContact = Date.now();
    if (!m || typeof m.json !== "string") return;
    try {
      const p = JSON.parse(m.json);
      if (p && Array.isArray(p.events)) { qcList = p.events; if (p.media) qcMedia = p.media; }
    } catch (e) { /* still persist the raw body */ }
    persistMarkers(m.json);
  });

  // Export: write a report / CSV / JSON to the data dir (or a sidecar) and reveal it.
  onWin("iinfo-export", (m) => {
    lastContact = Date.now();
    if (!m || typeof m.content !== "string") return;
    try {
      let target;
      if (m.fmt === "sidecar") {
        target = sidecarPath();
        if (!target) { core.osd("IINfo: this media has no local file for a sidecar"); return; }
      } else {
        target = "@data/" + String(m.name || "iinfo-markers.json").replace(/[^\w.\-]+/g, "_");
      }
      file.write(target, m.content);
      try { file.showInFinder(target); } catch (e) {}
      core.osd("IINfo: exported");
    } catch (e) {
      console.log("IINfo: export — " + e);
      core.osd("IINfo: export failed");
    }
  });
}

/* ---- per-window geometry ------------------------------------------------
 * Window size + position live under their OWN preferences key, keyed by this
 * player's id — NOT in the shared "config" blob. Two inspectors open at once
 * (the A/B use case) each persisted to the same blob, so the last one to save
 * dictated both windows' next frame ("it moved on its own"). See DECISIONS
 * "Configuration ownership across windows". Falls back to a single shared
 * "default" slot when there is no global entry (so no player id) — which is
 * exactly the single-window case where sharing is harmless. */
let geomMap = null;
function playerKey() { return myId != null ? "p" + myId : "default"; }
function loadGeomMap() {
  if (geomMap) return geomMap;
  geomMap = {};
  try {
    const raw = preferences.get("geom");
    const p = raw ? JSON.parse(raw) : null;
    if (p && typeof p === "object") geomMap = p;
  } catch (e) { geomMap = {}; }
  // migrate geometry that used to live inside the shared config blob
  if (legacyWinCfg && !Object.keys(geomMap).length) {
    geomMap.default = legacyWinCfg;
    saveGeomMap();
  }
  return geomMap;
}
function saveGeomMap() {
  try { preferences.set("geom", JSON.stringify(geomMap)); preferences.sync(); } catch (e) {}
}
function saveGeom(g) {
  if (!g || !(g.w > 100 && g.h > 100)) return;
  loadGeomMap();
  geomMap[playerKey()] = {
    x: Math.round(g.x || 0), y: Math.round(g.y || 0),
    w: Math.round(g.w), h: Math.round(g.h),
  };
  saveGeomMap();
}
function myGeom() {
  const m = loadGeomMap();
  return m[playerKey()] || m.default || null;
}

// Restore the window's last size (always) and position (only if it still lands on
// a screen — the display setup may have changed). The webview reports geometry in
// DOM coords (origin = top-left of the primary screen, y down); setFrame wants
// Cocoa coords (origin = bottom-left of the primary screen, y up).
function restoreGeom() {
  const g = myGeom();
  if (!g || !(g.w > 200 && g.w < 6000 && g.h > 150 && g.h < 6000)) return;

  let screens = null;
  try { screens = core.window.screens; } catch (e) {}
  if (!Array.isArray(screens) || !screens.length) {
    try { standaloneWindow.setFrame(g.w, g.h); } catch (e) {}
    return;
  }
  const primary = screens.find((s) => s.frame && s.frame.x === 0 && s.frame.y === 0) || screens[0];
  const primaryH = primary.frame.height;
  const cocoaX = g.x;
  const cocoaY = primaryH - g.y - g.h;

  // require the window's title strip to sit on some screen
  const tx = cocoaX + g.w / 2, ty = cocoaY + g.h - 14;
  const onScreen = screens.some((s) => {
    const f = s.frame;
    return tx >= f.x - 6 && tx <= f.x + f.width + 6 && ty >= f.y - 6 && ty <= f.y + f.height + 6;
  });
  try {
    if (onScreen) standaloneWindow.setFrame(g.w, g.h, cocoaX, cocoaY);
    else standaloneWindow.setFrame(g.w, g.h);
  } catch (e) {}
}

// First-ever open (no saved geometry): a quarter of the screen wide, half tall,
// on whichever display the player window is on. IINA's screens[].frame is Cocoa
// (bottom-left origin, y up) — the same space setFrame() takes.
function defaultGeom() {
  let screens = null;
  try { screens = core.window.screens; } catch (e) {}
  if (!Array.isArray(screens) || !screens.length) {
    try { standaloneWindow.setFrame(520, 880); } catch (e) {}
    return;
  }
  const scr = screens.find((s) => s && s.current) ||
              screens.find((s) => s && s.main) || screens[0];
  const f = scr.frame;
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
  const w = clamp(f.width / 4, 400, f.width - 40);
  const h = clamp(f.height / 2, 480, f.height - 80);
  const x = Math.round(f.x + f.width - w - 24);   // tucked to the top-right of that screen
  const y = Math.round(f.y + f.height - h - 24);
  try { standaloneWindow.setFrame(w, h, x, y); }
  catch (e) { try { standaloneWindow.setFrame(w, h); } catch (e2) {} }
}

function openWindow() {
  try {
    standaloneWindow.loadFile("ui/inspector.html");
    webviewLoaded = true;
    wireMessages();   // loadFile() wiped the listeners — re-register them now
    standaloneWindow.setProperty({
      title: "IINfo",
      resizable: true,
      hideTitleBar: false,
      fullSizeContentView: false,
    });
    // Use the saved frame only if the user has actually shaped the window; a
    // frame still at (or near) the old hardcoded 520×880 default is treated as
    // "never customised" so the screen-relative default below takes over.
    const g = myGeom();
    const legacyish = g && Math.abs(g.w - 520) < 40 && Math.abs(g.h - 880) < 40;
    if (g && !legacyish) restoreGeom();
    else defaultGeom();
  } catch (e) {
    console.log("IINfo: window setup — " + e);
  }
  try { standaloneWindow.open(); }
  catch (e) { console.log("IINfo: standaloneWindow.open failed — " + e); core.osd("IINfo: could not open inspector window"); return; }
  wantWindow = true;
  lastContact = Date.now();
  console.log("IINfo: inspector opened");
}
function closeWindow() {
  wantWindow = false;
  teardownFilter(); // don't leave the metering filter running once the window is gone
  try { standaloneWindow.close(); } catch (e) {}
  // swap the live page (and its polling) out for a blank one
  try { standaloneWindow.loadFile("ui/blank.html"); webviewLoaded = false; } catch (e) {}
  console.log("IINfo: inspector closed");
}
function toggleWindow() {
  console.log("IINfo: toggle (wantWindow=" + wantWindow + ")");
  wantWindow ? closeWindow() : openWindow();
}

/* ------------------------------------------------------------------- wiring */

let legacyWinCfg = null;   // geometry that used to live in the shared blob (migrated below)
try {
  const saved = preferences.get("config");
  const parsed = saved ? JSON.parse(saved) : null;
  legacyWinCfg = iinfocfg.legacyWin(parsed);
  lastConfig = iinfocfg.normalize(parsed);   // one validator, shared with the web view
} catch (e) { lastConfig = iinfocfg.normalize(null); }
scopeCfg = iinfocfg.normalizeScope(lastConfig.settings.scope);

// every callback we hand to IINA (menu items, events, window messages) is pinned
// in PINS so JavaScriptCore's GC can't collect it — see the note above onMsg()
const PINS = [toggleWindow];
function pin(fn) { PINS.push(fn); return fn; }

// register the menu first and defensively — a later failure must never keep the
// "Toggle IINfo Inspector" item from appearing
try {
  menu.addItem(menu.item("Toggle IINfo Inspector", toggleWindow, { keyBinding: "Alt+Shift+i" }));
  menu.addItem(menu.separator());
  menu.addItem(menu.item("IINfo: Previous Frame", pin(() => { try { mpv.command("frame-back-step", []); } catch (e) {} }), { keyBinding: "Alt+Shift+LEFT" }));
  menu.addItem(menu.item("IINfo: Next Frame", pin(() => { try { mpv.command("frame-step", []); } catch (e) {} }), { keyBinding: "Alt+Shift+RIGHT" }));
  menu.addItem(menu.item("IINfo: Exact-Frame Screenshot", pin(() => { try { shotNow(); } catch (e) {} }), { keyBinding: "Alt+Shift+s" }));
  menu.addItem(menu.item("IINfo: Mark QC Issue", pin(markHere), { keyBinding: "Alt+Shift+m" }));
  menu.addItem(menu.item("IINfo: Cycle Video Scope", pin(cycleScope), { keyBinding: "Alt+Shift+w" }));
} catch (e) { console.log("IINfo: menu setup error — " + e); }

// bump the generation counter on any file / audio change. tickFilter() (run
// every poll) notices the new gen and reinstalls a fresh @iinfo instance, so
// ebur128's integration and astats stats never carry across clips. The webview
// also resets its waveform / meter / sparkline history when `gen` changes.
let lastAudioSig = "";
function on(ev, fn) { pin(fn); try { event.on(ev, fn); } catch (e) { console.log("IINfo: event.on(" + ev + ") failed — " + e); } }

on("iina.file-loaded", () => {
  alive = true;                        // mpv is provably up — recover from a parked state
  fileGen++;
  if (G) gHello();   // path / fps / duration may all have changed
  if (vcOn) gSend("iinfo/compare-cmd", { op: "vcompare", on: false });  // new content — drop the compare overlay
  maybeLoadMarkers();
  if (wantWindow) standaloneWindow.postMessage("iinfo-data", collect());
});
on("mpv.audio-params.changed", () => {
  if (!alive) return;
  const sig = JSON.stringify(native("audio-params") || {});
  if (sig !== lastAudioSig) { lastAudioSig = sig; fileGen++; }
  if (G) gHello();   // audio format may only now be known — refresh the A/B tech snapshot
});
// video-params often aren't ready at file-loaded; re-hello once they settle so the
// A/B technical-diff panel gets the real codec / pixfmt / colour data
let lastTechSig = "";
on("mpv.video-params.changed", () => {
  if (!G || !alive) return;
  const sig = JSON.stringify(native("video-params") || {}) + "|" + str("video-codec");
  if (sig === lastTechSig) return;
  lastTechSig = sig;
  gHello();
});
// end of file — this can also fire mid-shutdown, so touch nothing in mpv
on("mpv.end-file", () => { freshGen = -1; });

// a seek finished and a frame is on screen — grab any marker screenshot that was
// waiting on it (shotAtMarker seeks to the marked frame before capturing)
on("mpv.playback-restart", () => { if (shotPending) fireShotPending(); });
// mpv is going away: stop touching it FIRST, then persist (pure + file I/O only)
on("mpv.shutdown", () => { alive = false; try { flushMarkersNow(); } catch (e) {} });

/* ------------------------------------------------------- A/B compare (global)
 *
 * Register this window with the global entry so it can appear as an A/B
 * candidate, answer state requests, and run ganged transport. All no-ops when
 * there is no global entry (iina.global undefined).
 */
let myId = null;
let lastCompare = null;

function gMeta() {
  const fps = num("container-fps") || num("estimated-vf-fps");
  const vp = native("video-params") || {};
  const ap = native("audio-params") || {};
  const vct = native("current-tracks/video");
  return {
    path: str("path"), filename: str("filename"),
    w: vp.w || null, h: vp.h || null,
    fps: fps, duration: num("duration"),
    pos: num("time-pos"), frame: num("estimated-frame-number"), paused: flag("pause"),
    // per-file technical metadata for the A/B technical-diff panel
    tech: {
      container: str("file-format"),
      vcodec: str("video-codec"),
      vdecoder: vct ? (vct["decoder-desc"] || vct.codec) : null,
      w: vp.w || null, h: vp.h || null, dw: vp.dw || null, dh: vp.dh || null,
      par: vp.par != null ? vp.par : null,
      dar: vp["aspect-name"] || (vp.aspect != null ? vp.aspect : null),
      pixfmt: vp.pixelformat || null,
      range: vp.colorlevels || null,
      matrix: vp.colormatrix || null,
      primaries: vp.primaries || null,
      transfer: vp.gamma || null,
      sigPeak: vp["sig-peak"] != null ? vp["sig-peak"] : null,
      fps: fps,
      duration: num("duration"),
      frameCount: num("estimated-frame-count"),
      vbitrate: num("video-bitrate"),
      acodec: str("audio-codec-name") || str("audio-codec"),
      asr: ap["samplerate"] || num("audio-params/samplerate"),
      ach: ap["channel-count"] || num("audio-params/channel-count"),
      alayout: ap["hr-channels"] || ap["channels"] || null,
      afmt: ap["format"] || null,
      abitrate: num("audio-bitrate"),
    },
  };
}
function gSend(name, data) { if (!G) return; try { G.postMessage(name, data); } catch (e) {} }
function gHello() { gSend("iinfo/hello", gMeta()); }
function gBeat()  { gSend("iinfo/beat", { pos: num("time-pos"), frame: num("estimated-frame-number"), paused: flag("pause") }); }

/* ---- A/B visual compare: this window (when it is A) hosts the overlay ---- */
let vcOn = false;
const OV_PINS = [];
function onOv(name, fn) { OV_PINS.push(fn); try { overlay.onMessage(name, fn); } catch (e) {} }
function later(fn, ms) { if (typeof setTimeout === "function") setTimeout(fn, ms || 0); else fn(); }

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64(u8) {           // JavaScriptCore has no btoa
  let out = "", i = 0, n = u8.length;
  for (; i + 2 < n; i += 3) {
    const t = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64[(t >> 18) & 63] + B64[(t >> 12) & 63] + B64[(t >> 6) & 63] + B64[t & 63];
  }
  if (n - i === 1) { const t = u8[i] << 16; out += B64[(t >> 18) & 63] + B64[(t >> 12) & 63] + "=="; }
  else if (n - i === 2) { const t = (u8[i] << 16) | (u8[i + 1] << 8); out += B64[(t >> 18) & 63] + B64[(t >> 12) & 63] + B64[(t >> 6) & 63] + "="; }
  return out;
}
function readDataURI(pseudoPath) {
  try {
    if (file.exists(pseudoPath)) {
      const bytes = file.handle(pseudoPath, "read").readToEnd();
      if (bytes && bytes.length > 64) {
        const mime = /\.jpe?g$/i.test(pseudoPath) ? "image/jpeg" : "image/png";
        return "data:" + mime + ";base64," + b64(bytes);
      }
    }
  } catch (e) { /* not written yet */ }
  return null;
}
function wireOverlay() {
  OV_PINS.length = 0;
  onOv("iinfo-vc-ready", () => pushFrames());
  onOv("iinfo-vc-exit", () => gSend("iinfo/compare-cmd", { op: "vcompare", on: false }));
  onOv("iinfo-vc-refresh", () => gSend("iinfo/compare-cmd", { op: "vgrab-now" }));
}
function pushFrames(attempt) {
  attempt = attempt || 0;
  if (!vcOn) return;
  const a = readDataURI("@tmp/iinfo-vc-A.jpg");
  const bb = readDataURI("@tmp/iinfo-vc-B.jpg");
  if ((!a || !bb) && attempt < 5) { later(() => pushFrames(attempt + 1), 130); return; }
  if (!a && !bb) return;
  const vp = native("video-params") || {};
  try { overlay.postMessage("frames", { a: a, b: bb, wA: vp.w || null, hA: vp.h || null }); } catch (e) {}
}
function vcHideOverlay() { vcOn = false; try { overlay.hide(); } catch (e) {} }
function openVcOverlay(attempt) {
  if (!alive) return;
  try {
    overlay.loadFile("ui/vcompare.html");
    wireOverlay();
    overlay.setClickable(true);
    overlay.show();
    vcOn = true;
  } catch (e) {
    // the player window may not be ready yet — retry a couple of times
    console.log("IINfo: overlay open — " + e);
    if ((attempt || 0) < 3) later(() => openVcOverlay((attempt || 0) + 1), 350);
  }
}

if (G) {
  try {
    G.onMessage("iinfo/you-are", pin((d) => { if (d && d.id != null) myId = String(d.id); }));
    G.onMessage("iinfo/compare", pin((d) => { lastCompare = d && d.state ? d : null; }));
    G.onMessage("iinfo/gang-exec", pin((d) => {
      if (!d || !d.action || !alive) return;
      runAction(d.action, d.value);
      gBeat();   // report the new position so the global entry can align off it
    }));
    G.onMessage("iinfo/vcompare", pin((d) => {
      if (!alive) return;
      if (d && d.on) openVcOverlay(0);
      else vcHideOverlay();
    }));
    G.onMessage("iinfo/vgrab", pin((d) => {
      if (!alive || !d || !d.name) return;
      try {
        mpv.command("screenshot-to-file", [utils.resolvePath("@tmp/" + d.name), "video"]);
      } catch (e) { console.log("IINfo: screenshot-to-file — " + e); }
      later(() => gSend("iinfo/vgrabbed", { slot: d.slot }), 180);
    }));
    G.onMessage("iinfo/vready", pin(() => { pushFrames(); }));
    console.log("IINfo: A/B compare wired to global entry");
  } catch (e) { console.log("IINfo: global wiring — " + e); }

  // defer the first hello: if it lands synchronously during this player's own
  // plugin init, the global entry's reply postMessage trips a force-unwrap in
  // IINA and traps the process
  if (typeof setTimeout === "function") setTimeout(gHello, 0); else gHello();

  let beatTimer = setInterval(() => { if (alive) gBeat(); }, 2000);
  const goodbye = () => {
    // mpv (or the whole player) is being torn down. Native crashes here aren't
    // catchable, and IINA has been seen delivering an mpv event to a plugin
    // listener AFTER freeing the handle — so kill every mpv path FIRST, then do
    // only pure / file-I/O work.
    alive = false;
    try { clearInterval(beatTimer); } catch (e) {}
    try { flushMarkersNow(); } catch (e) {}
    try { vcHideOverlay(); } catch (e) {}
    gSend("iinfo/bye", {});
  };
  on("mpv.shutdown", goodbye);
  on("iina.window-did-close", goodbye);
}
on("iina.window-will-close", () => {
  // Earliest teardown signal — every observed session has `Player has shutdown`
  // within a few seconds. Native crashes aren't catchable and IINA can still
  // deliver an mpv event (end-file / *-params.changed) to a plugin listener
  // while the handle is being freed, so from here on touch NOTHING in mpv: flip
  // `alive` first, before any read/command. `iina.file-loaded` / `iinfo-ready`
  // flip it back if this was only a transient teardown, and tickFilter() /
  // tickScope() then reinstate the filters. `wantWindow` is left alone.
  alive = false;
  afActive = false; armedGen = -1;
  console.log("IINfo: window-will-close (wantWindow left " + wantWindow + ")");
});

// watchdog: if the webview has gone quiet for a while (occluded and throttled by
// WebKit, or crashed) stop touching the audio chain — but DON'T clear wantWindow,
// so the moment polls resume tickFilter() puts the filter back on its own.
setInterval(() => {
  try {
    if (alive && wantWindow && afActive && lastContact && Date.now() - lastContact > 8000) {
      teardownFilter();
      console.log("IINfo: webview quiet — filter parked");
    }
    // the scope's consumer is the video, not the webview — keep it reconciled
    // even when the inspector is closed (so ⌥⇧W works fullscreen). Also mop up a
    // stray @iinfo that mpv's watch-later may have restored on this file (only
    // wanted while the inspector polls).
    if (alive && !wantWindow) {
      tickScope();
      if (filterPresent()) tryRemove();
    }
  } catch (e) {}
}, 1000);

console.log("IINfo: main entry ready — Plugin menu ▸ Toggle IINfo Inspector (⌥⇧I)");
