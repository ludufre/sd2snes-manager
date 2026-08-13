/**
 * The `fmv: 1` flag the firmware gates its `.fmv`/`.gss` probe on.
 *
 * Placing a preview has to guarantee the sibling ficha carries that flag, and the store no longer
 * Reads the ficha back to find out: when the same flow just wrote it (auto-fill writes the `.yml`
 * and then the preview), the text is already in memory and gets patched from there. That only holds
 * if the patch is decided purely from "what the file holds now", which is what these tests pin,
 * including the two ways it must not be written: never a second flag, never a rewritten ficha.
 *
 * Get this wrong and nothing throws: the clip lands on the card and the console never plays it.
 */
import { describe, expect, it } from 'vitest';
import { electFichaOwners, fichaKeyOf, fmvFlagFor, groupManualBuckets, manSlotsField, manSlotsFor, planManualSlots, ymlWithFmvFlag, ymlWithoutFmvFlag } from './library-store';
import { buildYml, parseInfoYml, MAN_USER_TAG } from '../lib/yml.js';
import { slugIdOfType } from '../lib/man.js';

describe('ymlWithFmvFlag — the ficha patch that turns the preview on', () => {
  it('creates the flag-only ficha when there is no `.yml` at all', () => {
    expect(ymlWithFmvFlag(null)).toBe('fmv: 1\n');
  });

  it('writes NOTHING when the flag is already there (this is the case that saves a read + a write)', () => {
    expect(ymlWithFmvFlag('fmv: 1\n')).toBeNull();
    expect(ymlWithFmvFlag('---\ntitle: "Super Metroid"\nfmv: 1\n')).toBeNull();
    expect(ymlWithFmvFlag('---\nfmv: 1\ntitle: "Super Metroid"\n')).toBeNull(); // not only as the last line
    expect(ymlWithFmvFlag('  fmv:1\n')).toBeNull();                             // indented / no space
    expect(ymlWithFmvFlag('FMV: 1\n')).toBeNull();                              // FAT-ish casing
  });

  it('appends the flag and leaves every existing byte of the ficha alone', () => {
    const before = '---\n# comment the user wrote\ntitle: "Chrono Trigger"\ndescription: "hi"\n';
    const after = ymlWithFmvFlag(before);
    expect(after).toBe(before + 'fmv: 1\n');
    expect(after?.startsWith(before)).toBe(true); // nothing reordered, nothing normalized, nothing dropped
  });

  it('does not glue the flag onto the last line when the ficha has no trailing newline', () => {
    expect(ymlWithFmvFlag('title: "Tetris"')).toBe('title: "Tetris"\nfmv: 1\n');
  });

  it('leaves a ficha buildYml already flagged untouched, and flags one it did not', () => {
    expect(ymlWithFmvFlag(buildYml({ title: 'Super Metroid', fmv: 1 }))).toBeNull();

    const plain = buildYml({ title: 'Super Metroid', description: 'English text', sync_meta: 'r7' });
    const patched = ymlWithFmvFlag(plain);
    expect(patched).not.toBeNull();
    // The ficha still reads back exactly as before, plus the flag, the firmware's own reader parses
    // `key: value` lines in any order, so appending is safe, but nothing else may have moved.
    const back = parseInfoYml(patched as string) as Record<string, string>;
    expect(back['fmv']).toBe('1');
    expect(back['title']).toBe('Super Metroid');
    expect(back['description']).toBe('English text');
    expect(back['sync_meta']).toBe('r7');
  });

  it('is idempotent — a second pass over its own output writes nothing', () => {
    const once = ymlWithFmvFlag(buildYml({ title: 'F-Zero' })) as string;
    expect(ymlWithFmvFlag(once)).toBeNull();
  });
});

/**
 * The other direction, and the reason it exists: auto-fill hands the write worker a ficha with
 * `fmv: 1` already baked in (the worker writes the `.yml` and the `.fmv` in one pass), and the package
 * may then turn out not to carry the clip. Left alone, that flag points at files nobody wrote.
 */
describe('ymlWithoutFmvFlag — taking the flag back out when the preview was skipped', () => {
  it('writes NOTHING when there is no ficha or no flag in it', () => {
    expect(ymlWithoutFmvFlag(null)).toBeNull();
    expect(ymlWithoutFmvFlag('')).toBeNull();
    expect(ymlWithoutFmvFlag('title: "Tetris"\n')).toBeNull();
  });

  it('drops only the flag line and leaves every other byte alone', () => {
    expect(ymlWithoutFmvFlag('---\ntitle: "Chrono Trigger"\nfmv: 1\n')).toBe('---\ntitle: "Chrono Trigger"\n');
    expect(ymlWithoutFmvFlag('fmv: 1\ntitle: "Chrono Trigger"\n')).toBe('title: "Chrono Trigger"\n');
    expect(ymlWithoutFmvFlag('  FMV:1\ntitle: "T"\n')).toBe('title: "T"\n'); // indented / no space / FAT-ish casing
    expect(ymlWithoutFmvFlag('title: "T"\nfmv: 1')).toBe('title: "T"\n');   // no trailing newline
  });

  it('never touches a key that merely STARTS with fmv', () => {
    const keep = 'fmv_rate: 12\n';
    expect(ymlWithoutFmvFlag(keep)).toBeNull();
  });

  it('round-trips with ymlWithFmvFlag — flag, unflag, and the ficha is what it was', () => {
    const before = buildYml({ title: 'Super Metroid', description: 'hi', sync_meta: 'r7' });
    const flagged = ymlWithFmvFlag(before) as string;
    expect(ymlWithoutFmvFlag(flagged)).toBe(before);
    // and the ficha still parses with everything else intact
    const back = parseInfoYml(ymlWithoutFmvFlag(flagged) as string) as Record<string, string>;
    expect(back['fmv']).toBeUndefined();
    expect(back['title']).toBe('Super Metroid');
    expect(back['sync_meta']).toBe('r7');
  });

  it('is idempotent — a second pass over its own output writes nothing', () => {
    const once = ymlWithoutFmvFlag('title: "F-Zero"\nfmv: 1\n') as string;
    expect(ymlWithoutFmvFlag(once)).toBeNull();
  });
});

