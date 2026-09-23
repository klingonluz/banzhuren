// 记录 Tab：① 极速记录（页面内嵌）② 统计概览 ③ 成长时间线
// V11.1：正面管教标签体系（8 能力分类 + 关注）；关注子模块用 chip-switch；记录只存标签名 + 评语
import { state } from '../state.js';
import {
  listStudents, listRecordsPage, addRecord, softDeleteRecord, restoreRecord,
  countActiveRecords, getRecord, putImage, getImageBlob, listImages, incTagUse, listTags
} from '../db/semester.js';
import { WUYU, GUANZHU, GZ_GROUPS, GZ_SUB } from '../db/seed.js';
import { lintText, PHOTO_BAN, PHOTO_OK } from '../privacy.js';
import {
  el, esc, toast, banner, closeBanner, openPicker, closePickers,
  actionSheet, undoBar, emptyState, bindEmpty, confirm, lightbox, syncSeg, onSeg
} from '../ui.js';

const TL_PAGE = () => +(state.settings.tlPage || 20);   // 🔴 分页保命项：单页上限
// 🔴 时间线渐进显示：首屏 5 条，逐步 +5 直到 20，之后每页 TL_PAGE()（避免一次灌太多卡顿）
function nextLimit(offset) {
  if (offset === 0) return 5;
  if (offset < 20) return Math.min(5, 20 - offset);
  return TL_PAGE();
}
const MAX_IMG = 6;
let tlOffset = 0, tlFilter = '全部';
let objUrls = [];                         // 🔴 createObjectURL 必须配对 revoke
let tagCat = null, gzSub = null;          // 当前分类 / 当前关注子模块
let libTags = [];                         // 标签库（db.tags 快照，便于渲染）
let form = { stu: null, tags: new Set(), imgs: [], date: '' };
let lastAuto = '';
let editingId = null;
let allNames = [];                        // 全班姓名（含已转出）：评语「他人姓名」实时提醒用

const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ymPrefix = () => todayStr().slice(0, 8);
const draftKey = () => 'bzr_draft_' + (state.currentSemesterId || 'x');
const catColor = c => c === GUANZHU ? 'var(--danger)' : 'var(--primary-d)';

function revokeUrls() { objUrls.forEach(u => URL.revokeObjectURL(u)); objUrls = []; }
function objUrl(blob) { const u = URL.createObjectURL(blob); objUrls.push(u); return u; }

/* ================= ① 极速记录 ================= */
function quickCard() {
  return `
  <div class="card" id="quick-card">
    <h2>✍️ 极速记录 <span class="muted" style="font-weight:400;font-size:12px">（约 30 秒）</span></h2>

    <div class="field">
      <label>学生</label>
      <button class="student-pick" id="q-stu">选择学生 · 搜索姓名/拼音首字母 ▾</button>
    </div>

      <div class="field">
        <label>标签（点分类筛选，再点标签选中）</label>
        <div class="chips" id="q-cats"></div>
        <div id="q-tags"></div>
      </div>

    <div class="field">
      <label>评语</label>
      <textarea id="q-text" rows="3" placeholder="选标签自动填预设评语，可微调"></textarea>
      <div class="draft" id="q-draft"></div>
      <div class="draft" id="q-rule"></div>
    </div>

    <div class="field">
      <label>日期</label>
      <div class="row" style="gap:8px">
        <input type="date" id="q-date" max="${todayStr()}" class="datein">
        <button class="btn ghost tiny" id="q-today">今天</button>
        <button class="btn ghost tiny" id="q-yest">昨天</button>
      </div>
      <div class="draft" id="q-datetip"></div>
    </div>

    <div class="field">
      <label>图片（非必要不拍 · 只拍作品不拍人）</label>
      <div class="row" style="gap:8px">
        <button class="btn ghost tiny" id="q-cam">📷 拍照</button>
        <button class="btn ghost tiny" id="q-alb">🖼️ 相册</button>
        <span class="muted" style="font-size:12px">已选 <b id="q-imgn">0</b>/${MAX_IMG} 张</span>
      </div>
      <div class="photorule" id="q-photorule">
        <div class="pr-hd">📸 只拍物，不拍人</div>
        <div class="pr-row"><b>✅ 可以拍</b>${PHOTO_OK.map(x => esc(x)).join(' · ')}</div>
        <div class="pr-row"><b>❌ 不要拍</b>${PHOTO_BAN.map(x => esc(x)).join(' · ')}</div>
        <div class="pr-ft">入库会自动去掉拍摄位置等元信息；画面里本来就有的内容（人脸、姓名、名单）不会被自动识别，请在按下快门前就避开。</div>
      </div>
      <input type="file" id="q-cam-in" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="q-alb-in" accept="image/*" multiple style="display:none">
      <div class="imgs" id="q-imgs"></div>
      <label class="pdok" id="q-pdok" style="display:none"><input type="checkbox" id="q-pdchk"><span>画面已确认：无学生人脸 · 无他人姓名 / 署名 · 背景没有名单、座位表、成绩表</span></label>
      <div class="draft" id="q-phototip"></div>
    </div>

    <button class="btn mt" id="q-save">保存</button>
    <div class="save-note">删除或改名标签，不影响已保存的成长记录。评语与「图片说明」都会随记录保存；只有你自己复制的「AI 评语素材」会离开本设备，且已脱敏。</div>
  </div>`;
}

