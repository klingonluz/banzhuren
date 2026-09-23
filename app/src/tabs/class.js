// 班务 Tab：① 今日课表 ② 周课表 ③ 作息时间表 ④ 收缴（建单 + 点名，无催缴）
// V11.1：收缴 = collections（临时态，不进备份）；课表 / 收缴功能保留（本版变更 #16）
// 课表模型：本班课表 homeroom（班主任只负责一个班，单一固定，无班级选择）+ 我的课表 mine（跨班自填，每格 {subject,cls}）+ 授课班级 teachClasses（跨班任教）+ 自定义科目 customSubjects
import { state } from '../state.js';
import { listStudents, listCollections, putCollection, deleteCollection, getSchedule, saveSchedule } from '../db/semester.js';
import { esc, toast, openPicker, emptyState, confirm, onSeg, filterStudents } from '../ui.js';

const DAYS = ['周一', '周二', '周三', '周四', '周五'];
const SUBJECTS = ['语文', '数学', '英语', '科学', '体育', '音乐', '美术', '信息', '劳技', '阅读', '班会', '自习', ''];

let schedMode = 'class';      // class | mine
let season = 'summer';        // summer | winter

const pad = n => String(n).padStart(2, '0');
function todayInfo() {
  const d = new Date();
  const wd = d.getDay();                 // 0=周日
  const dayIdx = wd >= 1 && wd <= 5 ? wd - 1 : 0;
  return { dayIdx, dateStr: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, dayName: DAYS[dayIdx], wd };
}
function weekNo() {
  const start = state.semester?.startAt ? new Date(state.semester.startAt) : null;
  if (!start) return 1;
  const diff = Math.floor((Date.now() - start.getTime()) / 86400000);
  return Math.max(1, Math.floor(diff / 7) + 1);
}
function periodTime(p) { return season === 'summer' ? (p.summer || '') : (p.winter || p.summer || ''); }
function inPeriod(p) {
  const t = periodTime(p);
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(t || '');
  if (!m) return false;
  const now = new Date(), cur = now.getHours() * 60 + now.getMinutes();
  return cur >= (+m[1]) * 60 + (+m[2]) && cur <= (+m[3]) * 60 + (+m[4]);
}
function typeBadge(p) {
  if (p.type === 'tutor') return { cls: 'tu', txt: '辅' };
  if (p.type === 'break') return { cls: 'br', txt: '休' };
  if (p.type === 'service') return { cls: 'sv', txt: '服' };
  return { cls: '', txt: String(p.no || '·') };
}
// 单双周：设置开关 + 当前周奇偶
function useSplit() { return state.settings.classWeekSplit === 'on'; }
function parity() { return weekNo() % 2 === 1 ? 'odd' : 'even'; }   // 单数周→单周(odd)，双数周→双周(even)
function weekParityLabel() { return parity() === 'odd' ? '单周' : '双周'; }

/* ---------- 数据模型归一化（兼容旧库：root weekly / classes[] → 本班 + 授课班级） ---------- */
function normalizeWeekly(weekly, nPer) {
  const w = [];
  for (let d = 0; d < 5; d++) {
    const row = (weekly && weekly[d]) ? [...weekly[d]] : [];
    while (row.length < nPer) row.push('');
    if (row.length > nPer) row.length = nPer;
    w.push(row);
  }
  return w;
}
// 我的课表单元格：{subject, cls} 或 null（空 = 该节不排我的课）
function normalizeMine(weekly, nPer) {
  const w = [];
  for (let d = 0; d < 5; d++) {
    const row = (weekly && weekly[d]) ? weekly[d].slice() : [];
    while (row.length < nPer) row.push(null);
    if (row.length > nPer) row.length = nPer;
    w.push(row.map(c => (c && (c.subject || c.cls)) ? { subject: c.subject || '', cls: c.cls || '' } : null));
  }
  return w;
}
function flattenMine(weekly) {
  const out = [];
  (weekly || []).forEach(row => (row || []).forEach(c => { if (c) out.push(c); }));
  return out;
}
function normalizeSched(sched, semester) {
  sched = sched || {};
  if (!Array.isArray(sched.periods)) sched.periods = [];
  const nPer = sched.periods.length;
  const hn = semester?.name || '本班';
  // 本班课表：班主任只负责本班，单一固定，无班级选择
  let homeroom;
  if (sched.homeroom && sched.homeroom.weekly) {
    homeroom = { name: sched.homeroom.name || hn, weekly: sched.homeroom.weekly };
  } else if (Array.isArray(sched.classes) && sched.classes[0]) {
    // 🔴 旧库：classes[0] 即本班
    homeroom = { name: sched.classes[0].name || hn, weekly: sched.classes[0].weekly || [] };
  } else {
    homeroom = { name: hn, weekly: sched.weekly || [] };
  }
  homeroom.name = homeroom.name || hn;
  homeroom.weekly = normalizeWeekly(homeroom.weekly, nPer);
  // 双周课表：旧库无 weeklyEven → 默认复制单周（避免开启单双周后双周空表）
  if (!Array.isArray(homeroom.weeklyEven) || !homeroom.weeklyEven.length) homeroom.weeklyEven = homeroom.weekly.map(r => [...r]);
  else homeroom.weeklyEven = normalizeWeekly(homeroom.weeklyEven, nPer);
  // 我的课表：独立自填表（每格 {subject, cls}|null）
  if (!sched.mine || !Array.isArray(sched.mine.weekly)) sched.mine = { weekly: [] };
  sched.mine.weekly = normalizeMine(sched.mine.weekly, nPer);
  // 授课班级（跨班）：供「我的课表」每节选班级。默认含本班 + 旧库跨班班 + 已用班级
  const tc = new Map();
  tc.set('main', { id: 'main', name: homeroom.name });
  if (Array.isArray(sched.classes)) sched.classes.slice(1).forEach(c => tc.set(c.id || c.name, { id: c.id || c.name, name: c.name }));
  (sched.teachClasses || []).forEach(c => tc.set(c.id || c.name, { id: c.id || c.name, name: c.name }));
  flattenMine(sched.mine.weekly).forEach(c => { if (c && c.cls && !tc.has(c.cls)) tc.set(c.cls, { id: c.cls, name: c.cls }); });
  sched.teachClasses = [...tc.values()];
  if (!Array.isArray(sched.customSubjects)) sched.customSubjects = [];
  delete sched.classes;
  delete sched.weekly;
  delete sched.mineSubject;
  sched.homeroom = homeroom;
  return sched;
}
function allSubjects(sched) {
  return [...SUBJECTS.filter(Boolean), ...(sched.customSubjects || [])];
}

