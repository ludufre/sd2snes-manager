import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * The auto-fill worker's DOWNLOAD/WRITE pipeline, driven through its real message protocol.
 *
 * This is not the repo's usual "pure function" spec, for the same reason package.spec.ts isn't: the
 * behaviour worth pinning down is not in any single expression, it is in how the two stages race.
 * Whether the fetchers actually run ahead of the writers, whether the lookahead/budget bounds hold, and
 * (the expensive one) whether a cancel or a dead card can leave the two stages waiting on each other
 * are all invisible in review and all one stub away from being provable. A hung pipeline shows up here
 * as a test timeout instead of as a progress bar frozen at 43% on someone's card.
 *
 * fzstd is mocked to the identity function: it only DEcompresses, so real fixtures would need a zstd
 * encoder just to hand the worker bytes it immediately inflates again.
 */
vi.mock('fzstd', () => ({ decompress: (b: Uint8Array) => b }));

/** The worker's own constants, mirrored so the assertions below read as arithmetic, not magic numbers. */
const LOOKAHEAD = 4;
const WRITERS = 6;
const BUDGET_BYTES = 96 * 1024 * 1024;

/* ---- the .s2pkg container the worker parses (mirror of lib/package.js's writer) ---- */
function makePkg(members: Record<string, Uint8Array>): Uint8Array {
  const manifest: { n: string; o: number; l: number }[] = [];
  let off = 0;
  for (const [n, b] of Object.entries(members)) { manifest.push({ n, o: off, l: b.byteLength }); off += b.byteLength; }
  const mj = new TextEncoder().encode(JSON.stringify(manifest));
  const out = new Uint8Array(12 + mj.length + off);
  out.set(new TextEncoder().encode('S2PK'), 0);
  new DataView(out.buffer).setUint32(8, mj.length, true);
  out.set(mj, 12);
  let at = 12 + mj.length;
  for (const b of Object.values(members)) { out.set(b, at); at += b.byteLength; }
  return out;
}

/* ---- an in-memory card. `writeHook` is where a test makes close() slow / fail. ---- */
let writeHook: (name: string) => Promise<void> = async () => {};
const closes: string[] = []; // every close() entered, i.e. every write that reached the card

class FakeDir {
  kind = 'directory' as const;
  children = new Map<string, FakeDir>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    let d = this.children.get(name);
    if (!d) {
      if (!opts?.create) throw Object.assign(new Error('no dir ' + name), { name: 'NotFoundError' });
      d = new FakeDir(name);
      this.children.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string): Promise<unknown> {
    return {
      createWritable: async () => ({
        write: async () => {},
        close: async () => { closes.push(name); await writeHook(name); },
      }),
    };
  }
}

/* ---- the CDN ---- */
let served: Uint8Array = new Uint8Array();
let failUrl: string | null = null; // this one URL answers 404 (the "no package for this CRC" case)
const fetched: string[] = [];
const realFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = ((url: string) => {
    fetched.push(url);
    if (url === failUrl) return Promise.resolve({ ok: false, status: 404, body: null } as unknown as Response);
    // body:null → the worker's readAll takes its arrayBuffer() path, and `new Uint8Array(buf)` is a view:
    // every job shares one container, so a 24MB budget fixture costs 24MB, not 24MB per job.
    return Promise.resolve({ ok: true, status: 200, body: null, arrayBuffer: async () => served.buffer } as unknown as Response);
  }) as typeof fetch;
}

/* ---- driving the worker ---- */
type Msg = { type: string; [k: string]: unknown };
const posts: Msg[] = [];
let onmsg: (ev: { data: unknown }) => Promise<void>;
let realPost: unknown;

beforeAll(async () => {
  // Dynamic import so `self` exists before the module's top-level `self.onmessage = ...` runs, whatever
  // environment the runner picked.
  (globalThis as { self?: unknown }).self ??= globalThis;
  await import('./autofill.worker');
  onmsg = (self as unknown as { onmessage: (ev: { data: unknown }) => Promise<void> }).onmessage;
});

beforeEach(() => {
  posts.length = 0; closes.length = 0; fetched.length = 0;
  writeHook = async () => {};
  failUrl = null;
  served = makePkg({ gcv: new Uint8Array(64) });
  stubFetch();
  realPost = (self as unknown as { postMessage: unknown }).postMessage;
  (self as unknown as { postMessage: unknown }).postMessage = (m: Msg) => posts.push(m);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (self as unknown as { postMessage: unknown }).postMessage = realPost;
  vi.restoreAllMocks();
});

/** N jobs that each write exactly one small file (the game info .gcv). One write per job keeps the
 *  concurrency arithmetic below honest. */
function jobsOf(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 'g' + i,
    packageUrl: `https://cdn/${i}.s2pkg`,
    fallbackPackageUrl: null, manualUrl: null, pcmUrl: null,
    file: `Game ${i}.sfc`, mode: 'buckets', stem: `Game ${i}`, folder: '',
    want: { cov: false, gcv: true, gss: false, fmv: false, pcm: false },
    cheatsText: null, infoYml: null,
  }));
}

function start(jobs: unknown[]): Promise<void> {
  return onmsg({
    data: {
      type: 'start', rootHandle: new FakeDir(''), jobs,
      cfg: { games: WRITERS, smallMax: 6, largeMax: 2, largeBytes: 128 * 1024 },
    },
  });
}

/** Let the pipeline run to its fixed point (everything either blocked on the write gate or parked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A write gate a test can hold open-ended and then release. */
function gate() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  return { held, release };
}

