import { describe, expect, it } from 'vitest';
import { snesHeaderChecksum } from './snes-header';

function rom(header: number, checksum: number, copier = false): File {
  const bytes = new Uint8Array(Math.max(header + 0x20, 0x10000) + (copier ? 0x200 : 0));
  const offset = header + (copier ? 0x200 : 0);
  bytes.fill(0x20, offset, offset + 21);
  bytes[offset + 0x15] = header === 0x7fc0 ? 0x20 : header === 0xffc0 ? 0x21 : 0x25;
  const complement = checksum ^ 0xffff;
  bytes[offset + 0x1c] = complement & 0xff;
  bytes[offset + 0x1d] = complement >>> 8;
  bytes[offset + 0x1e] = checksum & 0xff;
  bytes[offset + 0x1f] = checksum >>> 8;
  return new File([bytes], 'game.sfc');
}

describe('snesHeaderChecksum', () => {
  it('reads LoROM and HiROM internal checksums as four-digit uppercase hex', async () => {
    expect(await snesHeaderChecksum(rom(0x7fc0, 0x09b7))).toBe('09B7');
    expect(await snesHeaderChecksum(rom(0xffc0, 0xa109))).toBe('A109');
  });

  it('accounts for a 512-byte copier header', async () => {
    expect(await snesHeaderChecksum(rom(0x7fc0, 0x0055, true))).toBe('0055');
  });
});
