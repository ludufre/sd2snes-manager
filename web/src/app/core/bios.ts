/**
 * Chip-BIOS files the sd2snes/FXPak Pro firmware needs for special-chip games
 * (DSP, S-DD1/BS-X, Super Game Boy, ST-010, Sufami Turbo). They can't be distributed (legal),
 * so the user supplies their own, they go in the card's `/sd2snes/` folder.
 *
 * Validation rules taken from the firmware source (sd2snes/_repo):
 *  - SGB files are CRC32-checked by the firmware (src/sgb.c sgb_bios_state), accepted CRCs below.
 *  - DSP/ST-010/BS-X are not CRC-checked by the firmware: it loads them by size and structure
 *    (src/memory.c load_dspx, load_sram_offload). So we accept those if the CRC32 matches a
 *    known-good dump or, failing that, the firmware's size rule still holds. See addBios().
 *  - cx4.bin is not read (logic lives in fpga_cx4.bit) → not listed.
 *
 * Every file carries its known-good CRC32(s): the Manager uses them to auto-identify a dropped
 * file (even if renamed) and to confirm "verified" on manual selection. They are not a hard gate
 * for the size-loaded chips (a same-sized but unknown dump is still accepted, matching the firmware).
 *
 * SGB needs only one version: a complete v1 pair (sgb1_boot + sgb1_snes) or a complete v2 pair
 * (sgb2_boot + sgb2_snes). The "missing BIOS" badge treats that as satisfied (see biosMissing).
 */
export interface BiosFile {
  id: string;
  file: string; // filename written into /sd2snes/
  chip: string; // human label
  crc32: string[]; // known-good CRC32s (uppercase 8-hex), identify on drop; verify on select
  size?: number[]; // accepted exact byte sizes (firmware size rule)
  minSize?: number; // accepted if at least this many bytes (firmware reads fixed offsets)
  sgbPair?: 'v1' | 'v2'; // SGB version this file belongs to (for the either-pair "missing" rule)
}

export const BIOS_DIR = 'sd2snes';

const DSP_SIZE = 8192; // 2048 pgm words ×3 + 1024 dat words ×2

export const BIOS_FILES: BiosFile[] = [
  { id: 'dsp1', file: 'dsp1.bin', chip: 'DSP-1', crc32: ['27124599'], size: [DSP_SIZE] },
  { id: 'dsp1b', file: 'dsp1b.bin', chip: 'DSP-1B', crc32: ['588279B4'], size: [DSP_SIZE] },
  { id: 'dsp2', file: 'dsp2.bin', chip: 'DSP-2', crc32: ['F0221C90'], size: [DSP_SIZE] },
  { id: 'dsp3', file: 'dsp3.bin', chip: 'DSP-3', crc32: ['E3B54E6A'], size: [DSP_SIZE] },
  { id: 'dsp4', file: 'dsp4.bin', chip: 'DSP-4', crc32: ['CA09E176'], size: [DSP_SIZE] },
  // ST-010: firmware needs the file to reach 0xCC00 (52224); real dumps are 52224/53248 bytes.
  { id: 'st0010', file: 'st0010.bin', chip: 'ST-010', crc32: ['8D136190'], minSize: 0xcc00 },
  // BS-X BIOS: 1 MiB, optionally with a 512-byte copier header (firmware auto-skips); headered dump
  // has a different CRC, so it's accepted by size.
  { id: 'bsxbios', file: 'bsxbios.bin', chip: 'BS-X / Satellaview', crc32: ['8ECC1963'], size: [1048576, 1049088] },
  // Sufami Turbo base cartridge: 256 KiB, optionally headered (firmware auto-skips).
  { id: 'stbios', file: 'stbios.bin', chip: 'Sufami Turbo', crc32: ['9B4CA911'], size: [262144, 262656] },
  // Super Game Boy, CRC-validated by the firmware. Boot ROM differs per version; the SNES-side image
  // differs too (v1 ≈ 256 KiB, v2 ≈ 512 KiB). Both original and SameBoy boot builds are accepted.
  { id: 'sgb1boot', file: 'sgb1_boot.bin', chip: 'Super Game Boy v1 (boot)', crc32: ['EC8A83B9', 'EDAC680E'], sgbPair: 'v1' },
  { id: 'sgb1snes', file: 'sgb1_snes.bin', chip: 'Super Game Boy v1 (SNES)', crc32: ['2E353DBB', '27A03C98', '8A4A174F'], sgbPair: 'v1' },
  { id: 'sgb2boot', file: 'sgb2_boot.bin', chip: 'Super Game Boy v2 (boot)', crc32: ['53D0DD63', '73BD96DC'], sgbPair: 'v2' },
  { id: 'sgb2snes', file: 'sgb2_snes.bin', chip: 'Super Game Boy v2 (SNES)', crc32: ['CB176E45'], sgbPair: 'v2' },
];
