/* DeepSeek / OpenAI 兼容接口 —— 流式调用 + 结果缓存 */

import * as db from './db.js';

const LS = 'lexiread.ai';
export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
};

export function getConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
export function setConfig(cfg) {
  const next = { ...getConfig(), ...cfg };
  localStorage.setItem(LS, JSON.stringify(next));
  return next;
}
export function hasKey() { return !!getConfig().apiKey.trim(); }

export class AIError extends Error {
  constructor(msg, kind) { super(msg); this.kind = kind || 'error'; }
}

/** 把用户填的地址展开成候选的 chat/completions 接口列表。
 *  OpenAI 兼容网关有的要 /v1 有的不要，这里两个都试，省得用户自己猜。 */
export function candidateUrls(base) {
  const b = String(base || DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return [b];
  const list = [b + '/chat/completions'];
  if (!/\/v\d+$/.test(b)) list.push(b + '/v1/chat/completions');
  return list;
}

/** 从各种可能的返回结构里抠出正文 */
function extractText(obj) {
  if (!obj) return '';
  const c = obj.choices && obj.choices[0];
  if (c) {
    if (typeof c.text === 'string' && c.text) return c.text;
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
  }
  if (typeof obj.output_text === 'string') return obj.output_text;
  if (typeof obj.content === 'string') return obj.content;
  return '';
}

function parseSSE(raw) {
  let out = '';
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith(':') || !t.startsWith('data:')) continue;
    const d = t.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try { out += extractText(JSON.parse(d)); } catch { /* 分片不完整，跳过 */ }
  }
  return out;
}

/** 读一次响应体，流式和非流式都能处理 */
async function readAnswer(res, onDelta) {
  const ctype = (res.headers.get('content-type') || '').toLowerCase();

  // 网关忽略了 stream=true，直接回了一整段 JSON
  if (!ctype.includes('event-stream')) {
    const raw = await res.text();
    let text = '';
    try { text = extractText(JSON.parse(raw)); } catch { text = parseSSE(raw); }
    if (!text) text = parseSSE(raw);
    if (text && onDelta) onDelta(text, text);
    return text;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const piece = extractText(JSON.parse(data));
        if (piece) { full += piece; if (onDelta) onDelta(piece, full); }
      } catch { /* 忽略不完整分片 */ }
    }
  }
  return full;
}

/** 记住哪个候选地址是通的，后续请求不用再试 */
const resolved = new Map();
const cacheKeyOf = cfg => cfg.baseUrl + '|' + cfg.model;

/** 某一个地址的一次尝试 */
async function tryOnce(url, cfg, body, signal, onDelta) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey.trim(),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new AIError('网络请求失败：' + (e && e.message ? e.message : e) +
      '。请检查网络，或确认接口地址是否需要代理。', 'network');
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();

  // 关键：很多网关地址写错时会「友好地」返回 200 + 一个 HTML 首页，
  // 以前会把网页当数据解析、最后报「没有返回内容」，非常难排查。
  if (ctype.includes('text/html')) {
    return { html: true, status: res.status };
  }

  if (!res.ok) {
    let detail = '';
    try {
      const t = await res.text();
      try {
        const j = JSON.parse(t);
        detail = j.error?.message || j.message || t.slice(0, 300);
      } catch { detail = t.slice(0, 300); }
    } catch {}
    const hint = res.status === 401 ? '（API Key 不正确）'
      : res.status === 402 ? '（余额不足，去平台充值）'
      : res.status === 403 ? '（这个 Key 没有该模型的权限）'
      : res.status === 429 ? '（请求太频繁，稍后再试）'
      : res.status === 404 ? '（接口地址或模型名不对）' : '';
    throw new AIError(`接口返回 ${res.status} ${hint} ${detail}`, 'http');
  }

  const text = await readAnswer(res, onDelta);
  return { text };
}

/**
 * 流式对话（自动兼容「地址要不要带 /v1」以及「网关不支持流式」两种情况）
 */
export async function streamChat(o) {
  const cfg = getConfig();
  if (!cfg.apiKey.trim()) throw new AIError('还没有填写 API Key，去「设置 → AI 引擎」填一个。', 'nokey');

  const body = {
    model: cfg.model || DEFAULTS.model,
    messages: o.messages,
    stream: true,
    temperature: o.temperature ?? 0.3,
    max_tokens: o.maxTokens ?? 900,
  };

  const key = cacheKeyOf(cfg);
  const all = candidateUrls(cfg.baseUrl);
  const cached = resolved.get(key);
  // 先把上次成功的地址试一遍，再试其它候选
  const urls = cached && all.includes(cached)
    ? [cached, ...all.filter(u => u !== cached)]
    : all;

  let sawHtml = false;
  let emptyAt = '';
  for (const url of urls) {
    const r = await tryOnce(url, cfg, body, o.signal, o.onDelta);
    if (r.html) { sawHtml = true; continue; }          // 换下一个候选地址
    if (r.text) { resolved.set(key, url); return r.text; }
    emptyAt = url;
  }

  if (sawHtml) {
    throw new AIError(
      '这个接口地址返回的是网页，不是 API。多数第三方网关需要在地址后面加 /v1，' +
      '比如 https://你的域名/v1 —— 改一下「接口地址」再试。', 'badendpoint');
  }
  if (emptyAt) {
    throw new AIError(
      `接口返回了 200 但没有正文内容（${emptyAt}）。可能是模型名不对，` +
      '或者这个网关不支持流式输出；换个模型名试试。', 'empty');
  }
  throw new AIError('接口没有返回任何内容，请重试。', 'empty');
}

