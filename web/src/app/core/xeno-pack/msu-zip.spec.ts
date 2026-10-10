import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ImportCancelled, ZipError, bytesSource, copyEntry, conflicts, matchTrackName, planImport, readZipDirectory, renameMap, streamTracks,
  type OutFile, type ZipEntryInfo,
} from './msu-zip';

const info = (name: string, size = 10): ZipEntryInfo => ({ name, size, packed: size });
const names = (...n: string[]): ZipEntryInfo[] => n.map((x) => info(x));

describe('matchTrackName', () => {
  it('finds the trailing -<n>.pcm whatever the prefix, folder or case', () => {
    expect(matchTrackName('Game-1.pcm')).toEqual({ dir: '', prefix: 'Game', n: 1 });
    expect(matchTrackName('pack/sub/My Game - Deluxe-26.PCM')).toEqual({ dir: 'pack/sub', prefix: 'My Game - Deluxe', n: 26 });
    expect(matchTrackName('G-007.pcm')).toMatchObject({ n: 7 });
  });
  it('ignores what is not a track of this game', () => {
    for (const bad of ['Game-0.pcm', 'Game-27.pcm', 'Game.pcm', 'Game-1.wav', 'Game-x.pcm', 'dir/', '__MACOSX/Game-1.pcm', 'a/__MACOSX/b/Game-2.pcm', '._Game-1.pcm', 'sub/._Game-1.pcm', 'readme.txt']) {
      expect(matchTrackName(bad), bad).toBeNull();
    }
  });
});

