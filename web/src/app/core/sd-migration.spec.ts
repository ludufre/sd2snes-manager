import { describe, it, expect, beforeEach } from 'vitest';
import { SdMigrationService, buildRomIndex, planPatchRenames, isSweepableJunk } from './sd-migration.service';
import { CardWriter } from './card-writer.service';

/**
 * A minimal in-memory stand-in for the File System Access API. Enough to exercise the planner,
 * which is the risky half: it decides what moves where, and a mistake there is what would put a
 * save in a bucket the firmware never looks in.
 */
class FakeFile {
  kind = 'file' as const;
  constructor(public name: string, public size = 1) {}
  getFile() { return Promise.resolve({ size: this.size } as File); }
}
class FakeDir {
  kind = 'directory' as const;
  children = new Map<string, FakeDir | FakeFile>();
  constructor(public name: string) {}
  async *entries(): AsyncGenerator<[string, FakeDir | FakeFile]> {
    for (const [k, v] of this.children) yield [k, v];
  }
  getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.children.get(name);
    if (!d && opts?.create) { d = new FakeDir(name); this.children.set(name, d); }
    if (!d || d.kind !== 'directory') return Promise.reject(new Error('no dir ' + name));
    return Promise.resolve(d);
  }
  getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.children.get(name);
    if (!f && opts?.create) { f = new FakeFile(name); this.children.set(name, f); }
    if (!f || f.kind !== 'file') return Promise.reject(new Error('no file ' + name));
    return Promise.resolve(f);
  }
  dir(path: string): FakeDir {
    let d: FakeDir = this;
    for (const seg of path.split('/')) if (seg) d = d.children.get(seg) as FakeDir ?? (() => {
      const n = new FakeDir(seg); d.children.set(seg, n); return n;
    })();
    return d;
  }
  put(path: string, ...names: string[]) {
    const d = this.dir(path);
    for (const n of names) d.children.set(n, new FakeFile(n));
    return this;
  }
  /** Make this directory behave like a read-only one on disk (chmod 555 / a locked volume). */
  readonly_ = false;
  removeEntry(name: string, _opts?: { recursive?: boolean }) {
    // The exact shape CardWriter.withRetry keys off, it only ever reads `.name`.
    if (this.readonly_) return Promise.reject(Object.assign(new Error('read-only'), { name: 'NoModificationAllowedError' }));
    this.children.delete(name);
    return Promise.resolve();
  }
}

/* plan()/scanJunk() never touch the writer, so the stub can stay empty -- if a change ever makes
   the planner write, this blows up loudly instead of quietly mutating a card. */
const svc = () => new SdMigrationService({} as CardWriter);

