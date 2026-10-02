/* 精读 LexiRead —— 主程序 */

import * as db from './db.js';
import * as dict from './dict.js';
import * as ai from './ai.js';
import * as tts from './tts.js';
import * as srs from './srs.js';
import { parseArticle, tokensOf, countWords } from './text.js';
import { importFile, ACCEPT, FORMATS } from './importers.js';
import * as sync from './sync.js';
import {
  $, $$, esc, toast, renderRich, openModal, closeModal, isModalOpen,
  highlightWord, clozeSentence, fmtDate, readingTime, splitSenses, TAG_LABEL,
} from './ui.js';

/* ══════════════════════════  设置  ══════════════════════════ */

const APP_VERSION = '2.0.0';           // 每次发布递增，界面上能看到
const SET_KEY = 'lexiread.settings';
const DEFAULT_SETTINGS = {
  fontSize: 20, lineHeight: 195, width: 680, font: 'serif',
  theme: 'auto', autoAI: true, ttsRate: 95, ttsVoice: '',
  paraStyle: 'web',       // 与 SentiRead 一致：段间空行、不缩进
  justify: true,          // 两端对齐 + 自动断词
  readingMode: 'page',    // page=翻页（像书一样） scroll=滚动
  columns: 'auto',        // auto=宽屏两栏 one=始终一栏
  showTranslation: false, // 中文对照
  annotate: 'off',        // 分级注释：off / cet4 / cet6 / ky / toefl / gre
  annotatePhonetic: false,// 注释里是否带音标
  syncAiKey: false,       // 是否把 AI 配置（含 API Key）同步到其它设备
};
let settings = (() => {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SET_KEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
})();
function saveSettings() {
  localStorage.setItem(SET_KEY, JSON.stringify(settings));
  localStorage.setItem(SET_KEY + '.updated', String(Date.now()));
  applySettings();
  scheduleSync();
}

function applySettings() {
  const r = document.documentElement.style;
  r.setProperty('--fs', settings.fontSize + 'px');
  r.setProperty('--lh', String(settings.lineHeight / 100));
  r.setProperty('--measure', settings.width + 'px');
  r.setProperty('--ff', settings.font === 'serif' ? 'var(--ff-serif)'
    : settings.font === 'mono' ? 'var(--ff-mono)' : 'var(--ff-sans)');
  let t = settings.theme;
  if (t === 'auto') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.para = settings.paraStyle === 'web' ? 'web' : 'book';
  document.documentElement.dataset.justify = settings.justify ? '1' : '0';
  document.documentElement.dataset.mode = settings.readingMode === 'scroll' ? 'scroll' : 'page';
  tts.configure({ rate: settings.ttsRate / 100, voiceURI: settings.ttsVoice });
}

/* ══════════════════════════  状态  ══════════════════════════ */

const S = {
  articles: [],
  vocab: new Map(),
  view: 'library',
  cur: null,              // { article, parsed }
  filter: 'all',
  review: { queue: [], i: 0, revealed: false, cur: null, done: 0 },
  panel: null,
  aiAbort: null,
  lastAI: null,
  vFilter: 'all',
};

const parsedCache = new Map();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ══════════════════════════  主题 / 词典状态  ══════════════════════════ */

function setDot(cls, title) {
  const d = $('#dict-dot');
  d.className = 'sync-dot' + (cls ? ' ' + cls : '');
  d.title = title || '';
}

async function ensureDict() {
  if (dict.ready()) return;
  setDot('busy', '词典加载中…');
  try {
    const m = await dict.load(st => {
      if (st.state === 'loading') setDot('busy', '词典加载中…');
    });
    setDot('ok', `离线词典已就绪 · ${m.count.toLocaleString()} 条`);
  } catch (e) {
    setDot('err', '词典加载失败：' + e.message);
  }
}

/* ══════════════════════════  路由  ══════════════════════════ */

function setView(name, opts = {}) {
  S.view = name;
  $$('.view').forEach(v => v.classList.toggle('is-on', v.id === 'view-' + name));
  const tabMap = { welcome: 'library', library: 'library', reader: 'library', vocab: 'vocab', review: 'vocab', settings: 'settings' };
  const tb = $('#tabbar');
  if (tb) tb.style.display = name === 'welcome' ? 'none' : '';
  $$('#tabbar .tab').forEach(t => t.classList.toggle('is-on', t.dataset.tab === tabMap[name]));
  $('#btn-back').hidden = !(name === 'reader' || name === 'review');
  document.body.classList.toggle('focus-mode', false);
  $$('.tool').forEach(t => t.classList.remove('is-on'));

  const titles = { welcome: '精读', library: '精读', reader: S.cur?.article.title || '阅读', vocab: '生词本', review: '复习', settings: '设置' };
  const tbTitle = $('#tb-title'), back = $('#btn-back'), tr = $('#tb-right');
  if (name === 'welcome') {
    if (tbTitle) tbTitle.textContent = '精读 LexiRead';
    if (back) back.hidden = true;
    if (tr) tr.hidden = true;
  } else if (tr) {
    tr.hidden = false;
  }
  $('#tb-title').textContent = titles[name] || '精读';

  document.body.classList.toggle('paged', name === 'reader' && isPaged());
  const rf = $('#reader-foot');
  if (rf) rf.hidden = !(name === 'reader' && isPaged());
  if (name === 'welcome') renderWelcome();
  if (name === 'library') renderLibrary();
  if (name === 'vocab') renderVocab();
  if (name === 'settings') { renderSettings(); renderSync(); }
  if (name === 'review') { /* 由 startReview 驱动 */ }
  if (!opts.keepScroll) window.scrollTo({ top: 0 });
  closePanel();
}

/* ══════════════════════════  书架  ══════════════════════════ */

function renderLibrary() {
  const list = $('#article-list');
  const arts = [...S.articles].sort((a, b) => (b.lastRead || b.created) - (a.lastRead || a.created));

  const due = [...S.vocab.values()].filter(c => srs.isDue(c)).length;
  const mastered = [...S.vocab.values()].filter(c => c.stage === 'mastered').length;
  const badge = $('#lib-due-badge');
  badge.hidden = !due; badge.textContent = due;
  const tb = $('#tab-due');
  tb.hidden = !due; 

  $('#lib-stats').innerHTML = [
    ['文章', arts.length],
    ['生词', S.vocab.size],
    ['待复习', due],
    ['已掌握', mastered],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');

  if (!arts.length) {
    list.innerHTML = `<div class="empty">
      还没有文章。<br>点上面的「＋ 导入文章」，把一段英文粘贴进来就能开始精读。
    </div>`;
    return;
  }

  list.innerHTML = arts.map(a => {
    const prog = Math.round((a.progress || 0) * 100);
    const sub = [
      `<span class="pill">${a.wordCount || 0} 词</span>`,
      `<span class="pill">${readingTime(a.wordCount || 0)}</span>`,
      a.wordCount ? `<span class="pill${prog >= 99 ? '' : ' due'}">${prog >= 99 ? '已读完' : '读到 ' + prog + '%'}</span>` : '',
      `<span>${fmtDate(a.lastRead || a.created)}</span>`,
    ].filter(Boolean).join('');
    return `<div class="card" data-id="${a.id}">
      <div class="card-main" data-open="${a.id}">
        <div class="card-title">${esc(a.title)}</div>
        <div class="card-sub">${sub}</div>
      </div>
      <button class="card-x" data-del="${a.id}" title="删除">✕</button>
    </div>`;
  }).join('');
}

/* ══════════════════════════  阅读器  ══════════════════════════ */

/** 解析结果缓存；正文按需从 bodies 存储读取，启动时不再全量载入 */
async function parsedOf(article) {
  if (parsedCache.has(article.id)) return parsedCache.get(article.id);
  const body = await db.get('bodies', article.id);
  if (!body || typeof body.raw !== 'string') return null;
  const p = parseArticle(body.raw, article.title);
  parsedCache.set(article.id, p);
  return p;
}

async function openArticle(id) {
  const article = S.articles.find(a => a.id === id);
  if (!article) return;
  let parsed;
  try {
    parsed = await parsedOf(article);
  } catch (e) {
    toast('读取正文失败：' + e.message, 4000);
    return;
  }
  if (!parsed) { toast('找不到这篇文章的正文，可能在清理数据时丢失了'); return; }

  S.cur = { article, parsed };
  article.lastRead = Date.now();
  article.updated = touch();
  persistArticle(article);                              // 只写元数据，很轻

  if (settings.annotate && settings.annotate !== 'off' && !dict.ready()) {
    try { await dict.load(); } catch {}          // 注释需要词典，先等它到位
  }
  renderReader();
  setView('reader');
  if (settings.showTranslation) setTimeout(() => applyCachedTranslations(), 60);
  if (isPaged()) {
    requestAnimationFrame(() => relayoutPages(false));
  } else {
    requestAnimationFrame(() => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      if (h > 0 && article.progress > 0.005) window.scrollTo({ top: article.progress * h });
    });
  }
}

/* ══════════════════════════  翻页引擎（像书一样）  ══════════════════════════ */

const PG = { page: 0, total: 1, step: 0, w: 0, cols: 1, headings: [] };
const COL_GAP = 56;                 // 两栏之间的中缝
const MIN_TWO_COL = 720;            // 视口宽于这个才分两栏

const isPaged = () => settings.readingMode !== 'scroll';

/** 视口高度 = 窗口 − 顶栏 − 页眉 − 页脚 */
function sizeViewport() {
  const vp = $('#reader-viewport');
  if (!vp) return 0;
  const top = $('#topbar');
  const head = $('#reader-head');
  const foot = $('#reader-foot');
  const topH = top ? top.offsetHeight : 0;
  const headH = head ? head.offsetHeight : 0;
  const footH = foot && !foot.hidden ? foot.offsetHeight : 0;
  const h = Math.max(200, window.innerHeight - topH - headH - footH - 6);
  vp.style.height = h + 'px';
  return h;
}

/** 按视口算栏宽，并把正文排成横向的栏 */
function applyColumns() {
  const vp = $('#reader-viewport');
  const body = $('#reader-body');
  if (!vp || !body) return null;
  // 页边距按屏宽自适应：手机窄一点、宽屏像书页一样留白多一些
  const vw = window.innerWidth;
  const padx = vw >= 1000 ? 46 : vw >= 700 ? 34 : 22;
  vp.style.setProperty('--padx', padx + 'px');
  const cs = getComputedStyle(vp);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0;
  if (!vp.clientWidth) return null;                    // 还没显示，等下一帧
  const W = Math.max(200, vp.clientWidth - padX);      // 正文可用的净宽
  const two = settings.columns !== 'one' && W >= MIN_TWO_COL;
  const cols = two ? 2 : 1;
  // 栏间距永远保留：否则单栏时右边会漏出下一条栏的边缘
  const gap = COL_GAP;
  const colW = two ? Math.floor((W - gap) / 2) : W;

  body.style.columnWidth = colW + 'px';
  body.style.columnGap = gap + 'px';
  body.style.width = W + 'px';
  body.style.height = '100%';

  PG.cols = cols;
  PG.w = W;
  PG.step = W + gap;                 // 翻一页前进的距离
  return { W, gap };
}

/** 量出总页数、记录每个标题所在的横向位置 */
function measurePages() {
  const body = $('#reader-body');
  if (!body) return;
  const total = body.scrollWidth;
  PG.total = Math.max(1, Math.round((total + COL_GAP) / Math.max(1, PG.step)));
  // 章节标题与每个段落的横向位置（页眉副标题、进度百分比都要用）
  const bodyRect = body.getBoundingClientRect();
  PG.headings = [];
  PG.blockX = [];
  for (const el of $$('#reader-body [data-bi]')) {
    const x = el.getBoundingClientRect().left - bodyRect.left;
    const bi = +el.dataset.bi;
    PG.blockX[bi] = x;
    if (el.tagName === 'H2') PG.headings.push({ x, text: (el.textContent || '').trim(), bi });
  }
}

function updatePageChrome() {
  const pgEl = $('#reader-page');
  if (pgEl) {
    let pct = 0;
    if (S.cur && PG.blockX && PG.blockX.length) {
      const cut = PG.page * PG.step + 4;
      let bi = 0;
      for (let i = 0; i < PG.blockX.length; i++) {
        if (PG.blockX[i] === undefined) continue;
        if (PG.blockX[i] <= cut) bi = i; else break;
      }
      const before = (PG.blockWords && PG.blockWords[bi]) || 0;
      const total = S.cur.parsed.words || 1;
      pct = Math.max(0, Math.min(100, before / total * 100));
    }
    pgEl.textContent = `${PG.page + 1} / ${PG.total} · ${pct.toFixed(2)}%`;
  }
  $$('[data-action="page-prev"]').forEach(b => b.toggleAttribute('disabled', PG.page <= 0));
  $$('[data-action="page-next"]').forEach(b => b.toggleAttribute('disabled', PG.page >= PG.total - 1));
  const sub = $('#reader-sub');
  if (sub) {
    const x = PG.page * PG.step + 4;
    let cur = '';
    for (const h of PG.headings) { if (h.x <= x) cur = h.text; else break; }
    sub.textContent = cur && cur !== (S.cur?.parsed.title || '') ? cur : '';
  }
}

function goPage(p, smooth = true) {
  if (!isPaged() || !S.cur) return;
  const body = $('#reader-body');
  if (!body) return;
  PG.page = Math.max(0, Math.min(PG.total - 1, p));
  body.style.transition = smooth ? '' : 'none';
  body.style.transform = `translateX(${-PG.page * PG.step}px)`;
  if (!smooth) requestAnimationFrame(() => { body.style.transition = ''; });
  updatePageChrome();
  if (settings.showTranslation && !trRunning) {
    clearTimeout(goPage._trT);
    goPage._trT = setTimeout(() => {
      translateCurrentPage({ silent: true }).catch(() => {});
    }, 450);
  }
  if (S.cur.article) {
    S.cur.article.progress = PG.total > 1 ? PG.page / (PG.total - 1) : 0;
    S.cur.article.updated = touch();
    persistArticle(S.cur.article);
    scheduleSync();
  }
}

/** 重排 + 重新分页（首次渲染、改设置、转屏都走这里） */
function relayoutPages(keepRatio = true, retry = 0) {
  if (!isPaged() || !S.cur) return;
  const ratio = keepRatio
    ? (PG.total > 1 ? PG.page / (PG.total - 1) : 0)
    : (S.cur.article.progress || 0);
  sizeViewport();
  if (!applyColumns()) {
    if (retry < 8) requestAnimationFrame(() => relayoutPages(keepRatio, retry + 1));
    return;
  }
  requestAnimationFrame(() => {
    measurePages();
    const target = Math.round(ratio * Math.max(0, PG.total - 1));
    goPage(target, false);
  });
}

