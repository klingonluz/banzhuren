// 分析 Tab：单功能 = 导出（实名直出 · 全量含图 · 绝不联网）
// V11.1：关注项默认一并导出，评语以鼓励为主（把缺点写成可努力的方向）
import { state } from '../state.js';
import { listStudents } from '../db/semester.js';
import { GUANZHU } from '../db/seed.js';
import { esc, toast, openPicker, syncSeg, onSeg } from '../ui.js';

// 🔴 关注类标签 → 鼓励版措辞（导出时把不足写成可努力的方向，不给孩子贴负面标签）
const ENCOURAGE = {
  '自控力差': '课堂上需要更多引导保持专注',
  '爱发脾气': '情绪管理正在成长中，多用语言表达',
  '违反班规': '规则意识正在建立，持续引导',
  '卫生不佳': '卫生习惯在养成中，多提醒即好',
  '严重拖延': '任务拆解成小步后完成度更高',
  '粗心大意': '检查习惯在培养，逐步更稳',
  '消极应付': '意义感建立后更投入',
  '过度内向': '需多创造参与机会，慢慢打开',
  '缺乏安全感': '需要更多关注与陪伴建立安全',
  '社交冲突': '冲突协调中，社交能力在练',
  '寻求过度关注': '多给正向关注，被看见后更安稳',
  '争夺权力': '给有限选择，增强掌控感',
  '报复行为': '先修复关系，再引导表达',
  '自暴自弃': '多搭梯子，小步成功积累信心'
};
const imgsOf = r => r.imageIds || [];

function tagText(r) {
  return (r.tags || []).map(n => {
    if (r.category === GUANZHU && ENCOURAGE[n]) return ENCOURAGE[n];
    return n;
  }).join('、');
}

