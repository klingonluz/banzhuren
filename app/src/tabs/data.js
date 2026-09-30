// 数据 Tab：管理端（名单 / 标签库 / 分类）/ 学期管理 / 备份与恢复 / 成长记录文本（实名导出）/ 归档档案柜 / 回收站 / 设置
// V11.1：分类与标签全部可编辑；导入逐条校验；图片在学期库；collections 为临时态不进备份
// V11.11：成长记录文本（实名）从「分析」页迁到这里，与备份并列 —— 备份可导入恢复，文本只给人看
import {
  state, saveSetting, setSemester, refresh, teacherInitial, effectiveDeviceName,
  persistSupported, requestPersist, canInstall, promptInstall
} from '../state.js';
import {
  listStudents, bulkPutStudents,
  getSchedule, saveSchedule, listDeleted, restoreRecord, deleteSemester, openSemester, ensureOpen, countActiveRecords,
  putImage, listImages, deleteImage, dataURLToBlob, orphanImages,
  restoreSemesterFromPack, restoreSemesterFromStores, diffRecordsOfStudent, mergeStudentsFromPack
} from '../db/semester.js';
import { nameInitials } from '../pinyin.js';
import { PHOTO_BAN, PHOTO_OK } from '../privacy.js';
import { openExport } from '../export.js';
import { listSemesters, putSemester, ensureSemester, removeSemester, meta } from '../db/meta.js';
import { listSnaps, getSnap, deleteSnap, snapshotSemester, pruneSnaps } from '../db/rescue.js';
import { buildArchiveHTML, archiveFileName, fmtBytes } from '../archive.js';
import { seedBaseline, seedTaxonomy, WUYU, GUANZHU } from '../db/seed.js';
import { esc, toast, openPicker, emptyState, confirm, confirmAsync, askText, syncSeg, onSeg, banner, closeBanner, showSheet, filterStudents, afterBack, actionSheet } from '../ui.js';
import { download, blobToDataURL, stamp, kindOfFile, normSemName, semNameOf, nextSemName, curSemName, semYearOptions, semStartYear } from '../util.js';
import { flushDraft } from './record.js';

const SCHEMA_VERSION = 7;                 // 当前 schema 版本（V11.13：templates 移除 / images 去 del / 记录增复合索引）
const APP_VER = 'v1.8.1';                 // 🔴 产品版本号（对外）：语义化递增，与 main.js 的 APP_VER 保持一致
const PLAN_VER = 'V11.16';                // 🔴 方案版本号（内部，仅设置页可见）：与 dev/docs 里配对的方案文件同步，改功能才顺延

// 🔴 存储口径三处统一：一个函数、不写死（§4.8.18 ①-4）
async function storageBreakdown() {
  const db = state.db;
  const recN = await countActiveRecords(db);
  // 🔴 只用图片**数量**：绝不用 listImages()（那是 db.images.toArray()，会把全部照片 Blob 读进内存）
  const imgN = await db.images.count();
  const rec = +(recN * 0.03).toFixed(2);
  const img = +(imgN * 0.4).toFixed(2);
  const oth = 1.2;
  const total = +(rec + img + oth).toFixed(2);
  return { recN, imgN, rec, img, oth, total };
}
function fmtMB(n) { return n >= 1 ? n.toFixed(1) + 'MB' : Math.round(n * 1024) + 'KB'; }

/* ---------- 备份导出（全量含图，单文件；collections 不进备份） ---------- */
export async function buildExportPack() {
  const db = state.db;
  const students = await db.students.toArray();
  const records = await db.growth_records.toArray();      // 🔴 含软删记录（回收站一并备份）
  const categories = await db.categories.toArray();
  const tags = await db.tags.toArray();
  const schedule = await getSchedule(db);
  const imgs = await listImages(db);                       // 🔴 图片在学期库
  const images = [], imageErrors = [];
  for (const im of imgs) {
    let data = '';
    try { if (im.blob && typeof im.blob.arrayBuffer === 'function') data = await blobToDataURL(im.blob); }
    catch (e) { console.warn('图片导出失败，已跳过', im.imageId, e); }
    if (!data) imageErrors.push(im.imageId);               // 🔴 P1-11：读不出的图如实记下来，导出后告诉老师
    images.push({ imageId: im.imageId, data });
  }
  return {
    app: '班主任工作台', schemaVersion: SCHEMA_VERSION, exportedAt: Date.now(),
    device: effectiveDeviceName(schedule),  // 🔴 始终由「本班班级 + 教师姓名」派生（设置页只读展示，不开放手填）
    semesterId: state.currentSemesterId, semester: state.semester,
    students, categories, tags, records, schedule, images,
    imageErrors                                            // 备份自证：这些图这次没能带上（记录本身完整）
  };
}

// 🔴 P1-11：导出结束后如实告知丢了哪几张，别让备份「看起来成功、实际缺图」
function warnImageErrors(pack) {
  const n = (pack && pack.imageErrors && pack.imageErrors.length) || 0;
  if (n) banner('exportImgBanner', `⚠️ 本次导出有 <b>${n}</b> 张图片读不出来（<b>记录文字完整</b>），可稍后重试导出。`, 'warn');
  return n;
}

/* ---------- 一键备份：顶部横幅「立即备份」与数据页「导出备份」走同一条路径 ---------- */
// 🔴 规格要求横幅上的「立即备份」**直接调导出**（不是跳到数据页让老师再点一次）
// 闭环：导出成功 → 写 lastExport → 当天横幅消失；归档后 lastExport=null，提醒重新计时
export async function quickBackup() {
  const pack = await buildExportPack();
  download(`班主任工作台_${state.semester?.name || '学期'}_备份_${stamp()}.json`, JSON.stringify(pack));
  const now = Date.now();
  await meta.settings.put({ key: 'lastExport', value: now });
  state.settings.lastExport = now;
  closeBanner('backupBanner');
  warnImageErrors(pack);
  return pack;
}

/* ---------- 快照卡片（bzr_rescue 独立库：导入前 / 抢救） ---------- */
// 🔴 v1.5.0：原「自动备份 / 全量快照」（每次打开把整库含图写进 bzr_rescue）已删除 ——
//    它挡不住换设备 / 换网址（最常见的两种丢失），却每次打开都要读全表、把每张图 base64 转一遍，
//    图片还会在本机存两份。「编辑被打断的恢复」由记录页草稿机制（localStorage，输入即存）承担，
//    比"6 小时才拍一次"的快照及时得多。
// 🔴 现在 bzr_rescue 里有两类快照，**两类都必须给入口**：
//    · preimport —— 每次「用备份替换本机学期」之前自动存的（可撤销到那一刻 / 从中捞回学生）
//    · rescue    —— 打开失败时尽力 dump 出来的
//    ⚠️ 旧版这张卡只 listSnaps('rescue') ⇒ **导入前快照全应用没有任何地方看得到**，
//       老师说「替换之前的快照我也不知道在哪里找」，就是这个洞。
async function snapCard() {
  const all = await listSnaps().catch(() => []);
  if (!all.length) return '';
  const pre = all.filter(s => s.type === 'preimport').length;
  const res = all.filter(s => s.type === 'rescue').length;
  const parts = [];
  if (pre) parts.push(`导入前 ${pre} 份`);
  if (res) parts.push(`抢救 ${res} 份`);
  return `<div class="card">
    <h2>🕘 快照 <span class="muted" style="font-weight:400;font-size:12px">${parts.join(' · ')}</span></h2>
    <div class="save-note" style="border:none;padding-top:0">存在<b>独立备份库</b>里 —— 清缓存、清本机数据它都还在。<b>每次用备份替换本机学期之前都会自动存一份</b>，可以「撤销到这一刻」，也可以从中「捞回学生」。</div>
    <button class="btn ghost mt" id="dt-snap-view">查看 / 管理快照（${all.length} 份）</button>
  </div>`;
}

// 列出快照，动作按「快照属于哪个学期」分两档（🔴 跨学期闸门）：
//    · 同学期   ⇒ 下载 · 从这一刻捞回学生 · （仅 preimport）撤销到这一刻 · 删
//    · 别的学期 ⇒ 下载 · 确认已归档后清理
//      理由（老师：新学期新名单，不与归档弄混）：想补几个转出的学生，名单里点「转回」就行 —— 记录一直都在。
function snapBadge(s) {
  if (s.type === 'preimport') return ['导入前', 'a'];
  if (s.type === 'auto') return ['自动', 'yes'];
  return ['抢救', 'no'];
}
function snapTime(s) { return new Date(s.exportedAt || 0).toLocaleString('zh-CN'); }
function snapSame(s) { return !!s.semesterId && s.semesterId === state.currentSemesterId; }

