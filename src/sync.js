/* 账号与跨设备同步（Supabase）
   ─ 登录：邮箱 + 密码，走 Supabase Auth 的 REST 接口，不需要后端服务器
   ─ 同步：按记录「谁的时间戳新听谁的」合并，删除用墓碑标记，不会互相覆盖
   ─ 未配置时整个模块静默不工作，App 照常离线使用            */

import * as db from './db.js';

const LS = 'lexiread.sync';
const PAGE = 1000;

export class SyncError extends Error {}

/* ══════════════════  配置  ══════════════════ */

function baked() {
  try { return window.LEXIREAD_CONFIG || {}; } catch { return {}; }
}

export function getConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS) || '{}'); } catch {}
  const b = baked();
  return {
    url: String(saved.url || b.supabaseUrl || '').trim().replace(/\/+$/, ''),
    anonKey: String(saved.anonKey || b.supabaseAnonKey || '').trim(),
    session: saved.session || null,
    email: saved.email || '',
    lastPull: saved.lastPull || 0,
    lastPush: saved.lastPush || {},
    lastSync: saved.lastSync || 0,
    autoSync: saved.autoSync !== false,
  };
}

export function saveConfig(patch) {
  const next = { ...getConfig(), ...patch };
  localStorage.setItem(LS, JSON.stringify(next));
  return next;
}

/**
 * 配置自检：地址对不对、Key 收不收、建表 SQL 跑没跑。
 * 不需要登录就能用，专门给刚配好的人一个明确反馈。
 */
export async function testConfig() {
  const c = getConfig();
  if (!c.url || !c.anonKey) throw new SyncError('还没有填写项目地址和 Key');
  // Supabase 官方一定是 https；本机自建的允许 http
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(c.url);
  if (!/^https:\/\//.test(c.url) && !isLocal) {
    throw new SyncError('项目地址要以 https:// 开头，形如 https://xxxxxxxx.supabase.co');
  }
  if (/^sb_secret_/.test(c.anonKey)) {
    throw new SyncError('这是 secret key，不能放在前端。请改用 Publishable key（或旧版的 anon public）');
  }

  // 1) 地址与 Key 是否被接受
  let r;
  try {
    r = await fetch(`${c.url}/auth/v1/settings`, { headers: { apikey: c.anonKey } });
  } catch (e) {
    throw new SyncError('连不上这个地址：' + (e.message || e) +
      '。检查 Project URL 有没有抄错（形如 https://xxxxxxxx.supabase.co）');
  }
  if (r.status === 401 || r.status === 403) {
    throw new SyncError('地址能通，但 Key 不被接受。确认复制的是 Publishable key（sb_publishable_…）或旧版 anon public');
  }
  if (r.status === 404) {
    throw new SyncError('地址能通但路径不对，Project URL 应该是 https://你的项目.supabase.co（结尾不要带 /rest/v1）');
  }
  if (!r.ok) throw new SyncError('连接返回 HTTP ' + r.status);

  // 2) 建表 SQL 跑了没有
  let t;
  try {
    t = await fetch(`${c.url}/rest/v1/lexi_settings?select=user_id&limit=1`, {
      headers: { apikey: c.anonKey },
    });
  } catch (e) {
    throw new SyncError('地址和 Key 都对，但读取数据表失败：' + (e.message || e));
  }
  if (t.status === 404) {
    throw new SyncError('地址和 Key 都对，但还没建表 —— 请到 SQL Editor 里执行那段建表语句（应用里有「📋 复制建表 SQL」按钮）');
  }
  if (!t.ok && t.status !== 401 && t.status !== 403) {
    throw new SyncError('数据表读取返回 HTTP ' + t.status);
  }

  return {
    url: c.url,
    keyKind: /^sb_publishable_/.test(c.anonKey) ? 'publishable（新版公开密钥）'
      : /^eyJ/.test(c.anonKey) ? 'anon JWT（旧版公开密钥）' : '未知格式',
    tables: true,
  };
}

export function isConfigured() {
  const c = getConfig();
  return !!(c.url && c.anonKey);
}
export function isSignedIn() {
  const c = getConfig();
  return !!(c.session && c.session.access_token && c.session.user);
}
export function currentEmail() { return getConfig().email; }
export function lastSyncAt() { return getConfig().lastSync; }

/* ══════════════════  底层请求  ══════════════════ */

