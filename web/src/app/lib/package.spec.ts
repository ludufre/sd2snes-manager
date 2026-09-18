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

/** A valid zstd frame holding `raw` as one raw block (single segment, 1-byte content size, no
 *  checksum). fzstd only inflates, and this is all a test of the fetch loop needs. */
function zstdRaw(raw: Uint8Array): Uint8Array {
  const n = raw.length; // ≤ 255: the 1-byte Frame_Content_Size
  const bh = 1 | (n << 3); // Last_Block, Raw_Block, Block_Size
  return new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, n, bh & 0xff, (bh >> 8) & 0xff, (bh >> 16) & 0xff, ...raw]);
}
async function hex(b: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('fetchInflate with a published sha256 — a re-encoded manual stuck in the browser cache', () => {
  const OLD = new TextEncoder().encode('manual, the encode before the GameDB rebuilt it');
  const NEW = new TextEncoder().encode('manual, the encode the GameDB publishes today');

  /** Answer each request with the next body in `bodies` (the last one repeats), recording the cache mode. */
  function stubSeq(bodies: Uint8Array[]) {
    const modes: Array<RequestCache | undefined> = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      modes.push(init?.cache);
      const b = bodies[Math.min(modes.length - 1, bodies.length - 1)];
      return Promise.resolve(new Response(zstdRaw(b) as BodyInit, { status: 200 }));
    }) as typeof fetch;
    return modes;
  }

  it('asks ONCE, through the normal cache, when the bytes are the published ones', async () => {
    const modes = stubSeq([NEW]);
    expect([...await fetchInflate('https://cdn/m.man.zst', await hex(NEW))]).toEqual([...NEW]);
    expect(modes).toEqual([undefined]);
  });

  it('refetches PAST the cache when the first answer is the old encode, and returns the new one', async () => {
    // The card that kept "Guias/Manuais" at "Completar": the same url, `immutable`, answered from the
    // HTTP cache with the pre-re-encode document. Written as-is it never matched the published hash.
    const modes = stubSeq([OLD, NEW]);
    expect([...await fetchInflate('https://cdn/m.man.zst', await hex(NEW))]).toEqual([...NEW]);
    expect(modes).toEqual([undefined, 'reload']);
  });

  it('never hands back bytes it could not prove, a mismatch that survives the reload is an error', async () => {
    const modes = stubSeq([OLD]);
    await expect(fetchInflate('https://cdn/m.man.zst', await hex(NEW))).rejects.toThrow(/^checksum mismatch/);
    expect(modes).toEqual([undefined, 'reload']);
  });

  it('accepts the hash in upper case too', async () => {
    stubSeq([NEW]);
    expect([...await fetchInflate('https://cdn/m.man.zst', (await hex(NEW)).toUpperCase())]).toEqual([...NEW]);
  });

  it('revalidates when there is no hash to prove the bytes with', async () => {
    const modes = stubSeq([NEW]);
    expect([...await fetchInflate('https://cdn/a.pcm.zst')]).toEqual([...NEW]);
    expect(modes).toEqual(['no-cache']);
  });
});
