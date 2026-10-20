/*
 * sw.js — робота без інтернету.
 * Спочатку пробуємо взяти файл з мережі (щоб оновлення одразу підхоплювались),
 * а якщо мережі немає — беремо збережену копію. Після першого відкриття пульт працює офлайн.
 */
const CACHE = 'init-stm-v1';
const FILES = [
  './', './index.html', './style.css', './app.js', './ble.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
