"use strict";
// A/B Compare + A/B Technical Diff panels: player select, link transport,
// ganged transport verbs, frame offset, badges, tech-diff rows + diff-only.
const assert = require("node:assert/strict");
const H = require("./_harness");

const shim = `
window.iina = (function () {
  var H = {};
  var linked = false, aId = "1", bId = "2", offFrames = 0;
  function compare(){
    return {
      myId: "1",
      state: { aId: aId, bId: bId, linked: linked, offsetSec: offFrames/25, offsetFrames: offFrames, mode: "frame-offset", fpsMismatch: false, drift: 0 },
      players: [
        { id: "1", filename: "show_v011.mov", path: "/w/show_v011.mov", w: 1920, h: 1080, fps: 25, duration: 120, pos: 5, paused: true,
          tech: { container:"mov", vcodec:"prores", w:1920, h:1080, par:1, dar:"16:9", pixfmt:"yuv422p10le", range:"limited", matrix:"bt.709", primaries:"bt.709", transfer:"bt.709", fps:25, duration:120, frameCount:3000, vbitrate:178000000, acodec:"pcm_s24le", asr:48000, ach:2, alayout:"stereo", afmt:"s32", abitrate:2300000 } },
        { id: "2", filename: "show_v012.mov", path: "/w/show_v012.mov", w: 1920, h: 1080, fps: 25, duration: 121, pos: 5.08, paused: true,
          tech: { container:"mov", vcodec:"prores", w:1920, h:1080, par:1, dar:"16:9", pixfmt:"yuv422p10le", range:"full", matrix:"bt.709", primaries:"bt.709", transfer:"bt.709", fps:25, duration:120, frameCount:3000, vbitrate:178000000, acodec:"pcm_s16le", asr:48000, ach:2, alayout:"stereo", afmt:"s16", abitrate:1500000 } }
      ]
    };
  }
  function data(){
    return {
      now: Date.now(),
      file: { gen: 0, name: "show_v011.mov", path: "/w/show_v011.mov", format: "mov", size: 1e8, paused: true, speed: 1 },
      time: { pos: 5, duration: 120, remaining: 115, percent: 4.1, fps: 25, fpsSource: "container", frame: 125, frameCount: 3000, dropFrame: false, timecode: "00:00:05:00", timecodeNDF: "00:00:05:00" },
      frameInfo: { pictureType: "I", keyFrame: true, interlaced: false, tff: false, repeat: false, raw: {} },
      video: { w: 1920, h: 1080, dw: 1920, dh: 1080, aspect: 1.78, aspectName: "16:9", par: 1, pixelformat: "yuv420p", colormatrix: "bt.709", colorlevels: "limited", primaries: "bt.709", gamma: "bt.709", rotate: 0, stereoIn: "mono", alpha: "no", codec: "h264", decoder: "h264", hwdec: "no", bitrate: 5e6 },
      audio: { sampleRate: 48000, channelCount: 2, channels: "stereo", format: "s16", codec: "aac", bitrate: 256000 },
      perf: { avsync: 0.001, decDrop: 0, voDrop: 0, mistimed: 0, delayed: 0, displayFps: 60, estVfFps: 25, cacheDuration: 10, cacheUnderrun: false },
      meter: { active: false, wanted: false, fresh: false, error: "", raw: {} },
      compare: compare()
    };
  }
  return {
    postMessage: function (name, payload) {
      if (name === "iinfo-ready") setTimeout(function(){ (H["iinfo-config"]||[]).forEach(f=>f({ config: null })); (H["iinfo-data"]||[]).forEach(f=>f(data())); }, 5);
      if (name === "iinfo-poll") (H["iinfo-data"]||[]).forEach(f=>f(data()));
      if (name === "iinfo-compare-cmd") {
        window.__cmds = window.__cmds || []; window.__cmds.push(payload);
        if (payload.op === "link") linked = true;
        if (payload.op === "unlink") linked = false;
        if (payload.op === "offset-frames") offFrames += payload.delta;
        if (payload.op === "offset-reset") offFrames = 0;
        if (payload.op === "swap") { var t = aId; aId = bId; bId = t; offFrames = -offFrames; }
        (H["iinfo-data"]||[]).forEach(f=>f(data()));
      }
      if (name === "iinfo-gang") { window.__gangs = window.__gangs || []; window.__gangs.push(payload); }
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
    var cmp = [].slice.call(document.querySelectorAll(".panel h2")).find(function(h){ return /A\\/B Compare/.test(h.textContent); });
    out.steps.push("panel:" + !!cmp);
    var box = [].slice.call(document.querySelectorAll("#drawer label")).find(function(l){ return /A\\/B Compare/.test(l.textContent); });
    if (box) { var cb = box.querySelector("input"); cb.checked = true; cb.dispatchEvent(new Event("change")); }
    out.steps.push("selOptions:" + document.querySelectorAll(".cmp-sel option").length);
    var link = [].slice.call(document.querySelectorAll(".cmp-link input"))[0];
    if (link) { link.checked = true; link.dispatchEvent(new Event("change")); }
    q("#b-next").click();
    q("#b-pause").click();
    out.steps.push("gangs:" + JSON.stringify(window.__gangs || []));
    var plus5 = [].slice.call(document.querySelectorAll(".cmp-row .btn")).find(function(b){ return b.textContent === "+5f"; });
    if (plus5) plus5.click();
    out.steps.push("cmds:" + JSON.stringify(window.__cmds || []));
    out.steps.push("offLabel:" + (q(".cmp-off") ? q(".cmp-off").textContent : "?"));
    var atb = [].slice.call(document.querySelectorAll("#drawer label")).find(function(l){ return /A\\/B Technical Diff/.test(l.textContent); });
    if (atb) { var acb = atb.querySelector("input"); acb.checked = true; acb.dispatchEvent(new Event("change")); }
    window.iina.postMessage("iinfo-poll");
    out.steps.push("abtechRows:" + document.querySelectorAll(".abtable .abrow").length);
    out.steps.push("abtechDiffRows:" + document.querySelectorAll(".abtable .abrow.diff").length);
    document.title = "RESULT " + JSON.stringify(out);
  } catch (e) {
    document.title = "RESULT " + JSON.stringify({ fatal: String(e && e.stack || e), errors: window.__errors });
  }
}, 900);
`;

function run(chrome) {
  const res = H.render(chrome, "compare", H.inlineInspector(shim, driver), 4000);
  const S = (k) => (res.steps.find((s) => s.indexOf(k + ":") === 0) || "").slice(k.length + 1);
  assert.equal(S("panel"), "true", "A/B Compare panel present");
  assert.ok(Number(S("selOptions")) >= 2, "player pickers populated");
  const gangs = JSON.parse(S("gangs"));
  assert.ok(gangs.some((g) => /next/.test(g.action)), "next frame gangs a frame-next verb");
  assert.ok(gangs.some((g) => g.action === "play"), "pausing a paused pair gangs a play");
  const cmds = JSON.parse(S("cmds"));
  assert.ok(cmds.some((c) => c.op === "offset-frames" && c.delta === 5), "+5f sends offset-frames");
  assert.ok(Number(S("abtechRows")) > 5, "tech-diff table populated");
  assert.ok(Number(S("abtechDiffRows")) >= 1, "range/audio differences flagged");
}

module.exports = { name: "compare", run };