describe('migration planner', () => {
  let root: FakeDir;
  beforeEach(() => { root = new FakeDir('root'); });

  /** `roms` is the ROM library the card is judged against. Defaulting to [] here means every
   *  existing test runs with orphan sidecars, which keeps their expectations meaningful: an
   *  orphan outside sgb/ must still land in the plain bucket, exactly as before this feature. */
  const plan = (roms: string[] = []) => svc().plan(root as unknown as FileSystemDirectoryHandle, buildRomIndex(roms));

  it('moves legacy FLAT files into their bucket', async () => {
    root.put('sd2snes/saves', 'Super Mario World (USA).srm');
    root.put('sd2snes/cheats', 'Super Mario World (USA).yml');
    const p = await plan();
    expect(p.moves).toHaveLength(2);
    expect(p.moves.find((m) => m.name.endsWith('.srm'))!.toPath).toBe('sd2snes/saves/SU');
    expect(p.moves.find((m) => m.name.endsWith('.yml'))!.toPath).toBe('sd2snes/cheats/SU');
  });

  it('moves out of the legacy ONE-letter info bucket', async () => {
    root.put('sd2snes/info/S', 'Super Mario World (USA).yml', 'Super Mario World (USA).gcv');
    const p = await plan();
    expect(p.moves).toHaveLength(2);
    for (const m of p.moves) {
      expect(m.fromPath).toBe('sd2snes/info/S');
      expect(m.toPath).toBe('sd2snes/info/SU');
    }
  });

  it('leaves already-migrated files alone — the plan is idempotent', async () => {
    root.put('sd2snes/info/SU', 'Super Mario World (USA).yml');
    root.put('sd2snes/saves/SU', 'Super Mario World (USA).srm');
    const p = await plan();
    expect(p.moves).toHaveLength(0);
  });

  it('self-heals a file sitting in the WRONG two-letter bucket', async () => {
    // e.g. put there by hand, or by an older rule
    root.put('sd2snes/saves/ZZ', 'Super Mario World (USA).srm');
    const p = await plan();
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/SU');
  });

  it('buckets savestates by the ROM stem, not by the slot-suffixed filename', async () => {
    // "A01.state" would naively bucket to "A0"; the ROM "A.sfc" is in "A_", and the firmware
    // looks in "A_". Getting this wrong is how a save silently disappears.
    root.put('sd2snes/states', 'A01.state', 'A02.state');
    const p = await plan();
    expect(p.moves.map((m) => m.toPath)).toEqual(['sd2snes/states/A_', 'sd2snes/states/A_']);
  });

  it('reports a taken destination as a conflict and NEVER plans to overwrite it', async () => {
    root.put('sd2snes/saves', 'Super Mario World (USA).srm');
    root.put('sd2snes/saves/SU', 'Super Mario World (USA).srm');   // already there, different file
    const p = await plan();
    expect(p.moves).toHaveLength(0);
    expect(p.conflicts).toHaveLength(1);
  });

  it('collects AppleDouble droppings instead of moving them', async () => {
    root.put('sd2snes/info/S', 'Foo.yml', '._Foo.yml', '.DS_Store');
    const p = await plan();
    expect(p.moves.map((m) => m.name)).toEqual(['Foo.yml']);
    expect(p.junk.map((j) => j.name).sort()).toEqual(['.DS_Store', '._Foo.yml']);
  });

  it('counts the empty legacy buckets a previous run left behind', async () => {
    // moving a file never removed the folder it came from, so a migrated card kept a full set of
    // dead info/A, info/B, ..., and /sd2snes/info is walked on the way to every asset
    root.dir('sd2snes/info/A');
    root.dir('sd2snes/info/B');
    root.put('sd2snes/info/SU', 'Super Mario World.yml');
    const p = await plan(['Super Mario World.sfc']);
    expect(p.moves).toHaveLength(0);
    expect(p.emptyDirs).toBe(2);      // a run is still offered, purely to clean these up
  });

  it('does not count a user folder as prunable, even when empty', async () => {
    root.dir('sd2snes/info/SomeUserFolder');
    const p = await plan();
    expect(p.emptyDirs).toBe(0);
  });

  it('never touches directories it does not recognise', async () => {
    root.dir('sd2snes/info/SomeUserFolder').children.set('x.yml', new FakeFile('x.yml'));
    const p = await plan();
    expect(p.moves).toHaveLength(0);
    expect(p.skipped).toContain('sd2snes/info/SomeUserFolder');
  });

  it('finds a root whose folder name differs in CASE — FAT is case-insensitive', async () => {
    // A card with `Cheats` (older tool, hand-made folder) used to make dirAt return null and the
    // whole root was skipped in silence: the migration never mentioned cheats at all.
    root.put('sd2snes/Cheats', 'Super Mario World (USA).yml');
    const p = await plan();
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0].toPath).toBe('sd2snes/cheats/SU');
  });

  it('gives every root a row, so a missing one reads as 0 rather than vanishing', async () => {
    root.put('sd2snes/saves', 'Foo.srm');
    const p = await plan();
    expect(Object.keys(p.byRoot).sort()).toEqual(
      ['sd2snes/cheats', 'sd2snes/info', 'sd2snes/saves', 'sd2snes/states'],
    );
  });

  it('keeps every sidecar of one ROM together', async () => {
    root.put('sd2snes/info/S', 'Foo.yml', 'Foo.gcv', 'Foo.gss', 'Foo.fmv', 'Foo.02.man');
    const p = await plan();
    expect(new Set(p.moves.map((m) => m.toPath)).size).toBe(1);
  });
});

/**
 * The Game Boy namespace. A file on the card carries no evidence of its origin, .srm/.yml/.state
 * are system-agnostic, so every decision here comes from cross-referencing the ROM library.
 */