/* ──────────────────────────  缓存  ────────────────────────── */

function hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = (h1 ^ c) * 16777619 >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return h1.toString(36) + '-' + h2.toString(36) + '-' + str.length.toString(36);
}

async function cached(key, produce) {
  const k = 'ai:' + key;
  try {
    const hit = await db.get('aica', k);
    if (hit && hit.text) return hit.text;
  } catch {}
  const text = await produce();
  try { await db.put('aica', { k, text, t: Date.now() }); } catch {}
  return text;
}

/** 带缓存 + 流式的统一入口；命中缓存时一次性吐给 onDelta */
export async function cachedStream(cacheKey, messages, onDelta, opts = {}) {
  const k = 'ai:' + cacheKey;
  try {
    const hit = await db.get('aica', k);
    if (hit && hit.text) {
      if (onDelta) onDelta(hit.text, hit.text, true);
      return hit.text;
    }
  } catch {}
  const text = await streamChat({ messages, onDelta: (d, full) => onDelta && onDelta(d, full, false), ...opts });
  try { await db.put('aica', { k, text, t: Date.now() }); } catch {}
  return text;
}

/* ──────────────────────────  提示词  ────────────────────────── */

const SYS = '你是一位资深的英语精读老师，面向中文母语的英语学习者。'
  + '回答必须使用简体中文，直击要点，不说客套话，不使用 Markdown 的 # 标题和代码块。'
  + '需要分点时，用「【小标题】」开头另起一行。';

export function wordPrompt({ word, sentence, before = '', after = '' }) {
  const ctx = [before && '前文：' + before, '所在句：' + sentence, after && '后文：' + after]
    .filter(Boolean).join('\n');
  return [
    { role: 'system', content: SYS },
    {
      role: 'user', content:
`学生正在读一篇英文文章，点开了单词「${word}」。

${ctx}

请只针对「${word}」在**这个句子里的用法**讲解，严格按下面五段输出，每段一行小标题，总长控制在 220 字以内：

【本句释义】词性 + 中文意思（只给这句里的那个义项）
【为什么】结合句中的搭配或上下文线索，一两句说清为什么是这个意思
【其他常用义】最多 2 条，每条一行，没有就写「无」
【例句】另造一个同一义项、同一用法的英文例句，再给中文翻译
【记忆】词根词族或常见搭配，一句话`
    },
  ];
}

export function sentencePrompt({ sentence, before = '', after = '' }) {
  const ctx = [before && '上一句：' + before, after && '下一句：' + after].filter(Boolean).join('\n');
  return [
    { role: 'system', content: SYS },
    {
      role: 'user', content:
`把下面这句英文翻译成自然、地道的中文，不要逐字直译。

句子：${sentence}
${ctx}

按下面三段输出：

【翻译】只给译文
【关键词】挑出最多 3 个影响理解的词或短语，每条写成「英文 — 此处的中文意思」
【语气】一句话说明这句话的语气或言外之意`
    },
  ];
}

export function grammarPrompt({ sentence }) {
  return [
    { role: 'system', content: SYS },
    {
      role: 'user', content:
`请拆解下面这个英文长难句的语法结构：

${sentence}

按下面四段输出：

【句子主干】主语 / 谓语 / 宾语（或表语）分别是哪部分
【成分拆解】按意群逐段拆，每行格式「原文片段 — 成分名称 — 在句中起什么作用」
【难点】从句、非谓语、倒装、省略、虚拟等语法点，最多 3 条
【翻译】最后给一句通顺的中文`
    },
  ];
}

export function articlePrompt({ title, text }) {
  return [
    { role: 'system', content: SYS },
    {
      role: 'user', content:
`用中文给我一份这篇英文文章的导读，控制在 300 字以内：

标题：${title}
正文节选：${text.slice(0, 4000)}

按下面三段输出：
【大意】三到四句话概括
【难度】大致对应什么水平（如高考 / 四级 / 六级 / 考研 / 雅思 6.5）以及理由
【亮点】3 个值得记住的地道表达，每条写成「表达 — 意思」`
    },
  ];
}

/** 整段翻译：只要译文，不要任何解释 */
export function translateParagraphPrompt({ text }) {
  return [
    {
      role: 'system',
      content: '你是专业英中译者。把用户给的英文译成自然、地道、通顺的简体中文。'
        + '只输出译文本身：不要开场白、不要解释、不要括号注释、不要重复原文、不要加「译文：」之类的字样。'
        + '保留原文的段落与标点风格，人名地名和术语用通行译法。',
    },
    { role: 'user', content: text },
  ];
}

/** 整段翻译（走缓存，同一段不会重复花钱） */
export async function translateParagraph(text, opts = {}) {
  return streamChat({
    messages: translateParagraphPrompt({ text }),
    temperature: 0.2,
    maxTokens: 1600,
    ...opts,
  });
}

export function cacheKeyFor(type, parts) {
  return type + ':' + hash(parts.filter(Boolean).join('\u0001'));
}

/** 用于「测试连接」 */
export async function test() {
  const out = await streamChat({
    messages: [
      { role: 'system', content: '你是一个测试助手。' },
      { role: 'user', content: '只回复两个字：正常' },
    ],
    maxTokens: 16,
    temperature: 0,
  });
  return String(out || '').trim();
}

/** 清掉「哪个地址是通的」记忆（改了设置后调用） */
export function resetResolved() { resolved.clear(); }
