/* 精读 LexiRead —— 主程序 */

import * as db from './db.js';
import * as dict from './dict.js';
import * as ai from './ai.js';
import * as tts from './tts.js';
import * as srs from './srs.js';
import { parseArticle, tokensOf } from './text.js';
import { importFile, ACCEPT, FORMATS } from './importers.js';
import {
  $, $$, esc, toast, renderRich, openModal, closeModal, isModalOpen,
  highlightWord, clozeSentence, fmtDate, readingTime, splitSenses, TAG_LABEL,
} from './ui.js';

/* ══════════════════════════  设置  ══════════════════════════ */

const SET_KEY = 'lexiread.settings';
const DEFAULT_SETTINGS = {
  fontSize: 20, lineHeight: 190, width: 720, font: 'serif',
  theme: 'auto', autoAI: true, ttsRate: 95, ttsVoice: '',
};
let settings = (() => {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SET_KEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
})();
function saveSettings() {
  localStorage.setItem(SET_KEY, JSON.stringify(settings));
  applySettings();
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
  const tabMap = { library: 'library', reader: 'library', vocab: 'vocab', review: 'vocab', settings: 'settings' };
  $$('#tabbar .tab').forEach(t => t.classList.toggle('is-on', t.dataset.tab === tabMap[name]));
  $('#btn-back').hidden = !(name === 'reader' || name === 'review');
  document.body.classList.toggle('focus-mode', false);
  $$('.tool').forEach(t => t.classList.remove('is-on'));

  const titles = { library: '精读', reader: S.cur?.article.title || '阅读', vocab: '生词本', review: '复习', settings: '设置' };
  $('#tb-title').textContent = titles[name] || '精读';

  if (name === 'library') renderLibrary();
  if (name === 'vocab') renderVocab();
  if (name === 'settings') renderSettings();
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
  db.put('articles', { ...article }).catch(() => {});   // 只写元数据，很轻

  renderReader();
  setView('reader');
  requestAnimationFrame(() => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    if (h > 0 && article.progress > 0.005) window.scrollTo({ top: article.progress * h });
  });
}

const LAZY_WORD_LIMIT = 5000;      // 超过这么多词就改成「滚到哪儿渲染哪儿」
let readerObserver = null;

/** 把一个段落的纯文本换成可点词的 span（幂等） */
function tokenizeBlock(el, block) {
  if (!el || el.dataset.rendered === '1') return;
  const frag = document.createDocumentFragment();
  for (const sent of block.sentences) {
    const sEl = document.createElement('span');
    sEl.className = 'sent';
    sEl.dataset.sid = sent.sid;
    for (const t of tokensOf(sent)) {
      if (t.k === 'w') {
        const wEl = document.createElement('span');
        wEl.className = 'w' + (S.vocab.has(t.w) ? ' saved' : '');
        wEl.dataset.w = t.w;
        wEl.dataset.sid = sent.sid;
        wEl.textContent = t.v;
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

  if (parsed.words > LAZY_WORD_LIMIT && typeof IntersectionObserver !== 'undefined') {
    // 第二遍：滚到附近才把段落变成可点词，避免一口气造几十万个 DOM 节点
    readerObserver = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target;
        readerObserver.unobserve(el);
        tokenizeBlock(el, parsed.blocks[+el.dataset.bi]);
      }
    }, { rootMargin: '1500px 0px 1500px 0px' });
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
  $('#reader-end').innerHTML = `
    <div style="margin-bottom:14px">— 已读完 · 共 ${parsed.words} 词 —</div>
    <div class="row-actions" style="justify-content:center">
      <button class="btn" data-action="article-guide">✨ 生成 AI 导读</button>
      <button class="btn" data-action="back-top">↑ 回到顶部</button>
    </div>
    <div id="guide-out" class="ai-out" style="text-align:left;margin-top:18px"></div>`;
}

/* 阅读进度 */
let progTimer = null;
function onScroll() {
  if (S.view !== 'reader' || !S.cur) return;
  clearTimeout(progTimer);
  progTimer = setTimeout(() => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0;
    S.cur.article.progress = ratio;
    db.put('articles', { ...S.cur.article }).catch(() => {});
  }, 350);
}

