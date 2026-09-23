// 主入口：启动 → 状态栏 / 顶栏 / Banner 区 / 四 Tab 路由 / PWA
// 布局对齐 ui_prototype.html（方案 §4.8.3）
import {
  state, ensureCurrentSemester, loadSettings, setSemester, refresh, applyFontSize, onChange, teacherInitial,
  readPersisted, captureInstallPrompt
} from './state.js';
import { getSetting, setSetting, meta, listSemesters } from './db/meta.js';
import { openSemester, listStudents, bulkPutStudents } from './db/semester.js';
import { nameInitials } from './pinyin.js';
import { el, esc, toast, banner, closeBanner, openPicker, closePickers } from './ui.js';
import { mount as mountRecord, flushDraft } from './tabs/record.js';
import { mount as mountClass } from './tabs/class.js';
import { mount as mountAnalysis } from './tabs/analysis.js';
import { mount as mountData, housekeeping, quickBackup, openSettings, autoBackupMaybe, openSnapList, openImportPack } from './tabs/data.js';
import { listSnaps, rescueError } from './db/rescue.js';
import { classifyDbError, DB_ERR_NEWER, DB_ERR_BLOCKED, DB_ERR_CORRUPT } from './db/migrate.js';

// 🔴 4 个 Tab：不做 5 个、不做汉堡菜单（拇指够不到边缘）
const TABS = [
  { key: 'record',   ic: '✍️', label: '记录', mount: mountRecord },
  { key: 'class',    ic: '🗂️', label: '班务', mount: mountClass },
  { key: 'analysis', ic: '📊', label: '分析', mount: mountAnalysis },
  { key: 'data',     ic: '🔒', label: '数据', mount: mountData }
];
let activeTab = 'record';

// 🔴 产品版本号（对外：页脚展示 + 更新 UI）。语义化：修 bug 升末位（v1.0.1）、
//    加功能升中位（v1.1.0）、数据结构不兼容升首位（v2.0.0）。首个公开发布 = v1.0.0。
//    注意：内部还有一套「方案文档版本号」（如 V11.10），只用于设计记录，不对外，见 tabs/data.js 的 PLAN_VER。
const APP_VER = 'v1.4.0';
// 🔴 部署网址锚点（换网址风险防护，§13.7.1）：留空 = 首次启动自动记录当前 origin 并比对；
//    上线固定域名后建议填死，例如 'https://banzhuren.example.com'，网址变化即弹告警提醒导入备份。
const EXPECTED_ORIGIN = '';

// 🔴 头像：未填姓名时留空显示「＋」占位，title 引导填写（首装不预置假名，避免像预置样例数据）
const AVATAR_EMPTY = '＋';
function avatarTitle() {
  const n = (state.settings.teacherName || '').trim();
  return n ? `${n} · 点此修改` : '点此填写你的姓名';
}

