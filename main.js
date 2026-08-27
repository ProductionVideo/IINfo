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

const AF_LABEL = "iinfo";
// asetnsamples forces a predictable ~21 ms analysis window (1024 @ 48k) regardless
// of codec frame size, so the scrolling waveform advances at a steady rate.
// astats (reset=1) -> per-window min/max/RMS/peak for the meters + waveform envelope.
// ebur128 -> momentary / short-term / integrated loudness + true peak.
const AF_GRAPH =
  "@" + AF_LABEL +
  ":lavfi=[asetnsamples=n=1024:p=0,astats=metadata=1:reset=1,ebur128=metadata=1:peak=true]";

let winOpen = false;
let afActive = false;      // is our audio filter currently in the chain?
let afWanted = false;      // does the webview want metering right now?
let lastConfig = null;     // last config object received from the webview (for persistence)
let lastContact = 0;       // Date.now() of the last message from the webview

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

/* ------------------------------------------------------------ audio filter */

function filterPresent() {
  const list = native("af");
  if (!Array.isArray(list)) return false;
  return list.some((f) => f && f.label === AF_LABEL);
}

function ensureAudioFilter(want) {
  afWanted = want;
  const present = filterPresent();
  if (want && !present) {
    try {
      mpv.command("af", ["add", AF_GRAPH]);
      afActive = true;
      console.log("IINfo: metering filter added");
    } catch (e) {
      console.log("IINfo: failed to add metering filter — " + e);
    }
  } else if (!want && present) {
    try { mpv.command("af", ["remove", "@" + AF_LABEL]); } catch (e) {}
    afActive = false;
    console.log("IINfo: metering filter removed");
  } else {
    afActive = present;
  }
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

  const vp = native("video-params") || {};
  const ap = native("audio-params") || {};
  const fi = native("video-frame-info") || {};
  const afMeta = afActive ? (native("af-metadata/" + AF_LABEL) || {}) : {};

  const cacheState = native("demuxer-cache-state") || {};

  return {
    now: Date.now(),

    /* transport / header */
    file: {
      name: str("filename"),
      path: str("path"),
      format: str("file-format"),
      size: num("file-size"),
      paused: flag("pause"),
      speed: num("speed"),
      eofReached: flag("eof-reached"),
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
      pixelformat: vp.pixelformat, hwPixelformat: vp["hw-pixelformat"],
      avgBpp: vp["average-bpp"],
      colormatrix: vp.colormatrix, colorlevels: vp.colorlevels,
      primaries: vp.primaries, gamma: vp.gamma,
      sigPeak: vp["sig-peak"], light: vp.light,
      chromaLocation: vp["chroma-location"],
      rotate: vp.rotate, stereoIn: vp["stereo-in"], alpha: vp.alpha,
      codec: str("video-codec"),
      format: str("video-format"),
      decoder: (function () {
        const ct = native("current-tracks/video"); return ct ? (ct["decoder-desc"] || ct.codec) : null;
      })(),
      hwdec: str("hwdec-current"),
      hwdecInterop: str("hwdec-interop"),
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
      totalBitrate: num("packet-video-bitrate") != null || num("packet-audio-bitrate") != null
        ? (num("packet-video-bitrate") || 0) + (num("packet-audio-bitrate") || 0)
        : null,
    },

    /* metering (only populated while @iinfo filter is active) */
    meter: {
      active: afActive,
      wanted: afWanted,
      raw: afMeta,
    },
  };
}

/* ------------------------------------------------------------ window setup */

