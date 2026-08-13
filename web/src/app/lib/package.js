// `.s2pkg` reader, fetches the gamedb's pre-built per-CRC bundle and inflates it to the ready-to-
// write card members (cover/gcv/gss/fmv/pcm/cheats). The server builds these exactly as this app
// would (same .cov/.gcv/.gss/.fmv/.pcm formats), so a packaged game needs no ffmpeg/canvas work.
//
// Format (mirror of the backend's package-container.ts), zstd-compressed as a whole:
//   0..3 magic "S2PK" · 4 version(=1) · 5 flags · 6..7 reserved · 8..11 manifest JSON len (u32 LE)
//   12.. manifest JSON: [{ "n": <member>, "o": <offset>, "l": <length> }, ...]
//   then payloads concatenated (offsets relative to the start of the payload region)
import { decompress } from 'fzstd';

const MAGIC = 'S2PK';
const VERSION = 1;

/** Parse the uncompressed container → { cov?, gcv?, gss?, fmv?, pcm?, cheats? } (Uint8Array each). */
export function decodePackage(buf) {
  if (buf.length < 12 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== MAGIC) throw new Error('not an .s2pkg');
  if (buf[4] !== VERSION) throw new Error('unsupported .s2pkg version ' + buf[4]);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const mlen = dv.getUint32(8, true);
  const manifest = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + mlen)));
  const base = 12 + mlen;
  const out = {};
  for (const e of manifest) out[e.n] = buf.subarray(base + e.o, base + e.o + e.l);
  return out;
}

/** Idle watchdog, not a total budget: the timer is re-armed on every chunk that arrives, so this
 *  means "30s without receiving a single byte", never "30s to finish the download". A fixed total
 *  ceiling is the wrong tool here, a 4MB `.pcm.zst` over a sub-1Mbit link is perfectly healthy and
 *  would be aborted mid-transfer, then re-downloaded from zero, doubling both the wait and the
 *  bandwidth. Stagnation, on the other hand, is exactly the failure we're guarding against (dropped
 *  Vpn, slept tab, proxy that hung up), and it's caught the moment it happens.
 *  No throttle gate either: these are plain CDN objects, not the rate-limited `/api` of net.js. */
const STALL_MS = 30000;
/** Two attempts, one short backoff: the caller already has a fallback (generate the media / skip the
 *  audio), so a long retry ladder just delays it. */
const ATTEMPTS = 2;
const BACKOFF_MS = 1000;
/** Transient server-side statuses. Deliberately not 429: these objects are served straight off the
 *  CDN and don't sit behind the per-ip rate limit net.js paces for, so a 429 here would be a real
 *  limit, and re-firing at it 1s later, times the width of the fill pool, is the worst answer. */
const RETRY_STATUS = new Set([408, 500, 502, 503, 504]);

/**
 * Is a failed attempt worth one more?
 * - `stalled` = our own idle watchdog fired. Not retriable: a transfer that went STALL_MS without a
 *   single byte won't do better restarting from zero, it just burns the same silence again (and a
 *   second copy of whatever did arrive) before the caller's fallback finally runs.
 * - `status` = what the CDN answered, or 0 when the request failed with no status at all: a genuine
 *   network error (dns, connection reset, socket closed mid-body). Those are worth one more. A link
 *   that flickered is usually back by the next attempt.
 * - A 404 (this CRC simply has no package) or a 403 (hotlink protection), like every other 4xx,
 *   answers identically forever: retrying only doubles the wait before the fallback.
 */
export function isRetriable(status, stalled) {
  if (stalled) return false;
  return !status || RETRY_STATUS.has(status);
}

/** Drain a response body, calling `seen()` on every chunk so the caller can re-arm its idle watchdog.
 *  content-length is not trusted (Cloudflare omits it on chunked/compressed responses), so the chunks
 *  are concatenated at the end instead of being written into a pre-sized buffer. */
async function readAll(res, seen) {
  // no stream (polyfill / test double), NOTE the watchdog degrades to a total budget here, since
  // seen() is never called; fine, a real browser always streams a 200.
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  try {
    const chunks = [];
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

/**
 * Fetch a CDN object → raw response bytes, guarded by the idle watchdog and retried once on a
 * transient failure. `label` prefixes the thrown message so each caller keeps its own wording.
 *
 * The watchdog is the important part: a bare `await fetch(...)` never settles when the connection dies
 * without a reply, and one such call holds a slot of the main-thread fill pool forever, progress bar
 * and all, with no error and no way out but a reload.
 */
async function fetchBytes(url, label) {
  let last;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, BACKOFF_MS));
    const ctl = new AbortController();
    let timer = 0, stalled = false;
    /** (Re)start the idle watchdog, before the request, then again on every chunk received. */
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; ctl.abort(new DOMException('stalled', 'TimeoutError')); }, STALL_MS);
    };
    let status = 0;
    try {
      arm();
      // `no-referrer`: the CDN sits behind Cloudflare hotlink protection, which 403s a cross-origin
      // Referer. It only bites images today (see lib/gd.js), but a fetch that sends no Referer at all
      // never can, and these run from localhost/staging as much as from the app's own domain.
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
      if (res.ok) return await readAll(res, arm);
      status = res.status;
      last = new Error(`${label} ${res.status} ${res.statusText}`);
    } catch (err) {
      last = err; // our own stall abort, or a network failure with no status
    } finally {
      clearTimeout(timer);
    }
    if (!isRetriable(status, stalled) || attempt + 1 >= ATTEMPTS) break;
    console.warn(`[pkg] ${label} failed (attempt ${attempt + 1}/${ATTEMPTS}), retrying:`, last, url);
  }
  throw last;
}

/** Fetch + inflate a `.s2pkg` from its URL. Throws on network/format errors (callers fall back to
 *  generating the media). `url` should already be the absolute CDN URL */
export async function fetchPackage(url) {
  return decodePackage(decompress(await fetchBytes(url, 'package fetch')));
}

/** Fetch a zstd-compressed object (a `.man.zst` or a separated `.pcm.zst`) → inflated raw bytes. */
export async function fetchInflate(url) {
  return decompress(await fetchBytes(url, 'fetch'));
}
