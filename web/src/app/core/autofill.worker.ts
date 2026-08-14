/// <reference lib="webworker" />
// Auto-fill write pipeline, run in a dedicated Web Worker so it keeps full speed even when the tab is
// backgrounded (Chromium/Edge throttle the main thread of inactive tabs, but not worker threads. This
// is the fix for "the run slows to a crawl / pauses when I switch away"). The worker does the heavy I/O:
// fetch each game's `.s2pkg`, inflate it, and write the requested members to the SD card, with the same
// size-gated concurrency + retry + unwritable-latch the main-thread CardWriter uses. The main thread only
// builds the job list (handles, pre-serialized .yml/cheats) and reacts to progress messages. Games with
// No package (or whose package lacks a wanted member) are reported back so the main thread can fall back
// to covgen/ffmpeg for those few.
//
// Download and write are two decoupled stages. They used to share one pool slot, each task fetched its
// package and then wrote it, so whenever the six slots were all in their write phase the network sat
// idle, and a slow download held a slot the card was ready to use (convoy). Now a bounded fetcher stage
// runs ahead of the writers and parks inflated packages in a small queue, so a writer that finishes a
// game almost always finds the next one already downloaded. The write side is deliberately untouched:
// raising write concurrency is not on the table (close() measured 430ms → >5s at 6-way on large files,
// see card-writer.service.ts), so "never leave the SD waiting on the network" is the whole win available.

import { decompress } from 'fzstd';

/** Post a message back to the main thread. Cast avoids the dom-vs-webworker `postMessage` overload clash
 *  when this file is type-checked under the app's (dom) tsconfig. */
const post = (m: unknown): void => (self as unknown as { postMessage(msg: unknown): void }).postMessage(m);

import { infoDirFor, cheatsDirFor, assetKeyOf, type LayoutMode } from './sd-layout';

const MAGIC = 'S2PK';

/** Parse the uncompressed .s2pkg container → { member → bytes }. (Mirror of lib/package.js.) */
function decodePackage(buf: Uint8Array): Record<string, Uint8Array> {
  if (buf.length < 12 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== MAGIC) throw new Error('not an .s2pkg');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const mlen = dv.getUint32(8, true);
  const manifest = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + mlen))) as { n: string; o: number; l: number }[];
  const base = 12 + mlen;
  const out: Record<string, Uint8Array> = {};
  for (const e of manifest) out[e.n] = buf.subarray(base + e.o, base + e.o + e.l);
  return out;
}
/** Idle watchdog for the two CDN fetches below, not a total budget. The counter resets on every
 *  chunk that arrives, so this means "30s without receiving a single byte", never "30s to finish the
 *  download": a 4MB `.pcm.zst` over a sub-1Mbit link is healthy and must not be aborted mid-transfer
 *  and re-downloaded from zero. A bare `await fetch(...)`, meanwhile, never settles when the
 *  connection dies without a reply (dropped vpn, machine slept), and one such call holds a pool slot
 * (and eventually the whole run) forever. */
const STALL_MS = 30000;
const FETCH_ATTEMPTS = 2;
const FETCH_BACKOFF_MS = 1000;
/** Statuses that can answer differently next time. Deliberately not 429: these objects come straight
 *  off the CDN, not the rate-limited `/api`, so re-firing at a real limit 1s later (times the width of
 *  the pool) is the worst answer. A 404 (this CRC has no package) or a 403 (hotlink) is final,
 *  retrying it only doubles the wait before the caller's covgen/ffmpeg fallback. */
const RETRY_STATUS = new Set([408, 500, 502, 503, 504]);

/** Drain a response body, calling `seen()` on every chunk so the watchdog can reset. content-length is
 *  Not trusted (Cloudflare omits it on chunked responses), so chunks are concatenated at the end. */
