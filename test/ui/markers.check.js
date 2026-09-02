"use strict";
// QC Markers panel: capture, edit, resolve, filter, seek, reorder, report/CSV,
// delete, scrub-bar tick click, and the serialised push back to the plugin.
const assert = require("node:assert/strict");
const H = require("./_harness");

const shim = `
window.iina = (function () {
  var H = {};
  function emit(n, d){ (H[n]||[]).forEach(function(f){ f(d); }); }
  var markers = [], mgen = 1, pushed = [], pos = 5;
  function data(){
    return {
      now: Date.now(),
      file: { gen: 0, name: "a.mov", path: "/w/a.mov", format: "mov", size: 1e8, paused: true, speed: 1 },
      time: { pos: pos, duration: 120, remaining: 115, percent: 4.1, fps: 25, fpsSource: "container",
              frame: 125, frameCount: 3000, dropFrame: false, timecode: "00:00:05:00", timecodeNDF: "00:00:05:00" },
      frameInfo: { pictureType: "I", keyFrame: true, interlaced: false, tff: false, repeat: false, raw: {} },
      video: { w: 1920, h: 1080, dw: 1920, dh: 1080, aspect: 1.78, aspectName: "16:9", par: 1,
               pixelformat: "yuv420p", colormatrix: "bt.709", colorlevels: "limited", primaries: "bt.709",
               gamma: "bt.709", rotate: 0, stereoIn: "mono", alpha: "no", codec: "h264", decoder: "h264", hwdec: "no", bitrate: 5e6 },
      audio: { sampleRate: 48000, channelCount: 2, channels: "stereo", format: "s16", codec: "aac", bitrate: 256000 },
      perf: { avsync: 0.001, decDrop: 0, voDrop: 0, mistimed: 0, delayed: 0, displayFps: 60, estVfFps: 25, cacheDuration: 10, cacheUnderrun: false },
      meter: { active: false, wanted: false, fresh: false, error: "", raw: {} },
      compare: null,
      markers: { list: markers, media: { path: "/w/a.mov", filename: "a.mov", size: 1e8, durationMs: 120000, fps: 25 }, gen: mgen, sidecar: false, sidecarError: false }
    };
  }
  return {
    postMessage: function (name, payload) {
      if (name === "iinfo-ready") setTimeout(function(){ emit("iinfo-config", { config: null }); emit("iinfo-data", data()); }, 5);
      if (name === "iinfo-poll") emit("iinfo-data", data());
      if (name === "iinfo-action" && payload.type === "seek-abs") { pos = payload.value; }
      if (name === "iinfo-markers") { pushed.push(payload); window.__pushed = pushed;
        try { var p = JSON.parse(payload.json); markers = p.events; } catch(e){} }
      if (name === "iinfo-action" || name === "iinfo-gang") { window.__acts = window.__acts || []; window.__acts.push([name, payload]); }
      if (name === "iinfo-export") { window.__exports = window.__exports || []; window.__exports.push(payload); }
    },
    onMessage: function (name, cb) { (H[name] = H[name] || []).push(cb); }
  };
})();
` + H.errorHook;

