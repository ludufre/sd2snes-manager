import { Inflate } from 'fflate';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { crcBegin, crcEnd, crcUpdate } from '../../lib/crc32.js';
import { msuFileName, pcmFileName, PCM_MAGIC } from './msu-pcm';
import { TRACK_COUNT } from './xc-streams';

/**
 * Installing a ready-made MSU-1 pack from a .zip: find its tracks, rename them to the ROM's stem
 * (the firmware only finds `<rom stem>.msu` and `<rom stem>-<n>.pcm`), and copy them to the card while
 * the zip is inflated, so a 250 MB archive never sits in memory.
 */

/* ----- reading the zip's directory without reading the zip ----- */

/** Random access to the archive: a File in the app, a byte array in tests. */
export interface ZipSource { readonly size: number; read(start: number, end: number): Promise<Uint8Array> }

export const fileSource = (f: Blob): ZipSource => ({
  size: f.size,
  read: async (a, b) => new Uint8Array(await f.slice(a, b).arrayBuffer()),
});
export const bytesSource = (d: Uint8Array): ZipSource => ({ size: d.length, read: async (a, b) => d.subarray(a, b) });

export interface ZipEntryInfo {
  name: string;
  size: number;
  packed: number;
  /** Offset of the entry's local header, compression method (0 stored, 8 deflate) and CRC32 (from the central directory). */
  offset?: number;
  method?: number;
  crc?: number;
}

export class ZipError extends Error {
  constructor(public readonly code: 'notzip' | 'zip64' | 'encrypted', message: string) { super(message); this.name = 'ZipError'; }
}

/** Entries from the central directory (names and sizes), found through the end-of-archive record. */
export async function readZipDirectory(src: ZipSource): Promise<ZipEntryInfo[]> {
  const tailLen = Math.min(src.size, 22 + 0xffff);
  const tail = await src.read(src.size - tailLen, src.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new ZipError('notzip', 'no end-of-archive record');
  const count = tv.getUint16(e + 10, true);
  const cdSize = tv.getUint32(e + 12, true);
  const cdOff = tv.getUint32(e + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new ZipError('zip64', 'zip64 archives are not supported');
  const cd = await src.read(cdOff, cdOff + cdSize);
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out: ZipEntryInfo[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== 0x02014b50) throw new ZipError('notzip', 'damaged central directory');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const packed = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true);
    const xl = dv.getUint16(p + 30, true);
    const cl = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    if (packed === 0xffffffff || size === 0xffffffff) throw new ZipError('zip64', 'zip64 archives are not supported');
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nl));
    if (flags & 1 && !name.endsWith('/')) throw new ZipError('encrypted', 'encrypted archives are not supported');
    out.push({ name, size, packed, offset, method, crc });
    p += 46 + nl + xl + cl;
  }
  return out;
}

/* ----- which entries are the pack ----- */

export interface PackTrack { n: number; path: string; size: number; entry: ZipEntryInfo }
export interface ImportPlan {
  /** The common name the tracks carry in the zip (shown to the user), without the "-<n>.pcm". */
  prefix: string;
  tracks: PackTrack[];
  missing: number[];
  msu: ZipEntryInfo | null;
  totalBytes: number;
}
export type PlanResult =
  | { ok: true; plan: ImportPlan }
  | { ok: false; reason: 'none' }
  | { ok: false; reason: 'prefixes'; detail: string[] }
  | { ok: false; reason: 'duplicates'; detail: number[] };

const TRACK_RE = /^(.*)-(\d+)\.pcm$/i;

const splitPath = (p: string): { dir: string; base: string } => {
  const i = p.lastIndexOf('/');
  return { dir: i < 0 ? '' : p.slice(0, i), base: p.slice(i + 1) };
};

/** True for what is never part of a pack: folders, macOS resource forks and AppleDouble companions. */
const isNoise = (name: string): boolean =>
  name.endsWith('/') || name.split('/').some((s) => s === '__MACOSX' || s.startsWith('._'));

/** Tracks are found by their trailing `-<n>.pcm` (n = 1..26), whatever the prefix or the folder depth. */
export function matchTrackName(path: string): { dir: string; prefix: string; n: number } | null {
  if (isNoise(path)) return null;
  const { dir, base } = splitPath(path);
  const m = TRACK_RE.exec(base);
  if (!m) return null;
  const n = Number(m[2]);
  return n >= 1 && n <= TRACK_COUNT ? { dir, prefix: m[1], n } : null;
}