async function readAll(res: Response, seen: () => void): Promise<Uint8Array> {
  // no stream (polyfill / test double), NOTE the watchdog degrades to a total budget here, since
  // seen() is never called; fine, a real browser always streams a 200.
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen();
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  } finally {
    reader.releaseLock();
  }
}

/** Fetch a CDN object → raw response bytes, guarded by the idle watchdog and retried once on a
 *  transient failure. Same guarantees as lib/package.js's fetchBytes; the thrown wording is this
 *  worker's own (no statusText), so its callers keep matching what they always did.
 *
 *  The watchdog runs as a 1s tick rather than a re-armed timeout because it has a second job: noticing
 *  `cancelled`. Without that, a "Parar" mid-transfer would let the request run to completion and then
 *  sleep the backoff and fire a whole second request before anyone looked at the flag again. */
async function fetchBytes(url: string, label: string): Promise<Uint8Array> {
  let last: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, FETCH_BACKOFF_MS));
    // A cancel always reports as a cancel, `last` may hold the previous attempt's 503, and letting
    // it win would file "fetch 503" into the post-run report for a manual the user themselves stopped.
    if (cancelled) throw new DOMException('cancelled', 'AbortError');
    const ctl = new AbortController();
    let idle = 0, stalled = false;
    const tick = setInterval(() => {
      // unwritable too: once the card latched, up to LOOKAHEAD downloads in flight are pure waste,
      // without this they'd run their full course (stall window × attempts) before `done` could post.
      if (cancelled || unwritable) { ctl.abort(new DOMException('cancelled', 'AbortError')); return; }
      if ((idle += 1000) >= STALL_MS) { stalled = true; ctl.abort(new DOMException('stalled', 'TimeoutError')); }
    }, 1000);
    let status = 0;
    try {
      // no-referrer for the same reason as lib/gd.js fetchBytes: Cloudflare hotlink protection 403s a
      // cross-origin Referer. It only bites images today, but a fetch that sends no Referer never can.
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
      if (res.ok) return await readAll(res, () => { idle = 0; });
      status = res.status;
      last = new Error(`${label} ${res.status}`);
    } catch (err) {
      last = err; // our own stall/cancel abort, or a network failure with no status
    } finally {
      clearInterval(tick);
    }
    // Our own stall abort is not worth a retry (30s of silence won't go better from zero), and neither
    // is a cancel or a final status.
    if (stalled || cancelled || (status && !RETRY_STATUS.has(status)) || attempt + 1 >= FETCH_ATTEMPTS) break;
    console.warn(`[pkg] ${label} failed (attempt ${attempt + 1}/${FETCH_ATTEMPTS}), retrying:`, last, url);
  }
  throw last;
}
/** Fetch + inflate a `.s2pkg` → its members and the size of the buffer that backs them. Every member is a
 *  subarray view of that one inflated buffer, so holding any member pins all of it. The queue budget
 *  below has to charge the buffer once, never the sum of the members. */
async function fetchPackage(url: string): Promise<{ members: Record<string, Uint8Array>; bytes: number }> {
  const raw = decompress(await fetchBytes(url, 'package fetch'));
  return { members: decodePackage(raw), bytes: raw.byteLength };
}
/** Fetch a zstd-compressed object (`.man.zst`, separated `.pcm.zst`) → inflated raw bytes. */
async function fetchInflate(url: string): Promise<Uint8Array> {
  return decompress(await fetchBytes(url, 'fetch'));
}

/* ---- card writer (port of CardWriter: size-gated concurrency + retry + unwritable latch) ---- */
let SMALL = 6, LARGE = 2, LARGE_BYTES = 128 * 1024;
function makeSem(max: number) {
  let permits = max;
  const waiters: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (permits > 0) permits--; else await new Promise<void>((r) => waiters.push(r));
    try { return await fn(); } finally { const w = waiters.shift(); if (w) w(); else permits++; }
  };
}
let semSmall = makeSem(SMALL), semLarge = makeSem(LARGE);
let fatalStreak = 0, unwritable = false, writtenBytes = 0;
/** The real underlying error (name + message + which file) of the last persistent write failure,
 *  surfaced to the main thread so a production "card unwritable" actually says what failed (NoModification
 *  vs Quota vs InvalidState vs ...) instead of the opaque generic message. */
