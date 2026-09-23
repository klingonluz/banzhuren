// 学期库（每学期一个独立 IndexedDB 数据库）
// V11.1 数据层：图片移入学期库；新增 categories / collections；tasks → collections
const Dexie = window.Dexie;
import { classifyDbError, DB_ERR_CORRUPT, DbOpenError, migrateQuietly } from './migrate.js';

const cache = new Map();

// 构造学期库实例（每次都用全新 Dexie，避免复用损坏实例）
// 🔴 版本号迁移：v1=旧版(五育) schema（用于良好旧库的增量升级），v2=V11.1 完整 schema，v3=V11.13 简化。
function buildDb(semesterId) {
  const db = new Dexie('bzr_' + semesterId);
  // 红线1：分页用 offset().limit() / [del+date] 索引，禁止 toArray() 拉全表
  // 红线8：del 用 0，不用 null（IndexedDB 不索引 null）
  db.version(1).stores({
    students:       'id, name, pinyinInit, out, del',
    growth_records: 'id, studentId, date, category, del',
    tags:           'id, name, category, starred, del',
    tasks:          'id, name, amount, paidIds',
    schedule:       'id'
  });
  db.version(2).stores({
    students:       'id, name, pinyin, out, del',
    growth_records: 'id, studentId, date, category, del, [del+date], [studentId+date]',
    categories:     'id, cat, kind, del',          // 能力分类（ability）/ 关注（internal），全部可编辑
    tags:           'id, name, category, starred, del',   // 标签库（70 预设 + 自定义）
    templates:      'id, name, category, starred, del',   // 记录模板（V11.13 已整表移除）
    images:         'imageId, updatedAt, del',      // 🔴 图片在学期库（随归档一起删）
    collections:    'id, name',                     // 收缴单（临时态，不进备份）
    schedule:       'id',                            // 课表（单行 json）
    tasks:          null                             // 旧 tasks 表移除（→ collections）
  });
  // 🔴 v3（V11.13 简化三处）：
  //    ① templates 整表移除 —— 功能从没落地（无 UI 入口、记录里的 templateId 零读取），留着只是每次备份多导一张空表；
  //    ② images 去掉 del 索引 —— deleteImage 一直是硬删除，del 永远为 0，索引恒真且白占空间；
  //    ③ growth_records 增 [del+category+date] —— 分类筛选从此走索引分页，不再把整个分类拉进内存再 sort/slice。
  //    ⚠️ 改 stores() 必须同时 bump Dexie 版本号：否则 Dexie 抛 SchemaError，会被 classifyDbError 归到
  //    「corrupt」档显示兜底页（数据其实没坏，老师却以为坏了）。只加字段不用 bump，交给 migrate.js 补默认值。
  db.version(3).stores({
    growth_records: 'id, studentId, date, category, del, [del+date], [studentId+date], [del+category+date]',
    images:         'imageId, updatedAt',
    templates:      null                             // 需要记录模板时再加回来
  });
  return db;
}

export function openSemester(semesterId) {
  if (cache.has(semesterId)) return cache.get(semesterId);
  const db = buildDb(semesterId);
  cache.set(semesterId, db);
  return db;
}

// 🔴 打开学期库：v1→v2 由 Dexie 自动升级（保留学生/记录，仅增删 store）；
// 打开失败**绝不删库**，只按错误类型分流后抛 DbOpenError（详见 meta.js / migrate.js 的说明）。
// 打开成功后跑一次「补齐新键」：旧记录缺 pinyin / del / tags 等新键时写默认值。
export async function ensureOpen(db, semesterId) {
  try {
    await db.open();
  } catch (e) {
    try { db.close(); } catch (_) {}
    const kind = classifyDbError(e);
    if (kind === DB_ERR_CORRUPT) {
      try { const { rescueFromCorrupt } = await import('./rescue.js'); await rescueFromCorrupt('bzr_' + semesterId, semesterId); } catch (_) {}
    }
    throw new DbOpenError('bzr_' + semesterId, kind, e);
  }
  await migrateQuietly(db, 'semester');   // 旧记录缺新键 → 补默认值（幂等）
  return db;
}

export function closeSemester(semesterId) {
  if (cache.has(semesterId)) {
    cache.get(semesterId).close();
    cache.delete(semesterId);
  }
}
export async function deleteSemester(semesterId) {
  closeSemester(semesterId);
  await Dexie.delete('bzr_' + semesterId);
}

// ---------- 学生 ----------
// 在册学生（默认不含已转出）
// 🔴 转出 = 学生已离开本班 → 不再出现在「选学生 / 收缴点名 / 未记录待办 / 统计分母」里；
//    他的成长记录仍留在库中（作为纪念），在「管理名单」里仍可见、随时可转回。
//    includeOut: true 只用于需要看到全部人的场合：回显姓名 / 导出备份 / 导入校验 / 管理名单。
export async function listStudents(db, { includeOut = false } = {}) {
  const rows = await db.students.where('del').equals(0).toArray();
  return includeOut ? rows : rows.filter(s => !s.out);
}

// 一次性补齐拼音首字母：只补「没写过 / 算出来不一样」且未被手工改过的（pyManual）
export async function backfillPinyin(db) {
  const { nameInitials, pinyinSupported } = await import('../pinyin.js');
  if (!pinyinSupported()) return 0;
  const rows = await db.students.where('del').equals(0).toArray();
  const fix = [];
  for (const s of rows) {
    if (s.pyManual) continue;
    const py = nameInitials(s.name);
    if (py && py !== s.pinyin) fix.push({ ...s, pinyin: py });
  }
  if (fix.length) await db.students.bulkPut(fix);
  return fix.length;
}
export async function bulkPutStudents(db, rows) {
  await db.students.bulkPut(rows);
}

