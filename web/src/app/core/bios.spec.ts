import { describe, it, expect } from 'vitest';
import { BIOS_FILES } from './bios';

/** The table is what the chip BIOS dialog lists and what a dropped file is matched against, so a
 *  duplicated id or filename would make two rows fight over one file on the card. */
describe('BIOS_FILES', () => {
  it('has unique ids and unique filenames', () => {
    expect(new Set(BIOS_FILES.map((b) => b.id)).size).toBe(BIOS_FILES.length);
    expect(new Set(BIOS_FILES.map((b) => b.file.toLowerCase())).size).toBe(BIOS_FILES.length);
  });

  it('carries well-formed CRC32s and a size rule or a CRC for every file', () => {
    for (const b of BIOS_FILES) {
      for (const c of b.crc32) expect(c, b.file).toMatch(/^[0-9A-F]{8}$/);
      expect(b.crc32.length > 0 || !!b.size?.length || b.minSize != null, b.file).toBe(true);
    }
  });

  it('lists the Seta chip files under the names firmware 2.17 loads', () => {
    const st011 = BIOS_FILES.find((b) => b.id === 'st011');
    const st018 = BIOS_FILES.find((b) => b.id === 'st018');
    expect(st011?.file).toBe('st011.rom');
    expect(st011?.minSize).toBe(16384 * 3 + 2048 * 2);
    expect(st018?.file).toBe('st018.rom');
    expect(st018?.size).toEqual([0x28000]);
    // ST-010 keeps its own, older name: the two uPD96050 chips are different files
    expect(BIOS_FILES.find((b) => b.id === 'st0010')?.file).toBe('st0010.bin');
  });

  it('does not let a size alone pick the wrong slot', () => {
    // addBiosAuto falls back to "the only slot with this exact size": 163840 must name ST-018 only
    expect(BIOS_FILES.filter((b) => b.size?.includes(0x28000)).map((b) => b.id)).toEqual(['st018']);
  });
});
