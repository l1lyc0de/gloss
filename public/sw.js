// Gloss · Service Worker
//
// 策略：应用本身走网络优先（联网就拿最新版，顺手缓存），离线时退回缓存 ——
// 「随时能读」不该被网络状况卡住。
// 词典分片走缓存优先：它们内容不变，而且是查词秒出的关键，能命中就绝不走网络。
// /api/ 的同步请求永远直连，离线时自然失败，由页面里的同步逻辑悄悄重试。
const VERSION = 'v2';
const SHELL = 'gloss-shell-' + VERSION;
const DICT = 'gloss-dict-v1';   // 和 dict.js 里的 CACHE_NAME 保持一致
const SHELL_FILES = [
  '/', '/index.html', '/manifest.webmanifest', '/icon.svg',
  '/css/app.css',
  '/js/app.js', '/js/store.js', '/js/db.js', '/js/dict.js',
  '/js/util.js', '/js/text.js', '/js/epub.js', '/js/pdf.js', '/js/vocab.js',
  '/js/html.js', '/js/doc.js',
  '/vendor/fflate.min.js', '/vendor/pdf.min.mjs', '/vendor/pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DICT).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/dict/')) {
    e.respondWith(
      caches.open(DICT).then((c) =>
        c.match(e.request).then((hit) =>
          hit || fetch(e.request).then((res) => {
            if (res.ok) c.put(e.request, res.clone());
            return res;
          })
        )
      )
    );
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});
