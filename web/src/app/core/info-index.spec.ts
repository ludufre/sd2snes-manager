/**
 * The status probe stopped asking the card whether each sidecar exists and now looks the answer up
 * in two indexes built by one enumeration each (/sd2snes/info, plus the covers the ROM walk sees on
 * its way past). That only holds if the index keys a file exactly where the probe looks for it,
 * which is what these tests pin, by deriving both sides from the very functions the rest of the app
 * (and the migration planner) uses: bucketKeyForFile / assetIndexKey / guideFileName.
 *
 * Get this wrong and nothing throws: every badge simply reads 'none' on a full card.
 */
import { describe, expect, it } from 'vitest';
import { indexInfoRoot, infoFileKind, infoIndexKey, infoSidecarsFor, type InfoSidecars } from './library-store';
import { assetKeyOf, bucketKeyForFile, isGbRom } from './sd-layout';
import { guideFileName, GUIDE_SLOTS } from '../lib/man.js';
import { covKey, scanTree } from '../lib/scan.js';

/** The index's own key for a file found under /sd2snes/info. The one line indexInfoRoot runs. */
const keyOfSidecar = (name: string, sgb: boolean): string => infoIndexKey({ stem: bucketKeyForFile(name), sgb });
/** The key probeOnCard looks that game up under. */
const keyOfRom = (rom: string): string => infoIndexKey(assetKeyOf(rom, 'buckets'));

describe('infoFileKind — the extension rule of the /sd2snes/info index', () => {
  it('classifies every sidecar the probe reports a badge for', () => {
    expect(infoFileKind('Super Mario World (USA).gcv')?.kind).toBe('gcv');
    expect(infoFileKind('Super Mario World (USA).fmv')?.kind).toBe('fmv');
    expect(infoFileKind('Super Mario World (USA).yml')?.kind).toBe('yml');
    expect(infoFileKind('Super Mario World (USA).gss')?.kind).toBe('gss');
    expect(infoFileKind('Super Mario World (USA).gd')?.kind).toBe('gd');
  });

  it('ignores everything else in the directory (.pcm rides along with the .fmv, and has no badge)', () => {
    expect(infoFileKind('Super Mario World (USA).pcm')).toBeNull();
    expect(infoFileKind('Super Mario World (USA)')).toBeNull();
    expect(infoFileKind('notes.txt')).toBeNull();
  });

  it('matches case-insensitively, as the fileExists it replaces did on FAT', () => {
    expect(infoFileKind('Tetris.GCV')?.kind).toBe('gcv');
    expect(infoFileKind('Tetris.MAN')).toEqual({ kind: 'man', slot: 0 });
  });

  it('reads the guide SLOT back out of every name guideFileName writes', () => {
    for (const nn of GUIDE_SLOTS as number[]) {
      expect(infoFileKind(guideFileName('Chrono Trigger (USA)', nn))).toEqual({ kind: 'man', slot: nn });
    }
  });

  it('rejects two-digit groups that are not addressable slots — counting them would inflate the badge', () => {
    // slot 1 does not exist (0 is the official manual, users get 2..8) and 9+ is past MAX_GUIDES.
    expect(infoFileKind('Chrono Trigger (USA).01.man')).toBeNull();
    expect(infoFileKind('Chrono Trigger (USA).99.man')).toBeNull();
  });
});