describe('migration planner — sgb/ namespace', () => {
  let root: FakeDir;
  beforeEach(() => { root = new FakeDir('root'); });
  const plan = (roms: string[] = []) => svc().plan(root as unknown as FileSystemDirectoryHandle, buildRomIndex(roms));

  it('pulls a Game Boy game\'s save into sgb/', async () => {
    root.put('sd2snes/saves', 'Tetris.srm');
    const p = await plan(['Tetris.gb']);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/sgb/TE');
  });

  it('leaves a SNES game\'s save in the plain bucket', async () => {
    root.put('sd2snes/saves', 'Tetris.srm');
    const p = await plan(['Tetris.sfc']);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/TE');
  });

  it('treats .sgb as SNES, because the FIRMWARE does', async () => {
    // sgb.c:66-71 tests for an extension starting with "gb"; ".sgb" starts with 's' and loads as a
    // plain SNES ROM. Putting it under sgb/ here would point the Manager at a directory the device
    // never reads.
    root.put('sd2snes/saves', 'Tetris.srm');
    const p = await plan(['Tetris.sgb']);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/TE');
  });

  it('quarantines a stem that is BOTH a GB and a SNES game — never guesses a bucket', async () => {
    root.put('sd2snes/saves', 'Tetris.srm');
    const p = await plan(['Tetris.gb', 'Tetris.sfc']);
    expect(p.ambiguous).toHaveLength(1);
    expect(p.ambiguous[0].stem).toBe('Tetris');
    // moved out of the root (it slowed every scan there) but never into a bucket of either game
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/_ambiguous');
  });

  it('does NOT quarantine a file already under sgb/ — position proves it is the GB one', async () => {
    // only a .gb ever lands in sgb/ (the firmware writes it from the ROM it loaded), so even with
    // a same-named SNES game on the card this file's provenance is settled
    root.put('sd2snes/saves/sgb/TE', 'Tetris.srm');
    const p = await plan(['Tetris.gb', 'Tetris.sfc']);
    expect(p.moves).toHaveLength(0);
    expect(p.ambiguous).toHaveLength(0);
  });

  it('does NOT quarantine a file already in a two-letter bucket — that is the SNES one', async () => {
    // Under the new layout the two games live apart, so a plain <BB> bucket answers the question
    // just as sgb/ does. Measured on a real card: without this, 259 already-filed info sidecars
    // would be yanked into quarantine, breaking game info that works today.
    root.put('sd2snes/info/AD', 'Addams Family, The (USA).yml');
    const p = await plan(['Addams Family, The (USA).gb', 'Addams Family, The (USA).sfc']);
    expect(p.moves).toHaveLength(0);
    expect(p.ambiguous).toHaveLength(0);
  });

  it('DOES quarantine from a one-character legacy bucket — both games shared it', async () => {
    root.put('sd2snes/info/A', 'Addams Family, The (USA).yml');
    const p = await plan(['Addams Family, The (USA).gb', 'Addams Family, The (USA).sfc']);
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0].toPath).toBe('sd2snes/info/_ambiguous');
  });

  it('drains the quarantine once the name clash is resolved', async () => {
    root.put('sd2snes/saves/_ambiguous', 'Tetris.srm');
    // the user renamed the Game Boy copy, so the stem now matches only the SNES ROM
    const p = await plan(['Tetris.sfc']);
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/TE');
    expect(p.ambiguous).toHaveLength(0);
  });

  it('leaves a still-ambiguous file sitting in the quarantine (idempotent)', async () => {
    root.put('sd2snes/saves/_ambiguous', 'Tetris.srm');
    const p = await plan(['Tetris.gb', 'Tetris.sfc']);
    expect(p.moves).toHaveLength(0);
    expect(p.ambiguous).toHaveLength(1);
  });

  it('ORPHAN outside sgb/ goes to the plain bucket (where it already effectively is)', async () => {
    root.put('sd2snes/saves', 'Tetris.srm');
    const p = await plan(['Something Else.sfc']);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/TE');
  });

  it('ORPHAN already inside sgb/ STAYS — never dragged out on missing information', async () => {
    // The regression a naive "orphans default to SNES" rule would introduce: the ROM is simply
    // not in the scan (deleted, or a folder that was not walked) and a correctly-migrated GB save
    // would be moved somewhere the device does not look.
    root.put('sd2snes/saves/sgb/TE', 'Tetris.srm');
    const p = await plan([]);
    expect(p.moves).toHaveLength(0);
  });

  it('is idempotent once the library agrees', async () => {
    root.put('sd2snes/saves/sgb/TE', 'Tetris.srm');
    root.put('sd2snes/info/SU', 'Super Mario World.yml');
    const p = await plan(['Tetris.gb', 'Super Mario World.sfc']);
    expect(p.moves).toHaveLength(0);
  });

  it('self-heals in BOTH directions', async () => {
    root.put('sd2snes/saves/TE', 'Tetris.srm');
    expect((await plan(['Tetris.gb'])).moves[0].toPath).toBe('sd2snes/saves/sgb/TE');

    root = new FakeDir('root');
    root.put('sd2snes/saves/sgb/TE', 'Tetris.srm');
    expect((await plan(['Tetris.sfc'])).moves[0].toPath).toBe('sd2snes/saves/TE');
  });

  it('buckets a file dumped straight into sgb/, keeping the namespace', async () => {
    root.put('sd2snes/saves/sgb', 'Tetris.srm');
    const p = await plan([]);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/sgb/TE');
  });

  it('migrates a legacy one-char bucket inside sgb/', async () => {
    root.put('sd2snes/saves/sgb/T', 'Tetris.srm');
    const p = await plan(['Tetris.gb']);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/sgb/TE');
  });

  it('strips savestate slots in the GB namespace too', async () => {
    root.put('sd2snes/states', 'Tetris01.state');
    const p = await plan(['Tetris.gb']);
    expect(p.moves[0].toPath).toBe('sd2snes/states/sgb/TE');
  });

  it('keeps the SGB RTC file (.gtc) with its game\'s save', async () => {
    root.put('sd2snes/saves', 'Tetris.srm', 'Tetris.gtc');
    const p = await plan(['Tetris.gb']);
    expect(new Set(p.moves.map((m) => m.toPath))).toEqual(new Set(['sd2snes/saves/sgb/TE']));
  });

  it('matches case-insensitively, as FAT does', async () => {
    root.put('sd2snes/saves', 'TETRIS.srm');
    const p = await plan(['Tetris.gb']);
    expect(p.moves[0].toPath).toBe('sd2snes/saves/sgb/TE');
  });

  it('reports a taken destination inside sgb/ as a conflict', async () => {
    root.put('sd2snes/saves', 'Tetris.srm');
    root.put('sd2snes/saves/sgb/TE', 'Tetris.srm');
    const p = await plan(['Tetris.gb']);
    expect(p.moves).toHaveLength(0);
    expect(p.conflicts).toHaveLength(1);
  });

  it('never reports the sgb/ tree as skipped or junk', async () => {
    // the old `name.length > BUCKET_LEN` test called this 3-character directory unrecognised
    root.put('sd2snes/saves/sgb/TE', 'Tetris.srm');
    const p = await plan(['Tetris.gb']);
    expect(p.skipped.filter((s) => s.includes('sgb'))).toHaveLength(0);
    expect(p.junk).toHaveLength(0);
  });

  it('treats a bucket as TERMINAL — never walks deeper', async () => {
    // two-character names must not nest: saves/TE/XX/ is a user folder, not a bucket-in-a-bucket
    root.put('sd2snes/saves/TE/XX', 'Tetris.srm');
    const p = await plan(['Tetris.gb']);
    expect(p.moves).toHaveLength(0);
    expect(p.skipped).toContain('sd2snes/saves/TE/XX');
  });

  it('collects junk from inside sgb/ buckets', async () => {
    root.put('sd2snes/saves/sgb/TE', 'Tetris.srm', '._Tetris.srm');
    const p = await plan(['Tetris.gb']);
    expect(p.junk.map((j) => j.name)).toEqual(['._Tetris.srm']);
  });

  it('collects junk from OUTSIDE the four bucketed roots', async () => {
    // The dialog promises to remove "the macOS ._ files" -- all of them. Junk sitting next to the
    // BIOS, the themes or config.yml is scanned by the firmware just the same, so a sweep that
    // only covered info/cheats/saves/states would be quietly lying.
    root.put('sd2snes', '._config.yml');
    root.put('sd2snes/themes', '._Cool.thm');
    root.put('sd2snes/saves/TE', '._Tetris.srm');
    const p = await plan([]);
    expect(p.junk.map((j) => j.name).sort()).toEqual(['._Cool.thm', '._Tetris.srm', '._config.yml']);
  });
});

