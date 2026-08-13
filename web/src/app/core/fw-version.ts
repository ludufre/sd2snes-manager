/**
 * Reading the firmware version off the card.
 *
 * The Manager has no device link, it only ever sees a mounted SD card through the File System
 * Access API. So "which firmware will read this card?" has to come from the card itself, and the
 * only honest source is the firmware image the bootloader will actually flash: the release build
 * of /sd2snes/firmware.im3 carries its version as plain text ("fw ver.: 1.11.2-br-2.15b3",
 * emitted by src/main.c). That works no matter how the firmware got there, installed by this
 * Manager, flashed over USB, or copied by hand.
 *
 * Why it matters: firmware 2.15+ reads the two-letter bucket layout and only that layout. On a
 * card still in the old flat/one-letter layout it finds nothing, saves, cheats, covers and
 * manuals all read as absent. Nothing is destroyed (the old files simply sit at paths the device
 * no longer looks at), but to the user it looks exactly like data loss. Detecting the version is
 * what lets us say so before they panic.
 */
import { compareVersions } from 'compare-versions';
import type { LayoutMode } from './sd-layout';

/** The fork version at which the card layout changed. */
export const BUCKET_LAYOUT_FW = '2.15.0';

/**
 * The files that prove /sd2snes/ is a real firmware folder and not just a directory with that name.
 *
 * Deliberately wider than what `readFwVersion` can parse: `firmware.im3` + `m3nu.bin` are this fork,
 * `firmware.img` + `menu.bin` are the original sd2snes, `firmware.stm` is the STM32 image. Any one
 * of them means the user picked a card, even when the version stays unreadable.
 */
export const FIRMWARE_FILES = ['firmware.im3', 'firmware.img', 'firmware.stm', 'm3nu.bin', 'menu.bin'] as const;

/**
 * Does this folder look like an sd2snes/FXPak card at all?
 *
 * Cheap enough to await before the scan: one directory lookup plus at most five direct file
 * lookups, no listing. Used to ask "are you sure?" before anything is mounted -- pointing the
 * Manager at a plain ROM folder is silent otherwise, and only shows up later as a console that
 * finds nothing.
 */
export async function hasFirmwareFiles(
  root: FileSystemDirectoryHandle,
  getDirByPath: (root: FileSystemDirectoryHandle, path: string) => Promise<FileSystemDirectoryHandle | null>,
): Promise<boolean> {
  try {
    const dir = await getDirByPath(root, 'sd2snes');
    if (!dir) return false;
    for (const name of FIRMWARE_FILES) {
      if (await dir.getFileHandle(name).then(() => true, () => false)) return true;
    }
    return false;
  } catch {
    return false; // unreadable -> treat as "cannot prove it is a card", the caller asks the user
  }
}

export type FwVersion =
  /** not probed yet, or demo mode, say nothing */
  | { kind: 'unknown' }
  /** no /sd2snes/firmware.im3 on the card */
  | { kind: 'absent' }
  /** a development build: version.mk stamps a 14-digit timestamp (or "SNAPSHOT"), which carries
   *  no fork version, so it cannot be compared. Never warn on these. */
  | { kind: 'snapshot'; raw: string }
  /** a release: raw "1.11.2-br-2.15b3", base "1.11.2", fork "2.15b3" */
  | { kind: 'release'; raw: string; base: string; fork: string }
  /** the original sd2snes/FXPak firmware: the same marker with no `-br-` fork part ("1.11.2"). Not
   *  this project's build, so it has no fork version to compare, but it is perfectly identified, and
   *  saying "official 1.11.2" beats the "fw ?" it used to show. */
  | { kind: 'official'; raw: string; base: string };

/** The plain-text marker src/main.c prints into the image. */
const MARKER = /fw ver\.:\s*([^\r\n\x00]{1,64})/;
const RELEASE = /^(\d+\.\d+\.\d+)-br-(\d+\.\d+(?:\.\d+)?[a-z0-9]*)$/i;
const SNAPSHOT = /^(\d{14}|SNAPSHOT)$/i;
/** Upstream stamps a bare version and nothing else. Checked after the fork's, which starts the same
 *  way, so `1.11.2-br-2.15b7` can never be mistaken for official `1.11.2`. */
const OFFICIAL = /^(\d+\.\d+(?:\.\d+)?)$/;

/** Classify the raw version string found in the image. */
export function classifyFwString(raw: string): FwVersion {
  const t = raw.trim();
  const rel = RELEASE.exec(t);
  if (rel) return { kind: 'release', raw: t, base: rel[1], fork: rel[2] };
  if (SNAPSHOT.test(t)) return { kind: 'snapshot', raw: t };
  const off = OFFICIAL.exec(t);
  if (off) return { kind: 'official', raw: t, base: off[1] };
  return { kind: 'unknown' };
}

