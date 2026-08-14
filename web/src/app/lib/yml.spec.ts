import { describe, it, expect } from 'vitest';
import { buildYml, descLangFields, parseInfoYml, shaFromAssetUrl, syncTokensFromMatch, ymlFieldsFromMatch, DESC_LANGS, DESC_LANG_KEYS, SYNC_KEYS,
         MAN_SLOTS_KEY, MAN_USER_TAG, manGroupTag, parseManSlots, serializeManSlots } from './yml.js';

describe('shaFromAssetUrl', () => {
  it('extracts the content hash (sha16) from a package/pcm CDN URL', () => {
    expect(shaFromAssetUrl('https://cdn.example.com/assets/packages/D63ED5F8.a1b2c3d4e5f6a7b8.s2pkg')).toBe('a1b2c3d4e5f6a7b8');
    expect(shaFromAssetUrl('https://cdn/x/9B8DEC8F.0011223344556677.pcm.zst')).toBe('0011223344556677');
  });
  it('ignores query/hash and the local-fallback URL (no content hash)', () => {
    expect(shaFromAssetUrl('/x/D63ED5F8.a1b2c3d4e5f6a7b8.s2pkg?v=2#frag')).toBe('a1b2c3d4e5f6a7b8');
    expect(shaFromAssetUrl('/api/packages/D63ED5F8')).toBeNull(); // local fallback → no hash
    expect(shaFromAssetUrl(null)).toBeNull();
  });
});

describe('publisher', () => {
  it('rides in the gameInfo right after developer', () => {
    const yml: string = buildYml({ title: 'Super Mario World', developer: 'Nintendo EAD', publisher: 'Nintendo of America, Inc.', release_year: '1991' });
    expect(yml).toContain('publisher: "Nintendo of America, Inc."');
    expect(yml.indexOf('developer:')).toBeLessThan(yml.indexOf('publisher:'));
    expect(yml.indexOf('publisher:')).toBeLessThan(yml.indexOf('release_year:'));
  });

  it('is omitted when the GameDB has none, and survives a parse + rebuild', () => {
    expect(buildYml({ title: 'Tetris', publisher: null })).not.toContain('publisher');
    const back = parseInfoYml(buildYml({ title: 'Super Mario World', publisher: 'Nintendo of America, Inc.' })) as Record<string, string>;
    expect(back['publisher']).toBe('Nintendo of America, Inc.');
    // the rewrite paths rebuild from exactly this object; the value has to come out the other side
    expect(buildYml(back)).toContain('publisher: "Nintendo of America, Inc."');
  });

  it('ymlFieldsFromMatch carries it from the match', () => {
    const f = ymlFieldsFromMatch(
      { title: 'Super Mario World', developer: 'Nintendo EAD', publisher: 'Nintendo of America, Inc.', videoUrl: null },
      { romName: 'Super Mario World (USA).sfc', crc: 'B19ED489', region: 'USA' },
    ) as Record<string, unknown>;
    expect(f['developer']).toBe('Nintendo EAD');
    expect(f['publisher']).toBe('Nintendo of America, Inc.');
  });
});