/**
 * execute(), the half that actually touches the card. The case that matters is a card that stops
 * accepting writes partway (full, write-protected, or remounted read-only by the OS): it must halt
 * and say so, not grind through every remaining move refusing each one and leave half-populated
 * bucket folders behind with a cheerful summary.
 */
describe('migration execute — a card that stops accepting writes', () => {
  const unwritableErr = () => Object.assign(new Error('card is unwritable'), { name: 'CardUnwritableError' });

  /** A CardWriter stub that latches unwritable on its first remove(), like the real write-health latch. */
  const latchingCard = () => {
    const state = { unwritable: false, removes: 0, moves: 0 };
    return {
      state,
      card: {
        get unwritable() { return state.unwritable; },
        lastError: 'NotAllowedError: read-only',
        async remove() { state.removes++; state.unwritable = true; throw unwritableErr(); },
        async ensureDir() { return new FakeDir('d') as unknown as FileSystemDirectoryHandle; },
        async moveFile() { state.moves++; },
      } as unknown as CardWriter,
    };
  };

  it('stops after the junk sweep latches instead of attempting any move', async () => {
    const root = new FakeDir('root');
    root.put('sd2snes/saves', 'Tetris.srm', '._Tetris.srm');
    const { card, state } = latchingCard();
    const svc = new SdMigrationService(card);
    const plan = await svc.plan(root as unknown as FileSystemDirectoryHandle, buildRomIndex(['Tetris.sfc']));
    expect(plan.moves.length).toBe(1);
    expect(plan.junk.length).toBe(1);

    const res = await svc.execute(root as unknown as FileSystemDirectoryHandle, plan);
    expect(res.unwritable).toBe(true);
    // the whole point: it did not try to move anything onto a card that just refused a delete
    expect(state.moves).toBe(0);
    expect(res.moved).toBe(0);
    expect(res.failed).toHaveLength(0);   // and it is not reported as N individual "failures"
  });

  it('reports progress per STAGE, not per file', async () => {
    const root = new FakeDir('root');
    root.put('sd2snes/saves', 'A.srm', 'B.srm');
    root.put('sd2snes/cheats', 'A.yml');
    const moved: string[] = [];
    const card = {
      get unwritable() { return false; },
      lastError: '',
      async remove() { /* no junk here */ },
      async ensureDir() { return new FakeDir('d') as unknown as FileSystemDirectoryHandle; },
      async moveFile() { moved.push('x'); },
    } as unknown as CardWriter;
    const svc = new SdMigrationService(card);
    const plan = await svc.plan(root as unknown as FileSystemDirectoryHandle, buildRomIndex(['A.sfc', 'B.sfc']));

    const stages: string[] = [];
    await svc.execute(root as unknown as FileSystemDirectoryHandle, plan, (p) => {
      stages.push(`${p.stage} ${p.stageIndex}/${p.stageCount}`);
    });
    // cheats before saves (least-precious first), each stage named, no filenames anywhere
    expect(new Set(stages.map((s) => s.split(' ')[0]))).toEqual(new Set(['cheats', 'saves']));
    expect(stages.every((s) => /\d+\/2$/.test(s))).toBe(true);
  });

  it('renames a stranded patch in place, and reports a taken destination as a conflict', async () => {
    const root = new FakeDir('root');
    root.put('Games', 'Zelda.sfc', 'Zelda.ips', 'Metroid.sfc', 'Metroid.ips', 'Metroid - Patch 1.ips');
    const renames: string[] = [];
    const card = {
      get unwritable() { return false; },
      lastError: '',
      async remove() { /* no junk */ },
      async ensureDir() { return new FakeDir('d') as unknown as FileSystemDirectoryHandle; },
      async moveFile() { /* no sidecar moves here */ },
      async renameFile(_d: unknown, fh: { name: string }, to: string) { renames.push(`${fh.name} -> ${to}`); },
    } as unknown as CardWriter;
    const svc = new SdMigrationService(card);
    const library = {
      roms: [{ folder: 'Games', name: 'Zelda.sfc' }, { folder: 'Games', name: 'Metroid.sfc' }],
      patches: [
        { folder: 'Games', name: 'Zelda.ips' },
        { folder: 'Games', name: 'Metroid.ips' },
        { folder: 'Games', name: 'Metroid - Patch 1.ips' },
      ],
    };
    const plan = await svc.plan(root as unknown as FileSystemDirectoryHandle, buildRomIndex([]), library);
    // Metroid skips the taken "Patch 1"; the already-suffixed one is visible and left alone
    expect(plan.renames.map((r) => `${r.name} -> ${r.to}`).sort()).toEqual([
      'Metroid.ips -> Metroid - Patch 2.ips',
      'Zelda.ips -> Zelda - Patch 1.ips',
    ]);

    // now make Zelda's destination appear between planning and running: never overwritten
    root.put('Games', 'Zelda - Patch 1.ips');
    const res = await svc.execute(root as unknown as FileSystemDirectoryHandle, plan);
    expect(renames).toEqual(['Metroid.ips -> Metroid - Patch 2.ips']);
    expect(res.renamed).toBe(1);
    expect(res.conflicts).toBe(1);
    expect(res.failed).toHaveLength(0);
  });
});

