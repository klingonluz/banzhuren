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
      <p class="muted" style="margin:2px 0 8px">生成的是<b>给 AI 看的那一份</b>：保留「什么样的学生」，去掉「是谁」。素材里的姓名会换成一次性随机代号（如「同学K7X」），<b>每次生成都不同</b>，两次外发之间对不上号。</p>
      <p class="muted" style="margin:0 0 8px">照片一张都不发。想说明画面，就在记录时写一句「图片说明」——那句文字会进素材，同样会被脱敏。关注类记录共 ${gzTotal} 条，可以一起带上；其中的负面描述会自动转成「可努力的方向」。</p>
      <button class="btn mt" id="an-ai">生成 AI 评语素材</button>
      <button class="btn ghost mt" id="an-ai-back">把 AI 返回的评语还原成真实姓名</button>
    </div>

    <div class="card">
      <h2>🛡️ 外发前须知</h2>
      <div class="save-note" style="border:none">
        ① 未满 14 周岁的信息属《个人信息保护法》第 28 条<b>敏感个人信息</b>，教师不能代替学生授权。<br>
        ② 本工具只做<b>技术脱敏</b>；是否外发、发给谁，由你按学校要求判断。<br>
        ③ 照片一律不进 AI 输出；要说明画面就写一句文字。<br>
        ④ 复制前先扫一眼预览。
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
// 🔴 代号映射：一个「使用周期」内稳定 —— 从生成到回填成功之前，同一个学生始终是同一个代号。
//    为什么必须稳定：素材发给 AI 后，返回里只有代号；回填时若代号已经换过，就再也还原不回来。
//    什么时候换：回填成功后自动作废（下次生成是全新一套）；也可点「🔄 换一批新代号」主动作废。
// 🔴 存储用会话存储（sessionStorage），只存「学生 id ↔ 代号」这一对，**不含真实姓名**（真名按 id 现查）。
//    为什么不用内存变量：手机上切走再回来，页面常被系统整个重载，内存里的映射会丢，回填就白做了。
//    什么时候清：回填成功打 used 标记（下次生成换新码）；「换一批」与关闭标签页即彻底清除。
const GEN_KEY = 'bzr_alias_gen';   // 只存 id + 代号；不含姓名，落盘也无泄露价值

function loadGen() {
  try {
    const raw = sessionStorage.getItem(GEN_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !Array.isArray(o.pairs) || !o.pairs.length) return null;
    return { map: new Map(o.pairs.map(p => [p[0], p[1]])), at: o.at || 0, used: !!o.used };
  } catch (_) { return null; }
}
function saveGen(map, at, used) {
  try {
    sessionStorage.setItem(GEN_KEY, JSON.stringify({ at: at || 0, used: !!used, pairs: [...map.entries()] }));
  } catch (_) {}
}
function clearGen() {
  try { sessionStorage.removeItem(GEN_KEY); } catch (_) {}
}
let lastGen = null;      // { map: Map<id,alias>, at: 时间戳, used: 是否已用于回填 }

