// Offline support: always fetch the latest pages when online, fall back to the cache when not.
// Database traffic (supabase.co) is never cached; the sync layer handles offline edits.
const CACHE = "alfred-v4";
const SHELL = ["./", "index.html", "ledger.html", "focus.html", "shutdown.html",
  "js/sync.js", "js/shell.js", "js/compat-db.js", "js/config.js", "js/vendor/supabase-2.45.4.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Network first, so a new version shows up straight away; the cache is only the offline fallback.
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    try {
      const res = await fetch(e.request, { cache: "no-cache" });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  }));
});