describe('buildRomIndex', () => {
  it('classifies by extension and flags collisions', () => {
    const ix = buildRomIndex(['Tetris.gb', 'Zelda.sfc', 'Dr Mario.gbc', 'Kirby.sgb', 'Both.gb', 'Both.sfc']);
    expect(ix.get('tetris')).toBe('sgb');
    expect(ix.get('zelda')).toBe('');
    expect(ix.get('dr mario')).toBe('sgb');
    expect(ix.get('kirby')).toBe('');       // .sgb is not Game Boy, see sgb.c:66-71
    expect(ix.get('both')).toBe('both');
  });

  it('classifies Sufami Turbo minicarts, and collides them like any other namespace', () => {
    const ix = buildRomIndex(['Poi Poi.st', 'Gundam.st', 'Both.st', 'Both.sfc']);
    expect(ix.get('poi poi')).toBe('sft');
    expect(ix.get('gundam')).toBe('sft');
    expect(ix.get('both')).toBe('both');    // a .st and a .sfc share one stem -> unattributable
  });

  it('does not flag a duplicate of the SAME class as ambiguous', () => {
    // the same game in two folders is common and must not block migration
    expect(buildRomIndex(['Tetris.gb', 'Tetris.gbc']).get('tetris')).toBe('sgb');
    expect(buildRomIndex(['Poi Poi.st', 'Poi Poi.st']).get('poi poi')).toBe('sft');
  });
});

/**
 * The patch renames. Pure string work over the card scan, and the rule it implements is the exact
 * complement of a firmware rule (_repo/src/patch.c patch_belongs_to_rom), so the cases below mirror
 * _repo/tests/host/run_patchmatch.sh. Especially the one that must not be renamed.
 */
