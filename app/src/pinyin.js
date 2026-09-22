// 拼音首字母（零字典）：借浏览器内置的「汉语拼音排序规则」反推，不下载任何拼音表。
//
// 原理：为 A–Z（拼音里没有 i / u / v 开头的音节）各准备一组常用字，
//       用拼音排序取其中最小者作为该字母的「下界」；
//       一个汉字落在哪两个下界之间，它的拼音首字母就是哪个。
// 优点：零体积、离线可用、跟着浏览器 ICU 走；缺点：多音字按默认读音判断，
//       常见姓氏读音由下面的 SURNAME_FIX 纠正，个别仍不对的可在名单里手工修改。

const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
const CANDIDATES = {
  A: '阿啊安昂奥', B: '八巴白班包北本比边别冰波不', C: '擦才参仓草层叉产常车成吃冲出春词从村',
  D: '搭大代但当到得灯地点掉丁东都短对多', E: '鹅蛾额饿恩儿耳', F: '发法翻方飞分风夫',
  G: '该干刚高哥给根工古瓜关光归国', H: '哈海汉好河黑很红后胡花黄回火',
  J: '鸡机几家间讲交脚接姐今京九就局卷', K: '卡开看考可肯空口苦快宽',
  L: '拉来蓝老了冷里连两林六龙楼路乱罗', M: '妈麻马买满毛没美门米面苗民明摸某木',
  N: '那拿奶南难脑呢内能你年鸟宁牛农女暖诺', O: '哦噢欧偶藕', P: '怕拍盘跑陪朋批片票品平破普',
  Q: '七期其千前强桥切亲青请穷求去全却群', R: '然让热人日容肉如软若',
  S: '撒三色森沙山上少社身生十手书数水说四送苏算岁孙所', T: '他台谈堂套特疼提天条听同头图团推托',
  W: '挖外完王为文我无五物', X: '夕西下先想小写心星修许选学寻迅',
  Y: '丫压牙言眼样要也一以因应用有于元月云', Z: '匝再早怎增扎站张找者真正之中周主转装准子走最尊作'
};
// 常见姓氏读音（ICU 按普通读音判断会偏，只对姓名第一个字生效）
const SURNAME_FIX = {
  单: 'S', 仇: 'Q', 区: 'O', 查: 'Z', 乐: 'Y', 覃: 'Q', 曾: 'Z', 尉: 'Y',
  解: 'X', 折: 'S', 阚: 'K', 秘: 'B', 郇: 'X', 冼: 'X', 逄: 'P', 隗: 'K',
  郗: 'X', 过: 'G', 应: 'Y', 曲: 'Q', 华: 'H'
};

const HAN = /[\u3400-\u9fff]/;
const LATIN = /[a-zA-Z]/;

let coll = null;
let anchors = null;      // { A:'阿', B:'八', ... }；null = 本机不支持
let checked = false;

function collator() {
  if (coll === null) {
    try { coll = new Intl.Collator('zh-Hans-CN-u-co-pinyin'); } catch (e) { coll = false; }
  }
  return coll || null;
}

// 本机是否支持「按拼音排序」（决定能不能反推首字母）
export function pinyinSupported() {
  if (checked) return !!anchors;
  checked = true;
  const c = collator();
  if (!c) return false;
  const table = {};
  for (const L of LETTERS) {
    const chars = Array.from(CANDIDATES[L]);
    table[L] = chars.reduce((m, ch) => (c.compare(ch, m) < 0 ? ch : m), chars[0]);
  }
  // 自检：得到的下界必须按拼音升序，否则说明本机没有拼音排序规则 → 放弃
  for (let i = 1; i < LETTERS.length; i++) {
    if (c.compare(table[LETTERS[i - 1]], table[LETTERS[i]]) >= 0) return false;
  }
  anchors = table;
  return true;
}

function initialOf(ch) {
  if (!HAN.test(ch)) return LATIN.test(ch) ? ch.toUpperCase() : '';   // 英文名 / 少数民族名直接取字母
  let hit = '';
  for (let i = 0; i < LETTERS.length; i++) {
    if (collator().compare(ch, anchors[LETTERS[i]]) >= 0) hit = LETTERS[i]; else break;
  }
  return hit;
}

// 「张梓涵」→ 'ZZH'；空姓名 / 本机不支持拼音排序时返回 ''
export function nameInitials(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s || !pinyinSupported()) return '';
  let out = '';
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (i === 0 && HAN.test(ch) && SURNAME_FIX[ch]) out += SURNAME_FIX[ch];
    else out += initialOf(ch);
  }
  return out;
}
