// Offline support + staying up to date with what's on GitHub, without reinstalling:
// - the app's own code (html, css, js, manifest) is network-first: online, every open gets the latest
//   (asked fresh from the server); offline or a slow connection (3s), the cached copy is used instead.
// - fonts and icons are cache-first and refreshed in the background (big, and rarely change).
// - when the app comes back from the background, the page asks for a "check": the code files are fetched
//   fresh and compared with the cached ones; if any changed, the page reloads onto the new version (start.js).
const VERSION = "stats-v116";
const CODE = ["./", "index.html", "style.css", "app.js", "demo.js", "settings.js", "welcome.js", "cloud.js", "start.js", "manifest.webmanifest"];
const FILES = [...CODE, "icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "../fonts/ia-writer-mono-latin-400-normal.ttf", "../fonts/ia-writer-mono-latin-700-normal.ttf", "../fonts/ia-writer-mono-latin-400-italic.ttf"];
const NETWORK_WAIT = 3000; // ms before giving up on the network and using the cached copy

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// the app's code: the page itself and .html / .js / .css / .webmanifest files
const isCode = (req) => req.mode === "navigate" || /\.(html|js|css|webmanifest)$/.test(new URL(req.url).pathname);

// fresh from the server (no-cache = check with the server, never a stale browser copy), else the cached one
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([
      fetch(req, { cache: "no-cache" }),
      new Promise((_, fail) => setTimeout(() => fail(new Error("slow")), NETWORK_WAIT)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

// the cached copy straight away, refreshed in the background for next time
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // only this site's own files: never cache other sites (the Supabase API must always be live)
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(isCode(e.request) ? networkFirst(e.request) : cacheFirst(e.request));
});

// "check" (sent by the page when it comes back into view): has any code file changed on the server?
// changed ones are cached, and the page is told so it can reload onto them
self.addEventListener("message", (e) => {
  if (e.data !== "check") return;
  e.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      let changed = false;
      for (const path of CODE) {
        try {
          const fresh = await fetch(path, { cache: "no-cache" });
          if (!fresh.ok) continue;
          const old = await cache.match(path);
          if (old && (await old.text()) === (await fresh.clone().text())) continue;
          await cache.put(path, fresh);
          if (old) changed = true; // (nothing cached yet = not an update)
        } catch {
          return; // offline: nothing to compare against
        }
      }
      if (changed && e.source) e.source.postMessage("updated");
    })()
  );
});
