/**
 * These pin snes-header.ts to the firmware's own election, not to a plausible-looking result.
 *
 * The key written into savestate_inputs.yml / savestate_fixes.yml is "%04X" of the checksum in
 * whichever header slot smc_id() picked (_repo/src/smc.c:106-149). Pick another slot and the
 * entry is inert: the console looks up a key that is not there, and nothing anywhere says so.
 * So the cases below are the ones where a reasonable-but-different heuristic drifts off.
 */
import { describe, expect, it } from 'vitest';
import { snesHeaderChecksum } from './snes-header';

const SLOT = { lorom: 0x7fb0, hirom: 0xffb0, exhirom: 0x40ffb0 } as const;
const MAP = { lorom: 0x20, hirom: 0x21, exhirom: 0x25 } as const;

interface Header {
  slot: keyof typeof SLOT;
  checksum: number;
  map?: number;
  reset?: number;
  resetInst?: number;
  badChecksum?: boolean;
}

/** Builds a ROM carrying one plausible header per entry, with a valid reset vector and opcode. */
function rom(headers: Header[], opts: { copier?: boolean; size?: number } = {}): File {
  const copier = opts.copier ? 0x200 : 0;
  const need = Math.max(0x10000, ...headers.map((h) => SLOT[h.slot] + 0x50));
  const bytes = new Uint8Array((opts.size ?? need) + copier);

  for (const spec of headers) {
    const at = SLOT[spec.slot] + copier;
    bytes.fill(0x20, at + 0x10, at + 0x25);                  // name[21], printable
    bytes[at + 0x25] = spec.map ?? MAP[spec.slot];           // map
    bytes[at + 0x26] = 0x00;                                 // carttype
    bytes[at + 0x27] = 0x0a;                                 // romsize
    bytes[at + 0x28] = 0x03;                                 // ramsize
    bytes[at + 0x29] = 0x01;                                 // destcode
    bytes[at + 0x2a] = 0x33;                                 // licensee
    const complement = (spec.badChecksum ? spec.checksum : spec.checksum ^ 0xffff) & 0xffff;
    bytes[at + 0x2c] = complement & 0xff;
    bytes[at + 0x2d] = complement >>> 8;
    bytes[at + 0x2e] = spec.checksum & 0xff;
    bytes[at + 0x2f] = spec.checksum >>> 8;
    const reset = spec.reset ?? 0x8000;
    bytes[at + 0x4c] = reset & 0xff;                         // vect_reset
    bytes[at + 0x4d] = reset >>> 8;
    // The byte the firmware reads as the first instruction, at the address its own formula picks.
    const resetAddr = ((SLOT[spec.slot] & ~0x7fff) | (reset & 0x7fff)) + copier;
    if (resetAddr < bytes.length) bytes[resetAddr] = spec.resetInst ?? 0x78; // sei
  }
  return new File([bytes], 'game.sfc');
}

describe('snesHeaderChecksum: electing the slot the firmware would elect', () => {
  it('reads the checksum as four uppercase hex digits, zero padded', async () => {
    expect(await snesHeaderChecksum(rom([{ slot: 'lorom', checksum: 0x09b7 }]))).toBe('09B7');
    expect(await snesHeaderChecksum(rom([{ slot: 'hirom', checksum: 0xa109 }]))).toBe('A109');
    expect(await snesHeaderChecksum(rom([{ slot: 'lorom', checksum: 0x0055 }]))).toBe('0055');
  });

  it('finds the header behind a 512-byte copier header', async () => {
    expect(await snesHeaderChecksum(rom([{ slot: 'lorom', checksum: 0x2bcc }], { copier: true }))).toBe('2BCC');
    expect(await snesHeaderChecksum(rom([{ slot: 'hirom', checksum: 0x13b8 }], { copier: true }))).toBe('13B8');
  });

  it('gives a big ROM its upper header, which is where the firmware ends up (smc.c:527)', async () => {
    // Both headers are equally well formed. ExHiROM still wins: its slot is past 0x400000, which
    // is worth 4 more points, and it is probed later so it would win a tie anyway. Scoring by
    // "checksum looks valid" alone lands on LoROM here and writes a key nothing reads.
    const file = rom([
      { slot: 'lorom', checksum: 0x1111 },
      { slot: 'exhirom', checksum: 0x2222 },
    ]);
    expect(await snesHeaderChecksum(file)).toBe('2222');
  });

  it('ignores a slot whose reset vector points below 0x8000 (smc.c:474)', async () => {
    const file = rom([
      { slot: 'lorom', checksum: 0x3333 },
      { slot: 'exhirom', checksum: 0x4444, reset: 0x0100 }, // would otherwise outscore LoROM
    ]);
    expect(await snesHeaderChecksum(file)).toBe('3333');
  });

  it('penalises a slot whose reset instruction cannot start a program (smc.c:517-523)', async () => {
    const file = rom([
      { slot: 'lorom', checksum: 0x5555 },
      { slot: 'hirom', checksum: 0x6666, resetInst: 0x00 }, // brk, -8
    ]);
    expect(await snesHeaderChecksum(file)).toBe('5555');
  });

  it('falls back to LoROM when nothing scores, exactly as smc_id() does (smc.c:107)', async () => {
    // Every candidate short-circuits on the reset vector, so the firmware keeps its initial
    // score_idx of 2 and reads the header at 0x7fb0 regardless of the score.
    const file = rom([{ slot: 'lorom', checksum: 0x7777, reset: 0x0010 }]);
    expect(await snesHeaderChecksum(file)).toBe('7777');
  });

  it('returns null when the file is too small to hold that slot at all', async () => {
    expect(await snesHeaderChecksum(new File([new Uint8Array(0x1000)], 'tiny.sfc'))).toBeNull();
  });
});