/* ================= ① 今日课表 ================= */
function todayListHTML(sched) {
  const { dayIdx } = todayInfo();
  const periods = sched?.periods || [];
  const rows = periods.map(p => {
    const b = typeBadge(p);
    const now = inPeriod(p);
    const ro = p.type && p.type !== 'class' && p.type !== 'service';
    if (schedMode === 'mine') {
      // 我的课表：单张自填表，单元格 = {subject, cls}；空格=该节无课
      const cell = (sched.mine?.weekly?.[dayIdx]?.[periods.indexOf(p)]) || null;
      if (!cell || !cell.subject) return '';
      return `<div class="sch-row ${now ? 'now' : ''}">
        <div class="sch-p ${b.cls} ${now ? 'now' : ''}">${esc(b.txt)}</div>
        <div class="sch-t">${esc(periodTime(p))}</div>
        <div class="sch-s">${esc(cell.subject)}${cell.cls ? `<span class="sch-cls">${esc(cell.cls)}</span>` : ''}</div>
        <span class="sch-mine">我的课</span>
      </div>`;
    }
    // 本班课表（班主任单一固定班，无班级选择）；分单双周时按当前周奇偶取对应课表
    const hsrc = useSplit() ? (parity() === 'odd' ? sched.homeroom?.weekly : sched.homeroom?.weeklyEven) : sched.homeroom?.weekly;
    const course = ro ? (p.name || '') : ((hsrc?.[dayIdx]?.[periods.indexOf(p)]) || '');
    return `<div class="sch-row ${now ? 'now' : ''}">
      <div class="sch-p ${b.cls} ${now ? 'now' : ''}">${esc(b.txt)}</div>
      <div class="sch-t">${esc(periodTime(p))}</div>
      <div class="sch-s">${esc(course || (p.type === 'class' ? '—' : p.name))}</div>
    </div>`;
  }).join('');
  return rows || '<div class="empty">今天没有课 🎉</div>';
}

function scheduleCard(sched) {
  const { dateStr, dayName } = todayInfo();
  const splitTag = useSplit() ? ` · <b style="color:var(--primary)">${weekParityLabel()}</b>` : '';
  return `
  <div class="card">
    <h2>📅 今日课表 <span class="muted" style="font-weight:400;font-size:12px">${esc(dateStr)} ${dayName} · 第${weekNo()}周${splitTag}</span></h2>
    <div class="seg" id="cl-season" style="margin-bottom:8px">
      <button data-v="summer" class="${season === 'summer' ? 'on' : ''}">夏季作息</button>
      <button data-v="winter" class="${season === 'winter' ? 'on' : ''}">冬季作息</button>
    </div>
    <div class="seg" id="cl-mode" style="margin-bottom:10px">
      <button data-v="class" class="${schedMode === 'class' ? 'on' : ''}">本班课表</button>
      <button data-v="mine" class="${schedMode === 'mine' ? 'on' : ''}">我的课表</button>
    </div>
    ${schedMode === 'class'
      ? `<div class="muted" style="margin:6px 0 2px">本班（${esc(sched.homeroom?.name || '本班')}）课表，直接编辑即可。${useSplit() ? `当前显示<b>${weekParityLabel()}</b>课表。` : ''}</div>`
      : `<div class="muted" style="margin:6px 0 2px">空格子 = 该节没我的课；点格子填<b>科目</b>和<b>班级</b>。</div>`}
    <div id="cl-today">${todayListHTML(sched)}</div>
    ${schedMode === 'mine' ? `<button class="btn ghost mt" id="cl-classes">🏫 授课班级（跨班）</button>` : ''}
    <button class="btn ghost mt" id="cl-week">查看 / 编辑${schedMode === 'mine' ? '我的课表' : '本班课表'}</button>
    <button class="btn ghost mt" id="cl-sched">作息时间表（可编辑）</button>
    <div class="save-note">切换夏/冬作息，<strong>课程不变、时间自动跟随</strong>。本班课表 = 你当班主任的那个班（固定）；「我的课表」是<b>空表</b>，自己填科目与班级。</div>
  </div>`;
}

