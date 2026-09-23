// 隐私与脱敏：本模块是「AI 外发口」的唯一实现（方案 §2.12）
// 🔴 三层边界：记录端规范（源头治理）→ 本地库（永不出设备）→ AI 输出（唯一外发口）
// 🔴 只产出「脱敏姓名 + 必要文字」；图片绝不参与任何输出。
// 🔴 一次性代号：单次会话作用域、不落库、不跨次复用、映射本身不外发。
// 本模块是纯函数（不碰 DOM、不碰数据库），便于单测与环境复用。

/* ---------- 禁止 / 允许拍摄清单（记录页与设置页共用同一份文案） ---------- */
export const PHOTO_BAN = [
  '学生的正面、侧脸（人脸属生物识别信息）',
  '集体照、合影',
  '穿着校服、胸前有姓名牌的合影',
  '背景里出现名单 / 座位表 / 成绩表 / 他人的作业署名',
  '含家庭环境的画面'
];
export const PHOTO_OK = [
  '作业、试卷（先去姓名栏）',
  '手工作品、绘画、书法',
  '作文、手抄报',
  '作品特写'
];

/* ---------- 一次性代号 ---------- */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const OTHER = '某同学';                        // 他人的泛称
export const MASK = { score: '〔分数〕', rank: '〔名次〕' };

/** 第 i 个代号：0 → 同学A，25 → 同学Z，26 → 同学AA */
export function aliasOf(i) {
  const n = Math.max(0, i | 0);
  if (n < 26) return '同学' + LETTERS[n];
  return '同学' + LETTERS[Math.floor(n / 26) - 1] + LETTERS[n % 26];
}

/**
 * 生成一次性代号映射：Map<studentId, 代号>
 * 🔴 只在内存中存在，调用方负责「用完即弃」——不写库、不写任何本地存储、不复制到剪贴板。
 */
export function buildAliasMap(students) {
  const m = new Map();
  (students || []).forEach((s, i) => m.set(s.id, aliasOf(i)));
  return m;
}

const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 🔴 中文姓名后常跟「同学 / 老师 / 家长」，替换时一并吃掉，避免出现「同学A同学」
const withSuffix = name => new RegExp(escRe(name) + '(?:同学|老师|小朋友)?', 'g');

/* ---------- 核心：逐条脱敏 ---------- */
/**
 * 把一段文字里「不该外发」的信息去掉。
 * @param {string} text  原始文字
 * @param {object} o
 *   o.selfName 本条记录所属学生的真名 → 换成代号
 *   o.names    全班在册姓名（用于把提到的他人姓名泛称为「某同学」）
 *   o.alias    本条的代号（如「同学A」）
 *   o.grain    日期粒度：'month'（默认，粗化到月）| 'full'（保留完整日期）
 * @returns {{text:string, hits:{name:number,score:number,rank:number,date:number}}}
 */
export function scrubText(text, o = {}) {
  const hits = { name: 0, score: 0, rank: 0, date: 0 };
  let out = String(text == null ? '' : text);
  if (!out) return { text: '', hits };
  const alias = o.alias || '同学';

  // ① 日期：必须最先做——否则「2026-09-22」里的数字会被后面的分数 / 名次规则切碎
  if (o.grain !== 'full') {
    out = out.replace(/\d{4}-(\d{1,2})-\d{1,2}/g, (_m, mo) => { hits.date++; return `${+_m.slice(0, 4)}年${+mo}月`; });
    out = out.replace(/(\d{1,2})月\d{1,2}[日号]/g, (_m, mo) => { hits.date++; return `${+mo}月`; });
    out = out.replace(/\d{4}年(\d{1,2})月\d{1,2}[日号]/g, (_m, mo) => { hits.date++; return `${+_m.slice(0, 4)}年${+mo}月`; });
  }

  // ② 人名：本人 → 代号；他人 → 泛称（长名优先，避免「张梓」先于「张梓涵」被切开）
  const self = String(o.selfName || '').trim();
  if (self.length >= 2) out = out.replace(withSuffix(self), () => { hits.name++; return alias; });
  const others = (o.names || [])
    .map(n => String(n || '').trim())
    .filter(n => n.length >= 2 && n !== self)
    .sort((a, b) => b.length - a.length);
  for (const n of others) out = out.replace(withSuffix(n), () => { hits.name++; return OTHER; });

  // ③ 分数 / 名次：一律打码，不给任何开关（这两类不参与 AI 输出）
  out = out.replace(/((?:得分|满分|平均分|总分|分数|成绩)\s*[:：]?\s*)\d+(?:\.\d+)?/g,
    (_m, head) => { hits.score++; return head + MASK.score; });
  // 排除「3分钟 / 分享 / 分录 / 分配 / 隔分」等非成绩用法
  out = out.replace(/\d+(?:\.\d+)?\s*分(?![钟享录配隔类解析布积])/g,
    () => { hits.score++; return MASK.score; });
  out = out.replace(/第\s*\d+\s*名/g, () => { hits.rank++; return MASK.rank; });
  out = out.replace(/第\s*[一二三四五六七八九十]+\s*名/g, () => { hits.rank++; return MASK.rank; });
  out = out.replace(/(?:名次|排名)\s*[:：]?\s*(?:第\s*)?\d+/g, () => { hits.rank++; return MASK.rank; });

  return { text: out, hits };
}

