(function () {
  "use strict";
  var iina = window.iina;
  var VCFit = window.VCFit;
  function $(id) { return document.getElementById(id); }

  var cv = $("cv"), ctx = cv.getContext("2d");
  var imgA = new Image(), imgB = new Image();
  var haveA = false, haveB = false;

  var mode = "diff";          // diff | flicker | wipe | onion | a | b
  var rate = 6;               // flicker Hz
  var opacity = 0.5;          // onion
  var gain = 1;               // difference amplification (1..8)
  var wipe = 0.5;             // 0..1 across A's fitted rect
  var flickPhase = 0, flickTimer = null;
  var rectA = { x: 0, y: 0, w: 0, h: 0 };

  /* ---------- frame input ---------- */
  function frameLoaded() {
    refreshDiffBtn();
    draw();
  }
  iina.onMessage("frames", function (d) {
    if (!d) return;
    if (d.a) { haveA = false; imgA.onload = function () { haveA = true; frameLoaded(); }; imgA.src = d.a; }
    if (d.b) { haveB = false; imgB.onload = function () { haveB = true; frameLoaded(); }; imgB.src = d.b; }
    if (!d.a && !d.b) draw();
  });
  function refreshDiffBtn() {
    var b = document.querySelector('[data-mode="diff"]');
    if (b) b.disabled = !diffOK();
  }

  function diffOK() {
    return haveA && haveB && VCFit.diffAllowed(
      { w: imgA.naturalWidth, h: imgA.naturalHeight },
      { w: imgB.naturalWidth, h: imgB.naturalHeight });
  }

  /* ---------- draw ---------- */
  function fitCanvas() {
    var dpr = window.devicePixelRatio || 1;
    var w = window.innerWidth, h = window.innerHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h - 46 };   // leave room for the control bar
  }

  function draw() {
    var box = fitCanvas();
    ctx.clearRect(0, 0, box.w, box.h + 46);
    if (!haveA && !haveB) { note("waiting for frames…"); return; }

    var refImg = haveA ? imgA : imgB;
    rectA = VCFit.contain(box.w, box.h, refImg.naturalWidth, refImg.naturalHeight);

    var m = mode;
    if (m === "diff" && !diffOK()) { note("resolution mismatch — difference unavailable"); m = "a"; }
    else if (m === "a") note(dims());
    else if (m === "b") note(dims());
    else note("");

    if (m === "a" || !haveB) { if (haveA) ctx.drawImage(imgA, rectA.x, rectA.y, rectA.w, rectA.h); return; }
    if (m === "b" || !haveA) { ctx.drawImage(imgB, rectA.x, rectA.y, rectA.w, rectA.h); return; }

    if (m === "flicker") {
      var im = flickPhase ? imgB : imgA;
      ctx.drawImage(im, rectA.x, rectA.y, rectA.w, rectA.h);
      note(flickPhase ? "B" : "A");
      return;
    }
    if (m === "onion") {
      ctx.drawImage(imgA, rectA.x, rectA.y, rectA.w, rectA.h);
      ctx.globalAlpha = opacity;
      ctx.drawImage(imgB, rectA.x, rectA.y, rectA.w, rectA.h);
      ctx.globalAlpha = 1;
      return;
    }
    if (m === "wipe") {
      ctx.drawImage(imgA, rectA.x, rectA.y, rectA.w, rectA.h);
      var sx = rectA.x + wipe * rectA.w;
      ctx.save();
      ctx.beginPath(); ctx.rect(sx, rectA.y, rectA.x + rectA.w - sx, rectA.h); ctx.clip();
      ctx.drawImage(imgB, rectA.x, rectA.y, rectA.w, rectA.h);
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, rectA.y); ctx.lineTo(sx, rectA.y + rectA.h); ctx.stroke();
      positionHandle(sx);
      return;
    }
    // difference
    ctx.drawImage(imgA, rectA.x, rectA.y, rectA.w, rectA.h);
    ctx.globalCompositeOperation = "difference";
    ctx.drawImage(imgB, rectA.x, rectA.y, rectA.w, rectA.h);
    ctx.globalCompositeOperation = "source-over";
    // frames are JPEG-compressed, so knock out a small noise floor, then apply gain
    var FLOOR = 5;
    var rx = Math.max(0, Math.floor(rectA.x)), ry = Math.max(0, Math.floor(rectA.y));
    var rw = Math.min(cv.width - rx, Math.ceil(rectA.w)), rh = Math.min(cv.height - ry, Math.ceil(rectA.h));
    if (rw > 0 && rh > 0) {
      try {
        var id = ctx.getImageData(rx, ry, rw, rh), p = id.data;
        for (var i = 0; i < p.length; i += 4) {
          for (var c = 0; c < 3; c++) {
            var vv = p[i + c];
            vv = vv <= FLOOR ? 0 : (vv - FLOOR) * gain;
            p[i + c] = vv > 255 ? 255 : vv;
          }
        }
        ctx.putImageData(id, rx, ry);
      } catch (e) { /* tainted canvas shouldn't happen with data URIs */ }
    }
    note("difference" + (gain > 1 ? " ×" + gain : "") + "  ·  " + dims());
  }

  function dims() {
    if (!haveA) return "";
    var s = imgA.naturalWidth + "×" + imgA.naturalHeight;
    if (haveB && (imgB.naturalWidth !== imgA.naturalWidth || imgB.naturalHeight !== imgA.naturalHeight))
      s += "  vs  " + imgB.naturalWidth + "×" + imgB.naturalHeight;
    return s;
  }
  var noteEl = $("note");
  function note(t) { if (noteEl.textContent !== t) noteEl.textContent = t; }

  /* ---------- flicker loop ---------- */
  function restartFlicker() {
    if (flickTimer) { clearInterval(flickTimer); flickTimer = null; }
    if (mode !== "flicker") return;
    flickTimer = setInterval(function () { flickPhase ^= 1; draw(); }, Math.max(40, 1000 / rate));
  }

  /* ---------- controls ---------- */
  var modeBtns = $("modes").querySelectorAll("button");
  function setMode(m) {
    mode = m;
    [].forEach.call(modeBtns, function (b) { b.classList.toggle("on", b.dataset.mode === m); });
    var diffBtn = $("modes").querySelector('[data-mode="diff"]');
    diffBtn.disabled = !diffOK();
    var sl = $("sl"), lab = $("sl-label"), inp = $("slider");
    if (m === "flicker") { sl.hidden = false; lab.textContent = "Rate"; inp.min = 1; inp.max = 12; inp.step = 1; inp.value = rate; }
    else if (m === "onion") { sl.hidden = false; lab.textContent = "B opacity"; inp.min = 0; inp.max = 100; inp.step = 1; inp.value = Math.round(opacity * 100); }
    else if (m === "diff") { sl.hidden = false; lab.textContent = "Gain"; inp.min = 1; inp.max = 8; inp.step = 1; inp.value = gain; }
    else sl.hidden = true;
    $("handle").hidden = m !== "wipe";
    syncSliderVal();
    restartFlicker();
    draw();
  }
  function syncSliderVal() {
    var v = $("slider").value;
    $("sl-val").textContent = mode === "onion" ? v + "%" : (mode === "flicker" ? v + " Hz" : (mode === "diff" ? "×" + v : ""));
  }
  [].forEach.call(modeBtns, function (b) {
    b.addEventListener("click", function () { setMode(b.dataset.mode); });
  });
  $("slider").addEventListener("input", function () {
    var v = parseFloat($("slider").value);
    if (mode === "flicker") { rate = v; restartFlicker(); }
    else if (mode === "onion") { opacity = v / 100; }
    else if (mode === "diff") { gain = v; }
    syncSliderVal();
    draw();
  });
  $("refresh").addEventListener("click", function () { try { iina.postMessage("iinfo-vc-refresh"); } catch (e) {} });
  $("exit").addEventListener("click", function () { try { iina.postMessage("iinfo-vc-exit"); } catch (e) {} });

  /* wipe handle drag */
  var handle = $("handle"), dragging = false;
  function handleFromClientX(x) {
    if (rectA.w <= 0) return;
    wipe = Math.max(0, Math.min(1, (x - rectA.x) / rectA.w));
    draw();
  }
  function positionHandle(sx) { handle.style.left = sx + "px"; }
  handle.addEventListener("pointerdown", function (e) { dragging = true; try { handle.setPointerCapture(e.pointerId); } catch (err) {} handleFromClientX(e.clientX); });
  handle.addEventListener("pointermove", function (e) { if (dragging) handleFromClientX(e.clientX); });
  handle.addEventListener("pointerup", function () { dragging = false; });
  handle.addEventListener("pointercancel", function () { dragging = false; });

  /* keyboard */
  document.addEventListener("keydown", function (e) {
    var k = e.key;
    if (k === "1") setMode("diff");
    else if (k === "2") setMode("flicker");
    else if (k === "3") setMode("wipe");
    else if (k === "4") setMode("onion");
    else if (k === "5") setMode("a");
    else if (k === "6") setMode("b");
    else if (k === "r") { try { iina.postMessage("iinfo-vc-refresh"); } catch (err) {} }
    else if (k === "Escape") { try { iina.postMessage("iinfo-vc-exit"); } catch (err) {} }
    else if (k === "[" || k === "]") {
      var inp = $("slider");
      if ($("sl").hidden) return;
      inp.value = parseFloat(inp.value) + (k === "]" ? 1 : -1) * parseFloat(inp.step || 1);
      inp.dispatchEvent(new Event("input"));
    } else return;
    e.preventDefault();
  });

  window.addEventListener("resize", draw);

  setMode("diff");
  try { iina.postMessage("iinfo-vc-ready"); } catch (e) {}
})();
