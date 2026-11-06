// Shiftbook service worker: keeps the app's own files for quick start-up and installability.
// API calls are never cached, so rosters, clock-ins and approvals are always live.
const CACHE = "shiftbook-5d81bd7aa7";
const SHELL = ["/", "/app.css?v=5d81bd7aa7", "/assets/app.js?v=5d81bd7aa7", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network first, so updates arrive straight away; the cache covers a dropped signal.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && SHELL.includes(url.pathname + url.search)) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("/"))));
});