/* ---- 标签矩阵（分类 chips 筛选 + 平铺；关注用子模块 chip-switch） ---- */
async function renderTags(box) {
  const cats = [...WUYU, GUANZHU];                 // 🔴 9 个分类，不显示“全部”
  const catsEl = box.querySelector('#q-cats');
  if (!catsEl.dataset.bound) {
    catsEl.innerHTML = cats.map(c =>
      `<span class="chip ${c === tagCat ? 'on' : ''} ${c === GUANZHU ? 'gz' : ''}" data-cat="${esc(c)}">${esc(c)}</span>`).join('');
    catsEl.onclick = e => {
      const c = e.target.closest('[data-cat]'); if (!c) return;
      tagCat = c.dataset.cat;
      [...catsEl.children].forEach(x => x.classList.toggle('on', x === c));
      renderTags(box);
    };
    catsEl.dataset.bound = '1';
  }
  const tagsEl = box.querySelector('#q-tags');
  let subBar = '', list = [];
  if (tagCat === GUANZHU) {                        // 🔴 关注：先选子模块，再列该子模块标签
    const subs = Object.keys(GZ_GROUPS);
    subBar = `<div class="chips subsel">` + subs.map(s =>
      `<span class="chip ${s === gzSub ? 'on' : ''}" data-sub="${esc(s)}">${esc(s)}</span>`).join('') + `</div>`;
    list = libTags.filter(t => t.category === GUANZHU && (GZ_SUB[t.name] || subs[0]) === gzSub);
  } else {
    list = libTags.filter(t => t.category === tagCat);
  }
  list.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (b.useCount || 0) - (a.useCount || 0));
  tagsEl.innerHTML =
    (tagCat === GUANZHU ? `<div class="subhead">${esc(gzSub)}</div>` : '') +
    subBar +
    (list.length
      ? `<div class="tags">${list.map(t => `<div class="tag ${form.tags.has(t.name) ? 'on' : ''}" data-n="${esc(t.name)}">${esc(t.name)}</div>`).join('')}</div>`
      : '<div class="empty">该分类下暂无标签</div>');
  if (tagCat === GUANZHU) {
    const sb = tagsEl.querySelector('.subsel');
    if (sb) sb.onclick = e => { const s = e.target.closest('[data-sub]'); if (!s) return; gzSub = s.dataset.sub; renderTags(box); };
  }
  syncTagUI(tagsEl);
}

function syncTagUI(tagsEl) {
  tagsEl.querySelectorAll('.tag').forEach(el => el.classList.toggle('on', form.tags.has(el.dataset.n)));
}
function toggleTag(n) {
  if (form.tags.has(n)) form.tags.delete(n); else form.tags.add(n);
  autoPreset(); saveDraft();
}

/* ---- 草稿（localStorage：存储熔断时 IDB 写不进，草稿仍要能存） ---- */
function saveDraft() {
  try {
    localStorage.setItem(draftKey(), JSON.stringify({
      stu: form.stu, tags: [...form.tags], text: document.getElementById('q-text')?.value || '', date: form.date
    }));
    const tip = document.getElementById('q-draft');
    if (tip) tip.textContent = '草稿已暂存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {}
}
function clearDraft() { try { localStorage.removeItem(draftKey()); } catch {} const t = document.getElementById('q-draft'); if (t) t.textContent = ''; }
// 🔴 更新前 flush 草稿（§4.3）：立即更新会 reload，先确保未保存内容落 localStorage
export function flushDraft() { try { saveDraft(); } catch {} }
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch { return null; }
}

/* ---- 评语自动预设（仅当设置开启；默认关，避免标签已很细还自动灌评语显得臃肿） ---- */
/* 🔴 读取实时 libTags（不是 seed.js 的静态 TAG_PRESET），这样老师在「标签库」改过的预设评语立即生效 */
function autoPreset() {
  if (!state.settings.autoComment) { lastAuto = ''; return; }
  const ta = document.getElementById('q-text'); if (!ta) return;
  if (!form.tags.size) { if (ta.value === lastAuto) ta.value = ''; lastAuto = ''; saveDraft(); return; }
  const ps = [...form.tags].map(n => (libTags.find(t => t.name === n) || {}).presetComment).filter(Boolean);
  const v = ps.length ? ps.join('') : `该生${[...form.tags].join('、')}，表现突出。`;
  if (ta.value === '' || ta.value === lastAuto) { ta.value = v; lastAuto = v; }
  saveDraft();
}

