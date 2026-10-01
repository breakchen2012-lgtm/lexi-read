/* 精读 LexiRead —— Service Worker
   应用外壳：预缓存 + stale-while-revalidate
   离线词典：cache-first（2.9MB，装一次就够了）
   AI 接口与外部抓取：直连网络，永不缓存           */

const VERSION = 'lexiread-v5';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/db.js',
  './src/dict.js',
  './src/ai.js',
  './src/srs.js',
  './src/tts.js',
  './src/text.js',
  './src/ui.js',
  './src/unzip.js',
  './src/importers.js',
  './src/sync.js',
  './config.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.svg',
];
// 词典单独预缓存：首次加载时 SW 还没接管，之后应用都从 IndexedDB 读，
// 不主动预热的话 SW 缓存里永远没有它。失败不影响安装。
const PREWARM = ['./data/dict.json'];
const DICT = './data/dict.json';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.map(u =>
      c.add(new Request(u, { cache: 'reload' })).catch(() => {})
    ));
    await Promise.all(PREWARM.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(req, cache) {
  const hit = await cache.match(req);
  const fetching = fetch(req).then(res => {
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return hit || (await fetching) || new Response('', { status: 504, statusText: 'Offline' });
}

async function cacheFirst(req, cache) {
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 跨域（AI 接口、网址抓取）一律直连
  if (url.origin !== self.location.origin) return;

  // 词典：cache-first，并且请求时去掉 cache-buster 保证命中
  if (url.pathname.endsWith('/data/dict.json')) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      return cacheFirst(new Request(url.origin + url.pathname), cache);
    })());
    return;
  }

  // 导航请求：网络优先，离线回退到外壳
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req);
        cache.put('./index.html', res.clone()).catch(() => {});
        return res;
      } catch {
        return (await cache.match('./index.html')) || (await cache.match('./')) ||
          new Response('离线', { status: 503 });
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    return staleWhileRevalidate(req, cache);
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
