"use strict";
// Deep QC panel: experimental gating, user-started pass (never armed by panel
// visibility), badge / readout, threshold controls -> config, Automatic marker
// filter + hollow auto ticks, Stop, Clear automatic events.
const assert = require("node:assert/strict");
const H = require("./_harness");

const shim = `
window.__errors = [];
window.addEventListener("error", e => window.__errors.push(String(e.message || e.error)));
window.iina = (function () {
  var H = {};
  var markers = [
    { id: "m1", source: "manual", type: "marker", tMs: 2000, frame: 50, fps: 25, tc: "00:00:02:00", durMs: null, category: "Other", severity: "warning", note: "hi", resolved: false, ts: 1, meta: {} },
    { id: "a1", source: "video", type: "black-frame", tMs: 8000, frame: 200, fps: 25, tc: "00:00:08:00", durMs: 1200, category: "Video", severity: "error", note: "black frames (1.2s)", resolved: false, ts: 2, meta: { auto: true } },
    { id: "a2", source: "signalstats", type: "range-error", tMs: 12000, frame: 300, fps: 25, tc: "00:00:12:00", durMs: 2000, category: "Colour", severity: "warning", note: "broadcast-range violation (BRNG 20.0%)", resolved: false, ts: 3, meta: { auto: true } }
  ];
  function data() {
    return {
      now: Date.now(),
      file: { gen: 0, name: "a.mov", path: "/w/a.mov", format: "mov", size: 1e8, paused: true, speed: 1 },
      time: { pos: 5, duration: 120, remaining: 115, percent: 4, fps: 25, fpsSource: "container", frame: 125, frameCount: 3000, dropFrame: false, timecode: "00:00:05:00", timecodeNDF: "00:00:05:00" },
      frameInfo: { pictureType: "I", raw: {} },
      video: { w: 1920, h: 1080, dw: 1920, dh: 1080, par: 1, pixelformat: "yuv420p", codec: "h264" },
      audio: { sampleRate: 48000, channelCount: 2 },
      perf: { avsync: 0.001, decDrop: 0, voDrop: 0 },
      meter: { active: false, wanted: false, fresh: false, error: "", raw: {} },
      compare: null,
      markers: { list: markers, media: { filename: "a.mov" }, gen: 1 },
      scope: { cfg: { type: "off" }, active: false, error: "" },
      deepqc: { running: window.__running, active: window.__running, error: "",
                session: markers.filter(m => m.source !== "manual").length,
                stats: window.__running ? { yMin: 16, yMax: 235, yAvg: 118, brng: 0.002, tout: 0.01, vrep: 0 } : null }
    };
  }
  window.__running = false;
  return {
    postMessage: function (n, p) {
      if (n === "iinfo-ready") setTimeout(function () { (H["iinfo-config"]||[]).forEach(f=>f({config:{ settings: { experimental: true } }})); (H["iinfo-data"]||[]).forEach(f=>f(data())); }, 5);
      if (n === "iinfo-poll") (H["iinfo-data"]||[]).forEach(f=>f(data()));
      if (n === "iinfo-config") { window.__cfg = p; }
      if (n === "iinfo-markers") { window.__lastPush = p; try { markers = JSON.parse(p.json).events; } catch (e) {} }
      if (n === "iinfo-deepqc") { window.__running = p && p.op === "start"; (H["iinfo-data"]||[]).forEach(f=>f(data())); }
    },
    onMessage: function (n, cb) { (H[n] = H[n] || []).push(cb); window.__H = H; }
  };
})();
`;