/* ---- 图片 ---- */
async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1280 / img.width);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob(b => b ? resolve(b) : reject(new Error('compress fail')), 'image/jpeg', 0.8);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
function renderImgs() {
  const box = document.getElementById('q-imgs');
  if (!box) return;
  box.innerHTML = form.imgs.map((im, i) =>
    `<div class="img-cell"><div class="img-item" data-view="${i}"><img src="${im.url}" alt=""><span class="rmx" data-rm="${i}">&times;</span></div>` +
    `<input class="imgdesc" data-desc="${i}" value="${esc(im.desc || '')}" placeholder="这张的说明"></div>`).join('');
  const n = document.getElementById('q-imgn'); if (n) n.textContent = form.imgs.length;
  const okBox = document.getElementById('q-pdok');
  const chk = document.getElementById('q-pdchk');
  if (okBox) okBox.style.display = form.imgs.length ? '' : 'none';
  if (chk && !form.imgs.length) chk.checked = false;      // 图都删了 → 需要重新确认
  const tip = document.getElementById('q-phototip');
  if (tip) tip.textContent = form.imgs.length
    ? `已选 ${form.imgs.length} 张 · 入库已自动去掉拍摄位置等元信息；下面的「图片说明」会随记录保存并进入 AI 素材（照片本身不参与）${form.imgs.length >= 3 ? '；建议少拍，占内存' : ''}`
    : '';
}
async function pickImages(files) {
  for (const f of Array.from(files)) {
    if (form.imgs.length >= MAX_IMG) { toast(`最多 ${MAX_IMG} 张`); break; }
    const blob = await compressImage(f);
    form.imgs.push({ blob, url: URL.createObjectURL(blob), desc: '' });
  }
  renderImgs();
}

/* ---- 学生选择器（全屏 + 拼音首字母搜索） ---- */
export function pickStudent(onPick, currentId) {
  return listStudents(state.db).then(students => {
    const p = openPicker({
      title: '选择学生',
      lead: '支持按姓名或拼音首字母搜索（如「张梓涵」打 zzh）。',
      body: `<input class="search" id="sp-q" placeholder="搜索姓名 / 拼音首字母" style="border-bottom:1px solid var(--line)">
             <div id="sp-lst"></div>`,
      foot: `<button class="btn" data-pclose>关闭</button>`
    });
    const lst = p.body.querySelector('#sp-lst');
    const draw = q => {
      q = (q || '').trim().toLowerCase();
      const hit = students.filter(s => !q || s.name.includes(q) || (s.pinyin || '').toLowerCase().includes(q));
      lst.innerHTML = hit.length
        ? hit.map(s => `<div class="srow ${s.id === currentId ? 'on' : ''}" data-id="${s.id}">${esc(s.name)}<span class="py">${esc(s.pinyin || '')}</span></div>`).join('')
        : '<div class="empty">无匹配学生</div>';
    };
    draw('');
    p.body.querySelector('#sp-q').oninput = e => draw(e.target.value);
    lst.onclick = e => {
      const row = e.target.closest('.srow'); if (!row) return;
      const st = students.find(s => s.id === row.dataset.id);
      p.close(); onPick(st);
    };
    return p;
  });
}

/* ================= ② 统计概览 ================= */
async function computeStats() {
  const db = state.db;
  const students = await listStudents(db);
  const recs = await db.growth_records.where('del').equals(0).toArray();
  const imgs = await listImages(db);
  const imgN = imgs.length;                       // 🔴 取图片池长度，含孤儿
  const recStu = new Set(recs.map(r => r.studentId));
  const covered = students.filter(s => recStu.has(s.id));
  const unrec = students.filter(s => !recStu.has(s.id));
  const dist = {}; WUYU.forEach(w => dist[w] = 0); dist[GUANZHU] = 0;
  recs.forEach(r => { if (dist[r.category] != null) dist[r.category]++; });
  const tagCnt = {};
  recs.forEach(r => (r.tags || []).forEach(n => tagCnt[n] = (tagCnt[n] || 0) + 1));
  const top = Object.entries(tagCnt).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([n, c]) => ({ n, c }));
  return { total: recs.length, imgN, students, covered: covered.length, unrec, dist, top, recs };
}