export function planImport(entries: readonly ZipEntryInfo[]): PlanResult {
  const groups = new Map<string, { dir: string; prefix: string; items: PackTrack[] }>();
  for (const e of entries) {
    const m = matchTrackName(e.name);
    if (!m) continue;
    const key = `${m.dir}/${m.prefix}`.toLowerCase();
    const g = groups.get(key) ?? { dir: m.dir, prefix: m.prefix, items: [] };
    g.items.push({ n: m.n, path: e.name, size: e.size, entry: e });
    groups.set(key, g);
  }
  if (!groups.size) return { ok: false, reason: 'none' };
  if (groups.size > 1) return { ok: false, reason: 'prefixes', detail: [...groups.values()].map((g) => (g.dir ? `${g.dir}/` : '') + g.prefix) };
  const g = [...groups.values()][0];
  const seen = new Set<number>();
  const dup = new Set<number>();
  for (const t of g.items) (seen.has(t.n) ? dup : seen).add(t.n);
  if (dup.size) return { ok: false, reason: 'duplicates', detail: [...dup].sort((a, b) => a - b) };
  const tracks = [...g.items].sort((a, b) => a.n - b.n);
  const missing = Array.from({ length: TRACK_COUNT }, (_, i) => i + 1).filter((n) => !seen.has(n));
  const msus = entries.filter((e) => !isNoise(e.name) && /\.msu$/i.test(e.name) && splitPath(e.name).dir.toLowerCase() === g.dir.toLowerCase());
  const msu = msus.find((e) => splitPath(e.name).base.toLowerCase() === `${g.prefix}.msu`.toLowerCase()) ?? (msus.length === 1 ? msus[0] : null);
  return {
    ok: true,
    plan: { prefix: (g.dir ? `${g.dir}/` : '') + g.prefix, tracks, missing, msu, totalBytes: tracks.reduce((a, t) => a + t.size, 0) },
  };
}

/** zip path -> file name on the card, every one named after the ROM's stem. The `.msu` is always last. */
export function renameMap(stem: string, plan: ImportPlan): { from: string | null; to: string; track: number | null }[] {
  return [
    ...plan.tracks.map((t) => ({ from: t.path, to: pcmFileName(stem, t.n), track: t.n })),
    { from: plan.msu?.name ?? null, to: msuFileName(stem), track: null },
  ];
}

/** Names the install would overwrite, compared the way the card does (letter case ignored). */
export function conflicts(targets: readonly string[], present: readonly string[]): string[] {
  const have = new Set(present.map((n) => n.toLowerCase()));
  return targets.filter((t) => have.has(t.toLowerCase()));
}

/* ----- streaming the tracks to the card ----- */

/** A destination file being written (the card in the app, memory in tests). */
export interface OutFile { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }

export interface ImportOptions {
  src: ZipSource;
  plan: ImportPlan;
  /** Open `<stem>-<n>.pcm` (or any target name) for writing. */
  openOut(name: string): Promise<OutFile>;
  stem: string;
  onProgress?(track: number, done: number, total: number): void;
  onTrackDone?(track: number): void;
  cancelled?(): boolean;
  /** How much of the archive is read per step. */
  chunkBytes?: number;
}
export interface ImportResult { written: number[]; invalid: number[] }

export class ImportCancelled extends Error { constructor() { super('cancelled'); this.name = 'ImportCancelled'; } }

const concat = (parts: Uint8Array[]): Uint8Array => {
  const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { o.set(p, at); at += p.length; }
  return o;
};

const hasMagic = (b: Uint8Array): boolean => b.length >= 4 && String.fromCharCode(b[0], b[1], b[2], b[3]) === PCM_MAGIC;

interface PumpOptions { src: ZipSource; entry: ZipEntryInfo; step: number; cancelled?: () => boolean; onProgress?(done: number, total: number): void }

/**
 * Read one entry from its own place in the archive (the central directory gives the offset and the exact sizes),
 * a few MB per step, inflate it and hand every piece to `sink`. Size and CRC32 are checked against the directory.
 * Going entry by entry, instead of scanning the stream for data descriptors, cannot be fooled by compressed bytes.
 */