export function openSnapList(title, snaps, badge) {
  const types = new Set(snaps.map(x => x.type));
  const p = openPicker({
    title,
    lead: '存在<b>独立备份库</b>里 —— 清缓存、清本机数据它都还在。',
    body: `<div style="padding:12px 14px" id="sn-box">${snaps.length ? snaps.map(s => {
      const [txt, cls] = snapBadge(s);
      const same = snapSame(s);
      return `<div class="li" data-key="${esc(s.key)}">
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(s.semesterName || s.device || s.dbName || '—')} <span class="pill ${cls}">${txt}</span>${same ? ' <span class="pill yes">本学期待</span>' : ''}</div>
          <div class="meta">${snapTime(s)} · ${esc(s.device || '—')}</div>
        </div>
        <button class="mini" data-dl>下载</button>
        <button class="mini ${same ? '' : 'danger'}" data-act>${same ? '操作' : '清理'}</button>
      </div>`;
    }).join('') : emptyState('还没有快照')}</div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });
  // 删除后重开列表：🔴 必须 afterBack —— close() 里的 history.back() 是异步的，
  //    迟到的 popstate 会把**新**弹层当栈顶弹掉（老师看到列表闪一下就没了）
  const reopen = async () => {
    const left = await listSnaps().catch(() => []);
    const keep = left.filter(x => types.has(x.type));
    afterBack(() => openSnapList(title, keep, badge));
  };
  p.body.querySelector('#sn-box').onclick = async e => {
    const row = e.target.closest('[data-key]'); if (!row) return;
    const s = snaps.find(x => x.key === row.dataset.key); if (!s) return;
    if (e.target.closest('[data-dl]')) return downloadSnap(s);
    if (!e.target.closest('[data-act]')) return;
    if (!snapSame(s)) return openCleanup(s, reopen);
    actionSheet([
      { label: '从这一刻捞回学生', onClick: () => openSalvage(s) },
      // 🔴 只给「导入前快照」开撤销：抢救 dump 可能缺表（损坏时逐表 catch 跳过），
      //    用它覆盖整学期风险太大 —— 那种情况只允许"捞回"（只补不删）。
      ...(s.type === 'preimport' ? [{ label: '撤销到这一刻', onClick: () => undoSemester(s) }] : []),
      { label: '删除这份快照', danger: true, onClick: () => confirm({
        title: '删除这份快照', danger: true,
        msg: `删除后无法恢复（它本身就是一份备份）。\n\n确定删除这份「${s.semesterName || s.device || '快照'}」吗？`,
        okText: '删除',
        onOk: async () => { await deleteSnap(s.key); toast('已删除该快照'); p.close(); reopen(); }
      }) }
    ]);
  };
}

// 下载快照为 .json（🔴 含图片：blob → dataURL，所以是异步的）
async function downloadSnap(s) {
  const full = await getSnap(s.key);
  if (!full) { banner('errBanner', '⚠️ 这份快照的正文已不在本机（可能被清理过）。'); return; }
  const [txt] = snapBadge(s);
  const name = `班主任工作台_${s.semesterName || '学期'}_${txt}_${stamp(s.exportedAt)}.json`;
  if (s.type === 'auto' && full.pack) download(name, JSON.stringify(full.pack));
  else download(name, JSON.stringify(await buildRescuePack(full)));
  toast('已下载快照文件');
}

// 历史学期的快照：先把"里面有什么"摊开，两项都确认了才解锁删除
function openCleanup(s, reopen) {
  getSnap(s.key).then(full => {
    const st = (full && full.stores) || {};
    const n = { stu: (st.students || []).length, rec: (st.growth_records || []).length, img: (st.images || []).length };
    const p = openPicker({
      title: '清理历史快照',
      lead: '这份快照不属于当前学期',
      body: `<div style="padding:14px 16px">
        <div class="kv" style="border:none"><span>学期</span><b>${esc(s.semesterName || s.device || s.dbName || '—')}</b></div>
        <div class="kv"><span>内容</span><b>名单 ${n.stu} 人 · 记录 ${n.rec} 条 · 图片 ${n.img} 张</b></div>
        <div class="kv"><span>存于</span><b>${snapTime(s)}</b></div>
        <div class="save-note">这份数据已经有着落了吗？</div>
        <label class="li" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="cl-1"><span>我已经导出成文件保存好了</span></label>
        <label class="li" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="cl-2"><span>这个学期已经归档（.html 报告已生成）</span></label>
      </div>`,
      foot: `<button class="btn ghost" data-pclose>关闭</button><button class="btn danger" id="cl-ok" disabled>删除这份快照</button>`
    });
    const b1 = p.body.querySelector('#cl-1'), b2 = p.body.querySelector('#cl-2');
    const ok = p.foot.querySelector('#cl-ok');
    const sync = () => { ok.disabled = !(b1.checked && b2.checked); };
    b1.onchange = sync; b2.onchange = sync;
    ok.onclick = async () => {
      await deleteSnap(s.key);
      toast('已删除这份快照');
      p.close();
      reopen();
    };
  });
}

// 撤销到这一刻：整学期回退（走与"替换"同一路径）。🔴 执行前同样先存一份快照，防止撤销本身点错。
function undoSemester(s) {
  confirm({
    title: '撤销到这一刻', danger: true,
    msg: `会把当前学期整个换回这份快照的状态（${snapTime(s)}）。\n\n`
      + `本机现有的名单与记录会被替换掉。\n\n`
      + `执行前会自动再存一份「导入前快照」，可回退。\n\n`
      + `确定撤销吗？`,
    okText: '撤销',
    onOk: async () => {
      const full = await getSnap(s.key);
      if (!full || !full.stores) { banner('errBanner', '⚠️ 这份快照的正文已不在本机。'); return; }
      const db = state.db;
      const key = await snapshotSemester(db, state.currentSemesterId, state.semester?.name || '', '撤销前');
      if (!key) { banner('errBanner', '⚠️ 「撤销前快照」存不下来（本机备份库不可用），已中止 —— <b>本机数据一点没动</b>。'); return; }
      await pruneSnaps('preimport', state.currentSemesterId, 2);
      try {
        await restoreSemesterFromStores(db, full.stores);
        try { await seedTaxonomy(db); } catch (_) {}
        toast('已撤销到那一刻'); refresh();
      } catch (e) { banner('errBanner', `⚠️ 撤销失败：${esc(e.message || e)}（事务已回滚）。`); }
    }
  });
}

// 捞回学生（两级粒度，老师拍板）：
//   · 本机名单里**没有**这个学生 ⇒ 连人带记录一起恢复（+ 被引用到的图片）
//   · 本机名单里**已有** ⇒ 不重复建人，只列出"本机缺的记录"让他挑
// 🔴 全程只补不删 ⇒ 不需要危险确认。
async function openSalvage(s) {
  const full = await getSnap(s.key);
  if (!full || !full.stores) { banner('errBanner', '⚠️ 这份快照的正文已不在本机（可能被清理过）。'); return; }
  const stores = full.stores;
  const snapStu = stores.students || [];
  const snapRecs = stores.growth_records || [];
  if (!snapStu.length) { banner('errBanner', '⚠️ 这份快照里没有学生，无法捞回。'); return; }
  const db = state.db;
  const local = await db.students.toArray();
  const byId = new Map(local.map(x => [x.id, x]));
  const byName = new Map(local.map(x => [x.name, x]));

  const fresh = [], exist = [];
  for (const stu of snapStu) {
    const recs = snapRecs.filter(r => r.studentId === stu.id);
    const mine = byId.get(stu.id);
    if (mine) exist.push({ stu: mine, ...(await diffRecordsOfStudent(db, stu.id, recs)) });
    else fresh.push({ stu, recs, twin: (byName.get(stu.name) && byName.get(stu.name).id !== stu.id) ? byName.get(stu.name) : null });
  }
  const recRow = (r, changed) => `<label style="display:flex;gap:8px;align-items:flex-start;padding:5px 0;font-size:12px">
    <input type="checkbox" data-rec="${esc(r.id)}" checked>
    <span style="flex:1;min-width:0"><span class="muted">${esc(r.date || '')} ${esc(r.category || '')}</span> ${esc((r.text || '（无评语）').slice(0, 40))}${changed ? ' <span class="pill">本机有旧版本</span>' : ''}</span>
  </label>`;
  const H = title => `<div class="muted" style="font-size:12px;margin:12px 0 6px">${title}</div>`;

  const p = openPicker({
    title: '从这一刻捞回学生',
    lead: `来源：${esc(snapBadge(s)[0])}快照 · ${snapTime(s)}<br>去处：当前学期「${esc(state.semester?.name || '')}」`,
    body: `<div style="padding:12px 14px">
      <div class="save-note" style="border:none"><b>只补不删</b>：本机现有的名单与记录一个都不会动；回收站里已删的记录照原样带过来，不会复活。</div>
      ${fresh.length ? H('本机名单里没有的学生（连着人一起恢复）') + fresh.map(f => `
        <label class="li" style="display:flex;gap:8px;align-items:center">
          <input type="checkbox" data-fresh="${esc(f.stu.id)}" checked>
          <span style="flex:1;min-width:0"><b>${esc(f.stu.name)}</b><span class="meta"> · 新增 · 连同 ${f.recs.length} 条记录${f.stu.out ? '（快照里是转出状态）' : ''}</span>${f.twin ? `<span class="meta" style="color:var(--danger)"> · 与「${esc(f.twin.name)}」同名，可能是同一人</span>` : ''}</span>
        </label>`).join('') : ''}
      ${exist.length ? H('本机已有的学生（只补库里缺的记录）') + exist.map(x => `
        <div class="li" style="display:block">
          <label style="display:flex;gap:8px;align-items:center">
            <input type="checkbox" data-stu="${esc(x.stu.id)}">
            <span style="flex:1;min-width:0"><b>${esc(x.stu.name)}</b><span class="meta"> · 本机已有 · 缺 ${x.added.length + x.changed.length} 条${x.sameN ? `（另有 ${x.sameN} 条本机已是最全）` : ''}</span></span>
          </label>
          ${(x.added.length + x.changed.length) ? `<div style="padding-left:24px">
            ${x.added.map(r => recRow(r, false)).join('')}
            ${x.changed.map(r => recRow(r, true)).join('')}
          </div>` : ''}
        </div>`).join('') : ''}
      ${(!fresh.length && !exist.length) ? emptyState('这份快照里没有可恢复的学生') : ''}
    </div>`,
    foot: `<button class="btn ghost" data-pclose>关闭</button><button class="btn" id="sv-ok">捞回选中的</button>`
  });

  p.foot.querySelector('#sv-ok').onclick = async () => {
    const stuIds = new Set(), recIds = new Set();
    p.body.querySelectorAll('input[data-fresh]:checked').forEach(x => stuIds.add(x.dataset.fresh));
    p.body.querySelectorAll('input[data-rec]:checked').forEach(x => recIds.add(x.dataset.rec));
    p.body.querySelectorAll('input[data-stu]:checked').forEach(x => {
      const ex = exist.find(e => e.stu.id === x.dataset.stu);
      if (ex) [...ex.added, ...ex.changed].forEach(r => recIds.add(r.id));
    });
    const students = [], records = [];
    for (const f of fresh) if (stuIds.has(f.stu.id)) { students.push(f.stu); f.recs.forEach(r => records.push(r)); }
    for (const x of exist) [...x.added, ...x.changed].forEach(r => { if (recIds.has(r.id)) records.push(r); });
    if (!students.length && !records.length) { toast('还没选任何东西'); return; }
    // 🔴 图片只补"被选中记录引用到的"，别把整份快照的图都灌进来
    const need = new Set();
    records.forEach(r => (r.imageIds || []).forEach(id => need.add(id)));
    const images = (stores.images || []).filter(im => im && need.has(im.imageId));
    const r = await mergeStudentsFromPack(state.db, { students, records, images });
    p.close();
    toast(`已捞回：新增 ${r.stuN} 人、补 ${r.recN} 条记录、${r.imgN} 张图片`);
    if (r.imgBad.length) banner('errBanner', `⚠️ 有 ${r.imgBad.length} 张图片没读到（记录文字是完整的）。`);
    refresh();
  };
}

// 快照 → 可导入的 pack。🔴 图片是 blob ⇒ 下载时现转 dataURL（慢一点，但下载是低频操作）。
async function buildRescuePack(s) {
  const stores = s.stores || {};
  const images = [];
  for (const im of (stores.images || [])) {
    let data = '';
    try { if (im && im.blob && typeof im.blob.arrayBuffer === 'function') data = await blobToDataURL(im.blob); } catch (_) {}
    images.push({ imageId: im && im.imageId, data });
  }
  return {
    app: '班主任工作台', schemaVersion: SCHEMA_VERSION, exportedAt: s.exportedAt,
    device: s.device || s.dbName || '快照',
    semesterId: s.semesterId || state.currentSemesterId, semester: state.semester,
    students: stores.students || [], categories: stores.categories || [], tags: stores.tags || [],
    records: stores.growth_records || [], schedule: (stores.schedule || [])[0] || null,
    images
  };
}

/* ---------- 启动钩子 ---------- */
// 🔴 v1.5.0：原 autoBackupMaybe（每次打开把整库含图快照写进 bzr_rescue）已删除，理由见 snapCard 上方注释。

// 🔴 启动清理：只剩「回收站过期」一项。
//    v1.5.0 起「归档宽限到期自动删库」已删除 —— 那是全应用唯一的自动删库路径；
//    此后任何删库都由用户显式触发（彻底删除 / 清空名单 / 清除本机副本）。
export async function housekeeping() {
  // 回收站过期清理（下次启动时，不在老师翻记录时突然删）
  try {
    const days = +(state.settings.recycleDays || 30);
    const cut = Date.now() - days * 86400000;
    const del = await listDeleted(state.db);
    let dropped = 0;
    for (const r of del) if (r.del && r.del < cut) { await state.db.growth_records.delete(r.id); dropped++; }
    // 🔴 P1-2：记录既然过期删掉了，它的图片就再没有任何记录引用 → 一并清掉。
    //    否则「彻底删除」连图一起删、「过期自动清」只删记录，两种口径不一致，图片白占空间。
    //    孤儿图判定把回收站里还在的记录也算作引用，所以不会误删将来还要恢复的图。
    if (dropped) {
      for (const o of await orphanImages(state.db)) { try { await deleteImage(state.db, o.imageId); } catch {} }
    }
  } catch {}
}

/* ================= 挂载 ================= */
export async function mount(scrollEl) {
  const render = () => mount(scrollEl);   // 备份 / 操作后置刷新
  const db = state.db;
  const students = await listStudents(db);
  const deleted = await listDeleted(db);
  const sto = await storageBreakdown();
  const sems = await listSemesters();
  // 🔴 档案柜只列「已归档」与「已清除」—— 归档学期不参与工作流，只在这里可见
  const archived = sems.filter(s => s.status === 'archived' || s.status === 'cleared');

  scrollEl.innerHTML = `
    ${manageCard(students.length)}
    ${semesterCard(sto)}
    ${backupCard()}
    ${textCard()}
    ${await snapCard()}
    ${cabinetCard(archived)}
    ${trashCard(deleted.length, students)}
    <div class="card">
      <h2>🩺 诊断 / 兜底</h2>
      <div class="save-note" style="border:none;padding-top:0">一次只开一个页面记记录：多标签同时编辑会<b>互相覆盖</b>。</div>
      <button class="btn ghost mt" id="dt-settings">⚙️ 打开设置</button>
      <div class="save-note">失败时<b>保留输入</b>并说明原因，不白屏。</div>
    </div>`;

  // 🔴 「上次导出」：模板里留的空占位（#dt-last）一直没人填 ⇒ 老师看不到上次备份是什么时候，
  //    而这正是备份卡最该回答的问题。数据源与页脚横幅一致（settings.lastExport）。
  const lastEl = scrollEl.querySelector('#dt-last');
  if (lastEl) {
    const d = state.settings.lastExport;
    lastEl.textContent = d
      ? `上次导出：${new Date(d).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      : '本机还没有导出过备份 —— 建议现在就导一份。';
  }
  scrollEl.querySelector('#dt-manage').onclick = () => openManage();
  scrollEl.querySelector('#dt-sem').onclick = () => openSemesters();
  // 🔴 归档 = 盖章 + 产两份文件，**零删除**（想省空间另点「清除本机副本」）
  scrollEl.querySelector('#dt-archive').onclick = () => confirm({
    title: '归档本学期', danger: true,
    msg: '归档会为这个学期生成两份文件（备份 .json + 只读报告 .html），并把它标记为「已归档」。\n\n本机数据保持不动 —— 想省空间时，再到档案柜点「清除本机副本」。\n\n确认归档？',
    okText: '开始归档', onOk: doArchive
  });
  scrollEl.querySelector('#dt-backup').onclick = async () => {
    try { await quickBackup(); toast('备份已导出（全量含图）'); render(); }
    catch (e) { banner('errBanner', '⚠️ 导出失败：<b>' + esc(e.message || e) + '</b>（数据未被改动，可重试）。'); }
  };
  const snapBtn = scrollEl.querySelector('#dt-snap-view');
  if (snapBtn) snapBtn.onclick = async () => {
    const all = await listSnaps().catch(() => []);
    openSnapList('快照', all, '');
  };
  scrollEl.querySelector('#dt-text').onclick = () => openExport();
  scrollEl.querySelector('#dt-import').onclick = () => openImport();
  scrollEl.querySelector('#dt-trash').onclick = () => openTrash();
  scrollEl.querySelector('#dt-settings').onclick = () => openSettings();
  scrollEl.querySelectorAll('[data-clear-copy]').forEach(b => b.onclick = () => {
    const s = archived.find(x => x.id === b.dataset.clearCopy);
    if (s) clearSemesterCopy(s, render);
  });
}

/* ---------- 卡片 ---------- */
function manageCard(stuN) {
  return `<div class="card">
    <h2>👥 学生名单 <span class="muted" style="font-weight:400;font-size:12px">管理端</span></h2>
    <div class="stat-grid">
      <div class="stat"><b>${stuN}</b><span>在册学生</span></div>
    </div>
    <button class="btn ghost mt" id="dt-manage">管理学生名单</button>
    <div class="save-note">批量粘贴（每行一个）/ 手加 / 导入。<b>转出</b> = 学生离开本班：不再出现在选人、收缴、待办里，记录<b>全部保留</b>，可随时转回。</div>
  </div>`;
}
function semesterCard(sto) {
  return `<div class="card">
    <h2>📚 学期管理</h2>
    <div class="kv" style="border:none;padding:2px 0"><span>当前学期</span><b>${esc(state.semester?.name || '—')}</b></div>
    <div class="kv"><span>记录 / 图片 / 占用</span><b>${sto.recN} 条 · ${sto.imgN} 张 · ${fmtMB(sto.total)}</b></div>
    <button class="btn ghost mt" id="dt-sem">切换 / 管理学期</button>
    <button class="btn danger mt" id="dt-archive">归档本学期（生成归档文件）</button>
    <div class="save-note">一学期一库。新建继承名单、分类、标签，<b>不继承</b>记录与图片。<b>归档只生成文件、不动本机数据</b>。</div>
  </div>`;
}
function backupCard() {
  return `<div class="card">
    <h2>💾 备份与恢复</h2>
    <button class="btn" id="dt-backup">导出备份（全量含图）</button>
    <button class="btn ghost mt" id="dt-import">导入备份（换手机 / 换网址后恢复）</button>
    <div class="save-note" id="dt-last"></div>
    <div class="save-note"><b>JSON 备份</b>（含图片、可原样导入恢复），<b>不是给家长看的成长记录文本</b> —— 后者在下面「📄 成长记录文本」。</div>
    <div class="save-note">🛡️ <b>打不开时别清数据</b>：先用<a href="./recover.html">数据导出页</a>把内容存成文件（它不依赖应用代码）。</div>
    <div class="save-note danger"><b>换网址 = 数据全丢</b>：数据绑定当前网址（域名 + 协议 + 端口），换网址后旧数据读不到，抢救库也救不回。导出备份是<b>唯一能跨网址带走数据</b>的方式 —— <b>部署新网址前先导出一份</b>。</div>
  </div>`;
}
function textCard() {
  return `<div class="card">
    <h2>📄 成长记录文本 <span class="muted" style="font-weight:400;font-size:12px">（实名 · 留本机）</span></h2>
    <button class="btn" id="dt-text">生成成长记录文本</button>
    <div class="save-note">给人看的<b>实名</b>成长记录，可打印 / 给家长 / 存档，<b>不含照片与成绩</b>；纯文本，<b>只读不回填</b>。要发给 AI 请用「分析 → AI 评语素材」。</div>
  </div>`;
}
function cabinetCard(archived) {
  return `<div class="card">
    <h2>🏛️ 归档档案柜</h2>
    <div id="dt-cab">${archived.length ? archived.map(s => {
      const f = s.archivedFiles || {};
      const day = s.archivedAt ? new Date(s.archivedAt).toLocaleDateString('zh-CN') : '—';
      const size = f.bytes ? `约 ${fmtBytes((f.bytes.json || 0) + (f.bytes.html || 0))}` : '';
      return `<div class="archive-row">
        <div style="flex:1;min-width:0">
          <b>${esc(s.name)}</b>${s.status === 'cleared' ? ' <span class="pill no">本机已清除</span>' : ''}
          <div class="fn">归档于 ${day}</div>
          <div class="fn">📄 ${esc(f.json || s.archivedFileName || '未记录文件名')}</div>
          <div class="fn">🌐 ${esc(f.html || '未记录文件名')}</div>
          <div class="fn">${s.status === 'cleared'
            ? `本机数据已于 ${s.clearedAt ? new Date(s.clearedAt).toLocaleDateString('zh-CN') : '—'} 清除`
            : `本机副本：保留中${size ? ' · ' + size : ''}`}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${s.status === 'archived' ? `<button class="mini danger" data-clear-copy="${esc(s.id)}">清除本机副本</button>` : ''}
        </div>
      </div>`;
    }).join('') : emptyState('还没有归档学期', '')}</div>
    <div class="save-note">归档生成两份文件：<b>.json</b> 可导入恢复，<b>.html</b> 双击即可只读查看（含图）。请存到电脑或网盘。</div>
  </div>`;
}
function trashCard(n) {
  return `<div class="card">
    <h2>🗑️ 回收站 <span class="muted" style="font-weight:400;font-size:12px">${n} 条 · 保留 ${state.settings.recycleDays || 30} 天</span></h2>
    <button class="btn ghost" id="dt-trash">查看 / 恢复 / 清空</button>
    <div class="save-note">回收站里的图片会保留；彻底删除或清空后才会被清理。</div>
  </div>`;
}

/* ---------- 管理端：学生名单（分类 / 标签为系统预设，不可修改，故无对应页签） ---------- */
function openManage() {
  const p = openPicker({
    title: '管理学生名单',
    body: `<div style="padding:12px 14px"><div id="mg-box"></div></div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });
  drawStudents(p.body.querySelector('#mg-box'));
}

async function drawStudents(box) {
  const db = state.db;
  const students = await db.students.toArray();
  students.sort((a, b) => (a.out ? 1 : 0) - (b.out ? 1 : 0) || a.name.localeCompare(b.name, 'zh'));
  box.innerHTML = `
    <div class="field"><label>批量粘贴（Excel 一列直接粘，每行一个）</label>
      <textarea class="ta" id="mg-paste" rows="3" placeholder="张梓涵&#10;李思远&#10;王雨欣"></textarea></div>
    <div class="row" style="gap:8px">
      <button class="btn tiny" id="mg-import">导入名单</button>
      <button class="btn ghost tiny" id="mg-add">＋ 单个手加</button>
      <button class="btn ghost tiny danger" id="mg-clear" style="margin-left:auto">🗑️ 清空全部</button>
    </div>
    <input class="search" id="mg-q" type="search" enterkeyhint="search" placeholder="搜索 姓名 / 拼音首字母" style="border:1px solid var(--line);border-radius:8px;margin:10px 0">
    <div id="mg-list"></div>`;
  const list = box.querySelector('#mg-list');
  const drawList = q => {
    const hit = filterStudents(students, q);
    list.innerHTML = hit.length ? hit.map(s => `
      <div class="li" data-id="${esc(s.id)}" style="${s.out ? 'opacity:.55' : ''}">
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(s.name)} ${s.out ? '<span class="pill no">已转出</span>' : ''}</div>
          <div class="meta" data-py="${esc(s.id)}" title="点此修正拼音首字母" style="cursor:pointer">${esc(s.pinyin || '—')}</div>
        </div>
        <button class="mini" data-rename="${esc(s.id)}">改名</button>
        <button class="mini ${s.out ? '' : 'danger'}" data-out="${esc(s.id)}" data-cfm="0">${s.out ? '转回' : '转出'}</button>
      </div>`).join('') : '<div class="empty">无匹配学生</div>';
  };
  drawList();
  box.querySelector('#mg-q').oninput = e => drawList(e.target.value);

  box.querySelector('#mg-import').onclick = async () => {
    const raw = box.querySelector('#mg-paste').value || '';
    const names = raw.split('\n').map(s => s.trim().replace(/\u3000/g, ' ').trim()).filter(Boolean);
    if (!names.length) { toast('请先粘贴名单'); return; }
    const exist = new Set(students.map(s => s.name));
    let dup = 0, bad = 0, added = 0;
    for (const n of names) {
      if (n.length < 2 || n.length > 4) { bad++; continue; }
      if (exist.has(n)) { dup++; continue; }
      exist.add(n); added++;
      students.push({ id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: n, pinyin: nameInitials(n), out: 0, del: 0 });
    }
    await bulkPutStudents(db, students.filter(s => s.id));
    toast(`导入完成：新增 ${added}，跳过重复 ${dup}${bad ? `，忽略 ${bad} 个长度异常` : ''}`);
    drawStudents(box);
  };
  box.querySelector('#mg-add').onclick = async () => {
    // 🔴 不用 window.prompt（预览面板会静默返回 null ⇒「点了没反应」）
    const name = await askText({ title: '手加学生', label: '学生姓名（2~4 字）', placeholder: '张梓涵', okText: '添加', maxlength: 4 });
    if (!name) return;
    const n = name.trim();
    if (n.length < 2 || n.length > 4) { toast('姓名需 2~4 字'); return; }
    await bulkPutStudents(db, [{ id: 's' + Date.now().toString(36), name: n, pinyin: nameInitials(n), out: 0, del: 0 }]);
    toast('已添加'); drawStudents(box);
  };
  box.querySelector('#mg-clear').onclick = () => confirm({
    title: '清空全部名单', danger: true,
    msg: '将删除本班全部学生，并一并清除本学期所有成长记录与图片（仅本学期）。\n\n用于替换为你的真实名单，操作不可恢复。',
    okText: '清空并重建', onOk: async () => {
      try {
        // 🔴 P1-10：直接清空图片池 —— 这个动作本就承诺「本学期所有记录与图片」。
        //    旧写法只按记录的 imageIds 逐张删，此前留下的孤儿图（如保存失败）会残留在库里白占空间。
        await db.growth_records.clear();
        await db.students.clear();
        await db.images.clear();
        toast('已清空，可粘贴 / 手加真实名单'); drawStudents(box);
      } catch (e) { toast('清空失败：' + e.message); }
    }
  });
  list.onclick = async e => {
    const py = e.target.closest('[data-py]');
    if (py) {
      const s = students.find(x => x.id === py.dataset.py);
      const nv = await askText({ title: `「${s.name}」的拼音首字母`, label: '只用于搜索与分组（A~Z）', value: s.pinyin || '', placeholder: 'ZZH', okText: '保存' });
      if (nv === null) return;
      s.pinyin = nv.toUpperCase().replace(/[^A-Z]/g, '');
      s.pyManual = 1;                                  // 🔴 手工改过 → 以后不再被自动重算覆盖
      await bulkPutStudents(db, [s]);
      toast('已更新拼音首字母'); drawStudents(box);
      return;
    }
    const rn = e.target.closest('[data-rename]');
    if (rn) {
      const s = students.find(x => x.id === rn.dataset.rename);
      const nv = await askText({ title: '改姓名', label: '新姓名（2~4 字）', value: s.name, okText: '保存', maxlength: 4 });
      if (nv) { s.name = nv; if (!s.pyManual) s.pinyin = nameInitials(s.name); await bulkPutStudents(db, [s]); toast('已更新'); drawStudents(box); }
      return;
    }
    const out = e.target.closest('[data-out]');
    if (out) {
      const s = students.find(x => x.id === out.dataset.out);
      if (out.dataset.cfm !== '1' && !s.out) {
        out.dataset.cfm = '1'; out.textContent = '确认转出?'; return;
      }
      s.out = s.out ? 0 : 1;
      await bulkPutStudents(db, [s]);
      toast(s.out ? '已转出：不再出现在选学生 / 收缴点名 / 未记录待办；成长记录保留' : '已转回在册');
      drawStudents(box);
    }
  };
}

/* ---------- 学期管理 ---------- */
// 🔴 学期名固定成「2026-2027 学年 第一学期」，**不给老师自由输入**：
//    「同一个学期、两种叫法」会让导入认不出来（见 openRestore 的两步认学期），
//    于是列表里堆出两个学期，哪份数据属于谁看不出来（老师实际踩到）。
export function openSemesters() {
  const p = openPicker({
    title: '学期管理',
    lead: '一学期一库。新建继承名单、分类、标签；记录 / 图片 / 课表 / 收缴不继承。',
    body: '<div style="padding:12px 14px" id="sm-box"></div>',
    foot: `<button class="btn ghost" data-pclose>关闭</button><button class="btn" id="sm-new">＋ 新建学期</button>`
  });
  const draw = async () => {
    const sems = await listSemesters();
    const box = p.body.querySelector('#sm-box');
    box.innerHTML = sems.map(s => {
      const cur = s.id === state.currentSemesterId;
      const tag = s.status === 'cleared' ? ['本机已清除', 'no']
        : s.status === 'archived' ? ['已归档', '']
        : s.status === 'active' ? ['在用', 'yes']
        : ['未在用', ''];
      return `<div class="li" data-go="${esc(s.id)}">
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(s.name)}${cur ? ' <span class="pill yes">当前</span>' : ''} <span class="pill ${tag[1]}">${tag[0]}</span></div>
          <div class="meta" data-size="${esc(s.id)}">${s.startAt ? new Date(s.startAt).toLocaleDateString('zh-CN') : '—'}</div>
        </div>
        ${cur ? '' : `<button class="mini danger" data-del="${esc(s.id)}">删除</button>`}
      </div>`;
    }).join('') || '<div class="empty">还没有学期</div>';
    // 行内补上真实体量 —— 删除前老师得看见自己删的是什么
    for (const s of sems) {
      const el = box.querySelector(`[data-size="${s.id}"]`);
      const sz = await semSize(s.id);
      if (el && sz) el.textContent += ' · ' + sz;
    }
    box.onclick = async e => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const s2 = (await listSemesters()).find(x => x.id === del.dataset.del);
        if (s2) removeSemesterFlow(s2, draw);
        return;
      }
      const row = e.target.closest('[data-go]'); if (!row) return;
      const s = (await listSemesters()).find(x => x.id === row.dataset.go);
      if (!s || s.id === state.currentSemesterId) { p.close(); return; }
      if (s.status === 'cleared') { toast('该学期本机数据已清除，只能看归档文件'); return; }
      if (s.status === 'archived') { toast('该学期已归档，不在本应用内打开'); return; }
      await switchSemester(s); p.close();
    };
  };
  draw();

  // 新建学期：**学年 + 学期两个下拉**，拼固定名。同名视为同一学期 ⇒ 提示切过去，不再造第二个。
  p.foot.querySelector('#sm-new').onclick = async () => {
    const sems = await listSemesters();
    // 默认值 = **今天所在的学期**（`curSemName()`：8/1 起 = 当年…次年第一学期；8/1 前 = 上一年…当年第二学期）。
    // 🔴 日期边界只在 util.js::curStartYear() 一处算，这里别再自己比 getMonth()。
    // ⚠️ 如果那个学期本机已经建过，就顺着 `nextSemName()` 往后挪到**第一个还没建的** ——
    //    否则默认值指着一个已有学期，老师一点「创建」只会撞上「这个学期已经有了」。
    let dft = curSemName();
    const taken = new Set(sems.map(s => normSemName(s.name)));
    for (let i = 0; i < 8 && taken.has(normSemName(dft)); i++) dft = nextSemName(dft);
    let year = semStartYear(dft) || new Date().getFullYear();
    let term = /第二学期/.test(dft) ? 2 : 1;
    // 起始学年候选走下拉。⚠️ 默认值**必须**在候选里，否则 select 会自己落到第一项、和 year 变量不同步
    const years = semYearOptions(sems.map(s => s.name));
    if (!years.includes(year)) { years.push(year); years.sort((a, b) => b - a); }
    const np = openPicker({
      title: '新建学期',
      lead: '学期名按固定格式生成，不自由输入',
      body: `<div style="padding:12px 14px">
        <div class="kv" style="border:none"><span>起始学年</span></div>
        <select class="yrs" id="sm-year" aria-label="起始学年">${years.map(y =>
          `<option value="${y}"${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select>
        <div class="kv"><span>学期</span></div>
        <div class="seg sm" id="sm-term">
          <button data-v="1"${term === 1 ? ' class="on"' : ''}>第一学期</button>
          <button data-v="2"${term === 2 ? ' class="on"' : ''}>第二学期</button>
        </div>
        <div class="save-note" id="sm-prev"></div>
      </div>`,
      foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn" id="sm-ok">创建</button>`
    });
    const sync = () => {
      np.body.querySelector('#sm-prev').innerHTML =
        `将创建：<b>${esc(semNameOf(year, term))}</b>。名单从当前学期复制（转出的学生不带过去），记录 / 图片 / 课表不继承。`;
    };
    onSeg(np.body.querySelector('#sm-term'), v => { term = Number(v); sync(); });
    // 起始学年是原生下拉 ⇒ 用 change（onSeg 是给 .seg 分段按钮用的）
    np.body.querySelector('#sm-year').onchange = e => { year = Number(e.target.value); sync(); };
    sync();
    np.foot.querySelector('#sm-ok').onclick = async () => {
      const name = semNameOf(year, term);
      const sems2 = await listSemesters();
      const same = sems2.find(s => normSemName(s.name) === normSemName(name));
      if (same) {
        const go = await confirmAsync({
          title: '这个学期已经有了',
          msg: `本机已经有「${same.name}」。\n\n同一个学期只留一个 —— 切过去继续用它吗？`,
          okText: '切过去'
        });
        if (go) { np.close(); await switchSemester(same); p.close(); }
        return;
      }
      const ns = { id: 'sem_' + Date.now().toString(36), name, startAt: Date.now(), status: 'active' };
      await ensureSemester(ns);
      const from = openSemester(state.currentSemesterId);
      try {
        const stu = (await from.students.toArray()).filter(s => !s.out).map(s => ({ ...s, id: 's' + Math.random().toString(36).slice(2, 9), pinyin: s.pyManual ? s.pinyin : nameInitials(s.name) }));
        const to = openSemester(ns.id);
        await bulkPutStudents(to, stu);
      } catch (_) {}
      sems2.forEach(s => { if (s.status === 'active') putSemester({ ...s, status: 'inactive' }); });
      np.close();
      await switchSemester(ns); p.close();
    };
  };
}