// 本地拼装，纯字符串；🔴 不发起任何网络请求
function buildText(students, recs, withImg, withGz) {
  // 🔴 只导出「在册学生」的记录：已转出的学生不在名单里，也不进导出
  //    （他的历史记录仍留在本机时间线 / JSON 备份里，作为纪念）
  const ids = new Set(students.map(s => s.id));
  const data = (withGz ? recs : recs.filter(r => r.category !== GUANZHU)).filter(r => ids.has(r.studentId));
  const byStu = {};
  data.forEach(r => { (byStu[r.studentId] = byStu[r.studentId] || []).push(r); });
  Object.values(byStu).forEach(a => a.sort((x, y) => (x.date < y.date ? 1 : -1)));
  const lines = [];
  lines.push('班主任工作台 · 成长记录导出');
  lines.push(`学期：${state.semester?.name || ''}    导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`覆盖学生：${Object.keys(byStu).length} 人    记录总数：${data.length}`);
  lines.push('='.repeat(28));
  lines.push('【说明】以下是本学期学生的能力发展记录（实名，不含成绩），含「关注」类教师内部观察（含问题行为、错误目的识别与鼓励支持方向），请一并纳入分析。措辞以鼓励为主：把不足写成可努力的方向，不给孩子贴负面标签。');
  for (const st of students) {
    const arr = byStu[st.id]; if (!arr || !arr.length) continue;
    lines.push('');
    lines.push(`【${st.name}】(${arr.length}条)`);
    arr.forEach(r => {
      const tail = (withImg && imgsOf(r).length) ? `（附现场照片 ${imgsOf(r).length} 张）` : '';
      lines.push(`  ${r.date} [${r.category}] ${tagText(r)}${r.text ? ' — ' + r.text : ''}${tail}`);
    });
  }
  return lines.join('\n');
}

export async function mount(scrollEl) {
  const db = state.db;
  const students = await listStudents(db);
  const all = await db.growth_records.where('del').equals(0).toArray();   // 🔴 过滤软删
  const gzTotal = all.filter(r => r.category === GUANZHU).length;
  const imgRecs = all.filter(r => imgsOf(r).length).length;

  scrollEl.innerHTML = `
    <div class="card">
      <h2>📤 导出 <span class="muted" style="font-weight:400;font-size:12px">（单功能 · 实名）</span></h2>
      <div class="li"><span>姓名</span><span class="pill yes" style="margin-left:auto">实名，不脱敏</span></div>
      <div class="li"><span>本学期带图记录</span><span class="pill do" style="margin-left:auto">${imgRecs} 条（多模态维度）</span></div>
      <div class="li"><span>关注类记录</span><span class="pill no" style="margin-left:auto">${gzTotal} 条（一并导出，鼓励为主）</span></div>
      <p class="muted" style="margin-top:8px">本地拼装文本 + 带图标记，<b>绝不联网</b>；复制后粘贴到你自己的 AI 工具或存档即可。</p>
      <button class="btn mt" id="an-open">生成导出文本</button>
      <div class="save-note">导出保持<b>单功能</b>。名字无需脱敏——老师自己用、数据不出本机；关注项也导出，但评语以<b>鼓励为主</b>。</div>
    </div>`;

  scrollEl.querySelector('#an-open').onclick = () => openExport(students, all, gzTotal);
}

function openExport(students, all, gzTotal) {
  let scope = 'all', withImg = true, withGz = true;
  const picked = new Set();

  const p = openPicker({
    title: '导出 · 结构化文本（实名）',
    body: `
      <div style="padding:14px 16px">
        <div class="field">
          <label>范围</label>
          <div class="seg" id="ex-scope">
            <button data-v="all" class="on">全班</button>
            <button data-v="pick">指定学生</button>
          </div>
        </div>
        <div id="ex-pick" style="display:none;margin:-2px 0 8px">
          <input class="search" id="ex-q" placeholder="搜索学生 / 拼音首字母" style="border:1px solid var(--line);border-radius:8px;margin-bottom:8px">
          <div id="ex-list"></div>
        </div>
        <div class="field">
          <label>带图标注 <span class="muted" style="font-weight:400;font-size:11px">带图记录后标「附现场照片 N 张」</span></label>
          <div class="seg sm" id="ex-img">
            <button data-v="1" class="on">开</button><button data-v="0">关</button>
          </div>
        </div>
        <div class="field">
          <label>关注项 <span class="muted" style="font-weight:400;font-size:11px">教师内部观察，默认一并导出更全面</span></label>
          <div class="seg sm" id="ex-gz">
            <button data-v="1" class="on">一并导出</button><button data-v="0">仅正向能力</button>
          </div>
        </div>
        <div class="save-note" style="margin:6px 0">包含：<b>真实姓名</b> / 年级 / 班级 / 能力发展记录 / <b>关注项（鼓励为主）</b> / 带图标记。<b>不含</b>：成绩、已删记录、其他学期。</div>
        <div class="muted" id="ex-stat" style="font-size:12px;margin-bottom:6px"></div>
        <div class="ai-pre" id="ex-pre"></div>
      </div>`,
    foot: `<button class="btn ghost" data-pclose>关闭</button>
           <button class="btn ghost" id="ex-down">下载 .txt</button>
           <button class="btn" id="ex-copy">复制文本</button>`
  });

  const current = () => scope === 'all' ? students : students.filter(s => picked.has(s.id));
  const currentRecs = () => scope === 'all' ? all : all.filter(r => picked.has(r.studentId));
  let text = '';
  const refresh = () => {
    const ss = current(), rs = currentRecs();
    text = buildText(ss, rs, withImg, withGz);
    const gzNow = rs.filter(r => r.category === GUANZHU).length;
    p.body.querySelector('#ex-stat').textContent =
      `将导出 ${ss.length} 名学生 · ${rs.length} 条记录` + (withGz ? `（含 ${gzNow} 条关注）` : `（已排除 ${gzTotal} 条关注）`) + ` · ${text.length} 字`;
    p.body.querySelector('#ex-pre').textContent = text;
  };

  onSeg(p.body.querySelector('#ex-scope'), v => {
    scope = v;
    p.body.querySelector('#ex-pick').style.display = v === 'pick' ? '' : 'none';
    refresh();
  });
  onSeg(p.body.querySelector('#ex-img'), v => { withImg = v === '1'; refresh(); });
  onSeg(p.body.querySelector('#ex-gz'), v => { withGz = v === '1'; refresh(); });

  p.body.querySelector('#ex-q').oninput = e => drawPick(e.target.value);
  function drawPick(q = '') {
    q = q.trim().toLowerCase();
    const hit = students.filter(s => !q || s.name.includes(q) || (s.pinyin || '').toLowerCase().includes(q));
    p.body.querySelector('#ex-list').innerHTML = hit.map(s =>
      `<div class="srow ${picked.has(s.id) ? 'on' : ''}" data-s="${s.id}">${esc(s.name)}<span class="py">${esc(s.pinyin || '')}</span></div>`).join('')
      || '<div class="empty">无匹配</div>';
  }
  drawPick();
  p.body.querySelector('#ex-list').onclick = e => {
    const row = e.target.closest('[data-s]'); if (!row) return;
    const id = row.dataset.s;
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    row.classList.toggle('on');
    refresh();
  };

  refresh();

  p.foot.querySelector('#ex-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制' + (withImg && currentRecs().some(r => imgsOf(r).length) ? '，记得把照片一并发给 AI（如需）' : ''));
    } catch {
      toast('复制失败，请长按预览区手动复制');
    }
  };
  p.foot.querySelector('#ex-down').onclick = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = `成长记录_${state.semester?.name || '本学期'}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
    toast('已下载');
  };
}
