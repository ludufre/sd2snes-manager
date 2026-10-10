import { msuFileName, pcmFileName } from './msu-pcm';
import { DUMP_SIZE, TRACK_COUNT } from './xc-streams';

/* Pure rules behind "where do the dump and the pack live on the card". The card work is in xc-place.service.ts. */

const lower = (s: string): string => s.toLowerCase();
const extOf = (n: string): string => (n.lastIndexOf('.') < 0 ? '' : lower(n.slice(n.lastIndexOf('.') + 1)));

/** Name the dump is expected to have, on the card and beside the ROM. */
export const DUMP_FILE_NAME = 'xenocrisis_rp2040.bin';

/**
 * Files of a folder that could be the dump, best first: the file with the dump's own name, then any other
 * `.bin` of exactly the dump's size. Each still has to pass the CRC check (xc-status probeDump).
 */
export function pickDumpCandidates(files: readonly { name: string; size: number }[]): string[] {
  const byName = files.filter((f) => lower(f.name) === DUMP_FILE_NAME).map((f) => f.name);
  const bySize = files.filter((f) => lower(f.name) !== DUMP_FILE_NAME && extOf(f.name) === 'bin' && f.size === DUMP_SIZE).map((f) => f.name);
  return [...byName, ...bySize];
}

/**
 * ROMs in a folder other than the game itself. `isRom` is the Manager's own idea of a ROM (any console it lists):
 * the firmware opens an MSU-1 folder as a game only when it holds exactly one ROM.
 */
export function otherRoms(names: readonly string[], own: string, isRom: (name: string) => boolean): string[] {
  return names.filter((n) => lower(n) !== lower(own) && isRom(n));
}

/**
 * Folder for a game that has to move out of a shared one: its ROM stem, or "stem (2)", "stem (3)"…
 * A name is free when no entry has it, or when the one that has it holds no ROM (a leftover of an earlier try).
 * `existing` = the sub-folders already in the parent, with whether each holds a ROM.
 */
export function pickFolderName(stem: string, existing: readonly { name: string; hasRoms: boolean }[]): string {
  const taken = new Map(existing.map((e) => [lower(e.name), e.hasRoms]));
  for (let i = 1; ; i++) {
    const cand = i === 1 ? stem : `${stem} (${i})`;
    const t = taken.get(lower(cand));
    if (t === undefined || t === false) return cand;
  }
}

/**
 * Files beside the ROM that travel with it: its cover, its MSU-1 pack (an old one included), and the
 * `.ips`/`.bps` patches named after it. Per-game files under /sd2snes/<root>/<BB>/ are keyed by the ROM stem,
 * which does not change when the ROM changes folder, so they stay where they are.
 */
export function companionNames(stem: string, dirNames: readonly string[]): string[] {
  const want = new Set([`${stem}.cov`, msuFileName(stem), ...Array.from({ length: TRACK_COUNT }, (_, i) => pcmFileName(stem, i + 1))].map(lower));
  const s = lower(stem);
  return dirNames.filter((n) => want.has(lower(n)) || (lower(n).startsWith(s) && (extOf(n) === 'ips' || extOf(n) === 'bps')));
}

/** Join a card path ("" = root) and a name. */
export const joinPath = (folder: string, name: string): string => [folder, name].filter(Boolean).join('/');

/**
 * Rewrite the Recent/Favorite lists (`/sd2snes/lastgame.cfg`, `favorites.cfg`) after a ROM moved.
 *
 * The firmware writes entries as `<full path>` or `<full path>\t<patch name>`, ended by NUL (its reader also
 * stops at a newline). Bytes are handled as Latin-1, one byte per character, which keeps every other entry
 * byte-for-byte and matches the card's code page for every name a FAT card can hold. The comparison ignores
 * letter case, like the card does; the patch part after the TAB is kept.
 */
export function rewriteListedPaths(data: Uint8Array, from: string, to: string): { data: Uint8Array; changed: number } {
  if (![...from, ...to].every((c) => c.charCodeAt(0) <= 0xff)) return { data, changed: 0 };
  const f = lower(from);
  let changed = 0;
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    let j = i;
    while (j < data.length && data[j] !== 0 && data[j] !== 10) j++;
    let tab = i;
    while (tab < j && data[tab] !== 9) tab++;
    let path = '';
    for (let k = i; k < tab; k++) path += String.fromCharCode(data[k]);
    if (lower(path) === f) {
      changed++;
      for (let k = 0; k < to.length; k++) out.push(to.charCodeAt(k));
    } else {
      for (let k = i; k < tab; k++) out.push(data[k]);
    }
    for (let k = tab; k < j; k++) out.push(data[k]);
    if (j < data.length) out.push(data[j]);
    i = j + 1;
  }
  return changed ? { data: Uint8Array.from(out), changed } : { data, changed: 0 };
}
