/*
 * frame-os service worker (hand-written, no build step).
 *
 * Kept deliberately conservative for the ~Chrome 60 WebView: Promises,
 * async/await, fetch and Cache API are all supported there, but NO optional
 * chaining / nullish coalescing is used so this file ships as-is.
 *
 * Caching strategy:
 *   - app shell (navigation, index.html)  : network-first, fall back to cache
 *   - built assets (/assets/*, icons, …)  : cache-first (immutable, hashed)
 *   - photos (/.../photos/*)              : cache-first
 *   - manifest.json + entities JSON       : network-first, fall back to cache
 *   - cross-origin (Home Assistant, etc.) : passthrough (never cached here)
 */

var VERSION = "v1";
var SHELL_CACHE = "frame-os-shell-" + VERSION;
var ASSET_CACHE = "frame-os-assets-" + VERSION;
var PHOTO_CACHE = "frame-os-photos-" + VERSION;
var DATA_CACHE = "frame-os-data-" + VERSION;
var KEEP = [SHELL_CACHE, ASSET_CACHE, PHOTO_CACHE, DATA_CACHE];

// The scope is wherever this file is served from (e.g. "/local/frame/" in
// prod, "/" in dev) — never hardcode domain-root paths here.
self.addEventListener("install", function (event) {
  var scope = self.registration.scope;
  var shell = [scope, scope + "index.html", scope + "manifest.webmanifest"];
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(shell);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (KEEP.indexOf(key) === -1) return caches.delete(key);
        return Promise.resolve();
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isPhoto(url) {
  return url.pathname.indexOf("/photos/") !== -1;
}
function isManifest(url) {
  return url.pathname.lastIndexOf("manifest.json") !== -1;
}
function isEntities(url) {
  return url.pathname.lastIndexOf("entities.json") !== -1 ||
    url.pathname.lastIndexOf("mock-entities.json") !== -1;
}

// Re-wrap a cached Response with an X-From-Cache marker, so the app can tell
// it's showing last-known data (and flag it stale) even though the fetch
// resolved. Cloning the body is required to attach new headers.
async function markFromCache(response) {
  var headers = new Headers(response.headers);
  headers.set("X-From-Cache", "1");
  var body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers,
  });
}

async function fallback(cache, request, fallbackUrl) {
  var cached = await cache.match(request);
  if (cached) return markFromCache(cached);
  if (fallbackUrl) {
    var fb = await caches.match(fallbackUrl);
    if (fb) return markFromCache(fb);
  }
  return null;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  var cache = await caches.open(cacheName);
  try {
    var fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
      return fresh;
    }
    // A non-ok response (404/500, e.g. processor mid-rewrite or a server
    // hiccup) is NOT live data — prefer a good cached copy if we have one.
    var cachedOnErr = await fallback(cache, request, fallbackUrl);
    return cachedOnErr || fresh;
  } catch (err) {
    var cachedOnFail = await fallback(cache, request, fallbackUrl);
    if (cachedOnFail) return cachedOnFail;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  var cache = await caches.open(cacheName);
  var cached = await cache.match(request);
  if (cached) return cached;
  var fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url = new URL(request.url);
  var sameOrigin = url.origin === self.location.origin;

  // Navigation: keep the shell fresh, but survive offline reloads.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, self.registration.scope + "index.html"));
    return;
  }

  if (!sameOrigin) return; // let HA & other hosts go straight to network

  if (isManifest(url) || isEntities(url)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }
  if (isPhoto(url)) {
    event.respondWith(cacheFirst(request, PHOTO_CACHE));
    return;
  }
  // Built assets, icons, webmanifest, etc.
  event.respondWith(cacheFirst(request, ASSET_CACHE));
});