let lastFatal = '';
async function withRetry<T>(fn: () => Promise<T>, where = '', isolated = false): Promise<T> {
  if (unwritable) throw new DOMException('card unwritable', 'CardUnwritableError');
  let last: unknown;
  const max = isolated ? 2 : 5; // a read-only ROM folder won't clear on retry, don't burn 5 backoffs on it
  for (let a = 0; a < max; a++) {
    try { const r = await fn(); fatalStreak = 0; return r; } catch (e) {
      last = e; const n = (e as { name?: string })?.name;
      if (n === 'QuotaExceededError') break;
      if (n !== 'NoModificationAllowedError' && n !== 'InvalidStateError') throw e;
      await new Promise((r) => setTimeout(r, 150 * (a + 1)));
    }
  }
  // Isolated = the .cov next to the ROM, in an arbitrary user folder that may be read-only. A persistent
  // failure there is local to that game, never grow the card-wide streak or latch: bubble raw so
  // writeFile() returns false and writeJob records it in the fill report instead of killing the whole run.
  if (isolated) throw last;
  fatalStreak++;
  const le = last as { name?: string; message?: string } | undefined;
  lastFatal = `${le?.name || 'Error'}: ${(le?.message || '').slice(0, 200)}${where ? ` [${where}]` : ''}`;
  if (fatalStreak >= 4) { unwritable = true; throw new DOMException('card unwritable', 'CardUnwritableError'); }
  throw last;
}
/** Returns true when written. `isolated` (the .cov, which lands in the ROM's own folder): a read-only
 *  folder → returns false (caller reports + continues) instead of feeding the card-wide unwritable latch. */
async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array, isolated = false): Promise<boolean> {
  const gate = data.byteLength >= LARGE_BYTES ? semLarge : semSmall;
  try {
    await gate(() => withRetry(async () => {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(data as FileSystemWriteChunkType);
      await w.close();
      writtenBytes += data.byteLength;
    }, name, isolated));
    return true;
  } catch (e) {
    if (isolated && (e as { name?: string })?.name === 'NoModificationAllowedError') return false;
    throw e;
  }
}

/* ---- directory resolution (cached) ---- */
let rootHandle: FileSystemDirectoryHandle;
const dirCache = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
/** create=true → mkdir-as-needed (info/cheats); create=false → resolve existing (the ROM folder). */
function getDir(path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const key = (create ? 'c:' : 'r:') + path;
  let p = dirCache.get(key);
  if (!p) {
    p = (async () => {
      let d: FileSystemDirectoryHandle | null = rootHandle;
      for (const seg of path.split('/')) {
        if (!seg || !d) continue;
        try { d = await d.getDirectoryHandle(seg, { create }); } catch { return null; }
      }
      return d;
    })();
    dirCache.set(key, p);
  }
  return p;
}

const enc = new TextEncoder();
let cancelled = false;
/** `name: message` of a failure, for the reason strings the main thread shows the user (and logs). */
const errText = (e: unknown, n = 120): string =>
  `${(e as { name?: string })?.name || 'Error'}: ${((e as { message?: string })?.message || '').slice(0, n)}`;

