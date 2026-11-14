// Muster — on-device storage (IndexedDB with a localStorage fallback)
const DB_NAME = 'muster';
const DB_VER = 1;
const STORES = ['kv', 'factions', 'raw'];
let dbp = null;

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('no idb'));
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const r = fn(s);
        t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const memFallback = new Map();
const lsKey = (store, key) => `muster:${store}:${key}`;

export async function get(store, key) {
  try {
    return await tx(store, 'readonly', (s) => s.get(key));
  } catch {
    if (store === 'kv') {
      try {
        const v = localStorage.getItem(lsKey(store, key));
        return v == null ? undefined : JSON.parse(v);
      } catch { /* fall through */ }
    }
    return memFallback.get(lsKey(store, key));
  }
}

export async function set(store, key, value) {
  try {
    await tx(store, 'readwrite', (s) => s.put(value, key));
  } catch {
    if (store === 'kv') {
      try {
        localStorage.setItem(lsKey(store, key), JSON.stringify(value));
        return;
      } catch { /* fall through */ }
    }
    memFallback.set(lsKey(store, key), value);
  }
}

export async function del(store, key) {
  try {
    await tx(store, 'readwrite', (s) => s.delete(key));
  } catch {
    memFallback.delete(lsKey(store, key));
    try { localStorage.removeItem(lsKey(store, key)); } catch { /* ignore */ }
  }
}

export async function keys(store) {
  try {
    return await tx(store, 'readonly', (s) => s.getAllKeys());
  } catch {
    return [];
  }
}

export async function clear(store) {
  try {
    await tx(store, 'readwrite', (s) => s.clear());
  } catch { /* ignore */ }
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}
