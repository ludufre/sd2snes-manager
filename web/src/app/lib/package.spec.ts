import { describe, it, expect, afterEach, vi } from 'vitest';
import { isRetriable, fetchPackage, fetchInflate } from './package.js';

/** Two layers here, on purpose. The first is the repo's usual "pure function only" kind: `isRetriable`
 *  is the whole retry policy and it costs nothing to pin down.
 *
 *  The second breaks that convention and stubs `fetch`, because the bugs this module is guarding
 *  against are not in the predicate, they're in how the loop uses it: retrying a 404 (every game
 *  without a package would pay double before falling back) and, in the other direction, re-downloading
 *  a multi-MB body because the format check that failed happened to sit inside the retry. Neither is
 *  visible from the predicate, both are invisible in review, and both are one stub away from being
 *  provable. Counting requests is the assertion; the network itself is never touched. */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

/** Replace fetch with a canned response and count the calls. */
function stubFetch(status: number, statusText: string, body = new Uint8Array()) {
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => {
    calls.push(url);
    return Promise.resolve(new Response(status === 204 || status === 304 ? null : body, { status, statusText }));
  }) as typeof fetch;
  return calls;
}

describe('isRetriable', () => {
  it('retries a request that failed with no status at all (DNS, reset, dropped VPN)', () => {
    expect(isRetriable(0, false)).toBe(true);
  });

  it('retries transient server-side statuses', () => {
    for (const s of [408, 500, 502, 503, 504]) expect(isRetriable(s, false)).toBe(true);
  });

  it('does NOT retry a final answer — a 404 is "this CRC has no package", not a hiccup', () => {
    // Retrying these only doubles the wait before the caller falls back to generating the media.
    for (const s of [400, 401, 403, 404, 410, 416, 451]) expect(isRetriable(s, false)).toBe(false);
  });

  it('does NOT retry 429 — off the CDN that is a real limit, not the /api throttle net.js paces', () => {
    expect(isRetriable(429, false)).toBe(false);
  });

  it('does NOT retry OUR OWN stall abort, whatever else it looks like', () => {
    // A transfer that went 30s without a single byte won't do better starting over: it burns the same
    // silence again, plus a second copy of the bandwidth, before the caller's fallback finally runs.
    expect(isRetriable(0, true)).toBe(false);
    expect(isRetriable(503, true)).toBe(false);
  });
});

describe('fetchPackage / fetchInflate retry loop', () => {
  it('asks ONCE for a 404 — the common "no package for this CRC", which must fall back immediately', async () => {
    const calls = stubFetch(404, 'Not Found');
    await expect(fetchPackage('https://cdn/x.s2pkg')).rejects.toThrow('package fetch 404 Not Found');
    expect(calls.length).toBe(1);
  });

  it('asks TWICE for a 503 and then gives up', async () => {
    const calls = stubFetch(503, 'Service Unavailable');
    await expect(fetchInflate('https://cdn/x.pcm.zst')).rejects.toThrow('fetch 503 Service Unavailable');
    expect(calls.length).toBe(2);
  });

  it('does NOT re-download a body that arrived fine but failed to inflate', async () => {
    // decompress/decodePackage live outside the retry: a corrupt object is corrupt on every attempt,
    // and re-pulling several MB to prove it is exactly the waste this guards against.
    const calls = stubFetch(200, 'OK', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await expect(fetchPackage('https://cdn/x.s2pkg')).rejects.toThrow();
    expect(calls.length).toBe(1);
  });

  it('keeps each caller\'s error wording (library-store and the fill report read these)', async () => {
    stubFetch(403, 'Forbidden');
    await expect(fetchPackage('https://cdn/x.s2pkg')).rejects.toThrow(/^package fetch 403 Forbidden$/);
    stubFetch(403, 'Forbidden');
    await expect(fetchInflate('https://cdn/x.man.zst')).rejects.toThrow(/^fetch 403 Forbidden$/);
  });
});
