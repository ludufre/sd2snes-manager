// Explicit vitest imports rather than globals: `ng test` currently cannot compile the app (the
// test tsconfig lacks allowJs, so every `lib/*.js` import fails TS7016. Pre-existing). This spec
// is pure and has no Angular dependency, so it stays runnable on its own with
//   npx vitest run src/app/core/sd-layout.spec.ts
import { describe, it, expect } from 'vitest';
import {
  bucketOf, bucketKeyForFile, bucketDirForFile, isJunkFile, isJunkDir,
  INFO_ROOT, STATES_ROOT, SAVES_ROOT, CHEATS_ROOT,
  isGbRom, assetKeyOf, assetIndexKey, classifyRootChild, gbKey, snesKey,
  infoDirFor, cheatsDirFor, savesDirFor, statesDirFor,
  patchExtOf, patchBelongsToRom, patchShadowsRom, patchRenameFor,
} from './sd-layout';

/**
 * The same case table that pins the firmware side in
 * sd2snes-next/_repo/tests/host/run_bucket.sh (bucket_cli.c).
 *
 * These two lists must stay identical. The Manager creates these directories and the firmware
 * Reads them; a divergence means the device looks somewhere we never wrote and the user's saves,
 * cheats and covers appear to vanish. If you change one, change the other in the same commit.
 */
const CASES: Array<[string, string]> = [
  ['Super Mario World (USA).sfc', 'SU'],
  ['super mario world.sfc', 'SU'],
  ['sUpEr.sfc', 'SU'],
  ['A.sfc', 'A_'],   // one-char stem: the '.' lands at index 1 -> '_'
  ['A', 'A_'],
  ['AB', 'AB'],
  ['', '__'],
  ['2020 Super Baseball (Japan).sfc', '20'],
  ['96 Zenkoku.sfc', '96'],
  [' Leading space.sfc', '_L'],
  ['-Dash.sfc', '_D'],
  ['._Super Mario World.yml', '__'],
  ['.DS_Store', '_D'],
  ["'Tis a name.sfc", '_T'],
  ['[BIOS] Thing.sfc', '_B'],
  ['(Proto) Thing.sfc', '_P'],
  ['Ys III.sfc', 'YS'],
  ['F-Zero (USA).sfc', 'F_'],   // '-' at index 1 -> '_', not 'fz'. The rule never looks past a char.
  ['Pokemon.sfc', 'PO'],
  ['Super Mario World (USA)01.state', 'SU'],
  ['Super Mario World (USA).02.man', 'SU'],
  ['Super Mario World (USA).03.srm', 'SU'],
  ['1.sfc', '1_'],
  ['__weird__.sfc', '__'],
  // the bucket rule is namespace-agnostic: a GB ROM buckets exactly like any other, it just does
  // so inside sgb/. No new rows needed in run_bucket.sh for the bucket itself.
  ['Tetris.gb', 'TE'],
];

describe('sd-layout bucket rule', () => {
  for (const [input, want] of CASES) {
    it(`bucketOf(${JSON.stringify(input)}) === ${want}`, () => {
      expect(bucketOf(input)).toBe(want);
    });
  }

  it('is always exactly two characters', () => {
    for (const [input] of CASES) expect(bucketOf(input).length).toBe(2);
  });

  it('collapses non-ASCII the same way the firmware does (no Unicode case mapping)', () => {
    expect(bucketOf('Ácido.sfc')).toBe('_C');
    expect(bucketOf('日本語.sfc')).toBe('__');
  });
});

