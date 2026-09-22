// 生成 PWA PNG 图标（从 favicon.svg 的设计光栅化）
// 依赖本机已安装 Edge / Chrome（用无头模式截图），非功能代码，仅在需要重做图标时运行：
//   node scripts/make-icons.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const GREEN = '#2f9e44';

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const browser = BROWSERS.find(p => fs.existsSync(p));
if (!browser) { console.error('未找到 Edge / Chrome，无法光栅化图标'); process.exit(1); }

// radius: 圆角半径占边长比（0 = 直角全幅，iOS / maskable 用）；glyph: 字号占边长比
const TARGETS = [
  { out: 'icons/icon-192.png',             size: 192, radius: 0.219, glyph: 0.547 },
  { out: 'icons/icon-512.png',             size: 512, radius: 0.219, glyph: 0.547 },
  { out: 'icons/icon-maskable-512.png',    size: 512, radius: 0,     glyph: 0.42  },
  { out: 'apple-touch-icon.png',           size: 180, radius: 0,     glyph: 0.50  }
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bzr-icons-'));
const profile = path.join(tmp, 'profile');

const html = (size, radius, glyph) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  svg{display:block;width:${size}px;height:${size}px}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <rect width="512" height="512" rx="${radius * 512}" fill="${GREEN}"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle"
        font-family="-apple-system,Segoe UI,Microsoft YaHei,sans-serif"
        font-size="${glyph * 512}" font-weight="700" fill="#fff">班</text>
</svg></body></html>`;

for (const t of TARGETS) {
  const outAbs = path.join(APP, t.out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const page = path.join(tmp, path.basename(t.out) + '.html');
  fs.writeFileSync(page, html(t.size, t.radius, t.glyph));
  if (fs.existsSync(outAbs)) fs.unlinkSync(outAbs);
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${t.size},${t.size}`,
    `--user-data-dir=${profile}`,
    `--screenshot=${outAbs}`,
    '--default-background-color=00000000',
    'file:///' + page.replace(/\\/g, '/')
  ], { stdio: 'ignore', timeout: 60000 });

  const b = fs.existsSync(outAbs) ? fs.readFileSync(outAbs) : null;
  const dim = b && b.slice(1, 4).toString() === 'PNG' && b.slice(12, 16).toString() === 'IHDR'
    ? b.readUInt32BE(16) + 'x' + b.readUInt32BE(20) : null;
  console.log(`${t.out}  →  ${dim || 'FAILED'}  (${b ? b.length : 0} B)`);
  if (dim !== `${t.size}x${t.size}`) process.exitCode = 1;
}

fs.rmSync(tmp, { recursive: true, force: true });