/** 从当前视口位置朗读（翻页模式下就是当前页第一句） */
function firstSentenceOnScreen() {
  if (!S.cur) return 0;
  if (isPaged()) {
    const body = $('#reader-body');
    if (!body) return 0;
    const rect = body.getBoundingClientRect();
    const cut = PG.page * PG.step;
    for (const el of $$('#reader-body [data-bi]')) {
      const x = el.getBoundingClientRect().left - rect.left;
      if (x >= cut - 2) return +el.dataset.sid0 || 0;
    }
    return 0;
  }
  for (const el of $$('#reader-body [data-bi]')) {
    if (el.getBoundingClientRect().bottom > 110) return +el.dataset.sid0 || 0;
  }
  return 0;
}

const LAZY_WORD_LIMIT = 5000;      // 超过这么多词就改成「滚到哪儿渲染哪儿」
let readerObserver = null;

/** 把一个段落的纯文本换成可点词的 span（幂等） */
function tokenizeBlock(el, block) {
  if (!el || el.dataset.rendered === '1') return;
  const keepTr = el.querySelector(':scope > .tr-block');   // 已插入的译文先拿出来
  if (keepTr) keepTr.remove();
  const frag = document.createDocumentFragment();
  for (const sent of block.sentences) {
    const sEl = document.createElement('span');
    sEl.className = 'sent';
    sEl.dataset.sid = sent.sid;
    for (const t of tokensOf(sent)) {
      if (t.k === 'w') {
        const anno = annoInfoFor(t.w);
        const wEl = document.createElement(anno ? 'ruby' : 'span');
        wEl.className = 'w' + (anno ? ' has-anno' : '')
          + (anno && anno.mine ? ' anno-mine' : '')
          + ((S.vocab.has(t.w) || S.vocab.has(dict.resolveBase(t.w))) ? ' saved' : '');
        wEl.dataset.w = t.w;
        wEl.dataset.sid = sent.sid;
        wEl.textContent = t.v;
        if (anno) {
          const rt = document.createElement('rt');
          rt.textContent = anno.text + '\u00a0\ud83d\udd0a';   // 尾部小喇叭，点一下就读
          if (anno.phonetic) wEl.dataset.ph = anno.phonetic;
          wEl.appendChild(rt);
        }
        sEl.appendChild(wEl);
      } else {
        sEl.appendChild(document.createTextNode(t.v));
      }
    }
    frag.appendChild(sEl);
    frag.appendChild(document.createTextNode(' '));
  }
  el.textContent = '';
  el.appendChild(frag);
  if (keepTr) el.appendChild(keepTr);                      // 再放回去
  el.dataset.rendered = '1';
}

/** 立刻展开某一段（TTS 高亮、深链接定位要用） */
function forceRenderBlock(bi) {
  if (!S.cur || bi === undefined || bi === null || bi < 0) return null;
  const el = $(`#reader-body [data-bi="${bi}"]`);
  if (!el) return null;
  if (readerObserver) readerObserver.unobserve(el);
  if (el.dataset.rendered !== '1') tokenizeBlock(el, S.cur.parsed.blocks[bi]);
  return el;
}

function renderReader() {
  if (window.__bm) window.__bm.render_start = Math.round(performance.now());
  const { article, parsed } = S.cur;
  $('#reader-title').textContent = parsed.title || article.title;
  $('#reader-meta').innerHTML = [
    `<span>${parsed.words} 词</span>`, `<span>${readingTime(parsed.words)}</span>`,
    `<span>生词 ${S.vocab.size} 个</span>`,
  ].join('');

  if (readerObserver) { readerObserver.disconnect(); readerObserver = null; }

  const body = $('#reader-body');
  const frag = document.createDocumentFragment();
  const els = [];
  // 每段之前累计了多少词 —— 用来算「按字数的阅读百分比」
  PG.blockWords = [];
  let wAcc = 0;
  parsed.blocks.forEach((b, bi) => {
    PG.blockWords[bi] = wAcc;
    wAcc += b.sentences.reduce((n, x) => n + countWords(x.text), 0);
  });
  // 句子 → 段落 的映射，供朗读定位 / 强制展开使用
  const sidBlock = new Array(parsed.sentences.length).fill(-1);

  parsed.blocks.forEach((block, bi) => {
    const el = document.createElement(block.type === 'h' ? 'h2' : block.type === 'q' ? 'blockquote' : 'p');
    if (block.type === 'h') el.className = 'art-h';
    el.dataset.bi = bi;
    el.dataset.sid0 = block.sentences[0]?.sid ?? 0;
    for (const sent of block.sentences) sidBlock[sent.sid] = bi;
    // 第一遍：只放纯文本，保证行高与滚动条从一开始就是对的
    el.textContent = block.sentences.map(s => s.text).join(' ') + ' ';
    frag.appendChild(el);
    els.push(el);
  });
  body.innerHTML = '';
  body.appendChild(frag);
  S.cur.sidBlock = sidBlock;

  if (parsed.words > LAZY_WORD_LIMIT && typeof IntersectionObserver !== 'undefined' && !needEagerRender(parsed)) {
    // 第二遍：滚到附近才把段落变成可点词，避免一口气造几十万个 DOM 节点
    readerObserver = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target;
        readerObserver.unobserve(el);
        tokenizeBlock(el, parsed.blocks[+el.dataset.bi]);
      }
    }, isPaged()
        ? { rootMargin: '0px 1400px 0px 1400px' }
        : { rootMargin: '1500px 0px 1500px 0px' });
    for (const el of els) readerObserver.observe(el);
    requestAnimationFrame(() => {
      // 首屏 + 附近立刻展开，避免用户还没滚动就点不到词
      const top = window.innerHeight + 1500;
      for (const el of els) {
        if (el.getBoundingClientRect().top > top) break;
        forceRenderBlock(+el.dataset.bi);
      }
    });
  } else {
    for (const el of els) tokenizeBlock(el, parsed.blocks[+el.dataset.bi]);
  }

  if (window.__bm) window.__bm.render_end = Math.round(performance.now());
  document.body.classList.toggle('paged', isPaged());
  $('#reader-end').innerHTML = `
    <div style="margin-bottom:14px">— 已读完 · 共 ${parsed.words} 词 —</div>
    <div class="row-actions" style="justify-content:center">
      <button class="btn" data-action="article-guide">✨ 生成 AI 导读</button>
      <button class="btn" data-action="back-top">↑ 回到顶部</button>
    </div>
    <div id="guide-out" class="ai-out" style="text-align:left;margin-top:18px"></div>`;
  const foot = $('#reader-foot');
  if (foot) foot.hidden = !isPaged();
  if (!isPaged()) {
    const body = $('#reader-body');
    if (body) { body.style.transform = 'none'; body.style.columnWidth = ''; body.style.columnGap = ''; body.style.width = ''; }
  }
  // 注意：分页要等视图真正显示后再算宽度，见 openArticle
}

/* ══════════════════════════  分级注释（按考纲级别在文中标注）  ══════════════════════════ */

const TAG_RANK = { cet4: 3, cet6: 4, ky: 5, toefl: 6, ielts: 6, gre: 7 };
const LEVEL_NAME = { cet4: '四级以上', cet6: '六级以上', ky: '考研以上', toefl: '托福/雅思以上', gre: 'GRE' };
const annoMemo = new Map();
let annoRetry = false;

/** 单个词条的难度。
 *  关键：托福/雅思词表里连 can、in、day 都有，所以绝不能取「标签里最高的等级」，
 *  而应取「最容易的那个标签」——中考/高考词一律算最简单的。 */
function levelOfRec(rec) {
  const t = rec.tags || [];
  const has = k => t.indexOf(k) >= 0;
  const frq = rec.frq || 0;
  if (has('zk') || has('gk')) return 1;        // 中考 / 高考词：一定认识
  if (rec.oxford === 1) return 2;              // 牛津核心词
  if (frq && frq <= 2500) return 2;            // 超高频
  if (has('cet4')) return 3;
  if (rec.collins >= 4) return 3;
  if (has('cet6')) return 4;
  if (has('ky')) return 5;
  if (has('toefl') || has('ielts')) return 6;
  if (has('gre')) return 7;
  // 没有考纲标签时按词频估：词频 5000 以内的词，六级学习者基本都认识
  if (frq && frq <= 8000) return 3;
  if (frq && frq <= 15000) return 4;
  if (frq && frq <= 25000) return 5;
  return 6;
}

/** 词的难度：本身和它的原形里，取更简单的那个。
 *  is→be、words→word、easier→easy 都会因此降到基础级。 */
function wordLevelOf(word) {
  const rec = dict.lookup(word);
  if (!rec) return 0;
  let lv = levelOfRec(rec);

  // 把所有可能的原形都算一遍，取最简单的那一个。
  // 关键：buying / showered / intimidating 这类词的词典条目里没有「（buy 的现在分词）」
  // 这种提示，只靠 lemma 还原不到原形，会被误判成难词标上注释。
  const cands = new Set();
  const baseW = rec.exact ? rec.lemma : rec.matched;
  if (baseW) cands.add(baseW);
  for (const c of dict.stemCandidates(word)) cands.add(c);

  for (const c of cands) {
    if (!c || c === word) continue;
    const b = dict.lookup(c);
    if (b) lv = Math.min(lv, levelOfRec(b));
  }
  return lv;
}

/** 把一条释义拆成若干个候选义项，按「先出现的更常用」排序，
 *  并丢掉带 [计] [法] 这类专业标记的冷门义项。 */
function sensesOf(rec) {
  if (!rec || !rec.translation) return [];
  const out = [];
  for (const chunk of String(rec.translation).split(/[；;\n]/)) {
    if (!chunk.trim()) continue;
    const soft = /\[[^\]]{1,5}\]/.test(chunk);           // 这一块带专业标记
    for (let piece of chunk.split(/[，,、]/)) {
      piece = piece.replace(/^[a-z]{1,6}\.\s*/i, '').replace(/\[[^\]]*\]/g, '')
        .replace(/[.．…]+$/, '').replace(/\.{3,}/g, '').replace(/^[.．…]+/, '').trim();
      if (!piece || piece.length > 14) continue;           // 太长的是解释句，不适合当注
      if (/[.．…]{2,}/.test(piece)) continue;               // 「做得比…好」这种残缺义项，读着别扭
      if (/[（(]/.test(piece) && piece.length > 6) continue;
      out.push({ text: piece, soft });
    }
  }
  // 非专业的排前面
  out.sort((a, b) => (a.soft ? 1 : 0) - (b.soft ? 1 : 0));
  return out.map(x => x.text);
}

/** 短释义：最多给两个义项，用「／」隔开，让读者能自己挑对的那个 */
function shortGloss(rec, max = 2) {
  const list = sensesOf(rec);
  if (!list.length) return '';
  const picked = [];
  for (const t of list) {
    if (picked.some(p => p === t || p.includes(t) || t.includes(p))) continue;
    picked.push(t.length > 6 ? t.slice(0, 6) : t);
    if (picked.length >= max) break;
  }
  return picked.join('／');
}

/* 人名、地名、机构名之类：标了也没用，还特别吵 */
const PROPER_NOISE = /(姓氏|人名|男子名|女子名|男子名|地名|城市|国家|州名|河名|山名|岛名|公司|商标|缩写|略语|即|原名|同|见)/;

/** 这个词要不要加注释。返回 { text, mine } 或 null。
 *  mine=true 表示这个词在「我的生词本」里（用另一种颜色显示）。 */
function annoInfoFor(word) {
  if (!settings.annotate || settings.annotate === 'off') return null;
  const need = TAG_RANK[settings.annotate] || 0;
  if (!need) return null;
  // 词典还没加载完时必须直接返回，而且**不能写进缓存** ——
  // 否则空结果会被永久缓存，注释功能看起来「完全没反应」。
  if (!dict.ready()) {
    if (!annoRetry) {
      annoRetry = true;
      dict.load()
        .then(() => { annoRetry = false; annoMemo.clear(); rerenderReader(); })
        .catch(() => { annoRetry = false; });
    }
    return null;
  }

  const mine = S.vocab.has(word) || S.vocab.has(dict.resolveBase(word));
  const key = word + '|' + settings.annotate + '|' + (settings.annotatePhonetic ? 1 : 0) + '|' + (mine ? 'm' : '-');
  const hit = annoMemo.get(key);
  if (hit !== undefined) return hit || null;

  let out = null;
  try {
    const rec = dict.lookup(word);
    // 生词本里的词一律标（这是「我自己选中的」）；其余按难度门槛
    const qualified = !!rec && (mine || wordLevelOf(word) >= need);
    if (qualified) {
      const raw = String(rec.translation || '');
      const tags = rec.tags || [];
      const plain = tags.length === 0 && (!rec.frq || rec.frq === 0) && (rec.collins || 0) === 0;
      const usable = mine || (!PROPER_NOISE.test(raw.split('；')[0]) && !plain);
      if (usable) {
        const g = shortGloss(rec, mine ? 3 : 2);
        if (g) out = {
          text: settings.annotatePhonetic && rec.phonetic ? `${rec.phonetic} ${g}` : g,
          mine,
          phonetic: rec.phonetic || '',
        };
      }
    }
  } catch {}
  if (annoMemo.size > 30000) annoMemo.clear();
  annoMemo.set(key, out || '');
  return out;
}

/** 打开注释时要把所有段落都渲染出来，否则分页高度量不准 */
function needEagerRender(parsed) {
  return (settings.annotate && settings.annotate !== 'off') && parsed.words <= 15000;
}

/* ══════════════════════════  章节目录  ══════════════════════════ */

function goToBlock(bi, smooth = true) {
  if (!S.cur) return;
  const el = forceRenderBlock(bi) || $(`#reader-body [data-bi="${bi}"]`);
  if (!el) return;
  if (isPaged()) {
    const body = $('#reader-body');
    const x = el.getBoundingClientRect().left - body.getBoundingClientRect().left;
    goPage(Math.floor((x + 4) / Math.max(1, PG.step)), smooth);
  } else {
    el.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  }
}

function showToc() {
  if (!S.cur) return;
  const { parsed } = S.cur;
  const items = [];
  parsed.blocks.forEach((b, bi) => {
    if (b.type === 'h') items.push({ bi, text: b.sentences.map(x => x.text).join(' ') });
  });
  // 没有明显标题时，退而把每 12 段当一节，至少能快速跳转
  const fallback = items.length === 0;
  if (fallback) {
    for (let bi = 0; bi < parsed.blocks.length; bi += 12) {
      const head = parsed.blocks[bi].sentences[0];
      if (head) items.push({ bi, text: head.text.slice(0, 42) + (head.text.length > 42 ? '…' : '') });
    }
  }
  openModal(`<h3>目录</h3>
    <div class="sub">${fallback ? '这篇没有明显的章节标题，按段落位置生成' : `共 ${items.length} 个章节`} · 点一下跳过去</div>
    <div class="toc-list">
      ${items.map(x => `<button class="toc-item" data-action="toc-go" data-bi="${x.bi}">
        <span class="toc-idx">${fallback ? '·' : ''}</span>${esc(x.text)}</button>`).join('')}
    </div>
    <div class="modal-foot"><button class="btn" data-action="modal-close">关闭</button></div>`);
}

