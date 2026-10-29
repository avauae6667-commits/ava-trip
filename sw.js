/* ============================================================
   AVA Fleet — service worker
   • precaches the whole app shell so it opens with no signal
   • cache-first for the app files, network-only for the Google API
   • Background Sync: if the app is closed when the signal returns,
     the phone wakes this worker and the queue is uploaded anyway
   Change CACHE when you change any file below.
   ============================================================ */
importScripts("./db.js", "./sync.js");

const CACHE = "ava-fleet-4.2.0";
const CORE = [
  "./driver.html", "./driver-app.js", "./db.js", "./sync.js",
  "./config.js", "./manifest.json", "./icon-192.png", "./icon-512.png"
];
const EXTRA = [
  "./index.html", "./admin.html", "./admin-manifest.json",
  "./admin-icon-192.png", "./admin-icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE.map(u => new Request(u, { cache: "reload" })));            // all-or-nothing
    await Promise.all(EXTRA.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // API goes to network

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (_) {
      if (req.mode === "navigate") {
        const fb = await cache.match(url.pathname.endsWith("admin.html") ? "./admin.html" : "./driver.html");
        if (fb) return fb;
      }
      return Response.error();
    }
  })());
});

/* ---- Background Sync -------------------------------------------------- */
async function flushFromWorker() {
  const meta = k => AVA_DB.metaGet(k, "");
  const [apiUrl, token] = await Promise.all([meta("apiUrl"), meta("token")]);
  if (!apiUrl || !token) return true;                 // nobody signed in: nothing to do
  const res = await AVA_SYNC.flush({ apiUrl, token });
  if (res.sent) {
    await AVA_DB.metaSet("lastSync", new Date().toISOString());
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: "SYNCED", sent: res.sent, remaining: res.remaining }));
  }
  // Throw to ask the browser to retry later. A permanent auth problem is not
  // retryable from the worker — the driver has to sign in again.
  if (res.auth) return true;
  if (res.remaining > 0 && res.waiting > 0) throw new Error("still-pending");
  return true;
}

self.addEventListener("sync", e => {
  if (e.tag === "ava-upload") e.waitUntil(flushFromWorker().catch(() => {}));
});

self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "FLUSH") {
    e.waitUntil(flushFromWorker().catch(() => {}));
  }
});
