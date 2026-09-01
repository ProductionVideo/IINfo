"use strict";
// Video Scopes panel: type select, options reveal, size / corner / brightness
// -> config, docked layout hides corner + opacity, menu-cycle sync, Off.
const assert = require("node:assert/strict");
const H = require("./_harness");

const shim = `
window.__errors = [];
window.addEventListener("error", e => window.__errors.push(String(e.message || e.error)));
window.iina = (function () {
  var H = {}; var scope = { type: "off", size: "m", corner: "tr", opacity: 1 };
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
      compare: null, markers: { list: [], media: null, gen: 0 },
      scope: { cfg: scope, active: scope.type !== "off", error: "" }
    };
  }
  return {
    postMessage: function (n, p) {
      if (n === "iinfo-ready") setTimeout(function () { (H["iinfo-config"]||[]).forEach(f=>f({config:null})); (H["iinfo-data"]||[]).forEach(f=>f(data())); }, 5);
      if (n === "iinfo-poll") (H["iinfo-data"]||[]).forEach(f=>f(data()));
      if (n === "iinfo-config") { window.__cfg = p; if (p && p.settings && p.settings.scope) scope = p.settings.scope; }
    },
    onMessage: function (n, cb) { (H[n] = H[n] || []).push(cb); window.__H = H; }
  };
})();
`;

const driver = `
setTimeout(function () {
  try {
    var out = { errors: window.__errors, steps: [] };
    function q(s){ return document.querySelector(s); }
    var box = [].slice.call(document.querySelectorAll("#drawer label")).find(l => /Video Scopes/.test(l.textContent));
    if (box) { var cb = box.querySelector("input"); cb.checked = true; cb.dispatchEvent(new Event("change")); }
    var wf = [].slice.call(document.querySelectorAll(".scope-seg .btn")).find(b => b.textContent === "Waveform");
    wf.click();
    window.iina.postMessage("iinfo-poll");
    out.steps.push("typeAfterWaveform:" + (window.__cfg && window.__cfg.settings && window.__cfg.settings.scope.type));
    out.steps.push("optsVisible:" + !q(".scope-opts").hidden);
    [].slice.call(document.querySelectorAll(".scope-row .btn")).find(b => b.textContent === "XL").click();
    [].slice.call(document.querySelectorAll(".scope-row .btn")).find(b => b.title === "bottom-right").click();
    var brightInp = [].slice.call(document.querySelectorAll(".scope-row input[type=range]"))[0];
    brightInp.value = 0.35; brightInp.dispatchEvent(new Event("input"));
    window.iina.postMessage("iinfo-poll");
    out.steps.push("cfgFinal:" + JSON.stringify(window.__cfg.settings.scope));
    [].slice.call(document.querySelectorAll(".scope-row .btn")).find(b => b.textContent === "Bottom").click();
    var cornRowHidden = [].slice.call(document.querySelectorAll(".scope-row")).find(r => /Corner/.test(r.textContent)).hidden;
    out.steps.push("cornerHiddenWhenDocked:" + cornRowHidden);
    out.steps.push("layoutInCfg:" + window.__cfg.settings.scope.layout);
    (window.__H["iinfo-scope-set"]||[]).forEach(f => f({ scope: { type: "vectorscope", size: "l", corner: "br", opacity: 0.6 } }));
    window.iina.postMessage("iinfo-poll");
    var vsOn = [].slice.call(document.querySelectorAll(".scope-seg .btn")).find(b => b.textContent === "Vectorscope").classList.contains("on");
    out.steps.push("scopeSetSync:" + vsOn);
    [].slice.call(document.querySelectorAll(".scope-seg .btn")).find(b => b.textContent === "Off").click();
    out.steps.push("optsHiddenWhenOff:" + q(".scope-opts").hidden);
    document.title = "RESULT " + JSON.stringify(out);
  } catch (e) { document.title = "RESULT " + JSON.stringify({ fatal: String(e && e.stack || e), errors: window.__errors }); }
}, 700);
`;

function run(chrome) {
  const res = H.render(chrome, "scope", H.inlineInspector(shim, driver), 3500);
  const S = (k) => (res.steps.find((s) => s.indexOf(k + ":") === 0) || "").slice(k.length + 1);
  assert.equal(S("typeAfterWaveform"), "waveform");
  assert.equal(S("optsVisible"), "true");
  const cfg = JSON.parse(S("cfgFinal"));
  assert.equal(cfg.size, "xl");
  assert.equal(cfg.corner, "br");
  assert.equal(cfg.bright, 0.35);
  assert.equal(S("cornerHiddenWhenDocked"), "true", "docked layout hides the corner picker");
  assert.equal(S("layoutInCfg"), "bottom");
  assert.equal(S("scopeSetSync"), "true", "a menu-cycle scope-set message syncs the panel");
  assert.equal(S("optsHiddenWhenOff"), "true");
}

module.exports = { name: "scope", run };
