/* 离线词典：ECDICT 精简版（本地 IndexedDB 缓存优先，失败再走网络） */

import * as db from './db.js';

const KV_KEY = 'dict.json';
// 用模块自身位置解析，保证部署在 GitHub Pages 子路径下也能取到
const URL_DICT = new URL('../data/dict.json', import.meta.url).href;

let lines = null;
let index = null;
let meta = { count: 0, state: 'idle', source: '' };   // idle|loading|cached|network|error
let loading = null;
const parseCache = new Map();

export function status() { return { ...meta }; }
export function ready() { return !!index; }

async function readFromIDB() {
  try {
    const row = await db.get('kv', KV_KEY);
    if (row && typeof row.text === 'string' && row.text.length > 1000) return row.text;
  } catch {}
  return null;
}

async function writeToIDB(text) {
  try { await db.put('kv', { k: KV_KEY, text, saved: Date.now() }); } catch {}
}

function ingest(text, source) {
  const data = JSON.parse(text);
  if (!data || typeof data.recs !== 'string') throw new Error('词典文件格式不正确');
  lines = data.recs.split('\n');
  index = new Map();
  for (let i = 0; i < lines.length; i++) {
    const sp = lines[i].indexOf('\t');
    index.set(sp < 0 ? lines[i] : lines[i].slice(0, sp), i);
  }
  meta = { count: index.size, state: source, source: data.src || 'ECDICT' };
  return meta;
}