describe('patch renames', () => {
  const rom = (name: string, folder = 'Games') => ({ folder, name });

  it('rescues the stranded "Foo.sfc + Foo.ips" convention', () => {
    const r = planPatchRenames([rom('Zelda.sfc')], [rom('Zelda.ips')]);
    expect(r).toEqual([{ path: 'Games', name: 'Zelda.ips', to: 'Zelda - Patch 1.ips' }]);
  });

  it('LEAVES the "Create patched ROM" leftover alone — renaming it would corrupt the patched copy', () => {
    // Zelda - PT-BR.ips shares the stem of the copy it produced, but it is still the patch of
    // Zelda.sfc and the firmware offers it there. Renaming would make it visible on the already
    // patched image, which is the double-apply the same-stem skip exists to prevent.
    const roms = [rom('Zelda.sfc'), rom('Zelda - PT-BR.sfc')];
    expect(planPatchRenames(roms, [rom('Zelda - PT-BR.ips')])).toEqual([]);
  });

  it('leaves a patch that is already visible alone', () => {
    expect(planPatchRenames([rom('Zelda.sfc')], [rom('Zelda - PT-BR.ips')])).toEqual([]);
  });

  it('ignores a patch with no ROM to be stranded from', () => {
    expect(planPatchRenames([rom('Zelda.sfc')], [rom('Metroid.ips')])).toEqual([]);
    expect(planPatchRenames([], [rom('Zelda.ips')])).toEqual([]);
  });

  it('matches case-insensitively, as FAT does', () => {
    const r = planPatchRenames([rom('ZELDA.SFC')], [rom('zelda.ips')]);
    expect(r.map((x) => x.to)).toEqual(['zelda - Patch 1.ips']);
  });

  it('numbers an .ips and a .bps for the same ROM apart', () => {
    const r = planPatchRenames([rom('Zelda.sfc')], [rom('Zelda.ips'), rom('Zelda.bps')]);
    expect(r.map((x) => x.to).sort()).toEqual(['Zelda - Patch 1.bps', 'Zelda - Patch 2.ips']);
  });

  it('skips a number already taken by a file on the card', () => {
    const r = planPatchRenames([rom('Zelda.sfc')], [rom('Zelda.ips'), rom('Zelda - Patch 1.ips')]);
    expect(r.map((x) => x.to)).toEqual(['Zelda - Patch 2.ips']);
  });

  it('is idempotent — a renamed patch is visible and never touched again', () => {
    const roms = [rom('Zelda.sfc')];
    const first = planPatchRenames(roms, [rom('Zelda.ips')]);
    const after = [{ folder: 'Games', name: first[0].to }];
    expect(planPatchRenames(roms, after)).toEqual([]);
  });

  it('only matches ROMs in the SAME folder — the firmware scans one directory', () => {
    expect(planPatchRenames([rom('Zelda.sfc', 'A')], [rom('Zelda.ips', 'B')])).toEqual([]);
  });

  it('handles the card root, whose folder is the empty string', () => {
    const r = planPatchRenames([rom('Zelda.sfc', '')], [rom('Zelda.ips', '')]);
    expect(r).toEqual([{ path: '', name: 'Zelda.ips', to: 'Zelda - Patch 1.ips' }]);
  });

  it('is not fooled by a lookalike extension', () => {
    expect(planPatchRenames([rom('Zelda.sfc')], [rom('Zelda.ips2'), rom('Zelda.bak')])).toEqual([]);
  });

  it('never renames into ANOTHER ROM\'s shadow', () => {
    // "Zelda - Patch 1.ips" would be invisible all over again next to "Zelda - Patch 1.sfc"
    const roms = [rom('Zelda.sfc'), rom('Zelda - Patch 1.sfc')];
    expect(planPatchRenames(roms, [rom('Zelda.ips')]).map((x) => x.to)).toEqual(['Zelda - Patch 2.ips']);
  });

  it('refuses a rename the firmware would then drop for length', () => {
    // patch_scan_dir skips a basename >= 128 chars, so producing one is not a rescue
    const stem = 'Z'.repeat(120);
    expect(planPatchRenames([rom(`${stem}.sfc`)], [rom(`${stem}.ips`)])).toEqual([]);
  });
});