/* ══════════════════════════  段落翻译 / 中文对照  ══════════════════════════ */

const trKey = (articleId, bi) => `tr:${articleId}:${bi}`;
/* 备注存在 aica 表里（key 以 note: 开头），这样会跟着账号同步 */
const noteKey = (aid, sid) => `note:${aid}:${sid}`;
async function loadNote(aid, sid) {
  const r = await db.get('aica', noteKey(aid, sid));
  return (r && r.text) || '';
}
async function saveNote(aid, sid, text) {
  const k = noteKey(aid, sid);
  if (!text.trim()) await db.del('aica', k);
  else await db.put('aica', { k, text, t: Date.now() });
  scheduleSync();
}
let trRunning = false;

function blockText(bi) {
  const b = S.cur && S.cur.parsed.blocks[bi];
  if (!b) return '';
  return b.sentences.map(x => x.text).join(' ');
}

/** 把译文插到某一段的下面（已存在就更新） */
function insertTranslation(bi, text) {
  const host = $(`#reader-body [data-bi="${bi}"]`);
  if (!host || !text) return null;
  // 放在段落「内部」：两栏排版时才不会被甩到下一栏，离原文更近
  let node = host.querySelector(':scope > .tr-block');
  if (!node) {
    node = document.createElement('span');
    node.className = 'tr-block';
    host.appendChild(node);
  }
  node.dataset.trBi = String(bi);
  node.innerHTML = `<span class="tr-tag">译</span>`
    + `<span class="spk" data-spk="${bi}" title="朗读这一段英文">\ud83d\udd0a</span>`
    + esc(text);
  return node;
}

/** 渲染后把已经翻译过的段落补回来（不联网、不花钱） */
async function applyCachedTranslations() {
  if (!S.cur || !settings.showTranslation) return 0;
  const { article, parsed } = S.cur;
  let missing = 0;
  for (let bi = 0; bi < parsed.blocks.length; bi++) {
    if (parsed.blocks[bi].type === 'h') continue;
    const hit = await db.get('aica', trKey(article.id, bi));
    if (hit && hit.text) insertTranslation(bi, hit.text);
    else missing++;
  }
  if (isPaged()) relayoutPages(true);
  return missing;
}

/** 单段：先查缓存，没有再问 AI */
async function ensureTranslation(bi) {
  const { article } = S.cur || {};
  if (!article) return '';
  const k = trKey(article.id, bi);
  const hit = await db.get('aica', k);
  if (hit && hit.text) { insertTranslation(bi, hit.text); return hit.text; }
  const text = blockText(bi);
  if (!text.trim()) return '';
  const tr = await ai.translateParagraph(text);
  if (tr) await db.put('aica', { k, text: tr, t: Date.now() });
  insertTranslation(bi, tr);
  return tr;
}

/** 翻译顺序：先把「当前这一页」的段落翻出来，再按离得远近依次翻。
 *  这样点开「中 译文」几秒钟就能看到眼前的中文，而不是等整篇。 */
function orderedTranslationTargets(parsed) {
  const all = [];
  parsed.blocks.forEach((b, bi) => { if (b.type !== 'h') all.push(bi); });
  if (!isPaged() || !PG.blockX || !PG.blockX.length) return all;
  const start = PG.page * PG.step;
  const onPage = [], rest = [];
  for (const bi of all) {
    const x = PG.blockX[bi];
    if (x === undefined) { rest.push(bi); continue; }
    if (x >= start - 1 && x < start + PG.step) onPage.push(bi);
    else rest.push(bi);
  }
  rest.sort((a, b) => {
    const da = Math.abs((PG.blockX[a] === undefined ? 1e9 : PG.blockX[a]) - start);
    const db = Math.abs((PG.blockX[b] === undefined ? 1e9 : PG.blockX[b]) - start);
    return da - db;
  });
  return onPage.concat(rest);
}

/** 当前这一页包含哪些段落（滚动模式下取视口内的） */
function currentPageTargets() {
  if (!S.cur) return [];
  const { parsed } = S.cur;
  const all = [];
  parsed.blocks.forEach((b, bi) => { if (b.type !== 'h') all.push(bi); });
  if (!all.length) return [];

  if (!isPaged()) {
    const vp = $('#reader-viewport') || document.documentElement;
    const top = vp === document.documentElement ? 0 : vp.getBoundingClientRect().top;
    const bottom = vp === document.documentElement ? innerHeight : vp.getBoundingClientRect().bottom;
    const inView = all.filter(bi => {
      const el = $(`#reader-body [data-bi="${bi}"]`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > top - 40 && r.top < bottom + 40;
    });
    return inView.length ? inView : all.slice(0, 3);
  }

  if (!PG.blockX || !PG.blockX.length) return all.slice(0, 3);
  const start = PG.page * PG.step;
  const onPage = all.filter(bi => {
    const x = PG.blockX[bi];
    return x !== undefined && x >= start - 1 && x < start + PG.step;
  });
  return onPage;
}

/** 只翻当前这一页 —— 便宜、快，读者要的就是眼前这段 */
async function translateCurrentPage(opts = {}) {
  const targets = currentPageTargets();
  if (!targets.length) return;
  const pend = [];
  for (const bi of targets) {
    const hit = await db.get('aica', trKey(S.cur.article.id, bi));
    if (!(hit && hit.text)) pend.push(bi);
  }
  if (!pend.length) { if (opts.silent !== true) toast('本页译文已经有了（来自缓存）'); return; }
  await runTranslateQueue(pend, { label: '本页', confirmLong: false });
}

/** 整篇翻译：并发 3 路，当前页优先，边翻边显示，带进度 */
async function translateArticle(force = false) {
  if (!S.cur || trRunning) return;
  if (!ai.hasKey()) { toast('需要先在「设置 → AI 引擎」填 API Key', 4000); return; }
  const { article, parsed } = S.cur;

  const targets = orderedTranslationTargets(parsed);
  if (!targets.length) { toast('这篇文章没有可翻译的正文'); return; }

  if (parsed.words > 3000 && !force) {
    const ok = confirm('这篇有 ' + parsed.words.toLocaleString() + ' 个词，\n'
      + '整篇翻译会需要不少时间和费用（已经翻过的段落不会重复收费）。\n\n'
      + '只是想看懂眼前这一页的话，点「取消」，直接用「中 译文」即可 —— 它只翻当前页。');
    if (!ok) return;
  }
  await runTranslateQueue(targets, { label: '整篇', confirmLong: false });

  trRunning = false;
}

/** 翻译队列：并发 3 路，边翻边显示，带进度 */
async function runTranslateQueue(targets, opts = {}) {
  if (!S.cur || trRunning || !targets.length) return;
  if (!ai.hasKey()) { toast('需要先在「设置 → AI 引擎」填 API Key', 4500); setView('settings'); return; }
  const { article } = S.cur;
  trRunning = true;
  const bar = $('#tr-progress');
  const show = t => { if (bar) { bar.hidden = false; bar.textContent = t; } };
  show(`正在翻译${opts.label || ''} · 共 ${targets.length} 段…`);

  let done = 0, cached = 0, failed = 0;
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const bi = queue.shift();
      try {
        const k = trKey(article.id, bi);
        const hit = await db.get('aica', k);
        if (hit && hit.text) { cached++; insertTranslation(bi, hit.text); }
        else { await ensureTranslation(bi); }
      } catch (e) {
        failed++;
        if (failed === 1) toast('翻译出错：' + e.message, 5000);
      }
      done++;
      show(`翻译中 ${done}/${targets.length} 段 · ${cached} 段来自缓存（不花钱）`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
    scheduleSync();
    if (isPaged()) relayoutPages(true);
    toast(failed
      ? `翻译完成 ${done - failed} 段，${failed} 段失败`
      : `翻译完成${opts.label || ''}：${targets.length} 段（${cached} 段命中缓存，没重复花钱）`, 3500);
  } finally {
    trRunning = false;
    if (bar) { bar.hidden = true; bar.textContent = ''; }
  }
}

function removeTranslations() {
  $$('.tr-block').forEach(n => n.remove());
  if (isPaged()) relayoutPages(true);
}

/* 阅读进度 */
let progTimer = null;
function onScroll() {
  if (S.view !== 'reader' || !S.cur || isPaged()) return;
  clearTimeout(progTimer);
  progTimer = setTimeout(() => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0;
    S.cur.article.progress = ratio;
    S.cur.article.updated = touch();
    persistArticle(S.cur.article);
    scheduleSync();
  }, 350);
}

/* ── 点词 / 点句 ── */
/** 取词元素上的纯单词文本。带注释的词是 <ruby>词<rt>释义</rt></ruby>，
 *  直接读 textContent 会把释义一起读进去（面板标题变成「formidable巨大的」）。 */
function surfaceOf(el) {
  if (!el) return '';
  if (el.dataset && el.dataset.w) return el.dataset.w;
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.nodeName !== 'RT') out += n.textContent || '';
  }
  return out.trim();
}

function onReaderClick(e) {
  if (isModalOpen()) return;

  // ① 点注释上的小喇叭 / 注释本身 → 读这个单词，并显示音标
  const rt = e.target.closest && e.target.closest('rt');
  if (rt) {
    const ruby = rt.closest('ruby.w');
    if (ruby) {
      const w = ruby.dataset.w || rt.textContent.replace(/[^A-Za-z'\-]/g, '');
      tts.say(w, settings.ttsRate / 100, { slow: true });
      const ph = ruby.dataset.ph ? `  /${ruby.dataset.ph}/` : '';
      toast(`🔊 ${w}${ph}`, 2400);
    }
    return;
  }

  // ② 点译文行首的小喇叭 → 读回对应的英文原段
  const spk = e.target.closest && e.target.closest('[data-spk]');
  if (spk) {
    const bi = +spk.dataset.spk;
    const text = blockText(bi);
    if (text) {
      tts.say(text, settings.ttsRate / 100);
      toast('🔊 正在朗读这一段英文', 2000);
    }
    return;
  }

  // 点左半边 → 详情放右边；点右半边 → 详情放左边，永远不挡着正在读的地方
  try {
    const r = e.target.getBoundingClientRect();
    S.panelSide = (r.left + r.width / 2) < window.innerWidth / 2 ? 'right' : 'left';
  } catch { S.panelSide = 'right'; }
  const w = e.target.closest?.('.w');
  if (w) { showWordPanel(w.dataset.w, +w.dataset.sid, surfaceOf(w)); return; }
  const s = e.target.closest?.('.sent');
  if (s) { showSentencePanel(+s.dataset.sid); }
}

/** 取某句的上下文 */
function ctxFor(sid) {
  if (!S.cur) return { sentence: '', before: '', after: '' };
  const arr = S.cur.parsed.sentences;
  return {
    sentence: arr[sid]?.text || '',
    before: arr[sid - 1]?.text || '',
    after: arr[sid + 1]?.text || '',
  };
}

/* ══════════════════════════  面板  ══════════════════════════ */

function openPanel() {
  if (window.innerWidth >= 900) {
    const left = S.panelSide === 'left';
    document.body.classList.toggle('panel-left', left);
    document.body.classList.toggle('panel-right', !left);
  }
  $('#panel').hidden = false;
  $('#scrim').hidden = false;
  document.body.classList.add('panel-open');
}
function closePanel() {
  if (S.aiAbort) { try { S.aiAbort.abort(); } catch {} S.aiAbort = null; }
  $('#panel').hidden = true;
  $('#scrim').hidden = true;
  document.body.classList.remove('panel-open');
  $$('.w.active').forEach(el => el.classList.remove('active'));
  $$('.sent.speaking').forEach(el => el.classList.remove('speaking'));
  S.panel = null;
}

function markActiveWord(sid, word) {
  $$('.w.active').forEach(el => el.classList.remove('active'));
  const el = $(`.w[data-sid="${sid}"][data-w="${CSS.escape(word)}"]`);
  if (el) el.classList.add('active');
}

async function showWordPanel(surface, sid, surfaceText) {
  // 冷启动时用户可能先点词、后加载完词典：这里等一下就绪
  if (!dict.ready()) {
    toast('离线词典加载中…', 1200);
    try { await dict.load(); } catch {}
  }
  const rec = dict.lookup(surface);
  const base = rec?.matched || String(surface).toLowerCase();
  const surfaceForm = surfaceText || surface;
  S.panel = { type: 'word', base, surface: surfaceForm, sid, rec, saved: S.vocab.get(base) || null };
  markActiveWord(sid, String(surfaceText || surface).toLowerCase());

  $('#ph-word').textContent = surfaceForm;
  const sub = [];
  if (rec?.phonetic) sub.push(`<span class="ipa">/${esc(rec.phonetic)}/</span>`);
  // 屈折形式：给一个可点的「原形」跳转
  const lemma = rec ? (rec.exact ? rec.lemma : (rec.matched !== String(surfaceForm).toLowerCase() ? rec.matched : null)) : null;
  if (lemma && lemma !== String(surfaceForm).toLowerCase()) {
    sub.push(`<button class="tag link" data-action="lookup-word" data-word="${esc(lemma)}" data-sid="${sid}">原形 ${esc(lemma)}</button>`);
  }
  if (rec?.frq) sub.push(`<span class="tag freq">词频 ${rec.frq}</span>`);
  if (rec?.oxford) sub.push(`<span class="tag oxford">牛津核心</span>`);
  if (rec?.collins) sub.push(`<span class="tag collins">柯林斯 ${'★'.repeat(rec.collins)}</span>`);
  for (const t of (rec?.tags || []).slice(0, 5)) {
    if (TAG_LABEL[t]) sub.push(`<span class="tag">${TAG_LABEL[t]}</span>`);
  }
  $('#ph-sub').innerHTML = sub.join('') || '<span style="color:var(--fg-faint)">未收录</span>';

  const { sentence, before, after } = ctxFor(sid);
  const saved = S.vocab.get(base);

  const dictBlock = rec
    ? `<div class="def-block">
         <div class="def-label">本地词典</div>
         <div class="def-zh">${splitSenses(rec.translation).map(s =>
            `<div class="sense">${s.pos ? `<span class="pos">${esc(s.pos)}</span> ` : ''}${esc(s.text)}</div>`).join('')}</div>
       </div>`
    : `<div class="def-block"><div class="warn-box">离线词典里没有 <b>${esc(surfaceForm)}</b>（可能是专有名词、生僻词或变形）。
        下面的 AI 讲解仍然可用。</div></div>`;

  const sentBlock = sentence ? `
    <div class="def-block">
      <div class="def-label">本句语境</div>
      <div class="ctx-sent">${highlightWord(sentence, surfaceForm)}</div>
    </div>` : '';

  const aiBlock = `
    <div class="def-block">
      <div class="def-label">AI 语境讲解</div>
      <div id="ai-word" class="ai-out"></div>
    </div>`;

  const trBlock = sentence ? `
    <div class="def-block" id="ph-trans-wrap" hidden>
      <div class="def-label">本段译文
        <button class="btn tiny" data-action="translate-block" data-sid="${sid}">重新翻译</button>
      </div>
      <div id="ph-trans" class="ai-out"></div>
    </div>` : '';

  $('#panel-body').innerHTML = dictBlock + sentBlock + aiBlock + trBlock;

  $('#panel-foot').innerHTML = saved
    ? `<button class="btn" data-action="unsave">✓ 已在生词本 · 移除 <b class="kbd">A</b></button>
       <span style="font-size:12.5px;color:var(--fg-dim)">${srs.isDue(saved) ? '今天待复习' : '下次 ' + fmtDate(saved.due)}</span>`
    : `<button class="btn primary" data-action="save">＋ 加入生词本 <b class="kbd">A</b></button>`;

  const extra = [];
  if (sentence) extra.push(`<button class="btn" data-action="to-sentence" data-sid="${sid}">整句翻译 · 语法</button>`);
  if (sentence) extra.push(`<button class="btn" data-action="translate-block" data-sid="${sid}">译本段</button>`);
  extra.push(`<button class="btn" data-action="copy-word">复制</button>`);
  extra.push(`<button class="btn" data-action="close-panel">关闭 <b class="kbd">Esc</b></button>`);
  $('#panel-foot').insertAdjacentHTML('beforeend', extra.join(''));

  openPanel();

  const el = $('#ai-word');
  if (!sentence) { el.innerHTML = '<div class="warn-box">这个词不在句子语境里，无法做语境讲解。</div>'; return; }
  if (settings.autoAI && ai.hasKey()) {
    runAI(el, ai.cacheKeyFor('w', [base, sentence]), ai.wordPrompt({ word: surfaceForm, sentence, before, after }));
  } else {
    el.innerHTML = `<div class="row-actions"><button class="btn primary" data-action="run-word-ai">✨ 让 AI 讲解这个词</button></div>`
      + (ai.hasKey() ? '' : '<div class="warn-box" style="margin-top:10px">还没有配置 API Key，去「设置 → AI 引擎」填写后即可使用。</div>');
  }
}

function showSentencePanel(sid) {
  const { sentence, before, after } = ctxFor(sid);
  if (!sentence) return;
  S.panel = { type: 'sentence', sid, sentence };

  $('#ph-word').textContent = sentence.length > 34 ? sentence.slice(0, 34) + '…' : sentence;
  const n = sentence.split(/\s+/).length;
  $('#ph-sub').innerHTML = `<span class="tag">第 ${sid + 1} 句</span><span class="tag">${n} 词</span>`;

  $('#panel-body').innerHTML = `
    <div class="def-block">
      <div class="def-label">原句</div>
      <div class="ctx-sent">${esc(sentence)}</div>
    </div>
    <div class="def-block">
      <div class="def-label" data-action="toggle-coll">翻译 <span class="caret">▾</span></div>
      <div class="def-block-body"><div id="ai-tr" class="ai-out"></div></div>
    </div>
    <div class="def-block">
      <div class="def-label" data-action="toggle-coll">语法拆解 <span class="caret">▾</span></div>
      <div class="def-block-body"><div id="ai-gr" class="ai-out"></div></div>
    </div>
    <div class="def-block">
      <div class="def-label" data-action="toggle-coll">我的备注 <span class="caret">▾</span></div>
      <div class="def-block-body">
        <textarea id="sent-note" class="note-box" rows="3"
          placeholder="记点什么…（边打边自动保存，会跟着账号同步）"></textarea>
      </div>
    </div>`;

  $('#panel-foot').innerHTML = `
    <button class="btn primary" data-action="speak-sent" data-sid="${sid}">🔊 朗读本句 <b class="kbd">P</b></button>
    <button class="btn" data-action="copy-sent">复制</button>
    <button class="btn" data-action="close-panel">关闭 <b class="kbd">Esc</b></button>`;

  openPanel();

  // 备注：载入 + 防抖保存
  if (S.cur && S.cur.article) {
    const aid = S.cur.article.id;
    loadNote(aid, sid).then(t => {
      const box = $('#sent-note');
      if (box && document.activeElement !== box) box.value = t;
    });
    const box = $('#sent-note');
    if (box) {
      let timer = 0;
      box.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => saveNote(aid, sid, box.value), 600);
      });
    }
  }

  if (ai.hasKey()) {
    runAI($('#ai-tr'), ai.cacheKeyFor('t', [sentence]), ai.sentencePrompt({ sentence, before, after }));
    runAI($('#ai-gr'), ai.cacheKeyFor('g', [sentence]), ai.grammarPrompt({ sentence }));
  } else {
    const msg = '<div class="warn-box">还没有配置 API Key，去「设置 → AI 引擎」填写后即可使用 AI 翻译与语法拆解。</div>';
    $('#ai-tr').innerHTML = msg; $('#ai-gr').innerHTML = '';
  }
}

