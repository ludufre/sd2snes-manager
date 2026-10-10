import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PackRunner } from './xeno-pack-runner';
import type { PackReply, PackRequest } from './xeno-pack.protocol';
import { PackZip } from './pack-zip';
import { cleanStem, looksLikeXenoCrisis, packStem } from './xc-rom';
import { detectXenoCrisis, isXenoCrisisHeader, probeDump, probePack } from './xc-status';
import { DUMP_SIZE } from './xc-streams';
import { companionNames, joinPath, otherRoms, pickDumpCandidates, pickFolderName, rewriteListedPaths } from './xc-place';

describe('looksLikeXenoCrisis', () => {
  const e = (title: string, file: string, system = 'SNES') => ({ title, file, system }) as Parameters<typeof looksLikeXenoCrisis>[0];
  it('matches by title or file name, whatever the separators', () => {
    expect(looksLikeXenoCrisis(e('Xeno Crisis', 'Xeno Crisis.sfc'))).toBe(true);
    expect(looksLikeXenoCrisis(e('', 'xenocrisis.sfc'))).toBe(true);
    expect(looksLikeXenoCrisis(e('', 'Xeno_Crisis (World).smc'))).toBe(true);
    expect(looksLikeXenoCrisis(e('XENO-CRISIS', 'x.sfc'))).toBe(true);
  });
  it('ignores other games and other consoles', () => {
    expect(looksLikeXenoCrisis(e('Chrono Trigger', 'Chrono Trigger.sfc'))).toBe(false);
    expect(looksLikeXenoCrisis(e('Xeno Crisis', 'Xeno Crisis.md', 'MD' as never))).toBe(false);
    expect(looksLikeXenoCrisis(null)).toBe(false);
    expect(looksLikeXenoCrisis(undefined)).toBe(false);
  });
});

describe('pack file names', () => {
  it('uses the ROM file name without its extension, as the firmware does', () => {
    expect(packStem('Xeno Crisis.sfc')).toBe('Xeno Crisis');
    expect(packStem('Xeno Crisis (World) (v1.0).smc')).toBe('Xeno Crisis (World) (v1.0)');
    expect(packStem('noextension')).toBe('noextension');
  });
  it('cleanStem keeps names a card can hold and refuses the rest', () => {
    expect(cleanStem('  Xeno Crisis  ')).toBe('Xeno Crisis');
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'a:b', 'what?', 'a"b', 'a<b', 'a|b', 'x.', 'tab\there']) expect(cleanStem(bad), JSON.stringify(bad)).toBe('');
    expect(cleanStem('x'.repeat(201))).toBe('');
  });
});

describe('PackZip', () => {
  it('stores the files uncompressed and they unzip to the same bytes', () => {
    const z = new PackZip();
    const a = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) & 255);
    z.add('Game-1.pcm', a);
    z.add('Game.msu', new Uint8Array(0));
    const chunks = z.finish();
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    const out = unzipSync(all);
    expect(Object.keys(out).sort()).toEqual(['Game-1.pcm', 'Game.msu']);
    expect(Array.from(out['Game-1.pcm'])).toEqual(Array.from(a));
    expect(out['Game.msu'].length).toBe(0);
    expect(all.length).toBeLessThan(a.length + 400); // stored, not deflated
  });
  it('refuses files after finish', () => {
    const z = new PackZip();
    z.finish();
    expect(() => z.add('x', new Uint8Array(1))).toThrow();
  });
});