// ---------- 成长记录 ----------
// rec: { id, studentId, date, category, text, tags[], imageIds[], imgDescs[], updatedAt, del:0 }
export async function addRecord(db, rec) {
  await db.growth_records.put(rec);
}
export async function getRecord(db, id) {
  return await db.growth_records.get(id);
}
// 时间线分页（红线1）：[del+date] 索引倒序
export async function listRecordsPage(db, { offset = 0, limit = 20 } = {}) {
  return await db.growth_records
    .where('[del+date]')
    .between([0, Dexie.minKey], [0, Dexie.maxKey])
    .reverse()
    .offset(offset)
    .limit(limit)
    .toArray();
}
export async function countActiveRecords(db) {
  return await db.growth_records.where('del').equals(0).count();
}
// 按分类分页（🔴 走 [del+category+date] 复合索引，不再把整个分类 toArray() 进内存再 sort/slice）
export async function listRecordsByCategoryPage(db, category, { offset = 0, limit = 20 } = {}) {
  return await db.growth_records
    .where('[del+category+date]')
    .between([0, category, Dexie.minKey], [0, category, Dexie.maxKey])
    .reverse().offset(offset).limit(limit).toArray();
}
// 「有图」分页：图片有无无法用索引表达（imageIds 是数组），所以**逐页扫描**——
// 每次只把正在扫的那一页读进内存，凑够 limit 条带图记录即停；扫描总量设上限，极端情况也不会卡死。
export async function listRecordsWithImgPage(db, { offset = 0, limit = 20 } = {}) {
  const SCAN = 200, SCAN_MAX = 5000;
  const out = [];
  let skip = offset, scanned = 0, off = 0;
  while (out.length < limit && scanned < SCAN_MAX) {
    const page = await db.growth_records
      .where('[del+date]')
      .between([0, Dexie.minKey], [0, Dexie.maxKey])
      .reverse().offset(off).limit(SCAN).toArray();
    if (!page.length) break;
    off += page.length; scanned += page.length;
    for (const r of page) {
      if (!(r.imageIds || []).length) continue;
      if (skip > 0) { skip--; continue; }
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}
export async function recordsByStudent(db, studentId) {
  return await db.growth_records.where('studentId').equals(studentId).and(r => r.del === 0).reverse().toArray();
}
// 软删除：写 del = Date.now()（蓝图 记录端 #15）
export async function softDeleteRecord(db, id) {
  await db.growth_records.update(id, { del: Date.now() });
}
export async function restoreRecord(db, id) {
  await db.growth_records.update(id, { del: 0 });
}
export async function listDeleted(db) {
  return await db.growth_records.where('del').notEqual(0).toArray();
}
export async function bulkPutRecords(db, rows) {
  await db.growth_records.bulkPut(rows);
}

// ---------- 分类（正面管教：8 能力 + 关注）----------
export async function listCategories(db) {
  return await db.categories.where('del').equals(0).toArray();
}
export async function bulkPutCategories(db, rows) {
  await db.categories.bulkPut(rows);
}
export async function addCategory(db, cat) {
  await db.categories.put(cat);
}
export async function updateCategory(db, id, patch) {
  await db.categories.update(id, patch);
}

// ---------- 标签库 ----------
export async function listTags(db) {
  return await db.tags.where('del').equals(0).toArray();
}
export async function bulkPutTags(db, rows) {
  await db.tags.bulkPut(rows);
}
export async function addTag(db, tag) {
  await db.tags.put(tag);
}
export async function updateTag(db, id, patch) {
  await db.tags.update(id, patch);
}
export async function deleteTag(db, id) {
  await db.tags.delete(id);
}
// 使用频率 +1（按标签名匹配，记录里存的是名字，删标签不影响历史）
export async function incTagUse(db, name, by = 1) {
  const t = await db.tags.where('name').equals(name).and(x => x.del === 0).first();
  if (t) await db.tags.update(t.id, { useCount: (t.useCount || 0) + by });
}

// ---------- 图片（🔴 在学期库）----------
export async function putImage(db, imageId, blob) {
  await db.images.put({ imageId, blob, updatedAt: Date.now() });
}
export async function getImageBlob(db, imageId) {
  const r = await db.images.get(imageId);
  return r ? r.blob : null;
}
export async function listImages(db) {
  return await db.images.toArray();
}
export async function deleteImage(db, imageId) {
  await db.images.delete(imageId);
}
// 孤儿图 = 图片池 - 所有记录引用的图（🔴 回收站里的记录也算引用，恢复还要用）
// 🔴 只取图片主键（orderBy().keys()），绝不把整张照片读进内存 —— 设置页每次打开都会调它
export async function orphanImages(db) {
  const imgs = await db.images.orderBy('imageId').keys();
  const used = new Set();
  await db.growth_records.each(r => (r.imageIds || []).forEach(id => used.add(id)));
  return imgs.filter(id => !used.has(id)).map(imageId => ({ imageId }));
}
// dataURL -> Blob（导入图片用）
export function dataURLToBlob(dataURL) {
  const [head, b64] = dataURL.split(',');
  const mime = (head.match(/:(.*?);/) || [, 'image/png'])[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ---------- 收缴单（collections，临时态）----------
export async function listCollections(db) {
  return await db.collections.toArray();
}
export async function putCollection(db, c) {
  await db.collections.put(c);
}
export async function deleteCollection(db, id) {
  await db.collections.delete(id);
}

// ---------- 课表 ----------
export async function getSchedule(db) {
  return await db.schedule.get('current');
}
export async function saveSchedule(db, data) {
  await db.schedule.put({ id: 'current', ...data });
}