function statCard(s) {
  const pct = s.students.length ? Math.round(s.covered / s.students.length * 100) : 0;
  const maxD = Math.max(1, ...WUYU.map(w => s.dist[w]), s.dist[GUANZHU]);
  const ovRow = (label, n, color) => `
    <div class="ov-row">
      <div class="lab" style="color:${color};font-weight:600">${esc(label)}</div>
      <div class="ov-bar"><i style="width:${Math.round(n / maxD * 100)}%;background:${color}"></i></div>
      <div class="num">${n}</div>
    </div>`;
  const abilityRows = WUYU.map(w => ovRow(w, s.dist[w], 'var(--primary)')).join('');
  const gzRow = ovRow(GUANZHU, s.dist[GUANZHU], 'var(--danger)');   // 🔴 关注单独红条
  const maxT = Math.max(1, ...s.top.map(t => t.c));
  return `
  <div class="card">
    <h2>📊 统计概览 <span class="muted" style="font-weight:400;font-size:12px">本学期</span></h2>
    <div class="stat-grid">
      <div class="stat"><b>${s.total}</b><span>成长记录</span></div>
      <div class="stat"><b>${s.imgN}</b><span>已拍图片</span></div>
      <div class="stat"><b>${s.covered}/${s.students.length}</b><span>已记录学生</span></div>
    </div>
    <div class="ov-row"><div class="lab">覆盖</div>
      <div class="ov-bar"><i id="covBar" style="width:${pct}%"></i></div>
      <div class="num" id="covPct">${pct}%</div></div>
    <button class="btn ghost mt" id="q-unrec">未记录学生（${s.unrec.length} 人）→</button>
    <button class="btn ghost tiny mt" id="q-stattoggle" style="width:auto">📊 统计详情（分布 / 高频标签）▾</button>
    <div id="statDetail" style="display:none;margin-top:10px">
      <div style="font-size:13px;color:var(--txt2)">能力分布</div>
      <div id="wuyuBox">${abilityRows}${gzRow}</div>
      <div style="margin-top:14px;font-size:13px;color:var(--txt2)">高频标签</div>
      <div id="tagBox2">${s.top.length ? s.top.map(t => `
        <div class="ov-row"><div class="lab" style="width:64px">${esc(t.n)}</div>
          <div class="ov-bar"><i style="width:${Math.round(t.c / maxT * 100)}%"></i></div>
          <div class="num">${t.c}</div></div>`).join('') : '<div class="muted">暂无标签数据</div>'}</div>
      <div class="save-note">统计数字来自你实际写的成长记录，和时间线、导出完全对应。</div>
    </div>
  </div>`;
}

