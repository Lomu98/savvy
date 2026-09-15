// Service worker for "Savvy" — caches the static app shell so the UI
// still opens when offline or on a flaky connection. The data itself
// (Firestore) has its own offline cache handled by the Firebase SDK.
// Bump CACHE_NAME on any shell change to force clients onto new files.
const CACHE_NAME = "savvy-shell-v1";
const SHELL_FILES = [
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
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {
        // Best-effort: a single missing file shouldn't block install.
      })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Network-first for navigations (always try to get the latest app),
// falling back to the cached shell when offline. Cache-first for the
// static shell assets themselves. Everything else (Firebase/Firestore/
// Google Auth requests) is left alone — never intercepted.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  if (SHELL_FILES.some((f) => url.pathname.endsWith(f.replace("./", "/")))) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
  }
});
