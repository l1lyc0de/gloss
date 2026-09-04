// 书正文的本地仓库。只存在这台设备上，一个字节都不上传。
//
// 这里的东西是「可丢失、可重建」的：iOS Safari 存储紧张时会清掉网页的
// IndexedDB，丢了用户重新导入一次就好，原文件还在他手机上。
// 真正不能丢的进度和生词本在 store.js 里，走 localStorage + 服务器同步。

const DB_NAME = 'gloss';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('vocabIndex')) db.createObjectStore('vocabIndex', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onerror = () => reject(t.error);
    t.oncomplete = () => resolve(req && req.result);
  });
}

export const putBook = (book) => tx('books', 'readwrite', (s) => s.put(book));
export const getBook = (id) => tx('books', 'readonly', (s) => s.get(id));
export const delBook = (id) => tx('books', 'readwrite', (s) => s.delete(id));
export const allBookIds = () => tx('books', 'readonly', (s) => s.getAllKeys());

// 词汇索引是扫全书算出来的（几秒），算一次存下来，之后打开就是现成的
export const putVocabIndex = (idx) => tx('vocabIndex', 'readwrite', (s) => s.put(idx));
export const getVocabIndex = (id) => tx('vocabIndex', 'readonly', (s) => s.get(id));
export const delVocabIndex = (id) => tx('vocabIndex', 'readwrite', (s) => s.delete(id));

/** 尽量让浏览器别把我们的数据当缓存清掉。不保证成功，所以进度还是要上服务器。 */
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* 不支持就算了 */ }
  return false;
}

export async function estimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch { /* 同上 */ }
  return null;
}