/* ---- 科目 chips：两处（周课表单选 / 我的课表「科目+班级」）共用，避免副本各改一半（P2-4） ---- */
const PROMPT_SUBJECT = '自定义科目名称（如：校本 / 心理 / 写字）';
// 选中态由调用方通过 cur 传入；末尾两项是「＋ 自定义科目」「（清空）」
function subjectChipsHTML(all, cur) {
  return all.map(s => `<span class="chip ${s === cur ? 'on' : ''}" data-s="${esc(s)}">${esc(s)}</span>`).join('')
    + '<span class="chip" data-custom="1">＋ 自定义科目</span><span class="chip" data-s="">（清空）</span>';
}
// 弹窗里问一个自定义科目名并落进 sched.customSubjects（已存在则不重复加）；返回新名字或 ''
function addCustomSubject(sched, save, name) {
  const nm = (name || '').trim();
  if (!nm) return '';
  if (!(sched.customSubjects || []).includes(nm)) {
    sched.customSubjects = [...(sched.customSubjects || []), nm];
    if (save) save();
  }
  return nm;
}

/* ================= ② 周课表（按选中班级编辑） ================= */
function subjectPicker(cur, sched, onPick, save) {
  const all = allSubjects(sched);
  const p = openPicker({
    title: '选择科目',
    body: `<div style="padding:12px 14px" class="chips">${subjectChipsHTML(all, cur)}</div>`,
    foot: `<button class="btn ghost" data-pclose>取消</button>`
  });
  p.body.onclick = e => {
    const cs = e.target.closest('[data-custom]');
    if (cs) {
      const name = addCustomSubject(sched, save, window.prompt(PROMPT_SUBJECT) || '');
      if (name) { onPick(name); p.close(); }
      return;
    }
    const c = e.target.closest('[data-s]');
    if (c) { onPick(c.dataset.s); p.close(); }
  };
  return p;
}

function openWeek(db, sched, rerender) {
  const periods = (sched?.periods || []).map(p => ({ ...p }));
  let editParity = useSplit() ? parity() : 'odd';
  let weekly = normalizeWeekly(editParity === 'odd' ? (sched.homeroom?.weekly || []) : (sched.homeroom?.weeklyEven || []), periods.length).map(r => [...r]);
  const save = () => saveSchedule(db, sched);
  const tableHTML = () => `
    <table class="week">
      <tr><th style="width:52px">节次</th>${DAYS.map(d => `<th>${d}</th>`).join('')}</tr>
      ${periods.map((p, pi) => {
        const ro = p.type && p.type !== 'class' && p.type !== 'service';
        return `<tr>
          <td class="pn">${esc(p.name)}</td>
          ${DAYS.map((_, di) => {
            if (ro) return `<td class="ro ${p.type === 'tutor' ? 'tu' : ''}">${esc(p.name)}</td>`;
            const c = weekly[di] ? (weekly[di][pi] || '') : '';
            return `<td><div class="cell ${c ? '' : 'none'}" data-p="${pi}" data-d="${di}">${esc(c || '＋')}</div></td>`;
          }).join('')}
        </tr>`;
      }).join('')}
    </table>`;
  const body = `
    <div style="padding:12px 14px">
      <div class="muted" style="margin:0 0 8px">正在编辑：<b>本班（${esc(sched.homeroom?.name || '本班')}）</b> 的周课表<span id="wk-parity-lb">${useSplit() ? ' · <b style="color:var(--primary)">' + (editParity === 'odd' ? '单周' : '双周') + '</b>' : ''}</span></div>
      ${useSplit() ? `<div class="seg" id="wk-parity" style="margin-bottom:8px"><button data-v="odd" class="${editParity === 'odd' ? 'on' : ''}">单周课表</button><button data-v="even" class="${editParity === 'even' ? 'on' : ''}">双周课表</button></div>` : ''}
      <div id="wk-table">${tableHTML()}</div>
      <div class="save-note">点格子选科目；<b>辅导 / 大课间不可点</b>；没有的科目点「＋ 自定义科目」。${useSplit() ? '单双周各一套，互不覆盖。' : ''}</div>
    </div>`;
  const p = openPicker({ title: '周课表', body, foot: `<button class="btn ghost" data-pclose>关闭</button><button class="btn" id="wk-save">保存课表</button>` });
  const onCell = e => {
    const cell = e.target.closest('.cell'); if (!cell) return;
    const pi = +cell.dataset.p, di = +cell.dataset.d;
    const cur = weekly[di] ? (weekly[di][pi] || '') : '';
    subjectPicker(cur, sched, s => {
      weekly[di] = weekly[di] || [];
      weekly[di][pi] = s;
      cell.textContent = s || '＋';
      cell.classList.toggle('none', !s);
    }, save);
  };
  const bindTable = () => p.body.querySelector('#wk-table').querySelector('.week').addEventListener('click', onCell);
  bindTable();
  if (useSplit()) {
    onSeg(p.body.querySelector('#wk-parity'), v => {
      editParity = v;
      weekly = normalizeWeekly(v === 'odd' ? (sched.homeroom?.weekly || []) : (sched.homeroom?.weeklyEven || []), periods.length).map(r => [...r]);
      p.body.querySelector('#wk-table').innerHTML = tableHTML();
      p.body.querySelector('#wk-parity-lb').innerHTML = ' · <b style="color:var(--primary)">' + (v === 'odd' ? '单周' : '双周') + '</b>';
      bindTable();
    });
  }
  p.foot.querySelector('#wk-save').onclick = async () => {
    if (editParity === 'odd') sched.homeroom.weekly = weekly; else sched.homeroom.weeklyEven = weekly;
    await saveSchedule(db, sched);
    toast('课表已保存'); p.close(); rerender();
  };
}

