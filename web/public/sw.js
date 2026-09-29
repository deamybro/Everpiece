// Everpiece service worker — deliberately conservative (master §2.6).
// Caches ONLY immutable static build assets and icons. Never caches pages (including /c/* claim links whose
// secrets live in the #fragment), never touches cross-origin requests (relayer, claims server, RPC), never caches
// POST bodies, OTP responses or approvals.
const CACHE = "everpiece-static-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const cacheable = url.pathname.startsWith("/_next/static/") || /^\/icon-\d+\.png$/.test(url.pathname);
  if (!cacheable) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }),
  );
});