/* ── 点词 / 点句 ── */
function onReaderClick(e) {
  if (isModalOpen()) return;
  const w = e.target.closest?.('.w');
  if (w) { showWordPanel(w.dataset.w, +w.dataset.sid, w.textContent); return; }
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
  S.panel = { type: 'word', base, surface: surfaceForm, sid, rec };
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

  $('#panel-body').innerHTML = dictBlock + sentBlock + aiBlock;

  $('#panel-foot').innerHTML = saved
    ? `<button class="btn" data-action="unsave">✓ 已在生词本 · 移除</button>
       <span style="font-size:12.5px;color:var(--fg-dim)">${srs.isDue(saved) ? '今天待复习' : '下次 ' + fmtDate(saved.due)}</span>`
    : `<button class="btn primary" data-action="save">＋ 加入生词本</button>`;

  const extra = [];
  if (sentence) extra.push(`<button class="btn" data-action="to-sentence" data-sid="${sid}">整句翻译 · 语法</button>`);
  extra.push(`<button class="btn" data-action="copy-word">复制</button>`);
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
    <div class="def-block"><div class="def-label">翻译</div><div id="ai-tr" class="ai-out"></div></div>
    <div class="def-block"><div class="def-label">语法拆解</div><div id="ai-gr" class="ai-out"></div></div>`;

  $('#panel-foot').innerHTML = `
    <button class="btn primary" data-action="speak-sent" data-sid="${sid}">🔊 朗读本句</button>
    <button class="btn" data-action="copy-sent">复制</button>`;

  openPanel();

  if (ai.hasKey()) {
    runAI($('#ai-tr'), ai.cacheKeyFor('t', [sentence]), ai.sentencePrompt({ sentence, before, after }));
    runAI($('#ai-gr'), ai.cacheKeyFor('g', [sentence]), ai.grammarPrompt({ sentence }));
  } else {
    const msg = '<div class="warn-box">还没有配置 API Key，去「设置 → AI 引擎」填写后即可使用 AI 翻译与语法拆解。</div>';
    $('#ai-tr').innerHTML = msg; $('#ai-gr').innerHTML = '';
  }
}

/* ── AI 流式渲染 ── */
function runAI(el, key, messages) {
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
    if (!firstPaint) { el.innerHTML = ''; firstPaint = true; }
    el.innerHTML = renderRich(acc);
    el.classList.add('stream-cursor');
  };

  ai.cachedStream(key, messages, (d, full, cached) => {
    acc = full;
    if (cached) { el.innerHTML = renderRich(acc); el.classList.remove('stream-cursor'); return; }
    if (!raf) raf = requestAnimationFrame(paint);
  }, { signal: ac.signal })
    .then(() => {
      el.classList.remove('stream-cursor');
      if (!acc) el.innerHTML = '<div class="err-box">AI 没有返回内容，请重试。</div>';
    })
    .catch(err => {
      if (err && err.name === 'AbortError') return;
      el.classList.remove('stream-cursor');
      el.innerHTML = `<div class="err-box">${esc(err.message || err)}</div>
        <div class="row-actions" style="margin-top:10px">
          <button class="btn" data-action="retry-ai">重试</button>
          <button class="btn" data-action="go-settings">去设置</button>
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
  try { await db.put('vocab', { ...R.cur }); } catch {}
  S.vocab.set(R.cur.word, R.cur);
  R.done++;
  // 忘记的词重新排到队尾
  if (g === 1) R.queue.push(R.cur);
  R.i++;
  showReviewCard();
  if (S.view === 'vocab') renderVocab();
}