// 删除学期：任何**非当前**学期都能删（当前学期要先切走，否则删完老师没地方记录）
// 🔴 删的是「本机这份副本」，不是世界末日：**快照不受影响**，以后还能从快照里捞回学生 ——
//    文案里必须说清楚，否则老师会把"能捞回"误当成"删了也无所谓"。
async function removeSemesterFlow(s, render) {
  const sz = await semSize(s.id);
  const empty = /^\s*0 人 · 0 条/.test(sz);
  const snaps = (await listSnaps().catch(() => [])).filter(x => x.semesterId === s.id);

  const doIt = async () => {
    try {
      await deleteSemester(s.id);
      await removeSemester(s.id);
      toast('已删除学期');
    } catch (e) {
      banner('errBanner', `⚠️ 删除失败：<b>本机数据未被改动</b>（${esc(e.message || e)}）。`);
    }
    refresh(); if (render) render();
  };

  // 空学期：没有数据可丢，不折腾老师
  if (empty) {
    const ok = await confirmAsync({
      title: '删除空学期', danger: true,
      msg: `「${s.name}」里一个学生、一条记录都没有。\n\n删除后从学期列表里移除。`,
      okText: '删除'
    });
    if (ok) await doIt();
    return;
  }

  // 有数据：把体量念出来 + 两个必勾框（照 openCleanup 的做法，不让人手滑）
  const p = openPicker({
    title: '删除这个学期',
    lead: '这个学期里有数据，请先确认它有别的着落',
    body: `<div style="padding:14px 16px">
      <div class="kv" style="border:none"><span>学期</span><b>${esc(s.name)}</b></div>
      <div class="kv"><span>将删除</span><b>${esc(sz)}</b></div>
      <div class="kv"><span>图片 / 课表 / 作息</span><b>一并移除</b></div>
      <div class="save-note">${snaps.length
        ? `本机留着这个学期的 <b>${snaps.length} 份快照</b>，删学期<b>不会动它们</b>，以后还能从快照里把学生捞回来。`
        : '⚠️ 本机<b>没有</b>这个学期的快照 —— 删了就找不回来了。建议先去「💾 导出备份」导一份。'}</div>
      <label class="li" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="ds-1"><span>我已经导出备份（或已归档、手上有 .html 报告）</span></label>
      <label class="li" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="ds-2"><span>我知道删完本应用就不认识这个学期了</span></label>
    </div>`,
    foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn danger" id="ds-ok" disabled>删除这个学期</button>`
  });
  const b1 = p.body.querySelector('#ds-1'), b2 = p.body.querySelector('#ds-2');
  const okB = p.foot.querySelector('#ds-ok');
  const sync = () => { okB.disabled = !(b1.checked && b2.checked); };
  b1.onchange = sync; b2.onchange = sync;
  okB.onclick = async () => { p.close(); await doIt(); };
}
export async function switchSemester(s) {
  try {
    if (localStorage.getItem('bzr_draft_' + state.currentSemesterId)) {
      // 🔴 不用 window.confirm：预览面板（sandboxed iframe）会静默返回 false ⇒ 老师点「切换学期」像没反应
      const ok = await confirmAsync({
        title: '有未保存的草稿',
        msg: '草稿会保留在当前学期，不会丢。确定切换学期吗？',
        okText: '切换'
      });
      if (!ok) return;
    }
  } catch {}
  const sems = await listSemesters();
  for (const x of sems) if (x.status === 'active' && x.id !== s.id) await putSemester({ ...x, status: 'inactive' });
  await putSemester({ ...s, status: 'active' });
  setSemester(s);
  await meta.settings.put({ key: 'currentSemester', value: s.id });
  toast('已切换到 ' + s.name);
  refresh();
}