/**
 * The flag is named after the `.fmv` but gates both media: the firmware reads `fmv:` into
 * `fmv_eligible` and probes `<rom>.fmv` and `<rom>.gss` inside it (gameinfo.c:522, 563-577). Every
 * ficha rewrite decides the flag from scratch, so getting this wrong silently switches a snapshot off.
 */
describe('fmvFlagFor — the ficha flag that gates the clip AND the snapshot', () => {
  it('keeps the flag for a game that only has the static snapshot', () => {
    // The bug this pins: `g.fmv === 'has' ? 1 : null` turned the `.gss` off on every ficha rewrite,
    // and nothing ever brought it back (the file is still there, so the category never reads missing).
    expect(fmvFlagFor({ fmv: 'none', snapshot: 'has' })).toBe(1);
  });

  it('keeps the flag for the clip, with or without a snapshot', () => {
    expect(fmvFlagFor({ fmv: 'has', snapshot: 'none' })).toBe(1);
    expect(fmvFlagFor({ fmv: 'has', snapshot: 'has' })).toBe(1);
  });

  it('clears it only when the card holds NEITHER', () => {
    expect(fmvFlagFor({ fmv: 'none', snapshot: 'none' })).toBeNull();
    expect(fmvFlagFor({})).toBeNull(); // a game that was never filled has neither field set
  });
});

/**
 * `man_slots` is the fmv flag's twin: three code paths rebuild a game's ficha from scratch, each drops
 * every key it does not name, and the map lives nowhere else. Losing it is not visible on the card, it
 * just silently returns the game to sha-only manual dedup.
 */
describe('manSlotsFor — the ficha field for the slot→document map', () => {
  it('serializes the entry map in slot order', () => {
    expect(manSlotsFor({ manSlots: new Map([[2, 'ahtd2trh'], [0, 'h5y4tn5i']]) })).toBe('0:h5y4tn5i,2:ahtd2trh');
  });
  it('is null for a card with no map — and for an entry that has not loaded one', () => {
    expect(manSlotsFor({ manSlots: null })).toBeNull();
    expect(manSlotsFor({ manSlots: new Map() })).toBeNull();
    expect(manSlotsFor({})).toBeNull(); // undefined: the callers are the ones that must preserve, not erase
  });
});

/**
 * `manSlotsField`, what each of the three ficha writers must put in `man_slots`.
 *
 * `undefined` on the entry means nobody looked, not "there is no map", and conflating the two erases a
 * key that lives nowhere else. Nothing visible breaks when it happens, which is exactly why it needs a
 * spec: the card keeps working, it just drops back to sha-only manual dedup.
 */
describe('manSlotsField — the three-writer rule', () => {
  it('takes the ENTRY as authoritative once it has been loaded', () => {
    const g = { manSlots: new Map([[0, 'h5y4tn5i']]) };
    expect(manSlotsField(g, '2:ahtd2trh')).toBe('0:h5y4tn5i'); // the entry just installed this; the card is behind
    expect(manSlotsField({ manSlots: null }, '2:ahtd2trh')).toBeNull(); // loaded and genuinely empty → clear it
  });
  it('PRESERVES what the card has when the entry never loaded a map', () => {
    expect(manSlotsField({}, '2:ahtd2trh')).toBe('2:ahtd2trh');
    expect(manSlotsField({}, undefined)).toBeNull();
  });
});

/**
 * planManualSlots, which slot each GameDB manual goes to, and which slots may be swept.
 *
 * The BUG this pins. Slot addressing used to be "primary → slot 0, extras → dedup by sha256, else the
 * first free slot". On 2026-08-08 the GameDB re-encoded all 3664 `.man` files (double-page split +
 * pre-quantization sharpening) and every manSha256 changed. Every extra manual stopped being recognized:
 * it took another free slot beside the copy it was meant to replace, and the games with the most
 * documents. Zelda ALTTP and Super Metroid have 5, i.e. 1 primary + 4 extras against 3 free slots,
 * ran out and reported `slotsfull` for a user who owned no duplicates at all.
 *
 * Half of these tests are about the other direction: this function can now delete and overwrite files,
 * so most of what follows pins what it must refuse to touch. The rule it enforces: a file the pass did
 * not just write may only be deleted or written over when its exact bytes are provably auto-fill's own
 * (served now, or recorded in the ficha's own `sync_man`), and a delete additionally needs a surviving
 * copy, already on the card or landing in this same pass.
 *
 * The tags below are groupUuid[:8] (`manGroupTag`); shas stand in for the real 64-hex digests, with
 * `v1` = the pre-re-encode bytes and `v2` = the current ones.
 */