/* ── AI 流式渲染 ── */
function runAI(el, key, messages, opts = {}) {
  if (!el) return;
  if (S.aiAbort) { try { S.aiAbort.abort(); } catch {} }
  const ac = new AbortController();
  S.aiAbort = ac;
  S.lastAI = { el, key, messages, sid: S.panel?.sid };

  let acc = '';
  let raf = 0;
  let firstPaint = false;
  el.classList.add('stream-cursor');
  el.innerHTML = '<div class="loading"><span class="spinner"></span>AI 正在分析…</div>';

  const paint = () => {
    raf = 0;
    // 关键：只有拿到**非空**内容才清掉加载态。
    // 否则网关先吐一个空 chunk 就会把界面清空，看起来「什么都没出来」。
    if (!firstPaint) {
      if (!acc.trim()) return;
      el.innerHTML = '';
      firstPaint = true;
    }
    el.innerHTML = renderRich(acc);
    el.classList.add('stream-cursor');
  };

  ai.cachedStream(key, messages, (d, full, cached) => {
    acc = full;
    if (cached) { el.innerHTML = renderRich(acc); el.classList.remove('stream-cursor'); return; }
    if (!raf) raf = requestAnimationFrame(paint);
  }, { signal: ac.signal, ...opts })
    .then(full => {
      el.classList.remove('stream-cursor');
      const got = (acc || full || '').trim();
      if (!got) {
        el.innerHTML = '<div class="err-box">AI 这次没有返回内容（可能是网关超时或额度问题）。</div>'
          + '<div style="margin-top:10px"><button class="btn primary" data-action="retry-ai">重新生成</button>'
          + '<button class="btn" data-action="go-ai">检查 AI 设置</button></div>';
        return;
      }
      if (!firstPaint) { el.innerHTML = renderRich(got); firstPaint = true; }
    })
    .catch(err => {
      if (err && err.name === 'AbortError') return;
      el.classList.remove('stream-cursor');
      const needsKey = !ai.hasKey() || /API Key|apiKey|还没有填|接口地址/i.test(err.message || '');
      el.innerHTML = `<div class="err-box">${esc(err.message || err)}</div>
        <div class="row-actions" style="margin-top:10px">
          <button class="btn" data-action="retry-ai">重试</button>
          ${needsKey ? '<button class="btn primary" data-action="go-ai">去设置 AI 引擎 →</button>'
                     : '<button class="btn" data-action="go-settings">去设置</button>'}
        </div>`;
    });
}

/* ══════════════════════════  生词本  ══════════════════════════ */

function vocabList() {
  let list = [...S.vocab.values()];
  if (S.vFilter === 'due') list = list.filter(c => srs.isDue(c));
  else if (S.vFilter === 'learning') list = list.filter(c => c.stage !== 'mastered');
  else if (S.vFilter === 'mastered') list = list.filter(c => c.stage === 'mastered');
  return list.sort((a, b) => (a.due || 0) - (b.due || 0));
}

function renderVocab() {
  const due = [...S.vocab.values()].filter(c => srs.isDue(c)).length;
  const dc = $('#due-count');
  dc.hidden = !due; dc.textContent = due;
  const tb = $('#tab-due');
  tb.hidden = !due;

  const list = vocabList();
  const box = $('#vocab-list');
  if (!list.length) {
    box.innerHTML = `<div class="empty">${S.vocab.size
      ? '这个分类下还没有单词。'
      : '生词本还是空的。<br>在阅读时点任意一个词，然后点「＋ 加入生词本」。'}</div>`;
    return;
  }

  box.innerHTML = list.map(c => {
    const dueTxt = srs.isDue(c) ? '待复习' : '下次 ' + fmtDate(c.due);
    const cls = srs.isDue(c) ? 'pill due' : 'pill';
    return `<div class="card" data-word="${esc(c.word)}">
      <div class="card-main" data-open-word="${esc(c.word)}">
        <div class="card-title">${esc(c.word)}
          ${c.phonetic ? `<span style="font-weight:400;font-size:13px;color:var(--fg-faint)">/${esc(c.phonetic)}/</span>` : ''}
        </div>
        <div class="card-sub">
          <span>${esc((c.translation || '—').slice(0, 46))}</span>
        </div>
        <div class="card-sub" style="margin-top:6px">
          <span class="${cls}">${dueTxt}</span>
          <span class="pill">复习 ${c.reps || 0} 次</span>
          ${c.lapses ? `<span class="pill">忘记 ${c.lapses} 次</span>` : ''}
        </div>
      </div>
      <button class="card-x" data-del-word="${esc(c.word)}" title="删除">✕</button>
    </div>`;
  }).join('');
}

/* ══════════════════════════  复习  ══════════════════════════ */

function startReview() {
  let list = [...S.vocab.values()].filter(c => srs.isDue(c));
  if (!list.length) list = [...S.vocab.values()].filter(c => c.stage !== 'mastered');
  if (!list.length) { toast('生词本还是空的，先去阅读里收藏几个词吧'); return; }
  list.sort((a, b) => (a.due || 0) - (b.due || 0));
  S.review = { queue: list.slice(0, 60), i: 0, revealed: false, cur: null, done: 0 };
  setView('review');
  showReviewCard();
}

function showReviewCard() {
  const R = S.review;
  const card = R.queue[R.i];
  $('#review-bar').style.width = (R.i / R.queue.length * 100) + '%';

  if (!card) {
    $('#review-card').innerHTML = `<div class="done-card">
      <div class="big-emoji">🎉</div>
      <h3 style="margin:12px 0 6px">这一轮复习完成</h3>
      <p style="color:var(--fg-dim);font-size:14px;line-height:1.7">
        本轮复习了 ${R.queue.length} 个词。<br>按遗忘曲线，它们会在合适的时间再次出现。</p>
      <div class="row-actions" style="justify-content:center;margin-top:20px">
        <button class="btn primary" data-action="go-vocab">回生词本</button>
      </div></div>`;
    $('#review-foot').textContent = '';
    $('#review-bar').style.width = '100%';
    return;
  }

  R.cur = card;
  R.revealed = false;
  const cloze = card.sentence ? clozeSentence(card.sentence, card.word) : '';
  $('#review-card').innerHTML = `
    <div class="rc-word">${esc(card.word)}</div>
    <div class="rc-phon">${card.phonetic ? '/' + esc(card.phonetic) + '/' : ''}</div>
    <button class="btn" data-action="speak-card">🔊 听发音</button>
    ${cloze ? `<div class="rc-cloze">${cloze}</div>` : ''}
    <div class="rc-answer" id="rc-answer" hidden>
      <div class="def-label">释义</div>
      <div class="def-zh">${splitSenses(card.translation || '—').map(s =>
        `<div class="sense">${s.pos ? `<span class="pos">${esc(s.pos)}</span> ` : ''}${esc(s.text)}</div>`).join('')}</div>
      ${card.sentence ? `<div class="def-label" style="margin-top:14px">原句</div>
        <div class="ctx-sent">${highlightWord(card.sentence, card.word)}</div>` : ''}
      ${card.articleTitle ? `<div style="font-size:12.5px;color:var(--fg-faint);margin-top:8px">来自《${esc(card.articleTitle)}》</div>` : ''}
    </div>
    <button class="btn primary big" id="rc-reveal" data-action="reveal">显示答案</button>
    <div class="rc-grades" id="rc-grades" hidden>
      <button class="grade g1" data-grade="1">忘记<i>10 分钟</i></button>
      <button class="grade g2" data-grade="2">模糊<i id="g2i"></i></button>
      <button class="grade g3" data-grade="3">记得<i id="g3i"></i></button>
      <button class="grade g4" data-grade="4">太简单<i id="g4i"></i></button>
    </div>`;
  $('#review-foot').innerHTML = `第 ${R.i + 1} / ${R.queue.length} 个 · 已复习 ${R.done} 个`;
}

function revealReview() {
  const R = S.review;
  if (!R.cur || R.revealed) return;
  R.revealed = true;
  $('#rc-answer').hidden = false;
  $('#rc-reveal').hidden = true;
  $('#rc-grades').hidden = false;
  for (const g of [2, 3, 4]) {
    const d = srs.previewInterval(R.cur, g);
    const el = $('#g' + g + 'i');
    if (el) el.textContent = srs.fmtInterval(d);
  }
}

async function gradeReview(g) {
  const R = S.review;
  if (!R.cur) return;
  srs.apply(R.cur, g);
  R.cur.last = Date.now();
  R.cur.updated = touch();
  try { await db.put('vocab', { ...R.cur }); } catch {}
  scheduleSync();
  S.vocab.set(R.cur.word, R.cur);
  R.done++;
  // 忘记的词重新排到队尾
  if (g === 1) R.queue.push(R.cur);
  R.i++;
  showReviewCard();
  if (S.view === 'vocab') renderVocab();
}

/* ══════════════════════════  生词操作  ══════════════════════════ */

/** 把文中所有「原形等于 base」的词标上/去掉下划线（包含 running→run 这类变形） */
function markWordSaved(base, on) {
  const b = String(base).toLowerCase();
  $$('#reader-body .w').forEach(el => {
    const w = el.dataset.w;
    if (!w) return;
    if (w === b || dict.resolveBase(w) === b) el.classList.toggle('saved', on);
  });
  // 注释开着时要重绘：生词本里的词用另一种配色，而且可能因此「够格」被标上释义。
  // 这里没有做局部替换，因为要重建的可能是一个 span ↔ ruby 的结构变化，重绘最稳。
  if (settings.annotate && settings.annotate !== 'off') {
    annoMemo.clear();
    rerenderReader();
  }
}

