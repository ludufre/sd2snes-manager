/**
 * Xeno Crisis (SNES cartridge) music streams, as stored in the RP2040 flash.
 *
 * The cartridge keeps its music as 26 Opus streams inside the 16 MiB flash of its RP2040. The firmware
 * of the console cannot decode Opus, so the Manager rebuilds the music as an MSU-1 pack from the
 * owner's own dump of that flash (see xc-pack.ts). Nothing in this file is game data: it is the map of
 * where the streams of the v1.00 release start, plus the parser for their packet framing.
 *
 * Stream layout: a run of packets, each `[length BE32][final range BE32][length bytes of Opus]`, one
 * 20 ms stereo Opus frame per packet. A stream ends at the zero padding after it (length 0 AND range 0),
 * at a length no Opus frame of this game can have (> MAX_PACKET), or where the next stream starts.
 * A packet whose length is 0 but whose range is not is a skipped slot: the game plays no samples for it.
 */

/** The RP2040 flash is memory-mapped here; a flash address minus this is the offset in the dump. */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { crc32 } from '../../lib/crc32.js';

export const FLASH_BASE = 0x10000000;
export const DUMP_SIZE = 16 * 1024 * 1024;
export const TRACK_COUNT = 26;
/** The packets of this game are far smaller; a bigger length means "this is not a packet header". */
export const MAX_PACKET = 1500;

/** Flash address of the first packet of music stream n (index n - 1). Only the v1.00 release matches. */
export const STREAM_BASES: readonly number[] = [
  0x102ce930, 0x102e7120, 0x102eafd0, 0x1030ec20, 0x10310f40, 0x10362a10, 0x103d5930, 0x1043a4e0,
  0x10443470, 0x1049fc80, 0x104b6290, 0x10504af0, 0x1050c690, 0x105612b0, 0x1057e190, 0x105d5560,
  0x105ff030, 0x10618020, 0x10618970, 0x106374f0, 0x10658090, 0x10679ba0, 0x1068e6f0, 0x106a95d0,
  0x106aedb0, 0x106b7720,
];

/** Tracks the game plays exactly once (voiced intro, the intro parts, the jingles). The others loop. */
export const ONCE_TRACKS: ReadonlySet<number> = new Set([1, 4, 8, 10, 12, 14, 18, 24, 25]);

export interface OpusPacket {
  /** Opus payload size; 0 for a skipped slot. */
  length: number;
  /** Decoder final range the encoder recorded for this packet (0 = not recorded). */
  range: number;
  /** The Opus payload (a view into the dump, not a copy). */
  data: Uint8Array;
}

export type DumpCheck =
  | { ok: true }
  | { ok: false; reason: 'size'; actual: number }
  | { ok: false; reason: 'crc' };

const u32be = (d: Uint8Array, o: number): number =>
  ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

/** Packets of music stream `n` (1-based). Throws if the stream runs past the end of the dump. */
export function parseStream(dump: Uint8Array, n: number): OpusPacket[] {
  if (!Number.isInteger(n) || n < 1 || n > TRACK_COUNT) throw new RangeError(`no music stream ${n}`);
  let a = STREAM_BASES[n - 1] - FLASH_BASE;
  // A stream cannot run into the next one; the last one is bounded by the dump.
  const end = Math.min(n < TRACK_COUNT ? STREAM_BASES[n] - FLASH_BASE : dump.length, dump.length);
  const out: OpusPacket[] = [];
  while (a + 8 <= end) {
    const length = u32be(dump, a);
    const range = u32be(dump, a + 4);
    if (length > MAX_PACKET || (length === 0 && range === 0)) break;
    if (a + 8 + length > end) throw new RangeError(`stream ${n}: packet ${out.length} runs past the end of its data`);
    out.push({ length, range, data: dump.subarray(a + 8, a + 8 + length) });
    a += 8 + length;
  }
  return out;
}

/** The last 32 KB of the flash are the cartridge's save area and differ per player: never part of the check. */
export const DUMP_CODE_BYTES = 0xff8000;
/** CRC32 of the first DUMP_CODE_BYTES of the v1.00 flash (uppercase hex). */
export const DUMP_CRC32 = 'B4C799CC';

/**
 * Is this the v1.00 dump the pack builder understands? Exactly 16 MiB, and the CRC32 of everything
 * before the save area must be the v1.00 value. Another version, a damaged read or something that is
 * not this flash fails here instead of being decoded into noise. `expectedCrc` exists for tests.
 */
export function checkDump(dump: Uint8Array, expectedCrc: string = DUMP_CRC32): DumpCheck {
  if (dump.length !== DUMP_SIZE) return { ok: false, reason: 'size', actual: dump.length };
  const crc = (crc32(dump.subarray(0, DUMP_CODE_BYTES)) >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return crc === expectedCrc ? { ok: true } : { ok: false, reason: 'crc' };
}
