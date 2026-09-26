// 班主任工作台 Service Worker（PWA 离线缓存）
// 取数策略：cache-first（命中缓存立即返回，消除「加载中」白屏）。
// 安全性由「每次发版 bump CACHE 桶号」保证：新桶 install 时 addAll 重新拉全量资源，
// 旧桶在 activate 阶段被清掉，因此不会出现「旧 JS 永久缓存」问题。仅 2xx 响应写缓存。
const CACHE = 'bzr-v44';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './favicon.svg', './recover.html',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './apple-touch-icon.png',
  './src/styles.css', './src/main.js', './src/state.js', './src/ui.js', './src/util.js', './src/pinyin.js', './src/privacy.js', './src/export.js', './src/archive.js',
  './src/db/meta.js', './src/db/semester.js', './src/db/seed.js', './src/db/rescue.js', './src/db/migrate.js',
  './src/tabs/record.js', './src/tabs/class.js', './src/tabs/analysis.js', './src/tabs/data.js',
  './vendor/dexie.min.js'
];

self.addEventListener('install', e => {
  // 安装完成**不**自动 skipWaiting，等新 SW 进入 waiting；
  // 仅当用户点「立即更新」→ main.js 发 SKIP_WAITING 消息才接管（§4.2/§4.3）
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
});

// 接收页面「立即更新」指令（§4.3）：放弃等待、立即激活新 SW，触发 controllerchange → 页面 reload
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  // 删除旧版本缓存（更早的 bzr-vN 等），避免残留旧 JS
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // 只接管同源 App 资源；跨域请求（如外部 CDN）交给浏览器默认处理
  if (new URL(e.request.url).origin !== self.location.origin) return;
  // cache-first：命中缓存零网络等待 → 打开即渲染，无白屏；
  // 未命中才回源，且仅缓存 2xx（避免把 404/500 写进缓存永久服务）。
  // 离线时一律回退到已缓存的 index.html。
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
