// The offline shell, served from /sw.js.
//
// It is a route rather than a file in public/ so the cache name can carry the
// build ID. A deploy therefore changes the worker's own bytes, which is what
// makes the browser install it, drop every cache from the previous build, and
// take over - no stale bundle can outlive a deployment.
//
// Everything but the content-addressed /assets/ files is network-first, so the
// kiosk Pis still see a new build the moment the snapshot's build ID stops
// matching theirs. The cache is what a display falls back to when its wifi
// drops, not what it reads from normally.

const script = `
const CACHE = 'hub-${__BUILD_ID__}';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Restarting the process and fetching the worker itself must always be live.
  if (url.pathname === '/api/exit' || url.pathname === '/sw.js') return;
  event.respondWith(respond(request, url));
});

async function respond(request, url) {
  const cache = await caches.open(CACHE);

  // Build assets are content-addressed: the name changes when the bytes do.
  if (url.pathname.startsWith('/assets/')) {
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  }

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const hit =
      (await cache.match(request)) ||
      (request.mode === 'navigate' ? await cache.match('/') : undefined);
    if (hit) return hit;
    throw error;
  }
}
`;

export function loader() {
  return new Response(script, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    },
  });
}