async function saveWord(base, rec, surface, sid) {
  const { sentence } = ctxFor(sid);
  const card = srs.newCard(base, {
    phonetic: rec?.phonetic || '',
    translation: rec?.translation || '',
    sentence,
    articleId: S.cur?.article.id || '',
    articleTitle: S.cur?.article.title || '',
    updated: touch(),
  });
  S.vocab.set(base, card);
  try { await db.put('vocab', card); } catch {}
  scheduleSync();
  markWordSaved(base, true);
  toast('已加入生词本：' + base);
  return card;
}

async function unsaveWord(base) {
  const old = S.vocab.get(base) || {};
  S.vocab.delete(base);
  try {
    await db.put('vocab', { ...old, word: base, deleted: true, updated: touch() });
  } catch {}
  markWordSaved(base, false);
  scheduleSync();
  toast('已从生词本移除：' + base);
}

/* ══════════════════════════  设置页  ══════════════════════════ */

/* ══════════════════════════  账号与同步  ══════════════════════════ */

// 测试与调试用的钩子（同源才拿得到，不影响正常使用）
window.__lexisync = sync;

let syncTimer = null;
let syncBusy = false;

/** 本地有改动后延迟同步，避免连续操作时反复请求 */
function scheduleSync(delay = 4000) {
  if (!sync.isSignedIn() || !sync.getConfig().autoSync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { runSync(false); }, delay);
}

function setSyncBtn(state, title) {
  const b = $('#btn-sync');
  if (!b) return;
  b.hidden = !sync.isConfigured();
  b.className = 'icon-btn sync-btn' + (state ? ' ' + state : '');
  b.title = title || '';
  if (state === 'on') b.textContent = '☁';
  else if (state === 'busy') b.textContent = '↻';
  else if (state === 'err') b.textContent = '⚠';
  else b.textContent = '☁';
}

function fmtAgo(ts) {
  if (!ts) return '从未同步';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚同步';
  if (d < 3600000) return Math.round(d / 60000) + ' 分钟前同步';
  if (d < 86400000) return Math.round(d / 3600000) + ' 小时前同步';
  return fmtDate(ts) + ' 同步';
}

async function runSync(manual = true) {
  if (syncBusy) return;
  if (!sync.isSignedIn()) {
    if (manual) { toast('请先在「设置 → 账号与同步」登录'); setView('settings'); }
    return;
  }
  syncBusy = true;
  setSyncBtn('busy', '正在同步…');
  const hadArticle = S.cur?.article.id;
  try {
    const st = await sync.sync({
      onStage: msg => setSyncBtn('busy', msg),
      full: manual && false,
    });
    await reloadAll();
    if (S.cur) {
      const fresh = S.articles.find(a => a.id === S.cur.article.id);
      if (fresh) S.cur.article = fresh;
    }
    renderLibrary();
    if (S.view === 'vocab') renderVocab();
    renderSync();
    setSyncBtn('on', fmtAgo(sync.lastSyncAt()));

    // 当前在读的文章若被别的设备删了，就退回书架
    if (hadArticle && !S.articles.some(a => a.id === hadArticle)) {
      S.cur = null;
      setView('library');
      toast('这篇文章已在其它设备上删除');
    } else if (manual) {
      const bits = [];
      if (st.pulled) bits.push(`拉取 ${st.pulled} 项`);
      if (st.pushed) bits.push(`上传 ${st.pushed} 项`);
      if (st.removed) bits.push(`删除 ${st.removed} 项`);
      toast(bits.length ? '同步完成：' + bits.join('、') : '已经是最新的了');
    }
  } catch (e) {
    setSyncBtn('err', e.message);
    if (manual) toast('同步失败：' + e.message, 5000);
    renderSync(e.message);
  } finally {
    syncBusy = false;
  }
}

const ONBOARD_KEY = 'lexiread.onboarded';

/* ── 建表 SQL：直接读仓库里的 docs/supabase.sql，不用用户去找文件 ── */
let SQL_TEXT = '';
let sqlLoading = null;
function loadSql() {
  if (SQL_TEXT) return Promise.resolve(SQL_TEXT);
  if (!sqlLoading) {
    sqlLoading = fetch(new URL('../docs/supabase.sql', import.meta.url))
      .then(r => (r.ok ? r.text() : ''))
      .then(t => { SQL_TEXT = t || ''; return SQL_TEXT; })
      .catch(() => '');
  }
  return sqlLoading;
}

/** 复制到剪贴板：优先用 Clipboard API，失败就退回 execCommand */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 继续用回退方案 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/** 未配置同步时的引导卡片内容（欢迎页和设置页共用） */
function syncSetupHtml(cfg) {
  return `
    <p class="lead">用一个邮箱，在 iPhone / iPad / Mac 之间同步全部内容。
    同步用的是你自己的 Supabase 免费项目，不用信用卡，数据只有你能读写。</p>
    <ol class="sync-steps">
      <li>去 <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a> 注册，新建一个项目，等它初始化完成</li>
      <li><b>Project URL</b>：点页面右上角绿色的 <b>Connect</b> 按钮，弹窗里第一条就是（形如 <code>https://xxxx.supabase.co</code>）</li>
      <li><b>API Key</b>：左侧 <b>Settings → API Keys</b> 里的 <b>Publishable key</b>（<code>sb_publishable_…</code>，旧版叫 anon public）。
          <b>千万不要用 secret key</b></li>
      <li>左侧 <b>SQL Editor</b> → <b>New query</b> → 用下面按钮复制建表语句 → 粘进去 → <b>Run</b></li>
      <li>把上面两个值填到下面，点「测试连接」确认无误</li>
    </ol>
    <div class="wc-row" style="margin-bottom:12px">
      <button class="btn primary" data-action="copy-sql">📋 复制建表 SQL</button>
      <button class="btn" data-action="toggle-sql">查看内容</button>
    </div>
    <pre class="sql-box" id="sql-box" hidden>正在读取…</pre>
    <div class="sync-field"><span>Project URL</span>
      <input id="sy-url" type="url" inputmode="url" autocomplete="off" spellcheck="false"
             placeholder="https://abcdefghijk.supabase.co" value="${esc(cfg.url)}"></div>
    <div class="sync-field"><span>anon public key</span>
      <input id="sy-key" type="text" autocomplete="off" spellcheck="false"
             placeholder="eyJhbGciOi..." value="${esc(cfg.anonKey)}"></div>
    <div class="wc-row">
      <button class="btn primary" data-action="sync-save-cfg">保存并继续</button>
      <button class="btn" data-action="sync-test-cfg">测试连接</button>
    </div>
    <div id="sy-test-out" hidden></div>
    <p class="wc-note">也可以在部署时把这两个值填进 <code>config.js</code>，
    所有设备打开就自动配好，不用每台填一次。</p>`;
}

/** 第一屏：突出邮箱注册，说明同一邮箱全端同步 */
function renderWelcome(errMsg) {
  const box = $('#welcome-card');
  if (!box) return;
  const signed = sync.isSignedIn();
  const cfg = sync.getConfig();

  if (signed) {
    const email = sync.currentEmail();
    box.className = 'wc-card';
    box.innerHTML = `
      <h2>已登录</h2>
      <p class="lead">当前账号 <b>${esc(email)}</b><br>文章、生词本、阅读进度、复习记录和排版设置会在这台设备与其它设备之间自动同步。</p>
      <div class="wc-row">
        <button class="btn primary" data-action="welcome-go">开始阅读</button>
        <button class="btn" data-action="sync-now">立即同步</button>
      </div>`;
    return;
  }

  if (!sync.isConfigured()) {
    box.className = 'wc-card';
    box.innerHTML = '<h2>开启跨设备同步</h2>' + syncSetupHtml(cfg);
    loadSql();
    return;
  }

  box.className = 'wc-card';
  box.innerHTML = `
    <h2>用邮箱注册，开启三端同步</h2>
    <p class="lead">同一个邮箱，文章、生词本、阅读进度、复习记录和排版设置
    在 iPhone / iPad / Mac 之间自动同步。</p>
    <div class="sync-field"><span>邮箱</span>
      <input id="sy-email" type="text" inputmode="email" autocomplete="username" spellcheck="false"
             placeholder="you@example.com" value="${esc(cfg.email)}"></div>
    <div class="sync-field"><span>密码（至少 6 位）</span>
      <input id="sy-pass" type="password" autocomplete="current-password" placeholder="••••••"></div>
    ${errMsg ? `<div class="err-box" style="margin-bottom:12px;white-space:pre-wrap">${esc(errMsg)}</div>` : ''}
    <div class="wc-row">
      <button class="btn primary" data-action="sync-signup">注册新账号</button>
      <button class="btn" data-action="sync-signin">登录</button>
    </div>
    <p class="wc-note">同步服务是你自己的 Supabase 免费项目，数据只有你能读写。Key 和密码不会上传到任何第三方服务器。</p>
    <details class="wc-help">
      <summary>注册遇到问题？</summary>
      <div>
        <b>提示“email rate limit exceeded”</b><br>
        免费版内置邮件每小时只能发几封。去 Supabase 左侧
        <b>Authentication → Sign In / Providers → Email</b>，把 <b>Confirm email</b> 关掉，
        然后回来直接点「登录」即可，注册不再需要邮件。<br><br>
        <b>提示“这个邮箱已经注册过了”</b><br>
        直接点「登录」。如果密码忘了，Supabase 里
        <b>Authentication → Users</b> 可以删除那个用户，再重新注册。<br><br>
        <b>提示“邮箱还没验证”</b><br>
        去收件箱（含垃圾邮件）点确认链接；或者同样关掉 Confirm email。
      </div>
    </details>`;
}

function goWelcome() {
  renderWelcome();
  setView('welcome');
}

async function doAuth(mode) {
  const email = ($('#sy-email')?.value || '').trim();
  const pass = $('#sy-pass')?.value || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { renderSync('邮箱格式不对'); return; }
  if (pass.length < 6) { renderSync('密码至少要 6 位'); return; }
  const onWelcome = S.view === 'welcome';
  const host = onWelcome ? $('#welcome-card') : $('#sync-body');
  const repaint = (msg) => (onWelcome ? renderWelcome(msg) : renderSync(msg));
  $$('#sync-body .btn, #welcome-card .btn').forEach(b => { b.disabled = true; });
  const old = host.innerHTML;
  try {
    if (mode === 'up') {
      const r = await sync.signUp(email, pass);
      if (r.needConfirm) {
        host.innerHTML = `<h2>还差一步</h2>
          <p class="lead">确认邮件已经发到 <b>${esc(email)}</b>，点里面的链接后再回来登录。</p>
          <p class="wc-note">不想每次验证邮箱？在 Supabase 控制台 →
          Authentication → Sign In / Providers → Email，把 <b>Confirm email</b> 关掉，以后注册就立即生效。</p>
          <div class="wc-row"><button class="btn primary" data-action="sync-reload-ui">我已确认，去登录</button></div>`;
        return;
      }
      toast('注册成功，已登录');
    } else {
      await sync.signIn(email, pass);
      toast('登录成功');
    }
    repaint();
    if (!onWelcome) renderWelcome();
    runSync(true);
  } catch (e) {
    host.innerHTML = old;
    repaint(e.message);
  }
}

function renderSync(errMsg) {
  const box = $('#sync-body');
  if (!box) return;
  const cfg = sync.getConfig();
  const signed = sync.isSignedIn();

  if (!sync.isConfigured()) {
    box.innerHTML = syncSetupHtml(cfg);
    loadSql();
    setSyncBtn('', '未配置同步');
    return;
  }

  if (!signed) {
    box.innerHTML = `
      <p class="hint">同步服务已就绪，登录你的账号即可在三端之间同步。</p>
      <div class="sync-field"><span>邮箱</span>
        <input id="sy-email" type="text" inputmode="email" autocomplete="username" spellcheck="false" placeholder="you@example.com" value="${esc(cfg.email)}"></div>
      <div class="sync-field"><span>密码（至少 6 位）</span>
        <input id="sy-pass" type="password" autocomplete="current-password" placeholder="••••••"></div>
      ${errMsg ? `<div class="err-box" style="margin-bottom:12px">${esc(errMsg)}</div>` : ''}
      <div class="sync-actions">
        <button class="btn primary" data-action="sync-signin">登录</button>
        <button class="btn" data-action="sync-signup">注册新账号</button>
        <button class="btn" data-action="sync-reset-cfg">换一个项目</button>
      </div>`;
    setSyncBtn('', '未登录');
    return;
  }

  const email = sync.currentEmail();
  box.innerHTML = `
    <div class="sync-state">
      <div class="sync-avatar">${esc((email[0] || '?').toUpperCase())}</div>
      <div class="who"><b>${esc(email)}</b><span style="color:var(--fg-dim)">${esc(fmtAgo(sync.lastSyncAt()))}</span></div>
    </div>
    ${errMsg ? `<div class="err-box" style="margin-bottom:12px">${esc(errMsg)}</div>` : ''}
    <label class="field" style="border:none;padding:4px 0 10px">
      <span style="width:auto;flex:1">打开应用时自动同步</span>
      <input id="sy-auto" type="checkbox" ${cfg.autoSync ? 'checked' : ''}>
    </label>
    <p class="hint" style="margin-bottom:12px">同步是双向的：本地改动会传给云端，云端的改动也会合并回本机。
    冲突时以时间较新的那份为准，所以三部设备轮流用不会互相覆盖。</p>
    <div class="sync-actions">
      <button class="btn primary" data-action="sync-now">立即同步</button>
      <button class="btn" data-action="sync-signout">退出登录</button>
    </div>`;
  setSyncBtn('on', fmtAgo(sync.lastSyncAt()));
}