export function load(onStatus) {
  if (index) return Promise.resolve(meta);
  if (loading) return loading;
  const notify = s => { meta = { ...meta, ...s }; if (onStatus) onStatus(meta); };

  loading = (async () => {
    notify({ state: 'loading' });
    const cached = await readFromIDB();
    if (cached) {
      try { return ingest(cached, 'cached'); } catch {}
    }
    try {
      const res = await fetch(URL_DICT, { cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const m = ingest(text, 'network');
      writeToIDB(text);                       // 后台落盘，下次秒开
      return m;
    } catch (e) {
      notify({ state: 'error' });
      throw e;
    }
  })();

  loading.catch(() => { loading = null; });
  return loading;
}

function parseLine(i) {
  const cached = parseCache.get(i);
  if (cached) return cached;
  const f = lines[i].split('\t');
  const rec = {
    word: f[0] || '',
    phonetic: f[1] || '',
    translation: f[2] || '',
    frq: +(f[3] || 0),
    collins: +(f[4] || 0),
    oxford: +(f[5] || 0),
    tags: (f[6] || '').split(' ').filter(Boolean),
  };
  if (parseCache.size > 4000) parseCache.clear();
  parseCache.set(i, rec);
  return rec;
}

/* ── 不规则变形表（最高频的那些，规则变形交给下面算法） ── */
const IRREGULAR = {
  "was": "be", "were": "be", "been": "be", "am": "be", "is": "be", "are": "be", "being": "be",
  "went": "go", "gone": "go", "did": "do", "does": "do", "done": "do", "had": "have", "has": "have",
  "said": "say", "made": "make", "took": "take", "taken": "take", "came": "come", "saw": "see",
  "seen": "see", "got": "get", "gotten": "get", "gave": "give", "given": "give", "found": "find",
  "thought": "think", "told": "tell", "became": "become", "left": "leave", "felt": "feel",
  "brought": "bring", "began": "begin", "begun": "begin", "kept": "keep", "held": "hold",
  "wrote": "write", "written": "write", "stood": "stand", "heard": "hear", "meant": "mean",
  "met": "meet", "ran": "run", "paid": "pay", "sat": "sit", "spoke": "speak", "spoken": "speak",
  "led": "lead", "grew": "grow", "grown": "grow", "lost": "lose", "fell": "fall", "fallen": "fall",
  "sent": "send", "built": "build", "understood": "understand", "drew": "draw", "drawn": "draw",
  "broke": "break", "broken": "break", "spent": "spend", "rose": "rise", "risen": "rise",
  "drove": "drive", "driven": "drive", "bought": "buy", "wore": "wear", "worn": "wear",
  "chose": "choose", "chosen": "choose", "ate": "eat", "eaten": "eat", "sold": "sell",
  "sang": "sing", "sung": "sing", "swam": "swim", "swum": "swim", "threw": "throw", "thrown": "throw",
  "caught": "catch", "taught": "teach", "flew": "fly", "flown": "fly", "forgot": "forget",
  "forgotten": "forget", "slept": "sleep", "drank": "drink", "drunk": "drink", "rode": "ride",
  "ridden": "ride", "won": "win", "shot": "shoot", "sought": "seek", "fought": "fight",
  "lay": "lie", "lain": "lie", "laid": "lay", "arose": "arise", "arisen": "arise",
  "bore": "bear", "borne": "bear", "born": "bear", "beat": "beat", "beaten": "beat",
  "bent": "bend", "bit": "bite", "bitten": "bite", "blew": "blow", "blown": "blow",
  "bound": "bind", "burst": "burst", "cast": "cast", "crept": "creep", "dealt": "deal",
  "dug": "dig", "fed": "feed", "fled": "flee", "forbade": "forbid", "forbidden": "forbid",
  "froze": "freeze", "frozen": "freeze", "hung": "hang", "hid": "hide", "hidden": "hide",
  "hit": "hit", "hurt": "hurt", "knelt": "kneel", "knew": "know", "known": "know",
  "lent": "lend", "lit": "light", "put": "put", "quit": "quit", "read": "read",
  "rang": "ring", "rung": "ring", "seized": "seize", "set": "set", "shook": "shake",
  "shaken": "shake", "shone": "shine", "shut": "shut", "sank": "sink", "sunk": "sink",
  "slid": "slide", "split": "split", "spread": "spread", "sprang": "spring", "stole": "steal",
  "stolen": "steal", "stuck": "stick", "stung": "sting", "struck": "strike", "swore": "swear",
  "sworn": "swear", "swept": "sweep", "tore": "tear", "torn": "tear", "woke": "wake",
  "woken": "wake", "wept": "weep", "wound": "wind",
  "children": "child", "men": "man", "women": "woman", "feet": "foot", "teeth": "tooth",
  "geese": "goose", "mice": "mouse", "people": "person", "lives": "life", "wives": "wife",
  "knives": "knife", "leaves": "leaf", "halves": "half", "selves": "self", "wolves": "wolf",
  "shelves": "shelf", "thieves": "thief", "loaves": "loaf", "scarves": "scarf",
  "criteria": "criterion", "phenomena": "phenomenon", "analyses": "analysis",
  "crises": "crisis", "theses": "thesis", "hypotheses": "hypothesis", "diagnoses": "diagnosis",
  "parentheses": "parenthesis", "emphases": "emphasis", "oases": "oasis", "axes": "axis",
  "indices": "index", "appendices": "appendix", "matrices": "matrix", "vertices": "vertex",
  "alumni": "alumnus", "cacti": "cactus", "fungi": "fungus", "nuclei": "nucleus",
  "stimuli": "stimulus", "radii": "radius", "media": "medium", "bacteria": "bacterium",
  "curricula": "curriculum", "memoranda": "memorandum", "oxen": "ox",
  "better": "good", "best": "good", "worse": "bad", "worst": "bad", "more": "much",
  "most": "much", "further": "far", "furthest": "far", "less": "little", "least": "little",
};

function variants(w) {
  const out = [];
  const push = s => { if (s && s.length >= 2 && s !== w && !out.includes(s)) out.push(s); };
  const dbl = s => s.length > 2 && s[s.length - 1] === s[s.length - 2];

  if (w.endsWith("'s")) push(w.slice(0, -2));
  if (w.endsWith("s'")) push(w.slice(0, -2));
  if (w.endsWith("ies") && w.length > 4) push(w.slice(0, -3) + 'y');
  if (w.endsWith("ves") && w.length > 4) { push(w.slice(0, -3) + 'f'); push(w.slice(0, -3) + 'fe'); }
  if (w.endsWith("es") && w.length > 3) push(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) push(w.slice(0, -1));
  if (w.endsWith("ied") && w.length > 4) push(w.slice(0, -3) + 'y');
  if (w.endsWith("ed") && w.length > 3) {
    const b = w.slice(0, -2);
    push(b); push(b + 'e');
    if (dbl(b)) push(b.slice(0, -1));
  }
  if (w.endsWith("ing") && w.length > 5) {
    const b = w.slice(0, -3);
    push(b); push(b + 'e');
    if (dbl(b)) push(b.slice(0, -1));
    if (b.endsWith('y')) push(b);
  }
  if (w.endsWith("iest") && w.length > 5) push(w.slice(0, -4) + 'y');
  if (w.endsWith("ier") && w.length > 4) push(w.slice(0, -3) + 'y');
  if (w.endsWith("est") && w.length > 4) {
    const b = w.slice(0, -3); push(b); push(b + 'e'); if (dbl(b)) push(b.slice(0, -1));
  }
  if (w.endsWith("er") && w.length > 3) {
    const b = w.slice(0, -2); push(b); push(b + 'e'); if (dbl(b)) push(b.slice(0, -1));
  }
  if (w.endsWith("ly") && w.length > 4) { push(w.slice(0, -2)); push(w.slice(0, -2) + 'e'); }
  return out;
}

/** ECDICT 里屈折形式的释义常写成「（study的复数）」「（stop的过去式和过去分词）」这样的提示 */
const LEMMA_HINT = /[（(]\s*([a-zA-Z][a-zA-Z'’\- ]{0,24}?)\s*的\s*(?:复数|过去式|过去分词|现在分词|比较级|最高级|第三人称单数|名词复数|ing形式)[^)）]{0,12}[)）]/;

function lemmaOf(w, rec) {
  const m = String(rec.translation || '').match(LEMMA_HINT);
  if (m) {
    const base = m[1].trim().toLowerCase();
    if (base !== w && index.has(base)) return base;
  }
  const irr = IRREGULAR[w];
  if (irr && irr !== w && index.has(irr)) return irr;
  return null;
}

/** 精确查询 */
export function lookup(word) {
  if (!index) return null;
  const w = String(word || '').toLowerCase().replace(/[’]/g, "'").replace(/^[^a-z]+|[^a-z']+$/g, '');
  if (!w) return null;
  let i = index.get(w);
  if (i !== undefined) {
    const rec = parseLine(i);
    return { ...rec, matched: w, exact: true, lemma: lemmaOf(w, rec) };
  }

  const irr = IRREGULAR[w];
  if (irr && index.has(irr)) {
    const r = parseLine(index.get(irr));
    return { ...r, matched: irr, exact: false, via: '原形 ' + irr, lemma: null };
  }
  // 收集所有候选，按「常用程度」挑最好的，而不是碰运气取第一个。
  // 例：comes 的候选有 com（缩写）和 come —— come 的词频远高于 com，必须选 come。
  const cands = [];
  for (const v of variants(w)) {
    const j = index.get(v);
    if (j !== undefined) cands.push({ v, r: parseLine(j) });
  }
  if (cands.length) {
    cands.sort((a, b) => {
      const fa = a.r.frq || 1e9, fb = b.r.frq || 1e9;   // 词频数字越小越常用
      if (fa !== fb) return fa - fb;
      return (b.r.collins || 0) - (a.r.collins || 0);
    });
    const best = cands[0];
    return { ...best.r, matched: best.v, exact: false, via: '原形 ' + best.v, lemma: null };
  }
  return null;
}

/** 只取原形，带缓存。用于给文中每个词判断「是不是已收藏的生词」——
 *  存进去的是原形（run），文中却是变形（running），必须还原后才能比对。 */
const baseMemo = new Map();
export function resolveBase(word) {
  const w = String(word || '').toLowerCase().replace(/[’]/g, "'");
  if (!w) return w;
  const hit = baseMemo.get(w);
  if (hit !== undefined) return hit;
  let base = w;
  try {
    const r = lookup(w);
    // 精确命中的词也可能有词形提示（words 的释义里写着「word 的复数」），要优先用它
    if (r) base = (r.exact && r.lemma) ? r.lemma : (r.matched || w);
  } catch {}
  if (baseMemo.size > 30000) baseMemo.clear();
  baseMemo.set(w, base);
  return base;
}

/** 模糊搜索（前缀），用于词典页 */
export function suggest(prefix, limit = 12) {
  if (!index) return [];
  const p = String(prefix || '').toLowerCase();
  if (p.length < 2) return [];
  const out = [];
  for (const w of index.keys()) {
    if (w.startsWith(p)) { out.push(w); if (out.length >= limit * 4) break; }
  }
  return out.sort((a, b) => a.length - b.length).slice(0, limit);
}
