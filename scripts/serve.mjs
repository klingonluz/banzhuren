// 零依赖本地预览服务器：把 app/ 作为静态站点跑起来
// 用法：npm run serve   （默认 http://localhost:8123/，可 PORT=8080 覆盖）
// 说明：Service Worker / IndexedDB 需要 http(s) 来源，直接 file:// 打开 index.html 无法注册 SW。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = normalize(join(HERE, '..', '..', 'app'));
const PORT = Number(process.env.PORT || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const fp = normalize(join(ROOT, pathname));
    if (!fp.startsWith(ROOT)) { res.writeHead(403).end('403'); return; }
    const buf = await readFile(fp);
    // 🔴 sw.js 用 no-store：Service Worker 脚本一旦被浏览器钉在 HTTP 缓存里，
    // 用户就永远检查不到新版本。其余文件 no-cache（每次都回服务端校验）足够。
    const isSw = pathname.endsWith('/sw.js');
    res.writeHead(200, {
      'Content-Type': MIME[extname(fp).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': isSw ? 'no-store' : 'no-cache'
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}).listen(PORT, () => {
  console.log(`\n  班主任工作台 · 本地预览\n  http://localhost:${PORT}/\n\n  （Ctrl+C 结束）\n`);
});
