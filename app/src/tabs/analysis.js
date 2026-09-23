// 分析 Tab：AI 评语素材（脱敏 · 唯一外发口） + 外发前须知
// V11.11 §2.12：本地「成长记录文本（实名）」已移到「数据」页与备份并列；本页只负责「要发给 AI 的那一份」——
// 姓名换成一次性代号，分数 / 名次 / 具体日期 / 他人姓名一律处理掉，照片不参与任何输出。
import { state, saveSetting } from '../state.js';
import { listStudents } from '../db/semester.js';
import { GUANZHU } from '../db/seed.js';
import { esc, toast, openPicker, syncSeg, onSeg, scopeBlockHTML, bindScopeBlock } from '../ui.js';
import { buildAliasMap, buildScrubbedText, describeHits, highlight, MASK } from '../privacy.js';
import { tagText } from '../export.js';

export async function mount(scrollEl) {
  const db = state.db;
  const students = await listStudents(db);
  // 🔴 红线1：进本页不再 toArray() 拉全表。这里只需要「关注类记录几条」（走 category 索引 count），
  //    真正的全部记录要等到点「生成素材」那一刻再按需分页读取（loadAllRecords）。
  const gzTotal = await db.growth_records.where('category').equals(GUANZHU).and(r => r.del === 0).count();

  scrollEl.innerHTML = `
    <div class="card">
      <h2>🤖 AI 评语素材 <span class="muted" style="font-weight:400;font-size:12px">（脱敏 · 唯一外发口）</span></h2>
      <div class="li"><span>姓名</span><span class="pill yes" style="margin-left:auto">一次性代号「同学A」</span></div>
      <div class="li"><span>分数 / 名次</span><span class="pill no" style="margin-left:auto">自动隐去</span></div>
      <div class="li"><span>照片</span><span class="pill no" style="margin-left:auto">不参与，一张都不发</span></div>
      <div class="li"><span>关注类记录</span><span class="pill no" style="margin-left:auto">${gzTotal} 条（可含，负面自动转成可努力方向）</span></div>
      <p class="muted" style="margin-top:8px">生成的是<b>给 AI 看的那一份</b>：保留「这个学生是什么样的」，去掉「这个学生是谁」。代号只在本次有效，关掉或刷新即作废。</p>
      <button class="btn mt" id="an-ai">生成 AI 评语素材</button>
      <button class="btn ghost mt" id="an-ai-back">把 AI 返回的评语还原成真实姓名</button>
      <div class="save-note">照片不参与——需要说明画面时用<b>一句文字</b>转述：记录时可为每张图写「图片说明」，这句文字会出现在这份素材里（也会一并脱敏）。</div>
    </div>

    <div class="card">
      <h2>🛡️ 外发前须知</h2>
      <div class="save-note" style="border:none">
        ① 未满 14 周岁学生的信息属于《个人信息保护法》第 28 条中的<b>敏感个人信息</b>，教师不能代替学生对外授权。<br>
        ② 本工具只提供<b>技术上的脱敏</b>；是否外发、发给谁、发多少，请你按学校要求与自己的判断决定。<br>
        ③ 照片一律不参与 AI 输出——需要说明画面时，用一句文字转述（如「手抄报排版工整」）即可。<br>
        ④ 生成素材后，建议先扫一眼预览，确认没有你不希望外发的内容，再复制。
      </div>
    </div>`;

  scrollEl.querySelector('#an-ai').onclick = () => openAI(students, 'gen');
  scrollEl.querySelector('#an-ai-back').onclick = () => openAI(students, 'back');
}

// 按需分页读取本学期全部记录：每次只取一页，避免一次性 toArray() 把整表物化（红线1）。
// 只在老师点「生成素材」时调用一次，结果留在面板内存里供切换范围时复用。
async function loadAllRecords(db) {
  const PAGE = 300;
  const out = [];
  let off = 0;
  for (;;) {
    const part = await db.growth_records.where('del').equals(0).offset(off).limit(PAGE).toArray();
    out.push(...part);
    if (part.length < PAGE) break;
    off += PAGE;
  }
  return out;
}

/* ================= AI 评语素材（脱敏 · 唯一外发口） ================= */
// 🔴 代号映射：单次会话、只在内存、不落库、不跨次复用、映射本身不外发。
//    lastGen 保存「最近一次生成素材」用的映射，供同一次使用内回填还原姓名；刷新页面即失效。
let lastGen = null;      // { map: Map<id,alias>, names: Map<id,name>, at: number }

