import { describe, it, expect } from 'vitest';
import { crcBegin, crcUpdate, crcEnd, headerlessCrc32, isSfromName, romSpan, sfromFooterOffset, sfromSpan, SFROM_HEAD_BYTES, SFROM_FOOT_BYTES } from './crc32.js';
import { systemOf, ROM_EXTS } from './scan.js';
import { snesHeaderChecksum } from './snes-header';

/** The SFROM rule mirrors the firmware's load_sfrom_info(): the catalog CRC of a `.sfrom` is the CRC of
 *  the image embedded in it, so the container resolves to the same game as the plain dump. The streamed
 *  path (romSpan, used by the CRC worker) and the in-memory path (headerlessCrc32) have to agree, or a
 *  ROM's identity would depend on which one ran. */
describe('SFROM container', () => {
  const bytes = (n: number, seed = 7): Uint8Array => {
    const out = new Uint8Array(n);
    let s = seed >>> 0;
    for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = (s >>> 16) & 0xff; }
    return out;
  };
  const put32 = (b: Uint8Array, o: number, v: number): void => { new DataView(b.buffer, b.byteOffset).setUint32(o, v, true); };
  const cat = (...p: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
    let o = 0; for (const x of p) { out.set(x, o); o += x.length; }
    return out;
  };
  /** Nintendo layout: 0x30 header, image, footer with the size at +1. */
  const nintendo = (rom: Uint8Array): Uint8Array => {
    const hdr = new Uint8Array(0x30), foot = new Uint8Array(0x30);
    put32(hdr, 0, 0x100); put32(hdr, 4, 0x30 + rom.length + foot.length); put32(hdr, 8, 0x30); put32(hdr, 0x14, 0x30 + rom.length);
    foot[0] = 0x3c; put32(foot, 1, rom.length);
    return cat(hdr, rom, foot);
  };
  /** Converter layout: 0x50 header, size inline at 0x31, no footer. */
  const inline = (rom: Uint8Array): Uint8Array => {
    const hdr = new Uint8Array(0x50);
    put32(hdr, 0, 0x100); put32(hdr, 4, 0x50 + rom.length); put32(hdr, 8, 0x50); put32(hdr, 0x31, rom.length);
    return cat(hdr, rom);
  };
  const plain = (data: Uint8Array): string => crcEnd(crcUpdate(crcBegin(), data));
  const blob = (data: Uint8Array): Blob => new Blob([data as unknown as BlobPart]);
  const streamed = async (data: Uint8Array, name: string): Promise<string> => {
    const { off, len } = await romSpan(blob(data), name);
    return plain(data.subarray(off, off + len));
  };

  it('is listed as a SNES ROM', () => {
    expect(ROM_EXTS).toContain('sfrom');
    expect(systemOf('Super Mario Kart (USA).sfrom')).toBe('SNES');
    expect(systemOf('Super Mario Kart (USA).SFROM')).toBe('SNES');
    expect(isSfromName('a.sfrom')).toBe(true);
    expect(isSfromName('a.sfc')).toBe(false);
  });

  it('hashes to the CRC of the embedded image, in both layouts and on both paths', async () => {
    const rom = bytes(0x8000);
    const want = plain(rom);
    for (const file of [nintendo(rom), inline(rom)]) {
      expect(headerlessCrc32(file, 'Game.sfrom')).toBe(want);
      expect(headerlessCrc32(file, 'GAME.SFROM')).toBe(want);
      expect(await streamed(file, 'Game.sfrom')).toBe(want);
      expect(await romSpan(blob(file), 'Game.sfrom')).toEqual({ off: file[8], len: rom.length });
    }
  });

  it('is gated on the extension: the same bytes under .sfc are hashed whole', async () => {
    const file = nintendo(bytes(0x8000));
    expect(headerlessCrc32(file, 'Game.sfc')).toBe(plain(file));
    expect(await streamed(file, 'Game.sfc')).toBe(plain(file));
  });

  it('leaves the other rules alone', async () => {
    const rom = bytes(0x8000);
    const headered = cat(new Uint8Array(512), rom);
    expect(headerlessCrc32(headered, 'Game.smc')).toBe(plain(rom));
    expect(await streamed(headered, 'Game.smc')).toBe(plain(rom));
    const nes = cat(new Uint8Array([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), rom);
    expect(headerlessCrc32(nes, 'Game.nes')).toBe(plain(rom));
    expect(await streamed(nes, 'Game.nes')).toBe(plain(rom));
    expect(await streamed(rom, 'Game.sfc')).toBe(plain(rom));
  });

  it('a container that does not parse falls back to the plain rule on both paths', async () => {
    const rom = bytes(0x8000);
    const good = nintendo(rom);
    const mutate = (fn: (b: Uint8Array) => void): Uint8Array => { const b = good.slice(); fn(b); return b; };
    const noSize = inline(rom); put32(noSize, 0x31, 0);
    const cases: Array<[string, Uint8Array]> = [
      ['magic', mutate((b) => put32(b, 0, 0x200))],
      ['offset past the end', mutate((b) => put32(b, 8, good.length + 1))],
      ['size past the end', mutate((b) => put32(b, 0x30 + rom.length + 1, rom.length + 0x1000))],
      ['declared size too big', mutate((b) => put32(b, 4, good.length + 1))],
      ['no size anywhere', noSize],
      ['truncated header', good.slice(0, 0x20)],
    ];
    for (const [what, f] of cases) {
      const off = f.length % 1024 === 512 ? 512 : 0;
      const want = plain(f.subarray(off));
      expect(headerlessCrc32(f, 'x.sfrom'), what).toBe(want);
      expect(await streamed(f, 'x.sfrom'), what).toBe(want);
    }
  });

  it('exposes the two-slice read the worker relies on', () => {
    const rom = bytes(0x8000);
    const file = nintendo(rom);
    const head = file.subarray(0, SFROM_HEAD_BYTES);
    const fo = sfromFooterOffset(head, file.length);
    expect(fo).toBe(0x30 + rom.length);
    expect(sfromSpan(head, file.subarray(fo, fo + SFROM_FOOT_BYTES), file.length)).toEqual({ off: 0x30, len: rom.length });
    expect(sfromFooterOffset(new Uint8Array(0x50), 0x1000)).toBe(-1);
    const inl = inline(rom);
    expect(sfromFooterOffset(inl.subarray(0, SFROM_HEAD_BYTES), inl.length)).toBe(0);
    expect(sfromSpan(inl.subarray(0, SFROM_HEAD_BYTES), null, inl.length)).toEqual({ off: 0x50, len: rom.length });
  });

  it('reads the internal header from the embedded image', async () => {
    // a LoROM image whose header at $7FB0 carries a valid checksum pair
    const rom = new Uint8Array(0x10000);
    const h = 0x7fb0;
    rom[h + 0x25] = 0x20; rom[h + 0x26] = 0x00; rom[h + 0x27] = 0x08; rom[h + 0x28] = 0x00; rom[h + 0x29] = 0x01; rom[h + 0x2a] = 0x33;
    rom[h + 0x2c] = 0xcb; rom[h + 0x2d] = 0x5e; rom[h + 0x2e] = 0x34; rom[h + 0x2f] = 0xa1; // cchk + chk = 0xFFFF
    rom[h + 0x4c] = 0x00; rom[h + 0x4d] = 0x80; rom[0] = 0x78; // reset vector $8000 -> SEI
    const want = await snesHeaderChecksum(blob(rom), 'Game.sfc');
    expect(want).toBe('A134');
    expect(await snesHeaderChecksum(blob(nintendo(rom)), 'Game.sfrom')).toBe(want);
    expect(await snesHeaderChecksum(blob(inline(rom)), 'Game.sfrom')).toBe(want);
  });
});