const driver = `
setTimeout(function () {
  try {
    var out = { errors: window.__errors, steps: [] };
    function all(s){ return [].slice.call(document.querySelectorAll(s)); }
    var box = all("#drawer label").find(l => /Deep QC/.test(l.textContent));
    out.steps.push("drawerToggleVisibleWithExperimental:" + !!box);
    var cb = box.querySelector("input"); cb.checked = true; cb.dispatchEvent(new Event("change"));
    window.iina.postMessage("iinfo-poll");
    var xp = all("#drawer .set-row").find(r => /Experimental/.test(r.textContent)).querySelector("input");
    xp.checked = false; xp.dispatchEvent(new Event("change"));
    out.steps.push("drawerToggleGoneWhenExperimentalOff:" + !all("#drawer label").some(l => /Deep QC/.test(l.textContent)));
    xp.checked = true; xp.dispatchEvent(new Event("change"));
    all("#drawer label").find(l => /Deep QC/.test(l.textContent)).querySelector("input").checked = true;
    all("#drawer label").find(l => /Deep QC/.test(l.textContent)).querySelector("input").dispatchEvent(new Event("change"));
    window.iina.postMessage("iinfo-poll");
    var panel = all(".panel").find(p => /Deep QC/.test((p.querySelector("h2 span")||{}).textContent||""));
    out.steps.push("panelPresent:" + !!panel);
    out.steps.push("notRunningYet:" + (window.__running === false));
    panel.querySelector(".deepqc-run").click();
    window.iina.postMessage("iinfo-poll");
    out.steps.push("runningAfterStart:" + window.__running);
    out.steps.push("runBtnLabelRunning:" + panel.querySelector(".deepqc-run").textContent);
    out.steps.push("readout:" + panel.querySelector(".deepqc-read").textContent.trim());
    var offBtn = all(".panel .scope-row .btn").find(b => b.textContent === "Off" && /Broadcast range/.test(b.parentElement.textContent));
    offBtn.click();
    out.steps.push("rangeCfg:" + (window.__cfg.settings.deepqc && window.__cfg.settings.deepqc.range));
    var fchk = all(".deepqc-check").find(l => /Freeze/.test(l.textContent)).querySelector("input");
    fchk.checked = false; fchk.dispatchEvent(new Event("change"));
    out.steps.push("freezeCfg:" + window.__cfg.settings.deepqc.freeze);
    var mp = all(".panel").find(p => /QC Markers/.test((p.querySelector("h2 span")||{}).textContent||""));
    var sel = mp.querySelector(".qc-filter");
    sel.value = "Automatic"; sel.dispatchEvent(new Event("change"));
    var rows = mp.querySelectorAll(".qc-list .qc-row");
    out.steps.push("autoRowCount:" + rows.length);
    out.steps.push("autoRowHasEdit:" + /edit/.test(rows[0].querySelector(".qc-tools").textContent));
    out.steps.push("autoTicks:" + all(".scrub-mark.auto").length + "/" + all(".scrub-mark").length);
    panel.querySelector(".deepqc-run").click();
    window.iina.postMessage("iinfo-poll");
    out.steps.push("runningAfterStop:" + window.__running);
    var clr = all(".panel .qc-bar .btn").find(b => /Clear/.test(b.textContent));
    clr.click();
    window.iina.postMessage("iinfo-poll");
    out.steps.push("afterClearPush:" + (window.__lastPush && JSON.parse(window.__lastPush.json).events.length));
    document.title = "RESULT " + JSON.stringify(out);
  } catch (e) { document.title = "RESULT " + JSON.stringify({ fatal: String(e && e.stack || e), errors: window.__errors }); }
}, 700);
`;

function run(chrome) {
  const res = H.render(chrome, "deepqc", H.inlineInspector(shim, driver), 3500);
  const S = (k) => (res.steps.find((s) => s.indexOf(k + ":") === 0) || "").slice(k.length + 1);
  assert.equal(S("drawerToggleVisibleWithExperimental"), "true");
  assert.equal(S("drawerToggleGoneWhenExperimentalOff"), "true", "Deep QC must hide when experimental is off");
  assert.equal(S("panelPresent"), "true");
  assert.equal(S("notRunningYet"), "true", "the filter must NOT arm just because the panel is open");
  assert.equal(S("runningAfterStart"), "true", "Start must arm the pass");
  assert.equal(S("rangeCfg"), "off", "Range=Off must reach config");
  assert.equal(S("freezeCfg"), "false", "Freeze toggle must reach config");
  assert.equal(S("autoRowCount"), "2", "two automatic events");
  assert.equal(S("autoRowHasEdit"), "false", "automatic rows have no note editor");
  assert.equal(S("autoTicks"), "2/2", "automatic ticks render hollow");
  assert.equal(S("runningAfterStop"), "false", "Stop must disarm");
  assert.equal(S("afterClearPush"), "1", "Clear automatic events keeps only the manual marker");
}

module.exports = { name: "deepqc", run };
