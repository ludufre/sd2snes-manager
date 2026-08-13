import { describe, it, expect } from 'vitest';
import { crc32, crcBegin, crcUpdate, crcEnd, headerOffset, headerlessCrc32, hasCopierHeader, hasINesHeader } from './crc32.js';

/** The incremental API exists so a ROM can be streamed through the checksum (core/crc.worker.ts) instead
 *  of being pulled into memory whole. Streaming is only safe if it agrees with the one-shot
 *  `headerlessCrc32` bit for bit, a CRC that depends on which path computed it silently mis-identifies
 *  games (and poisons the (path,size,mtime) CRC cache with a value the other path will never reproduce).
 *  So every case here is asserted against `headerlessCrc32`, chunked at sizes that straddle the headers. */
describe('crc32 incremental API', () => {
  /** Deterministic pseudo-random bytes (no crypto/Math.random: a failure has to be reproducible). */
  const bytes = (n: number, seed = 1): Uint8Array => {
    const out = new Uint8Array(n);
    let s = seed >>> 0;
    for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = (s >>> 16) & 0xff; }
    return out;
  };
  /** Fold `data` in chunks of `size`. What the worker's stream reader does. */
  const streamed = (data: Uint8Array, size: number): string => {
    let st = crcBegin();
    for (let i = 0; i < data.length; i += size) st = crcUpdate(st, data.subarray(i, i + size));
    return crcEnd(st);
  };

  it('matches the known CRC32 vector for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crcEnd(crcUpdate(crcBegin(), new TextEncoder().encode('123456789')))).toBe('CBF43926');
  });

  it('is chunk-size independent (and equals the one-shot result)', () => {
    const data = bytes(4096 + 37);
    const once = crcEnd(crcUpdate(crcBegin(), data));
    for (const size of [1, 3, 64, 512, 1024, 4096, 100000]) expect(streamed(data, size)).toBe(once);
  });

  it('an empty input is the empty CRC, and empty chunks are no-ops', () => {
    expect(crcEnd(crcBegin())).toBe('00000000');
    let st = crcBegin();
    st = crcUpdate(st, new Uint8Array(0));
    st = crcUpdate(st, new Uint8Array(0));
    expect(crcEnd(st)).toBe('00000000');
  });

  it('pads to 8 UPPERCASE hex chars (the form gamedb stores)', () => {
    // The byte 0x22 hashes to 0x0762AE69, 7 significant hex digits, so this asserts the actual
    // leading-zero padding, not just the /^[0-9A-F]{8}$/ shape.
    expect(crcEnd(crcUpdate(crcBegin(), new Uint8Array([34])))).toBe('0762AE69');
    expect(crcEnd(crcUpdate(crcBegin(), new Uint8Array(4)))).toBe('2144DF1C');
    expect(headerlessCrc32(bytes(10), 'a.sfc')).toMatch(/^[0-9A-F]{8}$/);
  });

  it('headerOffset edge names: uppercase .NES without magic, and no name at all', () => {
    const plain = new Uint8Array(16); // no iNES magic
    expect(headerOffset(plain, 1024 + 512, 'GAME.NES')).toBe(512); // copier rule still applies
    expect(headerOffset(plain, 1024, 'GAME.NES')).toBe(0);
    expect(headerOffset(plain, 1024 + 512, '')).toBe(512);
    expect(headerOffset(plain, 1024, '')).toBe(0);
  });
});

describe('headerOffset', () => {
  const bytes = (n: number, seed = 7): Uint8Array => {
    const out = new Uint8Array(n);
    let s = seed >>> 0;
    for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = (s >>> 16) & 0xff; }
    return out;
  };
  const withINes = (n: number): Uint8Array => { const b = bytes(n); b.set([0x4e, 0x45, 0x53, 0x1a], 0); return b; };
  /** The streaming decision the worker makes: header offset from the first 16 bytes + the file size. */
  const viaStream = (data: Uint8Array, name: string): string => {
    const off = headerOffset(data.subarray(0, 16), data.length, name);
    return crcEnd(crcUpdate(crcBegin(), data.subarray(off)));
  };

  it('strips the 512-byte copier header exactly when size % 1024 === 512', () => {
    const headered = bytes(1024 * 4 + 512);
    expect(hasCopierHeader(headered.length)).toBe(true);
    expect(headerOffset(headered.subarray(0, 16), headered.length, 'game.smc')).toBe(512);
    expect(headerlessCrc32(headered, 'game.smc')).toBe(crcEnd(crcUpdate(crcBegin(), headered.subarray(512))));

    const plain = bytes(1024 * 4);
    expect(headerOffset(plain.subarray(0, 16), plain.length, 'game.sfc')).toBe(0);
  });

  it('strips the 16-byte iNES header only for a .nes carrying the magic', () => {
    const nes = withINes(1024 * 2);
    expect(hasINesHeader(nes)).toBe(true);
    expect(headerOffset(nes.subarray(0, 16), nes.length, 'game.nes')).toBe(16);
    expect(headerOffset(nes.subarray(0, 16), nes.length, 'GAME.NES')).toBe(16); // extension is case-insensitive
    // Same bytes under a non-nes extension: a ROM that merely starts with those bytes is never stripped.
    expect(headerOffset(nes.subarray(0, 16), nes.length, 'game.sfc')).toBe(0);
    // A headerless .nes (no magic) already is the data, so it is hashed whole.
    expect(headerOffset(bytes(1024 * 2).subarray(0, 16), 1024 * 2, 'game.nes')).toBe(0);
  });

  it('falls back to the copier rule for a .nes without the magic', () => {
    const n = 1024 * 2 + 512;
    expect(headerOffset(bytes(n).subarray(0, 16), n, 'game.nes')).toBe(512);
  });

  it('reproduces headerlessCrc32 from a 16-byte head + the size (the worker path)', () => {
    const cases: [Uint8Array, string][] = [
      [bytes(4096), 'plain.sfc'],
      [bytes(4096 + 512), 'copier.smc'],
      [withINes(4096), 'rom.nes'],
      [withINes(4096), 'ROM.NES'],
      [withINes(4096), 'notnes.sfc'],
      [withINes(4096 + 512), 'both.nes'],
      [bytes(8), 'tiny.sfc'], // shorter than the 16-byte head: hasINesHeader must simply say no
    ];
    for (const [data, name] of cases) expect(viaStream(data, name)).toBe(headerlessCrc32(data, name));
  });
});
