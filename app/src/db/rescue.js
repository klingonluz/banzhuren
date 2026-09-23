// 自动备份 / 损坏抢救 存储（独立库 bzr_rescue，正常流程绝不删除）
// 🔴 与业务库（bzr_meta / bzr_s_<id>）完全隔离：即便业务库损坏/被清，这里的快照仍保留，
//    是"换设备前一键导出 / 打开失败抢救"的最后一道保险。
const Dexie = window.Dexie;

let rescue = null;
let rescueErr = null;   // 备份库打开失败的原因（正常时 null），见 rescueError()
function makeRescue() {
  const db = new Dexie('bzr_rescue');
  db.version(1).stores({ snaps: 'key' });   // key: 'auto:<semId>:<ts>' | 'rescue:<dbName>:<ts>'
  // 🔴 v2：元数据与内容分表。列表（「查看抢救数据」/ 启动横幅）只读 snapMeta —— 几十字节；
  //    整份 dump（可能含多张图片）只在「下载 / 恢复」那一刻用 getSnap() 按 key 取。
  //    旧库升级后 snapMeta 为空，listSnaps() 会自愈补写一次（见下）。
  db.version(2).stores({ snaps: 'key', snapMeta: 'key, type, exportedAt' });
  return db;
}
export function openRescue() {
  if (rescue) return rescue;
  rescue = makeRescue();
  return rescue;
}
// 打开 rescue 库：**绝不删库**。它打不开时整体降级 —— 本次不做本机备份，业务库与主流程照常，
// 并把原因留在 rescueError() 里，由启动横幅提醒老师「手动导出备份」（备份库自己就是保险箱，删了才是真丢）。
async function ensureRescue() {
  const r = openRescue();
  try { await r.open(); rescueErr = null; return r; }
  catch (e) {
    try { r.close(); } catch (_) {}
    rescueErr = e;
    rescue = null;                   // 下次用全新实例重试（绝不在失败实例上重复 open）
    return null;
  }
}
// 最近一次备份库打开失败的原因（正常时 null）
export function rescueError() { return rescueErr; }

// ---- 写入 / 读取 ----
// 🔴 备份库不可用时一律「静默降级」：返回 false / null / []，绝不抛错打断老师正在做的事
// 快照元数据（列表用）：只留展示与筛选需要的字段，不含 pack / stores 正文
function metaOf(rec) {
  return {
    key: rec.key, type: rec.type || '', semesterId: rec.semesterId || '',
    semesterName: rec.semesterName || '', device: rec.device || '',
    dbName: rec.dbName || '', exportedAt: rec.exportedAt || 0
  };
}
export async function putSnap(rec) {
  const r = await ensureRescue();
  if (!r) return false;
  try {
    await r.transaction('rw', r.snaps, r.snapMeta, async () => {
      await r.snaps.put(rec);
      await r.snapMeta.put(metaOf(rec));
    });
    return true;
  } catch (_) { return false; }
}
// 按 key 取回整份快照正文（只在「下载 / 恢复」时调用）
export async function getSnap(key) {
  const r = await ensureRescue();
  if (!r) return null;
  return await r.snaps.get(key);
}
export async function deleteSnap(key) {
  const r = await ensureRescue();
  if (!r) return;
  try {
    await r.transaction('rw', r.snaps, r.snapMeta, async () => {
      await r.snaps.delete(key);
      await r.snapMeta.delete(key);
    });
  } catch (_) {}
}
// 🔴 列表只读元数据表，绝不把整份 dump（含图片）拉进内存
export async function listSnaps(type) {
  const r = await ensureRescue();
  if (!r) return [];
  let metas = [];
  try { metas = await r.snapMeta.toArray(); } catch (_) { return []; }
  if (!metas.length) {
    // 旧库（v1 只有 snaps）升级后元数据表是空的 → 读一次正文、补写元数据，此后就不再读正文了
    try {
      const all = await r.snaps.toArray();
      if (!all.length) return [];
      metas = all.map(metaOf);
      try { await r.snapMeta.bulkPut(metas); } catch (_) {}
    } catch (_) { return []; }
  }
  return (type ? metas.filter(s => s.type === type) : metas)
    .sort((a, b) => b.exportedAt - a.exportedAt);
}
// 自动快照滚动保留：每个学期只留最近 keep 份（默认 3）
export async function pruneAuto(semesterId, keep = 3) {
  const r = await ensureRescue();
  if (!r) return;
  let mine = [];
  try {
    mine = await r.snapMeta.where('key').startsWith('auto:' + semesterId + ':').toArray();
  } catch (_) { return; }
  const drop = mine.sort((a, b) => b.exportedAt - a.exportedAt).slice(keep);
  for (const d of drop) { try { await deleteSnap(d.key); } catch (_) {} }
}

// 🔴 损坏抢救：业务库 open() 抛错后（**不再有 delete 这一步**），尽最大努力用原生 IDB 把还能读出的 store dump 进 rescue。
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
    return await putSnap(out);      // 备份库不可用时返回 false（不强求抢救成功）
  } catch (_) { return false; }
}