/* ---------- 组装 AI 外发素材（多学生合集） ---------- */
/**
 * @param {Array} students 本次纳入的学生（在册，按选定顺序 → 代号顺序）
 * @param {Array} recs     已按需过滤好的记录
 * @param {object} o
 *   o.aliasMap  buildAliasMap 的结果
 *   o.names     全班在册姓名（他人泛称用）
 *   o.grain     日期粒度
 *   o.rawOf     r => 该条记录的原始正文（含标签与评语，不含图片）
 */
export function buildScrubbedText(students, recs, o = {}) {
  const { aliasMap = new Map(), names = [], grain = 'month', rawOf = r => r.text || '' } = o;
  const byStu = new Map();
  for (const r of recs) {
    if (!byStu.has(r.studentId)) byStu.set(r.studentId, []);
    byStu.get(r.studentId).push(r);
  }
  const hits = { name: 0, score: 0, rank: 0, date: 0 };
  const L = [];
  L.push('【学生成长记录 · 已脱敏素材】');
  L.push('说明：以下姓名为一次性代号，仅在本次使用内有效，与本班真实姓名无任何对应关系；');
  L.push('      分数、名次、具体日期与他人姓名均已隐去；不含任何照片。');
  L.push(`本次覆盖：${students.length} 名学生 · ${recs.length} 条记录`);
  L.push('='.repeat(28));

  let used = 0;
  for (const st of students) {
    const arr = (byStu.get(st.id) || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!arr.length) continue;
    used++;
    const alias = aliasMap.get(st.id) || '同学';
    L.push('');
    L.push(`【${alias}】共 ${arr.length} 条`);
    for (const r of arr) {
      const out = scrubText(rawOf(r), { selfName: st.name, names, alias, grain });
      hits.name += out.hits.name; hits.score += out.hits.score;
      hits.rank += out.hits.rank; hits.date += out.hits.date;
      L.push('  - ' + out.text);
    }
  }
  return { text: L.join('\n'), hits, used };
}

/** 命中统计 → 一行可读文案（给老师看「做了什么」） */
export function describeHits(h) {
  const p = [];
  if (h.name) p.push(`姓名 ${h.name} 处`);
  if (h.score) p.push(`分数 ${h.score} 处`);
  if (h.rank) p.push(`名次 ${h.rank} 处`);
  if (h.date) p.push(`日期 ${h.date} 处`);
  return p.length ? p.join(' · ') : '未发现需要隐去的内容';
}

/* ---------- 记录端实时提示（源头治理，事前 > 事后） ---------- */
/**
 * 写评语时即时提醒，而不是等外发时再打码。
 * @param {string} text  评语
 * @param {Array}  names 全班在册姓名（调用方需排除当前学生本人）
 * @returns {Array<{kind:string, word:string, tip:string}>}
 */
export function lintText(text, names = []) {
  const t = String(text || '');
  const out = [];
  if (!t.trim()) return out;
  const sc = /(?:得分|满分|平均分|总分|分数|成绩)\s*[:：]?\s*\d+/.exec(t)
    || /\d+(?:\.\d+)?\s*分(?![钟享录配隔类解析布积])/.exec(t);
  if (sc) out.push({ kind: 'score', word: sc[0], tip: '分数属于成绩信息，建议不写进评语（外发时会自动隐去）' });
  const rk = /第\s*\d+\s*名/.exec(t) || /第\s*[一二三四五六七八九十]+\s*名/.exec(t) || /(?:名次|排名)\s*[:：]?\s*(?:第\s*)?\d+/.exec(t);
  if (rk) out.push({ kind: 'rank', word: rk[0], tip: '名次属于成绩信息，建议不写进评语（外发时会自动隐去）' });
  const hit = (names || []).filter(n => { const s = String(n || '').trim(); return s.length >= 2 && t.includes(s); });
  if (hit.length) out.push({ kind: 'name', word: hit.join('、'), tip: `提到了其他同学的姓名，建议改成「同学 / 同伴 / 小组」` });
  return out;
}

/** 预览高亮：把命中的片段包成 <mark>（输入已 esc，调用方保证） */
export function highlight(escaped, patterns) {
  let out = String(escaped || '');
  for (const p of patterns || []) {
    if (!p) continue;
    out = out.replace(new RegExp(escRe(p), 'g'), m => `<mark>${m}</mark>`);
  }
  return out;
}
