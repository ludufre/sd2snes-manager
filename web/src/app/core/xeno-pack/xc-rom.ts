import type { Entry } from '../models';
import { romStem } from '../sd-layout';

/** Where a user usually leaves the dump on the card (the dialog offers it when it is there). */
export const XC_DUMP_CARD_DIR = 'sd2snes';
export const XC_DUMP_CARD_FILE = 'xenocrisis_rp2040.bin';

/**
 * Is this library entry the Xeno Crisis cartridge? Only a hint to preselect the right ROM: the dialog
 * lets the user pick any other file, since a hack or a re-release can carry a different name.
 */
export function looksLikeXenoCrisis(e: Pick<Entry, 'title' | 'file' | 'system'> | null | undefined): boolean {
  if (!e || e.system !== 'SNES') return false;
  return /xeno[\s._-]*crisis/i.test(`${e.title} ${e.file}`);
}

/**
 * The name the pack's files are built on. The firmware looks for `<rom stem>.msu` and
 * `<rom stem>-<n>.pcm` next to the ROM, so the stem is the ROM's file name without its extension,
 * exactly as it is on the card.
 */
export function packStem(romFile: string): string {
  return romStem(romFile);
}

/** Characters a FAT file name cannot hold (plus the path separators the ZIP would turn into folders). */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/;

/** A stem the user typed for the ZIP: trimmed, and only if a card could store it. Returns '' when not. */
export function cleanStem(raw: string): string {
  const s = raw.trim();
  if (!s || ILLEGAL.test(s) || /[. ]$/.test(s) || s.length > 200) return '';
  return s;
}

/** Bytes the finished pack takes on the card (the 26 tracks of the v1.00 dump, measured). */
export const PACK_APPROX_BYTES = 234 * 1024 * 1024;
