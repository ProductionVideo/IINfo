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
 */

const { console, core, event, mpv, menu, standaloneWindow, preferences, file } = iina;

console.log("IINfo: main entry loading (v0.3.0)");

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
      case "screenshot":     mpv.command("screenshot", ["video"]); core.osd("IINfo: exact-frame screenshot saved"); break;
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

function serializeMarkers() {
  const events = qcList.slice().sort((a, b) => (a.tMs - b.tMs) || ((a.ts || 0) - (b.ts || 0)));
  return JSON.stringify({
    iinfo: "qc-markers", version: 1,
    media: qcMedia || null,
    saved: new Date().toISOString(),
    events: events,
  }, null, 2);
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
  if (wantWindow) { try { standaloneWindow.postMessage("iinfo-data", collect()); } catch (e) {} }
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
// Emits the same shape ui/events.js create() does; the web view does the rest.
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
  const ev = {
    id: "qc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    source: "manual", type: "marker",
    tMs: Math.max(0, Math.round(t * 1000)),
    frame: frame != null ? Math.round(frame) : null,
    fps: fps || null,
    tc: tc && tc.indexOf("-") < 0 ? tc : null,
    durMs: null, category: "Other", severity: "warning", note: "",
    resolved: false, ts: Date.now(), ref: null,
    meta: paired ? { abActive: !!cmp.linked, aId: String(cmp.aId), bId: String(cmp.bId) } : {},
  };
  if (!qcMedia) qcMedia = qcIdentity();
  qcList = qcList.concat([ev]);
  qcGen++;
  persistMarkers(serializeMarkers());
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
    lastContact = Date.now();
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
    lastConfig = cfg;
    // preferences.set alone only persists to disk when a prefs page closes —
    // sync() forces the flush so panel visibility + display settings survive a restart
    try { preferences.set("config", JSON.stringify(cfg)); preferences.sync(); } catch (e) {}
    // enable metering whenever an audio panel wants it
    const pnl = (cfg && cfg.panels) || {};
    afWanted = !!(pnl.levels || pnl.loudness || pnl.waveform);
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

// Restore the window's last size (always) and position (only if it still lands on
// a screen — the display setup may have changed). The webview reports geometry in
// DOM coords (origin = top-left of the primary screen, y down); setFrame wants
// Cocoa coords (origin = bottom-left of the primary screen, y up).
function restoreGeom() {
  const g = lastConfig && lastConfig.win;
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
    if (lastConfig && lastConfig.win) restoreGeom();
    else standaloneWindow.setFrame(520, 880);
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
  teardownFilter(); // don't leave the analysis filter running once the window is gone
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

try {
  const saved = preferences.get("config");
  if (saved) lastConfig = JSON.parse(saved);
} catch (e) { lastConfig = null; }

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
  menu.addItem(menu.item("IINfo: Exact-Frame Screenshot", pin(() => { try { mpv.command("screenshot", ["video"]); core.osd("IINfo: screenshot saved"); } catch (e) {} }), { keyBinding: "Alt+Shift+s" }));
  menu.addItem(menu.item("IINfo: Mark QC Issue", pin(markHere), { keyBinding: "Alt+Shift+m" }));
} catch (e) { console.log("IINfo: menu setup error — " + e); }

// bump the generation counter on any file / audio change. tickFilter() (run
// every poll) notices the new gen and reinstalls a fresh @iinfo instance, so
// ebur128's integration and astats stats never carry across clips. The webview
// also resets its waveform / meter / sparkline history when `gen` changes.
let lastAudioSig = "";
function on(ev, fn) { pin(fn); try { event.on(ev, fn); } catch (e) { console.log("IINfo: event.on(" + ev + ") failed — " + e); } }

on("iina.file-loaded", () => {
  fileGen++;
  if (G) gHello();   // path / fps / duration may all have changed
  maybeLoadMarkers();
  if (wantWindow) standaloneWindow.postMessage("iinfo-data", collect());
});
on("mpv.audio-params.changed", () => {
  const sig = JSON.stringify(native("audio-params") || {});
  if (sig !== lastAudioSig) { lastAudioSig = sig; fileGen++; }
});
on("mpv.end-file", () => { freshGen = -1; });
on("mpv.shutdown", () => { try { flushMarkersNow(); } catch (e) {} });

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
  return {
    path: str("path"), filename: str("filename"),
    w: vp.w || null, h: vp.h || null,
    fps: fps, duration: num("duration"),
    pos: num("time-pos"), frame: num("estimated-frame-number"), paused: flag("pause"),
  };
}
function gSend(name, data) { if (!G) return; try { G.postMessage(name, data); } catch (e) {} }
function gHello() { gSend("iinfo/hello", gMeta()); }
function gBeat()  { gSend("iinfo/beat", { pos: num("time-pos"), frame: num("estimated-frame-number"), paused: flag("pause") }); }

if (G) {
  try {
    G.onMessage("iinfo/you-are", pin((d) => { if (d && d.id != null) myId = String(d.id); }));
    G.onMessage("iinfo/compare", pin((d) => { lastCompare = d && d.state ? d : null; }));
    G.onMessage("iinfo/gang-exec", pin((d) => {
      if (!d || !d.action || !alive) return;
      runAction(d.action, d.value);
      gBeat();   // report the new position so the global entry can align off it
    }));
    console.log("IINfo: A/B compare wired to global entry");
  } catch (e) { console.log("IINfo: global wiring — " + e); }

  // defer the first hello: if it lands synchronously during this player's own
  // plugin init, the global entry's reply postMessage trips a force-unwrap in
  // IINA and traps the process
  if (typeof setTimeout === "function") setTimeout(gHello, 0); else gHello();

  let beatTimer = setInterval(() => { if (alive) gBeat(); }, 2000);
  const goodbye = () => {
    try { flushMarkersNow(); } catch (e) {}
    alive = false;                       // stop every mpv read from here on
    try { clearInterval(beatTimer); } catch (e) {}
    gSend("iinfo/bye", {});
  };
  on("mpv.shutdown", goodbye);
  on("iina.window-did-close", goodbye);
}
on("iina.window-will-close", () => {
  // This also fires on transient player-window teardown (playback stops, some
  // file jumps) where the inspector is still open — so do NOT clear wantWindow
  // here or metering dies until the user re-toggles. Just release the filter;
  // tickFilter() re-arms it on the next poll if the window is still up. The
  // red-title-bar-button case is handled by the `iinfo-closing` message instead.
  if (filterPresent()) tryRemove();
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
  } catch (e) {}
}, 1000);

console.log("IINfo: main entry ready — Plugin menu ▸ Toggle IINfo Inspector (⌥⇧I)");