describe('syncTokensFromMatch', () => {
  it('derives all four tokens from a resolved match', () => {
    const t = syncTokensFromMatch({
      packageUrl: '/p/AAAAAAAA.a1b2c3d4e5f6a7b8.s2pkg',
      pcmUrl: '/p/AAAAAAAA.00112233aabbccdd.pcm.zst',
      metaRev: '7c1f9adeadbeef00',
      manuals: [
        { sha256: 'f'.repeat(64), sortOrder: 2, manualUrl: '/m/second.man.zst' },
        { sha256: 'a'.repeat(64), sortOrder: 1, manualUrl: '/m/first.man.zst' },
      ],
    });
    expect(t.sync_pkg).toBe('a1b2c3d4e5f6a7b8');
    expect(t.sync_pcm).toBe('00112233aabbccdd');
    expect(t.sync_meta).toBe('7c1f9adeadbeef00');
    // manuals joined by sortOrder (1 before 2), each sha256[:16]
    expect(t.sync_man).toBe('aaaaaaaaaaaaaaaa.ffffffffffffffff');
  });
  it('yields null tokens when the match lacks a package / audio / manuals / metaRev', () => {
    const t = syncTokensFromMatch({ packageUrl: null, pcmUrl: null, metaRev: null, manuals: [] });
    expect(t).toEqual({ sync_pkg: null, sync_pcm: null, sync_man: null, sync_meta: null });
  });
  it('ignores a manual the GameDB lists but cannot serve (no `.man` published)', () => {
    // Counting it would make sync_man unreachable: auto-fill has nothing to download for that entry,
    // so it could never stamp the token and the category would read as outdated on every run.
    const t = syncTokensFromMatch({
      manuals: [
        { sha256: 'a'.repeat(64), sortOrder: 1, manualUrl: '/m/first.man.zst' },
        { sha256: 'b'.repeat(64), sortOrder: 2, manualUrl: null },
      ],
    });
    expect(t.sync_man).toBe('aaaaaaaaaaaaaaaa');
    expect(syncTokensFromMatch({ manuals: [{ sha256: 'c'.repeat(64), manualUrl: null }] }).sync_man).toBeNull();
  });
});

describe('buildYml + parseInfoYml round-trip with sync tokens', () => {
  it('emits the sync_* keys after the metadata and reads them back', () => {
    const fields = {
      title: 'Super Metroid', crc: 'D63ED5F8', gamedb_id: 'abc',
      sync_pkg: 'a1b2c3d4e5f6a7b8', sync_meta: '7c1f9adeadbeef00', sync_man: 'aaaaaaaaaaaaaaaa',
    };
    const yml: string = buildYml(fields);
    // metadata precedes bookkeeping
    expect(yml.indexOf('crc:')).toBeLessThan(yml.indexOf('sync_pkg:'));
    const back = parseInfoYml(yml) as Record<string, string>;
    expect(back['title']).toBe('Super Metroid');
    expect(back['sync_pkg']).toBe('a1b2c3d4e5f6a7b8');
    expect(back['sync_meta']).toBe('7c1f9adeadbeef00');
    expect(back['sync_man']).toBe('aaaaaaaaaaaaaaaa');
    expect(back['sync_pcm']).toBeUndefined(); // falsy → omitted
  });
  it('SYNC_KEYS lists exactly the four bookkeeping keys', () => {
    expect(SYNC_KEYS).toEqual(['sync_pkg', 'sync_pcm', 'sync_man', 'sync_meta']);
    // man_slots is bookkeeping too but must stay out of this list: persistSyncTokens resolves every key
    // in it against syncTokensFromMatch and deletes the ones it cannot derive. The map records card
    // state, so it is underivable. Listing it here would wipe it on the first token rewrite.
    expect(SYNC_KEYS).not.toContain(MAN_SLOTS_KEY);
  });
});

/**
 * `man_slots`, which GameDB document sits in each `.man` slot.
 *
 * The card cannot answer that on its own: a slot is just `<stem>.NN.man`, with no mark of what is inside.
 * The only identity auto-fill had was the sha256 of the bytes, so when the GameDB re-encoded all 3664
 * `.man` files every extra manual stopped being recognized, took another free slot next to the copy it
 * meant to replace, and games with several documents ran out of slots and reported "no free guide slot"
 * without owning a single duplicate. `groupUuid` is stable across versions; the per-version `uuid` is not.
 */