/**
 * The fork version as something `compare-versions` will accept.
 *
 * "2.15b3" is not valid semver, the library rejects "15b3" as a minor and throws. Mapping it to
 * a prerelease ("2.15.0-b3") would be worse than throwing: prereleases sort below the release, so
 * 2.15b3 would compare as < 2.15.0 and a beta of 2.15 (exactly what ships today) would be told
 * its card needs no migration. Drop the suffix instead: a beta of 2.15 is 2.15 for layout purposes.
 */
export function normalizeFork(fork: string): string {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(fork);
  return m ? `${m[1]}.${m[2]}.${m[3] ?? 0}` : '0.0.0';
}

/** Does this firmware read the two-letter bucket layout? Only ever true for a positively
 *  identified release. Snapshot/absent/unknown must not trigger a "your card is broken" warning. */
export function fwUsesBuckets(v: FwVersion): boolean {
  return v.kind === 'release' && compareVersions(normalizeFork(v.fork), BUCKET_LAYOUT_FW) >= 0;
}

/**
 * Which layout to write, in order of how much the evidence is worth.
 *
 *   1. a release version read off the card. The only thing that is not a guess;
 *   2. `assumed`: the user answered "is this card's firmware 2.15 or newer?" when the version could
 *      not be read. An answer beats an observation: the card shows what it has, the user knows what
 *      they are going to run;
 *   3. `observed`: what the card already uses. An organized card keeps being organized, a legacy one
 *      stays readable. An 'official' image does not short-circuit here even though it is positively
 *      identified, because it proves what is on the card, not what the console will run (this fork is
 *      routinely flashed over USB, leaving the stock image in place), and a card already organized in
 *      buckets must not start scattering new files into the old layout. It still lands on 'legacy'
 *      below when nobody knows better, just not over the user's answer;
 *   4. nothing at all. A snapshot is a development build of this fork, so it reads buckets.
 *      'absent'/'unknown' covers the original sd2snes card (firmware.img + menu.bin, which the parser
 *      above cannot read), where assuming buckets would write covers and saves into two-letter folders
 *      a 2.14 console never opens. Legacy is the safer wrong answer: the files land in the old layout
 *      and the migration dialog offers to move them, which is recoverable and visible.
 *
 * (4) is only reached when nobody could be asked, such as a reload-resume of an unanswered card.
 */
export function layoutForFw(fw: FwVersion, observed: LayoutMode | null, assumed: LayoutMode | null = null): LayoutMode {
  if (fw.kind === 'release') return fwUsesBuckets(fw) ? 'buckets' : 'legacy';
  if (assumed) return assumed;
  if (observed) return observed;
  return fw.kind === 'snapshot' ? 'buckets' : 'legacy';
}

/**
 * The images to read a version out of, in order of authority.
 *
 * `firmware.im3` first because it is what this fork's bootloader flashes: on a card that carries
 * both, the `.im3` is the one that will run. `firmware.img` is the original sd2snes image. A card
 * with only that is an official install, and reading it is the difference between naming the
 * firmware and shrugging "fw ?" at the user. `firmware.stm` is the STM32 image, same marker.
 */
const VERSION_IMAGES = ['firmware.im3', 'firmware.img', 'firmware.stm'] as const;

/**
 * Read and classify the firmware image on the card.
 *
 * The whole file (~180 KB) is read rather than scanned in chunks: the marker sits ~60% in, and a
 * chunked scan could split it across a boundary for no meaningful saving next to the ROM tree
 * scan the Manager already does on connect.
 *
 * Decoded as latin1, never utf-8. This is a binary, and utf-8 would mangle bytes around the
 * marker (and can drop the match entirely).
 *
 * An image that exists but carries no readable marker does not end the search: a truncated or
 * third-party `.im3` beside a perfectly good official `.img` should still be named. Only when no
 * image at all is present is the answer 'absent'.
 */
export async function readFwVersion(
  root: FileSystemDirectoryHandle,
  getDirByPath: (root: FileSystemDirectoryHandle, path: string) => Promise<FileSystemDirectoryHandle | null>,
): Promise<FwVersion> {
  try {
    const dir = await getDirByPath(root, 'sd2snes');
    if (!dir) return { kind: 'absent' };
    let sawImage = false;
    for (const name of VERSION_IMAGES) {
      const fh = await dir.getFileHandle(name).catch(() => null);
      if (!fh) continue;
      sawImage = true;
      const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
      const m = MARKER.exec(new TextDecoder('latin1').decode(buf));
      if (!m) continue;
      const v = classifyFwString(m[1]);
      if (v.kind !== 'unknown') return v;
    }
    return sawImage ? { kind: 'unknown' } : { kind: 'absent' };
  } catch {
    return { kind: 'unknown' };
  }
}
