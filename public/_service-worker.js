// Minimal no-op service worker to prevent 404 errors
// AI Studio injects a service worker registration script — this file must exist.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
