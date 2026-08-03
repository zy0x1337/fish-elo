/* Aqua Elo service worker.
 *
 * Three caches, three strategies:
 *   shell   — app shell, precached on install, cache-first with a background refresh.
 *   photos  — fish photos, cache-first and capped (they never change under their name).
 *   api     — read-only GET endpoints, stale-while-revalidate so the app opens offline.
 *
 * Vote and matchup requests are never cached: a matchup token is single-use, and a
 * replayed vote would be rejected by the server anyway.
 */

const VERSION = 'v1';
const SHELL = `aqua-shell-${VERSION}`;
const PHOTOS = `aqua-photos-${VERSION}`;
const API = `aqua-api-${VERSION}`;

const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/manifest.webmanifest',
    '/icons/favicon.svg',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
];

// GET endpoints worth keeping a copy of; everything else under /api goes to the network.
const CACHEABLE_API = ['/api/rankings', '/api/daily', '/api/elo-info', '/api/stats'];
// Full photos and the 106 small thumbnails share this cache; the headroom keeps a
// rankings sweep from evicting the photos a voter just looked at.
const PHOTO_CACHE_LIMIT = 240;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    const keep = new Set([SHELL, PHOTOS, API]);
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('message', (event) => {
    if (event.data === 'skip-waiting') self.skipWaiting();
});

async function trimCache(name, limit) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
}

async function cacheFirst(request, cacheName, limit) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) {
        await cache.put(request, response.clone());
        if (limit) trimCache(cacheName, limit);
    }
    return response;
}

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    const network = fetch(request)
        .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
        })
        .catch(() => null);
    if (hit) return hit;
    const fresh = await network;
    return fresh || new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // Navigations: try the network so a deploy lands quickly, fall back to the shell.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(() => caches.match('/index.html', { ignoreSearch: true })),
        );
        return;
    }

    if (url.pathname.startsWith('/images/') || url.pathname.startsWith('/icons/')) {
        event.respondWith(cacheFirst(request, PHOTOS, PHOTO_CACHE_LIMIT));
        return;
    }

    if (url.pathname.startsWith('/api/')) {
        if (CACHEABLE_API.includes(url.pathname)) {
            event.respondWith(staleWhileRevalidate(request, API));
        }
        return;
    }

    // Shell assets are unhashed, so serve the copy we have and refresh it in the
    // background — a deploy then lands on the next load without bumping VERSION.
    event.respondWith(staleWhileRevalidate(request, SHELL));
});
