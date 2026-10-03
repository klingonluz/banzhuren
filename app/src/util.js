// 通用小工具：零依赖、纯函数式、不碰任何业务状态
// 🔴 这几个函数原先在 data.js / export.js / record.js / class.js 里各写了一份（P2-4），
//    口径容易悄悄漂移（补零位数、下载的 charset、dataURL 失败处理），统一到这里。
export const pad = n => String(n).padStart(2, '0');

// 文件名时间戳（本地时区）：YYYY-MM-DD_HHmmss
// 🔴 所有导出 / 下载的文件名都带上它 —— 同一天连导两次也不会重名，
//    否则浏览器会静默存成「xxx (1).json」，老师回头看不知道哪份是哪份。
//    与 app/recover.html 里的 stamp() 同格式（那个页面刻意零依赖，不能 import 本模块）。
export function stamp(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

// 本地日期 → `<input type="date">` 认的 'YYYY-MM-DD'
// 🔴 一律按**本地时区**算：`toISOString()` 是 UTC，东八区早 8 点前会取成昨天
//    （真机表现 =「日期莫名其妙变成前一天」）。全项目这一处转换，别各写一份。
export function dateStr(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
}

// 'YYYY-MM-DD' → Date：刻意取**本地正午**。
// 🔴 别用 `Date.parse('2026-08-01')`：那按 UTC 解析，东八区 0–8 点会算成前一天，
//    8/1 边界当场测歪；也别取零点 —— 夏令时会把某些日期挤到前后一天。
//    这里只要「哪一天」，不要那一刻。非法输入返回 Invalid Date，由调用方判。
export function dateOfStr(s) {
  return new Date(String(s || '') + 'T12:00:00');
}

// 姓名是否合规：普通姓名 2~4 个汉字；**少数民族姓名允许含「·」且更长**（如「阿依古丽·买买提」）。
// 🔴 三个写入端（首装向导粘贴 / 名单批量导入 / 手加与改名）共用这一个口径，别各写一份
//    （旧版三处各判 `length >= 2 && length <= 4`，长名直接被拒）。
// ⚠️ 超过 4 字**必须含「·」**：这样既放得开少数民族姓名，又挡住「两行名字粘成一行」的常见错
//    （如「张梓涵李思远」7 个字无间隔号）。
export function validName(s) {
  const t = String(s == null ? '' : s).trim().replace(/\u3000/g, '');
  if (!/^[\u4e00-\u9fa5·]{2,20}$/.test(t)) return false;
  if (t.length <= 4) return true;
  return t.includes('·') && !t.startsWith('·') && !t.endsWith('·');
}

// 触发一次文件下载（Blob → <a download> 点击 → 回收 blob URL）
export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}

// Blob → dataURL（导出备份时把图片内联进 JSON）
// ⚠️ app/recover.html 里有一份同名实现：那个页面刻意零依赖（应用坏了也要能单独双击打开），
//    不能 import 本模块 —— 两处是刻意分开的，不是漏合并。
export function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

/* ---------- 导入文件分流 ---------- */
// 🔴 按**内容**判定，不看文件名（老师会改名、也可能存成 .txt）：
//    pack    = 整学期备份（有 records 数组）⇒ 走整学期还原
//    periods = 作息小文件（kind:'periods' + periods 数组）⇒ 只写当前学期的作息，其余一点不动
//    unknown = 不是本应用的文件（或结构不全）⇒ 明确报错，绝不动库
export function kindOfFile(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'unknown';
  if (obj.app !== '班主任工作台') return 'unknown';
  if (obj.kind === 'periods' && Array.isArray(obj.periods) && obj.periods.length) return 'periods';
  if (Array.isArray(obj.records)) return 'pack';
  return 'unknown';
}

// 两条记录「内容是否相同」—— 导入 / 捞回时判断"这一条到底缺不缺"
// 🔴 必须比内容，不能只比 id：同一条记录两边都被改过时 id 相同、内容不同，
//    只按 id 判会把它当"已存在"跳过 ⇒ **静默丢掉更新**（真实的丢数据）。
//    del 参与比较（回收站里的软删记录原样带过来，不复活）；updatedAt 是易变字段，故意忽略。
export function sameRecord(a, b) {
  if (!a || !b) return false;
  const norm = r => JSON.stringify([
    r.studentId || '', r.date || '', r.category || '', r.text || '',
    (r.tags || []).slice().sort(), (r.imageIds || []).slice().sort(),
    (r.imgDescs || []).filter(Boolean), r.del ? 1 : 0
  ]);
  return norm(a) === norm(b);
}