describe('man_slots — the slot→document map', () => {
  it('manGroupTag folds a groupUuid to a short, separator-safe tag', () => {
    expect(manGroupTag('h5y4tn5iabcdef')).toBe('h5y4tn5i');       // truncated to 8
    expect(manGroupTag('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400');
    // a dash/underscore anywhere near the cut can never smuggle a `:` or `,` into the value
    expect(manGroupTag('ab-cd-ef-gh-ij')).toBe('abcdefgh');
    expect(manGroupTag('AhTd2TrH')).toBe('ahtd2trh');             // case-folded
    expect(manGroupTag(null)).toBeNull();
    expect(manGroupTag('---')).toBeNull();                        // nothing left to record
  });

  it('reserves one tag for the USER`s own guides, and keeps it out of the document namespace', () => {
    // A slot marked `u` is a guide the user added: never adopted as an old copy of a document, never
    // swept. The two namespaces must not be able to collide, so manGroupTag refuses to produce it.
    expect(MAN_USER_TAG).toBe('u');
    expect(manGroupTag('u')).toBeNull();
    expect(manGroupTag('U-')).toBeNull();
    expect(manGroupTag('u1234567')).toBe('u1234567'); // a real (8-char) group is unaffected
    // ...and it still round-trips through the game info file untouched
    const map = new Map([[0, 'h5y4tn5i'], [3, MAN_USER_TAG]]);
    expect(serializeManSlots(map)).toBe('0:h5y4tn5i,3:u');
    expect(parseManSlots('0:h5y4tn5i,3:u')).toEqual(map);
  });

  it('serializes ascending by slot, so an UNCHANGED map is byte-identical (no pointless card write)', () => {
    const map = new Map([[3, 'quhu9t87'], [0, 'h5y4tn5i'], [2, 'ahtd2trh']]);
    expect(serializeManSlots(map)).toBe('0:h5y4tn5i,2:ahtd2trh,3:quhu9t87');
    expect(serializeManSlots(new Map())).toBeNull();  // yfield omits falsy → the key disappears entirely
    expect(serializeManSlots(null)).toBeNull();
  });

  it('round-trips', () => {
    const map = new Map([[0, 'h5y4tn5i'], [2, 'ahtd2trh'], [8, 'quhu9t87']]);
    expect(parseManSlots(serializeManSlots(map))).toEqual(map);
  });

  it('parses tolerantly — a hand-edited gameInfo must never take a run down', () => {
    expect(parseManSlots('0:h5y4tn5i,,2:ahtd2trh')).toEqual(new Map([[0, 'h5y4tn5i'], [2, 'ahtd2trh']]));
    expect(parseManSlots(' 0 : H5Y4TN5I ')).toEqual(new Map([[0, 'h5y4tn5i']]));
    expect(parseManSlots('0:h5y4tn5i,garbage,3')).toEqual(new Map([[0, 'h5y4tn5i']]));
    expect(parseManSlots(undefined)).toEqual(new Map());
    expect(parseManSlots('')).toEqual(new Map());
  });

  it('KEEPS a document listed in two slots — that duplicate is what the cleanup pass looks for', () => {
    expect(parseManSlots('2:ahtd2trh,6:ahtd2trh')).toEqual(new Map([[2, 'ahtd2trh'], [6, 'ahtd2trh']]));
  });

  it('rides in the gameInfo after the sync tokens and before the localized descriptions', () => {
    const yml: string = buildYml({
      title: 'The Legend of Zelda', sync_man: 'a'.repeat(16), description_pt: 'Texto',
      [MAN_SLOTS_KEY]: '0:h5y4tn5i,2:ahtd2trh',
    });
    expect(yml.indexOf('sync_man:')).toBeLessThan(yml.indexOf('man_slots:'));
    expect(yml.indexOf('man_slots:')).toBeLessThan(yml.indexOf('description_pt:'));
    // Quoted, the firmware reads a value to end-of-line (yaml.h YAML_DELIM_VALUE "\r\n"), so the colons
    // inside it are never re-tokenized as keys; and the whole line stays far under YAML_BUFLEN (256).
    expect(yml).toContain('man_slots: "0:h5y4tn5i,2:ahtd2trh"');
    expect(Math.max(...yml.split('\n').map((l) => l.length))).toBeLessThan(256);
    const back = parseInfoYml(yml) as Record<string, string>;
    expect(back[MAN_SLOTS_KEY]).toBe('0:h5y4tn5i,2:ahtd2trh');
    expect(parseManSlots(back[MAN_SLOTS_KEY])).toEqual(new Map([[0, 'h5y4tn5i'], [2, 'ahtd2trh']]));
  });

  it('clamps to its own grammar, so "the line fits" is a property of the format, not of luck', () => {
    // A slot is one digit and a tag at most 8 chars, at both ends. That is what caps the worst case; the
    // firmware reader (yaml.c f_gets) truncates at YAML_BUFLEN and would silently corrupt a longer line.
    expect(parseManSlots('42:abcdefgh')).toEqual(new Map());            // two digits → not a pair we wrote
    expect(parseManSlots('2:abcdefghij')).toEqual(new Map());           // over-long tag → dropped, not cut
    expect(serializeManSlots(new Map([[42, 'abcdefgh']]))).toBeNull();  // ...and never emitted either
    expect(serializeManSlots(new Map([[2, 'abcdefghijklmnop']]))).toBe('2:abcdefgh'); // truncated on the way out
    expect(serializeManSlots(new Map([[2, '--']]))).toBeNull();         // nothing left after folding
    // the absolute ceiling the grammar allows: 10 pairs of 1 + 1 + 8 chars, plus 9 commas
    const worst = serializeManSlots(new Map(Array.from({ length: 10 }, (_, i) => [i, 'wwwwwwww'] as const))) as string;
    expect(worst.length).toBe(109);
    expect(buildYml({ [MAN_SLOTS_KEY]: worst }).split('\n').every((l) => l.length < 256)).toBe(true);
    expect(parseManSlots(worst).size).toBe(10); // and it survives the round trip unchanged
  });

  it('a full 8-slot map still fits the firmware line cap with room to spare', () => {
    const map = new Map([0, 2, 3, 4, 5, 6, 7, 8].map((nn, i) => [nn, `tag${i}abcd`] as const));
    const yml: string = buildYml({ [MAN_SLOTS_KEY]: serializeManSlots(map) });
    expect(Math.max(...yml.split('\n').map((l) => l.length))).toBeLessThan(256);
    expect(parseManSlots((parseInfoYml(yml) as Record<string, string>)[MAN_SLOTS_KEY])).toEqual(new Map(map));
  });

  it('is omitted when there is no map (a card that never had one keeps a clean gameInfo)', () => {
    expect(buildYml({ title: 'Tetris', [MAN_SLOTS_KEY]: null })).not.toContain('man_slots');
  });
});

describe('localized descriptions (description_<lang>)', () => {
  it('mirrors the gamedb translation languages (English is the canonical `description`)', () => {
    expect(DESC_LANGS).toEqual(['fr', 'pt', 'es', 'de', 'it']);
    expect(DESC_LANGS).not.toContain('en');
    expect(DESC_LANG_KEYS).toEqual(['description_fr', 'description_pt', 'description_es', 'description_de', 'description_it']);
  });

  it('descLangFields keeps non-empty known languages and drops the rest', () => {
    expect(descLangFields({ pt: 'texto', de: '', xx: 'unknown' })).toEqual({ description_pt: 'texto' });
    expect(descLangFields(undefined)).toEqual({});
  });

  it('writes them LAST -- after the metadata, the fmv flag and the sync tokens', () => {
    const yml: string = buildYml({ title: 'Super Metroid', description: 'English text', fmv: 1, sync_pkg: 'a'.repeat(16), description_pt: 'Texto em portugues' });
    const lines = yml.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('description_pt: "Texto em portugues"');
    expect(yml.indexOf('description:')).toBeLessThan(yml.indexOf('fmv: 1'));
    expect(yml.indexOf('sync_pkg:')).toBeLessThan(yml.indexOf('description_pt:'));
  });

  it('round-trips through parseInfoYml', () => {
    const back = parseInfoYml(buildYml({ description: 'English', description_pt: 'Portugues', description_it: 'Italiano' })) as Record<string, string>;
    expect(back['description']).toBe('English');
    expect(back['description_pt']).toBe('Portugues');
    expect(back['description_it']).toBe('Italiano');
    expect(back['description_de']).toBeUndefined(); // absent → omitted
  });

  it('ymlFieldsFromMatch carries the English description plus every translation', () => {
    const f = ymlFieldsFromMatch(
      { title: 'Super Metroid', description: 'Samus returns to Zebes.', descriptions: { pt: 'Samus volta a Zebes.' }, videoUrl: null },
      { romName: 'Super Metroid (USA).sfc', crc: 'D63ED5F8', region: 'USA' },
    ) as Record<string, unknown>;
    expect(f['description']).toBe('Samus returns to Zebes.');
    expect(f['description_pt']).toBe('Samus volta a Zebes.');
    expect(f['description_es']).toBeUndefined();
  });
});
