/* Zero-dependency PNG icon generator for LoadMaster Pro AI.
 * Renders the brand M-monogram (roofline) + AI sparkle mark at several sizes.
 * Run: node generate-icons.cjs */
var zlib = require("zlib");
var fs = require("fs");
var path = require("path");

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function render(S, opts) {
  opts = opts || {};
  var buf = new Uint8Array(S * S * 4);
  var topC = [109, 123, 255], botC = [25, 198, 232];
  // background gradient + soft top-left highlight
  for (var y = 0; y < S; y++) {
    for (var x = 0; x < S; x++) {
      var t = y / (S - 1);
      var r = lerp(topC[0], botC[0], t), g = lerp(topC[1], botC[1], t), b = lerp(topC[2], botC[2], t);
      var dx = (x / S - 0.28), dy = (y / S - 0.22);
      var hi = clamp01(1 - Math.sqrt(dx * dx + dy * dy) / 0.8) * 0.22;
      r = lerp(r, 255, hi); g = lerp(g, 255, hi); b = lerp(b, 255, hi);
      var i = (y * S + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }

  var WHITE = [246, 251, 255], GOLD = [255, 193, 87];

  function blend(x, y, col, a) {
    if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
    if (a > 1) a = 1;
    var i = (y * S + x) * 4;
    buf[i] = lerp(buf[i], col[0], a);
    buf[i + 1] = lerp(buf[i + 1], col[1], a);
    buf[i + 2] = lerp(buf[i + 2], col[2], a);
  }

  // Distance from point to a line segment (for rounded-cap/join thick strokes).
  function distToSeg(px, py, x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var len2 = dx * dx + dy * dy;
    var tt = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
    tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
    var cx = x0 + tt * dx, cy = y0 + tt * dy;
    return Math.hypot(px - cx, py - cy);
  }
  function thickPolyline(pts, halfW, col) {
    for (var seg = 0; seg < pts.length - 1; seg++) {
      var x0 = pts[seg][0], y0 = pts[seg][1], x1 = pts[seg + 1][0], y1 = pts[seg + 1][1];
      var minX = Math.max(0, Math.floor(Math.min(x0, x1) - halfW - 1)), maxX = Math.min(S, Math.ceil(Math.max(x0, x1) + halfW + 1));
      var minY = Math.max(0, Math.floor(Math.min(y0, y1) - halfW - 1)), maxY = Math.min(S, Math.ceil(Math.max(y0, y1) + halfW + 1));
      for (var y = minY; y < maxY; y++) {
        for (var x = minX; x < maxX; x++) {
          var d = distToSeg(x + 0.5, y + 0.5, x0, y0, x1, y1) - halfW;
          if (d < 1) blend(x, y, col, clamp01(0.5 - d));
        }
      }
    }
  }

  // Filled polygon (ray casting, 3x3 supersampled for anti-aliased edges) — used for the sparkle.
  function pointInPoly(px, py, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      var hit = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }
  function filledPoly(poly, col) {
    var xs = poly.map(function (p) { return p[0]; }), ys = poly.map(function (p) { return p[1]; });
    var minX = Math.max(0, Math.floor(Math.min.apply(null, xs))), maxX = Math.min(S, Math.ceil(Math.max.apply(null, xs)));
    var minY = Math.max(0, Math.floor(Math.min.apply(null, ys))), maxY = Math.min(S, Math.ceil(Math.max.apply(null, ys)));
    var N = 3;
    for (var y = minY; y < maxY; y++) {
      for (var x = minX; x < maxX; x++) {
        var cov = 0;
        for (var sy = 0; sy < N; sy++) {
          for (var sx = 0; sx < N; sx++) {
            if (pointInPoly(x + (sx + 0.5) / N, y + (sy + 0.5) / N, poly)) cov++;
          }
        }
        if (cov > 0) blend(x, y, col, clamp01(cov / (N * N)));
      }
    }
  }

  // Content blueprint drawn in a 24-unit box, scaled + centered into this SxS canvas
  // (tighter scale for maskable so the M + sparkle stay inside the safe zone).
  var sc = opts.maskable ? 0.72 : 0.88;
  var k = (S / 24) * sc;
  var offX = (S - 24 * k) / 2;
  var offY = offX;
  function P(x, y) { return [offX + x * k, offY + y * k]; }

  var mPts = [P(5, 19), P(5, 7), P(12, 14), P(19, 7), P(19, 19)];
  thickPolyline(mPts, 1.15 * k, WHITE);

  var sparkPts = [P(19.4, 1.7), P(20, 3.4), P(21.7, 4), P(20, 4.6), P(19.4, 6.3), P(18.8, 4.6), P(17.1, 4), P(18.8, 3.4)];
  filledPoly(sparkPts, GOLD);

  return buf;
}

// ---- minimal PNG encoder (RGBA, 8-bit) ----
var CRC = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { var c = 0xFFFFFFFF; for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  var tb = Buffer.from(type, "ascii");
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function encodePNG(S, rgba) {
  var sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  var raw = Buffer.alloc(S * (S * 4 + 1));
  for (var y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
  }
  var idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

var here = __dirname;
function write(name, S, opts) {
  var png = encodePNG(S, render(S, opts));
  fs.writeFileSync(path.join(here, name), png);
  console.log("wrote", name, "(" + png.length + " bytes)");
}
write("icon-192.png", 192, {});
write("icon-512.png", 512, {});
write("maskable-512.png", 512, { maskable: true });
write("apple-touch-icon.png", 180, {});