function openAI(students, tab = 'gen') {
  let withGz = true, grain = state.settings.aiDateGrain === 'full' ? 'full' : 'month';
  let all = [], loading = true;                 // 🔴 记录按需载入（loadAllRecords），不再进页面就拉全表
  lastGen = loadGen();                          // 🔴 与存储对齐：页面被系统重载后变量是空的，映射还在会话存储里

  const p = openPicker({
    title: 'AI 评语素材',
    lead: '要发给 AI 的那一份。姓名换成一次性代号，其他同学用泛称，<b>照片不参与</b>。',
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
          <div class="save-note" id="ai-mask" style="margin:6px 0"></div>
          <div class="muted" id="ai-stat" style="font-size:12px;margin-bottom:6px"></div>
          <div class="save-note" id="ai-batch" style="margin:0 0 6px"></div>
          <button class="btn tiny" id="ai-regen" style="margin-bottom:8px">🔄 换一批新代号</button>
          <div class="ai-pre" id="ai-pre"></div>
        </div>

        <div id="ai-back" style="display:none;margin-top:12px">
          <div class="field">
            <label>把 AI 返回的评语粘贴到这里</label>
            <textarea class="ta" id="ai-bin" rows="6" placeholder="同学K7X：本学期……"></textarea>
          </div>
          <div class="save-note" style="margin:6px 0" id="ai-bnote"></div>
          <button class="btn" id="ai-bdo" style="width:100%">还原成真实姓名</button>
          <div id="ai-bwarn" hidden style="margin:8px 0 0;font-size:12px;color:#a32d2d"></div>
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
      renderBatch();
      renderMask();
      return;
    }
    const ss = current();
    const rs = (withGz ? currentRecs() : currentRecs().filter(r => r.category !== GUANZHU));
    // 🔴 代号：本次「使用周期」内已发过的一律沿用（否则复制走的素材再也还原不回来）；
    //    只有「从没发过」或「上一批已用于回填」时才抽新码 —— 后者保证跨次外发不可关联。
    const saved = loadGen();
    const reuse = !!(saved && !saved.used);
    const map = buildAliasMap(ss, { keep: reuse ? saved.map : null });
    const at = reuse ? saved.at : Date.now();
    lastGen = { map, at, used: false };
    const built = buildScrubbedText(ss, rs, { aliasMap: map, names: allNames, grain, rawOf: aiLine });
    text = built.text;
    // 🔴 只在有学生入选时落盘：避免「临时取消选人看一眼」把已有映射清掉
    if (map.size) saveGen(map, at, false);
    // 高亮「被处理过的地方」——老师一眼能看出哪些内容没有外发
    patterns = [...map.values(), '某同学', MASK.score, MASK.rank];
    p.body.querySelector('#ai-stat').textContent =
      `将外发 ${built.used} 名学生 · ${rs.length} 条记录 · ${text.length} 字　|　已隐去：${describeHits(built.hits)}`;
    renderBatch();
    renderMask();
    p.body.querySelector('#ai-pre').innerHTML = highlight(esc(text), patterns);
    backNote();
  };

  // 批次提示：告诉老师「现在该复制哪一份」——每次生成的代号都不同，复制错版本就白填
  const hhmmss = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function renderBatch() {
    const b = p.body.querySelector('#ai-batch');
    if (!b) return;
    b.innerHTML = (lastGen && lastGen.map.size)
      ? `本次代号生成于 <b>${hhmmss(lastGen.at)}</b> · 共 ${lastGen.map.size} 个｜请复制<b>这一份</b>发给 AI（回填成功前代号不会变）`
      : '当前没有学生入选，先选一下范围再复制。';
  }

  // 🔒「已经隐去了什么」——随日期精度开关变：选了「保留完整」就不能再写「日期→按月」。
  //    不列分数 / 名次：记录端已要求不写（`record.js` 的 RULE_TIP），这里只在真的打码时才由统计行报出。
  function renderMask() {
    const m = p.body.querySelector('#ai-mask');
    if (!m) return;
    m.innerHTML = '🔒 已隐去：<b>真实姓名</b>→一次性代号 · 其他同学→「某同学」 · 具体日期→'
      + (grain === 'full' ? '保留完整' : '只到月');
  }

  function backNote() {
    const n = p.body.querySelector('#ai-bnote');
    if (!n) return;
    n.innerHTML = (lastGen && lastGen.map.size)
      ? `本次代号生成于 <b>${hhmmss(lastGen.at)}</b> · 共 ${lastGen.map.size} 个。<b>回填成功前代号不会变</b>（刷新、切走再回来都还在）；回填成功后自动作废，下次生成是全新代号。`
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

  // ② 回填：用本次映射把代号还原成真实姓名（🔴 映射不出本机，只在这里反向使用）
  //    真名按 id 现查（映射里从来不含姓名）⇒ 会话存储里那份即使被读到，也认不出是谁。
  const nameById = () => new Map(students.map(s => [s.id, s.name]));
  // 🔴 容错：AI 常把「同学K7X」抄成「同学 K7X」「同学k7x」——忽略大小写、容忍字间空格，
  //    否则一处抄错就整条还原不回来（这是随机代号相比「同学A」新增的风险）。
  const escCh = c => String(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aliasRe = (alias, global) =>
    new RegExp(String(alias).split('').map(escCh).join('\\s*'), global ? 'gi' : 'i');

  p.body.querySelector('#ai-bdo').onclick = () => {
    const src = p.body.querySelector('#ai-bin').value;
    const box = p.body.querySelector('#ai-bpre');
    const warn = p.body.querySelector('#ai-bwarn');
    if (!src.trim()) { toast('请先粘贴 AI 返回的评语'); return; }
    const cur = loadGen();
    if (!cur || !cur.map.size) {
      box.textContent = '没有可用的代号映射，请先在上一步生成素材。';
      toast('代号映射已失效，请先重新生成素材'); return;
    }
    const nm = nameById();
    // 代号等长；仍保留「长码优先」以防将来改长度
    const pairs = [...cur.map.entries()]
      .map(([id, alias]) => ({ alias, name: nm.get(id) || '' }))
      .filter(x => x.name)
      .sort((a, b) => b.alias.length - a.alias.length);
    let out = src, hit = 0;
    const missed = [];
    for (const { alias, name } of pairs) {
      if (!aliasRe(alias, false).test(src)) { missed.push(alias); continue; }
      out = out.replace(aliasRe(alias, true), () => { hit++; return name; });
    }
    box.textContent = hit ? out : '没有找到本次的代号（内容未改动）。';
    if (warn) {
      warn.hidden = !missed.length;
      warn.textContent = missed.length
        ? `${missed.length} 个代号在 AI 返回里没出现（可能被改写，或这条没写）：${missed.slice(0, 4).join('、')}${missed.length > 4 ? ' 等' : ''}`
        : '';
    }
    // 🔴 回填成功 → 打 used 标记：下次生成自动换一批全新代号（跨次外发无法关联）
    if (hit) { saveGen(cur.map, cur.at, true); lastGen = { map: cur.map, at: cur.at, used: true }; backNote(); }
    toast(hit ? `已还原 ${hit} 处姓名` : '没有找到本次的代号');
  };

  // 🔄 主动作废当前这批代号（例：上次复制走却没真用上，想重新开始）
  p.body.querySelector('#ai-regen').onclick = () => {
    if (!loadGen()) { toast('还没有代号，先点「生成素材」'); return; }
    clearGen();
    refresh();
    toast('已换一批新代号，请重新复制素材');
  };
  p.body.querySelector('#ai-bcopy').onclick = async () => {
    const t = p.body.querySelector('#ai-bpre').textContent;
    if (!t) { toast('先点「还原成真实姓名」'); return; }
    try { await navigator.clipboard.writeText(t); toast('已复制还原结果'); }
    catch { toast('复制失败，请长按手动复制'); }
  };
}
