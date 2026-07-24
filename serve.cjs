/* LoadMaster Pro — zero-dependency static dev server.
 * Serves the repo root (the app) so you can run the PWA locally with
 * a single command (`npm start`). No external packages required.
 *
 *   PORT=8099 node serve.cjs        (PORT defaults to 8099)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8099;

// Pro permit-search endpoint (server-side; keeps the API key off the client).
const permits = require("./api/permit-search.cjs");

function readJsonBody(req) {
  return new Promise(function (resolve) {
    var raw = "";
    req.on("data", function (c) {
      raw += c;
      if (raw.length > 1e6) { req.destroy(); resolve({}); } // ~1MB guard
    });
    req.on("end", function () {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on("error", function () { resolve({}); });
  });
}

function sendJson(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

const server = http.createServer(function (req, res) {
  // Strip query string, default "/" to index.html.
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  // API route: Pro permit & code search.
  if (urlPath === "/api/permit-search") {
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "Use POST." });
    }
    return readJsonBody(req).then(function (body) {
      return permits.permitSearch(body);
    }).then(function (result) {
      sendJson(res, result && result.ok ? 200 : 200, result); // app handles ok:false in-band
    }).catch(function (err) {
      sendJson(res, 500, { ok: false, error: "server_error", message: String(err && err.message || err) });
    });
  }

  if (urlPath === "/") urlPath = "/index.html";

  // Resolve safely inside ROOT (no path traversal).
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found: " + urlPath);
    }
    const type = TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

server.listen(PORT, function () {
  console.log("\n  LoadMaster Pro running:  http://localhost:" + PORT + "\n");
  console.log("  Serving: " + ROOT);
  console.log("  Press Ctrl+C to stop.\n");
});
