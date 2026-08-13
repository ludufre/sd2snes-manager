// Cached ROM checksums, keyed by path, validated by (size, mtime).
//
// Why: identifying a game needs its CRC32, and CRC32 needs every byte of the file, so the analyze
// pass reads the entire card. On a 32 GB card that's ~12 minutes at ~46 MB/s, and it happened again
// on every session because nothing was kept. The bytes don't change unless the file does, so the
// checksum is cached and only files that are new or actually modified get read.
//
// Key is the path (`folder/file`); the record also stores `size` and `mtime` and a hit requires both
// to match. Renaming, replacing or patching a ROM changes at least one of the three, so a stale entry
// can't survive: worst case we re-read a file we didn't need to, never the reverse.
//
// The whole store is loaded in one getAll() and written back in one transaction, 6000 individual
// IndexedDB round-trips would cost more than they save.

import { openDb, reqDone } from './idb.js';

const STORE = 'crc';

/** Cache key for an entry: its path on the card. */
export function crcKey(folder, file) {
  return folder ? `${folder}/${file}` : file;
}

/** Every cached checksum, as key → { size, mtime, crc }. Empty map when unavailable (private mode,
 *  blocked upgrade), the caller then just computes everything, exactly as before the cache existed. */
export async function loadCrcCache() {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const [keys, values] = await Promise.all([reqDone(store.getAllKeys()), reqDone(store.getAll())]);
    db.close();
    const out = new Map();
    for (let i = 0; i < keys.length; i++) out.set(keys[i], values[i]);
    return out;
  } catch {
    return new Map();
  }
}

/** One cached checksum, as `{ size, mtime, crc }` (null when absent/unavailable). For the single-ROM
 *  paths: loadCrcCache() reads the whole store, which is right for the batch pass but turns a
 *  per-game fallback loop into one getAll() per game. */
export async function getCrcCached(key) {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const rec = await reqDone(store.get(key));
    db.close();
    return rec ?? null;
  } catch {
    return null;
  }
}

/** Persist newly computed checksums. Best-effort: a failure here only costs a re-read next time. */
export async function saveCrcCache(entries) {
  if (!entries.length) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [key, rec] of entries) store.put(rec, key);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch { /* cache is an optimization, never a hard dependency */ }
}

/** Drop entries whose ROM is no longer on the card, so a reorganized card doesn't grow the store
 *  forever. `live` is the set of keys seen in this scan. */
export async function pruneCrcCache(live) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const keys = await reqDone(store.getAllKeys());
    for (const k of keys) if (!live.has(k)) store.delete(k);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch { /* best-effort */ }
}