interface Job {
  id: string;
  packageUrl: string | null; // null when this game has no .s2pkg (still a valid job if manualUrl is set)
  fallbackPackageUrl?: string | null; // base .s2pkg to retry when packageUrl is the legacy no-audio variant and 404s (rows can outlive their object, it happened to all 4.5k variants in 2026-08)
  manualUrl?: string | null; // official GameDB manual (`.man.zst`, zstd), a direct fetch, inflated here, not a package member
  pcmUrl?: string | null; // separated audio (`.pcm.zst`, zstd) for new audio-less packages; null when the .s2pkg embeds the .pcm
  file: string; // the ROM's filename with its extension: the extension decides the sgb/ namespace
  mode: LayoutMode; // which layout to write -- the card's firmware decides, not this app's version
  stem: string;
  folder: string; // relative path of the ROM's dir under the card root ('' = root)
  want: { cov?: boolean; gcv?: boolean; gss?: boolean; fmv?: boolean; pcm?: boolean };
  cheatsText?: string | null; // pre-serialized cheats .yml (fallback when the package has no cheats)
  infoYml?: string | null;    // pre-built game info .yml (with the fmv flag already baked by the main thread)
}

/* ---- stage 1/2: the fetcher (download + inflate, ahead of the writers) ---- */

/** A job whose downloads are done, waiting for a writer. `pkg`/`pcm`/`man` are nulled the moment its
 *  writes finish so the budget below reopens (and the fetchers move) without waiting for a GC guess. */
interface Ready {
  job: Job;
  pkg: Record<string, Uint8Array> | null;
  pcm: Uint8Array | null; // separated audio, already inflated (null when embedded in the pkg / not wanted)
  man: Uint8Array | null; // official manual, already inflated
  manErr: string;         // why the `.man` fetch failed (the write's own failure is appended by the writer)
  bytes: number;          // what this entry charges the budget while it is alive
}

/** How far ahead of the writers the fetchers may get, counting a download in flight as an occupied slot
 *  (the reservation is what keeps the bound real with several fetchers racing on the same gate). It also
 *  doubles as the download concurrency: 4 sockets that are always busy beat the 6 of the old shared pool,
 *  which only downloaded in the gaps between writes. */
const LOOKAHEAD = 4;
/** ...and a ceiling in bytes, because 4 jobs is a very different amount of memory for four covers
 *  (~30KB each) than for four previews with audio (MBs each). Charged per Ready entry until its writes
 *  finish. Soft ceiling: a job's size is only known after its download, so the gate is tested before
 *  the claim. The true bound is budget + up to LOOKAHEAD in-flight jobs (~+28MB on typical loads). */
const BUDGET_BYTES = 96 * 1024 * 1024;

const readyQ: Ready[] = [];   // downloaded, not yet written, consumed in production order
let nextJob = 0;              // next index of the job list a fetcher may claim
let inFlight = 0;             // downloads running right now (reserved lookahead slots)
let fetching = 0;             // fetcher tasks still alive; 0 + empty queue = nothing more will ever arrive
let heldBytes = 0;            // bytes charged by the queue + the jobs currently being written

/** One promise every idle stage awaits, replaced on each signal. A waiter captures it before testing its
 *  condition, so a change that lands in between still resolves the promise it is about to await, the
 *  reason this can't lose a wakeup (same shape as the crc worker's pump, minus the callback plumbing). */
let tickP: Promise<void> = Promise.resolve();
let tickR: () => void = () => {};
function arm(): void { tickP = new Promise<void>((r) => { tickR = r; }); }
arm();
/** Wake everyone: something they wait on (queue, budget, cancel, stage exit) changed. */
function bump(): void { const r = tickR; arm(); r(); }

/** Download + inflate everything one job needs. Never throws: a failed package is exactly the "no
 *  package" case the writer already reports (missing → main-thread covgen/ffmpeg fallback), and a job
 *  whose progress post is skipped is a game that silently disappears from the run. */