async function readJson(res) {
  const txt = await res.text().catch(() => '');
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

function explain(status, body) {
  const msg = body.error_description || body.msg || body.message || body.error || body.hint || '';

  if (/row-level security|violates row-level/i.test(msg)) {
    return '数据被数据库的安全策略拒绝了（row-level security）。\n'
      + '通常是因为建表 SQL 没有完整执行，或者登录状态不完整。'
      + '请到 Supabase 的 SQL Editor 里把建表语句重新执行一遍，然后退出登录再登一次。';
  }

  // 邮箱未验证：不同的 GoTrue 版本会返回 400 或 401，先统一拦下来
  if (/email not confirmed|email_not_confirmed/i.test(msg)) {
    return '邮箱还没验证。去收件箱（含垃圾邮件）点确认链接；\n'
      + '或者去 Supabase，在 Authentication → Sign In / Providers → Email 里关掉「Confirm email」，'
      + '再到 Authentication → Users 删掉这个用户，回应用重新注册一次即可。';
  }

  // 免费版内置邮件的发送频率限制：注册要发验证邮件时很容易撞上
  if (/rate limit|too many requests|over_email_send_rate_limit/i.test(msg) || status === 429) {
    return status === 429 || /email/i.test(msg)
      ? '邮件发送太频繁了。Supabase 免费版内置邮件每小时只能发几封。\n'
        + '最省事的解决办法：去 Supabase 左侧 Authentication → Sign In / Providers → Email，'
        + '把「Confirm email」关掉。关掉后注册不发邮件、立即生效，也不再受这个限制。'
      : '请求太频繁，请稍等一会儿再试。';
  }
  if (/User already registered|already been registered/i.test(msg)) {
    return '这个邮箱已经注册过了。如果当时没收到验证邮件，先按上面说的关掉「Confirm email」，然后直接点「登录」。';
  }
  if (status === 400 && /already registered|already exists/i.test(msg)) return '这个邮箱已经注册过了，直接登录吧';
  if (status === 400 && /password/i.test(msg)) return '密码太短了，至少要 6 位';
  if (status === 400 && /invalid login|invalid_grant/i.test(msg)) return '邮箱或密码不对';
  if (status === 401 || status === 403) {
    return '登录已过期，请重新登录（' + (msg || status) + '）';
  }
  if (status === 404) return '接口地址不对，检查一下 Supabase 项目地址（要 https://xxx.supabase.co）';
  if (status === 409) return '数据冲突，稍后重试';
  if (status === 422) return '数据格式不被接受：' + msg;
  return msg || ('请求失败 HTTP ' + status);
}

async function authFetch(path, body, method = 'POST') {
  const c = getConfig();
  if (!c.url || !c.anonKey) throw new SyncError('还没有填写 Supabase 项目地址和 anon key');
  let res = null;
  for (let i = 0; i < 3; i++) {
    try {
      res = await fetch(`${c.url}/auth/v1/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', apikey: c.anonKey },
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e) {
      if (i === 2) throw new SyncError('连不上同步服务：' + (e.message || e) + '（网络不通？稍后再试）');
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  const data = await readJson(res);
  if (!res.ok) throw new SyncError(explain(res.status, data));
  return data;
}

function storeSession(data, email) {
  if (!data || !data.access_token) return null;
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
    user: data.user || (getConfig().session && getConfig().session.user) || null,
  };
  saveConfig({ session, email: email || (session.user && session.user.email) || getConfig().email });
  return session;
}

/* ══════════════════  账号  ══════════════════ */

export async function signUp(email, password) {
  const data = await authFetch('signup', { email, password });
  if (data.access_token) { storeSession(data, email); return { ok: true, needConfirm: false }; }
  return { ok: true, needConfirm: true };   // 项目开了邮箱验证
}

export async function signIn(email, password) {
  const data = await authFetch('token?grant_type=password', { email, password });
  storeSession(data, email);
  return { ok: true };
}

export async function signOut() {
  try { await authFetch('logout', null); } catch { /* 本地登出就够了 */ }
  saveConfig({ session: null, email: '', lastPull: 0, lastPush: {}, lastSync: 0 });
}

/** 取一个没过期的 token，快过期就刷新 */
/** 单飞：并发请求同时发现 token 过期时，只发一次刷新请求。
 *  这点很关键 —— Supabase 的 refresh token 是一次性轮换的，
 *  并发刷新会把整个令牌族作废，用户就被踢下线（表现为「总是断线」）。 */
let refreshing = null;

async function ensureToken(force = false) {
  const c = getConfig();
  if (!c.session || !c.session.access_token) throw new SyncError('请先登录账号', 'noauth');

  // 到期前 2 分钟就提前续期，避免边界上刚好过期
  if (!force && c.session.expires_at && Date.now() < c.session.expires_at - 120000) return c;

  if (!refreshing) {
    refreshing = (async () => {
      const cur = getConfig();
      const rt = cur.session && cur.session.refresh_token;
      if (!rt) {
        saveConfig({ session: null });
        throw new SyncError('登录状态已失效，请重新登录', 'noauth');
      }
      try {
        const data = await authFetch('token?grant_type=refresh_token', { refresh_token: rt });
        storeSession(data, cur.email);
        syncError(null);
        return getConfig();
      } catch (e) {
        // refresh token 也失效了（比如换了设备、或太久没用）→ 清掉会话并让界面提示重新登录
        saveConfig({ session: null });
        syncError('登录已过期，请重新登录');
        throw new SyncError('登录已过期，请重新登录', 'noauth');
      }
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isNetErr = e => !e || e.name === 'TypeError' || /fetch|network|load failed|timed? ?out/i.test(String(e && e.message || e));

/* 同步状态，给界面用 */
export function status() {
  const c = getConfig();
  return { lastSync: c.lastSync || 0, lastError: c.lastError || '', signedIn: isSignedIn() };
}
function syncError(msg) { saveConfig({ lastError: msg || '' }); }

/* ══════════════════  数据接口  ══════════════════ */

async function rest(table, { method = 'GET', query = '', body, prefer } = {}) {
  let attempt = 0;
  let lastNet = null;

  while (attempt < 4) {
    const c = await ensureToken(attempt > 0);

    let res;
    try {
      res = await fetch(`${c.url}/rest/v1/${table}${query}`, {
        method,
        headers: {
          apikey: c.anonKey,
          Authorization: 'Bearer ' + c.session.access_token,
          'Content-Type': 'application/json',
          Prefer: prefer || 'resolution=merge-duplicates,return=minimal',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // 网络抖动（Supabase 在境外，国内网络容易断）—— 退避重试
      lastNet = e;
      attempt++;
      if (attempt >= 4) break;
      await sleep(400 * attempt * attempt);
      continue;
    }

    // token 可能刚好过期 —— 但 403 里有一类是 RLS 拒绝（策略问题），刷新没用，别白重试
    const looksAuth = res.status === 401;
    if (looksAuth && attempt < 2 && isSignedIn()) { attempt++; continue; }
    if (res.status === 403) {
      const probe = await res.clone().text().catch(() => '');
      if (/jwt|expired|invalid claim/i.test(probe) && attempt < 2 && isSignedIn()) { attempt++; continue; }
    }

    if (!res.ok) {
      const data = await readJson(res);
      const m = explain(res.status, data);
      if (res.status >= 500) {                 // 服务端临时故障也重试
        attempt++;
        if (attempt < 4) { await sleep(500 * attempt); continue; }
      }
      throw new SyncError(m + `（${table}）`);
    }

    const txt = await res.text().catch(() => '');
    if (!txt) return null;
    try { return JSON.parse(txt); } catch { return null; }
  }

  throw new SyncError('网络连接不稳定，同步失败：' +
    (lastNet && lastNet.message ? lastNet.message : '请检查网络后重试'), 'network');
}

/** 分页拉全表 */
async function fetchAll(table, select = '*') {
  const out = [];
  for (let off = 0; ; off += PAGE) {
    const rows = await rest(table, { query: `?select=${encodeURIComponent(select)}&limit=${PAGE}&offset=${off}` });
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
    if (off > 200000) break;                 // 安全阀
  }
  return out;
}

const CHUNK = 300;                            // 每次 upsert 的行数，正文很大所以小一点
async function upsert(table, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await rest(table, { method: 'POST', body: rows.slice(i, i + CHUNK) });
  }
}

async function removeRows(table, ids) {
  const col = table === 'lexi_vocab' ? 'word' : 'id';
  for (const id of ids) {
    await rest(table, {
      method: 'DELETE',
      query: `?${col}=eq.${encodeURIComponent(id)}`,
      prefer: 'return=minimal',
    });
  }
}

/* ══════════════════  合并规则  ══════════════════ */

/** 当前登录用户的 uuid。推送时必须写进每一行，
 *  否则 Supabase 的 RLS 策略 auth.uid() = user_id 会拒绝插入。 */
async function currentUserId() {
  const c = await ensureToken();
  const uid = c.session && c.session.user && c.session.user.id;
  if (!uid) throw new SyncError('登录信息不完整，请退出后重新登录', 'noauth');
  return uid;
}

const newer = (a, b) => (a || 0) > (b || 0);

/* ══════════════════  同步主流程  ══════════════════ */

/**
 * @param {{onStage?:Function, full?:boolean}} opts
 */
export async function sync(opts = {}) {
  if (!isSignedIn()) throw new SyncError('请先登录账号');
  const c = getConfig();
  const stage = opts.onStage || (() => {});
  const stats = { pulled: 0, pushed: 0, removed: 0, trace: [] };
  const tr = (k, v) => stats.trace.push(k + '=' + v);

  /* ── 1. 拉取远端 ── */
  stage('正在拉取云端数据…');
  const [rArts, rVocab, rSettings, rAica] = await Promise.all([
    fetchAll('lexi_articles'),
    fetchAll('lexi_vocab'),
    fetchAll('lexi_settings'),
    opts.skipAica ? Promise.resolve([]) : fetchAll('lexi_aica', 'k,text,updated'),
  ]);

  tr('pull.articles', rArts.length); tr('pull.vocab', rVocab.length);
  tr('pull.settings', rSettings.length); tr('pull.aica', rAica.length);
  tr('lastPush', JSON.stringify(c.lastPush));

  // 正文单独处理：先只取 id+updated（很轻），只下载真正变了的
  stage('正在比对文章正文…');
  const rBodyIndex = await fetchAll('lexi_bodies', 'id,updated');
  const localBodies = new Map((await db.all('bodies')).map(b => [b.id, b]));
  const needBodies = rBodyIndex.filter(r => {
    const l = localBodies.get(r.id);
    return !l || newer(r.updated, l.updated);
  }).map(r => r.id);

  const rBodies = [];
  for (let i = 0; i < needBodies.length; i += 20) {
    const ids = needBodies.slice(i, i + 20).map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
    if (!ids) continue;
    const rows = await rest('lexi_bodies', { query: `?select=id,raw,updated&id=in.(${encodeURIComponent(ids)})` });
    if (Array.isArray(rows)) rBodies.push(...rows);
  }

  /* ── 2. 合并进本地 ── */
  stage('正在合并…');
  const localArts = new Map((await db.all('articles')).map(a => [a.id, a]));
  const localVocab = new Map((await db.all('vocab')).map(v => [v.word, v]));
  const localAica = new Map((await db.all('aica')).map(v => [v.k, v]));

  const artsToPut = [];
  for (const r of rArts) {
    const l = localArts.get(r.id);
    if (!newer(r.updated, l && l.updated)) continue;
    if (l && l.updated === r.updated && !!l.deleted === !!r.deleted) continue;
    artsToPut.push({
      id: r.id, title: r.title || '', wordCount: r.word_count || 0,
      progress: r.progress || 0, created: r.created || 0, lastRead: r.last_read || 0,
      updated: r.updated || 0, deleted: !!r.deleted,
    });
    stats.pulled++;
  }
  for (const a of artsToPut) await db.put('articles', a);
  tr('merge.articles', artsToPut.length);

  const bodiesToPut = [];
  for (const r of rBodies) {
    const l = localBodies.get(r.id);
    if (!newer(r.updated, l && l.updated)) continue;
    bodiesToPut.push({ id: r.id, raw: r.raw || '', updated: r.updated || 0 });
    stats.pulled++;
  }
  for (const b of bodiesToPut) await db.put('bodies', b);

  const vocabToPut = [];
  for (const r of rVocab) {
    const l = localVocab.get(r.word);
    if (!newer(r.updated, l && l.updated)) continue;
    if (r.deleted) {
      if (l) { await db.del('vocab', r.word); stats.removed++; }
      continue;
    }
    const card = { ...(r.data || {}), word: r.word, updated: r.updated || 0 };
    vocabToPut.push(card);
    stats.pulled++;
  }
  for (const v of vocabToPut) await db.put('vocab', v);
  tr('merge.vocab', vocabToPut.length);

  const aicaToPut = [];
  for (const r of rAica) {
    const l = localAica.get(r.k);
    if (!newer(r.updated, l && l.t)) continue;
    aicaToPut.push({ k: r.k, text: r.text || '', t: r.updated || 0 });
    stats.pulled++;
  }
  for (const a of aicaToPut) await db.put('aica', a);

  // 设置：谁新听谁的
  const rs = rSettings && rSettings[0];
  if (rs && rs.data) {
    const localUpdated = +(localStorage.getItem('lexiread.settings.updated') || 0);
    if (newer(rs.updated, localUpdated)) {
      localStorage.setItem('lexiread.settings', JSON.stringify(rs.data));
      localStorage.setItem('lexiread.settings.updated', String(rs.updated || 0));
      stats.pulled++;
      stats.settingsChanged = true;
      tr('settings.applied', rs.updated);
    }
  }

  /* ── 3. 推送本地变更 ── */
  stage('正在上传本地改动…');
  const now = Date.now();
  const lp = c.lastPush || {};
  const full = !!opts.full;
  tr('opts', JSON.stringify(opts));
  tr('full', full);

  const allArts = await db.all('articles');
  tr('local.articles', allArts.length);
  const uid = await currentUserId();
  const pArts = allArts.filter(a => full || newer(a.updated, lp.articles));
  tr('push.articles', pArts.length);
  if (pArts.length) {
    await upsert('lexi_articles', pArts.map(a => ({
      user_id: uid,
      id: a.id, title: a.title || '', word_count: a.wordCount || 0,
      progress: a.progress || 0, created: a.created || 0, last_read: a.lastRead || 0,
      updated: a.updated || now, deleted: !!a.deleted,
    })));
    stats.pushed += pArts.length;
  }

  const pBodies = (await db.all('bodies')).filter(b => full || newer(b.updated, lp.bodies));
  if (pBodies.length) {
    await upsert('lexi_bodies', pBodies.map(b => ({
      user_id: uid, id: b.id, raw: b.raw || '', updated: b.updated || now })));
    stats.pushed += pBodies.length;
  }

  const allVocab = await db.all('vocab');
  const pVocab = allVocab.filter(v => full || newer(v.updated, lp.vocab));
  if (pVocab.length) {
    await upsert('lexi_vocab', pVocab.map(v => {
      const data = { ...v };
      delete data.updated;
      return { user_id: uid, word: v.word, data, updated: v.updated || now, deleted: !!v.deleted };
    }));
    stats.pushed += pVocab.length;
  }

  let pAica = [];
  if (!opts.skipAica) {
    const allAica = await db.all('aica');
    pAica = allAica.filter(a => full || newer(a.t, lp.aica)).slice(-2000);
    if (pAica.length) {
      await upsert('lexi_aica', pAica.map(a => ({
        user_id: uid, k: a.k, text: a.text || '', updated: a.t || now })));
      stats.pushed += pAica.length;
    }
  }

  const settingsUpdated = +(localStorage.getItem('lexiread.settings.updated') || 0);
  tr('local.settingsUpdated', settingsUpdated);
  if (settingsUpdated && (full || newer(settingsUpdated, lp.settings))) {
    let data = {};
    try { data = JSON.parse(localStorage.getItem('lexiread.settings') || '{}'); } catch {}
    // 用户明确同意时，才把 AI 配置（含 API Key）一起同步到别的设备
    if (data.syncAiKey) {
      try {
        const aiCfg = JSON.parse(localStorage.getItem('lexiread.ai') || '{}');
        data = { ...data, ai: { baseUrl: aiCfg.baseUrl || '', model: aiCfg.model || '', apiKey: aiCfg.apiKey || '' } };
      } catch {}
    } else if (data.ai) {
      data = { ...data };
      delete data.ai;
    }
    await upsert('lexi_settings', [{ user_id: uid, data, updated: settingsUpdated }]);
    stats.pushed++;
    tr('push.settings', settingsUpdated);
  }

  /* ── 4. 推进水位线（用真正推上去的最大时间戳，避免漏掉推送期间的新改动） ── */
  const maxOf = (arr, pick) => arr.reduce((m, x) => Math.max(m, pick(x) || 0), 0);
  saveConfig({
    lastPush: {
      articles: Math.max(maxOf(pArts, a => a.updated), lp.articles || 0),
      bodies: Math.max(maxOf(pBodies, b => b.updated), lp.bodies || 0),
      vocab: Math.max(maxOf(pVocab, v => v.updated), lp.vocab || 0),
      aica: Math.max(maxOf(pAica, a => a.t), lp.aica || 0),
      settings: Math.max(settingsUpdated, lp.settings || 0),
    },
    lastSync: now,
  });

  syncError(null);
  stage('完成');
  return stats;
}

/** 退出登录并清掉远端？（不删远端，只解绑本机） */
export function forgetLocalSession() {
  saveConfig({ session: null, email: '', lastPush: {}, lastSync: 0 });
}
