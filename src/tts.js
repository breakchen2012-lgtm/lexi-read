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

export function voices() {
  if (!supported()) return [];
  return speechSynthesis.getVoices()
    .filter(v => /^en/i.test(v.lang))
    .sort((a, b) => {
      const score = v =>
        (/en[-_]US/i.test(v.lang) ? 0 : /en[-_]GB/i.test(v.lang) ? 1 : 2) +
        (/Siri|Samantha|Daniel|Karen|Alex|Google|Natural|Enhanced|Premium/i.test(v.name) ? 0 : 1);
      return score(a) - score(b);
    });
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
  return list[0];
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
export function say(text, rate) {
  if (!supported()) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = rate || Math.max(0.4, Math.min(1.6, cfg.rate));
    speechSynthesis.speak(u);
  } catch {}
}