/* ---------- 学期名归一化 ---------- */
// 🔴 用途：导入时判断「本机已有的学期」和「备份里的学期」是不是**同一个**。
//    换手机 / 换网址（origin 变了）后，学期库 id **一定不同**，只按 id 认就会
//    把同一个学期当成新学期的 ⇒ 凭空多出一个学期，老师看到两份数据谁是谁都分不清。
//    老师各自表述习惯也不同：「2026-2027学年第一学期」/「2026—2027 学年度 第1学期」
//    /「2026~2027学年 第一学期」必须认成同一个。
// ⚠️ 只抹**格式差异**，**不做跨表述的语义翻译**：
//    「2026 春季学期」和「2026-2027 学年 第一学期」归一化后**故意不相等** ——
//    春天到底是哪个学年，代码猜不出来，也不能猜；这种情况交给老师当面确认（见 data.js::openRestore）。
export function normSemName(s) {
  let t = String(s || '');
  t = t.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); // 全角 → 半角
  t = t.replace(/\s+/g, '');                                        // 去掉所有空白
  t = t.replace(/[‐‑‒–—―ー~〜～~至]/g, '-');                          // 各种连字符 / 波浪 / 「至」
  t = t.replace(/[()（）【】\[\]〔〕〈〉<>《》「」『』]/g, '');           // 括号一律去掉
  t = t.replace(/学年度|学年|年度/g, '');                            // 「学年」可省略
  t = t.replace(/第?([一二三四1-4])个?学期/g, (m, d) => 's' + ({ 一: 1, 二: 2, 三: 3, 四: 4 }[d] || d));
  t = t.replace(/上学期/g, 's1').replace(/下学期/g, 's2');
  t = t.replace(/学期/g, '');                                        // 落单的「学期」
  t = t.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return t.toLowerCase();
}

// 拼标准学期名：`2026-2027 学年 第一学期`（新建学期只用这一种格式，老师不再自由输入）
export function semNameOf(startYear, term) {
  const y = Number(startYear);
  return `${y}-${y + 1} 学年 ${term === 2 ? '第二学期' : '第一学期'}`;
}

// 从学期名里解析出起始学年（认不出返回 null）。「2026-2027 学年 第一学期」→ 2026
export function semStartYear(name) {
  const t = String(name || '').replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  const m = t.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

// 当前学年（起始年份）：以 **8 月 1 日**为界 —— 8 月及以后算新学年，7 月及以前还属上一学年。
// 🔴 全项目只此一处算这个边界，别再各写一份（写岔了「默认学期」和「学年候选」会打架）。
// ⚠️ `d` 只为测试 / 探针注入日期用（一年只有一次 8/1，不注入就没法验边界）；正常调用不传。
function curStartYear(d = new Date()) {
  return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
}

// 今天落在哪个学期 —— 新建学期的**默认值**就取它（老师 2026-09-29 拍板）。
//   8/1 起 → 当年 … 次年 **第一学期**；8/1 前 → 上一年 … 当年 **第二学期**
// ❌ 不要用「当前学期的下一个」当默认：老师大多数时候要建的就是**眼下这个学期**，
//    尤其刚换手机 / 换网址、本机一个学期都没有时，按日期推才是他要的那个。
export function curSemName(d = new Date()) {
  const y = curStartYear(d);
  // 起始学年 == 当年 ⇒ 已过 8/1 ⇒ 第一学期；否则（起始学年是去年）⇒ 第二学期。
  // 刻意不再比一次 getMonth()：判据全部由 curStartYear() 给出，8/1 边界真的只有一处。
  return semNameOf(y, y === d.getFullYear() ? 1 : 2);
}

// 顺延到下一个学期：第一 → 第二；第二 → 下一学年第一
// 归档之后自动建下一个学期时用它（旧版写死 '新学期'，会造出一堆同名学期）
export function nextSemName(cur) {
  const s = String(cur || '');
  const y = semStartYear(s);
  if (y && /第二学期/.test(s)) return semNameOf(y + 1, 1);
  if (y && /第一学期/.test(s)) return semNameOf(y, 2);
  // 认不出格式（老数据 / 老师自己起的名）⇒ 按当前日期推一个
  return curSemName();
}

// 学期名 → 落在这个学期里的一天：第一学期 → 该学年 9/1，第二学期 → 次年 2/1。
// 用途：「新建学期」面板要把**默认学期**摆成日期输入框的值，日期与学期名就必须互相推得回来
//       （`curSemName(semDateOf(n)) === n`）—— 否则老师看到的日期和「将创建」会各说一个学期。
// ⚠️ 9/1 与 2/1 都稳稳落在该学期内（8/1 分界两侧各留了整整一个月），不是随便挑的日子。
// 认不出格式 / 年份离谱 ⇒ 回落到今天（调用方总能拿到一个合法日期，不会算出 NaN）。
export function semDateOf(name) {
  const y = semStartYear(name);
  if (!y || y < 2000 || y > 2100) return new Date();
  const t2 = /第二学期/.test(name);
  // ⚠️ 第二学期在**下一年的 2 月**（2026-2027 学年第二学期 = 2027-02-01），不是同年的 2 月
  return new Date(t2 ? y + 1 : y, t2 ? 1 : 8, 1);
}
