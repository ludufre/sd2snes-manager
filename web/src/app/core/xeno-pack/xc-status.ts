import { msuFileName, pcmFileName } from './msu-pcm';
import { checkDump, DUMP_SIZE, TRACK_COUNT } from './xc-streams';

/** CRC32 of the 128 KB v1.00 ROM (headerless), a shortcut that needs no file read. */
export const XC_ROM_CRC = 'FE5B38F0';

/** LoROM extended header: maker code at 0x7FB0, game code right after, internal title at 0x7FC0. */
const HDR = 0x7fb0;
const HDR_LEN = 0x40;

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** Is this the Xeno Crisis internal header? `h` = HDR_LEN bytes read at 0x7FB0 of the ROM (past any copier header). */
export function isXenoCrisisHeader(h: Uint8Array): boolean {
  if (h.length < HDR_LEN) return false;
  const maker = ascii(h, 0, 2) === 'BM';
  const code = ascii(h, 2, 4) === 'XCRI';
  const title = ascii(h, 0x10, 21).replace(/[\s\0]/g, '').toUpperCase().startsWith('XENOCRISIS');
  return (maker && code) || (title && (maker || code));
}

interface RomLike { crc?: string; size: number }
interface Sliceable { size: number; slice(a: number, b: number): { arrayBuffer(): Promise<ArrayBuffer> } }

/** Identify the cartridge by the ROM itself: its CRC32 when already known, else its internal header. */
export async function detectXenoCrisis(rom: RomLike, file: Sliceable | null): Promise<boolean> {
  if (rom.crc?.toUpperCase() === XC_ROM_CRC) return true;
  if (!file) return false;
  const base = file.size % 1024 === 512 ? 512 : 0;
  if (file.size < base + HDR + HDR_LEN) return false;
  try {
    const buf = await file.slice(base + HDR, base + HDR + HDR_LEN).arrayBuffer();
    return isXenoCrisisHeader(new Uint8Array(buf));
  } catch {
    return false;
  }
}

export type DumpState = 'missing' | 'wrong' | 'ok';

/** State of the dump on the card: not there, there but not the v1.00 flash (size, or CRC32 of everything before the save area), or fine. */
export async function probeDump(file: { size: number; arrayBuffer(): Promise<ArrayBuffer> } | null): Promise<DumpState> {
  if (!file) return 'missing';
  if (file.size !== DUMP_SIZE) return 'wrong';
  try {
    return checkDump(new Uint8Array(await file.arrayBuffer())).ok ? 'ok' : 'wrong';
  } catch {
    return 'wrong';
  }
}

export type PackState = 'missing' | 'incomplete' | 'present';
export interface PackStatus { state: PackState; have: number; total: number }

/** How much of `<stem>.msu` + `<stem>-1..26.pcm` is beside the ROM. */
export async function probePack(dir: { getFileHandle(name: string): Promise<unknown> } | undefined, stem: string): Promise<PackStatus> {
  const total = TRACK_COUNT + 1;
  const names = [msuFileName(stem), ...Array.from({ length: TRACK_COUNT }, (_, i) => pcmFileName(stem, i + 1))];
  let have = 0;
  if (dir) {
    for (const n of names) {
      try { await dir.getFileHandle(n); have++; } catch { /* absent */ }
    }
  }
  return { state: have === 0 ? 'missing' : have === total ? 'present' : 'incomplete', have, total };
}
