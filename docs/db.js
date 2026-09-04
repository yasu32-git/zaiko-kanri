/**
 * IndexedDB ラッパー
 *
 * オブジェクトストア:
 *   items  — 品目マスタのローカルキャッシュ（keyPath: id）
 *   logs   — 購入履歴のローカルキャッシュ（keyPath: key = itemId|at）
 *   queue  — 未送信の更新キュー（autoIncrement）
 *   meta   — 設定値（APIのURL、最終同期時刻など）
 *   images — 品目写真のサムネイルキャッシュ（keyPath: id = DriveのファイルID、value: { id, blob }）
 */
const DB_NAME = 'stock-pwa';
const DB_VERSION = 2;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const DB = {
  getAll(store) {
    return tx(store, 'readonly', s => s.getAll());
  },

  put(store, value) {
    return tx(store, 'readwrite', s => s.put(value));
  },

  putAll(store, values) {
    return tx(store, 'readwrite', s => { values.forEach(v => s.put(v)); });
  },

  clear(store) {
    return tx(store, 'readwrite', s => s.clear());
  },

  delete(store, key) {
    return tx(store, 'readwrite', s => s.delete(key));
  },

  // ---- meta（設定） ----
  async getMeta(k, fallback = null) {
    const row = await tx('meta', 'readonly', s => s.get(k));
    return row && row.v !== undefined ? row.v : fallback;
  },

  setMeta(k, v) {
    return DB.put('meta', { k, v });
  },

  // ---- queue（未送信の更新） ----
  /** kind: 'item' | 'log' */
  enqueue(kind, payload) {
    return DB.put('queue', { kind, payload, at: new Date().toISOString() });
  },

  async takeQueue() {
    return await DB.getAll('queue');
  },

  async removeQueue(seqs) {
    return tx('queue', 'readwrite', s => { seqs.forEach(q => s.delete(q)); });
  }
};

export const logKey = (itemId, at) => `${itemId}|${at}`;