function renderSettings() {
  const c = ai.getConfig();
  $('#set-baseurl').value = c.baseUrl;
  $('#set-apikey').value = c.apiKey;
  $('#set-model').value = c.model;

  $('#set-fontsize').value = settings.fontSize;
  $('#set-fontsize-v').textContent = settings.fontSize + 'px';
  $('#set-lineheight').value = settings.lineHeight;
  $('#set-lineheight-v').textContent = (settings.lineHeight / 100).toFixed(2);
  $('#set-width').value = settings.width;
  $('#set-width-v').textContent = settings.width + 'px';
  $('#set-font').value = settings.font;
  $('#set-theme').value = settings.theme;
  $('#set-mode').value = settings.readingMode || 'page';
  $('#set-columns').value = settings.columns || 'auto';
  $('#set-para').value = settings.paraStyle || 'web';
  $('#set-justify').checked = settings.justify !== false;
  $('#set-translation').checked = !!settings.showTranslation;
  $('#set-annotate').value = settings.annotate || 'off';
  $('#set-anno-phon').checked = !!settings.annotatePhonetic;
  $('#set-sync-ai').checked = !!settings.syncAiKey;
  const ver = $('#version-hint');
  if (ver) {
    const st = (typeof dict.status === 'function') ? dict.status() : {};
    const n = st.count || st.size || st.entries || 0;
    ver.textContent = `精读 LexiRead v${APP_VERSION}`
      + (n ? ` · 离线词典 ${n.toLocaleString()} 条` : '');
  }
  $('#set-autoai').checked = !!settings.autoAI;
  $('#set-rate').value = settings.ttsRate;
  $('#set-rate-v').textContent = (settings.ttsRate / 100).toFixed(2) + '×';

  fillVoices();
  renderSync();
  db.usage().then(u => {
    if (!u) { $('#storage-hint').textContent = '数据全部保存在本机浏览器中。'; return; }
    $('#storage-hint').textContent =
      `本地已用 ${(u.used / 1048576).toFixed(1)} MB，可用配额约 ${(u.quota / 1048576 / 1024).toFixed(1)} GB。数据全部保存在本机，不上传服务器。`;
  });
  $('#version-hint').textContent = `版本 v${APP_VERSION} · 离线词典 ` +
    (dict.status().count ? dict.status().count.toLocaleString() + ' 条' : '未加载');
}

function fillVoices() {
  const sel = $('#set-voice');
  const list = tts.voices();
  sel.innerHTML = list.length
    ? list.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)} · ${esc(v.lang)}</option>`).join('')
    : '<option value="">系统默认</option>';
  sel.value = settings.ttsVoice || (list[0]?.voiceURI || '');
  const hint = $('#voice-hint');
  if (hint) {
    const premium = tts.hasPremiumVoice();
    hint.innerHTML = premium
      ? `当前会用：<b>${esc(tts.currentVoiceName())}</b>（系统里有高质量音色，已自动优先选用）`
      : `当前只有基础音色（会用 <b>${esc(tts.currentVoiceName())}</b>）。`
        + `想要更自然的发音，去系统里下载一个高质量语音：<br>`
        + `<b>Mac</b>：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音 → 英文，挑带「(增强)」或「(高级)」的下载<br>`
        + `<b>iPhone / iPad</b>：设置 → 辅助功能 → 朗读内容 → 声音 → 英语，下载「Siri 语音」或带「增强」的<br>`
        + `下载后回到这里，音色列表里就会出现，选中即可。`;
  }
}

/* ══════════════════════════  导入 / 导出  ══════════════════════════ */

let naTitleTouched = false;

function newArticleModal() {
  naTitleTouched = false;
  openModal(`
    <h3>导入文章</h3>
    <div class="sub">支持 <b>${FORMATS}</b>，也可以直接把英文原文粘贴进来。</div>

    <div class="dropzone" id="na-drop">
      <input type="file" id="na-file" accept="${ACCEPT}" hidden>
      <span class="dz-icon">📄</span>
      <div>
        <div class="dz-main">点击选择文件</div>
        <div class="dz-sub">或把文件拖到这里 · EPUB 电子书、PDF 论文报告、Word 文档、纯文本都可以</div>
      </div>
    </div>
    <div class="na-status" id="na-status" hidden></div>

    <label class="field" style="border:none;padding:0 0 10px">
      <span style="width:80px">标题</span>
      <input type="text" id="na-title" placeholder="留空则自动取第一行">
    </label>
    <textarea id="na-text" placeholder="…也可以直接把英文原文粘贴到这里"></textarea>

    <div class="modal-foot">
      <button class="btn" data-action="na-url">🌐 从网址导入</button>
      <button class="btn" data-action="modal-close">取消</button>
      <button class="btn primary" data-action="na-save">导入并开始阅读</button>
    </div>`);

  const file = $('#na-file');
  const drop = $('#na-drop');
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    if (file.files && file.files[0]) loadFileIntoModal(file.files[0]);
    file.value = '';
  });
  for (const t of ['dragenter', 'dragover']) {
    drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('is-over'); });
  }
  for (const t of ['dragleave', 'dragend']) {
    drop.addEventListener(t, () => drop.classList.remove('is-over'));
  }
  drop.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFileIntoModal(f);
  });
  $('#na-title').addEventListener('input', () => { naTitleTouched = true; });

  if (window.innerWidth > 700) setTimeout(() => $('#na-text')?.focus(), 120);
}

/** 解析用户选中的文件，把正文填进文本框 */
async function loadFileIntoModal(file) {
  const st = $('#na-status');
  const ta = $('#na-text');
  if (!st || !ta) return;

  const MAX = 300 * 1024 * 1024;
  if (file.size > MAX) {
    st.hidden = false; st.className = 'na-status is-err';
    st.textContent = `文件太大了（${(file.size / 1048576).toFixed(0)} MB），上限 300 MB。`;
    return;
  }

  st.hidden = false;
  st.className = 'na-status is-busy';
  st.innerHTML = `<span class="spinner"></span><span id="na-status-text">正在解析 ${esc(file.name)}…</span>`;
  const setStatus = (msg) => {
    const el = $('#na-status-text');
    if (el) el.textContent = msg;
  };

  try {
    const t0 = Date.now();
    const res = await importFile(file, (i, n, msg) => {
      setStatus(msg ? `${msg}${n ? `（${i}/${n}）` : ''}` : `正在解析 ${i}/${n}…`);
    });
    const text = (res.text || '').trim();
    if (text.length < 20) throw new Error('没有提取到文本内容');

    ta.value = text;
    if (!naTitleTouched || !$('#na-title').value.trim()) {
      $('#na-title').value = res.title || '';
    }

    const words = (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    let extra = '';
    if (words > 40000) {
      extra = `<br><b>注意</b>：这是一整本长内容（${words.toLocaleString()} 词），一次渲染这么多词会让页面变卡。`
            + `建议按章节分开导入，阅读体验会好很多。`;
    }
    st.className = 'na-status is-ok';
    st.innerHTML = `✓ 已从 <b>${esc(file.name)}</b> 提取 ${words.toLocaleString()} 个英文词`
      + `（${text.length.toLocaleString()} 字符，耗时 ${secs}s）。可以直接点「导入并开始阅读」，也能先在下面修改。${extra}`;
  } catch (err) {
    st.className = 'na-status is-err';
    st.innerHTML = `✗ 导入失败：${esc(err.message || err)}`;
  }
}

async function saveNewArticle() {
  const raw = $('#na-text')?.value?.trim();
  const title = $('#na-title')?.value?.trim();
  if (!raw || raw.length < 20) { toast('内容太短了，至少粘贴一小段英文'); return; }
  const parsed = parseArticle(raw, title || '未命名文章');
  // 用户填的标题或文件自带的书名优先，不要被正文首行（常常是章节名）顶掉
  if (title) parsed.title = title;
  const art = {
    id: uid(),
    title: title || parsed.title,
    created: Date.now(),
    lastRead: Date.now(),
    progress: 0,
    wordCount: parsed.words,
    updated: touch(),
  };
  S.articles.push(art);
  parsedCache.set(art.id, parsed);
  await db.put('articles', art);
  await db.put('bodies', { id: art.id, raw, updated: art.updated });
  scheduleSync();
  closeModal();
  toast(`已导入：${art.title}`);
  openArticle(art.id);
}

async function importFromUrl() {
  const url = prompt('粘贴文章网址（只抓正文，部分网站可能失败）：');
  if (!url) return;
  toast('正在抓取…', 60000);
  try {
    const res = await fetch('https://r.jina.ai/' + url, { headers: { 'Accept': 'text/plain' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (text.length < 100) throw new Error('抓到的内容太短');
    const ta = $('#na-text');
    if (ta) { ta.value = text; toast('抓取成功，检查后点「导入」'); }
    else { toast('已抓取，请重新打开导入窗口'); }
  } catch (e) {
    toast('抓取失败：' + e.message + '（可以直接复制正文粘贴）', 4000);
  }
}

/** 导出成 Anki / 欧路词典能直接导入的 TSV（制表符分隔） */
function exportVocabAnki() {
  const list = [...S.vocab.values()];
  if (!list.length) { toast('生词本还是空的'); return; }
  const esc2 = t => String(t || '').replace(/[\t\r\n]+/g, ' ').trim();
  const rows = [
    '#separator:tab',
    '#html:true',
    '#columns:单词\t音标\t释义\t原句\t出处',
  ];
  for (const c of list) {
    const front = esc2(c.word);
    const back = [
      c.phonetic ? `/${esc2(c.phonetic)}/` : '',
      esc2(c.translation),
      c.sentence ? `<br><br><i>${esc2(c.sentence)}</i>` : '',
      c.articleTitle ? `<br><span style="color:#888">— ${esc2(c.articleTitle)}</span>` : '',
    ].filter(Boolean).join('');
    rows.push([front, esc2(c.phonetic), esc2(c.translation), esc2(c.sentence), esc2(c.articleTitle)].join('\t'));
  }
  const blob = new Blob(['\ufeff' + rows.join('\n')], { type: 'text/tab-separated-values;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lexiread-生词本-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`已导出 ${list.length} 个生词，可在 Anki 里「导入文件」直接使用`, 4500);
}

async function exportData() {
  const bodies = [];
  for (const a of S.articles) {
    try { const b = await db.get('bodies', a.id); if (b) bodies.push(b); } catch {}
  }
  const data = {
    app: 'LexiRead', version: 2, exported: new Date().toISOString(),
    settings, articles: S.articles, bodies, vocab: [...S.vocab.values()],
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lexiread-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已导出备份文件');
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.articles && !data.vocab) throw new Error('不是有效的备份文件');
    const stamp = Date.now();
    for (const a of data.articles || []) {
      const meta = { ...a };
      meta.updated = meta.updated || stamp;
      if (typeof meta.raw === 'string') {           // 旧版备份：正文内嵌在文章里
        await db.put('bodies', { id: meta.id, raw: meta.raw, updated: meta.updated });
        delete meta.raw;
      }
      await db.put('articles', meta);
    }
    for (const b of data.bodies || []) {
      await db.put('bodies', { ...b, updated: b.updated || stamp });
    }
    for (const v of data.vocab || []) {
      await db.put('vocab', { ...v, updated: v.updated || stamp });
    }
    if (data.settings) { settings = { ...DEFAULT_SETTINGS, ...data.settings }; saveSettings(); }
    await loadAll();
    toast(`导入完成：${(data.articles || []).length} 篇文章、${(data.vocab || []).length} 个生词`);
    renderLibrary(); renderVocab(); renderSettings();
  } catch (e) {
    toast('导入失败：' + e.message, 4000);
  }
}

/* ══════════════════════════  全局事件  ══════════════════════════ */

const ACTIONS = {
  'new-article': () => newArticleModal(),
  'na-save': () => saveNewArticle(),
  'na-url': () => importFromUrl(),
  'modal-close': () => closeModal(),
  'go-vocab': () => setView('vocab'),
  'go-settings': () => { closeModal(); setView('settings'); },
  'start-review': () => startReview(),
  'vocab-export': () => exportData(),
  'vocab-anki': () => exportVocabAnki(),
  'data-import': () => $('#file-import').click(),
  'data-wipe': async () => {
    if (!confirm('确定要清空所有文章、生词和缓存吗？此操作不可撤销。')) return;
    for (const s of db.STORES) await db.clear(s);
    S.articles = []; S.vocab.clear(); parsedCache.clear();
    toast('已清空');
    setView('library');
  },
  'back-top': () => window.scrollTo({ top: 0, behavior: 'smooth' }),
  'toggle-translation': async (btn) => {
    try {
      settings.showTranslation = !settings.showTranslation;
      saveSettings();
      if (btn) btn.classList.toggle('is-on', settings.showTranslation);
      if (!settings.showTranslation) { removeTranslations(); toast('已隐藏译文'); return; }

      if (!ai.hasKey()) {
        toast('要翻译需要先填 API Key：设置 → AI 引擎', 5500);
        setView('settings');
        return;
      }
      await applyCachedTranslations();
      // 只翻当前这一页 —— 不整篇翻，快又省
      await translateCurrentPage({ silent: true });
      toast('已显示本页译文（想翻整篇点「译全篇」）', 3500);
    } catch (e) {
      toast('打开译文失败：' + (e.message || e), 5000);
    }
  },
  'translate-article': () => translateArticle(),
  'toggle-annotate': (btn) => {
    const order = ['off', 'cet6', 'ky', 'toefl'];
    const i = order.indexOf(settings.annotate || 'off');
    settings.annotate = order[(i + 1) % order.length];
    saveSettings(); annoMemo.clear();
    if (btn) btn.classList.toggle('is-on', settings.annotate !== 'off');
    rerenderReader();
    const label = { off: '已关闭注释', cet6: '六级以上', ky: '考研以上', toefl: '托福/雅思以上' };
    toast(settings.annotate === 'off'
      ? '已关闭生词注释'
      : `注释已开启：${label[settings.annotate]}的词会在头顶标出简短释义`, 4000);
  },
  'translate-block': async (btn) => {
    if (!S.cur) return;
    const sid = +btn.dataset.sid;
    const bi = S.cur.sidBlock ? S.cur.sidBlock[sid] : -1;
    if (bi < 0) { toast('定位不到这一段'); return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '翻译中…';
    const wrap = $('#ph-trans-wrap'), out = $('#ph-trans');
    if (wrap) wrap.hidden = false;
    if (out) out.innerHTML = '<div class="loading"><span class="spinner"></span>正在翻译这一段…</div>';
    try {
      const tr = await ensureTranslation(bi);
      if (out) out.textContent = tr || '（这一段没有拿到译文，可以再点一次）';
      settings.showTranslation = true; saveSettings();
      const tb = $('[data-action="toggle-translation"]');
      if (tb) tb.classList.add('is-on');
      scheduleSync();
      if (isPaged()) {
        relayoutPages(true);
        setTimeout(() => {
          const node = $(`#reader-body .tr-block[data-tr-bi="${bi}"]`);
          if (node) {
            const body = $('#reader-body');
            const x = node.getBoundingClientRect().left - body.getBoundingClientRect().left;
            goPage(Math.floor((x + 4) / Math.max(1, PG.step)), true);
          }
        }, 220);
      } else {
        const node = $(`#reader-body .tr-block[data-tr-bi="${bi}"]`);
        if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } catch (e) {
      if (out) out.textContent = '翻译失败：' + (e.message || e);
      toast('翻译失败：' + (e.message || e), 4500);
    }
    btn.disabled = false;
    btn.textContent = old;
  },
  'page-prev': () => goPage(PG.page - 1),
  'page-next': () => goPage(PG.page + 1),
  'toggle-tools': () => document.body.classList.toggle('tools-open'),
  'toggle-coll': (btn) => {
    const blk = btn.closest('.def-block');
    if (blk) blk.classList.toggle('collapsed');
  },
  'close-panel': () => closePanel(),
  'go-ai': () => { closeModal(); setView('settings'); setTimeout(() => { const el = $('#set-base'); if (el) el.scrollIntoView({ block: 'center' }); }, 200); },
  'regen-guide': () => {
    if (!S.cur) return;
    const { article, parsed } = S.cur;
    db.del('aica', ai.cacheKeyFor('a', [article.id])).then(() => {
      openModal(`<h3>要点总结 · 导读</h3>
        <div class="sub">${esc(parsed.title)} · 中英双语要点</div>
        <div id="guide-out" class="ai-out"></div>
        <div class="modal-foot">
          <button class="btn" data-action="copy-guide">复制</button>
          <button class="btn" data-action="modal-close">关闭</button>
        </div>`);
      runAI($('#guide-out'), ai.cacheKeyFor('a', [article.id]), ai.articlePrompt({
        title: parsed.title, text: parsed.sentences.map(s => s.text).join(' '),
      }), { maxTokens: 1500, noCache: true });
    });
  },
  'toc': () => showToc(),
  'copy-guide': () => {
    const t = ($('#guide-out') || {}).textContent || '';
    if (!t.trim()) { toast('还没有内容'); return; }
    copyText(t).then(ok => toast(ok ? '已复制' : '复制失败，请手动选中'));
  },
  'toc-go': (btn) => { const bi = +btn.dataset.bi; closeModal(); setTimeout(() => goToBlock(bi), 80); },
  'toggle-fullscreen': async (btn) => {
    try {
      if (!document.fullscreenElement) {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (!req) throw new Error('这个浏览器不支持网页全屏');
        await req.call(el);
        btn.classList.add('is-on');
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
        btn.classList.remove('is-on');
      }
    } catch (e) {
      // iPhone 的 Safari 不给网页全屏 —— 退而用专注模式，效果接近
      document.body.classList.toggle('focus-mode');
      btn.classList.toggle('is-on', document.body.classList.contains('focus-mode'));
      toast('这个浏览器不支持网页全屏，已切换为「专注模式」（隐藏工具栏）', 4200);
    }
  },
  'toggle-focus': (btn) => {
    document.body.classList.toggle('focus-mode');
    btn.classList.toggle('is-on', document.body.classList.contains('focus-mode'));
  },
  'reader-settings': () => { setView('settings'); setTimeout(() => $$('.set-group')[1]?.scrollIntoView({ behavior: 'smooth' }), 60); },
  'tts-play': () => startReading(),
  'tts-stop': () => { tts.stop(); toast('已停止朗读'); },
  'speak-sent': (btn) => { const sid = +btn.dataset.sid; const t = ctxFor(sid).sentence; tts.say(t, settings.ttsRate / 100); },
  'speak-card': () => { if (S.review.cur) tts.say(S.review.cur.word, settings.ttsRate / 100, { slow: true }); },
  'copy-word': () => { navigator.clipboard?.writeText(S.panel?.surface || ''); toast('已复制'); },
  'copy-sent': () => { navigator.clipboard?.writeText(S.panel?.sentence || ''); toast('已复制'); },
  'to-sentence': (btn) => showSentencePanel(+btn.dataset.sid),
  'lookup-word': (btn) => {
    const w = btn.dataset.word;
    const sid = btn.dataset.sid !== undefined && btn.dataset.sid !== '' ? +btn.dataset.sid : (S.panel?.sid ?? -1);
    showWordPanel(w, sid, w);
  },
  'save': async (btn) => {
    const p = S.panel; if (!p) return;
    btn.disabled = true;
    await saveWord(p.base, p.rec, p.surface, p.sid);
    showWordPanel(p.surface, p.sid, p.surface);
  },
  'unsave': async () => {
    const p = S.panel; if (!p) return;
    const wasVocab = p.type === 'vocab';
    await unsaveWord(p.base);
    if (wasVocab) { closePanel(); renderVocab(); }
    else showWordPanel(p.surface, p.sid, p.surface);
  },
  'run-word-ai': () => {
    const p = S.panel; if (!p) return;
    const { sentence, before, after } = ctxFor(p.sid);
    runAI($('#ai-word'), ai.cacheKeyFor('w', [p.base, sentence]),
      ai.wordPrompt({ word: p.surface, sentence, before, after }));
  },
  'retry-ai': () => { const l = S.lastAI; if (l) runAI(l.el, l.key, l.messages); },
  'reveal': () => revealReview(),
  'article-guide': async () => {
    const { article, parsed } = S.cur || {};
    if (!article) return;
    openModal(`<h3>要点总结 · 导读</h3>
      <div class="sub">${esc(parsed.title)} · 中英双语要点</div>
      <div id="guide-out" class="ai-out"></div>
      <div class="modal-foot">
        <button class="btn" data-action="copy-guide">复制</button>
        <button class="btn" data-action="regen-guide">重新生成</button>
        <button class="btn" data-action="modal-close">关闭</button>
      </div>`);
    runAI($('#guide-out'), ai.cacheKeyFor('a', [article.id]), ai.articlePrompt({
      title: parsed.title, text: parsed.sentences.map(s => s.text).join(' '),
    }), { maxTokens: 1500 });
  },
  'sync-save-cfg': () => {
    const url = $('#sy-url').value.trim();
    const key = $('#sy-key').value.trim();
    if (!/^https?:\/\//.test(url) || key.length < 20) {
      renderSync('请填写完整的 Project URL（https://…）和 anon public key');
      return;
    }
    sync.saveConfig({ url, anonKey: key });
    toast('同步服务已保存');
    renderSync();
  },
  'sync-test-cfg': async () => {
    const out = $('#sy-test-out');
    const url = ($('#sy-url')?.value || '').trim();
    const key = ($('#sy-key')?.value || '').trim();
    if (out) { out.hidden = false; out.innerHTML = '<div class="loading" style="margin-top:12px"><span class="spinner"></span>正在测试…</div>'; }
    sync.saveConfig({ url, anonKey: key });
    try {
      const r = await sync.testConfig();
      if (out) out.innerHTML = `<div class="na-status is-ok" style="margin-top:12px">✓ 连接正常<br>
        <span style="font-size:12.5px;color:var(--fg-dim)">地址 ${esc(r.url)}<br>
        Key 类型：${esc(r.keyKind)}<br>数据表已就绪，可以注册账号了</span></div>`;
      renderWelcome();
      const keep = $('#sy-test-out');
      if (keep) { keep.hidden = false; keep.innerHTML = `<div class="na-status is-ok" style="margin-top:12px">✓ 连接正常，数据表已就绪 —— 现在填邮箱密码注册即可</div>`; }
    } catch (e) {
      if (out) out.innerHTML = `<div class="na-status is-err" style="margin-top:12px">✗ ${esc(e.message)}</div>`;
      else toast(e.message, 6000);
    }
  },
  'sync-reset-cfg': () => {
    if (!confirm('要换一个 Supabase 项目吗？当前登录状态会被清除，本地数据不受影响。')) return;
    sync.saveConfig({ url: '', anonKey: '', session: null, email: '' });
    renderSync();
  },
  'copy-sql': async () => {
    let sql = SQL_TEXT;
    if (!sql) sql = await loadSql();
    if (!sql) { toast('读取 SQL 失败，请到仓库的 docs/supabase.sql 复制', 4000); return; }
    const ok = await copyText(sql);
    if (ok) toast('建表 SQL 已复制，去 Supabase 的 SQL Editor 粘贴后点 Run', 4200);
    else {
      const box = $('#sql-box');
      if (box) { box.hidden = false; box.textContent = sql; }
      toast('自动复制被浏览器拦住了，请手动选中下面框里的内容复制', 5000);
    }
  },
  'toggle-sql': async (btn) => {
    const box = $('#sql-box');
    if (!box) return;
    if (box.hidden) {
      if (!box.dataset.filled) {
        const sql = await loadSql();
        box.textContent = sql || '读取失败，请到仓库 docs/supabase.sql 查看';
        box.dataset.filled = '1';
      }
      box.hidden = false;
      if (btn) btn.textContent = '收起';
    } else {
      box.hidden = true;
      if (btn) btn.textContent = '查看内容';
    }
  },
  'sync-apply-ai': () => {
    const cur = ai.getConfig();
    if (!cur.apiKey) { toast('远端还没有可用的 AI 配置'); return; }
    ai.saveConfig({ baseUrl: cur.baseUrl, model: cur.model, apiKey: cur.apiKey });
    toast('已应用云端的 AI 配置');
    renderSync();
  },
  'sync-reload-ui': () => (S.view === 'welcome' ? renderWelcome() : renderSync()),
  'welcome-skip': () => {
    localStorage.setItem(ONBOARD_KEY, '1');
    setView('library');
  },
  'welcome-go': () => {
    localStorage.setItem(ONBOARD_KEY, '1');
    setView('library');
  },
  'sync-signin': () => doAuth('in'),
  'sync-signup': () => doAuth('up'),
  'sync-now': () => runSync(true),
  'sync-signout': async () => {
    if (!confirm('退出登录？本地数据会保留，重新登录后会重新同步。')) return;
    await sync.signOut();
    renderSync();
    toast('已退出登录');
  },
  'save-ai': () => {
    ai.setConfig({
      baseUrl: $('#set-baseurl').value.trim(),
      apiKey: $('#set-apikey').value.trim(),
      model: $('#set-model').value.trim() || 'deepseek-chat',
    });
    ai.resetResolved();
    toast('已保存');
  },
  'test-ai': async () => {
    const out = $('#test-out');
    ai.setConfig({
      baseUrl: $('#set-baseurl').value.trim(),
      apiKey: $('#set-apikey').value.trim(),
      model: $('#set-model').value.trim() || 'deepseek-chat',
    });
    ai.resetResolved();
    out.hidden = false;
    out.innerHTML = '<div class="loading"><span class="spinner"></span>正在连接…</div>';
    try {
      const t0 = Date.now();
      const r = await ai.test();
      out.innerHTML = `<div class="warn-box" style="background:rgba(49,196,106,.12);border-color:rgba(49,196,106,.4)">
        ✅ 连接正常（${Date.now() - t0} ms）· 模型回复：${esc(r.slice(0, 40))}</div>`;
    } catch (e) {
      out.innerHTML = `<div class="err-box">❌ ${esc(e.message)}</div>`;
    }
  },
  'reload-dict': async () => {
    try { await db.del('kv', 'dict.json'); } catch {}
    location.reload();
  },
  'check-update': async () => {
    if (!('serviceWorker' in navigator)) { toast('当前环境不支持离线缓存'); return; }
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) { await reg.update(); toast('已检查，重新打开页面即可生效'); }
    else toast('尚未注册离线缓存');
  },
};

