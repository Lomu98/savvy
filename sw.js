// Service worker for "Savvy".
//
// - App shell (same-origin files): network-first with a short timeout, so
//   every deploy is picked up on the next load without having to bump a
//   version by hand; the cache is only the offline / slow-network fallback.
// - Versioned third-party assets (Firebase SDK modules, Google Fonts):
//   cache-first, since their URLs change whenever their content does.
//   Without these the app could not boot offline at all.
// - Everything else (Firestore, Auth, Google APIs) is never intercepted:
//   the Firebase SDK has its own offline cache.
//
// Bump the version only when this file's caching logic changes.
const SHELL_CACHE = "savvy-shell-v13";
const CDN_CACHE = "savvy-cdn-v1";
const NETWORK_TIMEOUT_MS = 3500;
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // If precaching fails the install fails too, and the browser retries on
  // the next visit: better than activating a worker with an empty cache.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL_CACHE, CDN_CACHE];
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => !keep.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

function isCacheableCdn(url) {
  return (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com";
}

// Opaque responses (no-cors stylesheet from fonts.googleapis.com) have
// status 0 but are still usable.
function isGoodResponse(res) {
  return res && (res.ok || res.type === "opaque");
}

function fetchWithTimeout(req) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS);
    fetch(req).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function networkFirst(req, cacheKey) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetchWithTimeout(req);
    if (res.ok) cache.put(cacheKey, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (isGoodResponse(res)) cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Navigations all map to the single page; other files to themselves.
    const cacheKey = req.mode === "navigate" ? "./index.html" : url.pathname;
    event.respondWith(networkFirst(req, cacheKey));
    return;
  }

  if (isCacheableCdn(url)) {
    event.respondWith(cacheFirst(req));
  }
});