async function pump(o: PumpOptions, sink: (chunk: Uint8Array) => Promise<void>): Promise<void> {
  const e = o.entry;
  if (e.offset === undefined || (e.method !== 0 && e.method !== 8)) throw new ZipError('notzip', `${e.name}: unsupported compression`);
  const lh = await o.src.read(e.offset, e.offset + 30);
  const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
  if (lh.length < 30 || lv.getUint32(0, true) !== 0x04034b50) throw new ZipError('notzip', `${e.name}: damaged local header`);
  const dataStart = e.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);

  const total = Math.max(1, e.size);
  let received = 0;
  let crc = crcBegin();
  let ended = false;
  const queue: Uint8Array[] = [];
  const inflater = e.method === 8 ? new Inflate((data, final) => { if (data.length) queue.push(data.slice()); if (final) ended = true; }) : null;

  for (let at = 0; at < e.packed || (e.packed === 0 && at === 0); at += o.step) {
    if (o.cancelled?.()) throw new ImportCancelled();
    const end = Math.min(at + o.step, e.packed);
    const chunk = e.packed ? await o.src.read(dataStart + at, dataStart + end) : new Uint8Array(0);
    const last = end >= e.packed;
    if (inflater) inflater.push(chunk, last);
    else if (chunk.length) queue.push(chunk.slice());
    for (const c of queue.splice(0)) {
      received += c.length;
      crc = crcUpdate(crc, c);
      await sink(c);
    }
    o.onProgress?.(Math.min(received, total), total);
    if (e.packed === 0) break;
  }
  if (inflater && !ended) throw new ZipError('notzip', `${e.name}: the data ends early`);
  if (received !== e.size) throw new ZipError('notzip', `${e.name}: ${received} bytes, expected ${e.size}`);
  if (e.crc !== undefined && Number(`0x${crcEnd(crc)}`) !== e.crc) throw new ZipError('notzip', `${e.name}: checksum mismatch`);
}

/**
 * Copy every pack track to its renamed file while it is inflated, one entry at a time. A track that does not start
 * with "MSU1" is left out (and reported), never written. The `.msu` is NOT handled here: the caller writes it last
 * (copyEntry, or an empty one), so an interrupted install never leaves a pack the console would treat as active.
 */
export async function streamTracks(o: ImportOptions): Promise<ImportResult> {
  const step = o.chunkBytes ?? 4 * 1024 * 1024;
  const written: number[] = [];
  const invalid: number[] = [];

  for (const t of o.plan.tracks) {
    let head: Uint8Array[] = [];
    let headLen = 0;
    let out: OutFile | null = null;
    let bad = false;
    try {
      await pump({ src: o.src, entry: t.entry, step, cancelled: o.cancelled, onProgress: (d, tot) => o.onProgress?.(t.n, d, tot) }, async (c) => {
        if (bad) return;
        if (out) { await out.write(c); return; }
        head.push(c);
        headLen += c.length;
        if (headLen < 4) return;
        const all = concat(head);
        head = [];
        if (!hasMagic(all)) { bad = true; return; }
        out = await o.openOut(pcmFileName(o.stem, t.n));
        await out.write(all);
      });
      if (!out && !bad) bad = !hasMagic(concat(head)); // shorter than the magic
      if (bad) { invalid.push(t.n); continue; }
      await (out as OutFile | null)!.close();
      out = null;
      written.push(t.n);
      o.onTrackDone?.(t.n);
    } catch (err) {
      if (out) await (out as OutFile).abort().catch(() => undefined);
      throw err;
    }
  }
  return { written: written.sort((a, b) => a - b), invalid: invalid.sort((a, b) => a - b) };
}

/** Copy one entry as it is (the pack's `.msu`) to `name`. Call it after the tracks: it is the file that activates the pack. */
export async function copyEntry(o: { src: ZipSource; entry: ZipEntryInfo; name: string; openOut(name: string): Promise<OutFile>; chunkBytes?: number; cancelled?: () => boolean }): Promise<void> {
  const out = await o.openOut(o.name);
  try {
    await pump({ src: o.src, entry: o.entry, step: o.chunkBytes ?? 4 * 1024 * 1024, cancelled: o.cancelled }, (c) => out.write(c));
    await out.close();
  } catch (err) {
    await out.abort().catch(() => undefined);
    throw err;
  }
}
