// Minimal service worker required for PWA installation trigger
const CACHE_NAME = 'aetherplayer-v1';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  // Pass-through fetch directly to server, avoiding caching issues for dynamic music playback
  event.respondWith(fetch(event.request));
});