/* ================= ②-b 我的课表（单张自填表：每格 = 科目 + 班级） ================= */
function openMineCell(cur, sched, onPick, save) {
  const all = allSubjects(sched);
  const classList = () => sched.teachClasses || [];
  const p = openPicker({
    title: '填写本节课',
    body: `<div style="padding:12px 14px">
      <label class="muted" style="font-size:12px">科目</label>
      <div class="chips" id="mc-subs">${subjectChipsHTML(all, cur?.subject)}</div>
      <label class="muted" style="font-size:12px;display:block;margin-top:12px">班级</label>
      <div class="chips" id="mc-cls">${classList().length
        ? classList().map(c => `<span class="chip ${cur?.cls === c.name ? 'on' : ''}" data-c="${esc(c.name)}">${esc(c.name)}</span>`).join('')
        : '<span class="muted">请先在「授课班级」添加班级</span>'}
        <span class="chip" data-cnew="1">＋ 新班级</span></div>
    </div>`,
    foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn" id="mc-ok">确定</button>`
  });
  let subject = cur?.subject || '';
  let cls = cur?.cls || '';
  const subBox = p.body.querySelector('#mc-subs');
  const clsBox = p.body.querySelector('#mc-cls');
  const redrawCls = () => {
    clsBox.innerHTML = (classList().length
      ? classList().map(c => `<span class="chip ${cls === c.name ? 'on' : ''}" data-c="${esc(c.name)}">${esc(c.name)}</span>`).join('')
      : '<span class="muted">请先在「授课班级」添加班级</span>')
      + `<span class="chip" data-cnew="1">＋ 新班级</span>`;
  };
  subBox.onclick = e => {
    const cs = e.target.closest('[data-custom]');
    if (cs) {
      const nm = addCustomSubject(sched, save, window.prompt(PROMPT_SUBJECT) || '');
      if (nm) {
        subject = nm;
        subBox.querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
        const sp = document.createElement('span'); sp.className = 'chip on'; sp.dataset.s = nm; sp.textContent = nm; subBox.appendChild(sp);
      }
      return;
    }
    const c = e.target.closest('[data-s]');
    if (c) { subject = c.dataset.s; subBox.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x.dataset.s === subject)); }
  };
  clsBox.onclick = e => {
    const cn = e.target.closest('[data-cnew]');
    if (cn) {
      const nm = (window.prompt('新班级名称（如：三年三班）') || '').trim();
      if (nm) {
        const nc = { id: 'cls_' + Date.now().toString(36), name: nm };
        sched.teachClasses = sched.teachClasses || []; sched.teachClasses.push(nc); save();
        cls = nm; redrawCls();
      }
      return;
    }
    const c = e.target.closest('[data-c]');
    if (c) { cls = c.dataset.c; clsBox.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x.dataset.c === cls)); }
  };
  p.foot.querySelector('#mc-ok').onclick = () => {
    onPick(subject ? { subject, cls } : null);
    p.close();
  };
}

