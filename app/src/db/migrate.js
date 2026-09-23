// 数据「补齐新键」迁移 + 打开失败分类
//
// 一、为什么要有这一层
//   Dexie 的版本机制能自动增删「表 / 索引」，但**不会**给旧记录补「后来新增的字段」。
//   例：students 的索引由 pinyinInit 改名 pinyin 之后，旧记录里只有 pinyinInit ——
//   按 pinyin 排序 / 查询时这些学生会查不到；记录若缺 del，更会直接从「在册记录」里消失
//   （IndexedDB 只索引有该键的记录）。
//   所以每次打开成功后做一次幂等补齐：**只给缺失的键写默认值，绝不改写已有值**。
//   以后再加字段，只需在下面的 RULES 里补一行，不用动库结构、也不用 bump 版本号。
//
// 二、打开失败为什么不再删库
//   原有三处「打开失败即删库重建」删掉的是**唯一正本**，且不区分故障类型：
//     · VersionError  = 库比代码新（旧代码遇到新数据）→ 该升级的是代码，删库是反向操作
//     · SecurityError = 浏览器禁用了本站存储（无痕 / 站点数据被拦截）→ 删了照样打不开
//     · 真结构损坏    = 只该「先抢救、再让用户决定」，永不自动删
//   本文件只做**分类**，不做任何删除。删库只保留为「用户显式点击 + 二次确认」的动作。

// 打开失败的三种类型（对外的选择器就这三个值）
export const DB_ERR_NEWER = 'newer';       // 数据比代码新 → 提示升级，绝不删
export const DB_ERR_BLOCKED = 'blocked';   // 存储被禁用 → 提示允许存储，删库无意义
export const DB_ERR_CORRUPT = 'corrupt';   // 读取异常 → 先抢救导出，再由用户决定

// 按错误名分类（Dexie / 原生 IndexedDB 抛的都是 DOMException，按 name 判最稳）
export function classifyDbError(e) {
  const n = (e && (e.name || (e.constructor && e.constructor.name))) || '';
  if (n === 'VersionError') return DB_ERR_NEWER;
  // MissingAPIError = 环境里根本没有 indexedDB；InvalidStateError = 同源策略/隐私模式下的拒开
  if (n === 'SecurityError' || n === 'MissingAPIError' || n === 'InvalidStateError') return DB_ERR_BLOCKED;
  return DB_ERR_CORRUPT;
}

// 带分类的打开失败错误：交给启动兜底页决定显示哪套文案
export class DbOpenError extends Error {
  constructor(dbName, kind, cause) {
    super(`数据库打开失败（${dbName}）：${(cause && cause.message) || cause || kind}`);
    this.name = 'DbOpenError';
    this.dbName = dbName;
    this.kind = kind;
    this.cause = cause;
  }
}

/* ---------- 补齐新键 ---------- */
// 值按「类型化的空」给：数组给 []、字符串给 ''、数值索引给 0（IndexedDB 不索引 null / undefined）
// 🔴 绝不写 null：del / out 这类是索引键，写 null 等于让记录从查询里消失（红线8）
const META_RULES = {
  semesters: { defaults: { status: 'active', startAt: 0 } }
};

const SEMESTER_RULES = {
  students: {
    defaults: { pinyin: '', out: 0, del: 0, pyManual: 0 },
    // v1 → v2：索引键由 pinyinInit 改名 pinyin，旧记录只有前者 —— 先搬过来再补空
    fix: r => { if (r.pinyin === undefined && r.pinyinInit !== undefined) r.pinyin = r.pinyinInit || ''; }
  },
  growth_records: {
    defaults: { del: 0, text: '', category: '', tags: [], imageIds: [], imgDescs: [] }
  },
  tags: { defaults: { del: 0, starred: 0, useCount: 0 } }
  // 🔴 以下表**不需要**补齐（都出生在 v2，不可能有缺键的旧记录），跳过它们还能避免
  //    每次启动把整个图片表（含照片）读一遍：images / collections / categories / templates
};

function emptyOf(v) { return Array.isArray(v) ? [] : (v && typeof v === 'object' ? { ...v } : v); }

const migrated = new WeakSet();   // 同一实例在一次会话里只补一次

async function normalizeStore(db, store, rule) {
  let rows;
  try { rows = await db.table(store).toArray(); } catch (_) { return 0; }   // 本库没这张表 → 跳过
  const fix = [];
  for (const src of rows) {
    const row = { ...src };
    if (rule.fix) rule.fix(row);
    let changed = false;
    for (const k in rule.defaults) {
      if (row[k] === undefined) { row[k] = emptyOf(rule.defaults[k]); changed = true; }
    }
    if (changed) fix.push(row);
  }
  if (!fix.length) return 0;
  try { await db.table(store).bulkPut(fix); } catch (_) { return 0; }
  return fix.length;
}

async function runRules(db, rules) {
  const report = {};
  for (const store in rules) {
    const n = await normalizeStore(db, store, rules[store]);
    if (n) report[store] = n;
  }
  return report;
}

// 返回补齐报告（{} = 没有记录需要补）；force 仅用于测试「再跑一次不写任何东西」
export async function migrateMeta(db, { force = false } = {}) {
  if (!db || (!force && migrated.has(db))) return null;
  migrated.add(db);
  return await runRules(db, META_RULES);
}

export async function migrateSemester(db, { force = false } = {}) {
  if (!db || (!force && migrated.has(db))) return null;
  migrated.add(db);
  return await runRules(db, SEMESTER_RULES);
}

// 打开成功后统一调用：任何补齐失败都不能拖垮启动（宁可少补一次，也不能打不开）
export async function migrateQuietly(db, which) {
  try {
    return which === 'meta' ? await migrateMeta(db) : await migrateSemester(db);
  } catch (e) { console.warn('数据补齐已跳过（不影响使用）', e); return null; }
}
