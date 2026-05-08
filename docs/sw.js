"use strict";

// =============================================================================
// Film Beamer — Service Worker
// -----------------------------------------------------------------------------
// Strategy:
//   * Bump CACHE_VERSION whenever shell assets change. Browsers will pick up
//     the new SW in the background, install it, and notify the page (via
//     `controllerchange` + an `SW_VERSION` postMessage). The page then shows
//     the "Доступна новая версия" banner; the user clicks it and we
//     `skipWaiting()` immediately.
//   * **Network-first** for navigation requests and the live document shell
//     (HTML, app.js, style.css, manifest). This is the fix for the long-
//     standing complaint that "old version loads after deploy". We always
//     try the network first; only if it fails do we fall back to cache.
//   * **Stale-while-revalidate** for the vendor bundle and icons. Those
//     change rarely, so it's safe to serve them from cache while we
//     background-refresh.
//   * Never cache cross-origin requests (GitHub API, Google APIs, CDN
//     fallbacks). Those need fresh data every time and would silently break
//     auth flows if cached.
//   * Listen for `{ type: "SKIP_WAITING" }` messages so the page can promote
//     the waiting worker on demand. Listen for `{ type: "GET_VERSION" }` so
//     diagnostics in the page can show which SW is running.
// =============================================================================

const CACHE_VERSION = "film-beamer-v26-search-killers";
const CACHE_PREFIX = "film-beamer-";

// Things that change every release — must come from network when possible.
// We still keep them in cache as an offline fallback.
const SHELL_LIVE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
];

// Static assets — change rarely, safe to serve from cache while revalidating.
const SHELL_STATIC = [
  "./icon.svg",
  "./icon-maskable.svg",
  "./vendor/libsodium-sumo.min.js",
  "./vendor/libsodium-wrappers.min.js",
];

const PRECACHE_URLS = [...SHELL_LIVE, ...SHELL_STATIC];

const NAV_TIMEOUT_MS = 4500;

// ---------- helpers ----------

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isLiveAsset(pathname) {
  // Anything in the live shell list. Also covers the bare `./` path which
  // maps to `index.html`.
  return SHELL_LIVE.some((p) => {
    const clean = p.replace(/^\.\//, "/");
    if (clean === "/") return pathname.endsWith("/");
    return pathname.endsWith(clean) || pathname === clean;
  });
}

function isVendorAsset(pathname) {
  return /\/vendor\//.test(pathname) || /\.svg$/.test(pathname);
}

async function broadcastVersion() {
  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  for (const client of clients) {
    client.postMessage({ type: "SW_VERSION", version: CACHE_VERSION });
  }
}

// Race the network against a timer. If the network wins, return the response
// AND drop the fresh copy into cache. If the timer wins (or fetch throws),
// fall back to whatever's in cache.
async function networkFirst(request, cache) {
  const cached = await cache.match(request, { ignoreSearch: false });
  let timeoutId;
  const networkPromise = fetch(request, { cache: "no-store" }).then((res) => {
    if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  });
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), NAV_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([networkPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    if (res) return res;
    if (cached) return cached;
    return await networkPromise;
  } catch (err) {
    clearTimeout(timeoutId);
    if (cached) return cached;
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Offline</title>` +
        `<style>body{font-family:system-ui;padding:2rem;max-width:36rem;margin:auto;color:#e2e8f0;background:#0b0d14}</style>` +
        `<h1>Сеть недоступна</h1>` +
        `<p>Офлайн-копия страницы тоже не нашлась в кеше. Подключись к интернету и обнови вкладку.</p>` +
        `<p style="opacity:.6">Версия SW: <code>${CACHE_VERSION}</code></p>`,
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

// Serve from cache immediately if present; in parallel hit the network and
// update the cache for next time. Falls back to network-only if no cache.
async function staleWhileRevalidate(request, cache) {
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
        cache.put(request, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }
  const fresh = await networkPromise;
  if (fresh) return fresh;
  return new Response("", { status: 504 });
}

// ---------- install ----------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // cache: "reload" bypasses the HTTP cache so we always precache the
      // freshest shell bytes, not whatever the browser had stored.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const req = new Request(url, { cache: "reload" });
            const res = await fetch(req);
            if (res && res.ok) await cache.put(req, res.clone());
          } catch (err) {
            // Best-effort: a missing precache URL shouldn't block install.
            console.warn("[sw] precache failed:", url, err);
          }
        })
      );
      // Note: we do NOT call skipWaiting() automatically anymore. The page
      // shows a banner and asks the user to confirm — this avoids the
      // mid-session flicker where forms reset because the controller
      // changed under the user's feet.
    })()
  );
});

// ---------- activate ----------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Wipe any old caches that share our prefix but aren't the active one.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
      await broadcastVersion();
    })()
  );
});

// ---------- fetch ----------

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Service workers only intercept GETs by default, but let's be explicit so
  // POST/PUT/DELETE traffic to the GitHub / Google APIs is never touched.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin requests pass through untouched. This includes the GitHub
  // API, Google Drive API, OAuth, libsodium CDN fallback, jsdelivr.
  if (!isSameOrigin(url)) return;

  // Navigation requests (top-level HTML loads) → network-first. This is the
  // single biggest UX fix vs. the previous SW: deploys are now visible on
  // the very next reload, no more "old site after update".
  if (req.mode === "navigate") {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) => networkFirst(req, cache))
    );
    return;
  }

  // Live shell assets (app.js, style.css, manifest, index.html) → also
  // network-first. Same reason as above.
  if (isLiveAsset(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) => networkFirst(req, cache))
    );
    return;
  }

  // Vendor bundles + icons → stale-while-revalidate. These rarely change,
  // and serving instantly from cache is good for perceived perf.
  if (isVendorAsset(url.pathname)) {
    event.respondWith(
      caches
        .open(CACHE_VERSION)
        .then((cache) => staleWhileRevalidate(req, cache))
    );
    return;
  }

  // Anything else same-origin → stale-while-revalidate as a safe default.
  event.respondWith(
    caches
      .open(CACHE_VERSION)
      .then((cache) => staleWhileRevalidate(req, cache))
  );
});

// ---------- messages from the page ----------

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "SKIP_WAITING") {
    // The page told us the user accepted the update. Promote the waiting
    // worker now; `controllerchange` on the page will then trigger a reload.
    self.skipWaiting();
    return;
  }
  if (data.type === "GET_VERSION") {
    // Diagnostics panel asked which version is live.
    if (event.source && event.source.postMessage) {
      event.source.postMessage({
        type: "SW_VERSION",
        version: CACHE_VERSION,
      });
    }
    return;
  }
  if (data.type === "PURGE_CACHE") {
    // Diagnostics → "Очистить кеш и перезагрузить".
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX))
            .map((k) => caches.delete(k))
        );
        if (event.source && event.source.postMessage) {
          event.source.postMessage({
            type: "CACHE_PURGED",
            version: CACHE_VERSION,
          });
        }
      })()
    );
    return;
  }
});