describe('planManualSlots — slot addressing by DOCUMENT, not by bytes', () => {
  const doc = (tag: string, sha: string, type?: string) => ({ manualUrl: `/m/${tag}.man.zst`, sha256: sha, groupUuid: tag + 'ffffff', type });
  const card = (o: {
    occupied?: number[]; hashes?: [number, string][]; groups?: [number, string][]; synced?: string[]; probed?: boolean;
    heads?: [number, string][]; // slot → document type, as the `.man` header declares it
  } = {}) => ({
    probed: o.probed ?? true,
    occupied: new Set(o.occupied ?? (o.hashes ?? []).map(([nn]) => nn)),
    hashBySlot: new Map(o.hashes ?? []),
    headBySlot: new Map((o.heads ?? []).map(([nn, t]) => [nn, { slug: slugIdOfType(t) as number }])),
    groups: new Map(o.groups ?? []),
    synced: new Set((o.synced ?? []).map((s) => s.slice(0, 16))),
  });
  const writes = (p: ReturnType<typeof planManualSlots>) => p.steps.filter((s) => s.action === 'write').map((s) => [s.index, s.slot]);
  const fails = (p: ReturnType<typeof planManualSlots>) => p.steps.filter((s) => s.action === 'fail').map((s) => s.reason);
  const dropSlots = (p: ReturnType<typeof planManualSlots>) => p.drops.map((d) => d.slot);

  it('THE FIX: a re-encoded extra is rewritten IN ITS OWN SLOT — no new slot, no slotsfull', () => {
    const manuals = [doc('manual00', 'A-v2'), doc('other000', 'B-v2'), doc('map00000', 'C-v2'), doc('guide000', 'D-v2'), doc('insert00', 'E-v2')];
    // `sync_man` carries the v1 shas: the two keys are written by the same passes, so a ficha that has a
    // map has the receipts for what is in it, which is what lets the rewrite happen in place.
    const p = planManualSlots(manuals, card({
      hashes: [[0, 'A-v1'], [2, 'B-v1'], [3, 'C-v1'], [4, 'D-v1'], [5, 'E-v1']],
      groups: [[0, 'manual00'], [2, 'other000'], [3, 'map00000'], [4, 'guide000'], [5, 'insert00']],
      synced: ['A-v1', 'B-v1', 'C-v1', 'D-v1', 'E-v1'],
    }));
    expect(writes(p)).toEqual([[0, 0], [1, 2], [2, 3], [3, 4], [4, 5]]);
    expect(fails(p)).toEqual([]);
    expect(p.drops).toEqual([]); // every slot was reused. There is nothing to delete
    expect(p.map).toEqual(new Map([[0, 'manual00'], [2, 'other000'], [3, 'map00000'], [4, 'guide000'], [5, 'insert00']]));
  });

  /* The card that shipped the bug report, measured live on v1.21.0: Zelda ALTTP, five documents, five
     slots holding the pre-re-encode versions, and no `man_slots`, because the map only exists after a
     run has written one, and this is that run. v1.21.0 fell through to sha dedup, recognized nothing,
     allocated new slots and produced `Manual · Outro · Mapa · Guia · Encarte · Outro · Mapa · Guia` with
     a `slotsfull` for the fifth. The `.man` header's type slug is what the card can answer with on its
     own, 40 bytes per slot, the same read the guides dialog already does to label them. */
  const ZELDA = [
    doc('manual00', 'A-v2', 'manual'), doc('other000', 'B-v2', 'other'), doc('map00000', 'C-v2', 'map'),
    doc('guide000', 'D-v2', 'guide'), doc('insert00', 'E-v2', 'insert'),
  ];

  it('CLEANS UP the card the shared-bucket race duplicated: same documents in two sets of slots', () => {
    // What the user's card actually looks like after N copies of one filename (a control folder, a
    // letter folder, five patch folders) each installed the same documents into different slots. Every
    // one of those files is byte-identical to a document being served right now, so the proof is the
    // strongest kind there is: one copy of each is kept and the rest go, with no free slot needed.
    const three = [ZELDA[0], ZELDA[1], ZELDA[2]];
    const p = planManualSlots(three, card({
      hashes: [[0, 'A-v2'], [2, 'B-v2'], [3, 'C-v2'], [4, 'B-v2'], [5, 'C-v2'], [6, 'B-v2'], [7, 'C-v2']],
      heads: [[0, 'manual'], [2, 'other'], [3, 'map'], [4, 'other'], [5, 'map'], [6, 'other'], [7, 'map']],
      synced: ['A-v2', 'B-v2', 'C-v2'],
    }));
    expect(writes(p)).toEqual([]);                       // everything it wants is already there
    expect(fails(p)).toEqual([]);                        // and no slotsfull, though 7 slots are occupied
    expect(dropSlots(p).sort((a, b) => a - b)).toEqual([4, 5, 6, 7]); // the duplicate copies go
    expect(p.leftovers).toEqual([]);                     // nothing left unexplained for the user to judge
    expect([...p.map.keys()].sort((a, b) => a - b)).toEqual([0, 2, 3]); // and the map now names the survivors
  });

  it('THE REAL CARD: five old versions, no map — five rewrites IN PLACE, zero duplicates, zero slotsfull', () => {
    const p = planManualSlots(ZELDA, card({
      hashes: [[0, 'A-v1'], [2, 'B-v1'], [3, 'C-v1'], [4, 'D-v1'], [5, 'E-v1']],
      heads: [[0, 'manual'], [2, 'other'], [3, 'map'], [4, 'guide'], [5, 'insert']],
      // the ficha's own receipt for the bytes it installed before the server re-encoded them. Every
      // card auto-fill has ever filled carries one, and it is what separates these files from a guide
      // the user added by hand (which has no receipt and is therefore never adopted).
      synced: ['A-v1', 'B-v1', 'C-v1', 'D-v1', 'E-v1'],
    }));
    expect(writes(p)).toEqual([[0, 0], [1, 2], [2, 3], [3, 4], [4, 5]]); // every extra lands on its own slot
    expect(fails(p)).toEqual([]);                                        // ...so nothing runs out of room
    expect(p.drops).toEqual([]);                                         // ...and nothing is deleted to get there
    expect(p.leftovers).toEqual([]);
    expect(p.adopted).toEqual([
      { slot: 2, type: 'other' }, { slot: 3, type: 'map' }, { slot: 4, type: 'guide' }, { slot: 5, type: 'insert' },
    ]);
    // and the card ends up with the identity it was missing, so the next re-encode needs no header at all
    expect(p.map).toEqual(new Map([[0, 'manual00'], [2, 'other000'], [3, 'map00000'], [4, 'guide000'], [5, 'insert00']]));
  });

  it("NEVER adopts a user's own guide on a LEGACY card — the `u` marker does not exist there yet", () => {
    // The hole a fuzz found in production: `addGuide` stamps the same document types the GameDB uses,
    // so a map the user scanned themselves is type-identical to the official one. On a card with no
    // `man_slots` (every card until this release) the user-marker cannot protect it, only the ficha's
    // receipt can: those bytes were never installed by auto-fill, so they are never adopted.
    const p = planManualSlots(ZELDA, card({
      hashes: [[0, 'A-v1'], [2, 'USER-SCAN'], [3, 'C-v1']],
      heads: [[0, 'manual'], [2, 'map'], [3, 'map']],
      synced: ['A-v1', 'C-v1'],           // the user's scan is absent. That is the whole proof
    }));
    expect(p.adopted).toEqual([{ slot: 3, type: 'map' }]); // the official old map is adopted...
    expect(writes(p).some(([, slot]) => slot === 2)).toBe(false); // ...and the user's is never written over
    expect(p.drops.some((d) => d.slot === 2)).toBe(false);        // nor deleted
    expect(p.leftovers).toEqual([2]);                             // just reported, for the user to judge
  });

  it("…and does so when it is the SOLE candidate — the case where only the receipt can say no", () => {
    // Same invariant, one slot fewer. It matters because the fixture above has two `map` slots, so
    // deleting the receipt guard still leaves adoption refusing to guess between them: the test would
    // go green for the wrong reason. Here the user's scan is the only slot of its type, so the receipt
    // is the single thing standing between it and being written over. Drop the guard and this fails.
    const p = planManualSlots(ZELDA, card({
      hashes: [[0, 'A-v1'], [2, 'USER-SCAN']],
      heads: [[0, 'manual'], [2, 'map']],
      synced: ['A-v1'],
    }));
    expect(p.adopted).toEqual([]);
    expect(writes(p).some(([, slot]) => slot === 2)).toBe(false);
    expect(p.drops.some((d) => d.slot === 2)).toBe(false);
    expect(p.leftovers).toEqual([2]);
  });

  it('converges the card the bug ALREADY duplicated: 5 old + 3 new → the correct 5, in place', () => {
    // What v1.21.0 leaves behind: the new copies spilled into 6/7/8 while the old ones still sit in 2..5.
    const p = planManualSlots(ZELDA, card({
      hashes: [[0, 'A-v1'], [2, 'B-v1'], [3, 'C-v1'], [4, 'D-v1'], [5, 'E-v1'], [6, 'B-v2'], [7, 'C-v2'], [8, 'D-v2']],
      heads: [[0, 'manual'], [2, 'other'], [3, 'map'], [4, 'guide'], [5, 'insert'], [6, 'other'], [7, 'map'], [8, 'guide']],
      synced: ['A-v1', 'B-v1', 'C-v1', 'D-v1', 'E-v1'],
    }));
    // B/C/D are recognized by bytes where they already are; only E has no copy at all, and it adopts the
    // old insert in slot 5, in place, so slots never run out and nothing is deleted.
    expect(writes(p)).toEqual([[0, 0], [4, 5]]);
    expect(p.steps.filter((s) => s.action === 'skip').map((s) => s.slot)).toEqual([6, 7, 8]);
    expect(fails(p)).toEqual([]);
    expect(p.adopted).toEqual([{ slot: 5, type: 'insert' }]);
    // The stragglers are provable here: the ficha's `sync_man` records those exact bytes as auto-fill's
    // own, and each document survives in the slot that skipped, so they go, but only after every write
    // has landed (`after: 'all'`). Nothing is guessed: a card with no receipt keeps them as leftovers.
    expect(p.drops).toEqual([
      { slot: 2, reason: 'obsolete', after: 'all' },
      { slot: 3, reason: 'obsolete', after: 'all' },
      { slot: 4, reason: 'obsolete', after: 'all' },
    ]);
    expect(p.leftovers).toEqual([])
    expect(p.map).toEqual(new Map([[0, 'manual00'], [5, 'insert00'], [6, 'other000'], [7, 'map00000'], [8, 'guide000']]));
  });

  it('AMBIGUOUS types are never adopted — two unexplained slots of one type, and it guesses neither', () => {
    const p = planManualSlots([doc('manual00', 'A-v2', 'manual'), doc('map00000', 'C-v2', 'map')], card({
      hashes: [[0, 'A-v2'], [2, 'X'], [3, 'Y']],
      heads: [[0, 'manual'], [2, 'map'], [3, 'map']], // which one is the old official map? unknowable
    }));
    expect(writes(p)).toEqual([[1, 4]]); // a free slot, exactly as before the adoption rule existed
    expect(p.adopted).toEqual([]);
    expect(p.drops).toEqual([]);
  });

  it('a slot marked as the USER`s is never adopted, even as the only one of its type', () => {
    const p = planManualSlots([doc('manual00', 'A-v2', 'manual'), doc('map00000', 'C-v2', 'map')], card({
      hashes: [[0, 'A-v2'], [2, 'USER-MAP']],
      heads: [[0, 'manual'], [2, 'map']],
      groups: [[0, 'manual00'], [2, MAN_USER_TAG]], // addGuide stamped slot 2 as theirs
    }));
    expect(writes(p)).toEqual([[1, 3]]); // their map is untouched; the official one takes a free slot
    expect(p.adopted).toEqual([]);
    expect(p.drops).toEqual([]);
    expect(p.leftovers).toEqual([]);
    expect(p.map.get(2)).toBe(MAN_USER_TAG); // ...and the marker survives the rewrite
  });

  it('a document of a type the card has never held still takes a free slot', () => {
    const p = planManualSlots([doc('manual00', 'A-v2', 'manual'), doc('brandnew', 'N-v1', 'insert')], card({
      hashes: [[0, 'A-v2'], [2, 'OLD-MAP']],
      heads: [[0, 'manual'], [2, 'map']],
    }));
    expect(writes(p)).toEqual([[1, 3]]);
    expect(p.adopted).toEqual([]);
    expect(p.leftovers).toEqual([]); // slot 2's type is not one the GameDB serves here → not even suspected
  });

  it('adoption never takes a slot holding a version the GameDB serves RIGHT NOW', () => {
    /* Slot 2 holds the current bytes of document B, but B is listed without a `.man` to download, so it
       never gets bound to that slot. Another document of the same type must not be allowed to take it on
       type alone: byte identity outranks type identity, and the file sitting there is the good copy. */
    const p = planManualSlots([
      doc('manual00', 'A-v2', 'manual'),
      { manualUrl: null, sha256: 'B-v2', groupUuid: 'other000ff', type: 'map' }, // listed, not published
      doc('map00000', 'C-v2', 'map'),
    ], card({
      hashes: [[0, 'A-v2'], [2, 'B-v2']],
      heads: [[0, 'manual'], [2, 'map']],
    }));
    expect(fails(p)).toEqual(['nofile']);
    expect(writes(p)).toEqual([[2, 3]]); // C takes a free slot, never B's current copy
    expect(p.adopted).toEqual([]);
    expect(p.leftovers).toEqual([]);
  });

  it('a USER-marked slot is out of reach of adoption AND of every sweep', () => {
    // Their own copy of a document the GameDB also serves, byte-identical to the official one in slot 2,
    // duplicate content, right type, and still untouchable: the marker says the slot is theirs.
    const p = planManualSlots([doc('manual00', 'A-v2', 'manual'), doc('other000', 'B-v2', 'map'), doc('map00000', 'C-v2', 'map')], card({
      hashes: [[0, 'A-v2'], [2, 'B-v2'], [3, 'B-v2']],
      heads: [[0, 'manual'], [2, 'map'], [3, 'map']],
      groups: [[3, MAN_USER_TAG]],
      synced: ['A-v2', 'B-v2'],
    }));
    expect(p.drops).toEqual([]);          // byte-identical to slot 2 and receipted, still not ours to remove
    expect(p.adopted).toEqual([]);
    expect(writes(p)).toEqual([[2, 4]]);  // C goes to a free slot, not over their guide
    expect(p.map.get(3)).toBe(MAN_USER_TAG);
  });

  it('…and the SAME card without a map is what produced the bug: 3 free slots for 4 new documents', () => {
    // The legacy fallback, kept deliberately: with no map and no matching bytes, free slots are the only
    // thing a card can offer. What it must not do is start deleting to make room.
    const manuals = [doc('manual00', 'A-v2'), doc('other000', 'B-v2'), doc('map00000', 'C-v2'), doc('guide000', 'D-v2'), doc('insert00', 'E-v2')];
    const p = planManualSlots(manuals, card({ hashes: [[0, 'A-v1'], [2, 'B-v1'], [3, 'C-v1'], [4, 'D-v1'], [5, 'E-v1']] }));
    expect(writes(p)).toEqual([[0, 0], [1, 6], [2, 7], [3, 8]]);
    expect(fails(p)).toEqual(['slotsfull']);
    expect(p.drops).toEqual([]); // no `sync_man` receipt → nothing is provably ours → nothing is touched
  });

  it('repairs the card the bug already filled: RECLAIM for room, sweep the rest only after the writes', () => {
    /* The card as the bug left it: slots 2..5 hold the pre-re-encode copies, 6..8 the new ones the old
       code spilled into free slots, and the 5th document never fit. `sync_man` still lists the v1 shas.
       the ficha's own receipt that AUTO-FILL put those bytes there, which is what makes removing them a
       proof rather than a guess (a user's guide is never in it). */
    const manuals = [doc('manual00', 'A-v2'), doc('other000', 'B-v2'), doc('map00000', 'C-v2'), doc('guide000', 'D-v2'), doc('insert00', 'E-v2')];
    const p = planManualSlots(manuals, card({
      hashes: [[0, 'A-v1'], [2, 'B-v1'], [3, 'C-v1'], [4, 'D-v1'], [5, 'E-v1'], [6, 'B-v2'], [7, 'C-v2'], [8, 'D-v2']],
      synced: ['A-v1', 'B-v1', 'C-v1', 'D-v1', 'E-v1'],
    }));
    // slot 2 is reclaimed, written straight over, never deleted first, so a failed download cannot
    // leave the card with neither version. That is what makes room for the document that never fit.
    expect(writes(p)).toEqual([[0, 0], [4, 2]]);
    expect(fails(p)).toEqual([]); // no `slotsfull` any more, repaired in one pass
    // the remaining orphans wait for every write to land: no single new slot replaces any one of them
    expect(p.drops).toEqual([
      { slot: 3, reason: 'obsolete', after: 'all' },
      { slot: 4, reason: 'obsolete', after: 'all' },
      { slot: 5, reason: 'obsolete', after: 'all' },
    ]);
    expect(p.map).toEqual(new Map([[0, 'manual00'], [2, 'insert00'], [6, 'other000'], [7, 'map00000'], [8, 'guide000']]));
  });

  it('NEVER sweeps a user guide — not even two byte-identical ones (addGuide does not dedup)', () => {
    // The property the receipt rule actually buys. Two identical scans the user added: byte-duplicates,
    // and the old "keep the lowest" rule would have deleted slot 5 during a manual update run.
    const p = planManualSlots([doc('manual00', 'A-v2')], card({
      hashes: [[0, 'A-v2'], [3, 'USER-SCAN'], [5, 'USER-SCAN']],
      synced: ['A-v2'],
    }));
    expect(p.drops).toEqual([]);      // no receipt for those bytes → they are not ours to remove
    expect(writes(p)).toEqual([]);
  });

  it('…but DOES sweep a byte-identical pair auto-fill itself installed', () => {
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('other000', 'B-v2')], card({
      hashes: [[0, 'A-v2'], [3, 'B-v2'], [5, 'B-v2']],
      synced: ['A-v2', 'B-v2'],
    }));
    expect(p.drops).toEqual([{ slot: 5, reason: 'dup', after: null }]); // survivor already on card → delete now
    expect(writes(p)).toEqual([]);
  });

  it('never deletes EVERY copy: one of a duplicated pair goes, and the survivor is off limits after', () => {
    // The map names one document twice and both copies are byte-identical, two chances to condemn the
    // same pair. Electing slot 2 (already condemned by the map) as the byte-survivor used to condemn
    // slot 3 as well: both copies gone, nothing written in their place.
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('other000', 'B-v2')], card({
      hashes: [[0, 'A-v2'], [2, 'B-v2'], [3, 'B-v2']],
      groups: [[2, 'other000'], [3, 'other000']],
      synced: ['A-v2', 'B-v2'],
    }));
    expect(p.drops).toEqual([{ slot: 3, reason: 'dup', after: null }]); // exactly one of the pair
    expect(dropSlots(p)).not.toContain(2);   // ...and the survivor is never swept by the obsolete pass either
    expect(p.map).toEqual(new Map([[0, 'manual00'], [2, 'other000']]));
  });

  it('leaves BOTH alone when the duplicated bytes name no document the GameDB still serves', () => {
    // Same shape, but the pair holds a version nothing on the server matches: there is no proof of which
    // one (if either) is the copy to keep, so neither is a `dup`. The obsolete pass would need the served
    // set to be intact, and here it has shrunk, so nothing is touched at all.
    const p = planManualSlots([doc('manual00', 'A-v2')], card({
      hashes: [[0, 'A-v2'], [2, 'X'], [3, 'X']],
      groups: [[2, 'other000'], [3, 'other000']],
      synced: ['A-v2', 'X'],
    }));
    expect(p.drops).toEqual([]);
  });

  it('a document promoted to PRIMARY leaves its old slot behind as an obsolete leftover, not a "dup"', () => {
    // Slot 2 holds B-v1, the old bytes of the document that just moved to slot 0. Nothing on the card
    // is a second copy of anything current, so it is not a duplicate: it is one of auto-fill's orphans,
    // and it waits behind the "every write landed" gate like the rest of them.
    const p = planManualSlots([doc('other000', 'B-v2'), doc('manual00', 'A-v2')], card({
      hashes: [[0, 'A-v1'], [2, 'B-v1']],
      groups: [[0, 'manual00'], [2, 'other000']],
      synced: ['A-v1', 'B-v1'],
    }));
    expect(writes(p)).toEqual([[0, 0], [1, 3]]);
    expect(p.drops).toEqual([{ slot: 2, reason: 'obsolete', after: 'all' }]);
    expect(p.map).toEqual(new Map([[0, 'other000'], [3, 'manual00']]));
  });

  it('NEVER deletes the last copy of a served document: the survivor is resolved from BYTES, after the plan', () => {
    /* The repro, on a map that is 100% true and a card with no user file on it, the state the 08/08 bug
       left behind. Slots 0 and 8 both hold B; the GameDB now leads with A.
         steps: write A into slot 0 · skip B (found at slot 8)
       Electing slot 8's survivor up front picked slot 0 (the other copy of B) and emitted
       `after: 0`, which the write of A then "satisfied", deleting the only remaining B. The pass looked
       clean, so `sync_man` was stamped complete and fillStale never offered B again: gone for good.
       Resolving the survivor from the slot's own bytes, after the steps loop, says B lives at slot 8.
       which is slot 8, so there is nothing to delete. */
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('other000', 'B-v2')], card({
      hashes: [[0, 'B-v2'], [8, 'B-v2']],
      groups: [[0, 'other000'], [8, 'other000']],
      synced: ['B-v2'],
    }));
    expect(writes(p)).toEqual([[0, 0]]);
    expect(p.steps.filter((s) => s.action === 'skip').map((s) => s.slot)).toEqual([8]);
    expect(p.drops).toEqual([]); // slot 8 is where B ends up. Deleting it would take the document with it
    expect(p.map).toEqual(new Map([[0, 'manual00'], [8, 'other000']]));
  });

  it('a suspect slot the map names but whose BYTES name nothing served is never a "dup"', () => {
    // Two ROMs sharing a stem share one ficha, so a `man_slots` written for one describes the other's
    // slots. A slot condemned on that say-so alone, with no byte evidence, must not be deleted as a
    // duplicate. At most it is an orphan, and only with a `sync_man` receipt.
    const p = planManualSlots([doc('manual00', 'A-v2')], card({
      hashes: [[0, 'A-v2'], [3, 'SOMETHING-ELSE']],
      groups: [[0, 'manual00'], [3, 'manual00']], // the map claims slot 3 holds the primary too
    }));
    expect(p.drops).toEqual([]);
    expect(writes(p)).toEqual([]);
  });

  it('two served manuals sharing a groupUuid never silently overwrite each other', () => {
    // Impossible through the GameDB's unique index, which is exactly why it must not pass unnoticed.
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('twinnnnn', 'B-v2'), doc('twinnnnn', 'C-v2')], card({
      hashes: [[0, 'A-v2']],
    }));
    expect(writes(p)).toEqual([[1, 2]]);
    expect(fails(p)).toEqual(['dupdoc']);
  });

  it('a document DEMOTED out of the primary is still installed (it used to vanish, silently, forever)', () => {
    /* Map `0:A`, and the GameDB now serves [B, A], B promoted, A demoted to extra. `claim` used to set
       the forward entry without clearing the reverse one, so `where` still said "A is in slot 0"; the
       extra a hit the "that is the primary" shortcut and was never written. The run then reported
       wrote=1/failed=0, stamped a complete `sync_man`, and the category read as up to date for ever.
       A simply gone from the card, with nothing in the report. */
    const p = planManualSlots([doc('other000', 'B-v2'), doc('manual00', 'A-v2')], card({
      hashes: [[0, 'A-v1']], groups: [[0, 'manual00']], synced: ['A-v1'],
    }));
    expect(writes(p)).toEqual([[0, 0], [1, 2]]); // A lands in a real slot
    expect(p.steps.some((s) => s.action === 'skip')).toBe(false);
    expect(p.map).toEqual(new Map([[0, 'other000'], [2, 'manual00']]));
  });

  it('same, for a primary the GameDB gives no groupUuid for over a map that names slot 0', () => {
    const p = planManualSlots([
      { manualUrl: '/m/p.man.zst', sha256: 'P-v1', groupUuid: null },
      doc('manual00', 'A-v2'),
    ], card({ hashes: [[0, 'A-v1']], groups: [[0, 'manual00']], synced: ['A-v1'] }));
    expect(writes(p)).toEqual([[0, 0], [1, 2]]);
    expect(p.map).toEqual(new Map([[2, 'manual00']])); // slot 0 has no identity to record
  });

  it('a STALE map entry never silently overwrites a file we cannot prove we wrote', () => {
    // `2:T` in the ficha, but slot 2 holds something with no receipt. The user's. Writing T there is the
    // one place the app would destroy a file it did not create, without a word. It takes a free slot.
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('other000', 'T-v2')], card({
      hashes: [[0, 'A-v2'], [2, 'USER-SCAN']], groups: [[2, 'other000']], synced: ['A-v2'],
    }));
    expect(writes(p)).toEqual([[1, 3]]);
    expect(p.drops).toEqual([]);
    expect(p.map).toEqual(new Map([[0, 'manual00'], [3, 'other000']]));
  });

  it('forgets a slot the map names but the card does not hold (a phantom reservation)', () => {
    // A write that failed (or a file deleted behind our back) must not lock that slot away for ever,
    // addGuide excludes reserved slots, so a phantom would leave the user no way to use it.
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('other000', 'T-v2')], card({
      occupied: [0, 3], hashes: [[0, 'A-v2'], [3, 'USER-SCAN']], groups: [[2, 'other000']],
    }));
    expect(writes(p)).toEqual([[1, 2]]); // slot 2 is simply free again
    expect(p.map).toEqual(new Map([[0, 'manual00'], [2, 'other000']]));
  });

  it('drops slots the ficha names that are not addressable guide slots at all', () => {
    const p = planManualSlots([doc('manual00', 'A-v2')], card({
      hashes: [[0, 'A-v2']], groups: [[1, 'bogus000'], [42, 'bogus111'], [0, 'manual00']],
    }));
    expect(p.map).toEqual(new Map([[0, 'manual00']])); // 1 and 42 are not slots man.js names
  });

  it('a TRUNCATED GameDB answer never reads as "these documents were retired"', () => {
    // Precedent: the 2026-08 sweep that briefly 404'd every `.s2pkg` variant. If the served set has
    // shrunk against `sync_man`, the obsolete sweep is off entirely.
    const p = planManualSlots([doc('manual00', 'A-v2')], card({
      hashes: [[0, 'A-v1'], [2, 'B-v1'], [3, 'C-v1']],
      synced: ['A-v1', 'B-v1', 'C-v1'],
    }));
    expect(p.drops).toEqual([]);
    expect(writes(p)).toEqual([[0, 0]]);
  });

  it('LEARNS the map from a card that is already correct — without moving a single file', () => {
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('other000', 'B-v2')], card({
      hashes: [[0, 'A-v2'], [3, 'B-v2']],
    }));
    expect(writes(p)).toEqual([]);
    expect(p.drops).toEqual([]);
    expect(p.map).toEqual(new Map([[0, 'manual00'], [3, 'other000']]));
  });

  it('an UNPROBED pass carries the stored map over untouched and sweeps nothing', () => {
    // installManuals skips the listing when the status probe says the game has no `.man` at all; the
    // planner then knows nothing about the card and must not "prune" the map to empty.
    const p = planManualSlots([doc('manual00', 'A-v2')], card({ probed: false, groups: [[0, 'manual00'], [2, 'other000']] }));
    expect(writes(p)).toEqual([[0, 0]]);
    expect(p.drops).toEqual([]);
    expect(p.map).toEqual(new Map([[0, 'manual00'], [2, 'other000']]));
  });

  it('a genuinely NEW document still takes the first free user slot', () => {
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('brandnew', 'N-v1')], card({
      hashes: [[0, 'A-v2'], [2, 'USER'], [3, 'USER2']], groups: [[0, 'manual00']],
    }));
    expect(writes(p)).toEqual([[1, 4]]); // 2 and 3 are the user's. The first free slot is 4
    expect(p.map).toEqual(new Map([[0, 'manual00'], [4, 'brandnew']]));
  });

  it('reports slotsfull only when there is genuinely no room for a NEW document', () => {
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('brandnew', 'N-v1')], card({
      hashes: [[0, 'A-v2'], [2, 'U'], [3, 'U3'], [4, 'U4'], [5, 'U5'], [6, 'U6'], [7, 'U7'], [8, 'U8']],
      groups: [[0, 'manual00']],
    }));
    expect(writes(p)).toEqual([]);
    expect(fails(p)).toEqual(['slotsfull']);
    expect(p.drops).toEqual([]); // a full card of user guides is full: nothing gets deleted to make room
  });

  it('keeps the primary`s in-place rules: skip identical bytes, `force` rewrites an unprovable slot 0', () => {
    const withSha = [doc('manual00', 'A-v2')];
    expect(writes(planManualSlots(withSha, card({ hashes: [[0, 'A-v2']] })))).toEqual([]);         // identical → nothing
    expect(writes(planManualSlots(withSha, card({ hashes: [[0, 'A-v1']] })))).toEqual([[0, 0]]);   // stale → in place
    // the deprecated scalar `manualUrl` path has no sha at all: rewrite only when forced, or when empty
    const noSha = [{ manualUrl: '/m/x.man.zst', sha256: null, groupUuid: null }];
    expect(writes(planManualSlots(noSha, card({ occupied: [0] })))).toEqual([]);
    expect(writes(planManualSlots(noSha, card({ occupied: [0] }), { force: true }))).toEqual([[0, 0]]);
    expect(writes(planManualSlots(noSha, card()))).toEqual([[0, 0]]);
  });

  it('keeps the report reasons: a manual the GameDB lists but cannot serve, and a sha-less EXTRA', () => {
    const p = planManualSlots([
      doc('manual00', 'A-v2'),
      { manualUrl: null, sha256: 'B-v2', groupUuid: 'other000ff' },        // listed, no `.man` published
      { manualUrl: '/m/c.man.zst', sha256: null, groupUuid: 'map00000ff' }, // no sha → cannot be deduped
    ], card({ hashes: [[0, 'A-v2']] }));
    expect(fails(p)).toEqual(['nofile', 'nosha']);
    expect(writes(p)).toEqual([]);
  });

  it('never copies the primary into a user slot when it really is the slot-0 document', () => {
    const p = planManualSlots([doc('manual00', 'A-v2'), doc('manual00', 'A-v2')], card({
      hashes: [[0, 'A-v2']], groups: [[0, 'manual00']],
    }));
    expect(writes(p)).toEqual([]);
    expect(p.map).toEqual(new Map([[0, 'manual00']]));
  });
});

