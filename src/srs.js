/* 间隔重复：SM-2 精简版 */

export const DAY = 86400000;

export function newCard(word, extra = {}) {
  const now = Date.now();
  return {
    word,
    phonetic: '',
    translation: '',
    sentence: '',
    articleId: '',
    articleTitle: '',
    added: now,
    last: 0,
    due: now,
    interval: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    stage: 'learning',
    ...extra,
  };
}

/** 返回按 grade 评分后的下次间隔（天），不修改原对象 */
export function previewInterval(card, g) {
  const v = { ...card };
  apply(v, g, card.last || Date.now());
  const d = (v.due - (card.last || Date.now())) / DAY;
  return Math.max(d, 10 / 1440);
}

export function apply(card, g, now = Date.now()) {
  const v = card;
  v.reps = v.reps || 0;
  v.ease = v.ease || 2.5;
  v.interval = v.interval || 0;
  v.lapses = v.lapses || 0;

  if (g === 1) {
    v.lapses++;
    v.reps = 0;
    v.interval = 0;
    v.ease = Math.max(1.3, v.ease - 0.2);
    v.due = now + 10 * 60000;            // 10 分钟后再来
  } else {
    v.reps++;
    const q = g === 2 ? 3 : g === 3 ? 4 : 5;
    v.ease = Math.max(1.3, Math.min(3.2,
      v.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))));
    if (v.reps === 1) v.interval = g === 2 ? 0.5 : g === 3 ? 1 : 3;
    else if (v.reps === 2) v.interval = g === 2 ? 2 : g === 3 ? 4 : 7;
    else {
      const mult = g === 2 ? 0.7 : g === 4 ? 1.3 : 1;
      v.interval = Math.round(Math.max(v.interval, 1) * v.ease * mult);
    }
    v.interval = Math.min(v.interval, 365);
    v.due = now + v.interval * DAY;
  }

  v.last = now;
  v.stage = v.interval >= 21 ? 'mastered' : 'learning';
  return v;
}

export function fmtInterval(days) {
  if (days < 1 / 24) return Math.max(1, Math.round(days * 1440)) + ' 分';
  if (days < 1) return Math.round(days * 24) + ' 小时';
  if (days < 30) return Math.round(days) + ' 天';
  if (days < 365) return (days / 30).toFixed(days < 60 ? 1 : 0) + ' 个月';
  return (days / 365).toFixed(1) + ' 年';
}

export const isDue = (c, now = Date.now()) => !c.due || c.due <= now;
