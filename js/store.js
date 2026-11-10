// IndexedDB 저장소. 좋아하는 사진(refs)과 찍은 사진(shots)은 이 기기 안에만 저장된다.

const NAME = 'insaengshot';
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('refs')) db.createObjectStore('refs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('shots')) db.createObjectStore('shots', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const all = (store) => run(store, 'readonly', (s) => s.getAll());
export const put = (store, obj) => run(store, 'readwrite', (s) => s.put(obj));
export const del = (store, id) => run(store, 'readwrite', (s) => s.delete(id));

export function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getPref(key, fallback) {
  try {
    const v = localStorage.getItem(`insaengshot.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem(`insaengshot.${key}`, JSON.stringify(value)); } catch { /* 저장 불가 환경은 무시 */ }
}