describe('junk sweep', () => {
  let root: FakeDir;
  beforeEach(() => { root = new FakeDir('root'); });
  const scan = () => svc().scanJunk(root as unknown as FileSystemDirectoryHandle);
  const found = async () => (await scan()).map((j) => (j.path ? `${j.path}/${j.name}` : j.name)).sort();

  it('finds AppleDouble files across the whole /sd2snes tree', async () => {
    root.put('sd2snes', '._config.yml');
    root.put('sd2snes/info/SU', 'Foo.yml', '._Foo.yml');
    root.put('sd2snes/saves', '._Bar.srm');
    const junk = await scan();
    expect(junk.map((j) => j.name).sort()).toEqual(['._Bar.srm', '._Foo.yml', '._config.yml']);
  });

  /* The one this whole package exists for. Chromium writes each `.cov` next to its ROM, and macOS
     answers with a `._` per file, so the ROM tree, not /sd2snes, is where the litter piles up. */
  it('finds the droppings out in the ROM tree, not just under /sd2snes', async () => {
    root.put('Roms/SNES', 'Zelda.sfc', 'Zelda.cov', '._Zelda.sfc', '._Zelda.cov', 'Zelda.cov.crswap');
    root.put('Roms', '.DS_Store');
    root.put('sd2snes/info/ZE', 'Zelda.yml', '._Zelda.yml');
    expect(await found()).toEqual([
      'Roms/.DS_Store',
      'Roms/SNES/._Zelda.cov', 'Roms/SNES/._Zelda.sfc', 'Roms/SNES/Zelda.cov.crswap',
      'sd2snes/info/ZE/._Zelda.yml',
    ]);
  });

  /* /sd2snes is reached by both walks unless the root one steps over it. Reporting a file twice
     would double the progress total and try to delete an already-deleted name. */
  it('reports each file once — /sd2snes is walked deep, and only once', async () => {
    root.put('sd2snes', '.DS_Store');
    root.put('sd2snes/info/ZE', '._Zelda.yml');
    expect(await found()).toEqual(['sd2snes/.DS_Store', 'sd2snes/info/ZE/._Zelda.yml']);
  });

  it('never descends into a recycle bin, trash or volume-metadata folder', async () => {
    root.put('System Volume Information', '._x', 'IndexerVolumeGuid');
    root.put('$RECYCLE.BIN/S-1-5-21', '._deleted.sfc');
    root.put('.Trashes/501', '._gone.sfc');
    root.put('.fseventsd', '._log');
    expect(await found()).toEqual([]);
  });

  /* A `desktop.ini` in the root of a removable volume is how Windows gives the card its own icon
     and label. Deleting it would throw away something the user set by hand. */
  it('spares desktop.ini at the card root and sweeps it everywhere else', async () => {
    root.put('', 'desktop.ini', '.DS_Store');
    root.put('Roms', 'desktop.ini');
    root.put('sd2snes/info', 'desktop.ini');
    expect(await found()).toEqual(['.DS_Store', 'Roms/desktop.ini', 'sd2snes/info/desktop.ini']);
  });

  it('lists the ROOT system folders by name — and only the root ones', async () => {
    root.dir('System Volume Information');
    root.dir('$RECYCLE.BIN');
    root.dir('Roms/$RECYCLE.BIN');        // not at the root: not offered, and not walked either
    root.put('Roms', 'Zelda.sfc');
    const dirs = await svc().scanSystemDirs(root as unknown as FileSystemDirectoryHandle);
    expect(dirs).toEqual(['$RECYCLE.BIN', 'System Volume Information']);
  });

  /**
   * The safety property of the whole package.
   *
   * The sweep now reaches into the user's own ROM folders, which are routinely read-only (a hack
   * set extracted with dr-xr-xr-x dirs already cost one production incident). Four consecutive
   * refusals used to be CardWriter's definition of "this card is unwritable", which would latch
   * the run and refuse every move that followed, over files that do not matter at all. So the
   * removals are isolated: they are retried, they are skipped, and they never latch.
   */
  it('a removal a read-only folder refuses NEVER latches the card', async () => {
    const card = new CardWriter();
    const m = new SdMigrationService(card);
    root.put('Roms', '._Zelda.sfc', '._Mario.sfc');
    root.dir('Roms').readonly_ = true;
    const junk = await m.scanJunk(root as unknown as FileSystemDirectoryHandle);
    expect(junk).toHaveLength(2);

    const res = await m.removeJunk(root as unknown as FileSystemDirectoryHandle, junk);
    expect(res).toEqual({ removed: 0, failed: 2 });   // refusals are reported, not swallowed
    // the point: the run may carry on, and the moves that follow are still attempted
    expect(card.unwritable).toBe(false);
  });

  it('still deletes what it can, and reports the count', async () => {
    const card = new CardWriter();
    const m = new SdMigrationService(card);
    root.put('Roms', 'Zelda.sfc', '._Zelda.sfc');
    root.put('sd2snes/info/ZE', '._Zelda.yml');
    const junk = await m.scanJunk(root as unknown as FileSystemDirectoryHandle);
    expect(await m.removeJunk(root as unknown as FileSystemDirectoryHandle, junk))
      .toEqual({ removed: 2, failed: 0 });
    expect([...root.dir('Roms').children.keys()]).toEqual(['Zelda.sfc']);
    expect(card.unwritable).toBe(false);
  });

  /**
   * A read-only folder must cost the rest of that folder and nothing else.
   *
   * The give-up used to count refusals in global order and `break` the whole loop, so one hack set
   * extracted with dr-xr-xr-x dirs silently truncated the sweep for the entire card, and because
   * the plan is re-derived from the filesystem, every re-run stalled on the same folder again.
   */
  it('gives up on the refusing FOLDER, never on the card', async () => {
    const card = new CardWriter();
    const m = new SdMigrationService(card);
    // more `._` in the read-only folder than the give-up threshold, so it is definitely reached
    root.put('Locked', ...Array.from({ length: 12 }, (_, i) => `._rom${i}.sfc`));
    root.dir('Locked').readonly_ = true;
    root.put('Writable', '._Zelda.sfc', 'Zelda.sfc');
    const junk = await m.scanJunk(root as unknown as FileSystemDirectoryHandle);

    const res = await m.removeJunk(root as unknown as FileSystemDirectoryHandle, junk);
    // the writable folder was still swept, whichever order the walk visited them in
    expect(res.removed).toBe(1);
    expect(res.failed).toBe(12);
    expect([...root.dir('Writable').children.keys()]).toEqual(['Zelda.sfc']);
    expect(card.unwritable).toBe(false);
  }, 20_000);   // the refusals are genuinely retried (isolated: 2 attempts + backoff) before giving up
});

