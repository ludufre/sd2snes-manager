import { describe, it, expect } from 'vitest';
import { classifyFwString, normalizeFork, fwUsesBuckets, layoutForFw, hasFirmwareFiles, FIRMWARE_FILES, type FwVersion } from './fw-version';

describe('classifyFwString', () => {
  it('parses a release build', () => {
    const v = classifyFwString('1.11.2-br-2.15b3');
    expect(v).toEqual({ kind: 'release', raw: '1.11.2-br-2.15b3', base: '1.11.2', fork: '2.15b3' });
  });

  it('recognises a snapshot build as a snapshot, not as garbage', () => {
    // Version.mk stamps `date +%Y%m%d%H%M%S` when version='*' -- verified against a real
    // snapshot image, which reads "fw ver.: 20260718231602". Misclassifying this as a release
    // (or as unknown-but-warn) would nag every developer build.
    expect(classifyFwString('20260718231602').kind).toBe('snapshot');
    expect(classifyFwString('SNAPSHOT').kind).toBe('snapshot');
  });

  it('falls back to unknown for anything it does not recognise', () => {
    expect(classifyFwString('').kind).toBe('unknown');
    expect(classifyFwString('some other build').kind).toBe('unknown');
  });
});

describe('normalizeFork — the beta trap', () => {
  it('drops the beta suffix rather than making it a semver prerelease', () => {
    // "2.15.0-b3" would sort below "2.15.0", so a 2.15 beta would be told its card is fine.
    expect(normalizeFork('2.15b3')).toBe('2.15.0');
    expect(normalizeFork('2.15')).toBe('2.15.0');
    expect(normalizeFork('2.15.1')).toBe('2.15.1');
    expect(normalizeFork('2.16b1')).toBe('2.16.0');
  });

  it('never throws on junk', () => {
    expect(normalizeFork('')).toBe('0.0.0');
    expect(normalizeFork('weird')).toBe('0.0.0');
  });
});

describe('fwUsesBuckets', () => {
  const rel = (fork: string): FwVersion => ({ kind: 'release', raw: `1.11.2-br-${fork}`, base: '1.11.2', fork });

  it('a 2.15 BETA counts as 2.15 — this is the version that ships today', () => {
    expect(fwUsesBuckets(rel('2.15b3'))).toBe(true);
  });

  it('accepts 2.15 and later, rejects earlier', () => {
    expect(fwUsesBuckets(rel('2.15'))).toBe(true);
    expect(fwUsesBuckets(rel('2.16'))).toBe(true);
    expect(fwUsesBuckets(rel('3.0'))).toBe(true);
    expect(fwUsesBuckets(rel('2.14'))).toBe(false);
    expect(fwUsesBuckets(rel('2.9'))).toBe(false);   // 2.9 < 2.15 numerically, not lexically
  });

  it('never claims buckets for a build it could not identify', () => {
    // A false "your saves are gone" on a dev build is worse than a missed nag.
    expect(fwUsesBuckets({ kind: 'snapshot', raw: '20260718231602' })).toBe(false);
    expect(fwUsesBuckets({ kind: 'absent' })).toBe(false);
    expect(fwUsesBuckets({ kind: 'unknown' })).toBe(false);
  });
});

describe('layoutForFw', () => {
  const rel = (fork: string): FwVersion => ({ kind: 'release', raw: `1.11.2-br-${fork}`, base: '1.11.2', fork });

  it('a release decides on its own, whatever the card looks like today', () => {
    // Mid-migration a 2.15 card still looks legacy; new writes must go to the new layout anyway.
    expect(layoutForFw(rel('2.15b3'), 'legacy')).toBe('buckets');
    expect(layoutForFw(rel('2.14'), 'buckets')).toBe('legacy');
  });

  it('an unidentified firmware follows the card', () => {
    expect(layoutForFw({ kind: 'absent' }, 'buckets')).toBe('buckets');
    expect(layoutForFw({ kind: 'unknown' }, 'legacy')).toBe('legacy');
    expect(layoutForFw({ kind: 'snapshot', raw: 'SNAPSHOT' }, 'legacy')).toBe('legacy');
  });

  it('with NO evidence at all, only a dev build gets the benefit of the doubt', () => {
    // The original sd2snes card carries firmware.img/menu.bin, which reads as 'absent' here. Writing
    // buckets there put covers and saves where a 2.14 console never looks -- silently.
    expect(layoutForFw({ kind: 'absent' }, null)).toBe('legacy');
    expect(layoutForFw({ kind: 'unknown' }, null)).toBe('legacy');
    // A snapshot is a build of this fork, which is past 2.15. Legacy would regress dev cards.
    expect(layoutForFw({ kind: 'snapshot', raw: '20260718231602' }, null)).toBe('buckets');
  });

  it("the user's answer beats what the card looks like, and the default", () => {
    // The card shows what it has; the user knows what they are about to run. A card still in the
    // old layout whose owner says "this runs 2.15" must get the new layout from the next write on.
    expect(layoutForFw({ kind: 'absent' }, 'legacy', 'buckets')).toBe('buckets');
    expect(layoutForFw({ kind: 'snapshot', raw: 'SNAPSHOT' }, 'buckets', 'legacy')).toBe('legacy');
    expect(layoutForFw({ kind: 'unknown' }, null, 'buckets')).toBe('buckets');
  });

  it('but a version read off the card beats even the answer — it is the one thing that is not a guess', () => {
    expect(layoutForFw(rel('2.14'), null, 'buckets')).toBe('legacy');
    expect(layoutForFw(rel('2.15'), null, 'legacy')).toBe('buckets');
  });
});

