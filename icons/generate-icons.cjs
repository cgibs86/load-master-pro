/* Zero-dependency PNG icon generator for LoadMaster Pro.
 * Renders the brand thermometer mark at several sizes. Run: node generate-icons.js */
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

  var WHITE = [246, 251, 255], RED = [255, 91, 91];
  // content placement (tighter & centered for maskable safe zone)
  var yTop = (opts.maskable ? 0.27 : 0.22) * S;
  var cyb = (opts.maskable ? 0.67 : 0.74) * S;
  var sc = opts.maskable ? 0.85 : 1;
  var cx = 0.5 * S;
  var stemHalf = 0.047 * S * sc;
  var bulbR = 0.118 * S * sc;
  var mStemHalf = 0.024 * S * sc;
  var mTop = (opts.maskable ? 0.45 : 0.41) * S;
  var mBulbR = 0.080 * S * sc;

  function blend(x, y, col, a) {
    if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
    if (a > 1) a = 1;
    var i = (y * S + x) * 4;
    buf[i] = lerp(buf[i], col[0], a);
    buf[i + 1] = lerp(buf[i + 1], col[1], a);
    buf[i + 2] = lerp(buf[i + 2], col[2], a);
  }
  function capsule(halfW, top, bottom, col) {
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var d;
        if (y < top) d = Math.hypot(x - cx, y - top) - halfW;
        else if (y > bottom) continue; // bottom handled by bulb circle
        else d = Math.abs(x - cx) - halfW;
        blend(x, y, col, clamp01(0.5 - d)); // ~1px AA edge
      }
    }
  }
  function disc(ccx, ccy, rad, col) {
    var y0 = Math.max(0, Math.floor(ccy - rad - 1)), y1 = Math.min(S, Math.ceil(ccy + rad + 1));
    for (var y = y0; y < y1; y++) {
      for (var x = 0; x < S; x++) {
        var d = Math.hypot(x - ccx, y - ccy) - rad;
        if (d < 1) blend(x, y, col, clamp01(0.5 - d));
      }
    }
  }
  function tick(yc, w) {
    var x0 = cx + stemHalf + 0.022 * S, x1 = x0 + w, h = 0.013 * S;
    for (var y = Math.floor(yc - h); y <= yc + h; y++)
      for (var x = Math.floor(x0); x <= x1; x++) blend(x, y, WHITE, 0.95);
  }

  capsule(stemHalf, yTop, cyb, WHITE);
  disc(cx, yTop, stemHalf, WHITE);
  disc(cx, cyb, bulbR, WHITE);
  capsule(mStemHalf, mTop, cyb, RED);
  disc(cx, mTop, mStemHalf, RED);
  disc(cx, cyb, mBulbR, RED);
  if (!opts.maskable) {
    var tx = cx + stemHalf;
    [0.30, 0.355, 0.41, 0.465].forEach(function (f, idx) { tick(f * S, (idx % 2 ? 0.05 : 0.075) * S); });
  }

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