describe('bucketKeyForFile — the sidecar-vs-ROM stem trap', () => {
  it('strips savestate slot digits, which are part of the NAME not the extension', () => {
    expect(bucketKeyForFile('Super Mario World (USA)01.state')).toBe('Super Mario World (USA)');
    // the case that breaks a naive romStem(): ROM "A.sfc" -> "A_", so its state must too
    expect(bucketKeyForFile('A01.state')).toBe('A');
    expect(bucketDirForFile(STATES_ROOT, 'A01.state', false)).toBe(`${STATES_ROOT}/A_`);
  });

  it('strips extra guide and SRM slot numbers', () => {
    expect(bucketKeyForFile('Super Mario World (USA).02.man')).toBe('Super Mario World (USA)');
    expect(bucketKeyForFile('Super Mario World (USA).03.srm')).toBe('Super Mario World (USA)');
  });

  it('otherwise just drops the extension', () => {
    expect(bucketKeyForFile('Super Mario World (USA).yml')).toBe('Super Mario World (USA)');
    expect(bucketDirForFile(INFO_ROOT, 'Super Mario World (USA).gcv', false)).toBe(`${INFO_ROOT}/SU`);
  });

  it('puts every sidecar of one ROM in the SAME bucket', () => {
    const files = ['Foo.yml', 'Foo.gcv', 'Foo.gss', 'Foo.fmv', 'Foo.pcm', 'Foo.man', 'Foo.02.man'];
    const dirs = new Set(files.map((f) => bucketDirForFile(INFO_ROOT, f, false)));
    expect(dirs.size).toBe(1);
  });
});

/**
 * The Game Boy namespace. The predicate mirrors _repo/src/sgb.c:66-71 exactly. It is the only
 * GB detection the firmware has, and this is the pinning table for it.
 */
describe('isGbRom — the .sgb trap', () => {
  const CASES: Array<[string, boolean]> = [
    ['Tetris.gb', true],
    ['Tetris.GB', true],
    ['Tetris.gbc', true],
    ['Tetris.GBC', true],
    // ⚠️ the trap, kept adjacent so it cannot be read past. ".sgb" starts with 's', so sgb.c's
    // `tolower(ext[1]) != 'g'` rejects it and the firmware loads it as a plain SNES ROM, even
    // though lib/scan.js maps the extension to the system named 'SGB'.
    ['Tetris.sgb', false],
    ['Tetris.SGB', false],
    ['Tetris.sfc', false],
    ['Tetris.smc', false],
    ['Tetris.bs', false],
    // Every other console the firmware loads shares the plain bucket: sgb/ is the ONLY namespace,
    // because it is the only extension family that collides with a SNES stem.
    ['Tetris.nes', false],
    ['Tetris.sms', false],
    ['Tetris.a26', false],
    ['Tetris', false],          // no dot at all -> firmware's `!ext` -> return
    ['foo.gb.sfc', false],      // last extension wins; both sides use strrchr('.')
    ['.gb', true],              // leaf that is just an extension; both sides agree
  ];
  for (const [name, want] of CASES) {
    it(`${JSON.stringify(name)} -> ${want}`, () => expect(isGbRom(name)).toBe(want));
  }
});

describe('asset paths per namespace', () => {
  it('sends a Game Boy ROM into sgb/, and a same-named SNES ROM beside it', () => {
    // this pair is the whole feature: without it both games write Tetris.srm to saves/TE
    expect(savesDirFor(assetKeyOf('Tetris.gb', 'buckets'))).toBe(`${SAVES_ROOT}/sgb/TE`);
    expect(savesDirFor(assetKeyOf('Tetris.sfc', 'buckets'))).toBe(`${SAVES_ROOT}/TE`);
    // ...and .sgb goes with the SNES one, because that is what the device does
    expect(savesDirFor(assetKeyOf('Tetris.sgb', 'buckets'))).toBe(`${SAVES_ROOT}/TE`);
    // as do the other consoles: path_is_gb() in fileops.c only ever answers for "gb*"
    expect(savesDirFor(assetKeyOf('Tetris.nes', 'buckets'))).toBe(`${SAVES_ROOT}/TE`);
    expect(savesDirFor(assetKeyOf('Tetris.a26', 'buckets'))).toBe(`${SAVES_ROOT}/TE`);
  });

  it('keeps the two-letter bucket INSIDE sgb/, padding just the same', () => {
    expect(statesDirFor(gbKey('A', 'buckets'))).toBe(`${STATES_ROOT}/sgb/A_`);
    expect(statesDirFor(snesKey('A', 'buckets'))).toBe(`${STATES_ROOT}/A_`);
  });

  it('strips savestate slots in the GB namespace too', () => {
    expect(bucketDirForFile(STATES_ROOT, 'A01.state', true)).toBe(`${STATES_ROOT}/sgb/A_`);
  });

  it('assetKeyOf splits stem and namespace from one filename', () => {
    expect(assetKeyOf('Tetris.gb', 'buckets')).toEqual({ stem: 'Tetris', sgb: true, mode: 'buckets' });
    expect(assetKeyOf('Tetris.sgb', 'buckets')).toEqual({ stem: 'Tetris', sgb: false, mode: 'buckets' });
  });

  it('gives the two namespaces distinct index keys', () => {
    expect(assetIndexKey(assetKeyOf('Tetris.gb', 'buckets'))).not.toBe(assetIndexKey(assetKeyOf('Tetris.sfc', 'buckets')));
  });
});

