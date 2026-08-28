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

const { console, core, event, mpv, menu, standaloneWindow, preferences } = iina;

console.log("IINfo: main entry loading (v0.1.7)");

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

/* ------------------------------------------------------------------ helpers */

function num(name) {
  try { const v = mpv.getNumber(name); return typeof v === "number" && isFinite(v) ? v : null; }
  catch (e) { return null; }
}
function str(name) {
  try { const v = mpv.getString(name); return v == null || v === "" ? null : v; }
  catch (e) { return null; }
}
function flag(name) {
  try { const v = mpv.getFlag(name); return typeof v === "boolean" ? v : null; }
  catch (e) { return null; }
}
function native(name) {
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
  try { mpv.command("af", ["remove", "@" + AF_LABEL]); } catch (e) {}
}
function tryAdd() {
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
  };
}

/* ------------------------------------------------------------ window setup */

function setupWindow() {
  try {
    standaloneWindow.loadFile("ui/inspector.html");
    standaloneWindow.setProperty({
      title: "IINfo",
      resizable: true,
      hideTitleBar: false,
      fullSizeContentView: false,
    });
    standaloneWindow.setFrame(440, 780);
  } catch (e) {
    console.log("IINfo: window setup warning — " + e);
  }

  // loadFile() runs the webview headless — it polls and exchanges config even
  // before open() is ever called, and IINA reports the webview "hidden" whenever
  // its window isn't frontmost. So NOTHING the webview says changes `wantWindow`
  // — only the user opening (openWindow) or closing it (closeWindow / red button)
  // does. `wantWindow` is pure user intent and survives losing focus, playback
  // ending, and jumping between files.
  standaloneWindow.onMessage("iinfo-ready", () => {
    lastContact = Date.now();
    standaloneWindow.postMessage("iinfo-config", { config: lastConfig });
    standaloneWindow.postMessage("iinfo-active", { active: wantWindow });
    standaloneWindow.postMessage("iinfo-data", collect());
  });

  standaloneWindow.onMessage("iinfo-poll", () => {
    lastContact = Date.now();
    standaloneWindow.postMessage("iinfo-data", collect());
  });

  // sent from pagehide — the window was actually closed (red title-bar button)
  standaloneWindow.onMessage("iinfo-closing", () => {
    if (!wantWindow) return;
    wantWindow = false;
    teardownFilter();
    console.log("IINfo: inspector closed (from window)");
  });

  standaloneWindow.onMessage("iinfo-config", (cfg) => {
    lastConfig = cfg;
    // preferences.set alone only persists to disk when a prefs page closes —
    // sync() forces the flush so panel visibility + display settings survive a restart
    try { preferences.set("config", JSON.stringify(cfg)); preferences.sync(); } catch (e) {}
    // enable metering whenever an audio panel wants it
    const pnl = (cfg && cfg.panels) || {};
    afWanted = !!(pnl.levels || pnl.loudness || pnl.waveform);
  });

  standaloneWindow.onMessage("iinfo-action", (a) => {
    if (!a || !a.type) return;
    const fr = () => num("container-fps") || num("estimated-vf-fps");
    try {
      switch (a.type) {
        case "frame-next":     mpv.command("frame-step", []); break;
        case "frame-prev":     mpv.command("frame-back-step", []); break;
        case "frame-jump": {
          const n = Math.round(a.value || 0), f = num("estimated-frame-number"), rate = fr();
          if (n === 0) break;
          if (f != null && rate) core.seekTo((Math.max(0, f + n) + 0.5) / rate);
          else if (rate) core.seek(n / rate, true);
          break;
        }
        case "seek-frame-abs": {
          const rate = fr();
          if (typeof a.value === "number" && rate) core.seekTo((Math.max(0, a.value) + 0.5) / rate);
          break;
        }
        case "toggle-pause":   flag("pause") ? core.resume() : core.pause(); break;
        case "screenshot":     mpv.command("screenshot", ["video"]); core.osd("IINfo: exact-frame screenshot saved"); break;
        case "seek-abs":       if (typeof a.value === "number") core.seekTo(a.value); break;
        case "seek-rel":       if (typeof a.value === "number") core.seek(a.value, false); break;
        case "nudge":          if (typeof a.value === "number") core.seek(a.value, true); break;
        case "seek-start":     core.seekTo(0); break;
        case "seek-end":       { const d = num("duration"); if (d) core.seekTo(Math.max(0, d - 0.05)); break; }
        case "mute":           mpv.command("cycle", ["mute"]); break;
        case "speed-mult":     if (typeof a.value === "number") mpv.command("multiply", ["speed", String(a.value)]); break;
      }
    } catch (e) { console.log("IINfo action error: " + e); }
    // push a fresh frame right after an action so the UI updates immediately
    standaloneWindow.postMessage("iinfo-data", collect());
  });
}

