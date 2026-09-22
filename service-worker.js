/* LoadMaster Pro AI — offline service worker */
var CACHE = "loadmasterproai-v27";
var ASSETS = [
  "./",
  "./index.html",
  "./app.html",
  "./auth.html",
  "./landing.css",
  "./styles.css",
  "./app.js",
  "./loadcalc.js",
  "./ai-providers.js",
  "./photo-ai.js",
  "./config.js",
  "./thinking.js",
  "./sw-register.js",
  "./climate-data.js",
  "./permits-data.js",
  "./climate-engine.js",
  "./energy-engine.js",
  "./room-loads.js",
  "./price-book.js",
  "./rebate-iq.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
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

/*
 * Freshness strategy.
 *
 * This used to be cache-first for everything, which meant every deploy was a
 * visit behind: the old copy was served immediately and the new one only
 * landed in the cache for NEXT time. A pricing change that the server was
 * already serving correctly still showed the old prices in the browser, which
 * is exactly the failure that motivated this rewrite.
 *
 * So: code (documents, JS, CSS, the manifest) is NETWORK-FIRST with a short
 * timeout and a cache fallback. Online, you always get what the server has.
 * Offline or on a bad driveway connection, the timeout trips and the cached
 * copy answers, so the app still opens and still works.
 *
 * Images and icons stay cache-first — they are large, they rarely change, and
 * bumping CACHE re-fetches them wholesale on the next install.
 */
var NETWORK_TIMEOUT_MS = 3500;

function isCodeRequest(req, url) {
  if (req.mode === "navigate") return true;
  if (url.origin !== location.origin) return false;
  return /\.(?:html|js|css|webmanifest)$/i.test(url.pathname) || url.pathname.endsWith("/");
}

// Network, but never hang: if it hasn't answered by the timeout, whatever is
// in the cache answers instead. A slow network must not beat no network.
function networkFirst(req, url) {
  return caches.match(req).then(function (cached) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(res) { if (!settled) { settled = true; resolve(res); } }

      var timer = cached ? setTimeout(function () { done(cached); }, NETWORK_TIMEOUT_MS) : null;

      fetch(req).then(function (res) {
        if (timer) clearTimeout(timer);
        if (res && res.status === 200 && url.origin === location.origin) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        done(res);
      }).catch(function () {
        if (timer) clearTimeout(timer);
        // Offline: the cache answers, and a navigation with nothing cached
        // for that exact URL still gets the app shell rather than an error.
        if (cached) return done(cached);
        if (req.mode === "navigate") {
          return caches.match("./app.html").then(function (shell) {
            done(shell || Response.error());
          });
        }
        done(Response.error());
      });
    });
  });
}

function cacheFirst(req, url) {
  return caches.match(req).then(function (cached) {
    if (cached) return cached;
    return fetch(req).then(function (res) {
      if (res && res.status === 200 && url.origin === location.origin) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Live API calls (geocoding / climate / property / AI); never cached.
  // Note: every AI provider call the app makes is a POST, and this handler
  // already returns above for anything but GET, and only ever writes to cache
  // for same-origin requests — so this hostname list isn't load-bearing for AI
  // calls (including a user-supplied "custom" endpoint, whatever its hostname
  // is). It's kept as documentation of intent and a safety net for any future
  // GET-based AI call.
  if (url.hostname.indexOf("nominatim") !== -1 || url.hostname.indexOf("rentcast") !== -1 || url.hostname.indexOf("open-meteo") !== -1 ||
      url.hostname.indexOf("nationalmap.gov") !== -1 ||
      url.hostname.indexOf("anthropic") !== -1 || url.hostname.indexOf("openai") !== -1 ||
      url.hostname.indexOf("googleapis") !== -1 || url.hostname.indexOf("perplexity") !== -1) {
    e.respondWith(fetch(req).catch(function () { return new Response("{}", { headers: { "Content-Type": "application/json" } }); }));
    return;
  }

  e.respondWith(isCodeRequest(req, url) ? networkFirst(req, url) : cacheFirst(req, url));
});