function onDocClick(e) {
  const el = e.target.closest?.('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  e.stopPropagation();
  fn(el, e);
}

function wire() {
  document.addEventListener('click', onDocClick);

  // 底部导航
  $$('#tabbar .tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.tab)));
  $('#btn-back').addEventListener('click', () => setView(S.view === 'review' ? 'vocab' : 'library'));
  $('#btn-settings').addEventListener('click', () => setView('settings'));
  $('#btn-sync').addEventListener('click', () => {
    if (!sync.isSignedIn()) { setView('settings'); toast('先在下面登录账号'); return; }
    runSync(true);
  });
  $('#btn-theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'sepia', 'dark'];
    settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length];
    saveSettings();
    toast('主题：' + ({ auto: '跟随系统', light: '明亮', sepia: '纸黄', dark: '暗色' })[settings.theme]);
  });

  // 阅读器
  $('#reader-body').addEventListener('click', onReaderClick);
  window.addEventListener('scroll', onScroll, { passive: true });

  // 面板
  $('#ph-close').addEventListener('click', closePanel);
  $('#scrim').addEventListener('click', closePanel);
  $('#ph-speak').addEventListener('click', () => {
    const p = S.panel;
    if (p?.type === 'sentence') tts.say(p.sentence, settings.ttsRate / 100);
    else if (p?.surface) tts.say(p.surface, settings.ttsRate / 100, { slow: true });
  });

  // 翻页模式下左右滑动
  const vp = $('#reader-viewport');
  if (vp) {
    let sx = 0, sy = 0, tracking = false;
    vp.addEventListener('touchstart', e => {
      if (!isPaged() || e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    vp.addEventListener('touchend', e => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        goPage(PG.page + (dx < 0 ? 1 : -1));
      }
    }, { passive: true });
  }

  // 面板下拉关闭（移动端）
  let dragY = null;
  $('#panel').addEventListener('touchstart', e => {
    if (window.innerWidth >= 900) return;
    if (e.target.closest('.panel-body')) return;
    dragY = e.touches[0].clientY;
  }, { passive: true });
  $('#panel').addEventListener('touchend', e => {
    if (dragY === null) return;
    if (e.changedTouches[0].clientY - dragY > 70) closePanel();
    dragY = null;
  }, { passive: true });

  // 书架 / 生词本
  $('#article-list').addEventListener('click', e => {
    const d = e.target.closest('[data-del]');
    if (d) {
      const id = d.dataset.del;
      const a = S.articles.find(x => x.id === id);
      if (!confirm(`删除《${a?.title || ''}》？`)) return;
      S.articles = S.articles.filter(x => x.id !== id);
      parsedCache.delete(id);
      // 留一个墓碑，别的设备才能知道这篇被删了
      db.put('articles', { id, title: a?.title || '', deleted: true, updated: touch() }).catch(() => {});
      db.del('bodies', id).catch(() => {});
      scheduleSync();
      renderLibrary();
      return;
    }
    const o = e.target.closest('[data-open]');
    if (o) openArticle(o.dataset.open);
  });

  $('#vocab-list').addEventListener('click', e => {
    const d = e.target.closest('[data-del-word]');
    if (d) { unsaveWord(d.dataset.delWord).then(renderVocab); return; }
    const o = e.target.closest('[data-open-word]');
    if (o) openVocabWord(o.dataset.openWord);
  });

  $('#vocab-seg').addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    S.vFilter = b.dataset.filter;
    $$('#vocab-seg .seg-btn').forEach(x => x.classList.toggle('is-on', x === b));
    renderVocab();
  });

  // 复习评分
  $('#review-card').addEventListener('click', e => {
    const g = e.target.closest('[data-grade]');
    if (g) { gradeReview(+g.dataset.grade); return; }
  });

  // 键盘：复习时按空格显示答案，1-4 评分
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);

    if (isModalOpen()) { if (e.key === 'Escape') closeModal(); return; }

    // 查词面板的快捷键：A 加入生词本 · P 发音 · Esc 关闭
    if (!typing && !$('#panel').hidden) {
      const k = e.key.toLowerCase();
      if (k === 'a') {
        e.preventDefault();
        if (S.panel && S.panel.type === 'word') {
          const name = S.panel.saved ? 'unsave' : 'save';
          const el = $(`[data-action="${name}"]`);
          if (ACTIONS[name]) ACTIONS[name](el, e);
        } else {
          toast('先点一个单词，再按 A 收藏', 2600);
        }
        return;
      }
      if (k === 'p') {
        e.preventDefault();
        const p = S.panel;
        if (p && p.type === 'sentence') tts.say(p.sentence, settings.ttsRate / 100);
        else if (p && p.surface) tts.say(p.surface, settings.ttsRate / 100, { slow: true });
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closePanel(); return; }
    }
    if (!typing && e.key === 'Escape' && S.view === 'reader') { setView('library'); return; }

    if (typing) return;
    if (S.view === 'reader' && isPaged()) {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); goPage(PG.page + 1); return; }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPage(PG.page - 1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); goPage(PG.page + PG.cols); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); goPage(PG.page - PG.cols); return; }
    }
    if (S.view !== 'review') return;
    if (e.key === ' ') { e.preventDefault(); revealReview(); }
    if (['1', '2', '3', '4'].includes(e.key) && S.review.revealed) gradeReview(+e.key);
    if (e.key === 'Escape') closePanel();
  });

  // 新建文章
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  // 拖文件到窗口任意位置
  let dragDepth = 0;
  const hint = $('#drop-hint');
  window.addEventListener('dragenter', e => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    dragDepth++;
    hint.hidden = false;
  });
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) hint.hidden = true;
  });
  window.addEventListener('drop', async e => {
    dragDepth = 0;
    hint.hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    if (!$('#modal').hidden && $('#na-drop')) {
      loadFileIntoModal(f);
    } else {
      newArticleModal();
      await loadFileIntoModal(f);
    }
  });

  // 设置项
  const bindRange = (id, key, fmt, scale = 1) => {
    const el = $(id);
    el.addEventListener('input', () => {
      settings[key] = +el.value * scale;
      $(id + '-v').textContent = fmt(+el.value);
      saveSettings();
      if (S.view === 'reader' && isPaged()) { clearTimeout(window.__pgTimer); window.__pgTimer = setTimeout(() => relayoutPages(false), 120); }
    });
  };
  bindRange('#set-fontsize', 'fontSize', v => v + 'px');
  bindRange('#set-lineheight', 'lineHeight', v => (v / 100).toFixed(2));
  bindRange('#set-width', 'width', v => v + 'px');
  bindRange('#set-rate', 'ttsRate', v => (v / 100).toFixed(2) + '×');
  $('#set-font').addEventListener('change', e => { settings.font = e.target.value; saveSettings(); });
  $('#set-theme').addEventListener('change', e => { settings.theme = e.target.value; saveSettings(); });
  $('#set-mode').addEventListener('change', e => {
    settings.readingMode = e.target.value; saveSettings();
    document.body.classList.toggle('paged', S.view === 'reader' && isPaged());
    const foot = $('#reader-foot');
    if (foot) foot.hidden = !(S.view === 'reader' && isPaged());
    if (S.view === 'reader') { if (isPaged()) relayoutPages(false); else { const b = $('#reader-body'); if (b) { b.style.transform = 'none'; b.style.columnWidth = ''; b.style.columnGap = ''; b.style.width = ''; b.style.height = ''; } window.scrollTo(0, 0); } }
  });
  $('#set-columns').addEventListener('change', e => {
    settings.columns = e.target.value; saveSettings();
    if (S.view === 'reader' && isPaged()) relayoutPages(false);
  });
  $('#set-para').addEventListener('change', e => { settings.paraStyle = e.target.value; saveSettings(); });
  $('#set-justify').addEventListener('change', e => { settings.justify = e.target.checked; saveSettings(); });
  $('#set-annotate').addEventListener('change', e => {
    settings.annotate = e.target.value; saveSettings(); annoMemo.clear();
    rerenderReader();
  });
  $('#set-sync-ai').addEventListener('change', e => {
    settings.syncAiKey = e.target.checked;
    saveSettings();
    toast(settings.syncAiKey
      ? '已开启：AI 配置会随账号同步到你的其它设备（Key 会存在你自己的 Supabase 里）'
      : '已关闭：AI 配置只留在本机', 4500);
    renderSync();
  });
  $('#set-anno-phon').addEventListener('change', e => {
    settings.annotatePhonetic = e.target.checked; saveSettings(); annoMemo.clear();
    rerenderReader();
  });
  $('#set-translation').addEventListener('change', e => {
    settings.showTranslation = e.target.checked; saveSettings();
    const tb = $('[data-action="toggle-translation"]');
    if (tb) tb.classList.toggle('is-on', settings.showTranslation);
    if (settings.showTranslation) applyCachedTranslations().then(n => { if (n > 0) translateArticle(); });
    else removeTranslations();
  });
  $('#set-autoai').addEventListener('change', e => { settings.autoAI = e.target.checked; saveSettings(); });
  $('#sync-body').addEventListener('change', e => {
    if (e.target.id === 'sy-auto') {
      sync.saveConfig({ autoSync: e.target.checked });
      if (e.target.checked) runSync(false);
      toast(e.target.checked ? '已开启自动同步' : '已关闭自动同步');
    }
  });

  $('#set-voice').addEventListener('change', e => { settings.ttsVoice = e.target.value; saveSettings(); tts.say('Hello, this is your reading voice.', settings.ttsRate / 100); });

  $('#file-import').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) importData(f);
    e.target.value = '';
  });

  // 朗读状态
  tts.setHandlers({
    state: ({ playing, sid }) => {
      $$('.tool[data-action="tts-play"]').forEach(b => b.classList.toggle('is-on', playing));
      if (S.view === 'reader') {
        $$('.sent.speaking').forEach(el => el.classList.remove('speaking'));
        if (sid !== null && sid !== undefined) {
          if (S.cur?.sidBlock) forceRenderBlock(S.cur.sidBlock[sid]);
          const el = $(`.sent[data-sid="${sid}"]`);
          if (el) {
            el.classList.add('speaking');
            if (isPaged()) {
              // 翻页模式：读到哪一栏就翻到哪一页
              const body = $('#reader-body');
              if (body) {
                const x = el.getBoundingClientRect().left - body.getBoundingClientRect().left;
                const p = Math.floor((x + 4) / Math.max(1, PG.step));
                if (p !== PG.page) goPage(p, false);
              }
            } else {
              const r = el.getBoundingClientRect();
              if (r.top < 80 || r.bottom > window.innerHeight - 40) {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }
            }
          }
        }
      }
    },
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (S.view !== 'reader' || !isPaged()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayoutPages(true), 180);
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') applySettings();
  });

  window.addEventListener('beforeunload', () => {
    if (S.cur) persistArticle(S.cur.article);   // 不会复活已删除的文章
  });
}

