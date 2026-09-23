// 发版号一键递增（npm run bump）
// 改完 app/ 下的 js / css / html 后跑一次，做两件事：
//   ① app/sw.js 的 CACHE 版本号 +1（清掉旧缓存，否则使用者一直看到旧版）
//   ② 三套测试里断言的同名版本号字符串同步改掉（漏改一处 npm test 就红）
// 用法：npm run bump            当前数字 +1
//       node scripts/bump-cache.mjs 25   显式指定（一般不用）
// 说明：测试目录已移出仓库（本机默认在仓库同级的 dev/tests）。找不到测试目录时，
//       只递增 app/sw.js 的版本号并提示，不报错——这样别人 clone 仓库后跑 bump 也不会炸。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(ROOT, 'app', 'sw.js');
const TEST_FILES = ['check3.mjs', 'check14.mjs', 'check16.mjs', 'check18.mjs'];
const RE = /bzr-v(\d+)/g;

// 测试目录探测顺序：环境变量 BZR_TESTS → 仓库同级 dev/tests → 仓库内 tests
const TESTS_DIR = [
  process.env.BZR_TESTS,
  path.join(ROOT, '..', 'dev', 'tests'),
  path.join(ROOT, 'tests')
].filter(Boolean).find(d => fs.existsSync(path.join(d, 'check3.mjs'))) || null;

const swSrc = fs.readFileSync(SW, 'utf8');
const m = /const CACHE = 'bzr-v(\d+)'/.exec(swSrc);
if (!m) {
  console.error("✗ app/sw.js 里找不到 const CACHE = 'bzr-vN'，请检查该行是否被改动");
  process.exit(1);
}

const oldN = Number(m[1]);
const arg = process.argv[2];
const newN = arg ? Number(arg) : oldN + 1;
if (!Number.isInteger(newN) || newN <= oldN) {
  console.error(`✗ 目标版本号不合法：${arg}（必须是不小于 ${oldN + 1} 的整数）`);
  process.exit(1);
}
const OLD = 'bzr-v' + oldN;
const NEW = 'bzr-v' + newN;

// 先全部读进内存 + 校验，全部通过才写盘（避免改一半留烂摊子）
const plan = [];
// sw.js 只改 const CACHE 那一行：注释里若出现别的版本号字样，不该被顺带改掉
const SW_RE = /const CACHE = 'bzr-v\d+'/g;
const swHits = (swSrc.match(SW_RE) || []).length;
if (swHits !== 1) {
  console.error(`✗ app/sw.js 里的 CACHE 赋值出现 ${swHits} 处（应为 1 处），请先检查`);
  process.exit(1);
}
plan.push([SW, swSrc.replace(SW_RE, `const CACHE = '${NEW}'`), swHits]);

let bad = 0;
if (!TESTS_DIR) {
  console.log('· 未找到测试目录（本机默认在仓库同级的 dev/tests），本次只递增 app/sw.js 的版本号。');
} else {
  for (const f of TEST_FILES) {
    const p = path.join(TESTS_DIR, f);
    const src = fs.readFileSync(p, 'utf8');
    const hits = (src.match(RE) || []).length;
    if (!hits) {
      console.error(`✗ ${f} 里找不到版本号字符串，测试断言可能被改动过，请先检查`);
      bad++;
      continue;
    }
    plan.push([p, src.replace(RE, NEW), hits]);
  }
}
if (bad) {
  console.error('\n已中止，未写任何文件。');
  process.exit(1);
}

for (const [p, content] of plan) fs.writeFileSync(p, content);

console.log(`✓ 发版号 ${OLD} → ${NEW}`);
console.log('  已同步这些文件的版本号字符串：');
for (const [p, , hits] of plan) {
  console.log(`    ${path.relative(ROOT, p).split(path.sep).join('/')}  （${hits} 处）`);
}
console.log('\n接着在 dev/ 目录跑 npm test（必须全绿），再提交推送。');
