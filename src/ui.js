/* 通用 UI 小工具 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let toastTimer = null;
export function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/** 把 AI 的纯文本渲染成带小标题和加粗的 HTML（已转义） */
export function renderRich(text) {
  let h = esc(text);
  h = h.replace(/【([^】]{1,20})】/g, '<span class="ai-h">【$1】</span>');
  h = h.replace(/\*\*([^*\n]{1,80})\*\*/g, '<strong>$1</strong>');
  h = h.replace(/^\s*(【[^】]+】)/gm, '$1');
  return h;
}

export function openModal(innerHTML) {
  const m = $('#modal');
  const card = $('#modal-card');
  card.innerHTML = innerHTML;
  m.hidden = false;
  return card;
}
export function closeModal() {
  $('#modal').hidden = true;
  $('#modal-card').innerHTML = '';
}
export function isModalOpen() { return !$('#modal').hidden; }

/** 把 <em> 之外的正文按「词」包一层，用于高亮原句中的目标词 */
export function highlightWord(sentence, word) {
  const re = new RegExp('\\b(' + String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b', 'gi');
  return esc(sentence).replace(re, '<em>$1</em>');
}

/** 生成挖空句：把目标词替换成下划线 */
export function clozeSentence(sentence, word) {
  const re = new RegExp('\\b' + String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
  let hit = false;
  const out = esc(sentence).replace(re, m => { hit = true; return '<em>' + '　'.repeat(Math.max(3, Math.min(10, m.length))) + '</em>'; });
  return hit ? out : esc(sentence);
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 86400000;
  if (diff < 1 && d.getDate() === now.getDate()) return '今天';
  if (diff < 2) return '昨天';
  if (diff < 7) return Math.round(diff) + ' 天前';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function readingTime(words) {
  const m = Math.max(1, Math.round(words / 200));
  return m + ' 分钟';
}

/** 用词性缩写给中文释义分段 */
const POS_RE = /^(n|v|vt|vi|a|adj|ad|adv|prep|conj|pron|num|int|art|aux|abbr|pl|u|c)\.\s*/i;
const POS_MAP = {
  n: 'n.', v: 'v.', vt: 'vt.', vi: 'vi.', a: 'adj.', adj: 'adj.', ad: 'adv.', adv: 'adv.',
  prep: 'prep.', conj: 'conj.', pron: 'pron.', num: 'num.', int: 'int.', art: 'art.',
  aux: 'aux.', abbr: 'abbr.', pl: 'pl.', u: 'u.', c: 'c.',
};

/** 把 ECDICT 的释义字符串拆成 [{pos, text}] */
export function splitSenses(zh) {
  const parts = String(zh).split(/[；;]/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = p.match(POS_RE);
    if (m) out.push({ pos: POS_MAP[m[1].toLowerCase()] || m[1] + '.', text: p.slice(m[0].length).trim() });
    else if (out.length) out[out.length - 1].text += '；' + p;
    else out.push({ pos: '', text: p });
  }
  return out.length ? out : [{ pos: '', text: String(zh) }];
}

export const TAG_LABEL = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级', ky: '考研',
  toefl: '托福', ielts: '雅思', gre: 'GRE',
};
