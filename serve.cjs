/* BTU.ai — zero-dependency static dev server.
 * Serves the repo root (the app) so you can run the PWA locally with
 * a single command (`npm start`). No external packages required.
 *
 *   PORT=8099 node serve.cjs        (PORT defaults to 8099)
 *
 * Also hosts:
 *   /api/permit-search   — Pro permit & code research (Claude + web search)
 *   /api/metrics/*       — ops metrics engine (see api/metrics.cjs)
 *   /dashboard           — the BTU.ai Ops control board (dashboard.html)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8099;

// Pro permit-search endpoint (server-side; keeps the API key off the client).
const permits = require("./api/permit-search.cjs");
// Ops metrics engine (request log, client telemetry, system health).
const metrics = require("./api/metrics.cjs");

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
  const started = process.hrtime.bigint();
  // Strip query string, default "/" to index.html.
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  // Measure response time + bytes for the request log.
  res.on("finish", function () {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const len = Number(res.getHeader("content-length")) || 0;
    metrics.logRequest(req, res, ms, len);
  });

  // ---- API: ops metrics ----
  if (urlPath.indexOf("/api/metrics/") === 0) {
    const done = req.method === "POST"
      ? readJsonBody(req).then(function (body) { return metrics.handleApi(urlPath, req, res, body); })
      : Promise.resolve(metrics.handleApi(urlPath, req, res, null));
    return done.catch(function (err) {
      sendJson(res, 500, { ok: false, error: "server_error", message: String(err && err.message || err) });
    });
  }

  // ---- API: Pro permit & code search ----
  if (urlPath === "/api/permit-search") {
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "Use POST." });
    }
    const t0 = Date.now();
    let reqBody = null;
    return readJsonBody(req).then(function (body) {
      reqBody = body;
      return permits.permitSearch(body);
    }).then(function (result) {
      metrics.logPermit(result, Date.now() - t0, reqBody, null);
      sendJson(res, 200, result); // app handles ok:false in-band
    }).catch(function (err) {
      metrics.logPermit({ ok: false, error: "server_error", message: String(err && err.message || err) }, Date.now() - t0, null, null);
      sendJson(res, 500, { ok: false, error: "server_error", message: String(err && err.message || err) });
    });
  }

  // ---- Friendly dashboard URL ----
  if (urlPath === "/dashboard" || urlPath === "/dashboard/") urlPath = "/dashboard.html";

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

// Helper for the permit error path above (elapsed since request start).
server.listen(PORT, "0.0.0.0", function () {
  console.log("\n  BTU.ai running:  http://localhost:" + PORT);
  console.log("  Ops dashboard:   http://localhost:" + PORT + "/dashboard");
  console.log("  Serving: " + ROOT);
  console.log("  Press Ctrl+C to stop.\n");
  metrics.logBoot();
});