/* ---------- 归档（只盖章 + 产两份文件，零删除） ---------- */
// 🔴 v1.5.0：归档与删除彻底解耦。
//    旧版是「导出 → 立即清表 → 7 天后自动删库」，删除风险全压在"导出是否成功"这一个前提上；
//    现在归档**永不删数据**，省空间由老师到档案柜点「清除本机副本」（见 clearSemesterCopy）。
async function doArchive() {
  const sem = state.semester;
  const now = Date.now();
  let jsonName, htmlName, pack;
  try {
    pack = await buildExportPack();
    jsonName = archiveFileName(sem?.name, 'json', now);
    htmlName = archiveFileName(sem?.name, 'html', now);
    const jsonText = JSON.stringify(pack);
    const htmlText = buildArchiveHTML(pack);
    download(jsonName, jsonText, 'application/json');
    download(htmlName, htmlText, 'text/html');
    await putSemester({
      ...sem, status: 'archived', archivedAt: now,
      archivedFiles: { json: jsonName, html: htmlName, bytes: { json: jsonText.length, html: htmlText.length } }
    });
    state.semester = { ...sem, status: 'archived', archivedAt: now, archivedFiles: { json: jsonName, html: htmlName } };
  } catch (e) {
    banner('errBanner', `⚠️ 归档失败：<b>本机数据未做任何改动</b>（可重试）。${esc(e.message || e)}`);
    return;
  }
  toast('已归档：两份文件已下载，请存到电脑或网盘');
  warnImageErrors(pack);                        // 🔴 若有图没带上，如实告知（归档包同样要可信）
  banner('archiveBanner',
    `📚 「${esc(sem?.name || '本学期')}」已归档。两份文件（<b>.json</b> 备份 / <b>.html</b> 报告）请存到电脑或网盘；要省空间可到档案柜「清除本机副本」。`,
    'warn');
  // 归档只是盖章：本机数据照旧，只是要换个学期继续记录
  const sems = await listSemesters();
  const next = sems.find(s => s.status === 'active' && s.id !== state.currentSemesterId);
  if (next) await switchSemester(next);
  else {
    // 🔴 不再写死 '新学期'：那会造出一堆同名的学期（导入时再也认不出谁是谁）。
    //    按当前学期名顺延：第一学期 → 第二学期；第二学期 → 下一学年第一学期。
    const taken = new Set(sems.map(x => normSemName(x.name)));
    let nn = nextSemName(sem && sem.name), guard = 0;
    while (taken.has(normSemName(nn)) && guard++ < 8) nn = nextSemName(nn);
    const ns = { id: 'sem_' + Date.now().toString(36), name: nn, startAt: Date.now(), status: 'active' };
    await ensureSemester(ns); await seedBaseline(openSemester(ns.id)); await switchSemester(ns);
  }
  refresh();
}