/* ══════════════════════════  生词操作  ══════════════════════════ */

async function saveWord(base, rec, surface, sid) {
  const { sentence } = ctxFor(sid);
  const card = srs.newCard(base, {
    phonetic: rec?.phonetic || '',
    translation: rec?.translation || '',
    sentence,
    articleId: S.cur?.article.id || '',
    articleTitle: S.cur?.article.title || '',
  });
  S.vocab.set(base, card);
  try { await db.put('vocab', card); } catch {}
  $$(`.w[data-w="${CSS.escape(base)}"]`).forEach(el => el.classList.add('saved'));
  toast('已加入生词本：' + base);
  return card;
}

async function unsaveWord(base) {
  S.vocab.delete(base);
  try { await db.del('vocab', base); } catch {}
  $$(`.w[data-w="${CSS.escape(base)}"]`).forEach(el => el.classList.remove('saved'));
  toast('已从生词本移除：' + base);
}

/* ══════════════════════════  设置页  ══════════════════════════ */

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
  $('#set-autoai').checked = !!settings.autoAI;
  $('#set-rate').value = settings.ttsRate;
  $('#set-rate-v').textContent = (settings.ttsRate / 100).toFixed(2) + '×';

  fillVoices();
  db.usage().then(u => {
    if (!u) { $('#storage-hint').textContent = '数据全部保存在本机浏览器中。'; return; }
    $('#storage-hint').textContent =
      `本地已用 ${(u.used / 1048576).toFixed(1)} MB，可用配额约 ${(u.quota / 1048576 / 1024).toFixed(1)} GB。数据全部保存在本机，不上传服务器。`;
  });
  $('#version-hint').textContent = '版本 v1.0 · 离线词典 ' +
    (dict.status().count ? dict.status().count.toLocaleString() + ' 条' : '未加载');
}