describe('info index keys land where probeOnCard looks', () => {
  const roms = ['Super Mario World (USA).sfc', 'A.sfc', '1.smc', '-Dash.sfc', 'Tetris.gb', 'Tetris.sgb'];

  it('every sidecar of a ROM keys to that ROM', () => {
    for (const rom of roms) {
      const stem = rom.slice(0, rom.lastIndexOf('.'));
      const sgb = isGbRom(rom);
      for (const ext of ['.gcv', '.fmv', '.yml', '.gss', '.gd']) {
        expect(keyOfSidecar(stem + ext, sgb)).toBe(keyOfRom(rom));
      }
      for (const nn of GUIDE_SLOTS as number[]) {
        expect(keyOfSidecar(guideFileName(stem, nn), sgb)).toBe(keyOfRom(rom));
      }
    }
  });

  it('keeps the Game Boy namespace separate — Tetris.gb and Tetris.sfc are different games', () => {
    expect(keyOfRom('Tetris.gb')).not.toBe(keyOfRom('Tetris.sfc'));
    // ".sgb" is not Game Boy (see isGbRom): the firmware loads it as a plain SNES ROM.
    expect(keyOfRom('Tetris.sgb')).toBe(keyOfRom('Tetris.sfc'));
  });

  it('folds case, so a sidecar written in another case still finds its ROM', () => {
    expect(keyOfSidecar('SUPER MARIO WORLD (USA).gcv', false)).toBe(keyOfRom('Super Mario World (USA).sfc'));
  });
});

/* ---- a card just real enough to walk ---- */

interface FakeEntry { kind: 'file' | 'directory' }
class FakeDir implements FakeEntry {
  readonly kind = 'directory' as const;
  constructor(readonly name: string, private readonly children: Record<string, FakeEntry>) {}
  async *entries(): AsyncGenerator<[string, FakeEntry]> {
    for (const [n, c] of Object.entries(this.children)) yield [n, c];
  }
  async getDirectoryHandle(name: string): Promise<FakeDir> {
    const c = this.children[name];
    if (!c || c.kind !== 'directory') throw new Error('NotFoundError');
    return c as FakeDir;
  }
}
const file = (): FakeEntry => ({ kind: 'file' });
const card = (info: Record<string, FakeEntry>): FileSystemDirectoryHandle =>
  new FakeDir('card', { sd2snes: new FakeDir('sd2snes', { info: new FakeDir('info', info) }) }) as unknown as FileSystemDirectoryHandle;

/* ---- the traversal: which file the walk attributes to which game ---- */

describe('indexInfoRoot — every shape /sd2snes/info can be in', () => {
  /** One card carrying all four accepted layouts at once, which is what a half-migrated card is. */
  const mixed = card({
    'Flat Legacy.yml': file(),                                          // <root>/<file>
    D: new FakeDir('D', {                                               // legacy one-char bucket
      'Dr. Mario (USA).yml': file(),                                    // ...and a stem with dots in it
      'Dr. Mario (USA).man': file(),
    }),
    SU: new FakeDir('SU', { 'Super Mario World (USA).gcv': file() }),   // current two-char bucket
    sgb: new FakeDir('sgb', {                                           // the Game Boy namespace
      TE: new FakeDir('TE', { 'Tetris.yml': file(), 'Tetris.03.man': file() }),
    }),
    _ambiguous: new FakeDir('_ambiguous', { 'Tetris.gcv': file() }),    // quarantine, unreadable by the firmware
    'My Notes': new FakeDir('My Notes', { 'Super Mario World (USA).gss': file() }), // a user folder: never followed
  });

  it('indexes a flat legacy file, both bucket widths and the sgb/ namespace', async () => {
    const idx = await indexInfoRoot(mixed);
    expect(idx.get('flat legacy')?.yml).toBe(true);
    expect(idx.get('dr. mario (usa)')?.yml).toBe(true);
    expect(idx.get('super mario world (usa)')?.gcv).toBe(true);
    expect(idx.get('sgb/tetris')?.yml).toBe(true);
  });

  it('keeps a dotted stem whole — "Dr. Mario (USA).man" is that game\'s slot 0, not a game called "Dr"', async () => {
    const idx = await indexInfoRoot(mixed);
    expect(idx.get('dr. mario (usa)')?.man).toEqual(new Set([0]));
    expect(idx.get('sgb/tetris')?.man).toEqual(new Set([3]));
  });

  it('IGNORES _ambiguous/ — a quarantined sidecar must not light the homonymous game\'s badge', async () => {
    const idx = await indexInfoRoot(mixed);
    // 'Tetris.gcv' sits in quarantine; the SNES `Tetris.sfc` must not inherit it.
    expect(infoSidecarsFor(idx, assetKeyOf('Tetris.sfc', 'buckets'))).toBeNull();
    expect(idx.get('tetris')).toBeUndefined();
  });

  it('never descends into a user folder under the root', async () => {
    const idx = await indexInfoRoot(mixed);
    expect(idx.get('super mario world (usa)')?.gss).toBe(false);
  });

  it('finds the game the probe asks about, ROM extension in any case', async () => {
    const idx = await indexInfoRoot(mixed);
    expect(infoSidecarsFor(idx, assetKeyOf('Dr. Mario (USA).SFC', 'buckets'))?.yml).toBe(true);
    expect(infoSidecarsFor(idx, assetKeyOf('Tetris.GB', 'buckets'))?.yml).toBe(true);
  });
});