async function fetchJob(job: Job): Promise<Ready> {
  const r: Ready = { job, pkg: null, pcm: null, man: null, manErr: '', bytes: 0 };
  if (job.packageUrl) {
    try { const p = await fetchPackage(job.packageUrl); r.pkg = p.members; r.bytes += p.bytes; } catch {  }/* → reported missing */
  }
  // Variant gone (stale row / swept object)? The base package carries the same members (+pcm), far
  // better to download it than to dump the whole game on the slow main-thread ffmpeg fallback.
  if (!r.pkg && job.fallbackPackageUrl && job.fallbackPackageUrl !== job.packageUrl) {
    try { const p = await fetchPackage(job.fallbackPackageUrl); r.pkg = p.members; r.bytes += p.bytes; } catch {  }/* → reported missing */
  }
  // Separated audio: the same predicate the writer uses below, minus the directory checks (resolving the
  // dirs is the writer's job). Worst case we prefetch a `.pcm` for a game whose info dir turns out to be
  // unusable, a mkdir failure, i.e. a card that is about to fail everything anyway.
  if (r.pkg && job.want.fmv && r.pkg['fmv'] && job.want.pcm && !r.pkg['pcm'] && job.pcmUrl) {
    try { r.pcm = await fetchInflate(job.pcmUrl); r.bytes += r.pcm.byteLength; } catch {  }/* audio best-effort */
  }
  // Official manual: a direct fetch, never a package member, a manual-only job (packageUrl null) is a
  // perfectly valid job and gets here regardless.
  if (job.manualUrl) {
    try { r.man = await fetchInflate(job.manualUrl); r.bytes += r.man.byteLength; } catch (e) { r.manErr = errText(e); }
  }
  return r;
}

/** One fetcher task. The gate is tested and the slot claimed (`nextJob++`, `inFlight++`) with no await in
 *  between, so racing fetchers can't all pass the same free slot. */
async function fetcher(jobs: Job[]): Promise<void> {
  try {
    for (;;) {
      const t = tickP; // capture before testing (see arm/bump)
      if (cancelled || unwritable || nextJob >= jobs.length) return;
      if (readyQ.length + inFlight >= LOOKAHEAD || heldBytes >= BUDGET_BYTES) { await t; continue; }
      const job = jobs[nextJob++];
      inFlight++;
      try {
        const r = await fetchJob(job);
        heldBytes += r.bytes;
        readyQ.push(r);
      } catch (e) {
        // fetchJob is written not to throw; if it ever does, the job still has to reach a writer. An
        // empty Ready is the "no package" path, which reports the game as missing and hands it to the
        // main-thread fallback. A fetcher that died here would instead take a game (and, via `fetching`,
        // possibly the run's 'done') with it.
        console.error('[autofill.worker] fetch failed, continuing', e);
        readyQ.push({ job, pkg: null, pcm: null, man: null, manErr: job.manualUrl ? errText(e) : '', bytes: 0 });
      } finally { inFlight--; bump(); }
    }
  } finally { fetching--; bump(); } // the last fetcher leaving is what lets idle writers exit
}

/* ---- stage 2/2: the writer (unchanged card work, now fed by the queue) ---- */

let done = 0;
/** One writer task: take the oldest ready job and write it. `shift()` is the claim, no test/act race. */
async function writer(): Promise<void> {
  for (;;) {
    const t = tickP; // capture before testing (see arm/bump)
    // Stop as the old pool did: never start another game after a cancel or an unwritable latch (a job
    // already in progress always runs to its end, posting its progress).
    if (cancelled || unwritable) return;
    const r = readyQ.shift();
    if (!r) { if (!fetching) return; await t; continue; }
    // Taking a job frees a lookahead slot (its bytes stay charged. They are still in memory, just being
    // written now). Signal it here and not only when the write ends, otherwise the queue would refill
    // exclusively at write completions: it would sit empty for the whole duration of a write and the next
    // free writer would land on an empty queue, the very stall this pipeline exists to remove.
    bump();
    try { await writeJob(r); }
    catch (e) {
      if ((e as { name?: string })?.name === 'CardUnwritableError') { cancelled = true; post({ type: 'fatal', error: lastFatal }); }
      else console.error('[autofill.worker] job failed, continuing', e);
    } finally {
      // Drop the buffers here, not at GC's convenience: every member is a view pinning a whole inflated
      // package, and the fetchers are parked on exactly this budget.
      r.pkg = null; r.pcm = null; r.man = null;
      heldBytes -= r.bytes;
      bump();
    }
  }
}