describe('groupManualBuckets', () => {
  const bucketOf = (e: { stem: string }) => e.stem;
  const docsOf = (e: { docs: number }) => e.docs;
  const mk = (id: string, stem: string, docs: number) => ({ id, stem, docs });

  it('elects ONE owner for every copy of a game that shares a `.man` bucket', () => {
    // The card that produced the bug: one filename under a control folder, its letter folder and five
    // patch folders. Seven entries, one set of eight slots, and before this, seven competing plans,
    // each spilling its extras past what the previous one had just written.
    const smw = ['_CONTROL', 'S', 'SMW-A', 'SMW-B', 'SMW-C', 'SMW-D', 'SMW-E']
      .map((f) => mk(`smw-${f}`, 'Super Mario World (USA)', 4));
    const g = groupManualBuckets(smw, bucketOf, docsOf);
    expect(g.length).toBe(1);
    expect(g[0].members.length).toBe(7);
    // All seven offer the same documents, so the tie-break decides, and what matters is only that it
    // is deterministic: the same copy wins every run, so the card converges instead of oscillating.
    expect(g[0].owner.id).toBe([...smw].map((e) => e.id).sort()[0]);
    expect(groupManualBuckets([...smw].reverse(), bucketOf, docsOf)[0].owner.id).toBe(g[0].owner.id);
  });

  it('keeps distinct stems independent', () => {
    const g = groupManualBuckets([mk('a', 'Zelda', 5), mk('b', 'Metroid', 5)], bucketOf, docsOf);
    expect(g.length).toBe(2);
    expect(new Set(g.map((x) => x.owner.id))).toEqual(new Set(['a', 'b']));
  });

  it('prefers the FULLEST document set — the shared files should end up as complete as possible', () => {
    // A patched copy the GameDB matched to a thinner entry must not decide what the shared slots hold.
    const g = groupManualBuckets(
      [mk('patch', 'Zelda', 1), mk('clean', 'Zelda', 5), mk('other', 'Zelda', 3)], bucketOf, docsOf);
    expect(g[0].owner.id).toBe('clean');
  });

  it('breaks ties by id, so a re-run elects the same owner and the card converges', () => {
    const a = groupManualBuckets([mk('z', 'X', 2), mk('a', 'X', 2)], bucketOf, docsOf)[0].owner.id;
    const b = groupManualBuckets([mk('a', 'X', 2), mk('z', 'X', 2)], bucketOf, docsOf)[0].owner.id;
    expect(a).toBe('a');
    expect(b).toBe('a');
  });

  it('is empty for an empty run', () => {
    expect(groupManualBuckets([], bucketOf, docsOf)).toEqual([]);
  });
});

