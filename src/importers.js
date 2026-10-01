/* 文件导入：EPUB / PDF / DOCX / TXT / Markdown / HTML → 纯文本
   EPUB 与 DOCX 用内置 DecompressionStream 自己解 ZIP；PDF 懒加载 pdf.js。 */

import { unzip } from './unzip.js';

export const ACCEPT = '.txt,.text,.md,.markdown,.html,.htm,.xhtml,.epub,.pdf,.docx,.csv,.srt,.vtt';
export const FORMATS = 'EPUB · PDF · DOCX · TXT · Markdown · HTML';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function safeChar(cp) {
  try { return String.fromCodePoint(cp); } catch { return ''; }
}

/** HTML / XHTML → 纯文本 */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|svg|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|figcaption|header|footer|dd|dt|pre)\s*>/gi, '\n\n');
  s = s.replace(/<(p|div|h[1-6]|blockquote|section|article|tr|pre)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<hr\s*\/?>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 智能解码：BOM → UTF-16；失败再退回 GBK */
export function decodeText(buffer) {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    for (const enc of ['gbk', 'big5', 'windows-1252']) {
      try { return new TextDecoder(enc).decode(b); } catch { /* 继续 */ }
    }
    return new TextDecoder('utf-8').decode(b);
  }
}

const baseName = n => String(n || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || '未命名文章';

/** 从正文首行猜标题：短、不以句末标点结尾才认，否则退回文件名 */
function guessTitle(text, fallback) {
  const first = String(text || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  const clean = first.replace(/^#{1,6}\s*/, '').replace(/^[-*•]\s*/, '').trim();
  if (clean.length >= 3 && clean.length <= 90 && !/[.!?。！？;；]$/.test(clean)) return clean;
  return baseName(fallback);
}

/** 从 HTML 里取标题：优先 <h1>（通常是正文标题），再退到 <title> 并去掉「- 站点名」后缀 */
function htmlTitle(html) {
  const src = String(html || '');
  const h1 = src.match(/<h1\b[^>]*>([\s\S]{0,300}?)<\/h1>/i);
  if (h1) {
    const t = htmlToText(h1[1]).replace(/\s+/g, ' ').trim();
    if (t.length >= 3 && t.length <= 120) return t;
  }
  const m = src.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (!m) return '';
  let t = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  const cut = t.split(/\s+[|·—–-]\s+/);
  if (cut.length > 1 && cut[0].trim().length >= 8) t = cut[0].trim();
  return t;
}

function resolvePath(dir, href) {
  let h = String(href || '').split('#')[0];
  try { h = decodeURIComponent(h); } catch { /* 保持原样 */ }
  if (/^[a-z]+:\/\//i.test(h)) return h;
  const parts = (dir + h).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '' && out.length) continue;
    if (p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/* ──────────────────────────────  EPUB  ────────────────────────────── */

export async function importEpub(buffer, fallback = '未命名文章', onProgress) {
  const zip = await unzip(buffer);

  let opfPath = null;
  const container = await zip.text('META-INF/container.xml');
  if (container) {
    const m = container.match(/<rootfile\b[^>]*\bfull-path\s*=\s*"([^"]+)"/i);
    if (m) opfPath = m[1];
  }
  if (!opfPath) opfPath = zip.find(/\.opf$/i);
  if (!opfPath) throw new Error('EPUB 里找不到 OPF 清单文件');

  const opf = await zip.text(opfPath);
  if (!opf) throw new Error('OPF 文件读取失败：' + opfPath);
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const titleM = opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
  const authorM = opf.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i);
  const title = titleM ? decodeEntities(titleM[1]).trim() : '';
  const author = authorM ? decodeEntities(authorM[1]).trim() : '';

  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = (tag.match(/\bid\s*=\s*"([^"]+)"/i) || [])[1];
    const href = (tag.match(/\bhref\s*=\s*"([^"]+)"/i) || [])[1];
    const mt = (tag.match(/\bmedia-type\s*=\s*"([^"]+)"/i) || [])[1] || '';
    if (id && href) manifest.set(id, { href, mt });
  }

  const order = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = (m[0].match(/\bidref\s*=\s*"([^"]+)"/i) || [])[1];
    if (idref && manifest.has(idref)) order.push(manifest.get(idref));
  }
  // 没有 spine 就按 manifest 里所有 xhtml 顺序来
  if (!order.length) {
    for (const it of manifest.values()) if (/xhtml|html/i.test(it.mt || it.href)) order.push(it);
  }
  if (!order.length) throw new Error('EPUB 的 spine 是空的，读不到正文');

  const chunks = [];
  let done = 0;
  for (const item of order) {
    if (item.mt && !/xhtml|html|xml/i.test(item.mt)) continue;
    const raw = await zip.read(resolvePath(opfDir, item.href));
    done++;
    if (onProgress && done % 3 === 0) onProgress(done, order.length, '正在解析 EPUB 章节');
    if (!raw) continue;
    const txt = htmlToText(decodeText(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
    if (txt.length > 40) chunks.push(txt);
  }
  if (!chunks.length) throw new Error('EPUB 里没有解析到正文（可能是漫画或纯图片电子书）');

  const full = chunks.join('\n\n');
  return { title: title || guessTitle(full, fallback), author, text: full };
}

/* ──────────────────────────────  DOCX  ────────────────────────────── */

export async function importDocx(buffer, fallback = '未命名文章') {
  const zip = await unzip(buffer);
  const docXml = await zip.text('word/document.xml');
  if (!docXml) throw new Error('DOCX 缺少 word/document.xml（是不是老式 .doc 改名了？）');

  const paras = [];
  const pRe = /<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g;
  for (const pm of docXml.matchAll(pRe)) {
    const p = pm[0];
    let text = '';
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g;
    for (const tm of p.matchAll(tRe)) {
      if (tm[1] !== undefined) text += tm[1];
      else if (/^<w:tab/.test(tm[0])) text += '\t';
      else text += '\n';
    }
    const clean = decodeEntities(text).replace(/\u00a0/g, ' ').trim();
    // 标题样式单独成行，正文段落之间留空行
    paras.push(clean);
  }

  let title = '';
  try {
    const core = await zip.text('docProps/core.xml');
    if (core) {
      const m = core.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
      if (m) title = decodeEntities(m[1]).trim();
    }
  } catch { /* 没有核心属性也无所谓 */ }

  const text = paras.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 40) throw new Error('这个 DOCX 里几乎没有文字（可能是扫描件或纯图片）');
  return { title: title || guessTitle(text, fallback), text };
}

/* ──────────────────────────────  PDF  ────────────────────────────── */

let pdfjsPromise = null;
function loadPdfjs(onProgress) {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      if (onProgress) onProgress(0, 0, '正在加载 PDF 解析引擎（首次约 1.8 MB）');
      const pdfjs = await import('../vendor/pdfjs/pdf.min.js');
      pdfjs.GlobalWorkerOptions.workerSrc =
        new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return pdfjs;
    })().catch(e => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

/** 把 pdf.js 的文本片段按 y 坐标重建成行 */
function itemsToLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    const s = it.str;
    if (!s) continue;
    const y = it.transform ? it.transform[5] : 0;
    const x = it.transform ? it.transform[4] : 0;
    if (!cur || Math.abs(cur.y - y) > 2.5) {
      cur = { y, parts: [{ x, s }] };
      lines.push(cur);
    } else {
      cur.parts.push({ x, s });
    }
  }
  return lines.map(l => {
    l.parts.sort((a, b) => a.x - b.x);
    let out = '';
    let lastEnd = null;
    for (const p of l.parts) {
      if (lastEnd !== null && p.x - lastEnd > 1.2 && !/\s$/.test(out) && !/^\s/.test(p.s)) out += ' ';
      out += p.s;
      lastEnd = p.x + p.s.length * 4.4;      // 粗略估算，够用
    }
    return out.replace(/\s+$/, '');
  }).filter(l => l.trim().length);
}

