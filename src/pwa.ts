/**
 * PWA manifest and Service Worker generation.
 */

export function generatePwaManifest(): string {
  return JSON.stringify({
    id: "/wand",
    scope: "/",
    lang: "zh-CN",
    dir: "ltr",
    name: "Wand Console",
    short_name: "Wand",
    description: "Local CLI Console for Vibe Coding",
    start_url: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    background_color: "#f6f1e8",
    theme_color: "#c5653d",
    orientation: "any",
    prefer_related_applications: false,
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
    categories: ["developer tools", "productivity"],
    shortcuts: [
      {
        name: "New Session",
        url: "/?action=new",
        description: "Start a new CLI session",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
      },
    ],
  });
}

export function generateServiceWorker(): string {
  return `
const STATIC_CACHE = 'wand-static-v6';
const RUNTIME_CACHE = 'wand-runtime-v6';
const APP_SHELL = '/';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/vendor/xterm/css/xterm.css',
  '/vendor/xterm/lib/xterm.js',
  '/vendor/xterm-addon-fit/lib/addon-fit.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && request.method === 'GET') {
    const clone = response.clone();
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, clone);
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(APP_SHELL, clone));
          return response;
        })
        .catch(async () => (await caches.match(APP_SHELL)) || Response.error())
    );
    return;
  }

  event.respondWith(
    cacheFirst(request).catch(async () => {
      const cached = await caches.match(request);
      return cached || (await caches.match(APP_SHELL)) || Response.error();
    })
  );
});
`;
}

