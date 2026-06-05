import { createHash } from "node:crypto";
import { EMBEDDED_WEB_ASSET_VERSION } from "./web-ui/embedded-assets.js";

// 内容指纹派生 cache key，dev 迭代时磁盘改动即换 key，不用重启进程。
function buildCacheVersion(): string {
  return createHash("md5").update(EMBEDDED_WEB_ASSET_VERSION).digest("hex").slice(0, 8);
}

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
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
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
  const cacheVersion = buildCacheVersion();
  return `
const STATIC_CACHE = 'wand-static-${cacheVersion}';
const RUNTIME_CACHE = 'wand-runtime-${cacheVersion}';
const APP_SHELL = '/';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/vendor/wterm/terminal.css',
  '/vendor/wterm/wterm.bundle.js'
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
    cacheFirst(request).catch(async () => (await caches.match(APP_SHELL)) || Response.error())
  );
});
`;
}