/** A worker that plays a script and records what the runner sends it. */
class FakeWorker {
  onmessage: ((ev: MessageEvent<PackReply>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  sent: PackRequest[] = [];
  terminated = false;
  postMessage(m: PackRequest): void { this.sent.push(m); }
  terminate(): void { this.terminated = true; }
  emit(m: PackReply): void { this.onmessage?.({ data: m } as MessageEvent<PackReply>); }
}

describe('PackRunner', () => {
  const track = (n: number): PackReply => ({ type: 'track', track: n, bytes: new ArrayBuffer(8), packets: 1, loops: false, rangeChecked: true });
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const handlers = () => {
    const log: string[] = [];
    return {
      log,
      h: {
        onRefused: (r: { reason: string }) => log.push('refused:' + r.reason),
        onProgress: (n: number, d: number, t: number) => log.push(`progress:${n}:${d}/${t}`),
        onTrack: async (r: { track: number }) => { log.push('track:' + r.track); },
        onDone: () => log.push('done'),
        onError: (m: string, t: number | null, mismatch: boolean) => log.push(`error:${m}:${t}:${mismatch}`),
      },
    };
  };

  it('sends the dump, acks each track after the handler finished, and stops on done', async () => {
    const w = new FakeWorker();
    const { h, log } = handlers();
    new PackRunner(() => w as unknown as Worker).start(new ArrayBuffer(4), h, 'https://x/opus.wasm');
    expect(w.sent[0]).toMatchObject({ type: 'start', wasmUrl: 'https://x/opus.wasm' });
    w.emit({ type: 'accepted' });
    w.emit({ type: 'progress', track: 1, done: 5, total: 10 });
    w.emit(track(1));
    await tick();
    expect(w.sent.filter((m) => m.type === 'ack').length).toBe(1);
    w.emit({ type: 'done' });
    expect(log).toEqual(['progress:1:5/10', 'track:1', 'done']);
    expect(w.terminated).toBe(true);
  });

  it('holds the ack while the handler is still writing', async () => {
    const w = new FakeWorker();
    let release!: () => void;
    const { h } = handlers();
    h.onTrack = () => new Promise<void>((r) => { release = r; });
    new PackRunner(() => w as unknown as Worker).start(new ArrayBuffer(4), h, 'u');
    w.emit(track(1));
    await tick();
    expect(w.sent.some((m) => m.type === 'ack')).toBe(false);
    release();
    await tick();
    expect(w.sent.some((m) => m.type === 'ack')).toBe(true);
  });

  it('turns a failing handler into an error and ends the worker', async () => {
    const w = new FakeWorker();
    const { h, log } = handlers();
    h.onTrack = async () => { throw new Error('disk full'); };
    new PackRunner(() => w as unknown as Worker).start(new ArrayBuffer(4), h, 'u');
    w.emit(track(3));
    await tick();
    expect(log).toEqual(['error:disk full:3:false']);
    expect(w.terminated).toBe(true);
    expect(w.sent.some((m) => m.type === 'ack')).toBe(false);
  });

  it('runs again after a cancel, and a late write of the cancelled run sends no ack', async () => {
    const a = new FakeWorker();
    const b = new FakeWorker();
    const workers = [a, b];
    const r = new PackRunner(() => workers.shift() as unknown as Worker);
    let release!: () => void;
    const first = handlers();
    first.h.onTrack = () => new Promise<void>((res) => { release = res; });
    r.start(new ArrayBuffer(4), first.h, 'u');
    a.emit(track(1));
    r.cancel();
    const second = handlers();
    r.start(new ArrayBuffer(4), second.h, 'u');
    release();
    await tick();
    expect(a.sent.some((m) => m.type === 'ack')).toBe(false);
    b.emit(track(1));
    await tick();
    expect(b.sent.filter((m) => m.type === 'ack').length).toBe(1);
  });

  it('relays a refusal and a worker error, and cancel terminates', () => {
    const a = new FakeWorker();
    const ha = handlers();
    new PackRunner(() => a as unknown as Worker).start(new ArrayBuffer(4), ha.h, 'u');
    a.emit({ type: 'refused', reason: 'crc' });
    expect(ha.log).toEqual(['refused:crc']);
    const b = new FakeWorker();
    const hb = handlers();
    const rb = new PackRunner(() => b as unknown as Worker);
    rb.start(new ArrayBuffer(4), hb.h, 'u');
    b.emit({ type: 'error', track: 7, message: 'boom', rangeMismatch: true });
    expect(hb.log).toEqual(['error:boom:7:true']);
    const c = new FakeWorker();
    const rc = new PackRunner(() => c as unknown as Worker);
    rc.start(new ArrayBuffer(4), handlers().h, 'u');
    rc.cancel();
    rc.cancel();
    expect(c.terminated).toBe(true);
  });
});

describe('card status', () => {
  const header = (over: Record<number, string> = {}): Uint8Array => {
    const h = new Uint8Array(0x40);
    const put = (at: number, s: string): void => { for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i); };
    put(0, 'BM'); put(2, 'XCRI'); put(0x10, 'XENOCRISIS           ');
    for (const [at, s] of Object.entries(over)) put(Number(at), s);
    return h;
  };
  const romOf = (hdr: Uint8Array, headered = false) => {
    const base = headered ? 512 : 0;
    const bytes = new Uint8Array(base + 0x8000 + 0x7fb0 - 0x8000 + 0x40 + 16);
    bytes.set(hdr, base + 0x7fb0);
    return new Blob([bytes]);
  };

  it('recognises the internal header, with a copier header too', async () => {
    expect(isXenoCrisisHeader(header())).toBe(true);
    expect(await detectXenoCrisis({ size: 0 }, romOf(header()))).toBe(true);
    expect(await detectXenoCrisis({ size: 0 }, romOf(header(), true))).toBe(true);
  });
  it('recognises it by ROM CRC without reading the file', async () => {
    expect(await detectXenoCrisis({ crc: 'fe5b38f0', size: 0 }, null)).toBe(true);
  });
  it('rejects other games, even one that borrows a part of the header', async () => {
    expect(isXenoCrisisHeader(header({ 0: 'AB', 2: 'ZZZZ', 0x10: 'SOMETHING ELSE      ' }))).toBe(false);
    expect(isXenoCrisisHeader(header({ 0: 'AB', 2: 'ZZZZ' }))).toBe(false); // a title alone is not enough
    expect(isXenoCrisisHeader(header({ 2: 'ZZZZ' }))).toBe(true); // title + maker
    expect(isXenoCrisisHeader(header({ 0x10: 'OTHER               ', 2: 'ZZZZ' }))).toBe(false);
    expect(isXenoCrisisHeader(new Uint8Array(10))).toBe(false);
    expect(await detectXenoCrisis({ size: 0 }, new Blob([new Uint8Array(100)]))).toBe(false);
    expect(await detectXenoCrisis({ size: 0 }, null)).toBe(false);
  });

  it('dump state: missing, wrong size, wrong content, ok', async () => {
    expect(await probeDump(null)).toBe('missing');
    expect(await probeDump({ size: 5, arrayBuffer: async () => new ArrayBuffer(5) })).toBe('wrong');
    expect(await probeDump({ size: DUMP_SIZE, arrayBuffer: async () => new ArrayBuffer(DUMP_SIZE) })).toBe('wrong');
  });

  it('pack state counts the .msu and the 26 tracks', async () => {
    const dirOf = (names: string[]) => ({ getFileHandle: async (n: string) => { if (!names.includes(n)) throw new Error('nf'); return {}; } });
    const all = ['G.msu', ...Array.from({ length: 26 }, (_, i) => `G-${i + 1}.pcm`)];
    expect(await probePack(dirOf([]), 'G')).toEqual({ state: 'missing', have: 0, total: 27 });
    expect(await probePack(undefined, 'G')).toMatchObject({ state: 'missing' });
    expect(await probePack(dirOf(all.slice(1)), 'G')).toEqual({ state: 'incomplete', have: 26, total: 27 });
    expect(await probePack(dirOf(all), 'G')).toEqual({ state: 'present', have: 27, total: 27 });
    expect(await probePack(dirOf(['other.msu']), 'G')).toMatchObject({ state: 'missing' });
  });
});

describe('placement rules', () => {
  const isRom = (n: string): boolean => /\.(sfc|smc|nes|gb|gbc|sms|a26|st|bs|sfrom|sgb)$/i.test(n);
  it('picks dump candidates: the dump name first, then other 16 MiB .bin files', () => {
    const MB16 = 16 * 1024 * 1024;
    expect(pickDumpCandidates([
      { name: 'other.bin', size: MB16 }, { name: 'small.bin', size: 5 }, { name: 'XenoCrisis_RP2040.BIN', size: 3 },
      { name: 'big.iso', size: MB16 }, { name: 'second.BIN', size: MB16 },
    ])).toEqual(['XenoCrisis_RP2040.BIN', 'other.bin', 'second.BIN']);
    expect(pickDumpCandidates([])).toEqual([]);
  });
  it('counts only other ROMs of any console, not the game itself or its extras', () => {
    expect(otherRoms(['Xeno Crisis.sfc', 'Xeno Crisis.cov', 'Xeno Crisis.msu', 'Zelda.smc', 'Tetris.nes', 'notes.txt'], 'xeno crisis.SFC', isRom)).toEqual(['Zelda.smc', 'Tetris.nes']);
    expect(otherRoms(['Xeno Crisis.sfc', 'Xeno Crisis-1.pcm', 'a.ips'], 'Xeno Crisis.sfc', isRom)).toEqual([]);
  });
  it('names the new folder after the ROM stem and avoids a clash', () => {
    expect(pickFolderName('Xeno Crisis', [])).toBe('Xeno Crisis');
    expect(pickFolderName('Xeno Crisis', [{ name: 'Other', hasRoms: true }])).toBe('Xeno Crisis');
    expect(pickFolderName('Xeno Crisis', [{ name: 'xeno crisis', hasRoms: false }])).toBe('Xeno Crisis'); // empty leftover is reused
    expect(pickFolderName('Xeno Crisis', [{ name: 'Xeno Crisis', hasRoms: true }])).toBe('Xeno Crisis (2)');
    expect(pickFolderName('X', [{ name: 'X', hasRoms: true }, { name: 'X (2)', hasRoms: true }])).toBe('X (3)');
  });
  it('lists what travels with the ROM', () => {
    const names = ['G.sfc', 'G.cov', 'G.msu', 'G-1.pcm', 'G-26.pcm', 'G-27.pcm', 'G - Patch.ips', 'G.BPS', 'H.cov', 'H.ips', 'G.txt', 'G.srm'];
    expect(companionNames('G', names)).toEqual(['G.cov', 'G.msu', 'G-1.pcm', 'G-26.pcm', 'G - Patch.ips', 'G.BPS']);
  });
  it('joins card paths', () => {
    expect(joinPath('', 'a')).toBe('a');
    expect(joinPath('Games/SNES', 'a')).toBe('Games/SNES/a');
  });

  const enc = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  const dec = (b: Uint8Array): string => [...b].map((c) => String.fromCharCode(c)).join('').replace(/\0/g, '|');
  it('rewrites a moved ROM in the lists, keeping patch names and the other entries', () => {
    const list = enc('/Games/Xeno Crisis.sfc\0/Games/Zelda.smc\t/Games/Zelda - Fix.ips\0/games/xeno crisis.SFC\tP\0');
    const r = rewriteListedPaths(list, '/Games/Xeno Crisis.sfc', '/Games/Xeno Crisis/Xeno Crisis.sfc');
    expect(r.changed).toBe(2);
    expect(dec(r.data)).toBe('/Games/Xeno Crisis/Xeno Crisis.sfc|/Games/Zelda.smc\t/Games/Zelda - Fix.ips|/Games/Xeno Crisis/Xeno Crisis.sfc\tP|');
  });
  it('leaves a list without the ROM untouched, and handles newline ends and Latin-1 names', () => {
    const list = enc('/a/B.sfc\0');
    const same = rewriteListedPaths(list, '/x.sfc', '/y/x.sfc');
    expect(same.changed).toBe(0);
    expect(same.data).toBe(list);
    const nl = rewriteListedPaths(enc('/Caf\xe9.sfc\n/b.sfc\n'), '/Caf\xe9.sfc', '/Caf\xe9/Caf\xe9.sfc');
    expect(dec(nl.data)).toBe('/Caf\xe9/Caf\xe9.sfc\n/b.sfc\n');
    expect(rewriteListedPaths(list, '/あ.sfc', '/x').changed).toBe(0);
    expect(rewriteListedPaths(new Uint8Array(0), '/a', '/b').changed).toBe(0);
  });
});