/**
 * Writing for an older console. The Manager is a website. A user on firmware 2.14 gets the new
 * app just by loading the page, and must keep finding what it writes. These paths are what
 * firmware < 2.15 actually reads.
 */
describe('legacy layout (firmware < 2.15)', () => {
  it('buckets info by ONE character and leaves the other roots flat', () => {
    expect(infoDirFor(assetKeyOf('Super Mario World.sfc', 'legacy'))).toBe(`${INFO_ROOT}/S`);
    expect(cheatsDirFor(assetKeyOf('Super Mario World.sfc', 'legacy'))).toBe(CHEATS_ROOT);
    expect(savesDirFor(assetKeyOf('Super Mario World.sfc', 'legacy'))).toBe(SAVES_ROOT);
    expect(statesDirFor(assetKeyOf('Super Mario World.sfc', 'legacy'))).toBe(STATES_ROOT);
  });

  it('never writes into sgb/ — a pre-2.15 firmware would not look there', () => {
    expect(savesDirFor(assetKeyOf('Tetris.gb', 'legacy'))).toBe(SAVES_ROOT);
    expect(infoDirFor(assetKeyOf('Tetris.gb', 'legacy'))).toBe(`${INFO_ROOT}/T`);
  });

  it('pads a one-character info bucket the same way the old firmware did', () => {
    expect(infoDirFor(assetKeyOf('1.sfc', 'legacy'))).toBe(`${INFO_ROOT}/1`);
    expect(infoDirFor(assetKeyOf('-Dash.sfc', 'legacy'))).toBe(`${INFO_ROOT}/_`);
  });

  it('differs from the new layout for the SAME game — which is the whole point', () => {
    const g = 'Super Mario World.sfc';
    expect(infoDirFor(assetKeyOf(g, 'legacy'))).not.toBe(infoDirFor(assetKeyOf(g, 'buckets')));
  });
});

describe('classifyRootChild', () => {
  it('recognises sgb/ only directly under a root', () => {
    expect(classifyRootChild('sgb', 0)).toBe('sgb');
    expect(classifyRootChild('SGB', 0)).toBe('sgb');
    // one level down it is just a 3-char name -> never followed, so saves/SG/sgb/ is inert
    expect(classifyRootChild('sgb', 1)).toBe('unknown');
  });

  it('accepts current and legacy buckets at both levels', () => {
    expect(classifyRootChild('TE', 0)).toBe('bucket');
    expect(classifyRootChild('S', 0)).toBe('bucket');
    expect(classifyRootChild('TE', 1)).toBe('bucket');
  });

  it('leaves anything else alone', () => {
    expect(classifyRootChild('SomeUserFolder', 0)).toBe('unknown');
    expect(classifyRootChild('', 0)).toBe('unknown');
  });
});

