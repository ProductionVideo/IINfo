/*
 * IINfo — A/B visual-compare fit maths. Pure: no DOM, no iina.
 * <script> in ui/vcompare.html (window.VCFit) + require()d by node --test.
 */
(function (root) {
  "use strict";

  // letterboxed rect (object-fit: contain) for an image of imgW×imgH inside boxW×boxH
  function contain(boxW, boxH, imgW, imgH) {
    if (!(boxW > 0 && boxH > 0 && imgW > 0 && imgH > 0)) return { x: 0, y: 0, w: boxW || 0, h: boxH || 0 };
    var s = Math.min(boxW / imgW, boxH / imgH);
    var w = imgW * s, h = imgH * s;
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w: w, h: h };
  }

  function sameSize(a, b) {
    return !!(a && b && a.w > 0 && b.w > 0 && a.w === b.w && a.h === b.h);
  }

  // a per-pixel difference is only meaningful when the two frames are the same
  // raster size (otherwise you're diffing a resample)
  function diffAllowed(a, b) { return sameSize(a, b); }

  var API = { contain: contain, sameSize: sameSize, diffAllowed: diffAllowed };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.VCFit = API;
})(typeof self !== "undefined" ? self : this);
