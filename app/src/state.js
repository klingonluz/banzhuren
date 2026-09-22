// 应用级状态：当前学期、设置、数据层句柄
import { meta, getSetting, setSetting, listSemesters, ensureSemester, openMeta } from './db/meta.js';
import { openSemester, ensureOpen, backfillPinyin } from './db/semester.js';
import { seedTaxonomy, seedBaseline } from './db/seed.js';

export const state = {
  currentSemesterId: null,
  semester: null,
  db: null,
  // 设备级设置（存 bzr_meta/settings）
  settings: {
    fontSize: 'std',      // std 15 / big 17 / huge 19
    afterSave: 'keep',    // keep 保留当前学生 / clear 完全清空
    tlMode: 'card',       // list 缩略图 / card 卡片 / cpt 紧凑
    tlPage: 20,           // TIMELINE_PAGE_SIZE
    remind: 'weekly',     // weekly / biweekly / off
    recycleDays: 30,
    teacherName: '',        // 🔴 教师姓名：顶栏头像取首字；同时作为设备名的默认前缀（首装留空，由向导/设置引导填写，不预置假名）
    persisted: false,
    lastExport: null,
    defaultCat: '能力感知力',   // 极速记录默认选中的能力分类（V11.1 本版变更）
    autoComment: false,       // 选标签时是否自动填充预设评语（默认关，避免臃肿；需要再开）
    classWeekSplit: 'off'     // 班级课表是否分单双周：off 统一课表 / on 单双周轮换
  },
  listeners: new Set()
};

export function onChange(fn) { state.listeners.add(fn); }
export function emit() { state.listeners.forEach(fn => fn()); }
export function refresh() { emit(); }

// 🔴 字号靠 --fs-* 五个 CSS 变量挂在 :root，立即生效、无需重启（§4.8.18 ①-5）
const FS = {
  std:  { base: '15px', sm: '13px', xs: '12px', lg: '17px', xl: '22px' },
  big:  { base: '17px', sm: '15px', xs: '13px', lg: '19px', xl: '24px' },
  huge: { base: '19px', sm: '17px', xs: '14px', lg: '21px', xl: '26px' }
};
export function applyFontSize() {
  const f = FS[state.settings.fontSize] || FS.std;
  const s = document.documentElement.style;
  s.setProperty('--fs-base', f.base);
  s.setProperty('--fs-sm', f.sm);
  s.setProperty('--fs-xs', f.xs);
  s.setProperty('--fs-lg', f.lg);
  s.setProperty('--fs-xl', f.xl);
}

export async function loadSettings() {
  const s = state.settings;
  s.fontSize = await getSetting('fontSize', 'std');
  s.afterSave = await getSetting('afterSave', 'keep');
  s.tlMode = await getSetting('tlMode', 'card');
  s.tlPage = await getSetting('tlPage', 20);
  s.remind = await getSetting('remind', 'weekly');
  s.recycleDays = await getSetting('recycleDays', 30);
  s.teacherName = await getSetting('teacherName', '');
  s.lastExport = await getSetting('lastExport', null);
  s.defaultCat = await getSetting('defaultCat', '能力感知力');
  s.autoComment = await getSetting('autoComment', false);
  s.classWeekSplit = await getSetting('classWeekSplit', 'off');
  applyFontSize();
}

export async function saveSetting(key, value) {
  state.settings[key] = value;
  await setSetting(key, value);
  if (key === 'fontSize') applyFontSize();
}

/* ---------- 教师姓名 ⇄ 顶栏头像 ⇄ 设备名 联动（单一数据源，绝不写死） ---------- */
// 🔴 头像文字与设备名都从 teacherName 派生：老师只填一次姓名，头像首字 / 设备名自动跟上
export function teacherInitial() {
  const n = (state.settings.teacherName || '').trim();
  return n ? n.slice(0, 1) : '';         // 🔴 未填姓名返回空串（头像由 UI 层显示「＋」占位），不再写死「师」
}
// 设备名自动值：`本班班级名 · 姓名手机`（识别本机备份用）；未填姓名时退回班级名
// 🔴 班级取课表本班名（homeroom.name），与教师姓名同源：改任一即同步到设备名
export function autoDeviceName(sched) {
  const n = (state.settings.teacherName || '').trim();
  const cls = (sched && sched.homeroom && sched.homeroom.name) || state.semester?.name || '本班';
  return n ? `${cls} · ${n}手机` : cls;
}
// 实际生效的设备名：始终直接由「本班班级 + 教师姓名」派生（设备名无需手动修改，避免与联动逻辑冲突）；与课表本班 / 教师姓名同源
export function effectiveDeviceName(sched) {
  return autoDeviceName(sched);
}