function shell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="topbar">
      <div>
        <div class="title">班主任工作台</div>
        <div class="sub" id="sem-name">—</div>
      </div>
      <div class="avatar" id="sem-avatar" title="${esc(avatarTitle())}">${esc(teacherInitial() || AVATAR_EMPTY)}</div>
    </div>
    <div class="banners" id="banners"></div>
    <div class="sem-pop" id="sem-pop"></div>
    <div class="scroll" id="scroll"></div>
    <div class="footer" id="footer">
      <span class="ver">版本 ${esc(APP_VER)}</span>
      <button id="dt-check-update">🔄 检查更新<span class="dot"></span></button>
    </div>
    <div class="update-mask" id="updateMask">
      <div class="update-card">
        <div class="ic">🔄</div>
        <h3>发现新版本</h3>
        <p>已为你准备好更新。点击「立即更新」会先保存当前草稿再重启，不会丢失正在写的内容。</p>
        <div class="row">
          <button class="btn ghost" id="um-later">稍后</button>
          <button class="btn" id="um-now">立即更新</button>
        </div>
      </div>
    </div>
    <div class="tabbar" id="tabbar">
      ${TABS.map(t => `<button class="tab" data-tab="${t.key}"><span class="ic">${t.ic}</span>${t.label}</button>`).join('')}
    </div>`;
  app.querySelector('#tabbar').onclick = e => {
    const b = e.target.closest('.tab'); if (!b) return;
    switchTab(b.dataset.tab);
  };
  app.querySelector('#sem-avatar').onclick = toggleSemPop;
  app.querySelector('#dt-check-update').onclick = checkForUpdate;
  const um = app.querySelector('#updateMask');
  um.querySelector('#um-later').onclick = () => um.classList.remove('show');
  um.querySelector('#um-now').onclick = applyUpdate;

  onChange(() => {                       // 学期 / 设置变更后刷新
    const n = document.getElementById('sem-name');
    if (n) n.textContent = state.semester?.name || '';
    const av = document.getElementById('sem-avatar');
    if (av) { av.textContent = teacherInitial() || AVATAR_EMPTY; av.title = avatarTitle(); }
    renderActive();
  });
}

function switchTab(key) {
  activeTab = key;
  document.querySelectorAll('#tabbar .tab').forEach(t =>
    t.classList.toggle('on', t.dataset.tab === key));
  // 引导气泡跟随当前 Tab：不清掉旧气泡的话，它会悬浮遮挡新页面，
  // 而且 hintFor 里「已有气泡就返回」的守卫会让后续 Tab 的引导永远不出现。
  document.getElementById('app')?.querySelectorAll('.hint-bubble').forEach(b => b.remove());
  renderActive();
  hintFor(key);
}

function renderActive() {
  const scroll = document.getElementById('scroll');
  if (!scroll) return;
  const tab = TABS.find(t => t.key === activeTab);
  tab.mount(scroll);
}

async function toggleSemPop() {
  const pop = document.getElementById('sem-pop');
  if (pop.classList.contains('show')) { pop.classList.remove('show'); return; }
  const sems = await meta.semesters.orderBy('startAt').toArray();
  // 🔴 头像文字来自「教师姓名」设置：这里给个直达入口，点一下就能改
  const hasName = !!(state.settings.teacherName || '').trim();
  pop.innerHTML = `<div class="opt tn" data-tname="1">👤 ${esc(hasName ? state.settings.teacherName + ' · 修改姓名 / 头像' : '设置姓名 / 头像')}</div>`
    + sems.filter(s => s.status !== 'cleared').map(s =>
    `<div class="opt ${s.id === state.currentSemesterId ? 'on' : ''}" data-id="${s.id}">${esc(s.name)}${s.status === 'grace' ? ' · 归档宽限' : s.status === 'archived' ? ' · 已归档' : ''}</div>`
  ).join('') + `<div class="opt" data-manage="1">⚙️ 管理学期…</div>`;
  pop.classList.add('show');
  pop.onclick = async e => {
    const opt = e.target.closest('.opt'); if (!opt) return;
    pop.classList.remove('show');
    if (opt.dataset.tname) { openSettings(); return; }
    if (opt.dataset.manage) { switchTab('data'); toast('在「数据 → 学期管理」中操作'); return; }
    const s = sems.find(x => x.id === opt.dataset.id);
    if (!s || s.id === state.currentSemesterId) return;
    await meta.semesters.put({ ...s, status: 'active' });
    setSemester(s); await setSetting('currentSemester', s.id);
    toast('已切换到 ' + s.name); refresh();
  };
}
document.addEventListener('click', e => {
  const pop = document.getElementById('sem-pop');
  if (pop && pop.classList.contains('show') && !pop.contains(e.target) && !e.target.closest('#sem-avatar')) pop.classList.remove('show');
});

/* ---------- 备份提醒（天数由 lastExport 推导，绝不写死） ---------- */
// 🔴 横幅上的「立即备份」= 直接导出（导出成功 → 写 lastExport → 横幅当天消失），
//    不是"跳到数据页再让老师点一次"。与数据页「导出备份」共用 quickBackup()。
async function onQuickBackup() {
  const chip0 = document.getElementById('bk-now');
  if (chip0) chip0.textContent = '导出中…';
  try {
    await quickBackup();                 // 内部已更新 lastExport 并关闭横幅
    toast('备份已导出（全量含图）');
  } catch (e) {
    banner('backupBanner', `💾 备份导出失败：<b>${esc(e.message || e)}</b>（数据未被改动，可重试）。<span class="chip" id="bk-now">重试</span>`, 'warn');
    bindBackupChip();
  }
}
function bindBackupChip() {
  const chip = document.getElementById('bk-now');
  if (chip) chip.onclick = onQuickBackup;
}

async function backupBanner() {
  const s = state.settings;
  if (s.remind === 'off') return;
  const cycle = s.remind === 'biweekly' ? 14 : 7;
  const days = s.lastExport ? Math.floor((Date.now() - s.lastExport) / 86400000) : null;
  if (days != null && days < cycle) return;
  const txt = days == null ? '还没有导出过备份' : `距上次备份已 ${days} 天`;
  banner('backupBanner', `💾 ${txt}（提醒周期 ${cycle} 天），建议导出一份。<span class="chip" id="bk-now">立即备份</span>`, 'warn');
  bindBackupChip();
}

/* ---------- 引导气泡（每 Tab 首次进入，状态存 device.dismissedHints） ---------- */
async function hintFor(key) {
  const HINTS = {
    record: { anchor: '#q-stu', text: '先点这里选学生，再点标签、写评语，30 秒记一条。' },
    class:  { anchor: '#cl-today', text: '课表按节次索引：改作息不会让课程错位。' },
    analysis: { anchor: '#an-ai', text: '要发给 AI 就用「AI 评语素材」：姓名换成代号，分数、名次、具体日期与他人姓名自动隐去，照片不参与。' },
    data:   { anchor: '#dt-backup', text: '手机会丢、系统会清，定期导出备份是唯一的保险；要给家长看的文字材料用「成长记录文本」。' },
  };
  const h = HINTS[key]; if (!h) return;
  const dismissed = (await getSetting('dismissedHints', [])) || [];
  if (dismissed.includes(key)) return;
  setTimeout(() => {
    if (activeTab !== key) return;          // 350ms 内已切走 Tab → 不再补气泡，避免飘在别的页面上
    const anchor = document.querySelector(h.anchor);
    if (!anchor) return;
    const app = document.getElementById('app');
    if (app.querySelector('.hint-bubble')) return;
    const b = el(`<div class="hint-bubble"><span class="close">✕</span>${esc(h.text)}<span class="arr"></span></div>`);
    const r = anchor.getBoundingClientRect(), ar = app.getBoundingClientRect();
    b.style.left = Math.min(ar.width - 260, Math.max(8, r.left - ar.left)) + 'px';
    b.style.top = (r.bottom - ar.top + 6) + 'px';
    b.querySelector('.close').onclick = async () => {
      b.remove();
      const d = (await getSetting('dismissedHints', [])) || [];
      if (!d.includes(key)) await setSetting('dismissedHints', [...d, key]);
    };
    app.appendChild(b);
  }, 350);
}

/* ---------- 首次启动向导（三步，§4.8.13.1） ---------- */
// 🔴 每一步都必须「能被关掉」：点 ×、点遮罩、按安卓返回键都算结束这一步。
// 若只认「下一步」按钮，boot 里的 await 会永远不返回 → 主界面停在空壳（已实测复现）。
// 中途退出只是本次不再引导（不写 onboarded），下次打开会重新弹。
function wizardStep(opts) {
  let settled = false, finish;
  const done = new Promise(res => { finish = res; });
  const ui = openPicker({ ...opts, onClose: () => { if (!settled) { settled = true; finish(false); } } });
  const next = () => { if (!settled) { settled = true; ui.close(); finish(true); } };
  return { ui, done, next };
}

async function maybeOnboard() {
  if (await getSetting('onboarded', false)) return;
  const students = await listStudents(state.db, { includeOut: true });
  if (students.length) { await setSetting('onboarded', true); return; }

  const s1 = wizardStep({
    title: '① 基本设置',
    body: `<div style="padding:16px">
      <div class="field"><label>教师姓名</label><input class="ta" id="ob-tname" value="${esc(state.settings.teacherName || '')}" placeholder="如：李老师 / 李明"></div>
      <div class="field"><label>学期名称</label><input class="ta" id="ob-name" value="${esc(state.semester?.name || '')}"></div>
      <div class="field"><label>起始日期</label><input class="ta" type="date" id="ob-start" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="save-note">教师姓名用于顶栏头像与备份设备名，稍后可在「设置」里改；一学期一个独立数据库，期末归档后手机不留旧数据。</div>
    </div>`,
    foot: `<button class="btn" id="ob-1">下一步</button>`
  });
  s1.ui.foot.querySelector('#ob-1').onclick = async () => {
    const tname = (s1.ui.body.querySelector('#ob-tname').value || '').trim();
    if (tname) {
      await setSetting('teacherName', tname);
      state.settings.teacherName = tname;
      const av = document.getElementById('sem-avatar');
      if (av) { av.textContent = teacherInitial() || AVATAR_EMPTY; av.title = avatarTitle(); }
    }
    const name = s1.ui.body.querySelector('#ob-name').value.trim() || state.semester?.name;
    const start = s1.ui.body.querySelector('#ob-start').value;
    const sem = { ...state.semester, name, startAt: start ? new Date(start).getTime() : Date.now() };
    await meta.semesters.put(sem); state.semester = sem;
    const n = document.getElementById('sem-name'); if (n) n.textContent = name;
    s1.next();
  };
  if (!await s1.done) return;

  const s2 = wizardStep({
    title: '② 录名单',
    lead: '把你的班级名单粘贴进来，每行一个姓名。之后随时可在「数据 → 管理名单」里增删。',
    body: `<div style="padding:16px">
      <textarea class="ta" id="ob-names" rows="6" placeholder="张梓涵&#10;李思远&#10;王雨欣"></textarea>
    </div>`,
    foot: `<button class="btn ghost" id="ob-skip">暂时跳过</button><button class="btn" id="ob-2">导入名单</button>`
  });
  s2.ui.foot.querySelector('#ob-skip').onclick = () => s2.next();
  s2.ui.foot.querySelector('#ob-2').onclick = async () => {
    const names = (s2.ui.body.querySelector('#ob-names').value || '')
      .split('\n').map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 4);
    if (names.length) {
      await bulkPutStudents(state.db, names.map((n, i) => ({ id: 's' + Date.now().toString(36) + i, name: n, pinyin: nameInitials(n), out: 0, del: 0 })));
      toast(`已导入 ${names.length} 人`);
    }
    s2.next();
  };
  if (!await s2.done) return;

  const s3 = wizardStep({
    title: '③ 完成',
    body: `<div style="padding:20px 16px;line-height:1.9">
      <div class="kv" style="border:none"><span>① 数据只存这台手机</span><b>不联网、不上传</b></div>
      <div class="kv"><span>② 建议每周导出备份</span><b>手机会丢、系统会清</b></div>
      <div class="kv"><span>③ 期末归档存电脑/网盘</span><b>手机上不留旧数据</b></div>
      <div class="kv"><span>④ 要发给 AI 的内容</span><b>走「AI 评语素材」，姓名自动换成代号</b></div>
      <div class="save-note">数据保存在本机浏览器，不会自动上传；清缓存或换设备前记得先导出备份。</div>
    </div>`,
    foot: `<button class="btn" id="ob-3">开始使用</button>`
  });
  s3.ui.foot.querySelector('#ob-3').onclick = async () => { await setSetting('onboarded', true); s3.next(); };
  await s3.done;
}

/* ---------- 更新提示 UI（§4.3）：prompt 语义，新 SW 等用户点「立即更新」才接管 ---------- */
let swReg = null;
let waitingSw = null;        // 已安装、等待激活的新 SW

function markUpdate() {       // 页脚「检查更新」变橙 + 小圆点
  const btn = document.getElementById('dt-check-update');
  if (btn) btn.classList.add('has-update');
}
function showUpdateMask() {
  const m = document.getElementById('updateMask');
  if (m) m.classList.add('show');
}
async function setupUpdate() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // 🔴 updateViaCache:'none' —— 向浏览器明确：检查 SW 更新时永不走 HTTP 缓存。
    // （现代浏览器默认已是这个语义，显式声明可挡掉「服务器给了长 max-age 就检查不到新版本」）
    swReg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  } catch { return; }
  if (swReg.waiting) { waitingSw = swReg.waiting; markUpdate(); }
  swReg.addEventListener('updatefound', () => {
    const installing = swReg.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // 新 SW 装好且当前已有旧 controller → 进入 waiting，标橙点（不自动刷新）
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        waitingSw = installing; markUpdate();
      }
    });
  });
  // 新 SW 接管后强制重载，拿到最新代码
  navigator.serviceWorker.addEventListener('controllerchange', () => { window.location.reload(); });
}
async function checkForUpdate() {
  if (!swReg) { toast('已是最新版本'); return; }
  try { await swReg.update(); } catch {}
  if (swReg.waiting) { waitingSw = swReg.waiting; showUpdateMask(); }
  else if (navigator.serviceWorker.controller) toast('已是最新版本');
  else toast('正在初始化更新…');
}
async function applyUpdate() {
  flushDraft();                                   // 🔴 先 flush 未保存草稿，避免录入中途被刷新丢字
  const m = document.getElementById('updateMask'); if (m) m.classList.remove('show');
  const target = waitingSw || (swReg && swReg.waiting);
  if (target) target.postMessage({ type: 'SKIP_WAITING' });
  // controllerchange 会触发 reload；兜底：无 controllerchange 时也 reload
  setTimeout(() => { if (navigator.serviceWorker.controller) window.location.reload(); }, 1000);
}

/* ---------- 启动失败兜底页（绝不清空数据） ---------- */
// 🔴 三种故障给三个出口：数据比代码新→升级；存储被禁→允许存储；真损坏→先导出再决定。
//    三种都**不再自动删库** —— 删的是唯一正本，而删库对前两种故障根本无效。
const BOOT_ERR = {
  [DB_ERR_NEWER]: {
    ic: '⬆️', tone: '#b26a00', title: '本地数据比当前代码新',
    body: '这台设备上的数据是用<b>更新版本</b>的代码写入的，当前这份代码读不了它。<br>请升级到最新版再打开 —— <b>不要清空数据</b>。'
  },
  [DB_ERR_BLOCKED]: {
    ic: '🔒', tone: '#b26a00', title: '浏览器不允许本站保存数据',
    body: '常见于无痕 / 隐私模式，或站点数据被拦截。<br>请允许本站存储后重试 —— 这时清空数据没有意义（清完照样打不开）。'
  },
  [DB_ERR_CORRUPT]: {
    ic: '⚠️', tone: 'var(--danger)', title: '本地数据读取异常',
    body: '已尽力把还能读出来的内容抢救到本机备份。<br>请<b>先打开「数据导出页」把数据存成文件</b>，再决定是否重建。'
  }
};
function renderBootError(app, e) {
  const kind = (e && e.kind) || classifyDbError(e);
  const m = BOOT_ERR[kind] || BOOT_ERR[DB_ERR_CORRUPT];
  app.innerHTML = `<div class="boot" style="text-align:center;padding:32px 20px;color:${m.tone}">
    <div style="font-size:32px;margin-bottom:12px">${m.ic}</div>
    <div style="font-size:var(--fs-lg);font-weight:600;margin-bottom:10px">${m.title}</div>
    <div style="color:var(--txt2);line-height:1.7">${m.body}</div>
    <div style="color:var(--txt2);margin-top:10px;font-size:var(--fs-xs)">技术信息：${esc((e && e.message) || e)}</div>
    <button id="boot-recover" class="btn" style="margin-top:16px">打开数据导出页</button>
    <button id="boot-retry" class="btn" style="margin-top:10px">重试</button>
    <button id="boot-reset" class="btn danger" style="margin-top:22px">清空本地数据并重建</button>
    <span style="color:var(--txt2);display:block;margin-top:8px">只有在数据确实读不出时才用它：会删除本机全部内容，且不可恢复。</span>
  </div>`;
  document.getElementById('boot-recover').onclick = () => { location.href = './recover.html'; };
  document.getElementById('boot-retry').onclick = () => location.reload();
  document.getElementById('boot-reset').onclick = hardReset;
}

// 🔴 全机唯一的删库入口：必须「显式点击 + 二次确认（确认框 + 手动输入）」——不能一点就没
async function hardReset() {
  if (!confirm('清空本机数据会删除全部学生与成长记录，且无法恢复。\n\n请先确认：已导出备份，或用「数据导出页」把数据存成文件。\n\n仍要清空吗？')) return;
  const typed = prompt('这是最后一步：请输入「清空」两个字确认。');
  if (((typed || '').trim()) !== '清空') { alert('输入不匹配，已取消。'); return; }
  try {
    const DX = window.Dexie;
    for (const n of await appDbNames()) { try { await DX.delete(n); } catch (_) {} }
    location.reload();
  } catch (err) { alert('清空失败：' + ((err && err.message) || err)); }
}
// 🔴 库名必须枚举全：只删 bzr_meta 会把学期库留成「看不见但占空间」的孤儿库
//    （meta 打不开时 listSemesters 读不到学期 id，所以再补一层浏览器自己的库列表）
async function appDbNames() {
  const out = new Set(['bzr_meta', 'bzr_rescue']);
  try { (await listSemesters()).forEach(s => { if (s && s.id) out.add('bzr_' + s.id); }); } catch (_) {}
  try {
    const ds = indexedDB.databases ? await indexedDB.databases() : [];
    (ds || []).forEach(d => { const n = d && d.name; if (n && n.startsWith('bzr_')) out.add(n); });
  } catch (_) {}
  return [...out];
}

/* ---------- 启动 ---------- */
async function boot() {
  const app = document.getElementById('app');
  try {
    const sem = await ensureCurrentSemester();
    await loadSettings();
    shell();
    document.getElementById('sem-name').textContent = sem.name;
    // 🔴 SW 注册放在首次向导之前：老师首装时若中途关掉向导，也照样拿到离线能力与「检查更新」
    setupUpdate();
    // 🔴 换网址风险告警（§13.7.1 / §4.3）：记录首次 origin，网址一旦变化即提醒导入备份
    try {
      const expect = EXPECTED_ORIGIN || (await getSetting('deployOrigin', ''));
      if (!expect) await setSetting('deployOrigin', location.origin);
      else if (expect !== location.origin) {
        banner('originBanner',
          `⚠️ 当前网址（${esc(location.origin)}）与首次使用时（${esc(expect)}）不一致，<b>旧数据可能不可见</b>。若是迁移，请先在「数据 → 备份与恢复」导出旧网址备份，再到此处导入。`,
          'warn');
      }
    } catch (_) {}
    // 🔴 持久化存储：启动只「读」当前状态，绝不在启动时申请（§4.8.18）。
    //    persist() 在 Chromium 上不弹授权框、只按浏览器自己的规则直接返回结果，启动时静默调用等于
    //    白白消耗这次判定；Firefox 更要求用户手势才可能授予。真正的申请入口在「设置 → 存储持久化」，
    //    由点击手势发起。顺手接管「装到主屏」提示，手机上有它才好一次拿到长期保存。
    captureInstallPrompt();
    state.settings.persisted = await readPersisted();
    await housekeeping();
    await autoBackupMaybe();                 // 🔴 开 app 即自动留一份本机快照（与业务库隔离）
    await maybeOnboard();
    switchTab('record');
    await backupBanner();
    // 🔴 打开失败抢救横幅：bzr_rescue 里有 rescue 快照说明上次 open 失败被救下，提示老师下载/恢复
    try {
      const rescues = await listSnaps('rescue');
      if (rescues.length) {
        banner('rescueBanner', `⚠️ 检测到上次打开失败，已自动抢救出 <b>${rescues.length}</b> 份旧数据，可下载或恢复。<span class="chip" id="rs-view">查看</span>`, 'warn');
        const chip = document.getElementById('rs-view');
        if (chip) chip.onclick = () => openSnapList('抢救数据', rescues, 'no');
      }
    } catch (_) {}
    // 🔴 备份库打不开时静默降级了（不再删库重建）：必须提醒老师手动导出，别以为"一直在备份"
    try {
      const re = rescueError();
      if (re) banner('rescueBrokenBanner', `⚠️ 本机自动备份暂时不可用（${esc(re.name || '存储异常')}），<b>请到「数据 → 备份与恢复」手动导出</b>一份。`, 'warn');
    } catch (_) {}
    // 🔴 定时 + 切回前台 自动快照（最小间隔 6h，在 autoBackupMaybe 内节流）
    setInterval(() => autoBackupMaybe(), 15 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) autoBackupMaybe(); });
  } catch (e) {
    // 🔴 启动失败兜底页（绝白屏）：按故障类型给不同出口，**绝不自动清空数据**（§13.25）
    renderBootError(app, e);
    return;
  }
  // 🔴 预览参数：?newversion=1 强制弹出更新窗，便于本地验证更新 UI（§4.3）
  if (new URLSearchParams(location.search).get('newversion') === '1') showUpdateMask();
}

boot();