/** Fetchers + writers over one job list. Deadlock-free by construction: a writer only sleeps with an
 *  Empty queue, and with an empty queue and no writer busy `heldBytes` is 0 and `inFlight` is 0, so the
 *  fetcher gate is necessarily open. The two stages can never both be waiting on each other. */
async function pipeline(jobs: Job[], writers: number): Promise<void> {
  fetching = Math.min(LOOKAHEAD, jobs.length);
  try {
    await Promise.all([
      ...Array.from({ length: fetching }, () => fetcher(jobs)),
      ...Array.from({ length: Math.min(writers, jobs.length) }, () => writer()),
    ]);
  } finally {
    // A cancelled run walks away from up to LOOKAHEAD downloaded packages, drop them now instead of
    // keeping ~100MB pinned until the next run happens to reset the queue.
    readyQ.length = 0; heldBytes = 0;
  }
}

async function writeJob(r: Ready): Promise<void> {
  const job = r.job;
  const pkg = r.pkg;
  const wrote = { cov: false, gcv: false, gss: false, fmv: false, pcm: false, info: false, cheats: false, manual: false };
  let jobErr: { asset: string; reason: string } | undefined; // a per-folder write skip (read-only ROM folder)
  let manErr = r.manErr; // real reason the `.man` fetch/write failed (surfaced, never swallowed)

  const key = assetKeyOf(job.file, job.mode);
  const infoDir = await getDir(infoDirFor(key), true);
  const romDir = job.folder ? await getDir(job.folder, false) : rootHandle;

  if (pkg && romDir && infoDir) {
    if (job.want.cov && pkg['cov']) {
      // The .cov lands next to the ROM, isolated write: a read-only folder skips (reported) not latches.
      if (await writeFile(romDir, job.stem + '.cov', pkg['cov'], true)) wrote.cov = true;
      else jobErr = { asset: 'cov', reason: 'readonly' };
    }
    if (job.want.gcv && pkg['gcv']) { await writeFile(infoDir, job.stem + '.gcv', pkg['gcv']); wrote.gcv = true; }
    if (job.want.gss && pkg['gss']) { await writeFile(infoDir, job.stem + '.gss', pkg['gss']); wrote.gss = true; }
    if (job.want.fmv && pkg['fmv']) {
      await writeFile(infoDir, job.stem + '.fmv', pkg['fmv']); wrote.fmv = true;
      if (job.want.pcm) {
        if (pkg['pcm']) { await writeFile(infoDir, job.stem + '.pcm', pkg['pcm']); wrote.pcm = true; } // legacy: embedded audio
        else if (r.pcm) { // new: audio-less package → the separated .pcm.zst, fetched + inflated by the fetcher
          try { await writeFile(infoDir, job.stem + '.pcm', r.pcm); wrote.pcm = true; } catch {  }/* audio best-effort */
        }
      }
    }
    // NOTE: these two used to write to a hardcoded flat 'sd2snes/cheats' -- they never got the
    // bucketing the rest of the app did, so autofilled cheats landed where the firmware no longer
    // looks. cheatsDirFor() is now the single source for this path, same as the main thread.
    if (job.cheatsText != null && pkg['cheats']) { const d = await getDir(cheatsDirFor(key), true); if (d) { await writeFile(d, job.stem + '.yml', pkg['cheats']); wrote.cheats = true; } }
  }
  // cheats: fall back to the reserved catalog text when the package has none
  if (!wrote.cheats && job.cheatsText) { const d = await getDir(cheatsDirFor(key), true); if (d) { await writeFile(d, job.stem + '.yml', enc.encode(job.cheatsText)); wrote.cheats = true; } }
  // game info .yml (fmv flag already baked in by the main thread when a preview is part of the plan)
  if (job.infoYml != null && infoDir) { await writeFile(infoDir, job.stem + '.yml', enc.encode(job.infoYml)); wrote.info = true; }

  // Official manual (.man, ready w/ zoom): a direct download, never a package member, never converted
  // here. Written AS-IS (the fetcher already inflated the zstd) to slot 0 (<stem>.man). Independent of
  // `pkg`. Runs even when the game has no .s2pkg at all (a manual-only job gets here regardless).
  // A failed download arrives with man=null and manErr already filled in by the fetcher.
  if (job.manualUrl && infoDir && r.man) {
    try {
      await writeFile(infoDir, job.stem + '.man', r.man);
      wrote.manual = true;
    } catch (e) {
      // Never swallow this: a manual that silently fails to land keeps its category flagged as
      // outdated forever (its sync_man token is only stamped on a real write), so every later
      // "Update" run re-offers the same game and appears to do nothing. The main thread retries it
      // (missing.man) and, failing that, records it in the post-run report.
      manErr = errText(e);
    }
  }

  // What the plan wanted but the package couldn't supply → the main thread covgen/ffmpegs these few.
  // `gcv` belongs here too: a package that carries a `cov` but no `gcv` (or no members at all) left the
  // game info cover unwritten and unreported, so the game came back as "a completar" on every single run.
  const missing = {
    cov: !!job.want.cov && !wrote.cov,
    gcv: !!job.want.gcv && !wrote.gcv,
    gss: !!job.want.gss && !wrote.gss,
    fmv: !!job.want.fmv && !wrote.fmv,
    man: !!job.manualUrl && !wrote.manual,
  };
  // Ship the cov bytes back when written so the main thread can render the list thumbnail live (the
  // worker can't make a canvas/dataURL). Small (~tens of KB) and only for games that got a cover.
  // `.slice()` copies those few KB out of the package: structured clone serializes a view's whole backing
  // buffer, so posting the member itself shipped the entire inflated .s2pkg to the main thread (megabytes
  // per game, kept alive there until the message was processed), the same "a view pins the buffer" trap
  // the queue budget accounts for.
  const cov = wrote.cov && pkg ? pkg['cov'].slice() : undefined;
  post({ type: 'progress', id: job.id, done: ++done, wrote, missing, hadPackage: !!pkg, bytes: writtenBytes, cov, err: jobErr, manErr });
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  // bump() so the stages parked on the queue/budget notice the flag now instead of on the next natural
  // signal (the in-flight fetches abort on their own, fetchBytes watches `cancelled` on its 1s tick).
  if (m?.type === 'cancel') { cancelled = true; bump(); return; }
  if (m?.type !== 'start') return;
  rootHandle = m.rootHandle;
  if (m.cfg) {
    SMALL = m.cfg.smallMax ?? SMALL; LARGE = m.cfg.largeMax ?? LARGE; LARGE_BYTES = m.cfg.largeBytes ?? LARGE_BYTES;
    semSmall = makeSem(SMALL); semLarge = makeSem(LARGE);
  }
  cancelled = false; unwritable = false; fatalStreak = 0; writtenBytes = 0; done = 0; dirCache.clear();
  // pipeline state too, defensive: production spawns a fresh Worker per run and terminates it after
  // (runWriterWorker), but nothing here should depend on that; a reused instance (as the spec drives)
  // must not inherit a queue, a byte charge or a stage count from the previous run.
  readyQ.length = 0; nextJob = 0; inFlight = 0; fetching = 0; heldBytes = 0;
  const t0 = Date.now();
  // 'done' in a finally: the main thread's run only ends on this message (or on the worker's `error`
  // event, which an unhandled rejection does not fire), so an unexpected throw anywhere in the pipeline
  // must still close the run instead of leaving the progress bar stuck forever.
  try { await pipeline(m.jobs as Job[], m.cfg?.games ?? 6); }
  finally { post({ type: 'done', unwritable, writtenBytes, ms: Date.now() - t0, error: lastFatal }); }
};