function openAI(students, tab = 'gen') {
  let withGz = true, grain = state.settings.aiDateGrain === 'full' ? 'full' : 'month';
  let all = [], loading = true;                 // 🔴 记录按需载入（loadAllRecords），不再进页面就拉全表

  const p = openPicker({
    title: 'AI 评语素材',
    lead: '这里生成的是<b>要发给 AI 的那一份</b>。真实姓名换成一次性代号，分数、名次、具体日期与他人姓名都会被隐去，<b>照片不参与</b>。',
    body: `
      <div style="padding:12px 14px">
        <div class="seg" id="ai-tab">
          <button data-v="gen">① 生成素材</button><button data-v="back">② 回填评语</button>
        </div>

        <div id="ai-gen" style="margin-top:12px">
${scopeBlockHTML('ai')}
          <div class="field">
            <label>关注类记录 <span class="muted" style="font-weight:400;font-size:11px">负面描述会自动转成「可努力的方向」</span></label>
            <div class="seg sm" id="ai-gz"><button data-v="1" class="on">包含</button><button data-v="0">排除</button></div>
          </div>
          <div class="field">
            <label>日期精度 <span class="muted" style="font-weight:400;font-size:11px">精确日期能定位到具体某天</span></label>
            <div class="seg sm" id="ai-date"><button data-v="month" class="on">只到月</button><button data-v="full">保留完整</button></div>
          </div>
          <div class="save-note" style="margin:6px 0">🔒 已隐去：<b>真实姓名</b>→代号 · 其他同学→「某同学」 · 分数→${esc(MASK.score)} · 名次→${esc(MASK.rank)} · 日期→按月。代号仅本次有效。</div>
          <div class="muted" id="ai-stat" style="font-size:12px;margin-bottom:6px"></div>
          <div class="ai-pre" id="ai-pre"></div>
        </div>

        <div id="ai-back" style="display:none;margin-top:12px">
          <div class="field">
            <label>把 AI 返回的评语粘贴到这里</label>
            <textarea class="ta" id="ai-bin" rows="6" placeholder="同学A：本学期……"></textarea>
          </div>
          <div class="save-note" style="margin:6px 0" id="ai-bnote"></div>
          <button class="btn" id="ai-bdo" style="width:100%">还原成真实姓名</button>
          <div class="ai-pre" id="ai-bpre" style="margin-top:10px"></div>
          <button class="btn ghost" id="ai-bcopy" style="width:100%;margin-top:8px">复制还原结果</button>
        </div>
      </div>`,
    foot: `<button class="btn ghost" data-pclose>关闭</button><button class="btn" id="ai-copy">复制脱敏素材</button>`
  });

  const genBox = p.body.querySelector('#ai-gen');
  const backBox = p.body.querySelector('#ai-back');
  const copyBtn = p.foot.querySelector('#ai-copy');

  // 🔴 范围 + 指定学生：与数据页「成长记录文本」共用同一实现（P2-4）
  const scopeCtl = bindScopeBlock(p.body, 'ai', students, () => refresh());
  const picked = scopeCtl.picked;
  const current = () => scopeCtl.isAll() ? students : students.filter(s => picked.has(s.id));
  const currentRecs = () => scopeCtl.isAll() ? all : all.filter(r => picked.has(r.studentId));
  const allNames = students.map(s => s.name);
  // 🔴 每条记录的正文：日期 + 分类 + 标签 + 评语（+ 图片说明）。
  //    🔴 照片本身绝不出现在素材里；「图片说明」是老师写的文字，等同于评语，会一并被脱敏。
  const aiLine = r => {
    const tg = tagText(r);
    let body = tg ? tg + (r.text ? ' — ' + r.text : '') : (r.text || '');
    const ds = (r.imgDescs || []).filter(Boolean);
    if (ds.length) body += (body ? '　' : '') + '（图片说明：' + ds.join('；') + '）';
    return `${r.date} [${r.category}]${body ? ' ' + body : ''}`;
  };

  let text = '', patterns = [];
  const refresh = () => {
    if (loading) {                                   // 记录还在读 → 明确告知，别让老师以为"没有记录"
      p.body.querySelector('#ai-stat').textContent = '正在载入本学期记录…';
      p.body.querySelector('#ai-pre').textContent = '';
      return;
    }
    const ss = current();
    const rs = (withGz ? currentRecs() : currentRecs().filter(r => r.category !== GUANZHU));
    // 🔴 只对本次选中的学生编号 —— 代号集合最小化
    const map = buildAliasMap(ss);
    const built = buildScrubbedText(ss, rs, { aliasMap: map, names: allNames, grain, rawOf: aiLine });
    text = built.text;
    const nm = new Map(); ss.forEach(s => nm.set(s.id, s.name));
    lastGen = { map, names: nm, at: Date.now() };
    // 高亮「被处理过的地方」——老师一眼能看出哪些内容没有外发
    patterns = [...map.values(), '某同学', MASK.score, MASK.rank];
    p.body.querySelector('#ai-stat').textContent =
      `将外发 ${built.used} 名学生 · ${rs.length} 条记录 · ${text.length} 字　|　已隐去：${describeHits(built.hits)}`;
    p.body.querySelector('#ai-pre').innerHTML = highlight(esc(text), patterns);
    backNote();
  };

  function backNote() {
    const n = p.body.querySelector('#ai-bnote');
    if (!n) return;
    n.innerHTML = lastGen
      ? `本次代号映射生成于 ${new Date(lastGen.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}，共 ${lastGen.map.size} 个代号。<b>用完即失效</b>；刷新页面后无法再还原，请先完成回填。`
      : '还没有可用的代号映射 —— 请先在上一步「生成素材」，再来回填。';
  }

  onSeg(p.body.querySelector('#ai-tab'), v => {
    genBox.style.display = v === 'gen' ? '' : 'none';
    backBox.style.display = v === 'back' ? '' : 'none';
    copyBtn.style.display = v === 'gen' ? '' : 'none';
    if (v === 'back') backNote();
  });
  onSeg(p.body.querySelector('#ai-gz'), v => { withGz = v === '1'; refresh(); });
  onSeg(p.body.querySelector('#ai-date'), v => {
    grain = v; saveSetting('aiDateGrain', v); refresh();
  });

  syncSeg(p.body.querySelector('#ai-tab'), tab);
  genBox.style.display = tab === 'gen' ? '' : 'none';
  backBox.style.display = tab === 'back' ? '' : 'none';
  copyBtn.style.display = tab === 'gen' ? '' : 'none';
  syncSeg(p.body.querySelector('#ai-date'), grain);
  refresh();
  // 🔴 按需载入：面板先开起来（可交互），记录读完再刷新一次预览
  loadAllRecords(state.db)
    .then(rows => { all = rows; loading = false; refresh(); })
    .catch(() => { loading = false; refresh(); });

  copyBtn.onclick = async () => {
    if (loading) { toast('记录还在读取中，稍等一下'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制脱敏素材 · 照片不要发给 AI');
    } catch {
      toast('复制失败，请长按预览区手动复制');
    }
  };

  // ② 回填：用「本次生成素材」的映射把代号还原成真实姓名（🔴 映射不出本机，只在这里反向使用）
  p.body.querySelector('#ai-bdo').onclick = () => {
    const src = p.body.querySelector('#ai-bin').value;
    const box = p.body.querySelector('#ai-bpre');
    if (!src.trim()) { toast('请先粘贴 AI 返回的评语'); return; }
    if (!lastGen) { box.textContent = '没有可用的代号映射，请先在上一步生成素材。'; toast('代号映射已失效，请先重新生成素材'); return; }
    let out = src;
    // 🔴 长代号优先替换，避免「同学A」吃掉「同学AA」的前缀
    const pairs = [...lastGen.map.entries()]
      .map(([id, alias]) => ({ alias, name: lastGen.names.get(id) || '' }))
      .filter(x => x.name)
      .sort((a, b) => b.alias.length - a.alias.length);
    let n = 0;
    for (const { alias, name } of pairs) {
      const re = new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      out = out.replace(re, () => { n++; return name; });
    }
    box.textContent = n ? out : '没有找到本次的代号（内容未改动）。';
    toast(n ? `已还原 ${n} 处姓名` : '没有找到本次的代号');
  };
  p.body.querySelector('#ai-bcopy').onclick = async () => {
    const t = p.body.querySelector('#ai-bpre').textContent;
    if (!t) { toast('先点「还原成真实姓名」'); return; }
    try { await navigator.clipboard.writeText(t); toast('已复制还原结果'); }
    catch { toast('复制失败，请长按手动复制'); }
  };
}
