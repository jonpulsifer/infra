// The shell is cached so the app opens without the network; the counter's
// state never is, because a stale number is worse than no number. Every
// answer refreshes the cache, so a new deploy wins on the first load online.
const SHELL = "smiirl-shell";
const ASSETS = ["/", "/icon.svg", "/icon.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => e.waitUntil(Promise.all([
  self.clients.claim(),
  caches.keys().then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n)))),
])));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) {
      const copy = r.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("/"))));
});