function openMine(db, sched, rerender) {
  const periods = (sched?.periods || []).map(p => ({ ...p }));
  const mine = sched.mine || { weekly: [] };
  const weekly = normalizeMine(mine.weekly, periods.length).map(r => r.map(c => (c ? { ...c } : null)));
  const save = () => saveSchedule(db, sched);
  const body = `
    <div style="padding:12px 14px">
      <div class="muted" style="margin:0 0 8px">空格子 = 该节没课；点格子填<b>科目</b>和<b>班级</b>。</div>
      <table class="week">
        <tr><th style="width:52px">节次</th>${DAYS.map(d => `<th>${d}</th>`).join('')}</tr>
        ${periods.map((p, pi) => {
          const ro = p.type && p.type !== 'class' && p.type !== 'service';
          return `<tr>
            <td class="pn">${esc(p.name)}</td>
            ${DAYS.map((_, di) => {
              if (ro) return `<td class="ro ${p.type === 'tutor' ? 'tu' : ''}">${esc(p.name)}</td>`;
              const c = weekly[di] ? (weekly[di][pi] || null) : null;
              const txt = c?.subject ? `${c.subject}${c.cls ? '·' + c.cls : ''}` : '＋';
              return `<td><div class="cell ${c?.subject ? '' : 'none'}" data-p="${pi}" data-d="${di}">${esc(txt)}</div></td>`;
            }).join('')}
          </tr>`;
        }).join('')}
      </table>
      <div class="save-note">空格=无课；点格子填科目与班级。</div>
    </div>`;
  const p = openPicker({ title: '我的课表', body, foot: `<button class="btn ghost" data-pclose>关闭</button><button class="btn" id="mk-save">保存课表</button>` });
  p.body.querySelector('.week').addEventListener('click', e => {
    const cell = e.target.closest('.cell'); if (!cell) return;
    const pi = +cell.dataset.p, di = +cell.dataset.d;
    const cur = weekly[di] ? (weekly[di][pi] || null) : null;
    openMineCell(cur, sched, val => {
      weekly[di] = weekly[di] || [];
      weekly[di][pi] = val;
      cell.textContent = val?.subject ? `${val.subject}${val.cls ? '·' + val.cls : ''}` : '＋';
      cell.classList.toggle('none', !val?.subject);
    }, save);
  });
  p.foot.querySelector('#mk-save').onclick = async () => {
    sched.mine = { weekly };
    await saveSchedule(db, sched);
    toast('我的课表已保存'); p.close(); rerender();
  };
}

/* ================= ②-c 授课班级（跨班教学）：管理「我的课表」可选的班级名单 ================= */
function openTeachClasses(db, sched, rerender) {
  const save = () => saveSchedule(db, sched);
  const p = openPicker({
    title: '授课班级（跨班教学）',
    lead: '本班（第一项）可改名，会同步到「设备名」的班级部分；跨班任教就在这添加其它班。',
    body: '<div style="padding:12px 14px" id="cc-body"></div>',
    foot: `<button class="btn" data-pclose>完成</button>`
  });
  const draw = () => {
    const b = p.body.querySelector('#cc-body');
    b.innerHTML = (sched.teachClasses || []).map(c => `
      <div class="cls-card" data-id="${esc(c.id)}">
        <div class="cls-hd">
          <input class="ta cls-name" data-id="${esc(c.id)}" value="${esc(c.name)}" style="flex:1;font-weight:600">
          ${c.id === 'main' ? '<span class="muted" style="font-size:12px">本班（可改名，同步设备名）</span>' : `<button class="mini danger" data-del="${esc(c.id)}">删除</button>`}
        </div>
      </div>`).join('') + `<button class="btn ghost mt" id="cc-add">＋ 添加授课班级</button>`;

    b.querySelectorAll('.cls-name').forEach(inp => {
      inp.onchange = () => {
        const c = sched.teachClasses.find(x => x.id === inp.dataset.id);
        c.name = inp.value.trim() || c.name;
        if (c.id === 'main') {                       // 🔴 本班班级名 ↔ 设备名班级 同源：改本班 → 设备名班级同步
          const oldName = sched.homeroom.name;
          sched.homeroom.name = c.name;
          (sched.mine?.weekly || []).forEach(row => (row || []).forEach(cell => { if (cell && cell.cls === oldName) cell.cls = c.name; }));
        }
        save();
      };
    });
    b.querySelector('#cc-add').onclick = () => {
      const nm = (window.prompt('添加的授课班级名称（如：三年三班）') || '').trim();
      if (nm) {
        if ((sched.teachClasses || []).some(c => c.name === nm)) { toast('已有同名班级'); return; }
        sched.teachClasses = sched.teachClasses || [];
        sched.teachClasses.push({ id: 'cls_' + Date.now().toString(36), name: nm });
        save(); draw();
      }
    };
    b.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = () => confirm({
        title: '删除授课班级', msg: '「我的课表」里引用此班的格子需手动改（不会自动清）。', danger: true,
        onOk: async () => {
          sched.teachClasses = (sched.teachClasses || []).filter(x => x.id !== btn.dataset.del);
          save(); draw();
        }
      });
    });
  };
  draw();
  // 关闭时统一刷新班务页（授课班级名单生效），编辑过程中不重绘以免关掉弹层
  p.foot.querySelector('[data-pclose]').addEventListener('click', () => rerender());
}

/* ================= ③ 作息时间表 ================= */
// 🔴 中文序号：新增节次与首装默认作息同风格（「第一节」而不是「第1节」），避免全表名字风格突变
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function cnNo(n) {
  if (n <= 10) return CN_NUM[n];
  if (n < 20) return '十' + CN_NUM[n - 10];
  const t = Math.floor(n / 10), o = n % 10;
  return CN_NUM[t] + '十' + (o ? CN_NUM[o] : '');
}
// 非正课的节次名回退值（改类型时用）
const PERIOD_TYPE_NAME = { tutor: '辅导', break: '大课间', service: '课后服务' };
function renumber(defs) {
  let i = 0;
  defs.forEach(d => { if (d.type === 'class') { d.no = ++i; d.name = '第' + cnNo(i) + '节'; } });
  return defs;
}
function norm(defs) {
  return defs.map(d => ({ no: d.no || 0, name: d.name || '', type: d.type || 'class', summer: d.summer || '', winter: d.winter || '' }));
}

