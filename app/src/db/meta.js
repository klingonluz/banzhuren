// 主库（meta）—— 全局、跨学期、长期存活
// V11.1：图片移入学期库（随归档一起删），meta 只留 settings + semesters（§2.1 / 本版变更 #12）
const Dexie = window.Dexie;

// 🔴 迁移策略（根治 “object stores was not found” / SchemaError）：
// 用 Dexie 版本号机制——旧库(v1)升级到 v2 时 Dexie 自动增删 store，干净且不会丢数据；
// 若旧库结构损坏导致 open() 抛错，则删库后用【全新实例】重建（绝不在损坏实例上重复 open）。
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

// 🔴 打开 meta：失败即【先抢救可读数据到 bzr_rescue，再】删库重建（全新实例）。返回最终可用的 db。
export async function openMeta() {
  try {
    await meta.open();
  } catch (e) {
    try { meta.close(); } catch (_) {}
    try { const { rescueFromCorrupt } = await import('./rescue.js'); await rescueFromCorrupt('bzr_meta', '全局设置/学期'); } catch (_) {}
    try { await Dexie.delete('bzr_meta'); } catch (_) {}
    meta = makeMeta();                    // 关键：全新实例，避免同实例复用导致 SchemaDiff
    await meta.open();
  }
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
