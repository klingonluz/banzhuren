// 自动备份 / 损坏抢救 存储（独立库 bzr_rescue，正常流程绝不删除）
// 🔴 与业务库（bzr_meta / bzr_s_<id>）完全隔离：即便业务库损坏/被清，这里的快照仍保留，
//    是"换设备前一键导出 / 打开失败抢救"的最后一道保险。
const Dexie = window.Dexie;

let rescue = null;
function makeRescue() {
  const db = new Dexie('bzr_rescue');
  db.version(1).stores({ snaps: 'key' });   // key: 'auto:<semId>:<ts>' | 'rescue:<dbName>:<ts>'
  return db;
}
export function openRescue() {
  if (rescue) return rescue;
  rescue = makeRescue();
  return rescue;
}
// 打开 rescue 库自身也做"败则删库重建"（rescue 结构简单，丢了只是少几份备份，不影响业务）
async function ensureRescue() {
  const r = openRescue();
  try { await r.open(); }
  catch (e) {
    try { r.close(); } catch (_) {}
    try { await Dexie.delete('bzr_rescue'); } catch (_) {}
    rescue = makeRescue(); await rescue.open();
  }
  return rescue;
}

// ---- 写入 / 读取 ----
export async function putSnap(rec) {
  const r = await ensureRescue();
  await r.snaps.put(rec);
}
export async function getSnap(key) {
  const r = await ensureRescue();
  return await r.snaps.get(key);
}
export async function deleteSnap(key) {
  const r = await ensureRescue();
  await r.snaps.delete(key);
}
export async function listSnaps(type) {
  const r = await ensureRescue();
  const all = await r.snaps.toArray();
  return (type ? all.filter(s => s.type === type) : all)
    .sort((a, b) => b.exportedAt - a.exportedAt);
}
// 自动快照滚动保留：每个学期只留最近 keep 份（默认 3）
export async function pruneAuto(semesterId, keep = 3) {
  const r = await ensureRescue();
  const mine = (await r.snaps.where('key').startsWith('auto:' + semesterId + ':').toArray())
    .sort((a, b) => b.exportedAt - a.exportedAt);
  const drop = mine.slice(keep);
  for (const d of drop) { try { await r.snaps.delete(d.key); } catch (_) {} }
}

// 🔴 损坏抢救：业务库 open() 抛错后、delete 之前，尽最大努力用原生 IDB 把还能读出的 store dump 进 rescue。
//    best-effort：任一环节失败就跳过，绝不让抢救本身卡住"必须重建以解锁 app"的主流程。
export async function rescueFromCorrupt(dbName, label) {
  if (!(await Dexie.exists(dbName))) return false;
  try {
    const idb = await new Promise((res, rej) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const out = { key: '', type: 'rescue', device: label || dbName, exportedAt: Date.now(), dbName, stores: {} };
    const storeNames = Array.from(idb.objectStoreNames);
    for (const sn of storeNames) {
      try {
        const rows = await new Promise((res, rej) => {
          const tx = idb.transaction(sn, 'readonly');
          const rq = tx.objectStore(sn).getAll();
          rq.onsuccess = () => res(rq.result);
          rq.onerror = () => rej(rq.error);
        });
        out.stores[sn] = rows;
      } catch (_) { /* 单表读不出就跳过 */ }
    }
    idb.close();
    if (!Object.keys(out.stores).length) return false;
    out.key = 'rescue:' + dbName + ':' + Date.now();
    out.semesterName = label || dbName;
    await putSnap(out);
    return true;
  } catch (_) { return false; }
}