/**
 * The ping-pong that kept auto-fill re-offering the same games after every run: two different games
 * sharing one `<stem>.yml`, each reading the version the other had recorded as "outdated".
 */
describe('electFichaOwners — who speaks for a shared ficha', () => {
  const mk = (id: string, file: string, rom?: string) => ({ id, file, rom });
  const elect = (es: ReturnType<typeof mk>[]) =>
    electFichaOwners(es, () => 'info/CH/chou aniki', (e) => e.id, (e) => e.rom === e.file);

  it('elects the copy the ficha NAMES — the SNES/Satellaview case that started this', () => {
    // `C/Chou Aniki (Japan).sfc` and `_BSX/Chou Aniki (Japan).bs`: different GameDB games, one ficha.
    const snes = mk('a', 'Chou Aniki (Japan).sfc', 'Chou Aniki (Japan).sfc');
    const bsx = mk('b', 'Chou Aniki (Japan).bs', 'Chou Aniki (Japan).sfc'); // ficha names the .sfc
    expect(elect([snes, bsx]).get('info/CH/chou aniki')).toBe('a');
    expect(elect([bsx, snes]).get('info/CH/chou aniki')).toBe('a'); // and order cannot change it
  });

  it('still elects exactly ONE when the ficha names them all — copies of one filename in subfolders', () => {
    // `Contra SNES/Contra SNES.sfc` + the USA and jpn builds in `sfc choice/`: `rom:` records only the
    // Filename, so it names every one of them. This is what 1.21.6 got wrong and 1.21.7 fixed.
    const cs = ['b', 'a', 'c'].map((id) => mk(id, 'Contra SNES.sfc', 'Contra SNES.sfc'));
    const owners = elect(cs);
    expect(owners.size).toBe(1);
    expect(owners.get('info/CH/chou aniki')).toBe('a'); // lowest id, deterministic, so the card settles
  });

  it('elects one even when the ficha names NOBODY (legacy, or written by another tool)', () => {
    const owners = elect([mk('z', 'X.sfc'), mk('a', 'X.bs')]);
    expect(owners.size).toBe(1);
    expect(owners.get('info/CH/chou aniki')).toBe('a');
  });

  it('prefers the copy you actually PLAY over a spare buried in a subfolder', () => {
    // The ficha carries the owner's title and description, and the console shows them for every copy,
    // so `_INFIDELITY/Metroid SNES/Metroid SNES.sfc` must win over the one in `bkup/` beside it, even
    // though the tie-break by id had picked the spare.
    const main = { id: 'z', file: 'Metroid SNES.sfc', rom: undefined, depth: 1 };
    const bkup = { id: 'a', file: 'Metroid SNES.sfc', rom: undefined, depth: 2 };
    const owners = electFichaOwners([bkup, main], () => 'k', (e) => e.id, () => false, (e) => e.depth);
    expect(owners.get('k')).toBe('z');
    expect(electFichaOwners([main, bkup], () => 'k', (e) => e.id, () => false, (e) => e.depth).get('k')).toBe('z');
  });

  it('lets the ficha OVERRIDE depth — a named copy wins wherever it sits', () => {
    const deep = { id: 'a', file: 'X.sfc', rom: 'X.sfc', depth: 3 };
    const shallow = { id: 'b', file: 'X.bs', rom: 'X.sfc', depth: 0 }; // not named (its file differs)
    const owners = electFichaOwners([shallow, deep], () => 'k', (e) => e.id, (e) => e.rom === e.file, (e) => e.depth);
    expect(owners.get('k')).toBe('a');
  });

  it('is stable under reordering — the property the whole fix rests on', () => {
    const es = [mk('c', 'X.bs'), mk('a', 'X.sfc', 'X.sfc'), mk('b', 'X.smc')];
    const first = elect(es).get('info/CH/chou aniki');
    expect(elect([...es].reverse()).get('info/CH/chou aniki')).toBe(first);
    expect(first).toBe('a');
  });

  it('keeps games with their own ficha independent — every one of them owns it', () => {
    const owners = electFichaOwners(
      [mk('a', 'Zelda.sfc'), mk('b', 'Metroid.sfc')],
      (e) => 'info/' + e.file, (e) => e.id, () => false);
    expect(owners.size).toBe(2);
    expect([...owners.values()].sort()).toEqual(['a', 'b']);
  });

  it('is empty for an empty library', () => {
    expect(electFichaOwners([], () => 'k', () => 'i', () => false).size).toBe(0);
  });
});

describe('fichaKeyOf — two ROMs share a ficha exactly when the card cannot tell them apart', () => {
  const k = (stem: string, sgb = false) => fichaKeyOf({ stem, sgb, mode: 'buckets' });

  it('is the same for two ROMs with the same filename (this is the sharing itself)', () => {
    expect(k('Chou Aniki (Japan)')).toBe(k('Chou Aniki (Japan)'));
  });

  it('folds case — FAT resolves case-insensitively, so these are ONE file', () => {
    expect(k('TETRIS')).toBe(k('Tetris'));
  });

  it('keeps Game Boy apart — the one namespace the firmware does honour', () => {
    expect(k('Tetris', true)).not.toBe(k('Tetris', false));
  });
});
