/*
 * IINfo — QC event model.
 *
 * Pure data logic: no DOM, no `iina`, no I/O. Loaded as a plain <script> in the
 * inspector web view (exposes window.QCEvents) and require()d by node --test
 * (module.exports). This is the ONE source of truth for the QC event shape and
 * operations — manual markers are the first producer; audio / video / freeze /
 * A-B-difference analysers will feed create() with a different `source` later.
 *
 * main.js has a tiny standalone-capture helper (markHere) that must emit the
 * same shape create() does — keep them in step; test/events.test.js pins the
 * schema.
 */
(function (root) {
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

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.QCEvents = API;
})(typeof self !== "undefined" ? self : this);
