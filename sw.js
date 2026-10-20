// Lost Memories service worker: the app works offline from its cached shell; posters are cached as they load.
const SHELL = 'lm-shell-v4';
const IMAGES = 'lm-img-v1';
const FILES = ['./', './index.html', './theme.css', './theme.js', './app.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];
const IMAGE_HOSTS = ['s4.anilist.co', 'm.media-amazon.com', 'static.tvmaze.com',
  'fonts.googleapis.com', 'fonts.gstatic.com'];          // fonts too, so the app looks the same offline

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== IMAGES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.includes('/api/')) return;           // PC preview data: always live
    // network first for the shell (updates arrive at once), cache when offline
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
  } else if (IMAGE_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(IMAGES).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }))));
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => list.length ? list[0].focus() : self.clients.openWindow('./')));
});