function openSched(db, sched, rerender) {
  let defs = norm(sched?.periods || []);
  let seasonTab = 'summer';
  // 🔴 分两栏（① 节次结构 / ② 作息时间），默认直接落在「作息时间」：
  //    两栏原本上下叠成整页，手机上要滚很久；键盘弹出又盖住页面下半屏，
  //    最下面那些时间输入框连看都看不到 → 老师当成「点了 / 打了没反应」。
  let pane = 'time';
  const p = openPicker({
    title: '作息时间表',
    lead: '① 节次结构（夏冬共用）　② 作息时间（夏 / 冬各一套，每个节次的时间都可改）',
    body: '<div style="padding:12px 14px" id="sd-body"></div>',
    foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn" id="sd-save">保存</button>`
  });
  const structHTML = () => `
      <div id="sd-rows">${defs.map((d, i) => {
        const t = d.type === 'tutor' ? '辅导' : d.type === 'break' ? '大课间' : d.type === 'service' ? '课后服务' : '正课';
        return `<div class="prow" data-i="${i}">
          <div class="pinfo" data-edit="${i}">
            <div class="pno">${esc(d.type === 'class' ? String(d.no) : '·')}</div>
            <div class="pnm">${esc(d.name)}</div>
            <div class="ptype">${t}</div>
          </div>
          <div class="pact">
            <button data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button data-dn="${i}" ${i === defs.length - 1 ? 'disabled' : ''}>↓</button>
            <button data-ins="${i}">＋</button>
            <button class="del" data-del="${i}">✕</button>
          </div>
        </div>`;
      }).join('')}</div>
      <button class="btn ghost tiny" id="sd-add" style="margin-top:10px">＋ 新增节次</button>
      <div class="save-note">夏冬共用同一套节次结构；增删改只动结构，不丢已排的课。</div>`;
  const timeHTML = () => `
      <div class="seg" id="sd-season" style="margin-bottom:8px">
        <button data-v="summer" class="${seasonTab === 'summer' ? 'on' : ''}">夏季</button>
        <button data-v="winter" class="${seasonTab === 'winter' ? 'on' : ''}">冬季</button>
      </div>
      <div id="sd-times">${defs.map((d, i) => `
        <div class="trow">
          <div class="tnm">${esc(d.name)}</div>
          <input class="ti" data-t="${i}" value="${esc(seasonTab === 'summer' ? (d.summer || '') : (d.winter || ''))}"
            placeholder="如 08:00-08:40" autocomplete="off" enterkeyhint="done">
        </div>`).join('')}</div>
      <div class="save-note">每节时间都能改；辅导、大课间在周课表里不排科目。</div>`;
  const draw = () => {
    const b = p.body.querySelector('#sd-body');
    b.innerHTML = `
      <div class="seg" id="sd-pane" style="margin-bottom:10px">
        <button data-v="struct" class="${pane === 'struct' ? 'on' : ''}">① 节次结构</button>
        <button data-v="time" class="${pane === 'time' ? 'on' : ''}">② 作息时间</button>
      </div>
      ${pane === 'struct' ? structHTML() : timeHTML()}`;
    onSeg(b.querySelector('#sd-pane'), v => { pane = v; draw(); });
    if (pane === 'struct') {
      b.querySelector('#sd-rows').onclick = e => {
        const up = e.target.closest('[data-up]'), dn = e.target.closest('[data-dn]');
        const ins = e.target.closest('[data-ins]'), del = e.target.closest('[data-del]');
        const ed = e.target.closest('[data-edit]');
        if (up) { const i = +up.dataset.up; [defs[i - 1], defs[i]] = [defs[i], defs[i - 1]]; renumber(defs); draw(); }
        else if (dn) { const i = +dn.dataset.dn; [defs[i + 1], defs[i]] = [defs[i], defs[i + 1]]; renumber(defs); draw(); }
        else if (ins) { const i = +ins.dataset.ins; defs.splice(i + 1, 0, { no: 0, name: '新节次', type: 'class', summer: '', winter: '' }); renumber(defs); draw(); }
        else if (del) { const i = +del.dataset.del; if (defs.length > 1) { defs.splice(i, 1); renumber(defs); draw(); } else toast('至少保留一个节次'); }
        else if (ed) { editPeriod(+ed.dataset.edit); }
      };
      b.querySelector('#sd-add').onclick = () => { defs.push({ no: 0, name: '新节次', type: 'class', summer: '', winter: '' }); renumber(defs); draw(); };
    } else {
      onSeg(b.querySelector('#sd-season'), v => { seasonTab = v; draw(); });
      b.querySelector('#sd-times').oninput = e => {
        const i = +e.target.dataset.t;
        if (seasonTab === 'summer') defs[i].summer = e.target.value; else defs[i].winter = e.target.value;
      };
      // 🔴 手机键盘会盖住下半屏：聚焦后把这一行滚到屏幕中间，避免「打了字却看不见」
      b.querySelectorAll('#sd-times .ti').forEach(inp => {
        inp.addEventListener('focus', () => setTimeout(() => { try { inp.scrollIntoView({ block: 'center' }); } catch (e) { } }, 260));
      });
    }
  };
  function editPeriod(i) {
    const d = defs[i];
    const s = openPicker({
      title: '编辑节次',
      body: `<div style="padding:14px 16px">
        <div class="field"><label>类型</label>
          <div class="seg" id="ep-type">
            <button data-v="class" class="${d.type === 'class' ? 'on' : ''}">正课</button>
            <button data-v="tutor" class="${d.type === 'tutor' ? 'on' : ''}">辅导</button>
            <button data-v="break" class="${d.type === 'break' ? 'on' : ''}">大课间</button>
            <button data-v="service" class="${d.type === 'service' ? 'on' : ''}">课后服务</button>
          </div>
        </div>
        <div class="field"><label>名称${d.type === 'class' ? '（正课序号自动生成，不可手改）' : ''}</label>
          <input class="ta" id="ep-name" value="${esc(d.name)}" ${d.type === 'class' ? 'disabled' : ''}></div>
      </div>`,
      foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn" id="ep-ok">确定</button>`
    });
    onSeg(s.body.querySelector('#ep-type'), v => {
      d.type = v;
      const inp = s.body.querySelector('#ep-name');
      inp.disabled = v === 'class';
      // 🔴 改成非正课：清掉自动生成的「第N节」，回退成类型名（否则会与正课重名）
      if (v === 'class') { renumber(defs); inp.value = d.name; }
      else { d.no = 0; d.name = PERIOD_TYPE_NAME[v] || '节次'; inp.value = d.name; }
    });
    s.foot.querySelector('#ep-ok').onclick = () => {
      const inp = s.body.querySelector('#ep-name');
      if (d.type !== 'class') d.name = inp.value.trim() || d.name;
      renumber(defs); s.close(); draw();
    };
  }
  draw();
  p.foot.querySelector('#sd-save').onclick = async () => {
    // 🔴 写回同一对象：展开成新对象会让内存里的 sched 不更新，卡片「今日课表」时间不刷新
    sched.periods = defs;
    await saveSchedule(db, sched);
    toast('作息表已保存'); p.close(); rerender();
  };
}

