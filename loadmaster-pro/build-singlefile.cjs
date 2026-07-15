/* Builds a single self-contained HTML file (inlined CSS + JS + icon) so the
 * app can be opened directly from a phone with no server. PWA install/offline
 * are disabled in this preview build (they require hosting over HTTPS). */
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let html = read("index.html");
const css = read("styles.css");
const js = ["climate-data.js", "loadcalc.js", "app.js"].map(read).join("\n;\n");
const iconB64 = fs.readFileSync(path.join(dir, "icons/icon-192.png")).toString("base64");
const iconData = "data:image/png;base64," + iconB64;

// Inline stylesheet.
html = html.replace(/<link rel="stylesheet" href="styles\.css" \/>/, "<style>\n" + css + "\n</style>");
// Drop manifest + SVG favicon links; point apple-touch + icon at the inlined PNG.
html = html.replace(/<link rel="manifest"[^>]*>\s*/, "");
html = html.replace(/<link rel="icon"[^>]*>\s*/, '<link rel="icon" href="' + iconData + '" />\n  ');
html = html.replace(/<link rel="apple-touch-icon"[^>]*>/, '<link rel="apple-touch-icon" href="' + iconData + '" />');
// The Pro permit search needs the server endpoint, which the single-file
// offline preview can't reach — drop its script so the preview stays standalone.
html = html.replace(/\s*<script src="permits\.js"><\/script>/, "");
// Replace the three external scripts with one inline bundle.
html = html.replace(/\s*<script src="climate-data\.js"><\/script>\s*<script src="loadcalc\.js"><\/script>\s*<script src="app\.js"><\/script>/,
  "\n  <script>\n" + js + "\n  </script>");

const outName = "LoadMaster-Pro-preview.html";
fs.writeFileSync(path.join(dir, "..", outName), html);
console.log("wrote", outName, "(" + html.length + " bytes)");
