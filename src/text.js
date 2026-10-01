/* 文章解析：段落 / 句子 / 单词 */

const ABBR = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|Inc|Ltd|Co|No|Fig|Vol|approx|e\.g|i\.e|a\.m|p\.m)\.$/i;

const WORD_RE = /[A-Za-z]+(?:[’'\-][A-Za-z]+)*/g;

export function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…' || ch === '。' || ch === '！' || ch === '？') {
      let j = i + 1;
      while (j < text.length && /[.!?…"'”’)\]）]/.test(text[j])) j++;
      const after = text[j];
      if (after === undefined || /\s/.test(after)) {
        const head = text.slice(start, j);
        if (ch === '.' && ABBR.test(head.trim())) continue;
        out.push(head);
        start = j;
        i = j - 1;
      }
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out.map(s => s.replace(/^\s+/, '')).filter(s => s.trim().length > 0);
}

/** 把一段文本切成 token：{k:'w'|'x', v:原文, w:小写词形} */
export function tokenize(text) {
  const tokens = [];
  let last = 0;
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text)) !== null) {
    if (m.index > last) tokens.push({ k: 'x', v: text.slice(last, m.index) });
    const raw = m[0];
    tokens.push({ k: 'w', v: raw, w: raw.toLowerCase().replace(/[’]/g, "'") });
    last = m.index + raw.length;
  }
  if (last < text.length) tokens.push({ k: 'x', v: text.slice(last) });
  return tokens;
}

/** 快速统计英文词数：单次遍历、不分配任何对象 */
export function countWords(str) {
  const s = String(str || '');
  let n = 0, inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    const isApos = c === 39 || c === 0x2019;
    const isHyphen = c === 45;
    if (isLetter || isApos) {
      if (!inWord) { n++; inWord = true; }
    } else if (!(isHyphen && inWord)) {
      inWord = false;
    }
  }
  return n;
}

/** 按需分词：长文只存句子文本，滚到哪儿才切哪一段 */
export function tokensOf(sent) {
  if (!sent.tokens) sent.tokens = tokenize(sent.text);
  return sent.tokens;
}

/**
 * 把被硬回车「折行」的段落重新拼回一行。
 * 只在不该断的地方拼：上一行没有句末标点，且下一行以小写字母开头。
 */
function unwrapHardWraps(block) {
  const lines = block.split('\n');
  let out = (lines[0] || '').trim();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const prevEndsSentence = /[.!?:"'”’)\]]$/.test(out);
    const lineStartsFresh = /^[A-Z0-9]/.test(line) || /^[-*•·–—\d(]/.test(line);
    out += (prevEndsSentence || lineStartsFresh) ? '\n' + line : ' ' + line;
  }
  return out;
}

/**
 * 解析整篇文章
 * @returns {{title:string, blocks:Array, sentences:Array, words:number}}
 */
export function parseArticle(raw, fallbackTitle = '未命名文章') {
  let text = String(raw || '').replace(/\r\n?/g, '\n');

  // 抽取第一个 Markdown 标题作为文章名
  let title = '';
  text = text.replace(/^\s*#\s+(.+)$/m, (mm, t) => { if (!title) title = t.trim(); return ''; });

  // 去 HTML 标签（从网页复制时常见）
  if (/<\/?[a-z][\s\S]*>/i.test(text)) {
    text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
               .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
               .replace(/<br\s*\/?>/gi, '\n')
               .replace(/<[^>]+>/g, '');
  }

  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
             .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!title) {
    const firstLine = text.split('\n').find(l => l.trim().length > 1) || fallbackTitle;
    title = firstLine.length <= 90 ? firstLine.trim() : fallbackTitle;
  }

  // 超过这个长度就不预分词了，否则一本书要造上百万个对象
  const lazyTokens = text.length > 180000;

  const paras = text
    .split(/\n{2,}/)
    .map(unwrapHardWraps)
    .flatMap(b => b.split('\n'))
    .map(p => p.trim())
    .filter(Boolean);
  const blocks = [];
  const sentences = [];
  let sid = 0;

  for (const para of paras) {
    const isHeading = para.length < 70 && !/[.!?。]$/.test(para) && /^[A-Z0-9]/.test(para)
      && para.split(/\s+/).length <= 10;
    const isQuote = /^\s*[>"“]/.test(para);
    const body = isQuote ? para.replace(/^\s*[>"“]\s*/, '') : para;

    const sents = splitSentences(body);
    const list = [];
    for (const st of sents) {
      const rec = { sid: sid++, text: st.trim(), tokens: lazyTokens ? null : tokenize(st) };
      list.push(rec);
      sentences.push(rec);
    }
    if (list.length) blocks.push({ type: isHeading ? 'h' : isQuote ? 'q' : 'p', sentences: list });
  }

  return { title, blocks, sentences, words: countWords(text), lazyTokens };
}