function openUnrec(unrec) {
  const groups = {};
  unrec.forEach(s => { const k = (s.pinyin || '#')[0].toUpperCase(); (groups[k] = groups[k] || []).push(s); });
  const keys = Object.keys(groups).sort();
  const p = openPicker({
    title: `未记录学生（${unrec.length} 人）`,
    lead: '这些学生本学期还没有任何成长记录。<b>点任意一行即可跳去记录页</b>给他们补一条——这是行动清单，不是虚荣数字。',
    body: unrec.length ? keys.map(k => `
      <div class="sec-hd" style="padding:8px 16px 4px;background:#f4f6f4">${esc(k)}</div>
      ${groups[k].map(s => `<div class="unrec-row" data-go="${s.id}" style="margin:0 12px"><span class="nm">${esc(s.name)}</span><span class="muted">去记录 →</span></div>`).join('')}`).join('')
      : '<div class="empty">全班已覆盖 🎉</div>',
    foot: `<button class="btn" data-pclose>关闭</button>`
  });
  p.body.onclick = e => {
    const row = e.target.closest('[data-go]'); if (!row) return;
    p.close();
    setStudent(row.dataset.go);
    document.getElementById('quick-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('已选中，随手记一条吧');
  };
}

/* ================= ③ 成长时间线 ================= */
async function fetchPage(offset, limit) {
  const db = state.db;
  if (tlFilter === '全部') return await listRecordsPage(db, { offset, limit });
  if (tlFilter === '有图') {
    const arr = await db.growth_records.where('del').equals(0).reverse().toArray();
    return arr.filter(r => (r.imageIds || []).length).slice(offset, offset + limit);
  }
  if (tlFilter === '本月') {
    const pre = ymPrefix();
    return await db.growth_records.where('[del+date]').between([0, pre + '01'], [0, pre + '32']).reverse().toArray();
  }
  // 按分类名过滤（8 能力 / 关注）
  const arr = await db.growth_records.where('category').equals(tlFilter).toArray();
  return arr.filter(r => r.del === 0).sort((a, b) => b.date.localeCompare(a.date)).slice(offset, offset + limit);
}

function gridClass(n) { return n === 1 ? 'g1' : n === 2 ? 'g2' : 'g3'; }

function recCard(r, name) {
  const tags = (r.tags || []).map(n => `<span>${esc(n)}</span>`).join('');
  const imgs = r.imageIds || [];
  const mode = state.settings.tlMode || 'card';
  const head = `<b>${esc(name)}</b><span>${esc(r.date)}</span><span style="color:${catColor(r.category)}">${esc(r.category)}</span>`;

  if (mode === 'cpt') {
    return `<div class="tl-cpt" data-id="${esc(r.id)}">
      ${imgs.length ? `<span class="bd" data-img="0" data-id="${esc(r.id)}">📷${imgs.length}</span>` : ''}
      <div style="flex:1;min-width:0">
        <div class="tl-meta">${head}</div>
        <div class="tl-comment">${esc(r.text || '')}</div>
      </div>
      <div class="tl-act" data-act="${esc(r.id)}">⋯</div>
    </div>`;
  }
  if (mode === 'list') {
    return `<div class="tl-item" data-id="${esc(r.id)}">
      ${imgs.length ? `<div class="tl-thumb" data-img="0" data-id="${esc(r.id)}">图</div>` : `<div class="tl-thumb">${esc(name.slice(0, 1))}</div>`}
      <div style="flex:1;min-width:0">
        <div class="tl-meta">${head}</div>
        <div class="tl-comment">${esc(r.text || '')}</div>
        ${tags ? `<div class="tl-tags">${tags}</div>` : ''}
      </div>
      <div class="tl-act" data-act="${esc(r.id)}">⋯</div>
    </div>`;
  }
  return `<div class="tl-card" data-id="${esc(r.id)}">
    <div class="tl-meta">${head}</div>
    <div class="tl-comment">${esc(r.text || '')}</div>
    ${tags ? `<div class="tl-tags">${tags}</div>` : ''}
    ${imgs.length ? `<div class="grid ${gridClass(imgs.length)}">${imgs.map((_, i) => `<div class="ph" data-img="${i}" data-id="${esc(r.id)}">图</div>`).join('')}</div>` : ''}
    ${(r.imgDescs || []).filter(Boolean).length ? `<div class="tl-desc">${(r.imgDescs || []).map((d, i) => d ? `图 ${i + 1}：${esc(d)}` : '').filter(Boolean).join('　')}</div>` : ''}
    <div class="tl-act" data-act="${esc(r.id)}">⋯</div>
  </div>`;
}

async function renderTimeline(tl, append) {
  if (!append) { tlOffset = 0; tl.innerHTML = '<div class="empty">加载中…</div>'; }
  const db = state.db;
  const students = await listStudents(db, { includeOut: true });
  const map = {}; students.forEach(s => map[s.id] = s.name);
  const page = await fetchPage(tlOffset, nextLimit(tlOffset));
  if (!append) {
    const any = await countActiveRecords(db);
    if (!page.length) {
      tl.innerHTML = any
        ? emptyState('该筛选下暂无记录', '查看全部记录') : emptyState('本学期还没有记录', '去「记录」页写第一条 →');
      bindEmpty(tl, () => {
        if (any) { tlFilter = '全部'; syncChips(); renderTimeline(tl); }
        else document.getElementById('quick-card')?.scrollIntoView({ behavior: 'smooth' });
      });
      return;
    }
    tl.innerHTML = '';
  }
  for (const r of page) {
    const node = el(recCard(r, map[r.studentId] || '?'));
    const imgs = r.imageIds || [];
    for (let i = 0; i < imgs.length; i++) {
      const blob = await getImageBlob(db, imgs[i]);
      if (!blob) continue;
      const u = objUrl(blob);
      const slot = node.querySelector(`[data-img="${i}"]`);
      if (slot) slot.innerHTML = `<img src="${u}" alt="">`;
    }
    tl.appendChild(node);
  }
  tlOffset += page.length;
  if (page.length >= nextLimit(tlOffset)) {
    const more = el('<button class="btn ghost mt" id="tl-more">加载更多</button>');
    more.onclick = () => { more.remove(); renderTimeline(tl, true); };
    tl.appendChild(more);
  } else if (page.length) {
    tl.appendChild(el('<div class="empty">—— 没有更多了 ——</div>'));
  }
}

function syncChips() {
  document.querySelectorAll('#tl-chips .chip').forEach(c =>
    c.classList.toggle('on', c.dataset.f === tlFilter));
}

/* ================= 挂载 ================= */
export async function mount(scrollEl) {
  revokeUrls();
  const nmap = {};                        // 🔴 评语「他人姓名」提醒（含已转出，避免漏判）
  (await listStudents(state.db, { includeOut: true })).forEach(s => nmap[s.id] = s.name);
  allNames = Object.values(nmap).filter(Boolean);
  const stats = await computeStats();
  libTags = await listTags(state.db);
  if (!tagCat) tagCat = state.settings.defaultCat || WUYU[0];
  if (!gzSub) gzSub = Object.keys(GZ_GROUPS)[0];

  scrollEl.innerHTML = `
    ${quickCard()}
    ${statCard(stats)}
    <div class="card">
      <h2>📜 成长时间线 <span class="muted" style="font-weight:400;font-size:12px">（分页懒加载）</span></h2>
      <div class="chips" id="tl-chips">
        ${['全部', ...WUYU, GUANZHU, '有图', '本月'].map(f =>
          `<span class="chip ${f === tlFilter ? 'on' : ''} ${f === GUANZHU ? 'gz' : ''}" data-f="${esc(f)}">${esc(f)}</span>`).join('')}
      </div>
      <div id="tl"></div>
      <div class="save-note">时间线分批加载，记录再多也流畅不卡顿。</div>
    </div>`;

  /* --- 极速记录交互 --- */
  const qStu = scrollEl.querySelector('#q-stu');
  const qText = scrollEl.querySelector('#q-text');
  const qDate = scrollEl.querySelector('#q-date');
  form.date = form.date || todayStr();
  qDate.value = form.date;

  const redrawStu = async () => {
    if (!form.stu) { qStu.textContent = '选择学生 · 搜索姓名/拼音首字母 ▾'; qStu.classList.remove('sel'); return; }
    const ss = await listStudents(state.db, { includeOut: true });
    const st = ss.find(s => s.id === form.stu);
    qStu.innerHTML = `<span>${esc(st ? st.name : form.stu)}</span><span class="chg">更改</span>`;
    qStu.classList.add('sel');
  };
  redrawStu();

  // 🔴 记录端规范（§2.12 D 源头治理）：在「写」的这一刻提醒，而不是事后打码
  const RULE_TIP = '评语不写：真实姓名（本人或同学）· 分数 · 名次 · 家庭隐私。建议写「行为 + 影响」（如「主动帮助同学讲解，对方有明显进步」），把同学写成「同桌 / 同伴 / 小组」。';
  const ruleEl = scrollEl.querySelector('#q-rule');
  if (ruleEl) ruleEl.textContent = RULE_TIP;
  const lint = () => {
    if (!ruleEl) return;
    const self = nmap[form.stu] || '';
    const descs = form.imgs.map(im => im.desc || '').filter(Boolean);
    const tips = lintText([qText.value, ...descs].join('\n'), allNames.filter(n => n !== self));
    if (!tips.length) { ruleEl.className = 'draft'; ruleEl.textContent = RULE_TIP; return; }
    ruleEl.className = 'draft warn';
    ruleEl.innerHTML = tips.map(t => '⚠️ ' + esc(t.tip)).join('<br>');
  };
  qStu.onclick = () => pickStudent(st => { form.stu = st.id; redrawStu(); saveDraft(); lint(); }, form.stu);
  qText.oninput = () => { saveDraft(); lint(); };
  qDate.onchange = () => {
    form.date = qDate.value || todayStr();
    const t = scrollEl.querySelector('#q-datetip');
    t.textContent = form.date === todayStr() ? '今天' : form.date === yesterday() ? '昨天' : '补录 ' + form.date;
    saveDraft();
  };
  const yesterday = () => { const d = new Date(Date.now() - 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  scrollEl.querySelector('#q-today').onclick = () => { qDate.value = todayStr(); qDate.onchange(); };
  scrollEl.querySelector('#q-yest').onclick = () => { qDate.value = yesterday(); qDate.onchange(); };

  // 图片
  // 🔴 V11.11：拍摄规范改为「常显在图片区」——不再弹层、不再有「首次提示」，老师一眼就能看到。
  //    规范（拍之前就看见）+ 入库确认勾选（保存前再确认）构成两道门；照片的 EXIF 由压缩重绘天然剥掉。
  scrollEl.querySelector('#q-cam').onclick = () => scrollEl.querySelector('#q-cam-in').click();
  scrollEl.querySelector('#q-alb').onclick = () => scrollEl.querySelector('#q-alb-in').click();
  scrollEl.querySelector('#q-cam-in').onchange = e => { pickImages(e.target.files); e.target.value = ''; };
  scrollEl.querySelector('#q-alb-in').onchange = e => { pickImages(e.target.files); e.target.value = ''; };
  scrollEl.querySelector('#q-imgs').onclick = e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { const i = +rm.dataset.rm; URL.revokeObjectURL(form.imgs[i].url); form.imgs.splice(i, 1); renderImgs(); return; }
    const v = e.target.closest('[data-view]');
    if (v) lightbox(form.imgs.map(x => x.url), +v.dataset.view);
  };
  // 🔴 图片说明：随打随存进 form.imgs[i].desc，并即时跑一次规范检查（说明也会进 AI 素材）
  scrollEl.querySelector('#q-imgs').addEventListener('input', e => {
    const d = e.target.closest('[data-desc]'); if (!d) return;
    const im = form.imgs[+d.dataset.desc]; if (im) im.desc = d.value;
    lint();
  });
  renderImgs();

  // 标签
  await renderTags(scrollEl);
  scrollEl.querySelector('#q-tags').addEventListener('click', e => {
    const tag = e.target.closest('.tag'); if (!tag) return;
    toggleTag(tag.dataset.n);
    syncTagUI(scrollEl.querySelector('#q-tags'));
  });

  // 恢复草稿
  const d = loadDraft();
  if (d && !form.stu) {
    form.stu = d.stu || null; form.tags = new Set(d.tags || []);
    qText.value = d.text || ''; if (d.date) { qDate.value = d.date; form.date = d.date; }
    redrawStu(); await renderTags(scrollEl);
    const tip = scrollEl.querySelector('#q-draft');
    if (tip && d.text) tip.textContent = '已恢复上次未保存的草稿';
    lint();
  }

  // 保存（🔴 状态机）
  const saveBtn = scrollEl.querySelector('#q-save');
  saveBtn.onclick = async () => {
    if (saveBtn.disabled) return;
    if (!form.stu) { toast('请先选择学生'); return; }
    const text = qText.value.trim();
    if (!text && form.tags.size === 0) { toast('评语或标签至少填一项'); return; }
    // 🔴 照片入库确认（§2.12 C4）：画面里本来就有的内容不会被自动识别，必须由拍摄者确认
    if (form.imgs.length && state.settings.photoGuard !== 'off') {
      const chk = scrollEl.querySelector('#q-pdchk');
      if (chk && !chk.checked) {
        toast('照片还没确认合规，请先勾选');
        const box = scrollEl.querySelector('#q-pdok');
        if (box) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    }
    saveBtn.disabled = true; saveBtn.textContent = '保存中…';
    try {
      const db = state.db;
      const imageIds = [], imgDescs = [];
      for (const im of form.imgs) {                   // 🔴 图片在学期库（随归档一起删）
        const imageId = 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await putImage(db, imageId, im.blob);
        imageIds.push(imageId);
        imgDescs.push((im.desc || '').trim());        // 🔴 图片说明与 imageIds 一一对齐
      }
      const rec = {
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        studentId: form.stu,
        category: tagCat,
        tags: [...form.tags],
        text, imageIds, imgDescs, templateId: null,
        date: qDate.value || todayStr(),
        updatedAt: Date.now(), del: 0
      };
      await addRecord(db, rec);
      for (const n of rec.tags) { try { await incTagUse(db, n, 1); } catch {} }   // 使用频率 +1
      // 成功才清空：清标签/评语/图片，保留学生由 afterSave 决定
      form.tags.clear(); lastAuto = ''; form.imgs.forEach(i => URL.revokeObjectURL(i.url)); form.imgs = [];
      qText.value = '';
      const keep = state.settings.afterSave !== 'clear';
      if (!keep) { form.stu = null; redrawStu(); }
      clearDraft();
      toast('已保存');
      saveBtn.disabled = false; saveBtn.textContent = '保存';
      await renderTags(scrollEl); renderImgs();
      await refreshLists(stats);
    } catch (err) {
      saveBtn.disabled = false; saveBtn.textContent = '保存';
      const quota = String(err && err.name || '').includes('Quota') || String(err.message).includes('Quota');
      banner('errBanner', quota
        ? '⚠️ 存储空间不足，本次<b>未保存</b>（草稿与已填内容均保留）。'
        : '⚠️ 保存失败：<b>未保存</b>，内容已保留。');
    }
  };

  /* --- 统计概览 --- */
  scrollEl.querySelector('#q-unrec').onclick = () => openUnrec(stats.unrec);
  const statToggle = scrollEl.querySelector('#q-stattoggle');
  if (statToggle) statToggle.onclick = () => {
    const det = scrollEl.querySelector('#statDetail');
    const open = det.style.display === 'none';
    det.style.display = open ? '' : 'none';
    statToggle.textContent = open ? '📊 收起统计详情 ▴' : '📊 统计详情（分布 / 高频标签）▾';
  };

  /* --- 时间线 --- */
  const tl = scrollEl.querySelector('#tl');
  scrollEl.querySelector('#tl-chips').onclick = e => {
    const c = e.target.closest('[data-f]'); if (!c) return;
    tlFilter = c.dataset.f; syncChips(); renderTimeline(tl);
  };
  tl.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]');
    if (act) { openRecordActions(act.dataset.act, () => refreshLists(stats)); return; }
    const img = e.target.closest('[data-img]');
    if (img) {
      const r = await getRecord(state.db, img.dataset.id);
      const ids = (r && (r.imageIds || [])) || [];
      const urls = [];
      for (const id of ids) { const b = await getImageBlob(state.db, id); if (b) urls.push(objUrl(b)); }
      if (urls.length) lightbox(urls, +img.dataset.img);
    }
  });
  await renderTimeline(tl);
}

