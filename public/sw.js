// App-shell service worker. The build (vite.config.ts) replaces BUILD_ID and PRECACHE in the copy
// under dist/. In dev this file is served as is and never registered.
const BUILD_ID = "dev";
const PRECACHE = ["./", "index.html", "manifest.webmanifest"];

const CACHE_PREFIX = "will-it-fly-";
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME)
            .map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Same-origin URLs (origin + pathname) of everything precached, resolved against the scope.
const PRECACHED = new Set(
  PRECACHE.map((entry) => {
    const url = new URL(entry, self.registration.scope);
    return url.origin + url.pathname;
  }),
);

/**
 * Fetches `request`, and caches a copy of an ok response. The caching is tied to the event with
 * `waitUntil` so it can't be cut short.
 */
function fetchAndCache(event, request) {
  const network = fetch(request);
  event.waitUntil(
    network
      .then((response) => {
        if (!response.ok) return undefined;
        // Clone now, before the page starts reading the body.
        const copy = response.clone();
        return caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      })
      .catch(() => {}),
  );
  return network;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Everything cross-origin (including Open-Meteo) passes straight through.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetchAndCache(event, request).catch(async () => {
        const cached =
          (await caches.match(request, { ignoreSearch: true })) ||
          (await caches.match("index.html")) ||
          (await caches.match("./"));
        return cached || Response.error();
      }),
    );
    return;
  }

  // Precached files (icons, manifest, hashed assets) and anything else under /assets/: cache first.
  if (PRECACHED.has(url.origin + url.pathname) || url.pathname.includes("/assets/")) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetchAndCache(event, request)),
    );
  }
});