/* ================= ④ 收缴（collections：建单 + 点名，无催缴） ================= */
function collHTML(c, students) {
  // 🔴 只数在册学生：已转出学生的历史已交记录不计入比例（否则会出现「已交 3/2」）
  const ids = new Set(students.map(s => s.id));
  const total = students.length;
  const paid = (c.paidIds || []).filter(id => ids.has(id)).length;
  return `<div class="task" data-open="${esc(c.id)}">
    <div style="flex:1;min-width:0">
      <div class="tk-nm">${esc(c.name)}</div>
      <div class="tk-sub">已交 ${paid}/${total} · ${total ? Math.round(paid / total * 100) : 0}%</div>
      <div class="bar"><i style="width:${total ? Math.round(paid / total * 100) : 0}%"></i></div>
    </div>
    <button class="mini danger" data-delcoll="${esc(c.id)}">删除</button>
  </div>`;
}

function openNewColl(db, colls, rerender) {
  const p = openPicker({
    title: '新建收缴任务',
    lead: '起个标题 → 到点名面板点姓名标谁交了。全班默认<b>未交</b>。',
    body: `<div style="padding:14px 16px">
      <div class="field"><label>任务标题（2~20 字，如「语文作业 / 校服费 / 安全回执」）</label>
        <input class="ta" id="nt-name" placeholder="语文作业" maxlength="20"></div>
      <div class="save-note">作业、回执、费用是同一套机制，只差标题。</div>
    </div>`,
    foot: `<button class="btn ghost" data-pclose>取消</button><button class="btn" id="nt-ok">创建并去点名</button>`
  });
  p.foot.querySelector('#nt-ok').onclick = async () => {
    const name = p.body.querySelector('#nt-name').value.trim();
    if (name.length < 2 || name.length > 20) { toast('标题需 2~20 字'); return; }
    if (colls.some(c => c.name === name)) { toast('已有同名任务，请换个标题'); return; }
    const coll = { id: 'cl' + Date.now().toString(36), name, paidIds: [], updatedAt: Date.now() };
    await putCollection(db, coll);
    colls.unshift(coll);
    p.close(); toast('已创建'); rerender(); openRoll(coll, db, rerender);
  };
}