describe('infoSidecarsFor — the legacy layout has no sgb/ segment', () => {
  // Pre-2.15 a Game Boy game's ficha sits in the same un-namespaced bucket as a SNES one, because
  // bucketDirFor('legacy') never emits `sgb/`. Keyed strictly, `Tetris.gb` would never find it.
  const legacyCard = card({ T: new FakeDir('T', { 'Tetris.yml': file(), 'Tetris.gcv': file() }) });

  it('a Game Boy game on a legacy card finds its un-namespaced sidecars', async () => {
    const idx = await indexInfoRoot(legacyCard);
    expect(infoSidecarsFor(idx, assetKeyOf('Tetris.gb', 'legacy'))?.yml).toBe(true);
    expect(infoSidecarsFor(idx, assetKeyOf('Tetris.GB', 'legacy'))?.gcv).toBe(true);
  });

  it('the fallback is scoped to legacy — a bucketed card keeps the two namespaces apart', async () => {
    const idx = await indexInfoRoot(legacyCard);
    expect(infoSidecarsFor(idx, assetKeyOf('Tetris.gb', 'buckets'))).toBeNull();
    expect(infoSidecarsFor(idx, assetKeyOf('Tetris.sfc', 'buckets'))?.yml).toBe(true);
  });

  it('merges both namespaces on a half-migrated legacy card', async () => {
    const half = card({
      T: new FakeDir('T', { 'Tetris.yml': file() }),                                  // not moved yet
      sgb: new FakeDir('sgb', { TE: new FakeDir('TE', { 'Tetris.gcv': file() }) }),   // already moved
    });
    const si = infoSidecarsFor(await indexInfoRoot(half), assetKeyOf('Tetris.gb', 'legacy')) as InfoSidecars;
    expect(si.yml).toBe(true);
    expect(si.gcv).toBe(true);
  });
});

/* ---- covStems: the .cov index the ROM walk fills for free ---- */

describe('scanTree covStems', () => {
  it('collects every .cov under its ROM folder, keyed exactly as probeOnCard asks', async () => {
    const root = new FakeDir('card', {
      'Root Game.sfc': file(),
      'Root Game.cov': file(),
      SNES: new FakeDir('SNES', {
        'Chrono Trigger (USA).sfc': file(),
        'CHRONO TRIGGER (USA).COV': file(), // FAT is case-insensitive; the old fileExists matched this
        'No Cover.sfc': file(),
      }),
      sd2snes: new FakeDir('sd2snes', { 'firmware.im3': file() }), // never walked
    });

    const tree = await scanTree(root as unknown as FileSystemDirectoryHandle);
    expect(tree.covStems).toEqual(new Set([covKey('', 'Root Game'), covKey('SNES', 'Chrono Trigger (USA)')]));

    // ...and that is the lookup the probe does, from the entry's own folder + stem.
    for (const rom of tree.roms as { folder: string; name: string }[]) {
      const stem = rom.name.slice(0, rom.name.lastIndexOf('.'));
      expect(tree.covStems.has(covKey(rom.folder, stem))).toBe(rom.name !== 'No Cover.sfc');
    }
  });
});