describe('hasFirmwareFiles', () => {
  /** Minimal stand-in for the File System Access handles this only ever reads from. */
  const dirOf = (files: string[]) =>
    ({
      getFileHandle: (name: string) =>
        files.includes(name) ? Promise.resolve({} as FileSystemFileHandle) : Promise.reject(new Error('NotFound')),
    }) as unknown as FileSystemDirectoryHandle;

  const getDirByPath = (sd: FileSystemDirectoryHandle | null) =>
    (_root: FileSystemDirectoryHandle, path: string) => Promise.resolve(path === 'sd2snes' ? sd : null);

  const root = {} as FileSystemDirectoryHandle;

  it('is false when there is no sd2snes folder at all — a plain ROM folder', async () => {
    expect(await hasFirmwareFiles(root, getDirByPath(null))).toBe(false);
  });

  it('is false for an sd2snes folder that holds no firmware image', async () => {
    // saves/cheats/info can all be there; without an image the console still will not boot.
    expect(await hasFirmwareFiles(root, getDirByPath(dirOf(['config.yml'])))).toBe(false);
  });

  it('accepts EITHER fork, from any single one of its images', async () => {
    // The original sd2snes ships firmware.img + menu.bin, which readFwVersion cannot parse --
    // that card must still count as a card, or every one of them gets nagged.
    for (const name of FIRMWARE_FILES) {
      expect(await hasFirmwareFiles(root, getDirByPath(dirOf([name])))).toBe(true);
    }
  });
});

/**
 * The original sd2snes/FXPak firmware. It stamps the very same `fw ver.:` marker, just without the
 * `-br-` fork part, so it used to fall through to 'unknown' and the card was labelled "fw ?" even
 * though its version was sitting right there in the image.
 */
describe('classifyFwString — the official firmware', () => {
  it('names it, with its version', () => {
    expect(classifyFwString('1.11.2')).toEqual({ kind: 'official', raw: '1.11.2', base: '1.11.2' });
    expect(classifyFwString(' 1.11.2 ')).toEqual({ kind: 'official', raw: '1.11.2', base: '1.11.2' });
    expect(classifyFwString('1.11')).toEqual({ kind: 'official', raw: '1.11', base: '1.11' });
  });

  it('never swallows a FORK release that merely starts the same way', () => {
    // The fork's own string begins with the upstream base it is built on, so order matters here.
    const v = classifyFwString('1.11.2-br-2.15b7');
    expect(v.kind).toBe('release');
    expect(v).toMatchObject({ base: '1.11.2', fork: '2.15b7' });
  });

  it('never swallows a development build', () => {
    expect(classifyFwString('20260807204804').kind).toBe('snapshot');
  });

  it('stays unknown for anything that is not a bare version', () => {
    expect(classifyFwString('1.11.2-rc1').kind).toBe('unknown');
    expect(classifyFwString('v1.11.2').kind).toBe('unknown');
    expect(classifyFwString('').kind).toBe('unknown');
  });

  it('does NOT claim the bucket layout — that is a fork feature, and writing it would hide every file', () => {
    expect(fwUsesBuckets(classifyFwString('1.11.2'))).toBe(false);
  });

  it('leaves the layout decision to the user, exactly as before', () => {
    // Positively identified, but it proves what is on the card, not what will run: this fork is
    // routinely flashed over USB with the stock image left in place. So the user's answer still wins,
    // and a card already organized in buckets keeps being organized.
    const off = classifyFwString('1.11.2');
    expect(layoutForFw(off, null, 'buckets')).toBe('buckets'); // the user said 2.15+
    expect(layoutForFw(off, 'buckets', null)).toBe('buckets'); // the card is already organized
    expect(layoutForFw(off, null, null)).toBe('legacy');       // nobody knows → the safe layout
  });
});
