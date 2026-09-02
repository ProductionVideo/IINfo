/*
 * IINfo — canonical plugin configuration.
 *
 * Pure data logic: no DOM, no `iina`, no I/O. This is the ONE source of truth for
 * every persisted setting, its default, its accepted values and the migration
 * from older stored shapes. Both sides of the plugin consume it:
 *
 *   - the web view loads it as a plain <script> (window.IINfoConfig)
 *   - node --test require()s it (module.exports)
 *   - main.js inlines the `var IINfoConfig = (function () { … })();` block
 *     verbatim (IINA's require() can't be trusted to return module.exports),
 *     guarded by test/config-inline.test.js
 *
 * Before this module the panel + scope defaults were copied into seven places
 * and validated by two different code paths that had drifted apart. Add a
 * setting HERE and nowhere else.
 *
 * Window geometry is deliberately NOT part of this blob — it is per-window state
 * and lives under its own preferences key (see DECISIONS "Configuration
 * ownership across windows").
 */
var IINfoConfig = (function () {
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
      markerSidecar: false, drawerTab: "panels", abtechDiffOnly: false,
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

if (typeof module !== "undefined" && module.exports) module.exports = IINfoConfig;
else if (typeof window !== "undefined") window.IINfoConfig = IINfoConfig;