/* ---------- 清除本机副本（归档之后的独立动作；二次确认后才删库） ---------- */
// 🔴 决策：清除后**不能反悔** —— 所以确认框必须把两份归档文件的名字念给老师听，让他自己核对
function clearSemesterCopy(s, render) {
  const f = s.archivedFiles || {};
  const jn = f.json || s.archivedFileName || '（未记录文件名）';
  const hn = f.html || '（未记录文件名）';
  confirm({
    title: '清除本机副本', danger: true,
    // 🔴 msg 走 esc 渲染（不解析 HTML）⇒ 这里用纯文本 + 换行，不要写 <b> / <br>
    msg: `将删除本机「${s.name}」的全部数据（记录 / 图片 / 名单）。\n\n`
      + `此操作不可恢复 —— 清除后本应用不再认识这个学期。\n\n`
      + `请先确认两份归档文件已在电脑或网盘上：\n· ${jn}\n· ${hn}`,
    okText: '文件已在手，清除',
    onOk: async () => {
      try {
        await deleteSemester(s.id);
        await putSemester({ ...s, status: 'cleared', clearedAt: Date.now() });
        toast('本机副本已清除');
      } catch (e) {
        banner('errBanner', `⚠️ 清除失败：<b>本机数据未被删除</b>（${esc(e.message || e)}）。`);
      }
      refresh(); if (render) render();
    }
  });
}

