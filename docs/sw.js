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

const CACHE_VERSION = "film-beamer-v35-settings-cleanup";
const CACHE_PREFIX = "film-beamer-";

// Path prefix that the in-page player uses to fetch Drive video bytes via
// us. Requests look like `/_drive_proxy/<fileId>` and we transparently
// rewrite them into `drive/v3/files/<id>?alt=media` with the page-supplied
// OAuth bearer token attached. This is the only way to make a regular
// `<video src="...">` element play an authenticated Drive file — the
// browser will not let us set an Authorization header on a media element
// directly. By keeping it same-origin, the standard Range/seek/byte-range
// logic the browser already implements just works.
const DRIVE_PROXY_PREFIX = "/_drive_proxy/";

// Stash of Drive bearer tokens keyed by `driveKey` (currently a single
// `"current"` slot; mapped per-mode in case we later want SA + OAuth
// side-by-side). Refreshed by the page on a timer; the SW does not refresh
// tokens itself because the page already owns the OAuth/JWT machinery.
const driveTokens = new Map();

// Things that change every release — must come from network when possible.
// We still keep them in cache as an offline fallback.
const SHELL_LIVE = [
  "./",
  "./index.html",
  "./style.css",
  "./tailwind.css",
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

// ---------- Drive proxy ----------

// Pulls the Bearer token out of our stash. Returns null if the page hasn't
// pushed one yet (in which case the player should show a "press play to
// authenticate" hint rather than firing requests we'll just 401 on).
function getDriveToken() {
  return driveTokens.get("current") || null;
}

// Forwards a same-origin `/_drive_proxy/<fileId>` request to the real
// Drive API. We deliberately preserve the `Range` header so the browser's
// video element can seek freely without us having to implement byte-range
// logic ourselves — Drive's `alt=media` honours Range for both binary
// uploads and converted exports.
async function proxyDriveRequest(request, fileId) {
  const token = getDriveToken();
  if (!token) {
    return new Response(
      "Drive token not set. Open the playback panel and grant access.",
      {
        status: 401,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }
    );
  }
  // `supportsAllDrives=true` so Shared Drive files work transparently.
  // `acknowledgeAbuse=true` is required by Drive to download files it has
  // flagged as "potentially abusive" (any large binary, basically).
  const target =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?alt=media&supportsAllDrives=true&acknowledgeAbuse=true`;
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  let res;
  try {
    res = await fetch(target, { method: "GET", headers, cache: "no-store" });
  } catch (err) {
    return new Response(
      `Drive fetch failed: ${err && err.message ? err.message : err}`,
      {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }
    );
  }
  // Strip Google-specific cookies / CORS headers that aren't useful here
  // and add an explicit Accept-Ranges so HTMLMediaElement reliably enables
  // its scrub-bar even when Drive sometimes omits it.
  const outHeaders = new Headers();
  for (const [k, v] of res.headers.entries()) {
    if (/^set-cookie|^x-goog/i.test(k)) continue;
    outHeaders.set(k, v);
  }
  if (!outHeaders.has("Accept-Ranges")) outHeaders.set("Accept-Ranges", "bytes");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Service workers only intercept GETs by default, but let's be explicit so
  // POST/PUT/DELETE traffic to the GitHub / Google APIs is never touched.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Same-origin Drive proxy — turn /_drive_proxy/<id> into an authenticated
  // Drive download. Must be checked BEFORE the cross-origin pass-through.
  if (isSameOrigin(url) && url.pathname.startsWith(DRIVE_PROXY_PREFIX)) {
    const fileId = decodeURIComponent(
      url.pathname.slice(DRIVE_PROXY_PREFIX.length)
    );
    if (!fileId) {
      event.respondWith(new Response("Missing file id", { status: 400 }));
      return;
    }
    event.respondWith(proxyDriveRequest(req, fileId));
    return;
  }

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
  if (data.type === "DRIVE_TOKEN") {
    // The page just refreshed the Drive bearer token. We store it for the
    // /_drive_proxy/ fetch handler to use on subsequent requests. We do not
    // attempt to refresh tokens ourselves — the page owns OAuth/JWT.
    if (typeof data.token === "string" && data.token) {
      driveTokens.set("current", data.token);
    } else {
      driveTokens.delete("current");
    }
    return;
  }
  if (data.type === "DRIVE_TOKEN_CLEAR") {
    // Account boundary: the page just logged the user out (or signed in
    // as someone else). Drop any cached Drive bearer so an in-flight
    // /_drive_proxy/* request can't reuse the previous identity's
    // token. The next playback attempt will trigger a fresh DRIVE_TOKEN
    // push from the page.
    driveTokens.clear();
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