export async function importPdf(buffer, fallback = '未命名文章', onProgress) {
  const pdfjs = await loadPdfjs(onProgress);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;

  let title = '';
  try {
    const meta = await doc.getMetadata();
    title = (meta?.info?.Title || '').trim();
  } catch { /* 没有元数据很正常 */ }

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (onProgress) onProgress(i, doc.numPages, `正在解析 PDF 第 ${i}/${doc.numPages} 页`);
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(itemsToLines(tc.items).join('\n'));
    page.cleanup();
  }
  const text = pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.replace(/\s/g, '').length < 60) {
    throw new Error('这个 PDF 里提取不到文字（多半是扫描件）。可以先用「预览」导出成带文字的 PDF，或者直接复制正文粘贴进来。');
  }
  return { title: title || guessTitle(text, fallback), text };
}

/* ──────────────────────────────  统一入口  ────────────────────────────── */

const TEXT_EXT = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'srt', 'vtt', 'log']);
const HTML_EXT = new Set(['html', 'htm', 'xhtml']);

export async function importFile(file, onProgress) {
  const name = file.name || '未命名';
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const buf = await file.arrayBuffer();

  if (TEXT_EXT.has(ext) || (!ext && /^text\//.test(file.type || ''))) {
    const raw = decodeText(buf);
    return { title: guessTitle(raw, name), text: raw };
  }
  if (HTML_EXT.has(ext) || file.type === 'text/html') {
    const raw = decodeText(buf);
    const body = htmlToText(raw);
    return { title: htmlTitle(raw) || guessTitle(body, name), text: body };
  }
  if (ext === 'epub' || file.type === 'application/epub+zip') {
    return importEpub(buf, name, onProgress);
  }
  if (ext === 'docx') return importDocx(buf, name);
  if (ext === 'pdf' || file.type === 'application/pdf') {
    return importPdf(buf, name, onProgress);
  }
  if (ext === 'doc') {
    throw new Error('不支持老式 .doc 格式。请在 Word / Pages 里「另存为」.docx 或导出 PDF 后再导入。');
  }
  if (['mobi', 'azw', 'azw3', 'fb2', 'lit'].includes(ext)) {
    throw new Error('Kindle 的 .mobi / .azw3 是私有格式，浏览器里没法解析。用 Calibre 免费转成 EPUB 再导入即可。');
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    throw new Error('这是压缩包，不是文章。请先把里面的 EPUB / PDF / TXT 解压出来再导入。');
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tiff'].includes(ext)) {
    throw new Error('图片里的文字需要 OCR，本应用不做 OCR。可以先在「备忘录」或「预览」里用系统实况文本复制出文字再粘贴。');
  }

  // 未知扩展名：按扩展名猜不出来就试文本
  const text = decodeText(buf);
  if (/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 4000))) {
    throw new Error(`不认识的格式：.${ext || '(无扩展名)'}。目前支持 ${FORMATS}。`);
  }
  return { title: guessTitle(text, name), text };
}