/* ---------- 导入（按内容分流 → 主路一键还原 / 岔路替换） ---------- */
// 🔴 模型：**导出是保险，导入是还原**，不是"两台设备把数据合起来"。
//    手机是唯一主力记录端；导入只出现在三种时候：① 换手机 ② 换了网址（origin 变了 ⇒ 旧库读不到）
//    ③ 其他意外。⇒ 主路（本机没有这个学期）**零决策**；只有本机已经有这个学期时才有一个岔路。
function openImport() {
  const p = openPicker({
    title: '导入备份',
    lead: '导入一般用在：<b>换手机、换了网址、浏览器数据被清</b>。平时不用导入。',
    body: `<div style="padding:14px 16px">
      <div class="drop" id="im-drop">点击选择备份文件（.json）<input type="file" id="im-file" accept="application/json,.json" style="display:none"></div>
      <div class="err" id="im-err"></div>
      <div class="save-note"><b>三种文件都能喂进来</b>：学期备份（全量）/ 归档文件 / 作息时间小文件 —— 应用按内容自己判断，不用你挑。</div>
    </div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });
  const drop = p.body.querySelector('#im-drop');
  const input = p.body.querySelector('#im-file');
  drop.onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); }
    catch { p.body.querySelector('#im-err').textContent = '❌ 不是合法 JSON 备份文件'; return; }
    // 🔴 这里必须 afterBack：p.close() 里的 history.back() 是异步的，
    //    紧接着开的新弹层会被那个迟到的 popstate 当成栈顶打回
    //    ⇒ 老师选完文件后「什么也没发生」（真机实测复现）。
    p.close();
    afterBack(() => openImportPack(data));
  };
}

// 🔴 统一入口（文件导入 / 快照恢复共用）：先按**内容**分流，再决定做什么
export async function openImportPack(data) {
  const kind = kindOfFile(data);
  if (kind === 'unknown') {
    banner('errBanner', '⚠️ 这不是本应用的备份文件（或结构不完整）—— <b>没有改动任何数据</b>。');
    return;
  }
  if (kind === 'periods') return importPeriods(data);
  return openRestore(data);
}

// 本机某个学期有多大 —— 替换 / 删除的文案都要念出真实体量，只念学期名老师没法判断
async function semSize(id) {
  try {
    const db = openSemester(id);
    await ensureOpen(db, id);
    return `${await db.students.count()} 人 · ${await db.growth_records.count()} 条记录`;
  } catch (_) { return ''; }
}

// 整学期备份：先摊开"这一份里有什么"，再按「本机有没有这个学期」给一条路
async function openRestore(file) {
  const errs = [];
  if (!file.schemaVersion) errs.push('缺 schemaVersion');
  if (file.schemaVersion > SCHEMA_VERSION) errs.push(`文件版本 ${file.schemaVersion} 高于本机 ${SCHEMA_VERSION}，请先升级应用`);
  if (!file.semesterId) errs.push('缺 semesterId（无法判断属于哪个学期）');
  if (errs.length) { banner('errBanner', '⚠️ ' + errs.join('；') + ' —— <b>没有改动任何数据</b>。'); return; }

  const sems = await listSemesters();
  const semName = (file.semester && file.semester.name) || '导入的学期';

  // 🔴 「本机已经有这个学期」要**认两步** —— 这是「导入完凭空多出一个学期」的根因修复：
  //    ① 先按学期库 id 认（同一台设备、没换过网址）
  //    ② id 认不到，再按**学期名归一化**认 —— 换手机 / 换网址后学期库 id 一定不同，
  //       但那就**是同一个学期**。只按 id 认会往列表里再堆一个（老师实际踩到：
  //       两个学期并列，哪份数据属于谁看不出来，还删不掉）。
  let mine = sems.find(s => s.id === file.semesterId) || null;
  let why = mine ? 'id' : '';
  if (!mine) {
    const norm = normSemName(semName);
    const hit = sems.find(s => normSemName(s.name) === norm);
    if (hit) { mine = hit; why = 'name'; }
  }
  const occupied = !!mine && mine.status !== 'cleared';
  const archived = occupied && mine.status === 'archived';
  // 本机没有任何「还在」的学期（没有 / 全被清过）⇒ 换了网址后的首次恢复，走零决策主路
  const brandNew = !sems.filter(s => s.status !== 'cleared').length;

  const stu = file.students || [], recs = file.records || [], imgs = file.images || [];
  const periods = (file.schedule && file.schedule.periods) || [];
  const wk = (file.schedule && file.schedule.homeroom && file.schedule.homeroom.weekly) || [];
  const outN = stu.filter(s => s.out).length;
  const localN = occupied ? await semSize(mine.id) : '';

  const p = openPicker({
    title: '导入备份',
    lead: '这一份里有什么',
    body: `<div style="padding:14px 16px">
      <div class="kv" style="border:none"><span>来源学期</span><b>${esc(semName)}</b></div>
      <div class="kv"><span>来源设备 / 时间</span><b>${esc(file.device || '—')} · ${new Date(file.exportedAt || Date.now()).toLocaleString('zh-CN')}</b></div>
      <div class="kv"><span>名单</span><b>${stu.length} 人${outN ? `（含转出 ${outN}）` : ''}</b></div>
      <div class="kv"><span>记录 / 图片</span><b>${recs.length} 条 · ${imgs.length} 张</b></div>
      <div class="kv"><span>课表 / 作息</span><b>${wk.length} 节 · ${periods.length} 项</b></div>
      <div id="im-info"></div>
    </div>`,
    foot: `<button class="btn ghost" data-pclose>关闭</button><button class="btn" id="im-go" style="display:none"></button>`
  });
  const info = p.body.querySelector('#im-info');
  const go = p.foot.querySelector('#im-go');
  // 🔴 关掉这个弹层再开结果单：同样必须 afterBack（理由同上）
  const run = opts => { p.close(); afterBack(() => doRestore(file, { semName, targetId: mine && mine.id, ...opts })); };

  if (occupied && !archived) {
    // 岔路：只有一个动作 —— 替换（"另存为新学期副本"已取消，兜底交给快照）
    const how = why === 'name'
      ? `本机有一个名字对得上的「<b>${esc(mine.name)}</b>」`
      : `本机已经有一个「<b>${esc(mine.name)}</b>」`;
    info.innerHTML = `
      <div class="save-note" style="border:none">${how}${mine.id === state.currentSemesterId ? '，就是当前学期' : '（在用）'}${localN ? ' · ' + esc(localN) : ''}。</div>
      <div class="save-note">只有一个选择：<b>用这份备份替换它</b>。替换前会自动存一份「导入前快照」（存在独立备份库里，清缓存也还在），随时可回退。</div>`;
    go.textContent = '用备份替换它';
    go.className = 'btn danger';
    go.style.display = '';
    go.onclick = () => confirm({
      title: '用备份替换', danger: true,
      // 🔴 msg 走 esc 渲染（不解析 HTML）⇒ 纯文本 + \n，不要写 <b> / <br>
      msg: `将用备份替换本机「${mine.name}」的全部数据。\n\n`
        + `本机现有的${localN ? localN + '、' : ''}全部图片会被删除，换成备份里的内容。\n\n`
        + `替换前会自动存一份「导入前快照」（独立备份库，清缓存也还在），可回退。\n\n`
        + `确定替换吗？`,
      okText: '替换', onOk: () => run({ replace: true })
    });
  } else if (archived) {
    // 已归档：不主动推荐，只给折叠的次要出口（归档意味着学期结束、报告已出，一般不需要导回）
    info.innerHTML = `
      <div class="save-note" style="border:none">本机这个学期<b>已经归档</b>（只读历史）—— <b>一般不需要导回</b>。</div>
      <details style="margin-top:10px">
        <summary class="muted" style="font-size:12px;cursor:pointer">仍然要用备份替换它</summary>
        <div class="save-note" style="margin-top:8px">替换后它会回到「在用」。替换前会自动存一份「导入前快照」，可回退。</div>
        <button class="btn danger mt" id="im-replace">用备份替换它</button>
      </details>`;
    p.body.querySelector('#im-replace').onclick = () => run({ replace: true });
  } else if (brandNew) {
    // 主路：本机一个学期都没有（换网址后的首次恢复）⇒ 零决策，一条路走到底
    info.innerHTML = `
      <div class="save-note" style="border:none"><b>本机还没有任何学期</b> → 会新建并完整还原，装完自动切过去。</div>
      <div class="save-note">还原内容：名单（含转出）/ 记录（含回收站里的）/ 图片 / 课表 + 作息。收缴单不进备份、不还原。</div>`;
    go.textContent = '开始还原';
    go.style.display = '';
    go.onclick = () => run({ replace: false });
  } else {
    // 🔴 本机有学期，但 id 和名字都对不上 ⇒ **绝不静默新建**。
    //    旧版在这里直接新建，结果列表里堆出两个学期（老师原话：「整个数据就变得不透明了」）。
    //    判断权交回老师：默认「这是同一个学期，只是叫法不同」，「确实不同、要新建」收进折叠。
    const alive = sems.filter(x => x.status !== 'cleared');
    const target = alive.find(x => x.id === state.currentSemesterId) || alive[0];
    const targetN = target ? await semSize(target.id) : '';
    info.innerHTML = `
      <div class="save-note" style="border:none">本机已经有 <b>${alive.length} 个学期</b>，但这份备份的学期名「<b>${esc(semName)}</b>」和它们<b>都对不上</b>。</div>
      <div class="save-note">最常见的是：<b>这本来就是同一个学期，只是两边叫法不同</b>（换手机、换网址后连学期库 id 也会变）。<b>别急着新建</b> —— 学期一多，哪份数据属于谁就看不出来了。</div>
      <div class="kv" style="border:none"><span>本机将替换</span><b>${esc(target ? target.name : '—')}${targetN ? ' · ' + esc(targetN) : ''}</b></div>
      <div class="save-note">如果你确定这<b>是另一个学期</b>，展开下面那一行。</div>
      <details style="margin-top:6px">
        <summary class="muted" style="font-size:12px;cursor:pointer">确实不是同一个学期，我要新建一个装它</summary>
        <div class="save-note" style="margin-top:8px">会新建「${esc(semName)}」，列表里就有 ${alive.length + 1} 个学期了。</div>
        <button class="btn ghost mt" id="im-new">新建并还原</button>
      </details>`;
    if (target) {
      go.textContent = `用备份替换「${target.name}」`;
      go.className = 'btn danger';
      go.style.display = '';
      go.onclick = () => confirm({
        title: '用备份替换', danger: true,
        msg: `将用备份替换本机「${target.name}」的全部数据。\n\n`
          + `本机现有的${targetN ? targetN + '、' : ''}全部图片会被删除，换成备份里的内容。\n\n`
          + `替换前会自动存一份「导入前快照」（独立备份库，清缓存也还在），可回退。\n\n`
          + `确定替换吗？`,
        okText: '替换', onOk: () => run({ replace: true, targetId: target.id })
      });
    }
    p.body.querySelector('#im-new').onclick = () => run({ replace: false });
  }
}

// 真正落库：新建 / 替换整学期，然后切过去（或原地刷新）
async function doRestore(file, { replace, semName, targetId }) {
  // 🔴 目标学期 id **不再等于** file.semesterId —— 认学期之后，要替换的是**本机那个学期**
  //    （可能是按名字认出来的，id 和备份里的不一样）。旧版写死用 file.semesterId，
  //    于是「同一学期换了网址」这种情况会写进一个新库 ⇒ 凭空多出一个学期。
  const semId = replace && targetId ? targetId : file.semesterId;
  try { await ensureOpen(openSemester(semId), semId); }
  catch (e) { banner('errBanner', `⚠️ 无法打开目标学期库（${esc(e.message || e)}）—— <b>没有改动任何数据</b>。`); return; }

  const sems = await listSemesters();
  const mine = sems.find(s => s.id === semId);
  const occupied = !!mine && mine.status !== 'cleared';
  const archived = occupied && mine.status === 'archived';

  // 🔴 替换档的第一件事，永远是先存「导入前快照」—— 这是唯一的退路。
  //    存不下就**中止**：宁可不让替换，也不能让它变成不可回退。
  if (replace) {
    const key = await snapshotSemester(openSemester(semId), semId, (mine && mine.name) || semName, '导入前');
    if (!key) { banner('errBanner', '⚠️ 「导入前快照」存不下来（本机备份库不可用），已中止替换 —— <b>本机数据一点没动</b>。'); return; }
    await pruneSnaps('preimport', semId, 2);
  }

  // 🔴 学期行必须**显式回写 status**：本机若是 cleared，数据虽写进了 bzr_<id>，
  //    但切换器会把它过滤掉、学期管理页也会拦住点击 ⇒ 老师根本进不去那个学期
  //    （表现就是「导入完什么都没有」）。这是 P0-4。
  //    ⚠️ 但**不能无条件写 inactive**：最常见的一支就是「替换当前学期」，
  //    把它改成 inactive 会让 meta 里一个 active 都没有（顶栏 / 学期管理看着像"没有在用学期"）。
  // ⚠️ 替换档**不改学期名**：名字是老师自己定的，替换的是数据不是名字
  //    （按名字认出来的那一支，本机名和备份名本来就不同，改了反而看不出是哪个）。
  const startAt = (file.semester && file.semester.startAt) || file.exportedAt || Date.now();
  const finalName = (replace && mine && mine.name) ? mine.name
    : (sems.some(s => s.name === semName && s.id !== semId) ? `${semName}（导入 ${stamp().slice(0, 10)}）` : semName);
  if (replace && occupied && !archived) {
    await ensureSemester({ ...mine });          // 在用：名字 / 状态 / id 全保留
  } else {
    // 本机没有 / 已清除 / 已归档 ⇒ 统一落成 inactive（可见、可切换）
    //   · 本机没有 → 随后主路 switchSemester 会把它置为 active
    //   · 已清除 → 必须显式回写，否则切换器把它过滤掉、老师进不去（P0-4）
    //   · 已归档 → 与弹层文案一致：替换后回到「在用」
    await ensureSemester({ id: semId, name: finalName, startAt, status: 'inactive' }, { status: 'inactive' });
  }

  let r = { imgBad: [] };
  try { r = await restoreSemesterFromPack(openSemester(semId), file); }
  catch (e) { banner('errBanner', `⚠️ 还原失败：${esc(e.message || e)}（事务已回滚，本机数据未被改动）。`); return; }
  // 老备份可能没带分类 / 标签 ⇒ 补一次预设（幂等，只补缺）
  try { await seedTaxonomy(openSemester(semId)); } catch (_) {}

  const bad = (r.imgBad || []).length;
  const stuN = (file.students || []).length, recN = (file.records || []).length;
  const imgN = Math.max(0, (file.images || []).length - bad);
  const outName = (mine && mine.name) || finalName;

  if (replace) {
    refresh();
    showResult({ semName: outName, stuN, recN, imgN, bad, replace: true, switched: false });
  } else {
    // 主路：新建出来的这个学期就是老师要恢复的那个 ⇒ 装完自动切过去
    await switchSemester({ id: semId, name: finalName, startAt: Date.now(), status: 'inactive' });
    showResult({ semName: finalName, stuN, recN, imgN, bad, replace: false, switched: true });
  }
}

// 结果单（只弹一次，关掉就散；不另建可回看入口）
function showResult({ semName, stuN, recN, imgN, bad, replace, switched }) {
  openPicker({
    title: replace ? '替换完成' : '还原完成',
    lead: '数据已经装回去了',
    body: `<div style="padding:14px 16px">
      <div class="kv" style="border:none"><span>学期</span><b>${esc(semName)}</b>${switched ? ' <span class="pill yes">当前</span>' : ''}</div>
      <div class="kv"><span>名单</span><b>${stuN} 人</b></div>
      <div class="kv"><span>记录 / 图片</span><b>${recN} 条 · ${imgN} 张</b></div>
      ${bad ? `<div class="save-note danger">⚠️ 有 ${bad} 张图片没能装回去（记录文字是完整的）。</div>` : ''}
      <div class="save-note">${switched ? '已自动切换到这个学期，可以直接开始记录。' : '本机当前学期没有变 —— 要看它请到「切换 / 管理学期」。'}</div>
    </div>`,
    foot: `<button class="btn" data-pclose>好</button>`
  });
}

// 作息小文件：🔴 只更新当前学期的「作息时间」，周课表 / 科目 / 班级一概不动
// （周课表是按节次下标引用作息的 ⇒ 作息单独换、周课表不换必然错位。所以整学期还原时它俩一起走。）
function importPeriods(file) {
  const per = (file.periods || []).filter(p => p && (p.name || p.no));
  if (!per.length) { banner('errBanner', '⚠️ 这个作息文件里没有节次 —— <b>没有改动任何数据</b>。'); return; }
  const p = openPicker({
    title: '导入作息时间',
    lead: '只更新<b>作息时间</b>（夏 / 冬各一套），周课表、科目与班级一概不动。',
    body: `<div style="padding:14px 16px">
      <div class="kv" style="border:none"><span>来源</span><b>${esc(file.semester || file.device || '—')}</b></div>
      <div class="kv"><span>导出时间</span><b>${file.exportedAt ? new Date(file.exportedAt).toLocaleString('zh-CN') : '—'}</b></div>
      <div class="kv"><span>节次</span><b>${per.length} 个</b></div>
      <div class="save-note" style="border:none">${per.map(x => esc(x.name || '')).filter(Boolean).join(' · ')}</div>
      <div class="save-note danger">本机现有的作息时间会被这份替换（已经排好的课不受影响）。</div>
    </div>`,
    foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn" id="ip-ok">导入作息</button>`
  });
  p.foot.querySelector('#ip-ok').onclick = async () => {
    try {
      const db = state.db;
      const sched = (await getSchedule(db)) || { periods: [] };
      sched.periods = per;
      await saveSchedule(db, sched);
      p.close(); toast('作息时间已导入'); refresh();
    } catch (e) { banner('errBanner', `⚠️ 导入失败：${esc(e.message || e)}（数据未被改动）。`); }
  };
}