function fillVoices() {
  const sel = $('#set-voice');
  const list = tts.voices();
  sel.innerHTML = list.length
    ? list.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)} · ${esc(v.lang)}</option>`).join('')
    : '<option value="">系统默认</option>';
  sel.value = settings.ttsVoice || (list[0]?.voiceURI || '');
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
  };
  S.articles.push(art);
  parsedCache.set(art.id, parsed);
  await db.put('articles', art);
  await db.put('bodies', { id: art.id, raw });
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
    for (const a of data.articles || []) {
      const meta = { ...a };
      if (typeof meta.raw === 'string') {           // 旧版备份：正文内嵌在文章里
        await db.put('bodies', { id: meta.id, raw: meta.raw });
        delete meta.raw;
      }
      await db.put('articles', meta);
    }
    for (const b of data.bodies || []) { await db.put('bodies', b); }
    for (const v of data.vocab || []) { await db.put('vocab', v); }
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
  'data-import': () => $('#file-import').click(),
  'data-wipe': async () => {
    if (!confirm('确定要清空所有文章、生词和缓存吗？此操作不可撤销。')) return;
    for (const s of db.STORES) await db.clear(s);
    S.articles = []; S.vocab.clear(); parsedCache.clear();
    toast('已清空');
    setView('library');
  },
  'back-top': () => window.scrollTo({ top: 0, behavior: 'smooth' }),
  'toggle-focus': (btn) => {
    document.body.classList.toggle('focus-mode');
    btn.classList.toggle('is-on', document.body.classList.contains('focus-mode'));
  },
  'reader-settings': () => { setView('settings'); setTimeout(() => $$('.set-group')[1]?.scrollIntoView({ behavior: 'smooth' }), 60); },
  'tts-play': () => startReading(),
  'tts-stop': () => { tts.stop(); toast('已停止朗读'); },
  'speak-sent': (btn) => { const sid = +btn.dataset.sid; const t = ctxFor(sid).sentence; tts.say(t, settings.ttsRate / 100); },
  'speak-card': () => { if (S.review.cur) tts.say(S.review.cur.word, settings.ttsRate / 100); },
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
    const el = $('#guide-out'); if (!el) return;
    const { article, parsed } = S.cur;
    runAI(el, ai.cacheKeyFor('a', [article.id]), ai.articlePrompt({
      title: parsed.title, text: parsed.sentences.map(s => s.text).join(' '),
    }));
  },
  'save-ai': () => {
    ai.setConfig({
      baseUrl: $('#set-baseurl').value.trim(),
      apiKey: $('#set-apikey').value.trim(),
      model: $('#set-model').value.trim() || 'deepseek-chat',
    });
    toast('已保存');
  },
  'test-ai': async () => {
    const out = $('#test-out');
    ai.setConfig({
      baseUrl: $('#set-baseurl').value.trim(),
      apiKey: $('#set-apikey').value.trim(),
      model: $('#set-model').value.trim() || 'deepseek-chat',
    });
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
    else if (p?.surface) tts.say(p.surface, settings.ttsRate / 100);
  });

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
      db.del('articles', id).catch(() => {});
      db.del('bodies', id).catch(() => {});
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
    if (S.view !== 'review' || isModalOpen()) return;
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
    });
  };
  bindRange('#set-fontsize', 'fontSize', v => v + 'px');
  bindRange('#set-lineheight', 'lineHeight', v => (v / 100).toFixed(2));
  bindRange('#set-width', 'width', v => v + 'px');
  bindRange('#set-rate', 'ttsRate', v => (v / 100).toFixed(2) + '×');
  $('#set-font').addEventListener('change', e => { settings.font = e.target.value; saveSettings(); });
  $('#set-theme').addEventListener('change', e => { settings.theme = e.target.value; saveSettings(); });
  $('#set-autoai').addEventListener('change', e => { settings.autoAI = e.target.checked; saveSettings(); });
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
            const r = el.getBoundingClientRect();
            if (r.top < 80 || r.bottom > window.innerHeight - 40) {
              el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
          }
        }
      }
    },
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') applySettings();
  });

  window.addEventListener('beforeunload', () => {
    if (S.cur) db.put('articles', { ...S.cur.article }).catch(() => {});
  });
}

function startReading() {
  if (!S.cur) return;
  const items = S.cur.parsed.sentences.map(s => ({ sid: s.sid, text: s.text }));
  if (!items.length) { toast('这篇文章没有可朗读的内容'); return; }
  if (!tts.supported()) { toast('当前浏览器不支持语音朗读'); return; }
  // 从当前视口位置开始读（用段落定位，懒渲染下也准）
  let from = 0;
  for (const el of $$('#reader-body [data-bi]')) {
    if (el.getBoundingClientRect().bottom > 110) { from = +el.dataset.sid0 || 0; break; }
  }
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
  showWordPanel(String(word), hit.sid, target ? target.textContent : word);
}

/** 支持 ?article=<id> / ?word=<word> / ?tab=vocab / ?tab=settings / ?review=1 深链接（PWA 快捷方式也用它） */
function applyDeepLink() {
  let q;
  try { q = new URLSearchParams(location.search); } catch { return; }
  const art = q.get('article');
  const word = q.get('word');
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
  const byId = new Map((arts || []).map(a => [a.id, a]));
  for (const a of S.articles) byId.set(a.id, a);
  S.articles = [...byId.values()];
  S.vocab = new Map([...(voc || []).map(v => [v.word, v]), ...S.vocab]);
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
  setView('library');
  if (window.__bm) window.__bm.libshell = Math.round(performance.now());

  try { await loadAll(); } catch (e) { toast('读取本地数据失败：' + e.message, 4000); }
  if (window.__bm) window.__bm.loaded = Math.round(performance.now());
  renderLibrary();
  document.body.dataset.ready = '1';
  db.persist();

  ensureDict();
  applyDeepLink();

  if ('serviceWorker' in navigator) {
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
