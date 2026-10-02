/* 语音朗读：Web Speech API 封装（iOS / iPadOS / macOS 通用） */

let queue = [];
let playing = false;
let current = null;
let cfg = { rate: 0.95, voiceURI: '' };

export function configure(next) { Object.assign(cfg, next || {}); }
export function getConfig() { return { ...cfg }; }

export function supported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/* macOS / iOS 自带一堆「玩具音色」，还有质量很差的 compact 版本，都要排到后面去 */
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|bork|doodle|flo|grandma|grandpa|rocko|shelley|sandy|reed|eddy|junior|ralph|kathy|fred|bruce|agnes|princess|victoria|alex\b)/i;
const PREMIUM = /(siri|premium|enhanced|neural|natural|google|eloquence)/i;

function voiceScore(v) {
  let s = 0;
  const n = v.name || '';
  if (/en[-_]US/i.test(v.lang)) s -= 40;
  else if (/en[-_]GB/i.test(v.lang)) s -= 30;
  else if (/en[-_](AU|IE|NZ|CA)/i.test(v.lang)) s -= 15;
  if (/siri/i.test(n)) s -= 60;                       // Siri 的自然度最好
  else if (PREMIUM.test(n)) s -= 30;
  if (/premium|enhanced/i.test(n)) s -= 25;           // 用户下载的高质量音色
  if (/compact/i.test(n)) s += 45;                    // 紧凑版最生硬
  if (NOVELTY.test(n.trim())) s += 200;               // 玩具音色，直接垫底
  if (v.localService === false) s -= 5;               // 网络音色通常更自然
  return s;
}

export function voices() {
  if (!supported()) return [];
  return speechSynthesis.getVoices()
    .filter(v => /^en/i.test(v.lang))
    .sort((a, b) => voiceScore(a) - voiceScore(b));
}

export function onVoicesReady(cb) {
  if (!supported()) return;
  const v = voices();
  if (v.length) { cb(v); return; }
  speechSynthesis.addEventListener('voiceschanged', () => cb(voices()), { once: true });
}

function pickVoice() {
  const list = voices();
  if (!list.length) return null;
  if (cfg.voiceURI) {
    const hit = list.find(v => v.voiceURI === cfg.voiceURI || v.name === cfg.voiceURI);
    if (hit) return hit;
  }
  return list[0];                                   // voices() 已按质量排序
}

/** 当前实际会用的音色名，界面上显示出来，让人知道用的是哪个 */
export function currentVoiceName() {
  const v = pickVoice();
  return v ? v.name : '系统默认';
}

/** 系统里有没有「高质量」音色（Siri / 增强版 / 高级版） */
export function hasPremiumVoice() {
  return voices().some(v => PREMIUM.test(v.name) || /premium|enhanced/i.test(v.name));
}

export function stop() {
  queue = [];
  playing = false;
  if (current) { current.onend = null; current.onerror = null; }
  current = null;
  if (supported()) { try { speechSynthesis.cancel(); } catch {} }
  if (onState) onState({ playing: false, sid: null });
}

let onState = null;
let onProgress = null;

export function setHandlers({ state, progress }) {
  onState = state;
  onProgress = progress;
}

/**
 * 朗读一串句子
 * @param {Array<{sid:any, text:string}>} items
 * @param {number} fromIndex
 */
export function play(items, fromIndex = 0) {
  if (!supported()) return false;
  stop();
  queue = items.slice(fromIndex);
  playing = true;
  next();
  return true;
}

function next() {
  if (!playing || !queue.length) {
    playing = false; current = null;
    if (onState) onState({ playing: false, sid: null });
    return;
  }
  const item = queue.shift();
  const u = new SpeechSynthesisUtterance(item.text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
  u.rate = Math.max(0.4, Math.min(1.6, cfg.rate));
  u.pitch = 1;
  current = u;
  if (onState) onState({ playing: true, sid: item.sid });
  if (onProgress) onProgress(item.sid);
  u.onend = () => { if (playing) next(); };
  u.onerror = () => { if (playing) next(); };
  try { speechSynthesis.speak(u); }
  catch { playing = false; if (onState) onState({ playing: false, sid: null }); }
}

export function isPlaying() { return playing; }

/** 朗读单个片段 */
export function say(text, rate, opts = {}) {
  if (!supported()) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    const base = rate || Math.max(0.4, Math.min(1.6, cfg.rate));
    // 单个单词读慢一些，音素更清楚；整句保持用户设定的语速
    u.rate = opts.slow ? Math.max(0.4, base * 0.82) : base;
    u.pitch = 1;
    speechSynthesis.speak(u);
  } catch {}
}
