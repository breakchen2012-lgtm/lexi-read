/* 极简 IndexedDB 封装 —— 无依赖 */

const NAME = 'lexiread';
const VER = 2;
export const STORES = ['articles', 'bodies', 'vocab', 'aica', 'kv'];
let _p = null;
export let onBlocked = null;      // 由 app 覆盖：提示用户关掉其它标签页
export function setOnBlocked(fn) { onBlocked = fn; }

function open() {
  if (_p) return _p;
  _p = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      const tx = r.transaction;
      if (!db.objectStoreNames.contains('articles')) db.createObjectStore('articles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('vocab')) db.createObjectStore('vocab', { keyPath: 'word' });
      if (!db.objectStoreNames.contains('aica')) db.createObjectStore('aica', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('bodies')) db.createObjectStore('bodies', { keyPath: 'id' });

      // v1 → v2：正文（raw）从 articles 挪进 bodies，
      // 这样启动时只读元数据，不必把每篇文章的全文都拉进内存。
      if (ev.oldVersion === 1) {
        const src = tx.objectStore('articles');
        const dst = tx.objectStore('bodies');
        src.openCursor().onsuccess = e2 => {
          const c = e2.target.result;
          if (!c) return;
          const v = c.value;
          if (v && typeof v.raw === 'string') {
            dst.put({ id: v.id, raw: v.raw });
            const meta = { ...v };
            delete meta.raw;
            c.update(meta);
          }
          c.continue();
        };
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => { if (onBlocked) onBlocked(); };
  });
  return _p;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

/** 在同一个事务里「读—改—写」，避免把过期的内存副本覆盖到新数据上 */
export function update(store, key, patch) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    const g = s.get(key);
    g.onsuccess = () => {
      let next;
      try { next = patch(g.result); } catch { next = null; }
      if (next) s.put(next);
    };
    t.oncomplete = () => res(true);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const put = (store, val) => run(store, 'readwrite', s => s.put(val));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const all = (store) => run(store, 'readonly', s => s.getAll());
export const clear = (store) => run(store, 'readwrite', s => s.clear());
export const count = (store) => run(store, 'readonly', s => s.count());

/** 估算已用存储空间（Safari 支持） */
export async function usage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { used: e.usage || 0, quota: e.quota || 0 };
    }
  } catch {}
  return null;
}

/** 请求持久化存储，避免 iOS 自动清理 */
export async function persist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}
