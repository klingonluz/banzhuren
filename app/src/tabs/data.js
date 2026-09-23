// 数据 Tab：管理端（名单 / 标签库 / 分类）/ 学期管理 / 备份与恢复 / 成长记录文本（实名导出）/ 归档档案柜 / 回收站 / 设置
// V11.1：分类与标签全部可编辑；导入逐条校验；图片在学期库；collections 为临时态不进备份
// V11.11：成长记录文本（实名）从「分析」页迁到这里，与备份并列 —— 备份可导入恢复，文本只给人看
import {
  state, saveSetting, setSemester, refresh, teacherInitial, effectiveDeviceName,
  persistSupported, requestPersist, canInstall, promptInstall
} from '../state.js';
import {
  listStudents, bulkPutStudents, listCategories, bulkPutCategories, addCategory, updateCategory, deleteCategory,
  listTags, bulkPutTags, addTag, updateTag, deleteTag, listTemplates, bulkPutTemplates,
  listCollections, putCollection, deleteCollection,
  getSchedule, bulkPutRecords, listDeleted, restoreRecord, deleteSemester, openSemester, ensureOpen, countActiveRecords,
  putImage, listImages, deleteImage, dataURLToBlob, orphanImages
} from '../db/semester.js';
import { nameInitials } from '../pinyin.js';
import { PHOTO_BAN, PHOTO_OK } from '../privacy.js';
import { openExport } from '../export.js';
import {
  getSetting, setSetting, listSemesters, putSemester, ensureSemester, meta
} from '../db/meta.js';
import { listSnaps, deleteSnap } from '../db/rescue.js';
import { buildArchiveHTML, archiveFileName, fmtBytes } from '../archive.js';
import { seedBaseline, WUYU, GUANZHU, CATEGORIES_SEED, TAGS_SEED } from '../db/seed.js';
import { el, esc, toast, openPicker, closePickers, emptyState, bindEmpty, confirm, syncSeg, onSeg, banner, closeBanner, showSheet } from '../ui.js';

const SCHEMA_VERSION = 6;                 // 当前 schema 版本（V11.1）
const APP_VER = 'v1.5.0';                 // 🔴 产品版本号（对外）：语义化递增，与 main.js 的 APP_VER 保持一致
const PLAN_VER = 'V11.13';                // 🔴 方案版本号（内部，仅设置页可见）：与 dev/docs 里配对的方案文件同步，改功能才顺延
const pad = n => String(n).padStart(2, '0');

function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}
// 🔴 存储口径三处统一：一个函数、不写死（§4.8.18 ①-4）
async function storageBreakdown() {
  const db = state.db;
  const recN = await countActiveRecords(db);
  const imgs = await listImages(db);
  const rec = +(recN * 0.03).toFixed(2);
  const img = +(imgs.length * 0.4).toFixed(2);
  const oth = 1.2;
  const total = +(rec + img + oth).toFixed(2);
  return { recN, imgN: imgs.length, rec, img, oth, total };
}
function fmtMB(n) { return n >= 1 ? n.toFixed(1) + 'MB' : Math.round(n * 1024) + 'KB'; }

/* ---------- 备份导出（全量含图，单文件；collections 不进备份） ---------- */
export async function buildExportPack() {
  const db = state.db;
  const students = await db.students.toArray();
  const records = await db.growth_records.toArray();      // 🔴 含软删记录（回收站一并备份）
  const categories = await db.categories.toArray();
  const tags = await db.tags.toArray();
  const templates = await db.templates.toArray();
  const schedule = await getSchedule(db);
  const imgs = await listImages(db);                       // 🔴 图片在学期库
  const images = [];
  for (const im of imgs) {
    let data = '';
    try { if (im.blob && typeof im.blob.arrayBuffer === 'function') data = await blobToDataURL(im.blob); }
    catch (e) { console.warn('图片导出失败，已跳过', im.imageId, e); }
    images.push({ imageId: im.imageId, data });
  }
  return {
    app: '班主任工作台', schemaVersion: SCHEMA_VERSION, exportedAt: Date.now(),
    device: effectiveDeviceName(schedule),  // 🔴 始终由「本班班级 + 教师姓名」派生（设置页只读展示，不开放手填）
    semesterId: state.currentSemesterId, semester: state.semester,
    students, categories, tags, templates, records, schedule, images
  };
}

/* ---------- 一键备份：顶部横幅「立即备份」与数据页「导出备份」走同一条路径 ---------- */
// 🔴 规格要求横幅上的「立即备份」**直接调导出**（不是跳到数据页让老师再点一次）
// 闭环：导出成功 → 写 lastExport → 当天横幅消失；归档后 lastExport=null，提醒重新计时
export async function quickBackup() {
  const pack = await buildExportPack();
  download(`班主任工作台_${state.semester?.name || '学期'}_备份.json`, JSON.stringify(pack));
  const now = Date.now();
  await meta.settings.put({ key: 'lastExport', value: now });
  state.settings.lastExport = now;
  closeBanner('backupBanner');
  return pack;
}

/* ---------- 抢救数据卡片（只列"打开失败"时尽力捞出的内容） ---------- */
// 🔴 v1.5.0：原「自动备份 / 全量快照」（每次打开把整库含图写进 bzr_rescue）已删除 ——
//    它挡不住换设备 / 换网址（最常见的两种丢失），却每次打开都要读全表、把每张图 base64 转一遍，
//    图片还会在本机存两份。「编辑被打断的恢复」由记录页草稿机制（localStorage，输入即存）承担，
//    比"6 小时才拍一次"的快照及时得多。bzr_rescue 只保留一个用途：打开失败时把还能读出的内容 dump 出来。
async function rescueCard() {
  const rescues = await listSnaps('rescue').catch(() => []);
  if (!rescues.length) return '';
  return `<div class="card">
    <h2>⚠️ 抢救数据 <span class="muted" style="font-weight:400;font-size:12px">${rescues.length} 份</span></h2>
    <div class="save-note" style="border:none;padding-top:0">这些是本应用某次<b>打开失败</b>时，尽力从本机库里捞出来的内容。可下载留存，或走导入流程合并回学期。</div>
    <button class="btn ghost mt danger" id="dt-rescue-view">查看 / 下载抢救数据（${rescues.length} 份）</button>
  </div>`;
}