function startReading() {
  if (!S.cur) return;
  const items = S.cur.parsed.sentences.map(s => ({ sid: s.sid, text: s.text }));
  if (!items.length) { toast('这篇文章没有可朗读的内容'); return; }
  if (!tts.supported()) { toast('当前浏览器不支持语音朗读'); return; }
  const from = firstSentenceOnScreen();
  tts.configure({ rate: settings.ttsRate / 100, voiceURI: settings.ttsVoice });
  tts.play(items, from);
  toast('开始朗读，可再点一次停止');
}

/* 从生词本打开某词 */
function openVocabWord(word) {
  const c = S.vocab.get(word);
  if (!c) return;
  S.panel = { type: 'vocab', base: word, surface: c.word, sid: -1, rec: dict.lookup(word) };
  $('#ph-word').textContent = c.word;
  const rec = S.panel.rec;
  const sub = [];
  if (c.phonetic) sub.push(`<span class="ipa">/${esc(c.phonetic)}/</span>`);
  if (rec?.frq) sub.push(`<span class="tag freq">词频 ${rec.frq}</span>`);
  sub.push(`<span class="tag">复习 ${c.reps || 0} 次</span>`);
  sub.push(`<span class="tag">${srs.isDue(c) ? '今天待复习' : '下次 ' + fmtDate(c.due)}</span>`);
  $('#ph-sub').innerHTML = sub.join('');

  $('#panel-body').innerHTML = `
    <div class="def-block"><div class="def-label">释义</div>
      <div class="def-zh">${splitSenses(c.translation || rec?.translation || '—').map(s =>
        `<div class="sense">${s.pos ? `<span class="pos">${esc(s.pos)}</span> ` : ''}${esc(s.text)}</div>`).join('')}</div></div>
    ${c.sentence ? `<div class="def-block"><div class="def-label">收录时的原句</div>
      <div class="ctx-sent">${highlightWord(c.sentence, c.word)}</div>
      ${c.articleTitle ? `<div style="font-size:12.5px;color:var(--fg-faint);margin-top:8px">来自《${esc(c.articleTitle)}》</div>` : ''}</div>` : ''}
    <div class="def-block"><div class="def-label">AI 语境讲解</div><div id="ai-word" class="ai-out"></div></div>`;

  $('#panel-foot').innerHTML = `
    <button class="btn" data-action="unsave">✓ 移除</button>
    <button class="btn primary" data-action="speak-card">🔊 发音</button>`;
  openPanel();

  if (c.sentence && ai.hasKey()) {
    runAI($('#ai-word'), ai.cacheKeyFor('w', [word, c.sentence]),
      ai.wordPrompt({ word: c.word, sentence: c.sentence }));
  } else {
    $('#ai-word').innerHTML = '<div class="hint">没有收录原句，无法做语境讲解。</div>';
  }
}

/* ══════════════════════════  启动  ══════════════════════════ */

/** 需要重绘正文时统一走这里（改注释级别、换字体等） */
function rerenderReader() {
  if (!S.cur) return;
  renderReader();
  if (S.view === 'reader') {
    if (isPaged()) requestAnimationFrame(() => relayoutPages(false));
    else {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      if (h > 0) window.scrollTo({ top: (S.cur.article.progress || 0) * h });
    }
  }
  if (settings.showTranslation) applyCachedTranslations();
}

/** 打开文章里第一次出现的某个词（配合 ?word= 深链接） */
function focusWord(word) {
  if (!S.cur) return;
  const w = String(word).toLowerCase();
  const re = new RegExp('\\b' + String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  const hit = S.cur.parsed.sentences.find(s => re.test(s.text));
  if (!hit) return;
  const el = forceRenderBlock(S.cur.sidBlock ? S.cur.sidBlock[hit.sid] : null);
  if (el) el.scrollIntoView({ block: 'center' });
  const target = el && el.querySelector(`.w[data-sid="${hit.sid}"][data-w="${CSS.escape(w)}"]`);
  showWordPanel(String(word), hit.sid, target ? surfaceOf(target) : word);
}

/** 支持 ?article=<id> / ?word=<word> / ?tab=vocab / ?tab=settings / ?review=1 深链接（PWA 快捷方式也用它） */
function applyDeepLink() {
  let q;
  try { q = new URLSearchParams(location.search); } catch { return; }
  const art = q.get('article');
  const word = q.get('word');
  if (art || q.get('tab') || q.get('review')) localStorage.setItem(ONBOARD_KEY, '1');
  if (art) {
    const a = S.articles.find(x => x.id === art);
    if (a) {
      openArticle(a.id).then(() => { if (word) setTimeout(() => focusWord(word), 120); });
      return;
    }
  }
  if (word) setTimeout(() => focusWord(word), 260);
  const tab = q.get('tab');
  if (tab === 'vocab') return setView('vocab');
  if (tab === 'settings') return setView('settings');
  if (q.get('review') === '1') return startReview();
}

async function loadAll() {
  const [arts, voc] = await Promise.all([db.all('articles'), db.all('vocab')]);
  // 合并而不是覆盖：读取期间用户可能已经导入文章 / 收藏生词
  const byId = new Map((arts || []).filter(a => !a.deleted).map(a => [a.id, a]));
  for (const a of S.articles) if (!a.deleted) byId.set(a.id, a);
  S.articles = [...byId.values()];
  S.vocab = new Map([...(voc || []).filter(v => !v.deleted).map(v => [v.word, v]), ...S.vocab]);
}

/** 同步之后整盘重读本地数据（远端可能有增删改） */
async function reloadAll() {
  S.articles = [];
  S.vocab = new Map();
  parsedCache.clear();
  await loadAll();
}

const touch = () => Date.now();

/** 写回文章元数据。若这篇文章已经被（本机或其它设备）删除，就不要再把它写活。
 *  用事务内「读—改—写」，避免 beforeunload / 滚动进度把过期的内存副本盖回去。 */
function persistArticle(a) {
  if (!a || !a.id) return Promise.resolve();
  const plain = { ...a };
  return db.update('articles', a.id, cur => (cur && cur.deleted) ? null : plain).catch(() => {});
}

async function boot() {
  db.setOnBlocked(() => toast('检测到另一个标签页还开着旧版本，请关掉其它标签页后刷新', 9000));
  // 性能打点：仅当页面带 ?perf=1 时启用，平时完全无副作用
  if (new URLSearchParams(location.search).has('perf')) {
    window.__bm = { boot_start: Math.round(performance.now()) };
  }
  applySettings();
  wire();
  setDot('', '离线词典未加载');
  $('#article-list').innerHTML = '<div class="empty">正在读取本地数据…</div>';
  const firstRun = !localStorage.getItem(ONBOARD_KEY);
  try { setView(firstRun ? 'welcome' : 'library'); }
  catch (e) { console.error('初始视图渲染失败', e); setView('library'); }
  if (window.__bm) window.__bm.libshell = Math.round(performance.now());

  try { await loadAll(); } catch (e) { toast('读取本地数据失败：' + e.message, 4000); }
  if (window.__bm) window.__bm.loaded = Math.round(performance.now());
  renderLibrary();
  if (firstRun && !sync.isSignedIn()) renderWelcome();
  document.body.dataset.ready = '1';
  db.persist();

  ensureDict();

  // 启动后自动同步一次（登录过且开着自动同步）
  if (sync.isSignedIn() && sync.getConfig().autoSync) {
    setTimeout(() => runSync(false), 1200);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!sync.isSignedIn() || !sync.getConfig().autoSync) return;
    if (Date.now() - sync.lastSyncAt() < 60000) return;   // 一分钟内不重复
    runSync(false);
  });

  applyDeepLink();

  // ?nosw=1 可跳过 Service Worker（调试用；也方便在自动化测试里排除缓存干扰）
  if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
    try { await navigator.serviceWorker.register('./sw.js', { scope: './' }); } catch {}
  }

  // 首次使用：引导填 Key
  if (!ai.hasKey()) {
    setTimeout(() => {
      if (S.view !== 'library') return;
      toast('先到「设置 → AI 引擎」填一个 API Key，AI 讲解才能用', 5200);
    }, 1400);
  }
}

boot();