describe('planImport', () => {
  it('plans a full pack, ignoring noise, and lists the missing tracks', () => {
    const all = Array.from({ length: 26 }, (_, i) => `Xeno Crisis-${i + 1}.pcm`).filter((n) => n !== 'Xeno Crisis-5.pcm' && n !== 'Xeno Crisis-26.pcm');
    const r = planImport(names('Xeno Crisis.msu', ...all, 'readme.txt', 'cover.png', '__MACOSX/._x', '._Xeno Crisis-1.pcm'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.prefix).toBe('Xeno Crisis');
    expect(r.plan.tracks.length).toBe(24);
    expect(r.plan.tracks[0].n).toBe(1);
    expect(r.plan.missing).toEqual([5, 26]);
    expect(r.plan.msu?.name).toBe('Xeno Crisis.msu');
    expect(r.plan.totalBytes).toBe(240);
  });
  it('works in a folder, with no .msu, and with a lone .msu of another name', () => {
    const a = planImport(names('dir/G-1.pcm', 'dir/G-2.pcm'));
    expect(a.ok && a.plan.msu).toBeNull();
    const b = planImport(names('dir/G-1.pcm', 'dir/other.msu', 'elsewhere/G.msu'));
    expect(b.ok && b.plan.msu?.name).toBe('dir/other.msu');
  });
  it('stops with a reason instead of guessing', () => {
    expect(planImport(names('readme.txt'))).toEqual({ ok: false, reason: 'none' });
    expect(planImport(names('A-1.pcm', 'B-2.pcm'))).toMatchObject({ ok: false, reason: 'prefixes' });
    expect(planImport(names('x/A-1.pcm', 'y/A-2.pcm'))).toMatchObject({ ok: false, reason: 'prefixes' });
    expect(planImport(names('A-1.pcm', 'a-1.PCM', 'A-2.pcm', 'A-2.pcm'))).toEqual({ ok: false, reason: 'duplicates', detail: [1, 2] });
  });
});

describe('rename map and conflicts', () => {
  it('names every file after the ROM stem, the .msu last', () => {
    const r = planImport(names('Xeno Crisis.msu', 'Xeno Crisis-1.pcm', 'Xeno Crisis-3.pcm'));
    if (!r.ok) throw new Error('plan');
    expect(renameMap('xenocrisis', r.plan)).toEqual([
      { from: 'Xeno Crisis-1.pcm', to: 'xenocrisis-1.pcm', track: 1 },
      { from: 'Xeno Crisis-3.pcm', to: 'xenocrisis-3.pcm', track: 3 },
      { from: 'Xeno Crisis.msu', to: 'xenocrisis.msu', track: null },
    ]);
    const none = planImport(names('G-1.pcm'));
    if (!none.ok) throw new Error('plan');
    expect(renameMap('R', none.plan).at(-1)).toEqual({ from: null, to: 'R.msu', track: null });
  });
  it('finds what would be overwritten, ignoring letter case', () => {
    expect(conflicts(['R-1.pcm', 'R-2.pcm', 'R.msu'], ['r-2.PCM', 'other', 'R.MSU'])).toEqual(['R-2.pcm', 'R.msu']);
    expect(conflicts(['a'], [])).toEqual([]);
  });
});

/* ----- a real (synthetic) archive through the streaming path ----- */

const pcm = (seed: number, len = 3000, magic = 'MSU1'): Uint8Array => {
  const b = new Uint8Array(8 + len);
  for (let i = 0; i < 4; i++) b[i] = magic.charCodeAt(i);
  for (let i = 8; i < b.length; i++) b[i] = (i * 7 + seed * 13) & 255;
  return b;
};
const mkZip = (files: Record<string, Uint8Array>, level: 0 | 6 = 6): Uint8Array => zipSync(files, { level });

class Mem {
  files = new Map<string, Uint8Array[]>();
  closed = new Set<string>();
  aborted = new Set<string>();
  openOut = async (name: string): Promise<OutFile> => {
    const parts: Uint8Array[] = [];
    this.files.set(name, parts);
    return {
      write: async (c) => { parts.push(c.slice()); },
      close: async () => { this.closed.add(name); },
      abort: async () => { this.aborted.add(name); },
    };
  };
  bytes(name: string): Uint8Array {
    const parts = this.files.get(name)!;
    const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { o.set(p, at); at += p.length; }
    return o;
  }
}

describe('readZipDirectory + streamTracks', () => {
  const files = {
    'Pack/Game.msu': new Uint8Array(0),
    'Pack/Game-1.pcm': pcm(1), 'Pack/Game-2.pcm': pcm(2, 9000), 'Pack/Game-3.pcm': pcm(3, 100, 'NOPE'),
    'Pack/readme.txt': new TextEncoder().encode('hello'), '__MACOSX/Pack/._Game-1.pcm': new Uint8Array(20),
  };

  it('lists names and sizes from the central directory', async () => {
    for (const level of [0, 6] as const) {
      const dir = await readZipDirectory(bytesSource(mkZip(files, level)));
      expect(dir.map((e) => e.name).sort()).toEqual(Object.keys(files).sort());
      expect(dir.find((e) => e.name === 'Pack/Game-2.pcm')?.size).toBe(9008);
    }
  });
  it('refuses what is not a zip', async () => {
    await expect(readZipDirectory(bytesSource(new Uint8Array(100)))).rejects.toBeInstanceOf(ZipError);
    await expect(readZipDirectory(bytesSource(new Uint8Array(3)))).rejects.toBeInstanceOf(ZipError);
  });

  for (const [label, level, chunk] of [['deflated, small steps', 6, 97], ['stored, one step', 0, 1 << 20]] as const) {
    it(`copies the tracks renamed, flags a bad one, writes nothing else (${label})`, async () => {
      const zip = mkZip(files, level);
      const src = bytesSource(zip);
      const plan = planImport(await readZipDirectory(src));
      if (!plan.ok) throw new Error('plan');
      const mem = new Mem();
      const seen: number[] = [];
      const r = await streamTracks({ src, plan: plan.plan, stem: 'rom', openOut: mem.openOut, chunkBytes: chunk, onTrackDone: (n) => seen.push(n) });
      expect(r.written).toEqual([1, 2]);
      expect(r.invalid).toEqual([3]);
      expect([...mem.files.keys()].sort()).toEqual(['rom-1.pcm', 'rom-2.pcm']);
      expect(Array.from(mem.bytes('rom-1.pcm'))).toEqual(Array.from(files['Pack/Game-1.pcm']));
      expect(Array.from(mem.bytes('rom-2.pcm'))).toEqual(Array.from(files['Pack/Game-2.pcm']));
      expect(mem.closed.size).toBe(2);
      expect(seen.sort()).toEqual([1, 2]);
    });
  }

  it('can be cancelled between steps and aborts the file in flight', async () => {
    const zip = mkZip({ 'G-1.pcm': pcm(1, 50000) }, 0);
    const src = bytesSource(zip);
    const plan = planImport(await readZipDirectory(src));
    if (!plan.ok) throw new Error('plan');
    const mem = new Mem();
    let steps = 0;
    await expect(streamTracks({ src, plan: plan.plan, stem: 'r', openOut: mem.openOut, chunkBytes: 4096, cancelled: () => ++steps > 3 })).rejects.toBeInstanceOf(ImportCancelled);
    expect(mem.aborted.has('r-1.pcm')).toBe(true);
    expect(mem.closed.size).toBe(0);
  });

  it('reports progress per track', async () => {
    const zip = mkZip({ 'G-1.pcm': pcm(1, 40000) }, 0);
    const src = bytesSource(zip);
    const plan = planImport(await readZipDirectory(src));
    if (!plan.ok) throw new Error('plan');
    const prog: number[] = [];
    await streamTracks({ src, plan: plan.plan, stem: 'r', openOut: new Mem().openOut, chunkBytes: 8192, onProgress: (_n, d, t) => prog.push(d / t) });
    expect(prog.length).toBeGreaterThan(2);
    expect(prog).toEqual([...prog].sort((a, b) => a - b));
  });

  it('notices a damaged track through its checksum and leaves the file aborted', async () => {
    const zip = mkZip({ 'G-1.pcm': pcm(1, 4000) }, 0);
    zip[zip.length - 400] ^= 0xff; // inside the stored data (the directory is at the very end)
    const src = bytesSource(zip);
    const plan = planImport(await readZipDirectory(src));
    if (!plan.ok) throw new Error('plan');
    const mem = new Mem();
    await expect(streamTracks({ src, plan: plan.plan, stem: 'r', openOut: mem.openOut })).rejects.toThrow(/checksum/);
    expect(mem.closed.size).toBe(0);
    expect(mem.aborted.has('r-1.pcm')).toBe(true);
  });

  it('copies the pack\'s .msu as it is, empty or not, under the ROM-stem name', async () => {
    for (const msu of [new Uint8Array(0), Uint8Array.of(1, 2, 3, 4, 5)]) {
      for (const level of [0, 6] as const) {
        const src = bytesSource(mkZip({ 'P/Game.msu': msu, 'P/Game-1.pcm': pcm(1) }, level));
        const plan = planImport(await readZipDirectory(src));
        if (!plan.ok || !plan.plan.msu) throw new Error('plan');
        const mem = new Mem();
        await copyEntry({ src, entry: plan.plan.msu, name: 'rom.msu', openOut: mem.openOut });
        expect(Array.from(mem.bytes('rom.msu'))).toEqual(Array.from(msu));
        expect(mem.closed.has('rom.msu')).toBe(true);
      }
    }
  });
});