export function setSemester(semester) {
  state.semester = semester;
  state.currentSemesterId = semester.id;
  state.db = openSemester(semester.id);
}

// 首次启动：确保存在当前学期（没有则按当前学年新建一个）
// 🔴 空库只补「基线」（标签体系 + 空课表），绝不含任何样例 / 临时数据。
export async function ensureCurrentSemester() {
  await openMeta();                       // 🔴 旧 meta 结构不兼容 → 重建（防止 SchemaError 崩到兜底页）
  let sems = await listSemesters();
  let cur = await getSetting('currentSemester', null);
  let sem = sems.find(s => s.id === cur);
  if (!sem) sem = sems.find(s => s.status === 'active');
  if (!sem) sem = sems[0];
  if (!sem) {
    const now = new Date();
    const y = now.getFullYear();
    sem = {
      id: 'sem_' + y + '_' + (now.getMonth() >= 7 ? '1' : '2'),
      name: `${y}-${y + 1} 学年 ${now.getMonth() >= 7 ? '第一' : '第二'}学期`,
      startAt: Date.now(), status: 'active'
    };
    await ensureSemester(sem);
  }
  setSemester(sem);
  state.db = await ensureOpen(state.db, sem.id);   // 🔴 旧学期库不兼容 → 升级或删库重建（返回可用实例）
  await seedTaxonomy(state.db);                    // 幂等补「正面管教标签体系」（迁移/全新都安全）
  // 🔴 空库只补「基线」：标签体系 + 空课表，不含任何学生 / 记录（老师自己录名单、自己排课）。
  if (!(await state.db.students.count())) await seedBaseline(state.db);
  // 🔴 补齐拼音首字母（手工改过的跳过；已一致的跳过）
  await backfillPinyin(state.db);
  await setSetting('currentSemester', sem.id);
  return sem;
}

export async function listAllSemesters() {
  return await listSemesters();
}

/* ---------- 存储持久化（§4.8.18）----------
   🔴 Chromium 的 persist() 不弹任何授权框，只按浏览器自己的规则直接返回结果
      （已装到主屏 / 已收藏 / 允许通知 / 长期常访问 才可能给）；Safari（iOS）根本没有该接口。
      所以必须能先判定「本机有没有」，再决定是申请还是直接给替代办法。 */
export function persistSupported() {
  try { return !!(navigator.storage && navigator.storage.persist); } catch (_) { return false; }
}
// 🔴 启动只「读」当前状态，绝不在启动时申请：申请必须落在用户点击手势里（Firefox 尤其要求）
export async function readPersisted() {
  try {
    if (!persistSupported()) return false;
    return !!(await navigator.storage.persisted());
  } catch (_) { return false; }
}
// 申请长期保存；拿到与否都回写 state.settings.persisted，供设置页徽标即时刷新
export async function requestPersist() {
  try {
    if (!persistSupported()) return false;
    const ok = !!(await navigator.storage.persist());
    state.settings.persisted = ok || await readPersisted();
    return state.settings.persisted;
  } catch (_) { return !!state.settings.persisted; }
}

/* ---------- 「装到主屏」提示（beforeinstallprompt）----------
   🔴 装到主屏是拿到长期保存最有效的路径，但浏览器只在该事件触发时允许主动弹窗，
      所以启动时先「接住」它，等老师点「添加到主屏」时再放出来。 */
let installEvent = null;
export function captureInstallPrompt() {
  try {
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; });
  } catch (_) { }
}
export function canInstall() { return !!installEvent; }
export async function promptInstall() {
  if (!installEvent) return false;
  try {
    installEvent.prompt();
    const r = await installEvent.userChoice;
    installEvent = null;
    return !!(r && r.outcome === 'accepted');
  } catch (_) { installEvent = null; return false; }
}
