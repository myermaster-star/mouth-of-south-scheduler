/* Mouth of the South LLC — service worker
   Caches the app shell so it launches instantly and survives a flaky signal.
   The live appointment data (/api/*) is ALWAYS fetched from the network so
   the calendar and the Telegram bot stay in sync — it is never cached. */
const CACHE = "mots-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache the API or anything that isn't a GET — always go to network.
  if (e.request.method !== "GET" || url.pathname.startsWith("/api")) return;
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request)
        .then((resp) => {
          if (resp && resp.ok && url.origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match("./index.html"))
    )
  );
});