function setupWindow() {
  standaloneWindow.loadFile("ui/inspector.html");
  standaloneWindow.setProperty({
    title: "IINfo — QC Inspector",
    resizable: true,
    hideTitleBar: false,
    fullSizeContentView: false,
  });
  standaloneWindow.setFrame(420, 720);

  standaloneWindow.onMessage("iinfo-ready", () => {
    // webview mounted — restore its saved config, then it starts polling
    lastContact = Date.now();
    standaloneWindow.postMessage("iinfo-config", { config: lastConfig });
    standaloneWindow.postMessage("iinfo-data", collect());
  });

  standaloneWindow.onMessage("iinfo-poll", () => {
    lastContact = Date.now();
    standaloneWindow.postMessage("iinfo-data", collect());
  });

  // the webview sends this from `pagehide` when the window is closed by the user
  standaloneWindow.onMessage("iinfo-closing", () => {
    winOpen = false;
    ensureAudioFilter(false);
  });

  standaloneWindow.onMessage("iinfo-config", (cfg) => {
    lastConfig = cfg;
    try { preferences.set("config", JSON.stringify(cfg)); } catch (e) {}
    // toggle the analysis filter based on whether an audio panel needs it
    const pnl = (cfg && cfg.panels) || {};
    ensureAudioFilter(!!(pnl.levels || pnl.loudness || pnl.waveform));
  });

  standaloneWindow.onMessage("iinfo-action", (a) => {
    if (!a || !a.type) return;
    try {
      switch (a.type) {
        case "frame-next":     mpv.command("frame-step", []); break;
        case "frame-prev":     mpv.command("frame-back-step", []); break;
        case "toggle-pause":   flag("pause") ? core.resume() : core.pause(); break;
        case "screenshot":     mpv.command("screenshot", ["video"]); core.osd("IINfo: exact-frame screenshot saved"); break;
        case "seek-abs":       if (typeof a.value === "number") core.seekTo(a.value); break;
        case "nudge":          if (typeof a.value === "number") core.seek(a.value, true); break;
        case "seek-start":     core.seekTo(0); break;
        case "seek-end":       { const d = num("duration"); if (d) core.seekTo(Math.max(0, d - 0.05)); break; }
      }
    } catch (e) { console.log("IINfo action error: " + e); }
    // push a fresh frame right after an action so the UI updates immediately
    standaloneWindow.postMessage("iinfo-data", collect());
  });
}

function openWindow() {
  standaloneWindow.open();
  winOpen = true;
  lastContact = Date.now();   // grace period until the webview starts polling
}
function closeWindow() {
  standaloneWindow.close();
  winOpen = false;
  ensureAudioFilter(false); // don't leave the filter running once the window is gone
}
function toggleWindow() {
  winOpen ? closeWindow() : openWindow();
}

/* ------------------------------------------------------------------- wiring */

try {
  const saved = preferences.get("config");
  if (saved) lastConfig = JSON.parse(saved);
} catch (e) { lastConfig = null; }

setupWindow();

menu.addItem(menu.item("Toggle IINfo Inspector", toggleWindow, { keyBinding: "Alt+Shift+i" }));
menu.addItem(menu.separator());
menu.addItem(menu.item("IINfo: Previous Frame", () => { try { mpv.command("frame-back-step", []); } catch (e) {} }, { keyBinding: "Alt+Shift+LEFT" }));
menu.addItem(menu.item("IINfo: Next Frame", () => { try { mpv.command("frame-step", []); } catch (e) {} }, { keyBinding: "Alt+Shift+RIGHT" }));
menu.addItem(menu.item("IINfo: Exact-Frame Screenshot", () => { try { mpv.command("screenshot", ["video"]); core.osd("IINfo: screenshot saved"); } catch (e) {} }, { keyBinding: "Alt+Shift+s" }));

// re-sync the metering filter on file change (mpv usually keeps runtime af
// across files, but a manual af-clr elsewhere would drop it)
event.on("iina.file-loaded", () => {
  if (winOpen) ensureAudioFilter(afWanted);
  if (winOpen) standaloneWindow.postMessage("iinfo-data", collect());
});

event.on("iina.window-will-close", () => {
  ensureAudioFilter(false);
});

// watchdog: if the webview has gone quiet (window closed by any means, or crashed)
// stop believing it is open and drop the analysis filter so audio is untouched
setInterval(() => {
  if (winOpen && lastContact && Date.now() - lastContact > 2500) {
    winOpen = false;
    ensureAudioFilter(false);
  }
}, 1000);

console.log("IINfo loaded — Plugin menu ▸ Toggle IINfo Inspector (⌥⇧I)");
