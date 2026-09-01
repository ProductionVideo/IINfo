"use strict";
// A/B Visual Compare overlay web view: frame ingest, mode keys, wipe handle,
// onion slider, difference disabled on a resolution mismatch, exit.
const assert = require("node:assert/strict");
const H = require("./_harness");

const shim = `
window.__errors = [];
window.addEventListener("error", function (e) { window.__errors.push(String(e.message || e.error)); });
window.addEventListener("unhandledrejection", function (e) { window.__errors.push("promise: " + (e.reason && e.reason.message || e.reason)); });
window.iina = (function () {
  var H = {};
  return {
    postMessage: function (n) { window.__sent = window.__sent || []; window.__sent.push(n); },
    onMessage: function (n, cb) { (H[n] = H[n] || []).push(cb); window.__H = H; }
  };
})();
function px(w, h, color) {
  var c = document.createElement("canvas"); c.width = w; c.height = h;
  var x = c.getContext("2d"); x.fillStyle = color; x.fillRect(0, 0, w, h);
  x.fillStyle = "#fff"; x.fillRect(2, 2, 3, 3);
  return c.toDataURL("image/png");
}
`;

const driver = `
setTimeout(function () {
  try {
    var out = { errors: window.__errors || [], steps: [] };
    function emit(n, d) { (window.__H[n] || []).forEach(function (f) { f(d); }); }
    out.steps.push("ready:" + JSON.stringify(window.__sent || []));
    emit("frames", { a: px(120, 80, "#204080"), b: px(120, 80, "#206040"), wA: 120, hA: 80 });
    setTimeout(function () {
      function q(s){ return document.querySelector(s); }
      out.steps.push("diffBtnDisabled:" + q('[data-mode=diff]').disabled);
      ["2","3","4","5","6","1"].forEach(function (k) { document.dispatchEvent(new KeyboardEvent("keydown", { key: k })); });
      out.steps.push("modeAfterKeys:" + (q(".modes .on") ? q(".modes .on").dataset.mode : "?"));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "3" }));
      var hd = q("#handle");
      out.steps.push("handleShown:" + !hd.hidden);
      hd.dispatchEvent(new PointerEvent("pointerdown", { clientX: 40, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "4" }));
      var sl = q("#slider"); sl.value = 30; sl.dispatchEvent(new Event("input"));
      out.steps.push("sliderVal:" + q("#sl-val").textContent);
      emit("frames", { a: px(120, 80, "#333"), b: px(60, 80, "#555"), wA: 120, hA: 80 });
      setTimeout(function () {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
        out.steps.push("diffDisabledOnMismatch:" + q('[data-mode=diff]').disabled);
        out.steps.push("note:" + q("#note").textContent);
        q("#exit").click();
        out.steps.push("sent:" + JSON.stringify(window.__sent || []));
        document.title = "RESULT " + JSON.stringify(out);
      }, 120);
    }, 120);
  } catch (e) {
    document.title = "RESULT " + JSON.stringify({ fatal: String(e && e.stack || e), errors: window.__errors });
  }
}, 300);
`;

function run(chrome) {
  const res = H.render(chrome, "vcompare", H.inlineVCompare(shim, driver), 3000);
  const S = (k) => (res.steps.find((s) => s.indexOf(k + ":") === 0) || "").slice(k.length + 1);
  assert.ok(S("ready").indexOf("iinfo-vc-ready") >= 0, "overlay signals ready");
  assert.equal(S("diffBtnDisabled"), "false", "same-size frames -> difference available");
  assert.equal(S("handleShown"), "true", "wipe handle visible in wipe mode");
  assert.equal(S("sliderVal"), "30%", "onion slider updates its readout");
  assert.equal(S("diffDisabledOnMismatch"), "true", "difference disabled on a resolution mismatch");
  assert.ok(S("note").toLowerCase().indexOf("mismatch") >= 0, "mismatch note shown");
  assert.ok(S("sent").indexOf("iinfo-vc-exit") >= 0, "exit sends iinfo-vc-exit");
}

module.exports = { name: "vcompare", run };