// 作息文件的专用入口（班务页「导入作息」调用）：
// 🔴 这条路**只收作息文件** —— 喂进整学期备份会被拒绝并指引到「数据页 → 导入备份」。
//    理由：老师从班务页点「导入作息」，心里想的是「换一下时间表」；若顺手把整份备份喂进来就触发
//    「替换整学期」（连同名单记录图片一起换掉），那是个危险得多的动作，不该藏在一个叫「作息」的按钮后面。
export function openPeriodsImport() {
  const p = openPicker({
    title: '导入作息时间',
    lead: '选一个<b>作息文件</b>（.json）。只更新时间表，周课表 / 名单 / 记录一概不动。',
    body: `<div style="padding:14px 16px">
      <div class="drop" id="pi-drop">点击选择作息文件（.json）<input type="file" id="pi-file" accept="application/json,.json" style="display:none"></div>
      <div class="err" id="pi-err"></div>
      <div class="save-note">没有作息文件？在「作息时间表」里点<b>导出作息</b>生成一个；整学期的备份请到<b>数据 → 导入备份</b>。</div>
    </div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });
  const drop = p.body.querySelector('#pi-drop');
  const input = p.body.querySelector('#pi-file');
  const err = p.body.querySelector('#pi-err');
  drop.onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); }
    catch { err.textContent = '❌ 不是合法 JSON 文件'; return; }
    if (kindOfFile(data) !== 'periods') {
      err.textContent = '❌ 这不是作息文件 —— 整学期备份请到「数据 → 导入备份」。';
      return;
    }
    // 🔴 必须 afterBack：p.close() 里的 history.back() 是异步的，
    //    紧接着开的导入确认弹层会被那个迟到的 popstate 当成栈顶打回（真机实测「点了没反应」）。
    p.close();
    afterBack(() => importPeriods(data));
  };
}

/* ---------- 回收站 ---------- */
function openTrash() {
  const p = openPicker({
    title: '回收站',
    lead: `软删记录保留 ${state.settings.recycleDays || 30} 天，可恢复；彻底删除后图片也会清理。`,
    body: '<div style="padding:12px 14px" id="tr-box"></div>',
    foot: `<button class="btn danger" id="tr-purge">清空回收站</button><button class="btn" data-pclose>完成</button>`
  });
  const draw = async () => {
    const del = await listDeleted(state.db);
    const ss = await listStudents(state.db, { includeOut: true });
    const nm = id => ss.find(s => s.id === id)?.name || id;
    p.body.querySelector('#tr-box').innerHTML = del.length ? del.map(r => `
      <div class="trash-row">
        <div class="t"><b>${esc(nm(r.studentId))} · ${esc(r.date)}</b><span>${esc((r.text || '（无评语）').slice(0, 40))}</span></div>
        <button class="mini" data-re="${esc(r.id)}">恢复</button>
        <button class="mini danger" data-hard="${esc(r.id)}">彻底删除</button>
      </div>`).join('') : emptyState('回收站是空的');
    p.body.querySelector('#tr-box').onclick = async e => {
      const re = e.target.closest('[data-re]');
      if (re) { await restoreRecord(state.db, re.dataset.re); toast('已恢复'); draw(); refresh(); return; }
      const hd = e.target.closest('[data-hard]');
      if (hd) {
        confirm({ title: '彻底删除', msg: '不可恢复，其图片也会一并删除。', danger: true, onOk: async () => {
          const r = await state.db.growth_records.get(hd.dataset.hard);
          for (const id of (r?.imageIds || [])) { try { await deleteImage(state.db, id); } catch {} }
          await state.db.growth_records.delete(hd.dataset.hard);
          toast('已彻底删除'); draw(); refresh();
        }});
      }
    };
  };
  draw();
  p.foot.querySelector('#tr-purge').onclick = () => confirm({
    title: '清空回收站', msg: '全部彻底删除，不可恢复。', danger: true, okText: '清空',
    onOk: async () => {
      const del = await listDeleted(state.db);
      for (const r of del) {
        for (const id of (r.imageIds || [])) { try { await deleteImage(state.db, id); } catch {} }
        await state.db.growth_records.delete(r.id);
      }
      toast('回收站已清空'); p.close(); refresh();
    }
  });
}

/* ---------- 设置页（七组 + 极速记录默认分类，§4.8.18） ---------- */
// 🔴 可拍 / 不可拍清单：与记录页共用同一份常量，文案不会漂移
function showPhotoRule() {
  openPicker({
    title: '拍摄规范（只拍物，不拍人）',
    lead: '照片拍进来就留在本机，也可能被误转发。',
    body: `<div style="padding:14px 16px">
      <div class="sec" style="margin-top:0">✅ 可以拍</div>
      <div class="save-note" style="border:none">${PHOTO_OK.map(x => '· ' + esc(x)).join('<br>')}</div>
      <div class="sec">❌ 不要拍</div>
      <div class="save-note" style="border:none">${PHOTO_BAN.map(x => '· ' + esc(x)).join('<br>')}</div>
      <div class="save-note">💡 <b>主体合规不等于照片合规</b>：背景有座位表、角落露出姓名，同样不能外发。</div>
      <div class="save-note">要让 AI 了解画面，写一句文字即可（如「手抄报排版工整」），不必发照片。</div>
    </div>`,
    foot: `<button class="btn" data-pclose>知道了</button>`
  });
}

export async function openSettings() {
  const db = state.db;
  const sched = await getSchedule(db);
  const S = state.settings;
  const p = openPicker({
    title: '⚙️ 设置',
    body: `<div style="padding:14px 16px">
      <div class="sec">👤 教师信息</div>
      <div class="set-item">
        <div class="si-lb"><span>教师姓名</span><em>顶栏头像取姓名的第一个字</em></div>
        <div class="row" style="gap:10px;align-items:center">
          <div class="ava-c" id="st-ava">${esc(teacherInitial() || '＋')}</div>
          <input class="ta" id="st-tname" style="flex:1" value="${esc(S.teacherName || '')}" placeholder="如：李老师 / 李明">
        </div>
      </div>
      <div class="set-item">
        <div class="si-lb"><span>设备名</span><em>用于识别本机备份（自动生成，无需填写）</em></div>
        <div class="kv" style="margin:4px 0 2px"><b id="st-dev-now">${esc(effectiveDeviceName(sched))}</b></div>
        <div class="save-note" style="border:none;padding-top:6px">由「<b>本班班级 + 教师姓名</b>」自动生成，改这两处会同步变化。它会写进备份文件名，方便区分是哪台手机。</div>
      </div>

      <div class="sec">👓 无障碍</div>
      <div class="set-item">
        <div class="si-lb"><span>字号</span><em id="st-fs-hint">标准 · 正文 15px</em></div>
        <div class="seg" id="st-fs"><button data-v="std">标准</button><button data-v="big">大</button><button data-v="huge">超大</button></div>
        <div class="save-note" style="border:none;padding-top:6px">改动<b>立即生效</b>，无需重启。</div>
      </div>

      <div class="sec">⚡ 记录效率</div>
      <div class="set-item">
        <div class="si-lb"><span>极速记录默认分类</span><em>打开记录页先选中它</em></div>
        <div class="seg sm hscroll" id="st-dcat">${WUYU.map(w => `<button data-v="${esc(w)}">${esc(w)}</button>`).join('')}</div>
      </div>
      <div class="set-item">
        <div class="si-lb"><span>保存后行为</span><em>连续记同一人更快</em></div>
        <div class="seg" id="st-after"><button data-v="keep">保留当前学生</button><button data-v="clear">完全清空</button></div>
      </div>
      <div class="set-item">
        <div class="si-lb"><span>时间线默认版式</span><em>卡片</em></div>
        <div class="seg" id="st-tlmode"><button data-v="list">缩略图</button><button data-v="card">卡片</button><button data-v="cpt">紧凑</button></div>
      </div>
      <div class="set-item">
        <div class="si-lb"><span>时间线每页条数</span><em>分页加载，避免长列表卡</em></div>
        <div class="seg" id="st-tlpage"><button data-v="20">20 条</button><button data-v="50">50 条</button></div>
      </div>

      <div class="sec">📅 班务课表</div>
      <div class="set-item">
        <div class="si-lb"><span>班级课表单双周</span><em>开启后按单/双周轮换课表</em></div>
        <div class="seg" id="st-weeksplit"><button data-v="off" class="${S.classWeekSplit !== 'on' ? 'on' : ''}">不分（统一课表）</button><button data-v="on" class="${S.classWeekSplit === 'on' ? 'on' : ''}">分单双周</button></div>
        <div class="save-note" style="border:none;padding-top:6px">本班课表分<b>单 / 双周</b>两套，今日课表按当前周次自动切换。</div>
      </div>

      <div class="sec">🛡️ 数据保护</div>
      <div class="set-item">
        <div class="si-lb"><span>备份提醒</span><em id="st-bk-hint">—</em></div>
        <div class="seg" id="st-remind"><button data-v="weekly">每周</button><button data-v="biweekly">每两周</button><button data-v="off">关闭</button></div>
      </div>
      <div class="set-item">
        <div class="si-lb"><span>回收站</span><em>软删记录保留期内可恢复</em></div>
        <div class="kv" style="border:none;padding:0 0 6px"><span>当前存放</span><b id="st-trash-cnt">—</b></div>
        <div class="seg" id="st-keep"><button data-v="30">保留 30 天</button><button data-v="60">保留 60 天</button></div>
      </div>
      <div class="set-item">
        <div class="si-lb"><span>存储占用明细（估算）</span><em id="st-sto-hint">—</em></div>
        <div class="barsto" id="st-bar"><i class="r" style="width:0%"></i><i class="i" style="width:0%"></i><i class="o" style="width:0%"></i></div>
        <div class="lgd"><span class="r">记录 <b id="st-sto-rec">—</b></span><span class="i">图片 <b id="st-sto-img">—</b></span><span class="o">其他 <b id="st-sto-oth">—</b></span></div>
      </div>
      <div class="set-item">
        <div class="kv" style="border:none;padding:0 0 6px"><span>多余图片（无记录引用）</span><b id="st-orphan">0 张</b></div>
        <button class="mini" id="st-clean" style="width:100%">清理多余图片</button>
      </div>

      <div class="sec">🛡️ 隐私与合规</div>
      <div class="set-item">
        <div class="si-lb"><span>照片入库必须确认</span><em>勾选「画面已确认」后才能保存带图记录</em></div>
        <div class="seg sm" id="st-pguard"><button data-v="on">开（推荐）</button><button data-v="off">关</button></div>
        <div class="save-note" style="border:none;padding-top:6px">入库自动去掉位置等元信息（EXIF）；人脸、姓名、名单不会被自动识别，需你亲眼确认。</div>
      </div>
      <div class="set-item">
        <div class="si-lb"><span>AI 素材日期精度</span><em>外发给 AI 时日期保留到什么程度</em></div>
        <div class="seg sm" id="st-aidate"><button data-v="month">只到月</button><button data-v="full">保留完整</button></div>
        <div class="save-note" style="border:none;padding-top:6px">精确到天容易定位到具体学生；默认只到月。</div>
      </div>
      <div class="set-item">
        <div class="kv" style="border:none;padding:0 0 6px"><span>拍摄规范</span><b>只拍物、不拍人</b></div>
        <button class="mini" id="st-photorule" style="width:100%">查看可拍 / 不可拍清单</button>
      </div>
      <div class="set-item">
        <div class="kv" style="border:none;padding:0 0 6px"><span>会离开本设备的</span><b>只有你自己复制的 AI 素材</b></div>
        <div class="save-note" style="border:none">数据只存在这台设备，应用不联网、不上传。<b>AI 评语素材</b>是唯一外发口：姓名换成一次性代号，其他同学用泛称，照片不参与。</div>
      </div>
      <div class="save-note">未满 14 周岁的信息属《个人信息保护法》第 28 条<b>敏感个人信息</b>，教师不能代替学生对外授权；是否外发由你按学校要求判断。</div>

      <div class="sec">📱 学期与存储</div>
      <div class="kv"><span>当前学期</span><b>${esc(state.semester?.name || '—')}</b></div>
      <div class="kv"><span>存储持久化</span><span class="pill ${S.persisted ? 'yes' : 'no'}" id="st-persist">${S.persisted ? '已授权' : '未授权'}</span></div>
      <button class="btn ghost mt" id="st-req">${persistSupported() ? '申请持久化权限' : '如何让数据更安全'}</button>
      <div class="save-note" id="st-persist-note" style="margin-top:8px">${S.persisted
        ? '已获长期保存授权，浏览器清理时不会回收本应用数据。'
        : (persistSupported()
          ? '未授权：存储紧张时浏览器可能回收本应用数据，点上方按钮申请。'
          : '本机不支持「长期保存」。装到主屏后系统会按独立应用保存。')}</div>

      <div class="sec">ℹ️ 关于</div>
      <div class="kv"><span>版本 / Build</span><b>${APP_VER}</b></div>
      <div class="kv"><span>方案版本</span><b>${PLAN_VER} · 正面管教版</b></div>
      <div class="kv"><span>隐私模式</span><b>本机离线 · 数据不出设备</b></div>
      <div class="kv"><span>Origin</span><b style="word-break:break-all">${esc(window.location?.origin || '—')}</b></div>
      <button class="btn ghost mt" id="st-clear">🔄 刷新到最新版（不触业务数据）</button>
      <div class="save-note" style="margin-top:8px">更新后没看到新功能，就点上面这个按钮：清缓存、注销旧版离线脚本、重新加载。<b>已保存的名单与记录不受影响。</b></div>
      <div class="save-note" style="margin-top:12px">💡 <b>所有改动自动保存</b>，无需点“保存”。</div>
    </div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });

  syncSeg(p.body.querySelector('#st-fs'), S.fontSize || 'std');
  syncSeg(p.body.querySelector('#st-dcat'), S.defaultCat || WUYU[0]);
  syncSeg(p.body.querySelector('#st-after'), S.afterSave || 'keep');
  syncSeg(p.body.querySelector('#st-tlmode'), S.tlMode || 'card');
  syncSeg(p.body.querySelector('#st-tlpage'), String(S.tlPage || 20));
  syncSeg(p.body.querySelector('#st-remind'), S.remind || 'weekly');
  syncSeg(p.body.querySelector('#st-keep'), String(S.recycleDays || 30));
  syncSeg(p.body.querySelector('#st-weeksplit'), S.classWeekSplit || 'off');
  syncSeg(p.body.querySelector('#st-pguard'), S.photoGuard === 'off' ? 'off' : 'on');
  syncSeg(p.body.querySelector('#st-aidate'), S.aiDateGrain === 'full' ? 'full' : 'month');

  // 🔴 「备份提醒」右侧的说明此前只有一个永远显示「—」的空占位：同一排的「字号」「存储占用」
  //    都有更新代码，唯独它没有 ⇒ 老师看不到「该不该备份了」。数据源与页脚备份横幅同一处（lastExport）。
  const bkHint = p.body.querySelector('#st-bk-hint');
  if (bkHint) {
    const d = S.lastExport ? Math.floor((Date.now() - S.lastExport) / 86400000) : null;
    bkHint.textContent = d == null ? '还没有导出过备份' : (d === 0 ? '今天备份过' : `距上次备份 ${d} 天`);
  }

  const fsHint = { std: '标准 · 正文 15px', big: '大 · 正文 17px', huge: '超大 · 正文 19px' };
  p.body.querySelector('#st-fs-hint').textContent = fsHint[S.fontSize || 'std'];
  onSeg(p.body.querySelector('#st-fs'), v => {
    saveSetting('fontSize', v);
    p.body.querySelector('#st-fs-hint').textContent = fsHint[v];
  });
  onSeg(p.body.querySelector('#st-dcat'), v => { saveSetting('defaultCat', v); });
  onSeg(p.body.querySelector('#st-after'), v => { saveSetting('afterSave', v); });
  onSeg(p.body.querySelector('#st-tlmode'), v => { saveSetting('tlMode', v); });
  onSeg(p.body.querySelector('#st-tlpage'), v => { saveSetting('tlPage', +v); });
  onSeg(p.body.querySelector('#st-remind'), v => { saveSetting('remind', v); });
  onSeg(p.body.querySelector('#st-keep'), v => { saveSetting('recycleDays', +v); });
  onSeg(p.body.querySelector('#st-weeksplit'), v => { saveSetting('classWeekSplit', v); });
  onSeg(p.body.querySelector('#st-pguard'), v => { saveSetting('photoGuard', v); });
  onSeg(p.body.querySelector('#st-aidate'), v => { saveSetting('aiDateGrain', v); });
  const sPhotoRule = p.body.querySelector('#st-photorule');
  if (sPhotoRule) sPhotoRule.onclick = () => showPhotoRule();
  // 🔴 教师姓名 ⇄ 头像 ⇄ 设备名 联动：改名即时预览头像；设备名始终自动派生（不开放手填）
  const tname = p.body.querySelector('#st-tname');
  const ava = p.body.querySelector('#st-ava');
  const syncName = () => {
    const v = tname.value.trim();
    ava.textContent = v ? v.slice(0, 1) : '＋';
    p.body.querySelector('#st-dev-now').textContent = effectiveDeviceName(sched);
  };
  tname.oninput = syncName;                       // 输入即预览（不写库）
  tname.onchange = async () => {
    await saveSetting('teacherName', tname.value.trim());
    syncName(); refresh();                        // 顶栏头像 / 设备名同步刷新
  };
  // 🔴 存储持久化（§4.8.18）：Chromium 的 persist() **不弹任何授权框**，只按浏览器自己的规则直接返回结果
  //    （已装到主屏 / 已收藏 / 允许通知 / 长期常访问 才可能给）。所以这里只做两件事：
  //    ① 在点击手势里申请一次；② 拿不到就给出可执行做法。否则按钮点起来像坏的
  //    ——旧版正是如此：Safari（iOS）根本没有该接口，点了彻底空转。
  const persistLabel = ok => (ok ? '已授权' : '未授权');
  const persistNote = ok => ok
    ? '已获长期保存授权，浏览器清理时不会回收本应用数据。'
    : (persistSupported()
      ? '未授权：存储紧张时浏览器可能回收本应用数据，点上方按钮申请。'
      : '本机不支持「长期保存」。装到主屏后系统会按独立应用保存。');
  const refreshPersistUI = () => {
    const ok = !!state.settings.persisted;
    const pill = p.body.querySelector('#st-persist');
    const btn = p.body.querySelector('#st-req');
    const note = p.body.querySelector('#st-persist-note');
    if (pill) { pill.className = 'pill ' + (ok ? 'yes' : 'no'); pill.textContent = persistLabel(ok); }
    if (btn) { btn.style.display = ok ? 'none' : ''; btn.textContent = persistSupported() ? '申请持久化权限' : '如何让数据更安全'; }
    if (note) note.textContent = persistNote(ok);
  };
  // 拿不到授权时给出「怎么做才可能拿到」：浏览器不会弹框、只会按规则判定，所以必须给可执行动作
  const openPersistHelp = () => {
    const sh = showSheet({
      title: '让数据更不容易被清理',
      body: `<div style="padding:16px;line-height:1.85">
        <div class="sec" style="margin-top:0">📲 装到主屏（最有效）</div>
        <div class="li"><div style="flex:1;min-width:0"><div class="nm">安卓（Chrome / Edge）</div><div class="meta">点浏览器右上角菜单 → 「安装应用」或「添加到主屏幕」</div></div></div>
        <div class="li"><div style="flex:1;min-width:0"><div class="nm">iPhone / iPad（Safari）</div><div class="meta">点底部「分享」 → 「添加到主屏幕」</div></div></div>
        <div class="save-note" style="border:none;padding-top:8px">装到主屏后浏览器按独立应用对待，数据一般不再被当临时缓存回收。</div>
        <div class="sec">🛡️ 没有授权也不影响恢复</div>
        <div class="save-note" style="border:none;padding-top:6px">定期导出的备份文件就是唯一的保险。<b>换手机、清缓存前先导出备份。</b></div>
      </div>`,
      foot: `${canInstall() ? '<button class="btn ghost" id="ph-install">📲 添加到主屏</button>' : ''}<button class="btn" data-close>知道了</button>`
    });
    const bi = sh.foot && sh.foot.querySelector('#ph-install');
    if (bi) bi.onclick = async () => {
      const done = await promptInstall();
      if (done) { await requestPersist(); refreshPersistUI(); toast('已添加到主屏'); }
      else toast('已取消');
      sh.close();
    };
  };
  p.body.querySelector('#st-req').onclick = async () => {
    if (!persistSupported()) { openPersistHelp(); return; }   // 本机没有这个接口 → 直接给办法，不做无效等待
    toast('正在申请…');
    const ok = await requestPersist();
    refreshPersistUI();
    if (ok) toast('已获得持久化权限'); else openPersistHelp();
  };
  refreshPersistUI();
  // 🔴 手机端「硬刷新」等价入口（§4.3）：清缓存 + 让等待中的新 SW 立即接管 / 无新版本则注销旧 SW，
  // 最后 reload。只动 Cache Storage 与 SW 注册，绝不碰 IndexedDB（业务数据）。
  // 注意：旧实现发的是裸字符串 'skip'，而 sw.js 只认对象型 SKIP_WAITING 消息 → 指令空转，已修正。
  p.body.querySelector('#st-clear').onclick = async () => {
    flushDraft();                                  // 🔴 刷新会 reload，先确保正在写的内容落 localStorage
    toast('正在刷新到最新版…');
    try {
      if ('caches' in window) { const ks = await caches.keys(); for (const k of ks) await caches.delete(k); }
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) {
        await reg.update().catch(() => {});
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });   // 有新版本在等 → 立刻接管
        else await reg.unregister().catch(() => {});                          // 无等待新版本 → 注销旧 SW，重载即走网络
      }
    } catch (_) {}
    setTimeout(() => { try { window.location.reload(); } catch (_) {} }, 600);
  };
  // 🔴 占用明细与回收站计数都是异步读取：此前这整段写在 .then 里且没有 catch ——
  //    任何一步抛错都会让「清理多余图片」**永远绑不上事件**（点了没反应），而这不是老师能自救的状态。
  //    现在：读取失败只是数字留空，按钮始终可用。
  (async () => {
    let orphans = [];
    try {
      const s = await storageBreakdown();
      p.body.querySelector('#st-sto-hint').textContent = `约 ${fmtMB(s.total)}`;
      const t = Math.max(0.01, s.total);
      const bar = p.body.querySelector('#st-bar');
      bar.children[0].style.width = (s.rec / t * 100) + '%';
      bar.children[1].style.width = (s.img / t * 100) + '%';
      bar.children[2].style.width = (s.oth / t * 100) + '%';
      p.body.querySelector('#st-sto-rec').textContent = fmtMB(s.rec);
      p.body.querySelector('#st-sto-img').textContent = fmtMB(s.img);
      p.body.querySelector('#st-sto-oth').textContent = fmtMB(s.oth);
      const del = await listDeleted(state.db);
      p.body.querySelector('#st-trash-cnt').textContent = del.length + ' 条';
      orphans = await orphanImages(state.db);
      p.body.querySelector('#st-orphan').textContent = orphans.length + ' 张';
    } catch (_) { /* 读不到明细不影响其它设置项 */ }
    const cleanBtn = p.body.querySelector('#st-clean');
    if (cleanBtn) cleanBtn.onclick = async () => {
      if (!orphans.length) { toast('没有多余图片'); return; }
      for (const o of orphans) await deleteImage(state.db, o.imageId);
      toast(`已清理 ${orphans.length} 张多余图片`); p.close();
    };
  })();
}
