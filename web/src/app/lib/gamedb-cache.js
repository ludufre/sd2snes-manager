// Cached GameDB lookup answers, keyed by the ROM's headerless CRC32.
//
// Why: nothing about a lookup was ever kept, so every session re-asked the server about the whole
// card, ~3000 CRCs in ~60 sequential POSTs, 60-90s of network before the library is usable, and the
// answer is virtually always the one from yesterday. The CRC cache (crc-cache.js) already removed the
// disk reads; this removes the requests.
//
// Key is the CRC32 (8 hex, uppercase), not the path. That is the identity the server itself uses, so
// the same ROM under a different name, in a different folder, or on a second card is one cache entry.
//
// The stored value is the server's raw `GameWithRelations` JSON, never the resolved GameMatch:
// resolveMatch (lib/gamedb.js) is a pure, cheap projection of it that this app keeps changing (new
// fields, new URL rules), and re-deriving it on read means an app update improves every cached game
// instead of invalidating it.
//
// `game: null` records a negative answer, the server replied and this CRC has no game. Those are the
// bulk of the waste on a real card (hacks, translations, bad dumps: hundreds of ROMs that will never
// match), and without caching them they are re-asked forever. A negative is only ever written when the
// server answered; a request that failed must stay uncached (see library-store's identifyEntries).

import { openDb, reqDone } from './idb.js';

const STORE = 'gamedb';

/** Stored record shape/semantics version. A record whose `v` differs is simply a miss, a one-line
 *  kill-switch for when the server contract or this file's rules change, with no migration to write
 *  and no risk of a half-converted store. */
export const SCHEMA_V = 1;

/** How long a match is trusted. Game data does change (a new cover, a rebuilt `.s2pkg`), so this is not
 *  forever, but a week of instant startups is the whole point, and the two paths that actually care
 *  about freshness (the explicit "Identificar" and auto-fill's Atualizar/Substituir) bypass the cache
 *  outright rather than waiting for it to expire. */
export const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a NO-MATCH is trusted. Shorter than a match on purpose: a miss is the answer most likely
 *  to become wrong (the GameDB gains games continuously), so ~2.5 days keeps a newly-added game from
 *  staying invisible for a week while still skipping the re-ask on every session. */
export const NEGATIVE_TTL_MS = 60 * 60 * 60 * 1000;
/** Records older than this are dropped wholesale on prune, nothing re-reads them (they are long past
 *  both TTLs), they only grow the store. Mirrors pruneCrcCache's job of keeping this bounded. */
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** Is a stored record still usable? Pure (no IndexedDB) so the TTL rules can be tested directly.
 *  `nowMs` is injected for the same reason. A record from the future (clock moved backwards, or a
 *  machine with a wrong clock wrote it) is treated as stale: re-asking is cheap, trusting a timestamp
 *  we can't reason about is not.
 *
 *  `maxAgeMs` lets one caller demand something fresher than the shared TTL, without a second cache or
 *  an all-or-nothing bypass flag: the effective limit is min(TTL, maxAgeMs). Auto-fill's
 *  Atualizar/Substituir passes a few minutes (fresh enough to trust the sync tokens, so re-running it
 *  after a mid-way failure doesn't pay for the whole lookup pass again); the explicit "Identificar"
 *  and "Atualizar dados do GameDB" pass 0, which no record can satisfy = always ask the server. */
export function isFresh(rec, nowMs = Date.now(), maxAgeMs = Infinity) {
  if (!rec || rec.v !== SCHEMA_V || typeof rec.fetchedAt !== 'number' || !Number.isFinite(rec.fetchedAt)) return false;
  const age = nowMs - rec.fetchedAt;
  if (age < 0) return false;
  return age < Math.min(rec.game ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS, maxAgeMs);
}

/** Cached answers for the given CRCs, as crcUpper → record. Only the keys asked for are read, in one
 *  transaction, deliberately not getAll(): this store accumulates every CRC ever looked up in this
 *  browser (other cards, other libraries, tens of MB of game JSON), and materializing all of it to
 *  answer 50 keys would cost more than the requests it saves. Empty map on any failure (private mode,
 *  blocked upgrade), the caller then just asks the server, exactly as before the cache existed. */
export async function loadGamedbCache(crcs) {
  const out = new Map();
  if (!crcs || !crcs.length) return out;
  try {
    const keys = [...new Set(crcs.map((c) => String(c).toUpperCase()))];
    const db = await openDb();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    // every get() is issued synchronously here, so they all ride the same transaction
    const recs = await Promise.all(keys.map((k) => reqDone(store.get(k))));
    db.close();
    for (let i = 0; i < keys.length; i++) if (recs[i]) out.set(keys[i], recs[i]);
    return out;
  } catch {
    return new Map();
  }
}

/** Write a batch of answers in one transaction. `entries` are `[crc, game]` pairs where `game` is the
 *  server's raw JSON or `null` for a confirmed no-match. The record's `v`/`fetchedAt` are stamped
 *  here so no caller can persist a malformed one. Best-effort: a failure only costs a re-ask. */
export async function saveGamedbCache(entries) {
  if (!entries || !entries.length) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const now = Date.now();
    for (const [crc, game] of entries) store.put({ v: SCHEMA_V, game: game ?? null, fetchedAt: now }, String(crc).toUpperCase());
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch { /* cache is an optimization, never a hard dependency */ }
}

/** Forget every cached answer. The "Atualizar dados do GameDB" escape hatch, for when the server has
 *  changed and the user does not want to wait out the TTL. */
export async function clearGamedbCache() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch { /* best-effort */ }
}

/** How often the prune is allowed to run. It is pure housekeeping over records that live for 60 days,
 *  so once a day is already generous, and it is not cheap (a readwrite cursor that deserializes every
 *  cached game payload), which is why it must not ride along with every card scan/rescan. */
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const PRUNE_STAMP_KEY = 'sd2_gamedb_pruned';

/** True at most once per PRUNE_EVERY_MS; stamps the clock as a side effect. Falls back to "yes, run it"
 *  when localStorage is unavailable (private mode), an occasional extra pass beats never pruning. */
function pruneDue(nowMs) {
  try {
    const last = Number(localStorage.getItem(PRUNE_STAMP_KEY));
    if (Number.isFinite(last) && last > 0 && nowMs - last < PRUNE_EVERY_MS) return false;
    localStorage.setItem(PRUNE_STAMP_KEY, String(nowMs));
    return true;
  } catch {
    return true;
  }
}

/** Drop long-dead records (past MAX_AGE_MS, or written by an older SCHEMA_V so they can never hit
 *  again) so a browser that has seen several libraries doesn't grow this store forever. Walks a
 *  Cursor rather than getAll(): the whole point is to bound memory, so it must not load the store it
 *  is trimming. Rate-limited to once a day, see pruneDue. */
export async function pruneGamedbCache(nowMs = Date.now()) {
  if (!pruneDue(nowMs)) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const rq = store.openCursor();
    rq.onsuccess = () => {
      const cur = rq.result;
      if (!cur) return;
      const rec = cur.value;
      if (!rec || rec.v !== SCHEMA_V || typeof rec.fetchedAt !== 'number' || nowMs - rec.fetchedAt > MAX_AGE_MS) cur.delete();
      cur.continue();
    };
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch { /* best-effort */ }
}
