/**
 * Service Worker
 * アプリの外殻（HTML/CSS/JS）をキャッシュしてオフライン起動を可能にする。
 * データ本体は IndexedDB 側で保持するため、API通信はキャッシュしない。
 */
const CACHE = 'stock-pwa-v2';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  // GAS APIへの通信はキャッシュを挟まない
  if (req.url.includes('script.google.com') || req.url.includes('googleusercontent.com')) return;

  // ネットワーク優先。取得できたらキャッシュを更新し、失敗時のみキャッシュを返す。
  // （キャッシュ優先にすると、アプリを更新しても古いJSが配信され続けてしまう）
  // cache: 'no-store' で、ブラウザのHTTPキャッシュ（GitHub Pagesのmax-age=600）も
  // 迂回して必ずネットワークまで取りに行く。これが無いと、SWの仕組みとしては
  // ネットワーク優先のつもりでも、裏でHTTPキャッシュから古い応答が返り続けることがある。
  ev.respondWith(
    fetch(req, { cache: 'no-store' })
      .then(res => {
        if (res && res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
