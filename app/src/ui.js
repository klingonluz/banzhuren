// 通用 UI 组件：Toast、底部弹层、全屏弹层、操作面板、撤销条、空态、确认框、灯箱
// 结构与类名严格对齐 ui_prototype.html（方案 §4.8 UI 设计规格）
const app = () => document.getElementById('app');

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------- Toast（居中偏下，2s；错误一律走 Banner） ---------- */
let toastTimer = null;
export function toast(msg) {
  let t = app().querySelector('.toast');
  if (!t) { t = el('<div class="toast"></div>'); app().appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

/* ---------- 顶部横幅（错误 / 预警，不用 Toast） ---------- */
export function banner(id, html, kind = 'warn') {
  const host = document.getElementById('banners');
  if (!host) return;
  let b = host.querySelector('#' + id);
  if (!b) { b = el(`<div class="banner ${kind}" id="${id}"></div>`); host.appendChild(b); }
  b.innerHTML = html + '<span class="x" data-bclose>&times;</span>';
  b.querySelector('[data-bclose]').onclick = () => b.remove();
}
export function closeBanner(id) {
  const b = document.getElementById(id); if (b) b.remove();
}

/* ---------- 底部弹层（sheet） ---------- */
export function showSheet({ title, body = '', foot = '', closable = true }) {
  // 🔴 只关闭已存在的 sheet（不误删底层全屏 picker），否则确认框打开会连下面的弹层一起干掉
  app().querySelectorAll('.mask.show').forEach(m => { if (m.querySelector('.sheet')) m.remove(); });
  const mask = el(`
    <div class="mask show">
      <div class="sheet">
        <div class="sheet-head">
          <div class="tt">${esc(title)}</div>
          ${closable ? '<div class="x" data-close>&times;</div>' : ''}
        </div>
        <div class="sheet-body">${body}</div>
        ${foot ? `<div class="sheet-foot">${foot}</div>` : ''}
      </div>
    </div>`);
  const myClose = () => mask.remove();
  if (closable) {
    mask.addEventListener('click', e => {
      if (e.target === mask || e.target.hasAttribute('data-close')) myClose();
    });
  }
  app().appendChild(mask);
  return { mask, body: mask.querySelector('.sheet-body'), foot: mask.querySelector('.sheet-foot'), close: myClose };
}
export function closeSheets() {
  app().querySelectorAll('.mask.show').forEach(m => m.remove());
}

/* ---------- 全屏弹层（学生选择 / 点名 / 设置 / 导出一律全屏） ---------- */
// 🔴 规格：手机上居中 Modal 可点区域太小、键盘弹起会顶飞 → 一律全屏（§4.8.3）
export function openPicker({ id = '', title = '', lead = '', body = '', foot = '', onClose = null }) {
  const mask = el(`
    <div class="mask show ${id}" style="align-items:stretch">
      <div class="picker">
        <div class="picker-hd">
          <h3>${esc(title)}</h3>
          <span class="x" data-pclose>&times;</span>
        </div>
        ${lead ? `<div class="picker-lead">${lead}</div>` : ''}
        <div class="lst">${body}</div>
        ${foot ? `<div class="nt-foot">${foot}</div>` : ''}
      </div>
    </div>`);
  const close = () => { mask.remove(); onClose && onClose(); };
  // 🔴 绑定所有 [data-pclose]（header × 与 footer 取消/关闭/完成 都带此属性），否则只有第一个（×）生效
  mask.querySelectorAll('[data-pclose]').forEach(x => x.onclick = close);
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  app().appendChild(mask);
  pushHistory(close);                      // 安卓物理返回键兜底（§4.8.11-6）
  return { mask, body: mask.querySelector('.lst'), foot: mask.querySelector('.nt-foot'), close };
}
export function closePickers() {
  app().querySelectorAll('.mask.show .picker').forEach(p => p.closest('.mask').remove());
}

/* ---------- 物理返回键兜底（history.pushState） ---------- */
const backStack = [];
export function pushHistory(fn) {
  backStack.push(fn);
  window.history.pushState({ bzr: backStack.length }, '');
}
window.addEventListener('popstate', () => {
  const fn = backStack.pop();
  if (fn) { try { fn(); } catch {} }
});

/* ---------- 记录操作面板（⋯） ---------- */
export function actionSheet(items) {
  const box = el(`
    <div class="mask show" id="actsheet">
      <div class="actsheet">
        <div class="as-hd">操作</div>
        ${items.map((it, i) => `<button class="as-item ${it.danger ? 'del' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('')}
        <button class="as-item cancel" data-cancel>取消</button>
      </div>
    </div>`);
  const close = () => box.remove();
  box.addEventListener('click', e => {
    if (e.target === box || e.target.hasAttribute('data-cancel')) { close(); return; }
    const b = e.target.closest('[data-i]'); if (!b) return;
    close(); items[+b.dataset.i].onClick && items[+b.dataset.i].onClick();
  });
  app().appendChild(box);
  return { close };
}

/* ---------- 撤销条（删除后 5 秒可撤销，只撤一步） ---------- */
export function undoBar(text, onUndo, ms = 5000) {
  document.querySelectorAll('.undo').forEach(u => u.remove());
  const bar = el(`<div class="undo"><span>${esc(text)}</span><button>撤销</button></div>`);
  bar.querySelector('button').onclick = () => { bar.remove(); onUndo && onUndo(); };
  app().appendChild(bar);
  setTimeout(() => bar.remove(), ms);
}

/* ---------- 空态（每个列表都要有，且给下一步动作） ---------- */
export function emptyState(text, actionText = '', onClick = null) {
  return `<div class="empty">${esc(text)}${actionText ? `<div style="margin-top:10px"><button class="btn ghost tiny" data-empty-act>${esc(actionText)}</button></div>` : ''}</div>`;
}
export function bindEmpty(root, handler) {
  root.querySelectorAll('[data-empty-act]').forEach(b => b.onclick = () => handler());
}

/* ---------- 确认框 ---------- */
export function confirm({ title, msg, okText = '确定', danger = false, onOk }) {
  const s = showSheet({
    title, closable: true,
    body: `<p class="muted">${esc(msg)}</p>`,
    foot: `<button class="btn ghost" data-close>取消</button>
           <button class="btn ${danger ? 'danger' : ''}" id="cfm-ok">${esc(okText)}</button>`
  });
  s.foot.querySelector('#cfm-ok').onclick = () => { s.close(); onOk && onOk(); };
}

/* ---------- 大图查看（灯箱，支持多图） ---------- */
export function lightbox(urls, index = 0) {
  const list = Array.isArray(urls) ? urls : [urls];
  let i = index;
  const lb = el(`<div class="lb"><div class="big"></div><button class="cls">关闭</button></div>`);
  const big = lb.querySelector('.big');
  const draw = () => { big.innerHTML = `<img src="${list[i]}" alt="">${list.length > 1 ? `<span class="lbidx">${i + 1}/${list.length}</span>` : ''}`; };
  draw();
  lb.addEventListener('click', e => {
    if (e.target.classList.contains('cls') || e.target === lb) { lb.remove(); return; }
    if (list.length > 1) {                       // 点击切换下一张
      const r = big.getBoundingClientRect();
      if (e.clientX - r.left > r.width / 2) i = (i + 1) % list.length; else i = (i - 1 + list.length) % list.length;
      draw();
    }
  });
  app().appendChild(lb);
  requestAnimationFrame(() => lb.classList.add('show'));
  return lb;
}

/* ---------- 分段控件：同步当前值（🔴 避免"看着是 A、实际是 B"） ---------- */
export function syncSeg(segEl, value) {
  if (!segEl) return;
  [...segEl.querySelectorAll('button')].forEach(b =>
    b.classList.toggle('on', b.dataset.v === String(value)));
}
export function onSeg(segEl, handler) {
  segEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    syncSeg(segEl, b.dataset.v);
    handler(b.dataset.v, b);
  });
}