describe('isSweepableJunk', () => {
  it('spares desktop.ini in the volume ROOT — that one is the card icon/label, not litter', () => {
    expect(isSweepableJunk('desktop.ini', true)).toBe(false);
    expect(isSweepableJunk('Desktop.INI', true)).toBe(false);   // FAT is case-insensitive
    expect(isSweepableJunk('desktop.ini', false)).toBe(true);   // a subfolder's is Explorer view state
  });

  it('is isJunkFile everywhere else, root or not', () => {
    for (const atRoot of [true, false]) {
      expect(isSweepableJunk('._Zelda.sfc', atRoot)).toBe(true);
      expect(isSweepableJunk('.DS_Store', atRoot)).toBe(true);
      expect(isSweepableJunk('Zelda.cov.crswap', atRoot)).toBe(true);
      expect(isSweepableJunk('Thumbs.db', atRoot)).toBe(true);
      expect(isSweepableJunk('Zelda.sfc', atRoot)).toBe(false);
      expect(isSweepableJunk('mydesktop.ini', atRoot)).toBe(false);
    }
  });
});

describe('optional system-folder removal', () => {
  const cardStub = (removals: string[], refuse = false) => ({
    get unwritable() { return false; },
    lastError: '',
    async remove() { /* no junk in these trees */ },
    async ensureDir() { return new FakeDir('d') as unknown as FileSystemDirectoryHandle; },
    async moveFile() { /* nothing to move */ },
    async removeFolder(_p: unknown, name: string) {
      if (refuse) throw Object.assign(new Error('nope'), { name: 'NoModificationAllowedError' });
      removals.push(name);
    },
  } as unknown as CardWriter);

  const planned = async (card: CardWriter, root: FakeDir) =>
    new SdMigrationService(card).plan(root as unknown as FileSystemDirectoryHandle, buildRomIndex([]));

  it('leaves the system folders alone unless asked — the default is OFF', async () => {
    const root = new FakeDir('root');
    root.dir('System Volume Information');
    root.dir('$RECYCLE.BIN');
    const removals: string[] = [];
    const card = cardStub(removals);
    const m = new SdMigrationService(card);
    const plan = await planned(card, root);
    expect(plan.systemDirs).toEqual(['$RECYCLE.BIN', 'System Volume Information']);

    const res = await m.execute(root as unknown as FileSystemDirectoryHandle, plan);
    expect(removals).toEqual([]);
    expect(res.sysDirsRemoved).toBe(0);
  });

  it('removes them whole when the user opts in', async () => {
    const root = new FakeDir('root');
    root.dir('$RECYCLE.BIN');
    const removals: string[] = [];
    const card = cardStub(removals);
    const m = new SdMigrationService(card);
    const plan = await planned(card, root);
    const res = await m.execute(root as unknown as FileSystemDirectoryHandle, plan, undefined, undefined,
                                { removeSystemDirs: true });
    expect(removals).toEqual(['$RECYCLE.BIN']);
    expect(res.sysDirsRemoved).toBe(1);
    expect(res.sysDirsFailed).toBe(0);
  });

  /* Chromium refuses `System Volume Information` outright on Windows, every time. That refusal has
     nothing to do with the card's health and must not end the run. */
  it('counts a refusal instead of aborting the run', async () => {
    const root = new FakeDir('root');
    root.dir('System Volume Information');
    const card = cardStub([], true);
    const m = new SdMigrationService(card);
    const plan = await planned(card, root);
    const res = await m.execute(root as unknown as FileSystemDirectoryHandle, plan, undefined, undefined,
                                { removeSystemDirs: true });
    expect(res.sysDirsFailed).toBe(1);
    expect(res.sysDirsRemoved).toBe(0);
    expect(res.unwritable).toBe(false);
    expect(res.aborted).toBe(false);
  });
});
