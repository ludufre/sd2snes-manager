// Shared client-side throttle + retry for the ludufre API (gamedb `/api` + `/cheats`), which sit
// behind Cloudflare's per-ip rate limit. The bulk "Preencher automaticamente" passes fire many
// lookups; without pacing they trip HTTP 429. A single global min-gap serializes the
// bursts (regardless of caller concurrency), and failures are retried with exponential backoff
// (honouring Retry-After). One module-level gate is shared by both clients since they share
// the same origin → the same rate limit.

let _next = 0;
const MIN_GAP_MS = 100; // ~10 req/s ceiling across gamedb + cheats
/** Per-attempt ceiling. A 50-CRC batch lookup is the slowest call and still answers in ~1s, so 30s
 *  only ever fires on a connection that is never going to answer. */
const TIMEOUT_MS = 30000;
/** Transient server-side failures: worth another attempt, unlike a 4xx that will fail identically. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gate() {
  const now = Date.now();
  const at = Math.max(now, _next);
  _next = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

/** The caller's own cancel signal + our per-attempt timeout, as one signal. */
function withTimeout(signal, ms) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  return {
    signal: ctl.signal,
    done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

/**
 * fetch() throttled by the global gate, bounded by a timeout, and retried on transient failures.
 * Returns the Response (caller checks .ok).
 *
 * The timeout is the important part: a bare `await fetch(...)` never settles when the connection
 * dies without a reply, a dropped vpn, a laptop that slept, a proxy that hung up mid-request. The
 * 6000-ROM analyze pass then froze on that one call, progress bar and all, with no error and no way
 * out but a reload. Every attempt is now bounded, and a connection that comes back is picked up by
 * the next retry.
 */
export async function apiFetch(url, init = {}, { retries = 4 } = {}) {
  let backoff = 600;
  for (let attempt = 0; ; attempt++) {
    // The caller's cancel outranks the gate: a request that was queued behind another one must not sit
    // out its 100ms slot (nor be sent at all) after the run it belongs to was stopped.
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
    await gate();
    const last = attempt >= retries;
    const t = withTimeout(init.signal, TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: t.signal });
      if (RETRY_STATUS.has(res.status) && !last) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff);
        backoff = Math.min(backoff * 2, 8000);
        continue;
      }
      return res;
    } catch (err) {
      // The caller's cancel (dialog closed, bulk stopped) must propagate immediately, only our own
      // timeout and genuine network errors are worth retrying.
      if (init.signal?.aborted) throw err;
      if (last) throw err;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 8000);
    } finally {
      t.done();
    }
  }
}