function openRoll(coll, db, rerender) {
  const students = [];
  let view = 'grid', filter = 'all', lastToggled = null;
  const paid = new Set(coll.paidIds || []);
  const p = openPicker({
    title: coll.name,
    body: `<div style="padding:12px 14px">
      <input class="search" id="rl-q" type="search" enterkeyhint="search" placeholder="搜索姓名 / 拼音首字母" style="border:1px solid var(--line);border-radius:8px;margin-bottom:8px">
      <div class="row" style="gap:8px;margin-bottom:8px">
        <div class="seg" id="rl-view"><button data-v="grid" class="on">网格</button><button data-v="list">列表</button></div>
        <div class="seg" id="rl-filter"><button data-v="all" class="on">全部</button><button data-v="no">未交</button><button data-v="yes">已交</button></div>
      </div>
      <div class="muted" id="rl-stat" style="margin-bottom:6px"></div>
      <div id="rl-box"></div>
    </div>`,
    foot: `<button class="btn ghost" id="rl-undo">撤销</button><button class="btn" data-pclose>完成</button>`
  });
  listStudents(db).then(ss => { students.push(...ss); draw(); });

  const draw = () => {
    let list = filterStudents(students, p.body.querySelector('#rl-q').value);
    if (filter === 'no') list = list.filter(s => !paid.has(s.id));
    if (filter === 'yes') list = list.filter(s => paid.has(s.id));
    list.sort((a, b) => (paid.has(a.id) ? 1 : 0) - (paid.has(b.id) ? 1 : 0));
    // 🔴 只数在册学生（已转出的不参与点名统计）
    const done = students.filter(s => paid.has(s.id)).length;
    p.body.querySelector('#rl-stat').textContent = `已交 ${done} / ${students.length}　未交 ${students.length - done}`;
    p.body.querySelector('#rl-box').innerHTML = list.length
      ? (view === 'grid'
        ? `<div class="cgrid">${list.map(s => `<div class="nm ${paid.has(s.id) ? 'yes' : 'no'}" data-s="${s.id}">${esc(s.name)}</div>`).join('')}</div>`
        : `<div class="clist">${list.map(s => `<div class="crow" data-s="${s.id}">${esc(s.name)}<span class="st ${paid.has(s.id) ? '' : 'no'}">${paid.has(s.id) ? '已交' : '未交'}</span></div>`).join('')}</div>`)
      : emptyState('没有符合条件的学生');
  };
  p.body.querySelector('#rl-q').oninput = draw;
  onSeg(p.body.querySelector('#rl-view'), v => { view = v; draw(); });
  onSeg(p.body.querySelector('#rl-filter'), v => { filter = v; draw(); });
  p.body.querySelector('#rl-box').onclick = async e => {
    const n = e.target.closest('[data-s]'); if (!n) return;
    const id = n.dataset.s;
    const was = paid.has(id);
    if (was) paid.delete(id); else paid.add(id);
    lastToggled = { id, was };
    coll.paidIds = [...paid];
    await putCollection(db, coll);
    draw(); rerender();
  };
  p.foot.querySelector('#rl-undo').onclick = async () => {
    if (!lastToggled) { toast('没有可撤销的操作'); return; }
    if (lastToggled.was) paid.add(lastToggled.id); else paid.delete(lastToggled.id);
    lastToggled = null;
    coll.paidIds = [...paid];
    await putCollection(db, coll);
    toast('已撤销'); draw(); rerender();
  };
}

/* ================= 挂载 ================= */
export async function mount(scrollEl) {
  const db = state.db;
  const students = await listStudents(db);
  let sched = await getSchedule(db);
  sched = normalizeSched(sched, state.semester);     // 旧库 weekly/classes[] → 本班 + 授课班级，并持久化
  await saveSchedule(db, sched);
  let colls = await listCollections(db);

  const render = () => {
    scrollEl.innerHTML = `
      ${scheduleCard(sched)}
      <div class="card">
        <h2>📋 收缴任务 <span class="muted" style="font-weight:400;font-size:12px">点姓名即标记</span></h2>
        <div id="cl-colls">${colls.length
          ? colls.map(c => collHTML(c, students)).join('')
          : emptyState('还没有收缴任务')}</div>
        <button class="btn ghost mt" id="cl-new">+ 新建收缴任务</button>
        <div class="save-note">标记后自动算出已交 / 未交比例。</div>
      </div>`;
    bind();
  };

  function bind() {
    onSeg(scrollEl.querySelector('#cl-season'), v => { season = v; const tb = document.getElementById('cl-today'); if (tb) tb.innerHTML = todayListHTML(sched); });
    onSeg(scrollEl.querySelector('#cl-mode'), v => { schedMode = v; render(); });
    const tcBtn = scrollEl.querySelector('#cl-classes');
    if (tcBtn) tcBtn.onclick = () => openTeachClasses(db, sched, render);
    scrollEl.querySelector('#cl-week').onclick = () => {
      if (schedMode === 'mine') openMine(db, sched, render);
      else openWeek(db, sched, render);
    };
    scrollEl.querySelector('#cl-sched').onclick = () => openSched(db, sched, render);
    scrollEl.querySelector('#cl-new').onclick = () => openNewColl(db, colls, render);
    scrollEl.querySelector('#cl-colls').onclick = async e => {
      const del = e.target.closest('[data-delcoll]');
      if (del) {
        e.stopPropagation();
        confirm({ title: '删除任务', msg: '连同已交记录一并清空。', danger: true, onOk: async () => {
          await deleteCollection(db, del.dataset.delcoll); colls = await listCollections(db); toast('已删除'); render();
        }});
        return;
      }
      const open = e.target.closest('[data-open]');
      if (open) { const c = colls.find(x => x.id === open.dataset.open); if (c) openRoll(c, db, render); }
    };
  }

  render();
}
