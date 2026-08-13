// The app's single IndexedDB database. Three stores live here:
//   handles, the picked card's FileSystemDirectoryHandle (see scan.js), so a reload can reconnect
//   crc, cached ROM checksums (see crc-cache.js), so a re-analyze doesn't re-read the whole card
//   gamedb, cached GameDB lookup answers (see gamedb-cache.js), so a re-analyze doesn't re-ask the
//             server about ~3000 CRCs it already answered this week
//
// One opener for all of them: IndexedDB refuses to open a database at a lower version than the one on
// disk, so a second module opening `sd2snes-manager` at its own version would break whichever ran
// second. Everything goes through openDb(), and the upgrade creates only the stores that are missing,
// which is also what migrates a v1 (handles only) or v2 (handles+crc) database without touching the
// stored card handle or a single cached checksum.

const DB_NAME = 'sd2snes-manager';
const DB_VERSION = 3;
const STORES = ['handles', 'crc', 'gamedb'];

export function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB upgrade blocked by another tab'));
  });
}

/** Promise wrapper for an IDBRequest. */
export function reqDone(rq) {
  return new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
}
