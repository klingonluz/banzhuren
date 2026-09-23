// 归档报告（自包含 HTML 单文件）：样式内联、零脚本、含图
// 🔴 刻意不 import 任何应用模块 —— 本应用损坏、被删、或换到别的设备后，这份文件仍要能双击打开
// 🔴 文件内含学生真实姓名与照片：与「成长记录文本」同性质（实名 · 留本机 · 不上云 · 不经 privacy.js 脱敏）
// 🔴 纯静态（无 <script>）⇒ 天然只读，不存在被误编辑的风险

function h(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const p2 = n => String(n).padStart(2, '0');
function fmtDay(v) {
  if (!v) return '—';
  if (typeof v === 'string') return v;                    // 记录日期本就是 YYYY-MM-DD
  const d = new Date(v);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}
function fmtStamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return fmtDay(ts) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}
function bytes(n) {
  if (!n) return '—';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

const STYLE = [
  '*{box-sizing:border-box}',
  'body{margin:0;background:#f5f6f8;color:#1f2328;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
  '.wrap{max-width:860px;margin:0 auto;background:#fff;min-height:100vh}',
  'header{padding:28px 26px 20px;border-bottom:3px solid #2f6f4f;background:#f0f6f2}',
  'header h1{margin:0 0 6px;font-size:22px}',
  'header .sub{color:#5c636b;font-size:14px}',
  '.meta{display:flex;flex-wrap:wrap;gap:6px 22px;margin-top:14px;font-size:13px;color:#4a5158}',
  '.meta b{color:#1f2328}',
  'main{padding:8px 26px 34px}',
  'section{margin-top:26px}',
  'h2{font-size:16px;margin:0 0 12px;padding-left:9px;border-left:4px solid #2f6f4f}',
  '.grid{display:flex;flex-wrap:wrap;gap:10px}',
  '.stat{flex:1 1 116px;background:#f7f8fa;border:1px solid #e6e8eb;border-radius:9px;padding:12px 14px}',
  '.stat b{display:block;font-size:21px;line-height:1.25}',
  '.stat span{font-size:12px;color:#5c636b}',
  'table{width:100%;border-collapse:collapse;font-size:14px}',
  'th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #eceef1}',
  'th{color:#5c636b;font-weight:600;font-size:12px;background:#fafbfc}',
  '.out{color:#9aa1a8}',
  '.pill{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;background:#eef0f3;color:#5c636b;margin-left:6px}',
  '.rec{border:1px solid #e6e8eb;border-radius:11px;padding:13px 15px;margin-bottom:11px}',
  '.rec .top{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;margin-bottom:7px}',
  '.rec .who{font-weight:600}',
  '.rec .dt{color:#5c636b;font-size:13px}',
  '.rec .cat{font-size:11px;background:#eaf3ee;color:#2f6f4f;border-radius:9px;padding:1px 8px}',
  '.rec .tags{margin:6px 0 0}',
  '.tag{display:inline-block;font-size:12px;background:#f0f1f4;color:#3b4148;border-radius:8px;padding:2px 9px;margin:0 5px 5px 0}',
  '.txt{margin:7px 0 0;white-space:pre-wrap}',
  'figure{margin:11px 0 0}',
  'figure img{max-width:100%;border-radius:9px;display:block;background:#f0f1f4}',
  'figcaption{margin-top:5px;font-size:13px;color:#5c636b}',
  '.empty{color:#8b929a;padding:14px;text-align:center;background:#fafbfc;border-radius:9px}',
  '.bar{display:flex;align-items:center;gap:9px;margin-bottom:5px;font-size:13px}',
  '.bar .n{flex:0 0 108px;text-align:right;color:#3b4148;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.bar .t{flex:1;background:#eef0f3;border-radius:5px;height:15px;overflow:hidden}',
  '.bar .t i{display:block;height:100%;background:#7fb398}',
  '.bar .c{flex:0 0 42px;color:#5c636b;font-size:12px}',
  'footer{padding:20px 26px 34px;border-top:1px solid #eceef1;color:#6b7279;font-size:12px;line-height:1.9}',
  '.warn{background:#fff7e6;border:1px solid #f0d9a8;color:#8a5a00;border-radius:8px;padding:9px 12px;font-size:13px;margin-top:12px}',
  '@media print{body{background:#fff}.wrap{max-width:none}header{background:#fff}.rec,figure{break-inside:avoid}}'
].join('');

/** 把一份导出包（buildExportPack 的产物）渲染成自包含 HTML 归档报告 */
export function buildArchiveHTML(pack) {
  const semName = (pack.semester && pack.semester.name) || '学期';
  const students = Array.isArray(pack.students) ? pack.students : [];
  const all = Array.isArray(pack.records) ? pack.records : [];
  const recs = all.filter(r => !r.del);                       // 回收站里的软删记录不进报告
  const cats = Array.isArray(pack.categories) ? pack.categories : [];
  const tags = Array.isArray(pack.tags) ? pack.tags : [];
  const homeroom = (pack.schedule && pack.schedule.homeroom && pack.schedule.homeroom.name) || '';
  const className = homeroom || '本班';

  // 图片查表：imageId → dataURL
  const imgMap = new Map();
  (pack.images || []).forEach(im => { if (im && im.imageId && im.data) imgMap.set(im.imageId, im.data); });
  let imgUsed = 0;
  recs.forEach(r => { (r.imageIds || []).forEach(id => { if (imgMap.has(id)) imgUsed++; }); });

  const nameOf = id => (students.find(s => s.id === id) || {}).name || id;
  const inClass = students.filter(s => !s.out);
  const outClass = students.filter(s => s.out);

  // ---- 名册（按姓名，转出排后） ----
  const roster = students.slice().sort((a, b) =>
    (a.out ? 1 : 0) - (b.out ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'zh'));
  const cntByStu = {};
  recs.forEach(r => { cntByStu[r.studentId] = (cntByStu[r.studentId] || 0) + 1; });
  const rosterHTML = roster.length ? roster.map(s =>
    '<tr' + (s.out ? ' class="out"' : '') + '><td>' + h(s.name) + (s.out ? '<span class="pill">已转出</span>' : '') +
    '</td><td>' + (cntByStu[s.id] || 0) + ' 条</td></tr>').join('')
    : '<tr><td colspan="2" class="out">（无名单）</td></tr>';

  // ---- 分类 / 标签分布 ----
  const catCount = {};
  recs.forEach(r => { const k = r.category || '未分类'; catCount[k] = (catCount[k] || 0) + 1; });
  const barList = obj => {
    const ent = Object.keys(obj).map(k => [k, obj[k]]).sort((a, b) => b[1] - a[1]);
    const max = ent.length ? ent[0][1] : 1;
    return ent.map(([k, v]) =>
      '<div class="bar"><span class="n" title="' + h(k) + '">' + h(k) + '</span>' +
      '<span class="t"><i style="width:' + Math.max(2, Math.round(v / max * 100)) + '%"></i></span>' +
      '<span class="c">' + v + '</span></div>').join('');
  };
  const catHTML = Object.keys(catCount).length ? barList(catCount) : '<div class="empty">（本报告不含记录）</div>';

  const tagCount = {};
  recs.forEach(r => (r.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const topTags = Object.keys(tagCount).map(k => [k, tagCount[k]]).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const tagHTML = topTags.length ? barList(Object.fromEntries(topTags)) : '<div class="empty">（未使用标签）</div>';
  const catName = {};
  cats.forEach(c => { catName[c.id] = c.cat; });

  // ---- 时间线（日期倒序） ----
  const sorted = recs.slice().sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || '')) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const recHTML = sorted.length ? sorted.map(r => {
    const imgs = (r.imageIds || []).map((id, i) => {
      const src = imgMap.get(id);
      if (!src) return '';
      const desc = ((r.imgDescs || [])[i] || '').trim();
      return '<figure><img src="' + src + '" alt="' + h(desc || '成长记录图片') + '">' +
        (desc ? '<figcaption>' + h(desc) + '</figcaption>' : '') + '</figure>';
    }).join('');
    const tg = (r.tags || []).map(t => '<span class="tag">' + h(t) + '</span>').join('');
    return '<div class="rec"><div class="top">' +
      '<span class="who">' + h(nameOf(r.studentId)) + '</span>' +
      '<span class="dt">' + h(fmtDay(r.date)) + '</span>' +
      (r.category ? '<span class="cat">' + h(r.category) + '</span>' : '') +
      '</div>' +
      (tg ? '<div class="tags">' + tg + '</div>' : '') +
      (r.text ? '<p class="txt">' + h(r.text) + '</p>' : '') +
      imgs + '</div>';
  }).join('') : '<div class="empty">本学期还没有成长记录</div>';

  const title = '班主任工作台 · ' + semName + ' · 归档报告';
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + h(title) + '</title>',
    '<style>' + STYLE + '</style>',
    '</head><body><div class="wrap">',
    '<header>',
    '<h1>' + h(className) + ' · 成长记录归档</h1>',
    '<div class="sub">' + h(semName) + '</div>',
    '<div class="meta">',
    '<span>归档时间 <b>' + h(fmtStamp(pack.exportedAt)) + '</b></span>',
    '<span>成册设备 <b>' + h(pack.device || '—') + '</b></span>',
    '<span>记录 <b>' + recs.length + '</b> 条</span>',
    '<span>图片 <b>' + imgUsed + '</b> 张</span>',
    '<span>学生 <b>' + inClass.length + '</b> 人' + (outClass.length ? '（另有转出 ' + outClass.length + ' 人）' : '') + '</span>',
    '</div></header>',
    '<main>',
    '<section><h2>名册</h2><table><thead><tr><th>姓名</th><th>记录</th></tr></thead><tbody>' + rosterHTML + '</tbody></table></section>',
    '<section><h2>分类分布</h2>' + catHTML + '</section>',
    '<section><h2>标签使用</h2>' + tagHTML + '</section>',
    '<section><h2>成长记录（按日期倒序）</h2>' + recHTML + '</section>',
    '</main>',
    '<footer>',
    '<div class="warn">本文件含学生<b>真实姓名与照片</b>，用于留档与打印。请妥善保管，不要上传到公开渠道或发给无关人员。</div>',
    '<div>本文件由「班主任工作台」于 ' + h(fmtStamp(pack.exportedAt)) + ' 导出，数据取自 ' + h(semName) + '。</div>',
    '<div>只读报告（纯静态页面，不含可编辑数据）；可直接用浏览器打印或另存为 PDF。同批导出的 .json 文件才是可导入恢复的备份。</div>',
    '</footer>',
    '</div></body></html>'
  ].join('');
}

/** 归档文件名（唯一命名规则）：班主任工作台_<学期名>_归档_<YYYYMMDD>.<ext> */
export function archiveFileName(semesterName, ext, ts) {
  const d = new Date(ts || Date.now());
  const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate());
  return '班主任工作台_' + (semesterName || '学期') + '_归档_' + stamp + '.' + ext;
}

export { bytes as fmtBytes };