describe('isJunkFile', () => {
  it('matches AppleDouble and Finder droppings', () => {
    expect(isJunkFile('._Super Mario World (USA).yml')).toBe(true);
    expect(isJunkFile('._Zelda.sfc')).toBe(true);
    expect(isJunkFile('.DS_Store')).toBe(true);
    expect(isJunkFile('.Spotlight-V100')).toBe(true);
    expect(isJunkFile('Super Mario World (USA).yml')).toBe(false);
    expect(isJunkFile('_underscore.yml')).toBe(false);
  });

  /* Chromium's own write temporary. It is the only junk that looks like a sidecar, so the
     migration planner used to plan a move for it into a real bucket. */
  it('matches .crswap as a SUFFIX, in any case', () => {
    expect(isJunkFile('Foo.sfc.crswap')).toBe(true);
    expect(isJunkFile('FOO.YML.CRSWAP')).toBe(true);
    expect(isJunkFile('Super Mario World (USA).srm.crswap')).toBe(true);
    // not a suffix -> a real file that merely starts with the word
    expect(isJunkFile('crswap.sfc')).toBe(false);
    expect(isJunkFile('Foo.crswap.sfc')).toBe(false);
    expect(isJunkFile('Foo.crswa')).toBe(false);
  });

  /* Windows shell droppings: exact name, not a suffix -- a suffix test would delete a user's
     "myThumbs.db". Case-insensitive because FAT is, and Windows varies the case itself. */
  it('matches Thumbs.db / desktop.ini by exact name, in any case', () => {
    expect(isJunkFile('Thumbs.db')).toBe(true);
    expect(isJunkFile('thumbs.db')).toBe(true);
    expect(isJunkFile('Thumbs.DB')).toBe(true);
    expect(isJunkFile('desktop.ini')).toBe(true);
    expect(isJunkFile('Desktop.ini')).toBe(true);
    expect(isJunkFile('myThumbs.db')).toBe(false);
    expect(isJunkFile('Thumbs.db.bak')).toBe(false);
    expect(isJunkFile('mydesktop.ini')).toBe(false);
  });

  it('folds case on the exact names too, since two such files cannot coexist on FAT', () => {
    expect(isJunkFile('.ds_store')).toBe(true);
    expect(isJunkFile('.spotlight-v100')).toBe(true);
  });

  it('leaves real library files alone', () => {
    for (const n of ['Zelda.sfc', 'Zelda.yml', 'Zelda01.state', 'Zelda.ips', 'config.yml', 'Tetris.gb']) {
      expect(isJunkFile(n)).toBe(false);
    }
  });

  /* Degenerate names: the bare prefix/suffix on their own. '._' and '.crswap' are still junk
     (an AppleDouble of an empty name / an orphaned temp of one); '' matches nothing. */
  it('handles degenerate names', () => {
    expect(isJunkFile('')).toBe(false);
    expect(isJunkFile('._')).toBe(true);
    expect(isJunkFile('.crswap')).toBe(true);
  });
});

describe('isJunkDir', () => {
  it('matches the host system folders, in any case', () => {
    expect(isJunkDir('System Volume Information')).toBe(true);
    expect(isJunkDir('SYSTEM VOLUME INFORMATION')).toBe(true);
    expect(isJunkDir('system volume information')).toBe(true);
    expect(isJunkDir('$RECYCLE.BIN')).toBe(true);
    expect(isJunkDir('$Recycle.Bin')).toBe(true);
    expect(isJunkDir('RECYCLER')).toBe(true);
    expect(isJunkDir('.Trashes')).toBe(true);
    expect(isJunkDir('.TemporaryItems')).toBe(true);
    expect(isJunkDir('.fseventsd')).toBe(true);
    // deliberately in both lists: macOS makes it a directory, a FAT repair can leave it as a file
    expect(isJunkDir('.Spotlight-V100')).toBe(true);
    expect(isJunkFile('.Spotlight-V100')).toBe(true);
  });

  it('never claims a library directory', () => {
    for (const n of ['sd2snes', 'SD2SNES', 'sgb', 'SU', '_ambiguous', 'roms', 'Recycled Games']) {
      expect(isJunkDir(n)).toBe(false);
    }
  });

  /* True neighbors of the list entries. The cases that prove matching is exact, not prefix. */
  it('matching is exact: near-misses of the system names stay', () => {
    expect(isJunkDir('Recycler Games')).toBe(false);
    expect(isJunkDir('$RECYCLE.BIN.old')).toBe(false);
    expect(isJunkDir('System Volume Information 2')).toBe(false);
  });

  /* The two lists are separate predicates; .Spotlight-V100 is the only deliberate overlap. */
  it('file junk and dir junk do not bleed into each other', () => {
    expect(isJunkDir('Thumbs.db')).toBe(false);
    expect(isJunkDir('.DS_Store')).toBe(false);
    expect(isJunkFile('System Volume Information')).toBe(false);
    expect(isJunkFile('$RECYCLE.BIN')).toBe(false);
  });
});