function openWindow() {
  try { standaloneWindow.open(); }
  catch (e) { console.log("IINfo: standaloneWindow.open failed — " + e); core.osd("IINfo: could not open inspector window"); return; }
  wantWindow = true;
  lastContact = Date.now();   // grace period until the webview starts polling
  try { standaloneWindow.postMessage("iinfo-active", { active: true }); } catch (e) {}
  console.log("IINfo: inspector opened");
}
function closeWindow() {
  try { standaloneWindow.close(); } catch (e) {}
  wantWindow = false;
  teardownFilter(); // don't leave the analysis filter running once the window is gone
  try { standaloneWindow.postMessage("iinfo-active", { active: false }); } catch (e) {}
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

try { setupWindow(); } catch (e) { console.log("IINfo: setupWindow error — " + e); }

// register the menu first and defensively — a later failure must never keep the
// "Toggle IINfo Inspector" item from appearing
try {
  menu.addItem(menu.item("Toggle IINfo Inspector", toggleWindow, { keyBinding: "Alt+Shift+i" }));
  menu.addItem(menu.separator());
  menu.addItem(menu.item("IINfo: Previous Frame", () => { try { mpv.command("frame-back-step", []); } catch (e) {} }, { keyBinding: "Alt+Shift+LEFT" }));
  menu.addItem(menu.item("IINfo: Next Frame", () => { try { mpv.command("frame-step", []); } catch (e) {} }, { keyBinding: "Alt+Shift+RIGHT" }));
  menu.addItem(menu.item("IINfo: Exact-Frame Screenshot", () => { try { mpv.command("screenshot", ["video"]); core.osd("IINfo: screenshot saved"); } catch (e) {} }, { keyBinding: "Alt+Shift+s" }));
} catch (e) { console.log("IINfo: menu setup error — " + e); }

// bump the generation counter on any file / audio change. tickFilter() (run
// every poll) notices the new gen and reinstalls a fresh @iinfo instance, so
// ebur128's integration and astats stats never carry across clips. The webview
// also resets its waveform / meter / sparkline history when `gen` changes.
let lastAudioSig = "";
function on(ev, fn) { try { event.on(ev, fn); } catch (e) { console.log("IINfo: event.on(" + ev + ") failed — " + e); } }

on("iina.file-loaded", () => {
  fileGen++;
  if (wantWindow) standaloneWindow.postMessage("iinfo-data", collect());
});
on("mpv.audio-params.changed", () => {
  const sig = JSON.stringify(native("audio-params") || {});
  if (sig !== lastAudioSig) { lastAudioSig = sig; fileGen++; }
});
on("mpv.end-file", () => { freshGen = -1; });
on("iina.window-will-close", () => {
  // the player window is going away — the plugin instance goes with it
  wantWindow = false;
  if (filterPresent()) tryRemove();
});

// watchdog: if the webview has gone quiet for a while (occluded and throttled by
// WebKit, or crashed) stop touching the audio chain — but DON'T clear wantWindow,
// so the moment polls resume tickFilter() puts the filter back on its own.
setInterval(() => {
  try {
    if (wantWindow && afActive && lastContact && Date.now() - lastContact > 4000) {
      teardownFilter();
      console.log("IINfo: webview quiet — filter parked");
    }
  } catch (e) {}
}, 1000);

console.log("IINfo: main entry ready — Plugin menu ▸ Toggle IINfo Inspector (⌥⇧I)");