const driver = `
setTimeout(function () {
  try {
    var out = { errors: window.__errors || [], steps: [] };
    function q(s){ return document.querySelector(s); }
    var box = [].slice.call(document.querySelectorAll("#drawer label")).find(function(l){ return /QC Markers/.test(l.textContent); });
    out.steps.push("drawerToggle:" + !!box);
    if (box) { var cb = box.querySelector("input"); cb.checked = true; cb.dispatchEvent(new Event("change")); }
    var mk = [].slice.call(document.querySelectorAll(".qc-bar .btn")).find(function(b){ return /Mark/.test(b.textContent); });
    mk.click();
    window.iina.postMessage("iinfo-action", { type: "seek-abs", value: 72 }); window.iina.postMessage("iinfo-poll");
    mk.click();
    out.steps.push("rows:" + document.querySelectorAll(".qc-row").length);
    out.steps.push("marksDistinct:" + document.querySelectorAll("#scrub-marks .scrub-mark").length);
    out.steps.push("editorOpen:" + !!q(".qc-edit"));
    var ni = q(".qc-note-in"); if (ni) { ni.value = "torn field"; ni.dispatchEvent(new Event("blur")); }
    var sevSel = q(".qc-edit-row select:nth-of-type(2)");
    if (sevSel) { sevSel.value = "error"; sevSel.dispatchEvent(new Event("change")); }
    var res = [].slice.call(document.querySelectorAll(".qc-row .mini")).find(function(b){ return b.textContent === "resolve"; });
    if (res) res.click();
    var fs2 = q(".qc-filter"); fs2.value = "Unresolved"; fs2.dispatchEvent(new Event("change"));
    out.steps.push("rowsUnresolved:" + document.querySelectorAll(".qc-row").length);
    fs2.value = "All"; fs2.dispatchEvent(new Event("change"));
    var main = q(".qc-main"); if (main) main.click();
    out.steps.push("acts:" + JSON.stringify(window.__acts || []));
    q("#b-tools").click();
    out.steps.push("drawerOpen:" + q("#drawer").classList.contains("open"));
    var order0 = [].slice.call(document.querySelectorAll("#main .panel")).map(function(p){ return (p.querySelector("h2 span")||{}).textContent; });
    var dnBtns = [].slice.call(document.querySelectorAll(".panel-order-row .mini")).filter(function(b){ return b.textContent === "↓" && !b.disabled; });
    if (dnBtns[0]) dnBtns[0].click();
    var order1 = [].slice.call(document.querySelectorAll("#main .panel")).map(function(p){ return (p.querySelector("h2 span")||{}).textContent; });
    out.steps.push("reordered:" + (order0[0] !== order1[0]));
    var actTab = [].slice.call(document.querySelectorAll(".drawer-tab")).find(function(b){ return /Actions/.test(b.textContent); });
    actTab.click();
    out.steps.push("actionsVisible:" + !q(".drawer-body[data-tab=actions]").hidden);
    var crb = [].slice.call(document.querySelectorAll(".drawer-body[data-tab=actions] .btn")).find(function(b){ return /Copy QC report/.test(b.textContent); });
    crb.click();
    out.steps.push("reportLen:" + (q("#report-text") ? q("#report-text").value.length : -1));
    q("#report").close();
    var csvb = [].slice.call(document.querySelectorAll(".drawer-body[data-tab=actions] .btn")).find(function(b){ return b.textContent === "CSV"; });
    csvb.click();
    out.steps.push("csvReportLen:" + (q("#report-text") ? q("#report-text").value.length : -1));
    q("#report").close();
    function nShots(){ return (window.__acts || []).filter(function(a){ return a[1] && a[1].type === "marker-shot"; }).length; }
    // the camera button works regardless of the opt-in setting
    var shotBtn = document.querySelector(".qc-row .mini.cam");
    out.steps.push("shotBtn:" + (!!shotBtn && !!shotBtn.querySelector("svg")));
    if (shotBtn) shotBtn.click();
    var camShot = (window.__acts || []).filter(function(a){ return a[1] && a[1].type === "marker-shot"; }).pop();
    out.steps.push("camShotStamp:" + (camShot ? String(camShot[1].value.tc) : "?"));
    out.steps.push("autoShotsDefault:" + nShots());   // adds so far posted none (opt-in off) — only the camera click
    // opt in via Tools > Storage, then a fresh marker should auto-screenshot
    var stTab = [].slice.call(document.querySelectorAll(".drawer-tab")).find(function(b){ return /Storage/.test(b.textContent); });
    if (stTab) stTab.click();
    var msCb = [].slice.call(document.querySelectorAll(".drawer-body[data-tab=storage] input[type=checkbox]")).find(function(c){ return /Screenshot each new/.test(c.parentNode.textContent); });
    out.steps.push("markerShotCb:" + !!msCb);
    if (msCb) { msCb.checked = true; msCb.dispatchEvent(new Event("change")); }
    var mk2 = [].slice.call(document.querySelectorAll(".qc-bar .btn")).find(function(b){ return /Mark/.test(b.textContent); });
    mk2.click();
    out.steps.push("autoShotsAfterOptIn:" + nShots());
    var before = document.querySelectorAll(".qc-row").length;
    var del = [].slice.call(document.querySelectorAll(".qc-row .mini")).find(function(b){ return b.textContent === "✕"; });
    if (del) del.click();
    out.steps.push("rowsAfterDelete:" + before + "->" + document.querySelectorAll(".qc-row").length);
    out.steps.push("scrubMarks:" + document.querySelectorAll("#scrub-marks .scrub-mark").length);
    var sm = q("#scrub-marks .scrub-mark");
    if (sm) { sm.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
    setTimeout(function () {
      var last = window.__pushed && window.__pushed[window.__pushed.length - 1];
      out.steps.push("pushedEvents:" + (last ? JSON.parse(last.json).events.length : -1));
      out.steps.push("firstNote:" + (last ? JSON.parse(last.json).events.map(function(e){return e.note+"/"+e.severity+"/"+e.resolved;}).join(",") : "?"));
      document.title = "RESULT " + JSON.stringify(out);
    }, 800);
  } catch (e) {
    document.title = "RESULT " + JSON.stringify({ fatal: String(e && e.stack || e), errors: window.__errors });
  }
}, 900);
`;

function run(chrome) {
  const res = H.render(chrome, "markers", H.inlineInspector(shim, driver), 4500);
  const S = (k) => (res.steps.find((s) => s.indexOf(k + ":") === 0) || "").slice(k.length + 1);
  assert.equal(S("drawerToggle"), "true", "QC Markers drawer toggle missing");
  assert.equal(S("rows"), "2", "two markers should be captured");
  assert.equal(S("editorOpen"), "true", "manual marker row should open an editor");
  assert.equal(S("rowsUnresolved"), "1", "one marker resolved -> one unresolved");
  assert.ok(S("acts").indexOf('"seek-abs"') >= 0, "clicking a row should seek");
  assert.equal(S("shotBtn"), "true", "every marker row should have a camera (svg) screenshot button");
  assert.match(S("camShotStamp"), /^\d\d:\d\d:\d\d[:;]\d\d$/, "the shot carries the marker's media timecode (raw tc in the action), not wall-clock time");
  assert.equal(S("autoShotsDefault"), "1", "with the opt-in off, adding markers must NOT auto-screenshot (only the camera click counts)");
  assert.equal(S("markerShotCb"), "true", "Storage tab should have a 'screenshot each new marker' checkbox");
  assert.equal(S("autoShotsAfterOptIn"), "2", "with the opt-in on, a new marker auto-posts marker-shot");
  assert.equal(S("reordered"), "true", "panel reorder should take effect");
  assert.ok(Number(S("reportLen")) > 100, "Markdown report should be non-trivial");
  assert.equal(S("rowsAfterDelete"), "3->2", "delete should remove a row");
  assert.ok(S("firstNote").indexOf("torn field/error") >= 0, "note + severity edit should serialise back");
}

module.exports = { name: "markers", run };