// 列出快照并支持 下载 / 恢复（走与文件导入相同的逐条裁决）/ 删除
export function openSnapList(title, snaps, badge) {
  const p = openPicker({
    title,
    lead: '以下快照存在本机。恢复时和导入备份一样逐条对比，不会直接覆盖你的现有数据。',
    body: `<div style="padding:12px 14px" id="sn-box">${snaps.length ? snaps.map(s => `
      <div class="li" data-key="${esc(s.key)}">
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(s.semesterName || s.device || s.dbName || '—')} <span class="pill ${badge}">${s.type === 'auto' ? '自动' : '抢救'}</span></div>
          <div class="meta">${new Date(s.exportedAt).toLocaleString('zh-CN')} · ${esc(s.device || '—')}</div>
        </div>
        <button class="mini" data-dl="${esc(s.key)}">下载</button>
        <button class="mini" data-im="${esc(s.key)}">恢复</button>
        <button class="mini danger" data-del="${esc(s.key)}">删</button>
      </div>`).join('') : '<div class="empty">没有快照</div>'}</div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });
  p.body.querySelector('#sn-box').onclick = async e => {
    const row = e.target.closest('[data-key]'); if (!row) return;
    const s = snaps.find(x => x.key === row.dataset.key); if (!s) return;
    if (e.target.closest('[data-dl]')) {
      const fn = `班主任工作台_${s.semesterName || '学期'}_${s.type === 'auto' ? '自动' : '抢救'}_${new Date(s.exportedAt).toISOString().slice(0, 10)}.json`;
      download(fn, JSON.stringify(s.type === 'auto' ? s.pack : buildRescuePack(s)));
      toast('已下载快照文件'); return;
    }
    if (e.target.closest('[data-del]')) {
      await deleteSnap(s.key); toast('已删除该快照'); p.close(); openSnapList(title, (await listSnaps(s.type).catch(() => [])), badge); return;
    }
    if (e.target.closest('[data-im]')) {
      const pack = s.type === 'auto' ? s.pack : buildRescuePack(s);
      p.close();
      if (pack && pack.app === '班主任工作台' && Array.isArray(pack.records)) openImportPack(pack);
      else banner('errBanner', '⚠️ 该抢救快照结构不完整，无法恢复（可改用"下载"另存）。');
    }
  };
}
// 抢救快照（原生 dump）转成可导入的 pack：能转的表尽量转，缺字段处标注
function buildRescuePack(s) {
  const stores = s.stores || {};
  const students = stores.students || [];
  const records = stores.growth_records || [];
  return {
    app: '班主任工作台', schemaVersion: SCHEMA_VERSION, exportedAt: s.exportedAt,
    device: s.device || s.dbName || '抢救', semesterId: state.currentSemesterId, semester: state.semester,
    students, categories: stores.categories || [], tags: stores.tags || [],
    templates: stores.templates || [], records, schedule: (stores.schedule || [])[0] || null,
    images: (stores.images || []).map(im => ({ imageId: im.imageId, data: '' }))
  };
}

/* ---------- 启动钩子 ---------- */
// 🔴 v1.5.0：原 autoBackupMaybe（每次打开把整库含图快照写进 bzr_rescue）已删除，理由见 rescueCard 上方注释。

// 🔴 启动清理：只剩「回收站过期」一项。
//    v1.5.0 起「归档宽限到期自动删库」已删除 —— 那是全应用唯一的自动删库路径；
//    此后任何删库都由用户显式触发（彻底删除 / 清空名单 / 清除本机副本）。
export async function housekeeping() {
  // 回收站过期清理（下次启动时，不在老师翻记录时突然删）
  try {
    const days = +(state.settings.recycleDays || 30);
    const cut = Date.now() - days * 86400000;
    const del = await listDeleted(state.db);
    for (const r of del) if (r.del && r.del < cut) await state.db.growth_records.delete(r.id);
  } catch {}
}

/* ================= 挂载 ================= */
export async function mount(scrollEl) {
  const render = () => mount(scrollEl);   // 备份 / 操作后置刷新
  const db = state.db;
  const students = await listStudents(db);
  const tags = await listTags(db);
  const cats = await listCategories(db);
  const deleted = await listDeleted(db);
  const sto = await storageBreakdown();
  const sems = await listSemesters();
  // 🔴 档案柜只列「已归档」与「已清除」—— 归档学期不参与工作流，只在这里可见
  const archived = sems.filter(s => s.status === 'archived' || s.status === 'cleared');

  scrollEl.innerHTML = `
    ${manageCard(students.length, cats.length, tags.length)}
    ${semesterCard(sto)}
    ${backupCard()}
    ${textCard()}
    ${await rescueCard()}
    ${cabinetCard(archived)}
    ${trashCard(deleted.length, students)}
    <div class="card">
      <h2>🩺 诊断 / 兜底</h2>
      <div class="save-note" style="border:none;padding-top:0">同时打开多个标签页编辑时，<b>后保存的会覆盖先保存的</b> —— 请一次只开一个页面记记录。</div>
      <button class="btn ghost mt" id="dt-settings">⚙️ 打开设置</button>
      <div class="save-note">任何失败路径都<b>保留输入</b>并明确告知原因；无痕模式 / 存储被禁用时显示兜底页，绝不白屏。</div>
    </div>`;

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
  const rescueBtn = scrollEl.querySelector('#dt-rescue-view');
  if (rescueBtn) rescueBtn.onclick = async () => {
    const ss = await listSnaps('rescue').catch(() => []);
    openSnapList('抢救数据', ss, 'no');
  };
  scrollEl.querySelector('#dt-text').onclick = () => openExport();
  scrollEl.querySelector('#dt-import').onclick = () => openImport();
  scrollEl.querySelector('#dt-trash').onclick = () => openTrash();
  scrollEl.querySelector('#dt-settings').onclick = () => openSettings();
  scrollEl.querySelectorAll('[data-clear-copy]').forEach(b => b.onclick = () => {
    const s = archived.find(x => x.id === b.dataset.clearCopy);
    if (s) clearSemesterCopy(s, render);
  });
  bindEmpty(scrollEl, () => {});
}

/* ---------- 卡片 ---------- */
function manageCard(stuN, catN, tagN) {
  return `<div class="card">
    <h2>👥 名单与标签 <span class="muted" style="font-weight:400;font-size:12px">管理端</span></h2>
    <div class="stat-grid">
      <div class="stat"><b>${stuN}</b><span>在册学生</span></div>
      <div class="stat"><b>${tagN}</b><span>标签总数</span></div>
      <div class="stat"><b>${catN}</b><span>分类数</span></div>
    </div>
    <button class="btn ghost mt" id="dt-manage">管理名单 / 分类 / 标签库</button>
    <div class="save-note">数据从这里进来：批量粘贴（每行一个）/ 手加 / 导入。<b>转出</b>表示学生已离开本班：他不再出现在「选学生 / 收缴点名 / 未记录待办」里，成长记录<b>全部保留</b>作纪念，在这里可随时转回。拼音首字母自动生成，不对就点它手工修正。分类与标签均可增删改名。</div>
  </div>`;
}
function semesterCard(sto) {
  return `<div class="card">
    <h2>📚 学期管理</h2>
    <div class="kv" style="border:none;padding:2px 0"><span>当前学期</span><b>${esc(state.semester?.name || '—')}</b></div>
    <div class="kv"><span>记录 / 图片 / 占用</span><b>${sto.recN} 条 · ${sto.imgN} 张 · ${fmtMB(sto.total)}</b></div>
    <button class="btn ghost mt" id="dt-sem">切换 / 管理学期</button>
    <button class="btn danger mt" id="dt-archive">归档本学期（生成归档文件）</button>
    <div class="save-note">一学期一库；新建默认继承在册名单 + 分类 + 标签库 + 模板，<b>不继承</b>记录 / 图片 / 课表 / 收缴。<b>归档只生成文件、不动本机数据</b>；要省空间，归档后再到档案柜点「清除本机副本」。</div>
  </div>`;
}
function backupCard() {
  return `<div class="card">
    <h2>💾 备份与恢复</h2>
    <button class="btn" id="dt-backup">导出备份（全量含图）</button>
    <button class="btn ghost mt" id="dt-import">导入备份（逐条裁决）</button>
    <div class="save-note" id="dt-last"></div>
    <div class="save-note">这是<b>数据备份</b>（JSON，含图片，可原样导入恢复），不是给家长看的成长记录文本 —— 后者在下面「📄 成长记录文本」。</div>
    <div class="save-note">🛡️ <b>万一哪天打不开</b>：先别清数据。打开<a href="./recover.html">数据导出页</a> —— 它不依赖应用代码，能把本机内容直接存成文件（含图片），存好之后再考虑是否重建。</div>
    <div class="save-note danger"><b>换网址 = 数据全丢</b>：本机所有数据存在浏览器里、绑定当前网址（域名+协议+端口）。一旦更换网址（换域名 / http 改 https / 改端口 / 重新发布拿到新地址），旧网址下的全部历史数据将无法读取、彻底消失。本机自动快照与抢救库也在同一网址下，<b>同样救不回</b>。因此「导出备份」是<b>唯一能跨网址带走数据</b>的方式——<b>每次部署新网址前，务必先在此导出一份 JSON 存好，再到新网址导入</b>。</div>
  </div>`;
}
function textCard() {
  return `<div class="card">
    <h2>📄 成长记录文本 <span class="muted" style="font-weight:400;font-size:12px">（实名 · 留本机）</span></h2>
    <button class="btn" id="dt-text">生成成长记录文本</button>
    <div class="save-note">给人看的文字材料：一份<b>实名</b>的成长记录，可打印、给家长、存档；<b>不含照片本身</b>、不含成绩。和上面的备份是两回事 —— 备份是机器可读、可导入恢复的 JSON，这份是纯文本，只读不回填。要发给 AI 请用「分析 → AI 评语素材」。</div>
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
          <div class="fn">${s.status === 'cleared' ? '本机数据已清除（归档文件应已存在你的电脑 / 网盘上）' : `本机副本：保留中${size ? ' · ' + size : ''}`}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${s.status === 'archived' ? `<button class="mini danger" data-clear-copy="${esc(s.id)}">清除本机副本</button>` : ''}
        </div>
      </div>`;
    }).join('') : emptyState('还没有归档学期', '')}</div>
    <div class="save-note">归档会生成两份文件：<b>.json</b> 是可导入恢复的备份，<b>.html</b> 是双击就能只读查看的报告（含图）。两份都请存到电脑或网盘 —— 那是唯一能跨设备带走数据的方式。</div>
  </div>`;
}
function trashCard(n) {
  return `<div class="card">
    <h2>🗑️ 回收站 <span class="muted" style="font-weight:400;font-size:12px">${n} 条 · 保留 ${state.settings.recycleDays || 30} 天</span></h2>
    <button class="btn ghost" id="dt-trash">查看 / 恢复 / 清空</button>
    <div class="save-note">回收站里的记录图片会保留（恢复时还要用）；彻底删除或清空后，多余图片才会被清理。</div>
  </div>`;
}

/* ---------- 管理端：名单 + 分类 + 标签库 ---------- */
function openManage() {
  let tab = 'stu';
  const p = openPicker({
    title: '管理名单 / 分类 / 标签库',
    body: `<div style="padding:12px 14px">
      <div class="seg" id="mg-tab">
        <button data-v="stu" class="on">学生名单</button><button data-v="cat">分类</button><button data-v="tag">标签库</button>
      </div>
      <div id="mg-box" style="margin-top:12px"></div>
    </div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });
  const draw = async () => {
    const box = p.body.querySelector('#mg-box');
    if (tab === 'stu') await drawStudents(box);
    else if (tab === 'cat') await drawCats(box);
    else await drawTags(box);
  };
  onSeg(p.body.querySelector('#mg-tab'), v => { tab = v; draw(); });
  draw();
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
    <input class="search" id="mg-q" placeholder="搜索 姓名 / 拼音首字母" style="border:1px solid var(--line);border-radius:8px;margin:10px 0">
    <div id="mg-list"></div>`;
  const list = box.querySelector('#mg-list');
  const drawList = q => {
    q = (q || '').trim().toLowerCase();
    const hit = students.filter(s => !q || s.name.includes(q) || (s.pinyin || '').toLowerCase().includes(q));
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
    const name = prompt('学生姓名（2~4 字）');
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
        const recs = await db.growth_records.toArray();
        for (const r of recs) for (const id of (r.imageIds || [])) { try { await deleteImage(db, id); } catch {} }
        await db.growth_records.clear(); await db.students.clear();
        toast('已清空，可粘贴 / 手加真实名单'); drawStudents(box);
      } catch (e) { toast('清空失败：' + e.message); }
    }
  });
  list.onclick = async e => {
    const py = e.target.closest('[data-py]');
    if (py) {
      const s = students.find(x => x.id === py.dataset.py);
      const nv = prompt(`「${s.name}」的拼音首字母（只用于搜索与分组）`, s.pinyin || '');
      if (nv === null) return;
      s.pinyin = nv.trim().toUpperCase().replace(/[^A-Z]/g, '');
      s.pyManual = 1;                                  // 🔴 手工改过 → 以后不再被自动重算覆盖
      await bulkPutStudents(db, [s]);
      toast('已更新拼音首字母'); drawStudents(box);
      return;
    }
    const rn = e.target.closest('[data-rename]');
    if (rn) {
      const s = students.find(x => x.id === rn.dataset.rename);
      const nv = prompt('改为', s.name);
      if (nv && nv.trim()) { s.name = nv.trim(); if (!s.pyManual) s.pinyin = nameInitials(s.name); await bulkPutStudents(db, [s]); toast('已更新'); drawStudents(box); }
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

/* ---------- 分类管理（全部可编辑；关注不可删，可改名） ---------- */
async function drawCats(box) {
  const db = state.db;
  let cats = await listCategories(db);
  if (!cats.length) { cats = CATEGORIES_SEED.map(c => ({ ...c })); await bulkPutCategories(db, cats); }
  cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  const tagCount = {};
  (await listTags(db)).forEach(t => { tagCount[t.category] = (tagCount[t.category] || 0) + 1; });
  box.innerHTML = `
    <div class="row" style="gap:8px;margin-bottom:8px">
      <input class="ta" id="cat-name" placeholder="新分类名" style="flex:1">
      <select class="ta" id="cat-kind" style="width:96px">
        <option value="ability">正向能力</option><option value="internal">关注（内部观察）</option>
      </select>
      <button class="btn tiny" id="cat-add">新建</button>
    </div>
    <div id="cat-list">${cats.map(c => `
      <div class="li" data-id="${esc(c.id)}">
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(c.cat)} ${c.kind === 'internal' ? '<span class="pill no">关注</span>' : ''}</div>
          <div class="meta">${tagCount[c.cat] || 0} 个标签</div>
        </div>
        <button class="mini" data-rename="${esc(c.id)}">改名</button>
        ${c.id === 'cat_gz' ? '<span class="muted" style="font-size:11px">受保护</span>' : `<button class="mini danger" data-delcat="${esc(c.id)}" data-cfm="0">删除</button>`}
      </div>`).join('')}</div>
    <div class="save-note">「关注」是内部观察分类，<b>不可删除</b>（改名可以）；其它分类可自由增删。删除分类会一并移除其下标签。</div>`;

  box.querySelector('#cat-add').onclick = async () => {
    const name = box.querySelector('#cat-name').value.trim();
    const kind = box.querySelector('#cat-kind').value;
    if (!name) { toast('请填写分类名'); return; }
    if (cats.some(c => c.cat === name)) { toast('已有同名分类'); return; }
    const id = 'cat_' + Date.now().toString(36);
    await addCategory(db, { id, cat: name, kind, order: cats.length, updatedAt: Date.now(), del: 0 });
    toast('已新建分类'); drawCats(box);
  };
  box.querySelector('#cat-list').onclick = async e => {
    const rn = e.target.closest('[data-rename]');
    if (rn) {
      const c = cats.find(x => x.id === rn.dataset.rename);
      const nv = prompt('改为', c.cat);
      if (nv && nv.trim()) { await updateCategory(db, c.id, { cat: nv.trim(), updatedAt: Date.now() }); toast('已更新'); drawCats(box); }
      return;
    }
    const dl = e.target.closest('[data-delcat]');
    if (dl) {
      if (dl.dataset.cfm !== '1') { dl.dataset.cfm = '1'; dl.textContent = '确认删除?'; return; }
      const c = cats.find(x => x.id === dl.dataset.delcat);
      confirm({ title: '删除分类', msg: `将一并删除「${c.cat}」下所有标签（历史记录仍按名称保留）。`, danger: true, onOk: async () => {
        await db.categories.update(c.id, { del: Date.now() });
        const own = (await listTags(db)).filter(t => t.category === c.cat);
        for (const t of own) await db.tags.update(t.id, { del: Date.now() });
        toast('已删除分类及标签'); drawCats(box);
      }});
    }
  };
}

/* ---------- 标签库（可增删改名 / 星标；关注类标签同样可删） ---------- */
async function drawTags(box) {
  const db = state.db;
  let tags = await listTags(db);
  if (!tags.length) { tags = TAGS_SEED.map(t => ({ ...t })); await bulkPutTags(db, tags); }
  let cats = await listCategories(db);
  if (!cats.length) { cats = CATEGORIES_SEED.map(c => ({ ...c })); await bulkPutCategories(db, cats); }
  cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  const catOpts = cats.map(c => `<option value="${esc(c.cat)}">${esc(c.cat)}</option>`).join('');
  tags.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (b.useCount || 0) - (a.useCount || 0));
  box.innerHTML = `
    <div class="field"><label>分类</label>
      <select class="ta" id="tg-cat" style="margin-bottom:8px">${catOpts}</select>
      <div class="row" style="gap:8px">
        <input class="ta" id="tg-name" placeholder="新标签名" style="flex:1">
        <button class="btn tiny" id="tg-add">新建</button>
      </div>
    </div>
    <div id="tg-list">${tags.map(t => `
      <div class="li" data-id="${esc(t.id)}">
        <div style="flex:1;min-width:0">
          <div class="nm">${t.starred ? '★ ' : ''}${esc(t.name)}</div>
          <div class="meta">${esc(t.category)} · 使用 ${t.useCount || 0} 次</div>
          ${t.presetComment ? `<div class="cmt">预设评语：${esc(t.presetComment)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex:none">
          <button class="mini" data-editcmt="${esc(t.id)}">改评语</button>
          <button class="mini" data-star="${esc(t.id)}">${t.starred ? '取消星标' : '星标'}</button>
          <button class="mini danger" data-deltag="${esc(t.id)}" data-cfm="0">删除</button>
        </div>
      </div>`).join('')}</div>
    <div class="save-note">删除标签后<b>历史记录仍显示原标签名</b>。同分类下禁止同名。「改评语」编辑的是<b>选标签时自动填入的预设评语</b>（设置里开启才自动填），改完立即生效。</div>`;

  box.querySelector('#tg-add').onclick = async () => {
    const name = box.querySelector('#tg-name').value.trim();
    const cat = box.querySelector('#tg-cat').value;
    if (!name) { toast('请填写标签名'); return; }
    if (tags.some(t => t.name === name && t.category === cat)) { toast('同分类下已有同名标签'); return; }
    await addTag(db, { id: 'tg' + Date.now().toString(36), name, category: cat, presetComment: '', starred: 0, useCount: 0, updatedAt: Date.now(), del: 0 });
    toast('已新建'); drawTags(box);
  };
  box.querySelector('#tg-list').onclick = async e => {
    const ec = e.target.closest('[data-editcmt]');
    if (ec) { editPresetComment(tags.find(x => x.id === ec.dataset.editcmt)); return; }
    const st = e.target.closest('[data-star]');
    if (st) { const t = tags.find(x => x.id === st.dataset.star); await updateTag(db, t.id, { starred: t.starred ? 0 : 1, updatedAt: Date.now() }); drawTags(box); return; }
    const dl = e.target.closest('[data-deltag]');
    if (dl) {
      if (dl.dataset.cfm !== '1') { dl.dataset.cfm = '1'; dl.textContent = '确认删除?'; return; }
      await deleteTag(db, dl.dataset.deltag);
      toast('已删除'); drawTags(box);
    }
  };
}

/* ---------- 编辑标签预设评语（选标签时自动填入的内容，可在标签库改） ---------- */
function editPresetComment(t) {
  if (!t) return;
  const p = openPicker({
    title: '改预设评语',
    lead: `「${t.name}」被选中且开启“自动填预设评语”时，会填入下面这段。留空则自动填一小句通用评语。`,
    body: `<div style="padding:14px 16px">
      <textarea class="ta" id="cmt-ta" rows="4" placeholder="如：能独立完成布置的任务，值得肯定。">${esc(t.presetComment || '')}</textarea>
    </div>`,
    foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn" id="cmt-save">保存</button>`
  });
  p.foot.querySelector('#cmt-save').onclick = async () => {
    const v = p.body.querySelector('#cmt-ta').value.trim();
    await updateTag(state.db, t.id, { presetComment: v, updatedAt: Date.now() });
    toast('预设评语已更新'); p.close();
    // 重绘标签库列表（若仍在管理弹层内）
    const box = document.querySelector('#mg-box');
    if (box) drawTags(box);
  };
}