describe('download/write pipeline', () => {
  it('downloads AHEAD of the writers instead of sharing their slots', async () => {
    // The point of the two stages. With every write parked, the old design (one pool slot = fetch then
    // write) could not have more than 6 packages downloaded, the network sat idle behind the card.
    // Now: 6 packages in the writers' hands + LOOKAHEAD parked ready to go, and not one more.
    const g = gate();
    writeHook = () => g.held;
    const run = start(jobsOf(20));
    await settle();

    expect(closes.length).toBe(WRITERS);                 // the card is saturated...
    expect(fetched.length).toBe(WRITERS + LOOKAHEAD);    // ...and the network ran on ahead of it

    g.release();
    await run;
    expect(posts.filter((p) => p.type === 'progress').length).toBe(20);
  });

  it('stops the fetchers on the BYTE budget, not just the job count', async () => {
    // Four covers ahead is nothing; four previews with audio is memory. A package big enough that
    // LOOKAHEAD jobs already fill the budget must park the fetchers on bytes alone.
    served = makePkg({ gcv: new Uint8Array(BUDGET_BYTES / LOOKAHEAD) });
    const g = gate();
    writeHook = () => g.held;
    const run = start(jobsOf(20));
    await settle();

    // The budget is tested before a download starts, so the ceiling is "what was in flight when it was
    // crossed". The LOOKAHEAD fetchers that had already claimed a slot, and nothing after them.
    expect(fetched.length).toBe(LOOKAHEAD);
    expect(fetched.length).toBeLessThan(WRITERS + LOOKAHEAD); // strictly tighter than the count limit

    g.release();
    await run;
    expect(posts.filter((p) => p.type === 'progress').length).toBe(20);
  });

  it('reports a game whose package could not be downloaded — never silently drops it', async () => {
    // A fetch failure makes the job "ready with no package": it still has to reach a writer, still has
    // to post its progress, and still has to say what is missing, or the game vanishes from the run.
    failUrl = 'https://cdn/7.s2pkg';
    await start(jobsOf(20));
    const prog = posts.filter((p) => p.type === 'progress');
    expect(prog.length).toBe(20);
    const bad = prog.find((p) => p['id'] === 'g7') as Msg;
    expect(bad['hadPackage']).toBe(false);
    expect((bad['missing'] as { gcv: boolean }).gcv).toBe(true);
    expect(posts.at(-1)?.type).toBe('done');
  });

  it('keeps the progress contract: one post per game, `done` 1..N, cumulative `bytes`', async () => {
    await start(jobsOf(20));
    const prog = posts.filter((p) => p.type === 'progress');
    expect(prog.map((p) => p['done'])).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(prog.map((p) => p['id'])).size).toBe(20);
    const bytes = prog.map((p) => p['bytes'] as number);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b)); // monotonic: it's a running total
    expect(bytes.at(-1)).toBe(20 * 64);
    const done = posts.at(-1) as Msg;
    expect(done.type).toBe('done');
    expect(done['unwritable']).toBe(false);
    expect(done['writtenBytes']).toBe(20 * 64);
  });

  it('posts the cover as a COPY, never a view into the inflated package', async () => {
    // Structured clone serializes a view's whole backing buffer, shipping the raw member used to
    // copy the entire inflated .s2pkg to the main thread per cover. Pinned so removing the .slice()
    // fails here instead of silently re-bloating every progress message.
    const covBytes = new Uint8Array(48).fill(7);
    served = makePkg({ cov: covBytes, gcv: new Uint8Array(64) });
    const [job] = jobsOf(1) as { want: Record<string, boolean> }[];
    job.want = { cov: true, gcv: true, gss: false, fmv: false, pcm: false };
    await start([job]);
    const cov = (posts.find((p) => p['cov'] !== undefined)?.['cov']) as Uint8Array;
    expect(cov).toBeDefined();
    expect(Array.from(cov)).toEqual(Array.from(covBytes));
    expect(cov.buffer.byteLength).toBe(cov.byteLength);
  });

  it('cancels without deadlocking: writes in progress finish, nothing new starts', async () => {
    // Both stages can be parked when the cancel lands (fetchers on the lookahead, writers on the queue).
    // If the flag never reached them, this test would hang instead of fail.
    const g = gate();
    writeHook = () => g.held;
    const run = start(jobsOf(20));
    await settle();
    await onmsg({ data: { type: 'cancel' } });
    g.release();
    await run; // the assertion is that this settles

    const prog = posts.filter((p) => p.type === 'progress');
    expect(prog.length).toBe(WRITERS);        // only the games already being written
    expect(fetched.length).toBe(WRITERS + LOOKAHEAD); // and not a single extra download after the stop
    expect(posts.at(-1)?.type).toBe('done');
  });

  // "at least once" on purpose: writers already inside writeJob when the latch trips each post their
  // own fatal. The main thread's handler is idempotent, so multiple posts are by design.
  it('reports a dead card and unwinds both stages', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // A card that has stopped accepting writes: the latch trips after the streak, every stage has to
    // unwind, and the run has to end with a fatal + done rather than with a stuck pipeline.
    writeHook = async () => { throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' }); };
    await start(jobsOf(20));

    expect(posts.some((p) => p.type === 'fatal')).toBe(true);
    const done = posts.at(-1) as Msg;
    expect(done.type).toBe('done');
    expect(done['unwritable']).toBe(true);
    expect(posts.filter((p) => p.type === 'progress').length).toBeLessThan(20); // it stopped, as designed
  });

  it('runs a second time in the same worker without inheriting the first run\'s state', async () => {
    await start(jobsOf(3));
    posts.length = 0; fetched.length = 0;
    await start(jobsOf(5));
    const prog = posts.filter((p) => p.type === 'progress');
    expect(prog.map((p) => p['done'])).toEqual([1, 2, 3, 4, 5]);
    expect(fetched.length).toBe(5);
    expect((posts.at(-1) as Msg)['writtenBytes']).toBe(5 * 64);
  });
});
