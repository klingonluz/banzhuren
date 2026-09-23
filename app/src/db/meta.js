// 主库（meta）—— 全局、跨学期、长期存活
// V11.1：图片移入学期库（随归档一起删），meta 只留 settings + semesters（§2.1 / 本版变更 #12）
const Dexie = window.Dexie;
import { classifyDbError, DB_ERR_CORRUPT, DbOpenError, migrateQuietly } from './migrate.js';

// 🔴 迁移策略（根治 “object stores was not found” / SchemaError）：
// 用 Dexie 版本号机制——旧库(v1)升级到 v2 时 Dexie 自动增删 store，干净且不会丢数据；
// 「新增字段」由 migrate.js 在打开成功后补齐（旧记录缺新键 → 写默认值），不需要改库结构。
// 旧版(v1) schema 仅用于“良好旧库”的增量升级路径。
function makeMeta() {
  const db = new Dexie('bzr_meta');
  db.version(1).stores({
    semesters: 'id, startAt',
    settings:  'key',
    images:    'imageId, semesterId'     // 旧版把图存在 meta，V11.1 移除
  });
  db.version(2).stores({
    semesters: 'id, startAt',
    settings:  'key',
    images:    null                       // 移除 meta.images（图改存学期库）
  });
  return db;
}

export let meta = makeMeta();

// 🔴 打开 meta：失败【绝不删库】，只按错误类型分流后抛出 DbOpenError，由启动兜底页给出出口。
//    （删掉原来的「先抢救 → 删库 → 重建」：它删的是唯一正本，且不分故障类型。）
//    · newer（库比代码新）→ 该升级代码，不能删
//    · blocked（存储被禁用）→ 删了照样打不开，白抹一次数据
//    · corrupt（真结构损坏）→ 先尽力 dump 一份到 bzr_rescue（只读），再由用户决定
export async function openMeta() {
  try {
    await meta.open();
  } catch (e) {
    try { meta.close(); } catch (_) {}
    const kind = classifyDbError(e);
    if (kind === DB_ERR_CORRUPT) {
      try { const { rescueFromCorrupt } = await import('./rescue.js'); await rescueFromCorrupt('bzr_meta', '全局设置/学期'); } catch (_) {}
    }
    throw new DbOpenError('bzr_meta', kind, e);
  }
  await migrateQuietly(meta, 'meta');     // 旧记录缺新键 → 补默认值（幂等）
  return meta;
}

// ---- settings 读写（KV，全局唯一，不进学期库）----
export async function getSetting(key, def) {
  const row = await meta.settings.get(key);
  return row ? row.value : def;
}
export async function setSetting(key, value) {
  await meta.settings.put({ key, value });
}

// ---- semesters ----
export async function listSemesters() {
  return await meta.semesters.orderBy('startAt').toArray();
}
export async function getSemester(id) {
  return await meta.semesters.get(id);
}
export async function putSemester(sem) {
  await meta.semesters.put(sem);
}
export async function ensureSemester(sem) {
  const exists = await meta.semesters.get(sem.id);
  if (!exists) await meta.semesters.put(sem);
  return sem;
}
