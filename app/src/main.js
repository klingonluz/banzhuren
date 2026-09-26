// 主入口：启动 → 状态栏 / 顶栏 / Banner 区 / 四 Tab 路由 / PWA
// 布局对齐 ui_prototype.html（方案 §4.8.3）
import {
  state, ensureCurrentSemester, loadSettings, setSemester, refresh, applyFontSize, onChange, teacherInitial,
  readPersisted, captureInstallPrompt
} from './state.js';
import { getSetting, setSetting, meta, listSemesters } from './db/meta.js';
import { openSemester, listStudents, bulkPutStudents } from './db/semester.js';
import { nameInitials } from './pinyin.js';
import { el, esc, toast, banner, openPicker } from './ui.js';
import { mount as mountRecord } from './tabs/record.js';
import { mount as mountClass } from './tabs/class.js';
import { mount as mountAnalysis } from './tabs/analysis.js';
import { mount as mountData, housekeeping, quickBackup, openSettings, openSemesters, switchSemester, openSnapList, openImportPack } from './tabs/data.js';
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
const APP_VER = 'v1.6.4';
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
      <div class="avatar" id="sem-avatar" role="button" tabindex="0" aria-label="学期与姓名菜单" title="${esc(avatarTitle())}">${esc(teacherInitial() || AVATAR_EMPTY)}</div>
    </div>
    <div class="banners" id="banners"></div>
    <div class="sem-pop" id="sem-pop"></div>
    <div class="scroll" id="scroll"></div>
    <div class="footer" id="footer">
      <span class="ver">版本 ${esc(APP_VER)}</span>
    </div>
    <div class="tabbar" id="tabbar">
      ${TABS.map(t => `<button class="tab" data-tab="${t.key}"><span class="ic">${t.ic}</span>${t.label}</button>`).join('')}
    </div>`;
  app.querySelector('#tabbar').onclick = e => {
    const b = e.target.closest('.tab'); if (!b) return;
    switchTab(b.dataset.tab);
  };
  // 🔴 头像入口可键盘操作（P2-6）：它是「改姓名 / 切学期」的唯一入口，只认鼠标点不合适
  const avatarBtn = app.querySelector('#sem-avatar');
  avatarBtn.onclick = toggleSemPop;
  avatarBtn.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSemPop(); } };
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
  // 🔴 只列「在用」的学期：已归档 / 本机已清除的不出现在切换器里（归档学期不在本应用内打开，见方案 §2.4）
  const usable = sems.filter(s => s.status !== 'cleared' && s.status !== 'archived');
  const hidden = sems.length - usable.length;
  // 🔴 头像文字来自「教师姓名」设置：这里给个直达入口，点一下就能改
  const hasName = !!(state.settings.teacherName || '').trim();
  pop.innerHTML = `<div class="opt tn" data-tname="1">👤 ${esc(hasName ? state.settings.teacherName + ' · 修改姓名 / 头像' : '设置姓名 / 头像')}</div>`
    + usable.map(s =>
      `<div class="opt ${s.id === state.currentSemesterId ? 'on' : ''}" data-id="${s.id}">${esc(s.name)}</div>`
    ).join('')
    + (hidden ? `<div class="opt" data-cabinet="1">🏛️ ${hidden} 个已归档学期 · 去档案柜</div>` : '')
    + `<div class="opt" data-manage="1">⚙️ 管理学期…</div>`;
  pop.classList.add('show');
  pop.onclick = async e => {
    const opt = e.target.closest('.opt'); if (!opt) return;
    pop.classList.remove('show');
    if (opt.dataset.tname) { openSettings(); return; }
    // 🔴 「管理学期…」现在真的把学期管理弹层打开（旧版只跳 Tab 就结束，是个空操作）
    if (opt.dataset.manage) { switchTab('data'); openSemesters(); return; }
    if (opt.dataset.cabinet) { switchTab('data'); return; }
    const s = sems.find(x => x.id === opt.dataset.id);
    if (!s || s.id === state.currentSemesterId) return;
    // 🔴 统一走 switchSemester：它会把其他在用学期置为 inactive，避免出现多个 active
    await switchSemester(s); refresh();
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
    analysis: { anchor: '#an-ai', text: '要发给 AI 就用「AI 评语素材」：姓名换代号，分数名次日期自动隐去，照片不参与。' },
    data:   { anchor: '#dt-backup', text: '定期导出备份是唯一的保险；给家长看的材料用「成长记录文本」。' },
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
      <div class="save-note">教师姓名用于顶栏头像与备份设备名，稍后可在「设置」改。</div>
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
    lead: '每行一个姓名；之后可在「数据 → 管理名单」增删。',
    body: `<div style="padding:16px">
      <textarea class="ta" id="ob-names" rows="6" placeholder="张梓涵&#10;李思远&#10;王雨欣"></textarea>
    </div>`,
    foot: `<button class="btn ghost" id="ob-skip">跳过</button><button class="btn" id="ob-2">导入名单</button>`
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
    </div>`,
    foot: `<button class="btn" id="ob-3">开始使用</button>`
  });
  s3.ui.foot.querySelector('#ob-3').onclick = async () => { await setSetting('onboarded', true); s3.next(); };
  await s3.done;
}

/* ---------- Service Worker 注册（离线能力 + 新 SW 接管后自动重载） ---------- */
// 🔴 更新入口已整合到「设置 → 刷新到最新版」：这里只负责注册与「新 SW 接管即重载」
async function setupUpdate() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // 🔴 updateViaCache:'none' —— 向浏览器明确：检查 SW 更新时永不走 HTTP 缓存。
    // （现代浏览器默认已是这个语义，显式声明可挡掉「服务器给了长 max-age 就检查不到新版本」）
    await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  } catch { return; }
  // 新 SW 接管后强制重载，拿到最新代码
  navigator.serviceWorker.addEventListener('controllerchange', () => { window.location.reload(); });
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
    // 🔴 SW 注册放在首次向导之前：老师首装时若中途关掉向导，也照样拿到离线能力
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
    // 🔴 v1.5.0：原「定时 + 切回前台自动快照」已删除（理由见 tabs/data.js 的 rescueCard 上方注释）。
    //    编辑中途被打断由记录页草稿机制兜底（localStorage，输入即存），比快照及时得多。
  } catch (e) {
    // 🔴 启动失败兜底页（绝白屏）：按故障类型给不同出口，**绝不自动清空数据**（§13.25）
    renderBootError(app, e);
    return;
  }
}

boot();
