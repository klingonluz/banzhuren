// 成长记录文本（实名 · 只留你自己设备上）：拼装 + 导出面板
// 🔴 V11.11 起从「分析」页迁到「数据」页，与「备份与恢复」并列 —— 两者不重复：
//    备份 = 全量 JSON（含图片二进制，可再导入、逐条裁决恢复）；本文件 = 纯文本成长记录（给人看 / 打印 / 给家长）。
// 分析页的「AI 评语素材」复用这里的 tagText，保证两条通道措辞一致（关注类一律写成可努力的方向）。
import { state } from './state.js';
import { listStudents } from './db/semester.js';
import { GUANZHU } from './db/seed.js';
import { esc, toast, openPicker, onSeg, scopeBlockHTML, bindScopeBlock } from './ui.js';
import { download } from './util.js';

// 🔴 关注类标签 → 鼓励版措辞（导出与 AI 素材都用它，不给孩子贴负面标签）
export const ENCOURAGE = {
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
export function tagText(r) {
  return (r.tags || []).map(n => {
    if (r.category === GUANZHU && ENCOURAGE[n]) return ENCOURAGE[n];
    return n;
  }).join('、');
}
const imgsOf = r => r.imageIds || [];
// 图片说明（V11.11）：每张图配一句文字，让「画面」以文字形式进入记录与 AI 素材
const descsOf = r => (r.imgDescs || []).filter(Boolean);

/* ---------- ① 实名文本拼装（纯字符串；🔴 不发起任何网络请求） ---------- */
export function buildText(students, recs, withImg, withGz) {
  // 🔴 只导出「在册学生」的记录：已转出的学生不在名单里，也不进导出
  //    （他的历史记录仍留在本机时间线 / JSON 备份里，作为纪念）
  const ids = new Set(students.map(s => s.id));
  const data = (withGz ? recs : recs.filter(r => r.category !== GUANZHU)).filter(r => ids.has(r.studentId));
  const byStu = {};
  data.forEach(r => { (byStu[r.studentId] = byStu[r.studentId] || []).push(r); });
  Object.values(byStu).forEach(a => a.sort((x, y) => (x.date < y.date ? 1 : -1)));
  const lines = [];
  lines.push('班主任工作台 · 成长记录导出（本地留存，不对外发送）');
  lines.push(`学期：${state.semester?.name || ''}    导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`覆盖学生：${Object.keys(byStu).length} 人    记录总数：${data.length}`);
  lines.push('='.repeat(28));
  lines.push('【说明】以下是本学期学生的能力发展记录（实名，不含成绩），含「关注」类内部观察，请一并纳入分析。措辞以鼓励为主：把不足写成可努力的方向，不贴负面标签。');
  for (const st of students) {
    const arr = byStu[st.id]; if (!arr || !arr.length) continue;
    lines.push('');
    lines.push(`【${st.name}】(${arr.length}条)`);
    arr.forEach(r => {
      const n = imgsOf(r).length;
      const ds = descsOf(r);
      const tail = (withImg && n) ? `（附现场照片 ${n} 张${ds.length ? '：' + ds.join('；') : ''}）` : '';
      lines.push(`  ${r.date} [${r.category}] ${tagText(r)}${r.text ? ' — ' + r.text : ''}${tail}`);
    });
  }
  return lines.join('\n');
}

/* ---------- ② 导出面板（实名） ---------- */
export async function openExport() {
  const db = state.db;
  const students = await listStudents(db);
  const all = await db.growth_records.where('del').equals(0).toArray();   // 🔴 过滤软删
  const gzTotal = all.filter(r => r.category === GUANZHU).length;

  let withImg = true, withGz = true;

  const p = openPicker({
    title: '成长记录文本 · 实名',
    lead: '给人看的文字材料，可打印 / 给家长，<b>不是备份</b>；姓名保持真实。要发给 AI 请用「分析 → AI 评语素材」。',
    body: `
      <div style="padding:14px 16px">
${scopeBlockHTML('ex')}
        <div class="field">
          <label>带图标注 <span class="muted" style="font-weight:400;font-size:11px">带图记录后标照片张数与说明</span></label>
          <div class="seg sm" id="ex-img">
            <button data-v="1" class="on">开</button><button data-v="0">关</button>
          </div>
        </div>
        <div class="field">
          <label>关注项 <span class="muted" style="font-weight:400;font-size:11px">教师内部观察</span></label>
          <div class="seg sm" id="ex-gz">
            <button data-v="1" class="on">一并导出</button><button data-v="0">仅正向能力</button>
          </div>
        </div>
        <div class="save-note" style="margin:6px 0">包含：<b>真实姓名</b> / 班级 / 能力发展记录 / <b>关注项</b> / 图片说明。<b>不含</b>：成绩与照片。</div>
        <div class="muted" id="ex-stat" style="font-size:12px;margin-bottom:6px"></div>
        <div class="ai-pre" id="ex-pre"></div>
      </div>`,
    foot: `<button class="btn ghost" data-pclose>关闭</button>
           <button class="btn ghost" id="ex-down">下载</button>
           <button class="btn" id="ex-copy">复制文本</button>`
  });

  // 🔴 范围 + 指定学生：与分析页「AI 评语素材」共用同一实现（P2-4）
  //    绑定里的 onChange 会在切换范围 / 增删学生后回调 refresh；它在下面才定义，靠闭包延迟求值。
  const scopeCtl = bindScopeBlock(p.body, 'ex', students, () => refresh());
  const picked = scopeCtl.picked;
  const current = () => scopeCtl.isAll() ? students : students.filter(s => picked.has(s.id));
  const currentRecs = () => scopeCtl.isAll() ? all : all.filter(r => picked.has(r.studentId));
  let text = '';
  const refresh = () => {
    const ss = current(), rs = currentRecs();
    text = buildText(ss, rs, withImg, withGz);
    const gzNow = rs.filter(r => r.category === GUANZHU).length;
    p.body.querySelector('#ex-stat').textContent =
      `将导出 ${ss.length} 名学生 · ${rs.length} 条记录` + (withGz ? `（含 ${gzNow} 条关注）` : `（已排除 ${gzTotal} 条关注）`) + ` · ${text.length} 字`;
    p.body.querySelector('#ex-pre').textContent = text;
  };

  onSeg(p.body.querySelector('#ex-img'), v => { withImg = v === '1'; refresh(); });
  onSeg(p.body.querySelector('#ex-gz'), v => { withGz = v === '1'; refresh(); });

  refresh();

  p.foot.querySelector('#ex-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      // 🔴 本地通道只给文本：照片不会随文本下载 / 复制，也永远不参与 AI 输出
      toast('已复制' + (withImg && currentRecs().some(r => imgsOf(r).length) ? '（照片不在文本里，只有带图标记与说明）' : ''));
    } catch {
      toast('复制失败，请长按预览区手动复制');
    }
  };
  p.foot.querySelector('#ex-down').onclick = () => {
    download(`成长记录_${state.semester?.name || '本学期'}.txt`, text, 'text/plain');
    toast('已下载');
  };
}