/**
 * The same cases that pin the firmware side in
 * sd2snes-next/_repo/tests/host/run_patchmatch.sh (patch_ext_type / patch_belongs_to_rom).
 * Change one, change the other in the same commit. A divergence here means the Manager renames a
 * patch the console can still see, or leaves one it cannot.
 */
describe('patchExtOf', () => {
  it('accepts ips/bps in any case, and only as a 3-char extension', () => {
    expect(patchExtOf('Zelda.ips')).toBe('ips');
    expect(patchExtOf('Zelda.BPS')).toBe('bps');
    expect(patchExtOf('Zelda.v2.ips')).toBe('ips');    // cut at the last dot
    expect(patchExtOf('Zelda.ips2')).toBe(null);
    expect(patchExtOf('Zelda.ip')).toBe(null);
    expect(patchExtOf('Zelda.bak')).toBe(null);
    expect(patchExtOf('Zelda')).toBe(null);
  });
});

describe('patchBelongsToRom / patchShadowsRom', () => {
  it('offers a patch whose stem EXTENDS the ROM stem', () => {
    expect(patchBelongsToRom('Zelda - PT-BR.ips', 'Zelda.sfc')).toBe(true);
    expect(patchBelongsToRom('Zelda.v2.ips', 'Zelda.sfc')).toBe(true);
  });

  it('refuses a patch whose stem IS the ROM stem — the rule this whole feature exists for', () => {
    expect(patchBelongsToRom('Zelda.ips', 'Zelda.sfc')).toBe(false);
    expect(patchShadowsRom('Zelda.ips', 'Zelda.sfc')).toBe(true);
  });

  it('compares case-insensitively, as FAT does', () => {
    expect(patchBelongsToRom('zelda - hack.ips', 'ZELDA.SFC')).toBe(true);
    expect(patchShadowsRom('ZELDA.IPS', 'zelda.sfc')).toBe(true);
  });

  it('says nothing about an unrelated name or a non-patch', () => {
    expect(patchBelongsToRom('Metroid - Hack.ips', 'Zelda.sfc')).toBe(false);
    expect(patchBelongsToRom('Zelda - Hack.bak', 'Zelda.sfc')).toBe(false);
    expect(patchShadowsRom('Zelda.bak', 'Zelda.sfc')).toBe(false);
  });
});

describe('patchRenameFor', () => {
  it('produces the name _repo/src/patch.c promises, which the console shows as "Patch 1"', () => {
    // patch_display_name strips the leading " - " separator off the suffix after the ROM stem
    expect(patchRenameFor('Zelda', 'ips', 1)).toBe('Zelda - Patch 1.ips');
    expect(patchRenameFor('Zelda', 'bps', 2)).toBe('Zelda - Patch 2.bps');
  });

  it('makes a stranded patch visible again', () => {
    expect(patchBelongsToRom(patchRenameFor('Zelda', 'ips', 1), 'Zelda.sfc')).toBe(true);
  });
});