// 局部刷新：统计 + 时间线（不重建极速记录表单）
async function refreshLists(oldStats) {
  const s = await computeStats();
  const cards = document.querySelectorAll('.card');
  if (cards[1]) cards[1].outerHTML = statCard(s);
  document.querySelector('#q-unrec') && (document.querySelector('#q-unrec').onclick = () => openUnrec(s.unrec));
  const tl = document.getElementById('tl');
  if (tl) await renderTimeline(tl);
}

// 记录编辑 / 删除
async function openRecordActions(id, onDone) {
  const db = state.db;
  const r = await getRecord(db, id);
  if (!r) return;
  actionSheet([
    { label: '✏️ 编辑这条记录', onClick: () => openEdit(r, onDone) },
    { label: '🗑️ 删除', danger: true, onClick: () => confirm({
      title: '删除记录', msg: '删除后 5 秒内可撤销；也可在「数据 → 回收站」恢复。', danger: true,
      onOk: async () => {
        await softDeleteRecord(db, id);
        toast('已移入回收站');
        onDone && onDone();
        undoBar('已删除 1 条记录', async () => { await restoreRecord(db, id); toast('已恢复'); onDone && onDone(); });
      }
    }) }
  ]);
}

function openEdit(r, onDone) {
  const studentsP = listStudents(state.db, { includeOut: true });
  studentsP.then(async students => {
    const tags = new Set(r.tags || []);
    let stu = r.studentId;
    const p = openPicker({
      title: '编辑记录',
      body: `
        <div style="padding:14px 16px">
          <div class="field"><label>学生</label><button class="student-pick sel" id="e-stu">${esc(students.find(s => s.id === stu)?.name || '?')}<span class="chg">更改</span></button></div>
          <div class="field"><label>日期</label><input class="ta" type="date" id="e-date" value="${esc(r.date)}" style="width:auto"></div>
          <div class="field"><label>标签</label><div id="e-tags">${[...WUYU, GUANZHU].map(cat => {
            const g = libTags.filter(t => t.category === cat);
            if (!g.length) return '';
            return `<div class="tagcat"><span class="dot" style="background:${catColor(cat)}"></span>${esc(cat)}</div>
              <div class="tags">${g.map(t => `<div class="tag ${tags.has(t.name) ? 'on' : ''}" data-n="${esc(t.name)}">${esc(t.name)}</div>`).join('')}</div>`;
          }).join('')}</div></div>
          <div class="field"><label>评语</label><textarea class="ta" id="e-text" rows="4">${esc(r.text || '')}</textarea></div>
          ${(r.imageIds || []).length ? `<div class="field"><label>图片说明 <span class="muted" style="font-weight:400;font-size:11px">照片不进 AI，这段文字会</span></label>
            ${(r.imageIds || []).map((_, i) => `<input class="imgdesc" data-edesc="${i}" value="${esc((r.imgDescs || [])[i] || '')}" placeholder="第 ${i + 1} 张的说明">`).join('')}</div>` : ''}
        </div>`,
      foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn" id="e-save">保存修改</button>`
    });
    p.body.querySelector('#e-stu').onclick = () => pickStudent(st => {
      stu = st.id;
      p.body.querySelector('#e-stu').innerHTML = `${esc(st.name)}<span class="chg">更改</span>`;
    }, stu);
    p.body.querySelector('#e-tags').onclick = e => {
      const t = e.target.closest('.tag'); if (!t) return;
      if (tags.has(t.dataset.n)) { tags.delete(t.dataset.n); t.classList.remove('on'); }
      else { tags.add(t.dataset.n); t.classList.add('on'); }
    };
    p.foot.querySelector('#e-save').onclick = async () => {
      const cat = [...tags].map(n => libTags.find(t => t.name === n)?.category).find(Boolean) || r.category;
      const imgDescs = (r.imageIds || []).map((_, i) => (((p.body.querySelector('[data-edesc="' + i + '"]') || {}).value) || '').trim());
      await state.db.growth_records.put({
        ...r, studentId: stu, date: p.body.querySelector('#e-date').value || r.date,
        tags: [...tags], category: cat, text: p.body.querySelector('#e-text').value.trim(),
        imgDescs: imgDescs.length ? imgDescs : (r.imgDescs || []), updatedAt: Date.now()
      });
      p.close(); toast('已更新'); onDone && onDone();
    };
  });
}

// 供「未记录学生」跳转后预填学生
function setStudent(id) {
  form.stu = id;
  const qStu = document.getElementById('q-stu');
  if (qStu) {
    listStudents(state.db, { includeOut: true }).then(ss => {
      const st = ss.find(s => s.id === id);
      qStu.innerHTML = `<span>${esc(st ? st.name : id)}</span><span class="chg">更改</span>`;
      qStu.classList.add('sel');
    });
  }
  saveDraft();
}
