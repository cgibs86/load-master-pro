/* LoadMaster Pro — offline service worker */
var CACHE = "loadmaster-v4";
var ASSETS = [
  "./",
  "./index.html",
  "./app.html",
  "./auth.html",
  "./landing.css",
  "./styles.css",
  "./app.js",
  "./loadcalc.js",
  "./climate-data.js",
  "./permits-data.js",
  "./climate-engine.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Network-first for live API calls (geocoding / climate / property); never cache those.
  if (url.hostname.indexOf("nominatim") !== -1 || url.hostname.indexOf("rentcast") !== -1 || url.hostname.indexOf("open-meteo") !== -1) {
    e.respondWith(fetch(req).catch(function () { return new Response("{}", { headers: { "Content-Type": "application/json" } }); }));
    return;
  }

  // Cache-first for app shell, with background refresh.
  e.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && url.origin === location.origin) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