/* ---------- 学期管理 ---------- */
export function openSemesters() {
  const p = openPicker({
    title: '学期管理',
    lead: '一学期一库。新建默认继承在册名单 + 分类 + 标签库 + 模板；记录 / 图片 / 课表 / 收缴不继承。',
    body: '<div style="padding:12px 14px" id="sm-box"></div>',
    foot: `<button class="btn ghost" data-pclose>关闭</button><button class="btn" id="sm-new">＋ 新建学期</button>`
  });
  const draw = async () => {
    const sems = await listSemesters();
    p.body.querySelector('#sm-box').innerHTML = sems.map(s => `
      <div class="li" data-go="${esc(s.id)}">
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(s.name)}${s.id === state.currentSemesterId ? ' <span class="pill yes">当前</span>' : ''}${
            s.status === 'archived' ? ' <span class="pill">已归档</span>' : s.status === 'cleared' ? ' <span class="pill no">本机已清除</span>' : ''}</div>
          <div class="meta">${s.startAt ? new Date(s.startAt).toLocaleDateString('zh-CN') : '—'} · ${
            s.status === 'cleared' ? '本机数据已清除' : s.status === 'archived' ? '已归档，不在本应用内打开' : '在用'}</div>
        </div>
      </div>`).join('') || '<div class="empty">还没有学期</div>';
    p.body.querySelector('#sm-box').onclick = async e => {
      const row = e.target.closest('[data-go]'); if (!row) return;
      const sems2 = await listSemesters();
      const s = sems2.find(x => x.id === row.dataset.go);
      if (!s || s.id === state.currentSemesterId) { p.close(); return; }
      if (s.status === 'cleared') { toast('该学期本机数据已清除，只能看归档文件'); return; }
      if (s.status === 'archived') { toast('该学期已归档，不在本应用内打开'); return; }
      await switchSemester(s); p.close();
    };
  };
  draw();
  p.foot.querySelector('#sm-new').onclick = async () => {
    const name = prompt('新学期名称', '新学期');
    if (!name) return;
    const sems = await listSemesters();
    if (sems.some(s => s.name === name.trim())) { toast('已存在同名学期'); return; }
    const ns = { id: 'sem_' + Date.now().toString(36), name: name.trim(), startAt: Date.now(), status: 'active' };
    await ensureSemester(ns);
    const from = openSemester(state.currentSemesterId);
    try {
      const stu = (await from.students.toArray()).filter(s => !s.out).map(s => ({ ...s, id: 's' + Math.random().toString(36).slice(2, 9), pinyin: s.pyManual ? s.pinyin : nameInitials(s.name) }));
      const tg = await from.tags.toArray();
      const cats = await from.categories.toArray();
      const tpl = await from.templates.toArray();
      const to = openSemester(ns.id);
      await bulkPutStudents(to, stu);
      await bulkPutTags(to, tg.length ? tg : TAGS_SEED);
      await bulkPutCategories(to, cats.length ? cats : CATEGORIES_SEED);
      await bulkPutTemplates(to, tpl.length ? tpl : []);
    } catch {}
    sems.forEach(s => { if (s.status === 'active') putSemester({ ...s, status: 'inactive' }); });
    await switchSemester(ns); p.close();
  };
}

