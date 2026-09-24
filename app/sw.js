// 班主任工作台 Service Worker（PWA 离线缓存）
// 🔴 关键：cache-first 会把旧 JS 永久缓存，导致修复后的代码刷不出来。
// 改成 network-first（在线取最新，离线回退缓存）+ 每次发版 bump CACHE 清除旧缓存。
const CACHE = 'bzr-v42';
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
  // 🔴 prompt 语义：安装完成**不**自动 skipWaiting，等新 SW 进入 waiting；
  // 仅当用户点「立即更新」→ main.js 发 SKIP_WAITING 消息才接管（§4.2/§4.3）
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
});

// 🔴 接收页面「立即更新」指令（§4.3）：放弃等待、立即激活新 SW，触发 controllerchange → 页面 reload
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  // 🔴 删除旧版本缓存（更早的 bzr-vN 等），避免残留旧 JS
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // 🔴 同源 App 资源一律带 no-cache 重新验证：托管平台（GitHub Pages）会给所有静态文件
  // 发 Cache-Control: max-age=600。默认的 network-first 仍可能被这层 HTTP 缓存挡住，
  // 出现「发版后最多 10 分钟还看到旧 JS」。no-cache = 每次回服务器校验（命中即 304，
  // 几乎不耗流量），保证拿到的一定是最新字节；离线时依旧回退 Cache Storage。
  const fresh = new URL(e.request.url).origin === self.location.origin ? { cache: 'no-cache' } : {};
  // network-first：在线永远取最新文件（修复即时生效），离线才回退缓存
  e.respondWith(
    fetch(e.request, fresh)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