export async function switchSemester(s) {
  try {
    if (localStorage.getItem('bzr_draft_' + state.currentSemesterId)) {
      const ok = window.confirm('有未保存的草稿，切换学期会保留在当前学期。确定切换？');
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
  banner('archiveBanner',
    `📚 「${esc(sem?.name || '本学期')}」已归档。请把刚下载的两份文件（<b>.json</b> 备份 / <b>.html</b> 只读报告）存到电脑或网盘 —— 那是唯一能跨设备带走数据的方式。要省空间，可到「归档档案柜」点「清除本机副本」。`,
    'warn');
  // 归档只是盖章：本机数据照旧，只是要换个学期继续记录
  const sems = await listSemesters();
  const next = sems.find(s => s.status === 'active' && s.id !== state.currentSemesterId);
  if (next) await switchSemester(next);
  else {
    const ns = { id: 'sem_' + Date.now().toString(36), name: '新学期', startAt: Date.now(), status: 'active' };
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
    msg: `将删除本机「${s.name}」这个学期的全部数据（记录 / 图片 / 名单），以释放空间。\n\n`
      + `此操作不可恢复 —— 清除后本应用不再认识这个学期，也无法取消。\n\n`
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

/* ---------- 导入（校验 → 学期识别 → 差异 → 逐条裁决） ---------- */
function openImport() {
  const p = openPicker({
    title: '导入备份',
    lead: '绝不默认合并：逐条对比、三选一。文件损坏或非本应用备份会明确报错，不会崩溃。',
    body: `<div style="padding:14px 16px">
      <div class="drop" id="im-drop">点击选择备份文件（.json）<input type="file" id="im-file" accept="application/json" style="display:none"></div>
      <div class="err" id="im-err"></div>
      <div id="im-info"></div>
    </div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });
  const drop = p.body.querySelector('#im-drop');
  const input = p.body.querySelector('#im-file');
  drop.onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    let pack;
    try { pack = JSON.parse(await f.text()); }
    catch { p.body.querySelector('#im-err').textContent = '❌ 不是合法 JSON 备份文件'; return; }
    p.close();
    openImportPack(pack);
  };
}

// 🔴 文件导入 与 快照恢复 共用的入口：校验 → 学期识别 → 下一步走逐条对比
export async function openImportPack(pack) {
  const errs = [];
  if (pack.app !== '班主任工作台') errs.push('非本应用备份');
  if (!pack.schemaVersion) errs.push('缺 schemaVersion');
  if (pack.schemaVersion > SCHEMA_VERSION) errs.push(`文件版本 ${pack.schemaVersion} 高于本机 ${SCHEMA_VERSION}，无法导入`);
  if (!pack.semesterId) errs.push('缺 semesterId（无法判断归属学期）');
  if (!Array.isArray(pack.records)) errs.push('records 节点缺失');
  if (errs.length) { banner('errBanner', '⚠️ ' + errs.join('；')); return; }
  const p = openPicker({
    title: '导入备份',
    lead: '绝不默认合并：逐条对比、三选一。文件损坏或非本应用备份会明确报错，不会崩溃。',
    body: `<div style="padding:14px 16px">
      <div id="im-info"></div>
    </div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });
  const sems = await listSemesters();
  const mine = sems.find(s => s.id === pack.semesterId);
  // 🔴 学期识别两类（v1.5.0 简化）：
  //    A ＝ 就是当前学期 → 逐条裁决合并
  //    C ＝ 本机没有该学期数据（本机没这个学期，或已清除本机副本）→ 重建学期库并导入全部
  //    B ＝ 本机已有该学期且数据仍在（在用 / 已归档）→ **一律拒绝**
  //        （归档学期不在本应用内打开，也不该被导入拉回；见方案 §2.5）
  let kind = 'C';
  if (mine && mine.id === state.currentSemesterId) kind = 'A';
  else if (mine && mine.status !== 'cleared') kind = 'B';
  const reject = kind === 'B';
  p.body.querySelector('#im-info').innerHTML = `
    <div class="kv" style="border:none"><span>来源学期</span><b>${esc(pack.semester?.name || pack.semesterId)}</b></div>
    <div class="kv"><span>来源设备 / 时间</span><b>${esc(pack.device || '—')} · ${new Date(pack.exportedAt || Date.now()).toLocaleString('zh-CN')}</b></div>
    <div class="kv"><span>学期识别</span><b><span class="badge ${kind === 'A' ? 'a' : kind === 'B' ? 'b' : 'c'}">情形 ${kind}</span></b></div>
    <p class="muted" style="margin:8px 0">${kind === 'A' ? '与当前学期一致 → 走逐条对比合并，绝不默认覆盖'
      : reject ? '该学期已在本机且数据仍在（含已归档）→ 不能导入覆盖'
      : '本机没有该学期的数据 → 新建学期并导入全部'}</p>
    ${reject ? `<div class="save-note danger">该学期在本机已有数据，不能被导入覆盖。<b>已归档的学期不在本应用内打开</b> —— 要看它就打开归档的 .html 报告。若确需在这台设备上恢复它，请先到档案柜清除本机副本；清除后本机不再有该学期，这份备份即可导入。</div>`
      : `<button class="btn" id="im-go">下一步：查看差异</button>`}`;
  const goBtn = p.body.querySelector('#im-go');
  if (goBtn) goBtn.onclick = () => showDiff(pack, kind, p);
}

// 逐条校验：bad structure / unknown studentId 跳过；按 id 比对（内容兜底）
// 🔴 目标库：A 类写当前学期；C 类写包里那个学期（本机没有 → 现建）
async function showDiff(pack, kind, parent) {
  const isNew = kind === 'C';
  const db = isNew ? null : state.db;
  const local = db ? await db.growth_records.toArray() : [];
  const localMap = {}; local.forEach(r => localMap[r.id] = r);
  const fileMap = {}; pack.records.forEach(r => fileMap[r.id] = r);
  // 🔴 C 类本机没有名单 ⇒ 用包里带的学生做校验。换设备恢复的关键：学生必须先导进来，否则记录会被整批跳过
  const validStu = new Set(isNew
    ? (pack.students || []).map(s => s.id)
    : (await db.students.toArray()).map(s => s.id));
  const differs = (a, b) => a.text !== b.text || a.category !== b.category ||
    JSON.stringify(a.tags || []) !== JSON.stringify(b.tags || []) || a.date !== b.date;
  const added = [], changed = [], skipped = [], localOnly = [];
  for (const id in fileMap) {
    const r = fileMap[id];
    if (!r || typeof r !== 'object' || !r.studentId || !Array.isArray(r.tags)) { skipped.push(r); continue; }
    if (!validStu.has(r.studentId)) { skipped.push(r); continue; }   // 🔴 未知学生：跳过
    if (!localMap[id]) added.push(r);
    else if (differs(localMap[id], r)) changed.push(r);              // 内容不同即需裁决
  }
  for (const id in localMap) if (!fileMap[id]) localOnly.push(localMap[id]);

  const choices = {};
  added.forEach(r => choices[r.id] = 'imp');
  changed.forEach(r => choices[r.id] = 'imp');
  localOnly.forEach(r => choices[r.id] = 'loc');   // 🔴 本地独有默认一条不删

  const stuName = id => (pack.students || []).find(s => s.id === id)?.name || id;
  const cardHTML = (r) => {
    const loc = localMap[r.id];
    return `<div class="cf" data-id="${esc(r.id)}">
      <div class="who">${esc(stuName(r.studentId) || r.studentId)}<span class="muted" style="font-weight:400"> · ${esc(r.date)}</span></div>
      <div class="vs">
        <div class="loc"><div class="h">本地</div><div class="c">${esc(loc ? (loc.text || '（空）') : '（本地没有）')}</div></div>
        <div class="imp"><div class="h">导入${(r.imageIds || []).length ? ' 📷含图' : ''}</div><div class="c im">${esc(r.text || '（空）')}</div></div>
      </div>
      <div class="pick">
        <label data-c="loc" class="${choices[r.id] === 'loc' ? 'on' : ''}">保留本地</label>
        <label data-c="imp" class="${choices[r.id] === 'imp' ? 'on' : ''}">用导入</label>
        <label data-c="both" class="warn ${choices[r.id] === 'both' ? 'on' : ''}">都留</label>
      </div>
    </div>`;
  };

  const p = openPicker({
    title: '逐条对比（MergeAdjust）',
    lead: '三选一：保留本地 / 用导入 / 都留。默认不删本地独有记录（删除不可逆）。' + (skipped.length ? `<br><b style="color:var(--danger)">已跳过 ${skipped.length} 条（结构异常或学生不在本班）</b>` : ''),
    body: `<div style="padding:12px 14px">
      <div class="dsum">
        <div class="d g"><b>${added.length}</b><span>仅导入</span></div>
        <div class="d y"><b>${changed.length}</b><span>需裁决</span></div>
        <div class="d r"><b>${localOnly.length}</b><span>仅本地（保留）</span></div>
      </div>
      <div class="row" style="gap:8px;margin-bottom:8px">
        <button class="btn ghost tiny" id="df-all-loc">全部保留本地</button>
        <button class="btn ghost tiny" id="df-all-imp">全部用导入</button>
      </div>
      ${[...added, ...changed].map(r => cardHTML(r)).join('')
        || '<div class="empty">没有需要处理的差异</div>'}
    </div>`,
    foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn" id="df-apply">确认导入</button>`
  });

  p.body.querySelectorAll('.cf').forEach(cf => {
    cf.querySelector('.pick').onclick = e => {
      const l = e.target.closest('[data-c]'); if (!l) return;
      choices[cf.dataset.id] = l.dataset.c;
      cf.querySelectorAll('.pick label').forEach(x => x.classList.toggle('on', x === l));
    };
  });
  p.body.querySelector('#df-all-loc').onclick = () => { changed.forEach(r => choices[r.id] = 'loc'); p.body.querySelectorAll('.cf').forEach(cf => cf.querySelectorAll('.pick label').forEach(x => x.classList.toggle('on', x.dataset.c === 'loc'))); };
  p.body.querySelector('#df-all-imp').onclick = () => { changed.forEach(r => choices[r.id] = 'imp'); p.body.querySelectorAll('.cf').forEach(cf => cf.querySelectorAll('.pick label').forEach(x => x.classList.toggle('on', x.dataset.c === 'imp'))); };

  p.foot.querySelector('#df-apply').onclick = async () => {
    try {
      // 🔴 C 类：本机没有这个学期 → 按包里的 semesterId 建库、**先落学生**，再导其余内容
      //    （旧版这里用的是当前学期库、且从不写 pack.students ⇒ 换设备恢复永远导不进任何东西）
      let tdb = db;
      if (isNew) {
        await ensureSemester({
          id: pack.semesterId,
          name: (pack.semester && pack.semester.name) || '导入的学期',
          startAt: (pack.semester && pack.semester.startAt) || pack.exportedAt || Date.now(),
          status: 'inactive'                        // 本机存在但非当前：可用「切换 / 管理学期」切过去
        });
        tdb = openSemester(pack.semesterId);
        await ensureOpen(tdb, pack.semesterId);     // 建库 + 跑一次结构迁移
        await bulkPutStudents(tdb, pack.students || []);
        if (pack.schedule) await saveSchedSafe(tdb, pack.schedule);
      }
      await tdb.transaction('rw', tdb.growth_records, tdb.images, async () => {
        for (const r of [...added, ...changed]) {
          const c = choices[r.id] || 'imp';
          if (c === 'loc') continue;
          if (c === 'both') {
            await tdb.growth_records.put({ ...r, id: r.id + '_i', del: 0 });
          } else {
            await tdb.growth_records.put({ ...r, del: r.del || 0 });
          }
        }
      });
      // 图片（学期库）
      for (const im of (pack.images || [])) {
        try { await putImage(tdb, im.imageId, dataURLToBlob(im.data)); } catch {}
      }
      // 分类 / 标签 / 模板：按 id 增量合并（不覆盖本地已有）
      await mergeById(tdb.categories, pack.categories);
      await mergeById(tdb.tags, pack.tags);
      await mergeById(tdb.templates, pack.templates);
      if (!isNew && pack.schedule) await saveSchedSafe(tdb, pack.schedule);
      toast(`导入完成：${isNew ? '新建学期，' : ''}新增 ${added.length}，更新 ${changed.length}${skipped.length ? `，跳过 ${skipped.length}` : ''}`);
      p.close(); parent.close(); refresh();
    } catch (e) { toast('导入失败，已回滚：' + e.message); }
  };
}

async function mergeById(table, rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const exist = new Set((await table.toArray()).map(r => r.id));
  const fresh = rows.filter(r => !exist.has(r.id));
  if (fresh.length) await table.bulkPut(fresh);
}
async function saveSchedSafe(db, sched) {
  try { await db.schedule.put({ id: 'current', ...sched }); } catch {}
}

/* ---------- 回收站 ---------- */
function openTrash() {
  const p = openPicker({
    title: '回收站',
    lead: `软删除的记录保留 ${state.settings.recycleDays || 30} 天，期间可恢复；彻底删除后图片也会清理。`,
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
    lead: '照片一旦拍进来就留在本机，也可能被你不小心转发出去。',
    body: `<div style="padding:14px 16px">
      <div class="sec" style="margin-top:0">✅ 可以拍</div>
      <div class="save-note" style="border:none">${PHOTO_OK.map(x => '· ' + esc(x)).join('<br>')}</div>
      <div class="sec">❌ 不要拍</div>
      <div class="save-note" style="border:none">${PHOTO_BAN.map(x => '· ' + esc(x)).join('<br>')}</div>
      <div class="save-note">💡 <b>主体合规不等于照片合规</b>：作业拍得好，但背景里有座位表、或角落露出别人的姓名，同样不能外发。拍之前先看一眼取景框。</div>
      <div class="save-note">需要让 AI 了解画面内容时，用一句文字转述即可（如「手抄报排版工整、配色协调」），不必把照片发出去。</div>
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
        <div class="save-note" style="border:none;padding-top:6px">由「<b>本班班级 + 教师姓名</b>」自动生成：在上方改教师姓名、或在班务「授课班级」改本班名，这里会同步变化。这个名字写进导出的备份文件，方便区分是哪台手机备的。</div>
      </div>

      <div class="sec">👓 无障碍</div>
      <div class="set-item">
        <div class="si-lb"><span>字号</span><em id="st-fs-hint">标准 · 正文 15px</em></div>
        <div class="seg" id="st-fs"><button data-v="std">标准</button><button data-v="big">大</button><button data-v="huge">超大</button></div>
        <div class="save-note" style="border:none;padding-top:6px">改动<b>立即生效</b>，无需重启。小学老师年龄跨度大，属无障碍刚需。</div>
      </div>

      <div class="sec">⚡ 记录效率</div>
      <div class="set-item">
        <div class="si-lb"><span>极速记录默认分类</span><em>打开记录页先选中它</em></div>
        <div class="seg sm hscroll" id="st-dcat">${WUYU.map(w => `<button data-v="${esc(w)}">${esc(w)}</button>`).join('')}</div>
      </div>
      <div class="set-item">
        <div class="si-lb"><span>选标签自动填预设评语</span><em>默认关，避免重复臃肿</em></div>
        <div class="seg sm" id="st-auto"><button data-v="0" class="on">关</button><button data-v="1">开</button></div>
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
        <div class="save-note" style="border:none;padding-top:6px">开启后，本班课表维护<b>单周 / 双周</b>两套，今日课表按当前周次自动显示对应那套；周课表编辑时可切换。</div>
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
        <div class="si-lb"><span>存储占用明细</span><em id="st-sto-hint">—</em></div>
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
        <div class="save-note" style="border:none;padding-top:6px">照片入库时会自动去掉拍摄位置等元信息（EXIF）；但画面里本来就有的人脸、姓名、名单不会被自动识别，所以要你亲眼确认一次。</div>
      </div>
      <div class="set-item">
        <div class="si-lb"><span>AI 素材日期精度</span><em>外发给 AI 时日期保留到什么程度</em></div>
        <div class="seg sm" id="st-aidate"><button data-v="month">只到月</button><button data-v="full">保留完整</button></div>
        <div class="save-note" style="border:none;padding-top:6px">精确到某天 + 具体事件，容易定位到具体学生。默认只到月，够 AI 判断先后顺序。</div>
      </div>
      <div class="set-item">
        <div class="kv" style="border:none;padding:0 0 6px"><span>拍摄规范</span><b>只拍物、不拍人</b></div>
        <button class="mini" id="st-photorule" style="width:100%">查看可拍 / 不可拍清单</button>
      </div>
      <div class="set-item">
        <div class="kv" style="border:none;padding:0 0 6px"><span>会离开本设备的</span><b>只有你自己复制的 AI 素材</b></div>
        <div class="save-note" style="border:none">学生与记录只存在这台设备里，应用不联网、不上传。<b>AI 评语素材</b>是唯一的外发通道：姓名换成一次性代号，分数、名次、具体日期与他人姓名都会被隐去，照片一张都不参与。</div>
      </div>
      <div class="save-note">未满 14 周岁学生的信息属《个人信息保护法》第 28 条中的<b>敏感个人信息</b>，教师不能代替学生对外授权；是否外发、发给谁，请你按学校要求与自己的判断决定。</div>

      <div class="sec">📱 学期与存储</div>
      <div class="kv"><span>当前学期</span><b>${esc(state.semester?.name || '—')}</b></div>
      <div class="kv"><span>存储持久化</span><span class="pill ${S.persisted ? 'yes' : 'no'}" id="st-persist">${S.persisted ? '已授权' : '未授权'}</span></div>
      <button class="btn ghost mt" id="st-req">${persistSupported() ? '申请持久化权限' : '如何让数据更安全'}</button>
      <div class="save-note" id="st-persist-note" style="margin-top:8px">${S.persisted
        ? '已获长期保存授权：浏览器清理本地数据时不会连同本应用一起回收。'
        : (persistSupported()
          ? '未获授权时，浏览器在存储紧张时可能回收本应用的数据。点上方按钮可申请长期保存权限。'
          : '本机浏览器未提供「长期保存」开关。把本应用装到主屏后，系统会按独立应用长期保存。')}</div>

      <div class="sec">ℹ️ 关于</div>
      <div class="kv"><span>版本 / Build</span><b>${APP_VER}</b></div>
      <div class="kv"><span>方案版本</span><b>${PLAN_VER} · 正面管教版</b></div>
      <div class="kv"><span>隐私模式</span><b>本机离线 · 数据不出设备</b></div>
      <div class="kv"><span>Origin</span><b style="word-break:break-all">${esc(window.location?.origin || '—')}</b></div>
      <button class="btn ghost mt" id="st-clear">🔄 刷新到最新版（不触业务数据）</button>
      <div class="save-note" style="margin-top:8px">手机上不像电脑能按「强制刷新」。更新了应用却没看到新功能时，点上面这个按钮即可——它会清掉本地缓存、注销旧版离线脚本、再重新加载页面。<b>已保存的名单与记录不受影响。</b></div>
      <div class="save-note" style="margin-top:12px">💡 <b>所有改动自动保存</b>，无需单独点“保存”按钮——每次调整都会立即写入本机。</div>
    </div>`,
    foot: `<button class="btn" data-pclose>关闭</button>`
  });

  syncSeg(p.body.querySelector('#st-fs'), S.fontSize || 'std');
  syncSeg(p.body.querySelector('#st-dcat'), S.defaultCat || WUYU[0]);
  syncSeg(p.body.querySelector('#st-auto'), String(S.autoComment ? 1 : 0));
  syncSeg(p.body.querySelector('#st-after'), S.afterSave || 'keep');
  syncSeg(p.body.querySelector('#st-tlmode'), S.tlMode || 'card');
  syncSeg(p.body.querySelector('#st-tlpage'), String(S.tlPage || 20));
  syncSeg(p.body.querySelector('#st-remind'), S.remind || 'weekly');
  syncSeg(p.body.querySelector('#st-keep'), String(S.recycleDays || 30));
  syncSeg(p.body.querySelector('#st-weeksplit'), S.classWeekSplit || 'off');
  syncSeg(p.body.querySelector('#st-pguard'), S.photoGuard === 'off' ? 'off' : 'on');
  syncSeg(p.body.querySelector('#st-aidate'), S.aiDateGrain === 'full' ? 'full' : 'month');

  const fsHint = { std: '标准 · 正文 15px', big: '大 · 正文 17px', huge: '超大 · 正文 19px' };
  p.body.querySelector('#st-fs-hint').textContent = fsHint[S.fontSize || 'std'];
  onSeg(p.body.querySelector('#st-fs'), v => {
    saveSetting('fontSize', v);
    p.body.querySelector('#st-fs-hint').textContent = fsHint[v];
  });
  onSeg(p.body.querySelector('#st-dcat'), v => { saveSetting('defaultCat', v); });
  onSeg(p.body.querySelector('#st-auto'), v => { saveSetting('autoComment', v === '1'); });
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
    ? '已获长期保存授权：浏览器清理本地数据时不会连同本应用一起回收。'
    : (persistSupported()
      ? '未获授权时，浏览器在存储紧张时可能回收本应用的数据。点上方按钮可申请长期保存权限。'
      : '本机浏览器未提供「长期保存」开关。把本应用装到主屏后，系统会按独立应用长期保存。');
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
        <div class="save-note" style="border:none;padding-top:8px">装到主屏后，浏览器会把它当成独立应用，本机数据一般不再被当作临时缓存回收。</div>
        <div class="sec">🛡️ 没有授权也不影响恢复</div>
        <div class="save-note" style="border:none;padding-top:6px">应用每次打开都会在本机自动留一份快照，配合定期导出的备份文件，即使存储被系统回收也能恢复。<b>换手机、清缓存前先导出备份。</b></div>
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
  storageBreakdown().then(async s => {
    p.body.querySelector('#st-sto-hint').textContent = `合计 ${fmtMB(s.total)}`;
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
    const orphans = await orphanImages(state.db);
    p.body.querySelector('#st-orphan').textContent = orphans.length + ' 张';
    p.body.querySelector('#st-clean').onclick = async () => {
      if (!orphans.length) { toast('没有多余图片'); return; }
      for (const o of orphans) await deleteImage(state.db, o.imageId);
      toast(`已清理 ${orphans.length} 张多余图片`); p.close();
    };
  });
}
